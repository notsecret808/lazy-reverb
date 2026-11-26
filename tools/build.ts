import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import { build, zip } from "wxt";
import { verifyExtensionFiles } from "./extension-files.js";
import type { Target } from "./extension-files.js";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const dist = join(root, "dist");

export function buildTargets(args: string[]): Target[] {
  const { values } = parseArgs({ args, options: { target: { type: "string", default: "firefox" } } });
  switch (values.target) {
    case "all": return ["firefox", "chromium"];
    case "firefox": case "chromium": return [values.target];
    default: throw new Error("Unknown target: " + values.target);
  }
}

async function packageVersion(): Promise<string> {
  const value: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (value && typeof value === "object" && "version" in value && typeof value.version === "string") return value.version;
  throw new Error("Invalid package version");
}

export async function generateExtension(target: Target, packageZip: boolean) {
  const version = await packageVersion();
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(join(dist, "extension-build-"));
  try {
    const config = {
      root, browser: target === "chromium" ? "chrome" : "firefox", manifestVersion: 3 as const,
      outDir: staging, outDirTemplate: target,
      zip: { artifactTemplate: "lazy-reverb-" + version + "-" + target + ".zip", zipSources: false },
    };
    const filename = config.zip.artifactTemplate;
    if (packageZip) await zip(config);
    else await build(config);
    const runtime = join(staging, target);
    const files = await verifyExtensionFiles(runtime, target, version);
    const actual = (await readdir(runtime, { recursive: true, withFileTypes: true })).filter(entry => !entry.isDirectory());
    if (actual.length !== files.size || actual.some(entry =>
      !entry.isFile() || !files.has(relative(runtime, join(entry.parentPath, entry.name)).split(sep).join("/")))) {
      throw new Error("Unexpected file in the extension build");
    }
    if (packageZip) {
      const packed = unzipSync(await readFile(join(staging, filename)));
      if (Object.keys(packed).length !== files.size || [...files].some(file => !packed[file])) {
        throw new Error("Unexpected files in the extension archive");
      }
      for (const file of files) {
        if (!(await readFile(join(runtime, file))).equals(packed[file])) throw new Error("Archive differs from runtime: " + file);
      }
    }
    const output = join(dist, target);
    await rm(output, { recursive: true, force: true });
    await rename(runtime, output);
    const archive = packageZip ? join(dist, filename) : undefined;
    if (archive) await rename(join(staging, filename), archive);
    return { runtime: output, archive };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function buildExtension(target: Target = "firefox"): Promise<string> {
  const result = await generateExtension(target, false);
  return result.runtime;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  for (const target of buildTargets(process.argv.slice(2))) console.log(await buildExtension(target));
}
