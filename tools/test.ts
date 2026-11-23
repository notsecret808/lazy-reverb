import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildExtension, root } from "./build.js";
import { defaultDriver } from "./browser-session.js";
import { packageExtension } from "./package.js";
import { runPerformance } from "./performance.js";

type Mode = "check" | "native" | "unit" | "push" | "ci";
export interface CheckOptions { browser: string; driver: string; screenshot?: string }

export function checkArguments(args: string[], mode: Mode): CheckOptions | undefined {
  const { values } = parseArgs({ args, options: { browser: { type: "string" }, driver: { type: "string" }, screenshot: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    const command = mode === "check" ? "check" : mode === "push" ? "check:push" : `test${mode === "unit" ? ":unit" : ""}`;
    console.log(`pnpm run ${command} [--browser PATH] [--driver PATH] [--screenshot PNG]`);
    return undefined;
  }
  return {
    browser: values.browser ?? process.env.LAZY_REVERB_BROWSER ?? "/opt/zen/zen",
    driver: values.driver ?? defaultDriver(),
    screenshot: values.screenshot,
  };
}

function child(command: string, args: string[], env = process.env): number {
  console.log(`Check: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Check terminated by signal ${result.signal}`);
  return result.status ?? 1;
}

function testFiles(directory: string): string[] {
  return readdirSync(join(root, directory)).filter(name => name.endsWith(".test.ts")).sort((first, last) => first.localeCompare(last)).map(name => join(directory, name));
}

export async function runChecks(mode: Mode, options: CheckOptions): Promise<number> {
  if (mode === "check" || mode === "push") {
    for (const step of ["lint", "typecheck"]) {
      const status = child("pnpm", ["run", step]);
      if (status) return status;
    }
  }
  const packaged = mode === "unit" ? undefined : await packageExtension();
  const runtime = packaged?.runtime ?? await buildExtension();
  if (mode !== "native") {
    const status = child(process.execPath, ["--expose-gc", "--import", "tsx", "--test", ...testFiles("tests")]);
    if (status || mode === "unit") return status;
  }
  const archive = packaged?.archive;
  if (!archive) throw new Error("Expected a packaged extension for native checks");
  const status = child(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles("tests/native")], {
    ...process.env, LAZY_REVERB_ARCHIVE: archive, LAZY_REVERB_BROWSER: options.browser, LAZY_REVERB_GECKODRIVER: options.driver,
    LAZY_REVERB_SCREENSHOT: options.screenshot ? resolve(options.screenshot) : undefined,
  });
  if (status || mode !== "push") return status;
  return runPerformance(runtime, {
    archive, driver: options.driver, browser: process.env.LAZY_REVERB_ZEN ?? "/opt/zen/zen",
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [, , mode, ...args] = process.argv;
  if (mode !== "check" && mode !== "unit" && mode !== "native" && mode !== "ci") throw new Error("Specify check, unit, native, or ci");
  const options = checkArguments(args, mode);
  if (options) process.exitCode = await runChecks(mode, options);
}
