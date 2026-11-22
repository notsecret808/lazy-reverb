import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Sample } from "./performance-gate.js";

export interface ProcessRow { pid: number; parent: number; start: number; ticks: number }
export interface Snapshot { time: number; processes: Map<number, ProcessRow>; pss: number }

function integer(text: string | undefined): number {
  const number = Number(text);
  if (!text || !Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid /proc counter value: ${text}`);
  return number;
}

export function parseStat(line: string): ProcessRow {
  const open = line.indexOf(" (");
  const close = line.lastIndexOf(")");
  if (open <= 0 || close <= open) throw new Error("Invalid /proc/PID/stat format");
  const fields = line.slice(close + 1).trim().split(/\s+/);
  return { pid: integer(line.slice(0, open)), parent: integer(fields[1]), start: integer(fields[19]), ticks: integer(fields[11]) + integer(fields[12]) };
}

export function parsePss(text: string): number {
  const match = /^Pss:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new Error("Could not read process PSS");
  return integer(match[1]);
}

export function processGroup(root: number, table: Map<number, ProcessRow>): Map<number, ProcessRow> {
  const browser = table.get(root);
  if (!browser) throw new Error(`Root browser process ${root} disappeared`);
  const owned = new Map([[root, browser]]);
  let size: number;
  do {
    size = owned.size;
    for (const row of table.values()) if (owned.has(row.parent)) owned.set(row.pid, row);
  } while (owned.size !== size);
  return owned;
}

export function sampleDelta(before: Snapshot, after: Snapshot, hz: number): Sample {
  const interval = (after.time - before.time) / 1000;
  if (!(interval > 0) || !(hz > 0) || !Number.isFinite(after.pss) || after.pss <= 0) throw new Error("Incomplete CPU/PSS sample interval");
  if (before.processes.size === 0 || before.processes.size !== after.processes.size) throw new Error("Browser process group changed");
  let ticks = 0;
  for (const [id, begin] of before.processes) {
    const end = after.processes.get(id);
    if (!end || end.start !== begin.start) throw new Error(`Browser process changed: ${id}`);
    if (end.ticks < begin.ticks) throw new Error(`CPU counter reset: ${id}`);
    ticks += end.ticks - begin.ticks;
  }
  return { cpu_percent_one_core: Math.round(ticks / hz / interval * 10_000) / 100, pss_mib: after.pss / 1024, interval_seconds: interval };
}

export function browserPid(capabilities: object): number {
  if (!("moz:processID" in capabilities) || typeof capabilities["moz:processID"] !== "number" || capabilities["moz:processID"] <= 0) {
    throw new Error("GeckoDriver did not report a browser PID");
  }
  return capabilities["moz:processID"];
}

export function makeSampler(root: number) {
  if (process.platform !== "linux") throw new Error("CPU/PSS sampling requires Linux /proc");
  const hz = integer(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  const rootProcess = parseStat(readFileSync(`/proc/${root}/stat`, "utf8"));
  return {
    hz,
    snapshot(): Snapshot {
      const table = new Map<number, ProcessRow>();
      for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
        try {
          const row = parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
          table.set(row.pid, row);
        } catch { /* An unrelated process may have exited between reads. */ }
      }
      const time = performance.now();
      const processes = processGroup(root, table);
      if (processes.get(root)?.start !== rootProcess.start) throw new Error("Root browser PID was reused");
      let pss = 0;
      for (const [pid, row] of processes) {
        pss += parsePss(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
        if (parseStat(readFileSync(`/proc/${pid}/stat`, "utf8")).start !== row.start) throw new Error(`PID was reused while reading PSS: ${pid}`);
      }
      return { time, processes, pss };
    },
  };
}
