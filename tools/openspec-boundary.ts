import { execFileSync } from "node:child_process";
import { basename, extname } from "node:path/posix";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "latin1", maxBuffer: 32 * 1024 * 1024 });
}

function forbidden(path: string, objectId: string): boolean {
  const parts = path.split("/");
  if (parts.includes("openspec") || parts.includes(".openspec-store")) return true;

  const integration = parts.some(part => ["skills", "commands", "prompts"].includes(part));
  if (integration && parts.some(part => /^(?:openspec-|opsx[-:])|^opsx$/.test(part))) return true;

  const skillLock = [".skill-lock.json", "skills-lock.json"].includes(basename(path));
  if (!skillLock && extname(path) !== ".md") return false;
  const content = git("cat-file", "blob", objectId);
  return content.includes("<!-- OPENSPEC:START -->") || (skillLock && content.includes("openspec-"));
}

export function verifyOpenSpecBoundary(...revisions: string[]): void {
  const diff = git("diff", "--raw", "--no-abbrev", "--no-renames", "--diff-filter=ACMT", "-z", ...revisions).split("\0");
  const blocked: string[] = [];
  for (let index = 0; index + 1 < diff.length; index += 2) {
    const entry = diff[index].split(" ");
    const path = diff[index + 1];
    if (forbidden(path, entry[3])) blocked.push(Buffer.from(path, "latin1").toString("utf8"));
  }
  if (blocked.length) {
    throw new Error(`OpenSpec files belong in lazy-reverb-plans. Disallowed paths: ${blocked.map(path => JSON.stringify(path)).join(", ")}`);
  }
}
