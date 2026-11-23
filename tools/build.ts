import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { extensionAssets, extensionScripts } from "./extension-files.js";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const dist = join(root, "dist");

export async function buildExtension(): Promise<string> {
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(join(dist, "firefox-build-"));
  try {
    await Promise.all([
      ...extensionAssets.map(file => copyFile(join(root, file), join(staging, file))),
      build({
        entryPoints: extensionScripts.map(file => join(root, "src", file.replace(/\.js$/, ".ts"))),
        outdir: staging,
        bundle: true,
        charset: "utf8",
        format: "iife",
        platform: "browser",
        target: "firefox128",
      }),
    ]);
    const manifest = await readFile(join(staging, "manifest.json"), "utf8");
    const popup = await readFile(join(staging, "popup.html"), "utf8");
    const knownFiles = new Set<string>([...extensionAssets, ...extensionScripts]);
    for (const match of manifest.matchAll(/"([^"\s]+\.(?:js|css|html|svg))"/g)) {
      if (!knownFiles.has(match[1])) throw new Error(`Unknown file in manifest.json: ${match[1]}`);
    }
    for (const match of popup.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (!knownFiles.has(match[1])) throw new Error(`Unknown file in popup.html: ${match[1]}`);
    }
    const output = join(dist, "firefox");
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  console.log(await buildExtension());
}
