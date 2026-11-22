import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { buildExtension, dist, root } from "./build.js";
import { extensionFiles } from "./extension-files.js";

async function readVersion(path: string): Promise<string> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string"
      || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error(`Некорректная версия в ${path}`);
  return data.version;
}

export async function packageExtension(runtime: string, destination?: string): Promise<string> {
  const version = await readVersion(join(runtime, "manifest.json"));
  if (version !== await readVersion(join(root, "package.json"))) throw new Error("Версии manifest.json и package.json расходятся");
  const output = destination ?? join(dist, `lazy-reverb-${version}.zip`);
  const files = await Promise.all(extensionFiles.map(async name => [name, await readFile(join(runtime, name))] as const));
  const archive = zipSync(Object.fromEntries(files));
  await mkdir(dirname(output), { recursive: true });
  const pending = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, archive, { flag: "wx" });
    await rename(pending, output);
  } finally {
    await rm(pending, { force: true });
  }
  return output;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  console.log(await packageExtension(await buildExtension()));
}
