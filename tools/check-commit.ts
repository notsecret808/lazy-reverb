import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { verifyOpenSpecBoundary } from "./openspec-boundary.js";

verifyOpenSpecBoundary("--cached");

const expectedNode = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
if (process.versions.node !== expectedNode) {
  throw new Error(`Node ${expectedNode} is required. Run nvm use.`);
}

const unstaged = execFileSync("git", ["diff", "--name-only", "-z"], { encoding: "utf8" });
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
const files = [...unstaged.split("\0"), ...untracked.split("\0")];
const unchecked = files.filter(path => /^(?:src|tests|tools|\.husky|\.github)\/|\.(?:[cm]?[jt]s|json|ya?ml|css|html|svg)$|^\.(?:gitignore|nvmrc|npmrc)$/.test(path));
if (unchecked.length) {
  throw new Error(`Commit checks require source and configuration to match the Git index. Unstaged changes: ${unchecked.map(path => JSON.stringify(path)).join(", ")}`);
}
