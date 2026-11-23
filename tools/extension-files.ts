import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { extensionHosts } from "../src/extension-hosts.js";

export type Target = "firefox" | "chromium";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestObject(json: string): Record<string, unknown> {
  const result: unknown = JSON.parse(json);
  if (!record(result)) throw new Error("Invalid extension manifest");
  return result;
}

function localPath(value: unknown): string {
  if (typeof value === "string" && /^\/?[\w.-]+(?:\/[\w.-]+)*$/.test(value) && !/(^|\/)\.{1,2}(\/|$)/.test(value)) {
    return value.replace(/^\//, "");
  }
  throw new Error("Invalid extension resource path");
}

function popupPath(manifest: Record<string, unknown>): string {
  return localPath(record(manifest.action) ? manifest.action.default_popup : undefined);
}

export function archivePopup(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: entry => entry.name === "manifest.json" });
  const manifest = files["manifest.json"];
  if (!manifest) throw new Error("Extension archive has no manifest");
  return popupPath(manifestObject(Buffer.from(manifest).toString("utf8")));
}

function sameStrings(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && expected.every(value => actual.includes(value));
}

export async function readExtensionFiles(directory: string) {
  const manifest = manifestObject(await readFile(join(directory, "manifest.json"), "utf8"));
  const popup = popupPath(manifest);
  const entries: readonly unknown[] = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const [content] = entries;
  if (entries.length !== 1 || !record(content) || content.world !== "MAIN" || content.run_at !== "document_start"
      || !sameStrings(content.matches, extensionHosts)) throw new Error("Invalid early engine registration");
  const scripts: readonly unknown[] = Array.isArray(content.js) ? content.js : [];
  if (scripts.length !== 1) throw new Error("Expected one engine script");
  const engine = localPath(scripts[0]);
  const html = await readFile(join(directory, popup), "utf8");
  const popupScript = localPath(/<script\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1]);
  const icons = record(manifest.icons) ? Object.values(manifest.icons).map(localPath) : [];
  const actionIcon = localPath(record(manifest.action) ? manifest.action.default_icon : undefined);
  const files = new Set(["manifest.json", popup, engine, actionIcon, ...icons]);
  for (const resource of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) files.add(localPath(resource[1]));
  return { manifest, engine, popupScript, files };
}

export async function verifyExtensionFiles(directory: string, target: Target, version: string) {
  const result = await readExtensionFiles(directory);
  const { manifest } = result;
  if (manifest.manifest_version !== 3 || manifest.version !== version || "background" in manifest || "key" in manifest
      || "web_accessible_resources" in manifest || !sameStrings(manifest.permissions, ["scripting", "storage"])
      || !sameStrings(manifest.host_permissions, extensionHosts)) throw new Error("Unexpected extension manifest");
  const gecko = record(manifest.browser_specific_settings) ? manifest.browser_specific_settings.gecko : undefined;
  if (target === "firefox") {
    if (!record(gecko) || gecko.id !== "lazy-reverb@local.example" || gecko.strict_min_version !== "128.0"
        || "minimum_chrome_version" in manifest) throw new Error("Invalid Firefox profile");
  } else if ("browser_specific_settings" in manifest || manifest.minimum_chrome_version !== "128") {
    throw new Error("Invalid Chromium profile");
  }
  return result.files;
}
