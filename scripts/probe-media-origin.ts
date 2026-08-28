import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HERO_MEDIA_PATH = path.join(REPOSITORY_ROOT, "public/video-prototype/hero-hevc-alpha-hq.mov");
export const HERO_MEDIA_TYPE = "video/quicktime";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const REQUIRED_EXPOSED_HEADERS = [
  "accept-ranges",
  "content-range",
  "content-length",
  "etag",
  "cache-control",
  "cf-cache-status",
  "age",
] as const;

type HeadersLike = { get(name: string): string | null };

export type ProbeResponse = { status: number; headers: HeadersLike; url?: string };

export type RangeCase =
  | { name: string; range: string; start: number; end: number; expectedStatus: 206 }
  | { name: string; range: string; expectedStatus: 416; invalid: true };

export type RequestObservation = {
  name: string;
  method: "HEAD" | "GET";
  range?: string;
  elapsedMs: number;
  status?: number;
  declaredBytes?: number;
  responseBytes?: number;
  cacheStatus?: string;
  ageHeader?: string;
  error?: string;
};

export type HeaderFacts = { contentLength: number; contentType: string; etag: string; cacheControl: string };

export type MovBoxOffsets = { moov: number; moovEnd: number; mdat: number };

/** Read an ISO-BMFF top-level box table; searching for ASCII markers is unsafe. */
export function inspectMovFastStart(bytes: Uint8Array): MovBoxOffsets {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let moov: number | undefined;
  let moovEnd: number | undefined;
  let mdat: number | undefined;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining < 8) throw new Error(`truncated ISO-BMFF box header at ${offset}`);
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    let boxSize: number;
    if (size32 === 1) {
      if (remaining < 16) throw new Error(`truncated extended ISO-BMFF box header at ${offset}`);
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`unsafe ISO-BMFF box size at ${offset}`);
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = remaining;
    } else {
      boxSize = size32;
    }
    if (boxSize < headerSize) throw new Error(`invalid ISO-BMFF box size ${boxSize} at ${offset}`);
    if (boxSize > remaining) throw new Error(`ISO-BMFF box at ${offset} extends beyond input`);
    if (type === "moov" && moov === undefined) {
      moov = offset;
      moovEnd = offset + boxSize;
    }
    if (type === "mdat" && mdat === undefined) mdat = offset;
    offset += boxSize;
  }
  if (moov === undefined || moovEnd === undefined || mdat === undefined) throw new Error("MOV is missing a top-level moov or mdat box");
  if (moov >= mdat) throw new Error(`MOV is not Fast Start: moov offset ${moov} is not before mdat ${mdat}`);
  return { moov, moovEnd, mdat };
}

export function createRangeCases(totalBytes: number, moovEnd?: number): readonly RangeCase[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 2) throw new Error(`Cannot create byte ranges for invalid size ${totalBytes}`);
  const ranges: RangeCase[] = [];
  if (moovEnd !== undefined) {
    if (!Number.isSafeInteger(moovEnd) || moovEnd < 8 || moovEnd > totalBytes) throw new Error(`Cannot create metadata range through invalid moov end ${moovEnd}`);
    ranges.push({ name: "range:metadata", range: `bytes=0-${moovEnd - 1}`, start: 0, end: moovEnd - 1, expectedStatus: 206 });
  }
  const firstEnd = Math.min(1_023, totalBytes - 1);
  const middleLength = Math.min(4_096, totalBytes);
  const middleStart = Math.floor((totalBytes - middleLength) / 2);
  const middleEnd = middleStart + middleLength - 1;
  const suffixLength = Math.min(1_024, totalBytes);
  const openEndedLength = Math.min(4_096, Math.floor(totalBytes / 2));
  const openEndedStart = totalBytes - openEndedLength;
  ranges.push(
    { name: "range:first", range: `bytes=0-${firstEnd}`, start: 0, end: firstEnd, expectedStatus: 206 },
    { name: "range:middle", range: `bytes=${middleStart}-${middleEnd}`, start: middleStart, end: middleEnd, expectedStatus: 206 },
    { name: "range:suffix", range: `bytes=-${suffixLength}`, start: totalBytes - suffixLength, end: totalBytes - 1, expectedStatus: 206 },
    // Safari commonly uses an open-ended range. Keep the start nonzero and
    // near the tail so this syntax check does not duplicate a full download.
    { name: "range:open-ended", range: `bytes=${openEndedStart}-`, start: openEndedStart, end: totalBytes - 1, expectedStatus: 206 },
    { name: "range:invalid", range: `bytes=${totalBytes}-${totalBytes + 1}`, expectedStatus: 416, invalid: true },
  );
  return ranges;
}

