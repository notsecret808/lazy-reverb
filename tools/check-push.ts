import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkArguments, runChecks } from "./test.js";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const options = checkArguments(process.argv.slice(2), "push");
if (options) {
  const updates = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
  const commits = [];
  for (const line of updates ? updates.split("\n") : []) {
    const [, sha] = line.trim().split(/\s+/);
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("Не удалось определить публикуемый коммит из Git pre-push");
    if (!/^0+$/.test(sha)) commits.push(sha);
  }
  if (commits.length || !updates) {
    if (git("status", "--porcelain=v1", "--untracked-files=normal")) throw new Error("Перед check:push требуется чистое рабочее дерево");
    const tree = git("rev-parse", "HEAD^{tree}");
    for (const sha of commits) {
      if (git("rev-parse", `${sha}^{tree}`) !== tree) throw new Error(`Опубликованный коммит ${sha} отличается от проверяемого дерева HEAD`);
    }
    process.exitCode = await runChecks("push", options);
  }
}
