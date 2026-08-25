import { cp } from "node:fs/promises";
import path from "node:path";

import { defineConfig, type Plugin } from "vite";

const RUNTIME_ASSET_DIRECTORIES = ["Кадры", "icon", "Проекты"] as const;

/**
 * These assets are addressed by runtime manifests/frame numbers, so Vite's
 * static import graph cannot discover them. Keep one source copy and mirror
 * the directories into dist after every production bundle.
 */
function copyRuntimeAssets(): Plugin {
  return {
    name: "copy-runtime-assets",
    apply: "build",
    async writeBundle(options) {
      const outputDirectory = path.resolve(String(options.dir ?? "dist"));
      await Promise.all(
        RUNTIME_ASSET_DIRECTORIES.map((directory) =>
          cp(path.resolve(directory), path.join(outputDirectory, directory), {
            recursive: true,
            force: true,
          }),
        ),
      );
    },
  };
}

export default defineConfig({
  plugins: [copyRuntimeAssets()],
});