export function createStartupRangeCase(totalBytes: number, moovEnd?: number): Extract<RangeCase, { expectedStatus: 206 }> {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 2) throw new Error(`Cannot create byte ranges for invalid size ${totalBytes}`);
  const end = moovEnd === undefined ? Math.min(1_023, totalBytes - 1) : moovEnd - 1;
  if (!Number.isSafeInteger(end) || end < 0 || end >= totalBytes) throw new Error(`Cannot create startup range through invalid end ${end}`);
  return { name: "range:startup", range: `bytes=0-${end}`, start: 0, end, expectedStatus: 206 };
}

function parseSafeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`invalid ${label} ${JSON.stringify(value)}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`unsafe ${label} ${JSON.stringify(value)}`);
  return number;
}
function parseContentLength(value: string | null): number {
  if (!value) throw new Error(`invalid Content-Length ${JSON.stringify(value)}`);
  return parseSafeInteger(value, "Content-Length");
}
function normalizeContentType(value: string | null): string {
  if (!value) throw new Error("missing Content-Type");
  return value.split(";", 1)[0].trim().toLowerCase();
}
export function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = value?.trim().match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  try {
    const [, start, end, total] = match;
    return { start: parseSafeInteger(start, "range start"), end: parseSafeInteger(end, "range end"), total: parseSafeInteger(total, "range total") };
  } catch { return null; }
}
function parseDirectives(value: string): Map<string, string | undefined> {
  return new Map(value.split(",").map((part) => {
    const [name, ...rest] = part.trim().toLowerCase().split("=");
    return [name, rest.length > 0 ? rest.join("=").replace(/^"|"$/g, "") : undefined];
  }));
}
function validateCorsAndCacheHeaders(response: ProbeResponse, expectedOrigin: string): string {
  const allowOrigin = response.headers.get("access-control-allow-origin")?.trim();
  if (allowOrigin !== expectedOrigin) throw new Error(`Access-Control-Allow-Origin ${JSON.stringify(allowOrigin)} != expected ${expectedOrigin}`);
  const exposed = new Set((response.headers.get("access-control-expose-headers") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const missing = REQUIRED_EXPOSED_HEADERS.filter((name) => !exposed.has(name));
  if (missing.length > 0) throw new Error(`Access-Control-Expose-Headers missing ${missing.join(", ")}`);
  const cacheControl = response.headers.get("cache-control")?.trim();
  if (!cacheControl) throw new Error("missing Cache-Control");
  const directives = parseDirectives(cacheControl);
  if (!directives.has("public") || !directives.has("immutable")) throw new Error(`Cache-Control must include public and immutable, got ${cacheControl}`);
  const maxAge = directives.get("max-age");
  if (maxAge === undefined) throw new Error(`Cache-Control missing max-age, got ${cacheControl}`);
  const maxAgeSeconds = Number(maxAge);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < IMMUTABLE_MAX_AGE_SECONDS) throw new Error(`Cache-Control max-age must be at least ${IMMUTABLE_MAX_AGE_SECONDS}, got ${maxAge}`);
  return cacheControl;
}
export function validateCommonHeaders(response: ProbeResponse, expectedLength: number, expectedType = HERO_MEDIA_TYPE, expectedEtag?: string, expectedOrigin?: string): HeaderFacts {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== expectedLength) throw new Error(`Content-Length ${contentLength} != expected ${expectedLength}`);
  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (contentType !== expectedType) throw new Error(`Content-Type ${contentType} != expected ${expectedType}`);
  if (response.headers.get("content-encoding")?.trim()) throw new Error(`Content-Encoding must be absent, got ${response.headers.get("content-encoding")}`);
  // Accept-Ranges is capability evidence on a complete response, but it is
  // advisory and commonly omitted from a valid partial response. A 206 has
  // already proved range support through its status, Content-Range, length,
  // and checked body bytes; requiring this header again rejects valid origins.
  if (response.status === 200) {
    const acceptRanges = response.headers.get("accept-ranges")?.toLowerCase().split(",").map((value) => value.trim());
    if (!acceptRanges?.includes("bytes")) throw new Error("missing Accept-Ranges: bytes");
  }
  const etag = response.headers.get("etag")?.trim();
  if (!etag) throw new Error("missing ETag");
  if (expectedEtag !== undefined && etag !== expectedEtag) throw new Error(`ETag changed from ${expectedEtag} to ${etag}`);
  const cacheControl = expectedOrigin === undefined ? response.headers.get("cache-control")?.trim() ?? "" : validateCorsAndCacheHeaders(response, expectedOrigin);
  return { contentLength, contentType, etag, cacheControl };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
class ProbeTimeoutError extends Error { constructor(message: string) { super(message); this.name = "ProbeTimeoutError"; } }
type RequestOptions = { expectedStatus: 200 | 206 | 416; expectedBodyBytes?: number; maxBodyBytes: number };
type RequestResult = { response: Response; body: Uint8Array; elapsedMs: number };

function parseOptionalContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  return parseContentLength(value);
}

function cancelUnreadResponse(response: Response): void {
  const cancel = response.body?.cancel();
  if (cancel !== undefined) void cancel.catch(() => undefined);
}

function rejectBeforeBody(response: Response, error: unknown): never {
  cancelUnreadResponse(response);
  throw error;
}

async function readBodyBounded(response: Response, maxBodyBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    if (signal.aborted) throw new Error("response body read aborted");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        cancelReader();
        throw new Error(`response body exceeds ${maxBodyBytes} byte safety limit`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function request(fetchImpl: FetchLike, url: string, origin: string, method: "HEAD" | "GET", range: string | undefined, timeoutMs: number, deadlineMs: number, options: RequestOptions): Promise<RequestResult> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new ProbeTimeoutError("total probe deadline exceeded");
  const effectiveTimeout = Math.min(timeoutMs, remaining);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const requestStartedAt = Date.now();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeTimeoutError(`request timed out after ${effectiveTimeout}ms`));
    }, Math.max(1, effectiveTimeout));
  });
  try {
    const fetchPromise = fetchImpl(url, { method, headers: { Origin: origin, ...(range ? { Range: range } : {}) }, signal: controller.signal, redirect: "manual" });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (response.status >= 300 && response.status < 400) rejectBeforeBody(response, new Error(`redirect ${response.status} to ${response.headers.get("location") ?? "(no Location)"}`));
    if (response.url && response.url !== url) rejectBeforeBody(response, new Error(`response URL ${response.url} differs from configured URL ${url}`));
    if (response.status !== options.expectedStatus) rejectBeforeBody(response, new Error(`status ${response.status} != expected ${options.expectedStatus}`));
    let declaredBytes: number | undefined;
    try {
      declaredBytes = parseOptionalContentLength(response.headers.get("content-length"));
    } catch (error) {
      rejectBeforeBody(response, error);
    }
    // Check the declared size before touching the body. A server which ignores
    // a small Range must fail here instead of buffering the entire asset.
    if (method === "GET") {
      if (options.expectedBodyBytes !== undefined && declaredBytes !== undefined && declaredBytes !== options.expectedBodyBytes) {
        rejectBeforeBody(response, new Error(`Content-Length ${declaredBytes} != expected ${options.expectedBodyBytes} before reading body`));
      }
      if (declaredBytes !== undefined && declaredBytes > options.maxBodyBytes) {
        rejectBeforeBody(response, new Error(`declared response body ${declaredBytes} exceeds ${options.maxBodyBytes} byte safety limit`));
      }
    }
    const body = method === "HEAD" ? new Uint8Array() : await Promise.race([readBodyBounded(response, options.maxBodyBytes, controller.signal), timeoutPromise]);
    if (method === "GET" && options.expectedBodyBytes !== undefined && body.byteLength !== options.expectedBodyBytes) {
      throw new Error(`response body ${body.byteLength} != expected ${options.expectedBodyBytes}`);
    }
    return { response, body, elapsedMs: Date.now() - requestStartedAt };
  } catch (error) {
    if (timedOut) throw new ProbeTimeoutError(`request timed out after ${effectiveTimeout}ms`);
    if (Date.now() >= deadlineMs) throw new ProbeTimeoutError("total probe deadline exceeded");
    throw error;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function responseDetails(response: Response): ProbeResponse { return { status: response.status, headers: response.headers, url: response.url }; }
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function parseHttpUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${label} must use http(s): ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  return parsed.toString();
}
function parseSiteOrigin(value: string): string {
  const parsed = new URL(parseHttpUrl(value, "site origin"));
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("site origin must not include a path, query, or hash");
  return parsed.origin;
}
export function resolveProbeArguments(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): { url: string; siteOrigin: string; timeoutMs: number; totalTimeoutMs: number; startupRangeMaxMs?: number } {
  let url = environment.MEDIA_ORIGIN_URL ?? environment.HERO_MEDIA_ORIGIN_URL;
  let siteOrigin = environment.MEDIA_SITE_ORIGIN ?? environment.HERO_SITE_ORIGIN;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;
  let startupRangeMaxMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--timeout-ms") timeoutMs = Number(args[++index]);
    else if (argument.startsWith("--timeout-ms=")) timeoutMs = Number(argument.slice("--timeout-ms=".length));
    else if (argument === "--total-timeout-ms") totalTimeoutMs = Number(args[++index]);
    else if (argument.startsWith("--total-timeout-ms=")) totalTimeoutMs = Number(argument.slice("--total-timeout-ms=".length));
    else if (argument === "--startup-range-max-ms") startupRangeMaxMs = Number(args[++index]);
    else if (argument.startsWith("--startup-range-max-ms=")) startupRangeMaxMs = Number(argument.slice("--startup-range-max-ms=".length));
    else if (argument === "--origin" || argument === "--site-origin") siteOrigin = args[++index];
    else if (argument.startsWith("--origin=")) siteOrigin = argument.slice("--origin=".length);
    else if (argument.startsWith("--site-origin=")) siteOrigin = argument.slice("--site-origin=".length);
    else if (argument === "--url") url = args[++index];
    else if (argument.startsWith("--url=")) url = argument.slice("--url=".length);
    else if (!argument.startsWith("-")) url = argument;
  }
  if (!url) throw new Error("media origin URL required: pass a URL or MEDIA_ORIGIN_URL");
  if (!siteOrigin) throw new Error("site Origin required: pass --origin or MEDIA_SITE_ORIGIN");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid timeout ${timeoutMs}`);
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) throw new Error(`invalid total timeout ${totalTimeoutMs}`);
  if (startupRangeMaxMs !== undefined && (!Number.isSafeInteger(startupRangeMaxMs) || startupRangeMaxMs < 0)) throw new Error(`invalid startup range latency threshold ${startupRangeMaxMs}`);
  return { url: parseHttpUrl(url, "media origin"), siteOrigin: parseSiteOrigin(siteOrigin), timeoutMs, totalTimeoutMs, startupRangeMaxMs };
}

