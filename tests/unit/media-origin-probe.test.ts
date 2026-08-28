import { describe, expect, it } from "vitest";

import {
  createRangeCases,
  createStartupRangeCase,
  IMMUTABLE_MAX_AGE_SECONDS,
  MAX_ERROR_BODY_BYTES,
  inspectMovFastStart,
  parseContentRange,
  REQUIRED_EXPOSED_HEADERS,
  resolveProbeArguments,
  runMediaOriginProbe,
  validateCommonHeaders,
} from "../../scripts/probe-media-origin";

const SITE_ORIGIN = "https://portfolio.example";
const MEDIA_URL = "https://media.example/hero.mov";

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function box(type: string, payload: Uint8Array, extended = false): Uint8Array {
  const headerSize = extended ? 16 : 8;
  const result = new Uint8Array(headerSize + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, extended ? 1 : result.byteLength);
  result.set(new TextEncoder().encode(type), 4);
  if (extended) view.setBigUint64(8, BigInt(result.byteLength));
  result.set(payload, headerSize);
  return result;
}

function fixture(): Uint8Array {
  return concat(box("ftyp", new Uint8Array([1, 2])), box("moov", new Uint8Array([3, 4, 5]), true), box("free", new Uint8Array([6])), box("mdat", new Uint8Array([7, 8, 9, 10])));
}

function headers(length: number, etag = '"asset-v1"', cacheStatus = "MISS", age = "0"): Headers {
  return new Headers({
    "access-control-allow-origin": SITE_ORIGIN,
    "access-control-expose-headers": REQUIRED_EXPOSED_HEADERS.join(", "),
    "accept-ranges": "bytes",
    "cache-control": `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`,
    "content-length": String(length),
    "content-type": "video/quicktime",
    "cf-cache-status": cacheStatus,
    age,
    etag,
  });
}

type FetchCall = { init?: RequestInit; range?: string };
function fakeOrigin(expected: Uint8Array, options: { wrongBytes?: boolean; driftEtag?: boolean; redirect?: boolean; startupCacheStatus?: string } = {}) {
  const calls: FetchCall[] = [];
  let fullGets = 0;
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const requestHeaders = new Headers(init?.headers);
    const range = requestHeaders.get("range") ?? undefined;
    calls.push({ init, range });
    if (options.redirect && calls.length === 1) return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/hero.mov" } });
    const method = init?.method ?? "GET";
    const etag = options.driftEtag && calls.length > 1 ? '"asset-v2"' : '"asset-v1"';
    if (method === "HEAD") return new Response(null, { status: 200, headers: headers(expected.byteLength, etag) });
    if (!range) {
      fullGets += 1;
      const body = new Uint8Array(expected);
      if (options.wrongBytes) body[body.length - 1] ^= 0xff;
      return new Response(body, { status: 200, headers: headers(body.byteLength, etag, fullGets > 1 ? "HIT" : "MISS", fullGets > 1 ? "1" : "0") });
    }
    const match = range.match(/^bytes=(\d+)-(\d*)$/) ?? range.match(/^bytes=-(\d+)$/);
    if (range === `bytes=${expected.byteLength}-${expected.byteLength + 1}`) {
      return new Response("unsatisfied", { status: 416, headers: new Headers({ ...Object.fromEntries(headers(11, etag, "HIT", "1")), "content-range": `bytes */${expected.byteLength}` }) });
    }
    let start: number;
    let end: number;
    if (range.match(/^bytes=-(\d+)$/)) {
      const length = Number(range.slice("bytes=-".length));
      start = expected.length - length;
      end = expected.length - 1;
    } else if (match) {
      start = Number(match[1]);
      end = match[2] === "" ? expected.length - 1 : Number(match[2]);
    } else throw new Error(`unexpected range ${range}`);
    const body = expected.slice(start, end + 1);
    const rangeCacheStatus = fullGets > 0 ? "HIT" : (options.startupCacheStatus ?? "MISS");
    const rangeHeaders = headers(body.length, etag, rangeCacheStatus, fullGets > 0 ? "1" : "0");
    rangeHeaders.set("content-range", `bytes ${start}-${end}/${expected.length}`);
    return new Response(body, { status: 206, headers: rangeHeaders });
  };
  return { fetchImpl, calls };
}

