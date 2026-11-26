import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { defineConfig } from "wxt";
import { extensionHosts } from "./src/extension-hosts.js";

const chromiumIconSizes = [48, 96, 128];

export default defineConfig({
  srcDir: "src",
  imports: false,
  manifestVersion: 3,
  manifest({ browser }) {
    const firefox = browser === "firefox";
    return {
      name: "Lazy Reverb",
      description: "Slowed playback, reverb, and bass boost for YouTube and SoundCloud. Audio is processed on your device.",
      permissions: ["scripting", "storage"],
      host_permissions: extensionHosts,
      ...(firefox ? {
        browser_specific_settings: {
          gecko: {
            id: "lazy-reverb@local.example",
            strict_min_version: "128.0",
            data_collection_permissions: { required: ["none"] },
          },
        },
      } : { minimum_chrome_version: "128" }),
      action: {
        default_title: "Lazy Reverb",
        default_icon: firefox ? "icon.svg" : "icon-48.png",
      },
      icons: firefox
        ? { 48: "icon.svg", 96: "icon.svg" }
        : Object.fromEntries(chromiumIconSizes.map(size => [size, `icon-${size}.png`])),
      commands: {
        _execute_action: {
          suggested_key: firefox ? { default: "Ctrl+Shift+F8" } : { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" },
          description: "Open Lazy Reverb",
        },
      },
    };
  },
  vite: () => ({ build: { target: ["firefox128", "chrome128"], modulePreload: false } }),
  hooks: {
    "build:publicAssets"(wxt, files) {
      if (wxt.config.browser === "firefox") {
        files.push({ absoluteSrc: join(wxt.config.root, "icon.svg"), relativeDest: "icon.svg" });
      }
    },
    async "build:done"(wxt) {
      if (wxt.config.browser === "firefox") return;
      const source = await readFile(join(wxt.config.root, "icon.svg"), "utf8");
      await Promise.all(chromiumIconSizes.map(async size => {
        const icon = new Resvg(source, { fitTo: { mode: "width", value: size } }).render();
        await writeFile(join(wxt.config.outDir, `icon-${size}.png`), icon.asPng());
      }));
    },
  },
});
