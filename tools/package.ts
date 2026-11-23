import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTargets, generateExtension } from "./build.js";
import type { Target } from "./extension-files.js";

export async function packageExtension(target: Target = "firefox"): Promise<{ runtime: string; archive: string }> {
  const { runtime, archive } = await generateExtension(target, true);
  if (!archive) throw new Error("WXT did not produce an extension archive");
  return { runtime, archive };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  for (const target of buildTargets(process.argv.slice(2))) {
    console.log((await packageExtension(target)).archive);
  }
}
