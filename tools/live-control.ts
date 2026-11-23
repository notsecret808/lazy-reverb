import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { liveArguments, liveReport, liveSession, openLive, readLive } from "./live-session.js";

const options = liveArguments("control");
if (options) {
  const url = options.urls[0];
  const samples = await liveSession("control", options, async session => {
    const context = await openLive(session, url);
    const rows: unknown[] = [];
    for (let index = 0; index < 14; index++) {
      await delay(5000);
      const state = await readLive(session, context, `(() => {
        const media = document.querySelector('video');
        return { extensionAbsent: window.__lazyReverb === undefined, title:document.title,
          media:media && {paused:media.paused,ready:media.readyState,time:media.currentTime,error:media.error?.code ?? null},
          playbackMessage:document.querySelector('.ytp-error-content-wrap')?.innerText ?? null };
      })()`);
      assert(typeof state === "object" && state !== null && "extensionAbsent" in state && state.extensionAbsent === true);
      rows.push(state);
      if ("playbackMessage" in state && state.playbackMessage) break;
    }
    return rows;
  });
  await liveReport("live-control-without-addon.json", { url, addon: "absent in fresh profile", samples });
}
