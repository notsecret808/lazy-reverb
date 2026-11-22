import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { evaluate, withBrowser } from "../../tools/browser-session.js";

const browser = process.env.LAZY_REVERB_BROWSER ?? "/usr/bin/firefox";
const driver = process.env.LAZY_REVERB_GECKODRIVER ?? resolve("dist/drivers/geckodriver");
const artifactsRoot = process.env.LAZY_REVERB_ARTIFACTS ?? "dist/native";

for (const reason of ["install", "exception", "timeout", "crash"] as const) {
  await test(`сессия освобождает профиль при сбое ${reason}`, async () => {
    const artifacts = resolve(artifactsRoot, `cleanup-${reason}`);
    let profile: string | undefined;
    await assert.rejects(withBrowser({ browser, driver, artifacts, timeout: 8000 }, async session => {
      session.step = `контролируемый сбой ${reason}`;
      const { client } = session;
      const capabilities: object = client.capabilities;
      assert("moz:profile" in capabilities && typeof capabilities["moz:profile"] === "string");
      profile = capabilities["moz:profile"];
      const { context } = await client.browsingContextCreate({ type: "tab" });
      session.context = context;
      await client.browsingContextNavigate({ context, url: "data:text/html,<title>Cleanup</title>", wait: "complete" });
      await evaluate(client, context, "console.error('cleanup marker')");
      switch (reason) {
        case "install": {
          const invalidZip = join(artifacts, "invalid.zip");
          await writeFile(invalidZip, "invalid ZIP");
          await session.install(invalidZip);
          break;
        }
        case "exception": throw new Error("контрольное исключение");
        case "timeout": await delay(15_000, undefined, { ref: false }); break;
        case "crash": {
          assert("moz:processID" in capabilities && typeof capabilities["moz:processID"] === "number");
          const pid = capabilities["moz:processID"];
          process.kill(pid, "SIGKILL");
          await delay(150);
          await evaluate(client, context, "document.title");
          break;
        }
      }
    }));
    assert(profile, "сессия должна открыть временный профиль перед контролируемым сбоем");
    await assert.rejects(access(profile), { code: "ENOENT" });
    await access(join(artifacts, "driver.log"));
    assert.match(await readFile(join(artifacts, "failure.txt"), "utf8"), new RegExp(reason));
    if (reason === "exception" || reason === "install") {
      await access(join(artifacts, "screenshot.png"));
      await access(join(artifacts, "page.html"));
      assert.match(await readFile(join(artifacts, "console.log"), "utf8"), /cleanup marker/);
    }
  });
}
