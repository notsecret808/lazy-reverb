import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePss, parseStat, processGroup, sampleDelta } from "../tools/process-sampler.js";
import type { ProcessRow, Snapshot } from "../tools/process-sampler.js";

await test("stat учитывает скобки в имени процесса, smaps требует Pss", () => {
  const rest = ["S", 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 55, 12, 0, 0, 0, 0, 0, 0, 123];
  assert.deepEqual(parseStat(`9 (Web (renderer)) ${rest.join(" ")} 0 0`), { pid: 9, parent: 7, start: 123, ticks: 67 });
  assert.equal(parsePss("Rss: 10 kB\nPss: 3 kB\nPss_Dirty: 1 kB\n"), 3);
  assert.throws(() => parseStat("9 (malformed) S"));
  assert.throws(() => parsePss("Rss: 10 kB\nPss: unavailable"));
});

await test("дерево включает потомков и требует присутствия корня", () => {
  const table = new Map<number, ProcessRow>([
    [4, { pid: 4, parent: 3, start: 2, ticks: 20 }], [1, { pid: 1, parent: 0, start: 1, ticks: 20 }],
    [3, { pid: 3, parent: 1, start: 1, ticks: 20 }], [9, { pid: 9, parent: 8, start: 1, ticks: 20 }],
  ]);
  assert.deepEqual([...processGroup(1, table).keys()].sort((left, right) => left - right), [1, 3, 4]);
  assert.throws(() => processGroup(8, table), /исчез/);
});

await test("CPU использует только стабильный набор PID и монотонный интервал", () => {
  const snapshot = (time: number, ticks: number, start = 3): Snapshot => ({
    time, processes: new Map([[7, { pid: 7, parent: 1, start, ticks }]]), pss: 2048,
  });
  assert.deepEqual(sampleDelta(snapshot(100, 200), snapshot(2100, 300), 100), {
    cpu_percent_one_core: 50, pss_mib: 2, interval_seconds: 2,
  });
  assert.throws(() => sampleDelta(snapshot(100, 200), snapshot(2100, 300, 4), 100), /изменился/);
  assert.throws(() => sampleDelta(snapshot(100, 200), snapshot(2100, 100), 100), /сброшен/);
  assert.throws(() => sampleDelta(snapshot(100, 200), { ...snapshot(2100, 300), processes: new Map() }, 100), /состав/);
  assert.throws(() => sampleDelta(snapshot(100, 200), { ...snapshot(2100, 300), pss: NaN }, 100), /интервал/);
  assert.throws(() => sampleDelta(snapshot(100, 200), snapshot(90, 300), 100), /интервал/);
});