describe("media origin acceptance probe", () => {
  it("covers metadata, first, middle, suffix, and unsatisfied ranges", () => {
    expect(createRangeCases(11_151_391, 2_135)[0]).toEqual({ name: "range:metadata", range: "bytes=0-2134", start: 0, end: 2_134, expectedStatus: 206 });
    expect(createRangeCases(11_151_391)).toEqual(expect.arrayContaining([
      { name: "range:first", range: "bytes=0-1023", start: 0, end: 1_023, expectedStatus: 206 },
      { name: "range:middle", range: "bytes=5573647-5577742", start: 5_573_647, end: 5_577_742, expectedStatus: 206 },
      { name: "range:suffix", range: "bytes=-1024", start: 11_150_367, end: 11_151_390, expectedStatus: 206 },
      { name: "range:open-ended", range: "bytes=11147295-", start: 11_147_295, end: 11_151_390, expectedStatus: 206 },
      { name: "range:invalid", range: "bytes=11151391-11151392", expectedStatus: 416, invalid: true },
    ]));
    expect(createStartupRangeCase(11_151_391, 2_135)).toEqual({ name: "range:startup", range: "bytes=0-2134", start: 0, end: 2_134, expectedStatus: 206 });
  });

  it("parses safe Content-Range values and rejects malformed/unsafe values", () => {
    expect(parseContentRange("bytes 0-1023/11151391")).toEqual({ start: 0, end: 1_023, total: 11_151_391 });
    expect(parseContentRange("bytes */11151391")).toBeNull();
    expect(parseContentRange("bytes 0-1023/9007199254740992")).toBeNull();
  });

  it("requires stable identity, unencoded bytes, and an immutable cache policy", () => {
    const valid = headers(1_024);
    expect(validateCommonHeaders({ status: 206, headers: valid }, 1_024, "video/quicktime", '"asset-v1"', SITE_ORIGIN).cacheControl).toContain("immutable");
    valid.set("content-encoding", "gzip");
    expect(() => validateCommonHeaders({ status: 206, headers: valid }, 1_024, "video/quicktime", '"asset-v1"', SITE_ORIGIN)).toThrow("Content-Encoding must be absent");
  });

  it("walks real ISO-BMFF headers, including 64-bit sizes, and requires moov before mdat", () => {
    expect(inspectMovFastStart(fixture())).toEqual({ moov: 10, moovEnd: 29, mdat: 38 });
    expect(() => inspectMovFastStart(concat(box("ftyp", new Uint8Array()), box("mdat", new Uint8Array([1])), box("moov", new Uint8Array())))).toThrow("not Fast Start");
    expect(() => inspectMovFastStart(new TextEncoder().encode("....moov....mdat"))).toThrow("ISO-BMFF box");
  });

  it("runs the complete green contract against a deterministic fake origin and sends the explicit Origin", async () => {
    const expected = fixture();
    const fake = fakeOrigin(expected);
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: expected, fetchImpl: fake.fetchImpl });
    expect(report.failures).toEqual([]);
    expect(report.results.every((result) => result.startsWith("PASS"))).toBe(true);
    expect(report.warmCache).toEqual({ status: "HIT", ageSeconds: 1 });
    expect(report.startupRange).toMatchObject({ name: "range:startup", cacheStatus: "MISS", ageHeader: "0", responseBytes: 29 });
    expect(report.requestObservations).toHaveLength(10);
    expect(fake.calls).toHaveLength(10);
    expect(fake.calls.every(({ init }) => new Headers(init?.headers).get("origin") === SITE_ORIGIN)).toBe(true);
    expect(fake.calls.every(({ init }) => init?.redirect === "manual")).toBe(true);
    expect(fake.calls.some(({ range }) => range === "bytes=0-28")).toBe(true);
    expect(fake.calls.some(({ range }) => range === "bytes=25-")).toBe(true);
  });

  it("reports an observed warm startup range without claiming it was cache-cold", async () => {
    const expected = fixture();
    const fake = fakeOrigin(expected, { startupCacheStatus: "HIT" });
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: expected, fetchImpl: fake.fetchImpl });
    expect(report.failures).toEqual([]);
    expect(report.startupRange?.cacheStatus).toBe("HIT");
  });

  it.each([
    ["wrong bytes", { wrongBytes: true }, "bytes differ"],
    ["ETag drift", { driftEtag: true }, "ETag changed"],
    ["redirect", { redirect: true }, "redirect 302"],
  ])("reports %s as RED", async (_name, options, message) => {
    const fake = fakeOrigin(fixture(), options);
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: fixture(), fetchImpl: fake.fetchImpl, timeoutMs: 100, totalTimeoutMs: 2_000 });
    expect(report.failures.join("\n")).toContain(message);
  });

  it("bounds a hanging fetch with the per-request and total deadline", async () => {
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const started = Date.now();
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: fixture(), fetchImpl, timeoutMs: 5, totalTimeoutMs: 25 });
    expect(Date.now() - started).toBeLessThan(250);
    expect(report.failures.join("\n")).toContain("timed out");
  });

  it("bounds a response body that hangs after headers", async () => {
    const expected = fixture();
    const startup = createStartupRangeCase(expected.byteLength, inspectMovFastStart(expected).moovEnd);
    const startupLength = startup.end - startup.start + 1;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([expected[0]])); },
      });
      const responseHeaders = headers(startupLength);
      responseHeaders.set("content-range", `bytes ${startup.start}-${startup.end}/${expected.length}`);
      void init;
      return new Response(stream, { status: 206, headers: responseHeaders });
    };
    const started = Date.now();
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: expected, fetchImpl, timeoutMs: 10, totalTimeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(report.failures.join("\n")).toContain("timed out");
  });

  it("rejects a declared oversized range before buffering the body", async () => {
    const expected = fixture();
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const range = new Headers(init?.headers).get("range");
      if (range === "bytes=0-28") {
        const oversized = headers(expected.byteLength);
        oversized.set("content-range", `bytes 0-${expected.length - 1}/${expected.length}`);
        return new Response(Buffer.from(expected), { status: 206, headers: oversized });
      }
      return fakeOrigin(expected).fetchImpl(_url, init);
    };
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: expected, fetchImpl, timeoutMs: 100, totalTimeoutMs: 2_000 });
    expect(report.failures.join("\n")).toContain(`Content-Length ${expected.length} != expected 29 before reading body`);
    expect(MAX_ERROR_BODY_BYTES).toBeGreaterThan(0);
  });

  it("cancels a response body when status validation fails before reading it", async () => {
    const expected = fixture();
    let cancelled = false;
    let first = true;
    const healthy = fakeOrigin(expected);
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (first) {
        first = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array([expected[0]])); },
          cancel() { cancelled = true; },
        });
        return new Response(stream, { status: 200, headers: headers(expected.length) });
      }
      return healthy.fetchImpl(url, init);
    };
    const report = await runMediaOriginProbe({ url: MEDIA_URL, siteOrigin: SITE_ORIGIN, expectedBytes: expected, fetchImpl, timeoutMs: 100, totalTimeoutMs: 2_000 });
    expect(report.failures.join("\n")).toContain("status 200 != expected 206");
    expect(cancelled).toBe(true);
  });

  it("requires an explicit site Origin and validates its shape", () => {
    expect(() => resolveProbeArguments(["--url", MEDIA_URL], {})).toThrow("site Origin required");
    expect(resolveProbeArguments(["--origin", SITE_ORIGIN, "--url", MEDIA_URL], {})).toMatchObject({ siteOrigin: SITE_ORIGIN, url: MEDIA_URL });
    expect(resolveProbeArguments(["--origin", SITE_ORIGIN, "--startup-range-max-ms", "250", "--url", MEDIA_URL], {})).toMatchObject({ startupRangeMaxMs: 250 });
    expect(() => resolveProbeArguments(["--origin", `${SITE_ORIGIN}/path`, "--url", MEDIA_URL], {})).toThrow("must not include a path");
  });
});
