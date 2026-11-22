import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import husky from "husky";

if (existsSync(".git")) {
  const current = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (current.error || (current.status !== 0 && current.status !== 1)) {
    throw new Error("Не удалось проверить текущий Git hooksPath.", { cause: current.error });
  }
  if (current.status === 0 && current.stdout.trim() !== ".husky/_") {
    throw new Error(`Уже установлен core.hooksPath (${current.stdout.trim()}). Существующие hooks требуют явной настройки совместной работы.`);
  }
  const error = husky();
  if (error) throw new Error(error);
}
