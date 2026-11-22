import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserSession } from "../../tools/browser-session.js";

const playerOrigins = new Set(["https://www.youtube.com", "https://music.youtube.com", "https://soundcloud.com", "https://unsupported.test"]);
const audioOrigins = new Set([...playerOrigins, "https://audio.test"]);

const wave = Buffer.alloc(44 + 48_000 * 2);
wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(48_000, 24); wave.writeUInt32LE(96_000, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
for (let index = 0; index < 48_000; index++) {
  wave.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 120 / 48_000) * 2800), 44 + index * 2);
}

export async function interceptFixture({ client, artifacts }: BrowserSession) {
  const playerHtml = await readFile(new URL("./fixtures/player.html", import.meta.url), "utf8");
  const journal: { url: string; action: "local" | "abort" }[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<unknown>>();
  await client.sessionSubscribe({ events: ["network.beforeRequestSent"] });
  await client.networkAddIntercept({ phases: ["beforeRequestSent"], urlPatterns: [
    { type: "pattern", protocol: "http" }, { type: "pattern", protocol: "https" },
  ] });
  client.on("network.beforeRequestSent", event => {
    if (!event.isBlocked) return;
    const { url, request } = event.request;
    const { origin, pathname } = new URL(url);
    const isAudio = audioOrigins.has(origin) && pathname === "/tone.wav";
    const isPage = playerOrigins.has(origin) && pathname === "/player";
    journal.push({ url, action: isAudio || isPage ? "local" : "abort" });
    const task = (isAudio || isPage
      ? client.networkProvideResponse({ request, statusCode: 200, headers: [
          { name: "Content-Type", value: { type: "string", value: isAudio ? "audio/wav" : "text/html; charset=UTF-8" } },
        ], body: isAudio ? { type: "base64", value: wave.toString("base64") } : { type: "string", value: playerHtml } })
      : client.networkFailRequest({ request })).catch((error: unknown) => { failures.push(error); });
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task)).catch((error: unknown) => { failures.push(error); });
  });
  return {
    journal,
    async verify() {
      await Promise.all(pending);
      await writeFile(join(artifacts, "network.json"), `${JSON.stringify(journal, null, 2)}\n`);
      if (failures.length) throw new AggregateError(failures, "HTTP(S) interception failed");
    },
  };
}
