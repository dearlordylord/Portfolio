import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const roots = ["Кадры", "icon", "Проекты"];
const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;
const HEVC_MANIFEST = "public/video-prototype/hero-hevc-alpha-hq.manifest.json";
const PRODUCTION_NATIVE_ASSETS = ["video-prototype/hero-alpha-vp9.webm"];
const FORBIDDEN_PRODUCTION_OUTPUTS = [
  "dist/prototype-video.html",
  "dist/video-prototype/hero-color-matte.mp4",
  "dist/video-prototype/hq-hero-color-matte.mp4",
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

let count = 0;
let bytes = 0;
let largest = { relative: "", size: 0 };

for (const forbidden of FORBIDDEN_PRODUCTION_OUTPUTS) {
  try {
    await stat(forbidden);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Draft-only output leaked into production dist: ${forbidden}`);
}
for (const root of roots) {
  const sourceFiles = await filesBelow(root);
  if (sourceFiles.length === 0) throw new Error(`Runtime asset root is empty: ${root}`);
  for (const source of sourceFiles) {
    const relative = path.relative(".", source);
    const destination = path.join("dist", relative);
    const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
    if (sourceStat.size !== destinationStat.size) {
      throw new Error(`Production asset differs from source: ${relative}`);
    }
    const [sourceDigest, destinationDigest] = await Promise.all([digest(source), digest(destination)]);
    if (sourceDigest !== destinationDigest) {
      throw new Error(`Production asset content differs from source: ${relative}`);
    }
    if (sourceStat.size > MAX_STATIC_ASSET_BYTES) {
      throw new Error(
        `Static asset exceeds Cloudflare Pages' 25 MiB limit: ${relative} (${(
          sourceStat.size /
          1024 /
          1024
        ).toFixed(1)} MiB)`,
      );
    }
    if (sourceStat.size > largest.size) largest = { relative, size: sourceStat.size };
    count += 1;
    bytes += sourceStat.size;
  }
}

const hevcManifest = JSON.parse(await readFile(HEVC_MANIFEST, "utf8"));
const hevcFileName = hevcManifest?.output?.fileName;
const hevcExpectedBytes = hevcManifest?.output?.bytes;
const hevcExpectedSha256 = hevcManifest?.output?.sha256;
if (
  typeof hevcFileName !== "string"
  || !Number.isInteger(hevcExpectedBytes)
  || hevcExpectedBytes <= 0
  || typeof hevcExpectedSha256 !== "string"
  || !/^[a-f0-9]{64}$/i.test(hevcExpectedSha256)
) {
  throw new Error(`Invalid checked-in HEVC manifest: ${HEVC_MANIFEST}`);
}

const hevcSource = path.join("public/video-prototype", hevcFileName);
const hevcDestination = path.join("dist/video-prototype", hevcFileName);
const hevcManifestDestination = path.join("dist/video-prototype", path.basename(HEVC_MANIFEST));
const [hevcSourceStat, hevcDestinationStat] = await Promise.all([
  stat(hevcSource),
  stat(hevcDestination),
]);
if (hevcSourceStat.size !== hevcExpectedBytes || hevcDestinationStat.size !== hevcExpectedBytes) {
  throw new Error(`HEVC candidate byte count differs from its manifest: ${hevcFileName}`);
}
if (hevcSourceStat.size > MAX_STATIC_ASSET_BYTES) {
  throw new Error(`HEVC candidate exceeds Cloudflare Pages' 25 MiB limit: ${hevcFileName}`);
}
const [hevcSourceDigest, hevcDestinationDigest, sourceManifestDigest, distManifestDigest] = await Promise.all([
  digest(hevcSource),
  digest(hevcDestination),
  digest(HEVC_MANIFEST),
  digest(hevcManifestDestination),
]);
if (hevcSourceDigest !== hevcExpectedSha256 || hevcDestinationDigest !== hevcExpectedSha256) {
  throw new Error(`HEVC candidate SHA-256 differs from its manifest: ${hevcFileName}`);
}
if (sourceManifestDigest !== distManifestDigest) {
  throw new Error(`Production HEVC manifest differs from source: ${HEVC_MANIFEST}`);
}
count += 2;
bytes += hevcSourceStat.size + (await stat(HEVC_MANIFEST)).size;
if (hevcSourceStat.size > largest.size) largest = { relative: hevcSource, size: hevcSourceStat.size };

// Verify the production native ladder's A asset is copied byte-for-byte. The
// H pair is checked above against its manifest; B is intentionally excluded.
const productionAssetChecks = await Promise.all(PRODUCTION_NATIVE_ASSETS.map(async (relative) => {
  const source = path.join("public", relative);
  const destination = path.join("dist", relative);
  const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
  if (sourceStat.size !== destinationStat.size) {
    throw new Error(`Production native asset differs in size: ${relative}`);
  }
  const [sourceDigest, destinationDigest] = await Promise.all([digest(source), digest(destination)]);
  if (sourceDigest !== destinationDigest) {
    throw new Error(`Production native asset differs in content: ${relative}`);
  }
  return { relative, size: sourceStat.size };
}));
for (const asset of productionAssetChecks) {
  count += 1;
  bytes += asset.size;
  if (asset.size > largest.size) largest = asset;
}

console.log(
  `Verified ${count} runtime assets in dist (${(bytes / 1024 / 1024).toFixed(1)} MiB); largest is ${
    largest.relative
  } (${(largest.size / 1024 / 1024).toFixed(1)} MiB)`,
);
