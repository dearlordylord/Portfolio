import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const roots = ["Кадры", "icon", "Проекты"];
const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;

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

console.log(
  `Verified ${count} runtime assets in dist (${(bytes / 1024 / 1024).toFixed(1)} MiB); largest is ${
    largest.relative
  } (${(largest.size / 1024 / 1024).toFixed(1)} MiB)`,
);
