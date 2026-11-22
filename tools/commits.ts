import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { verifyOpenSpecBoundary } from "./openspec-boundary.js";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" }, fallback: { type: "string" } } });
if (!values.head || !values.base) throw new Error("Проверка диапазона требует --base и --head");
const head = git("rev-parse", "--verify", "--end-of-options", `${values.head}^{commit}`);
const base = /^0+$/.test(values.base)
  ? git("merge-base", head, values.fallback ?? "origin/main")
  : git("rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`);
const commits = git("rev-list", "--reverse", `${base}..${head}`);
if (commits) {
  for (const commit of commits.split("\n")) verifyOpenSpecBoundary(`${commit}^`, commit);
  execFileSync("pnpm", ["run", "lint:commit", "--from", base, "--to", head], { stdio: "inherit" });
}
