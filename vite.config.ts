import { cp, rm } from "node:fs/promises";
import path from "node:path";

import { defineConfig, type Plugin } from "vite";

const RUNTIME_ASSET_DIRECTORIES = ["Кадры", "icon", "Проекты"] as const;
const PRODUCTION_EXCLUDED_OUTPUTS = [
  "prototype-video.html",
  "video-prototype/hero-color-matte.mp4",
  "video-prototype/hq-hero-color-matte.mp4",
] as const;

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
      // `public/` is also copied by Vite, while the packed B files and the
      // architecture-study page remain tracked draft inputs. Remove only the
      // known draft outputs from this production bundle; never delete source
      // files or other user assets.
      await Promise.all(
        PRODUCTION_EXCLUDED_OUTPUTS.map((relative) =>
          rm(path.join(outputDirectory, relative), { force: true }),
        ),
      );
    },
  };
}

export default defineConfig({
  plugins: [copyRuntimeAssets()],
  build: {
    // Production emits only the real portfolio. The architecture study stays
    // in source for future investigation but is not shipped as a public page.
    rollupOptions: {
      input: {
        main: path.resolve("index.html"),
      },
    },
  },
});
