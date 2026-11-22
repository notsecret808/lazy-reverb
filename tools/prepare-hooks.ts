import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import husky from "husky";

if (existsSync(".git")) {
  const current = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (current.error || (current.status !== 0 && current.status !== 1)) {
    throw new Error("Could not inspect the current Git hooksPath.", { cause: current.error });
  }
  if (current.status === 0 && current.stdout.trim() !== ".husky/_") {
    throw new Error(`core.hooksPath is already set (${current.stdout.trim()}). Configure the existing hooks and Husky to coexist.`);
  }
  const error = husky();
  if (error) throw new Error(error);
}