export type MediaOriginProbeOptions = { url: string; siteOrigin: string; expectedBytes: Uint8Array; timeoutMs?: number; totalTimeoutMs?: number; startupRangeMaxMs?: number; fetchImpl?: FetchLike };
export type MediaOriginProbeResult = { url: string; siteOrigin: string; expectedBytes: number; expectedHash: string; movBoxes: MovBoxOffsets; etag?: string; startupRange?: RequestObservation; startupRangeMaxMs?: number; warmCache?: { status: string; ageSeconds: number }; requestObservations: RequestObservation[]; results: string[]; failures: string[]; elapsedMs: number };
function bytesEqual(actual: Uint8Array, expected: Uint8Array): boolean { return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]); }
function validateWarmCache(response: ProbeResponse): { status: string; ageSeconds: number } {
  const status = response.headers.get("cf-cache-status")?.trim().toUpperCase();
  if (status !== "HIT") throw new Error(`warm response CF-Cache-Status ${JSON.stringify(status)} != HIT`);
  const rawAge = response.headers.get("age")?.trim();
  if (!rawAge || !/^\d+$/.test(rawAge)) throw new Error(`warm response Age is invalid: ${JSON.stringify(rawAge)}`);
  const ageSeconds = Number(rawAge);
  if (!Number.isSafeInteger(ageSeconds)) throw new Error(`warm response Age is unsafe: ${rawAge}`);
  return { status, ageSeconds };
}
export async function runMediaOriginProbe(options: MediaOriginProbeOptions): Promise<MediaOriginProbeResult> {
  const url = parseHttpUrl(options.url, "media origin");
  const siteOrigin = parseSiteOrigin(options.siteOrigin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const startupRangeMaxMs = options.startupRangeMaxMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid timeout ${timeoutMs}`);
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) throw new Error(`invalid total timeout ${totalTimeoutMs}`);
  if (startupRangeMaxMs !== undefined && (!Number.isSafeInteger(startupRangeMaxMs) || startupRangeMaxMs < 0)) throw new Error(`invalid startup range latency threshold ${startupRangeMaxMs}`);
  const expected = options.expectedBytes;
  const expectedBytes = expected.byteLength;
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  const movBoxes = inspectMovFastStart(expected);
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const deadlineMs = startedAt + totalTimeoutMs;
  const failures: string[] = [];
  const results: string[] = [];
  const requestObservations: RequestObservation[] = [];
  let etag: string | undefined;
  let warmCache: { status: string; ageSeconds: number } | undefined;
  const run = async (name: string, operation: () => Promise<void>): Promise<void> => {
    try { await operation(); results.push(`PASS ${name}`); }
    catch (error) { const reason = formatError(error); failures.push(`${name}: ${reason}`); results.push(`FAIL ${name} — ${reason}`); }
  };
  const get = async (name: string, method: "HEAD" | "GET", range: string | undefined, requestOptions: RequestOptions): Promise<RequestResult> => {
    const requestStartedAt = Date.now();
    try {
      const requestResult = await request(fetchImpl, url, siteOrigin, method, range, timeoutMs, deadlineMs, requestOptions);
      const rawAge = requestResult.response.headers.get("age")?.trim();
      requestObservations.push({
        name,
        method,
        ...(range === undefined ? {} : { range }),
        elapsedMs: requestResult.elapsedMs,
        status: requestResult.response.status,
        declaredBytes: (() => {
          try { return parseOptionalContentLength(requestResult.response.headers.get("content-length")); }
          catch { return undefined; }
        })(),
        responseBytes: requestResult.body.byteLength,
        cacheStatus: requestResult.response.headers.get("cf-cache-status")?.trim().toUpperCase() ?? undefined,
        ageHeader: rawAge || undefined,
      });
      return requestResult;
    } catch (error) {
      requestObservations.push({ name, method, ...(range === undefined ? {} : { range }), elapsedMs: Date.now() - requestStartedAt, error: formatError(error) });
      throw error;
    }
  };
  const common = (response: Response, length: number, expectedEtag?: string) => validateCommonHeaders(responseDetails(response), length, HERO_MEDIA_TYPE, expectedEtag, siteOrigin);
  const validateValidRange = (rangeCase: Extract<RangeCase, { expectedStatus: 206 }>, response: Response, body: Uint8Array): HeaderFacts => {
    const expectedLength = rangeCase.end - rangeCase.start + 1;
    const facts = common(response, expectedLength, etag);
    const contentRange = parseContentRange(response.headers.get("content-range"));
    if (!contentRange || contentRange.start !== rangeCase.start || contentRange.end !== rangeCase.end || contentRange.total !== expectedBytes) throw new Error(`Content-Range does not describe ${rangeCase.start}-${rangeCase.end}/${expectedBytes}`);
    if (!bytesEqual(body, expected.subarray(rangeCase.start, rangeCase.end + 1))) throw new Error("range response bytes differ from checked-in MOV");
    return facts;
  };
  const startupCase = createStartupRangeCase(expectedBytes, movBoxes.moovEnd);
  await run("GET range:startup (observed pre-prime)", async () => {
    const expectedLength = startupCase.end - startupCase.start + 1;
    const requestResult = await get("range:startup", "GET", startupCase.range, { expectedStatus: 206, expectedBodyBytes: expectedLength, maxBodyBytes: expectedLength });
    const facts = validateValidRange(startupCase, requestResult.response, requestResult.body);
    etag ??= facts.etag;
    if (startupRangeMaxMs !== undefined && requestResult.elapsedMs > startupRangeMaxMs) throw new Error(`startup range latency ${requestResult.elapsedMs}ms exceeds acceptance threshold ${startupRangeMaxMs}ms`);
  });
  await run("HEAD", async () => {
    const { response, body } = await get("HEAD", "HEAD", undefined, { expectedStatus: 200, maxBodyBytes: 0 });
    if (body.length !== 0) throw new Error(`HEAD returned ${body.length} body bytes`);
    const facts = common(response, expectedBytes, etag);
    etag ??= facts.etag;
  });
  await run("GET full (cache-prime observation)", async () => {
    const { response, body } = await get("GET full (cache-prime observation)", "GET", undefined, { expectedStatus: 200, expectedBodyBytes: expectedBytes, maxBodyBytes: expectedBytes });
    const facts = common(response, expectedBytes, etag);
    etag ??= facts.etag;
    if (!bytesEqual(body, expected)) throw new Error("full response bytes differ from checked-in MOV");
  });
  await run("GET full (warm cache)", async () => {
    const { response, body } = await get("GET full (warm cache)", "GET", undefined, { expectedStatus: 200, expectedBodyBytes: expectedBytes, maxBodyBytes: expectedBytes });
    common(response, expectedBytes, etag);
    warmCache = validateWarmCache(responseDetails(response));
    if (!bytesEqual(body, expected)) throw new Error("warm full response bytes differ from checked-in MOV");
  });
  for (const rangeCase of createRangeCases(expectedBytes, movBoxes.moovEnd)) {
    const warmName = `${rangeCase.name} (warm)`;
    await run(warmName, async () => {
      const expectedLength = "invalid" in rangeCase ? undefined : rangeCase.end - rangeCase.start + 1;
      const maxBodyBytes = expectedLength ?? MAX_ERROR_BODY_BYTES;
      const { response, body } = await get(warmName, "GET", rangeCase.range, { expectedStatus: rangeCase.expectedStatus, expectedBodyBytes: expectedLength, maxBodyBytes });
      if ("invalid" in rangeCase) {
        if (response.headers.get("content-range") !== `bytes */${expectedBytes}`) throw new Error(`invalid Content-Range ${JSON.stringify(response.headers.get("content-range"))}`);
        if (response.headers.get("content-encoding")?.trim()) throw new Error("Content-Encoding must be absent");
        const invalidEtag = response.headers.get("etag")?.trim();
        if (invalidEtag && etag !== undefined && invalidEtag !== etag) throw new Error(`ETag changed from ${etag} to ${invalidEtag}`);
        validateCorsAndCacheHeaders(responseDetails(response), siteOrigin);
        void body;
        return;
      }
      const facts = validateValidRange(rangeCase, response, body);
      etag ??= facts.etag;
    });
  }
  const startupRange = requestObservations.find(({ name }) => name === "range:startup");
  return { url, siteOrigin, expectedBytes, expectedHash, movBoxes, etag, startupRange, startupRangeMaxMs, warmCache, requestObservations, results, failures, elapsedMs: Date.now() - startedAt };
}

async function main(): Promise<void> {
  const { url, siteOrigin, timeoutMs, totalTimeoutMs, startupRangeMaxMs } = resolveProbeArguments(process.argv.slice(2));
  const expected = await readFile(HERO_MEDIA_PATH);
  const report = await runMediaOriginProbe({ url, siteOrigin, expectedBytes: expected, timeoutMs, totalTimeoutMs, startupRangeMaxMs });
  console.log(`Media origin probe: ${url}`);
  console.log(`Site Origin: ${siteOrigin}`);
  console.log(`Expected asset: ${report.expectedBytes} bytes, SHA-256 ${report.expectedHash}`);
  console.log(`MOV Fast Start: moov=${report.movBoxes.moov}, moovEnd=${report.movBoxes.moovEnd}, mdat=${report.movBoxes.mdat}`);
  console.log(`Total runtime: ${report.elapsedMs}ms / deadline ${totalTimeoutMs}ms`);
  const startup = report.startupRange;
  console.log(`Startup range (before full-cache observation): ${startup?.cacheStatus ?? "unknown"}${startup?.ageHeader === undefined ? "" : `, Age ${startup.ageHeader}s`}, ${startup?.elapsedMs ?? "unknown"}ms, ${startup?.responseBytes ?? "unknown"} bytes`);
  console.log("Request observations:");
  for (const observation of report.requestObservations) {
    const cache = observation.cacheStatus ?? "unknown";
    const bytes = observation.responseBytes === undefined ? "unknown" : `${observation.responseBytes} bytes`;
    console.log(`  ${observation.name}: ${observation.status ?? "no response"}, ${observation.elapsedMs}ms, ${bytes}, cache=${cache}${observation.error === undefined ? "" : `, error=${observation.error}`}`);
  }
  console.log(report.results.join("\n"));
  if (report.failures.length > 0) throw new Error(`RED — ${report.failures.length} acceptance check(s) failed`);
  const cache = report.warmCache;
  const startupPerformance = startupRangeMaxMs === undefined
    ? `startup range ${startup?.elapsedMs ?? "unknown"}ms observed; no origin latency threshold requested`
    : `startup range ${startup?.elapsedMs ?? "unknown"}ms <= origin threshold ${startupRangeMaxMs}ms`;
  console.log(`GREEN — protocol-only byte-range origin contract passed with stable ETag ${report.etag}; warm cache ${cache?.status ?? "unknown"}, Age ${cache?.ageSeconds ?? "unknown"}s; ${startupPerformance}. Real-device cellular performance remains a separate gate.`);
}
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedFile) main().catch((error) => { console.error(`\n${formatError(error)}`); process.exitCode = 1; });
