import { browser } from "wxt/browser";
import type { EffectSettings, EffectState } from "./engine-api";

function control<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Popup element not found ${selector}`);
  return element;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const stateFields = Object.entries({
  enabled: "boolean",
  configured: "boolean",
  suspended: "boolean",
  error: "string",
  mediaCount: "number",
  graphCount: "number",
  blockedCount: "number",
  rate: "number",
  mix: "number",
  bass: "number",
} satisfies Record<keyof EffectState, "boolean" | "string" | "number">);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isState(value: unknown): value is EffectState {
  return isRecord(value) && stateFields.every(([key, type]) => typeof value[key] === type);
}

const enabled = control<HTMLInputElement>("#enabled");
const rate = control<HTMLInputElement>("#rate");
const mix = control<HTMLInputElement>("#mix");
const bass = control<HTMLInputElement>("#bass");
const controls = control<HTMLFieldSetElement>("#controls");
const status = control<HTMLElement>("#status");
const shortcutLabel = control<HTMLElement>("#shortcut");
const shortcutReset = control<HTMLButtonElement>("#shortcut-reset");
let tabId: number | undefined;
let queue = Promise.resolve();
let revision = 0;

async function showShortcut() {
  try {
    const commands = await browser.commands.getAll();
    const shortcut = commands.find(command => command.name === "_execute_action")?.shortcut;
    shortcutLabel.textContent = shortcut ? `${shortcut} — open the popup` : "No keyboard shortcut assigned";
  } catch {
    shortcutLabel.textContent = "Could not read the keyboard shortcut";
  }
}

async function resetShortcut() {
  try {
    const commands = browser.commands;
    if (hasCommandUpdate(commands)) {
      await commands.update({ name: "_execute_action", shortcut: "Ctrl+Shift+F8" });
    } else {
      await browser.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
    await showShortcut();
  } catch (error) { shortcutLabel.textContent = `Could not assign the keyboard shortcut: ${message(error)}`; }
}

function hasCommandUpdate(commands: typeof browser.commands): commands is typeof browser.commands & Pick<typeof globalThis.browser.commands, "update"> {
  return "update" in commands && typeof commands.update === "function";
}
shortcutReset.addEventListener("click", () => { resetShortcut().catch(error => { shortcutLabel.textContent = message(error); }); });
showShortcut().catch(error => { shortcutLabel.textContent = message(error); });

function preferencesInput(value: object): Partial<EffectSettings> {
  return {
    rate: "rate" in value && typeof value.rate === "number" ? value.rate : undefined,
    mix: "mix" in value && typeof value.mix === "number" ? value.mix : undefined,
    bass: "bass" in value && typeof value.bass === "number" ? value.bass : undefined,
  };
}

function labels() {
  control<HTMLOutputElement>("#rate-value").value = `${Number(rate.value).toLocaleString("en-US", { minimumFractionDigits: 2 })}×`;
  control<HTMLOutputElement>("#mix-value").value = `${Math.round(Number(mix.value) * 100)} %`;
  control<HTMLOutputElement>("#bass-value").value = `${Number(bass.value) > 0 ? "+" : ""}${Number(bass.value)} dB`;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-rate]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.rate) === Number(rate.value) && Number(button.dataset.mix) === Number(mix.value)));
  }
}

async function engine(options?: Partial<EffectSettings>): Promise<EffectState> {
  if (tabId === undefined) throw new Error("No active tab found.");
  const [result] = await browser.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: (options: unknown) => {
      if (!window.__lazyReverb) return null;
      return options ? window.__lazyReverb.set(options) : window.__lazyReverb.get();
    }, args: [options ?? null]
  });
  const state: unknown = result?.result;
  if (!isState(state)) throw new Error("Reload the page after installing the extension.");
  return state;
}

function show(state: EffectState) {
  if (!state.enabled) status.textContent = "Effects are off. Original speed and pitch settings restored.";
  else if (state.error) status.textContent = state.error;
  else if (state.suspended) status.textContent = "Press Play or click the page to start processing.";
  else if (state.blockedCount) status.textContent = "Speed changed. Reverb and bass boost are unavailable for some players due to audio protection.";
  else if (!state.mediaCount && !state.graphCount) status.textContent = "Settings are ready. Play a track or video on the page.";
  else status.textContent = "Effects are on in this tab.";
}

function update() {
  labels();
  const options = { enabled: enabled.checked, rate: Number(rate.value), mix: Number(mix.value), bass: Number(bass.value) };
  const current = ++revision;
  queue = queue.then(async () => {
    if (current !== revision) return;
    const state = await engine(options);
    if (current === revision) show(state);
    await browser.storage.local.set({ preferences: { rate: state.rate, mix: state.mix, bass: state.bass } });
  }).catch(error => { if (current === revision) status.textContent = message(error); });
}

enabled.addEventListener("change", update);
rate.addEventListener("input", update);
mix.addEventListener("input", update);
bass.addEventListener("input", update);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-rate]")) {
  button.addEventListener("click", () => {
    rate.value = button.dataset.rate ?? rate.value;
    mix.value = button.dataset.mix ?? mix.value;
    enabled.checked = true;
    update();
  });
}

async function initialize() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "about:blank");
    if (url.protocol !== "https:" || !/^(?:[\w-]+\.)*youtube\.com$|^(?:www\.)?soundcloud\.com$/.test(url.hostname)) {
      status.textContent = "Open YouTube or SoundCloud to enable effects.";
      return;
    }
    tabId = tab?.id;
    let state = await engine();
    if (!state.configured) {
      const { preferences }: { preferences?: unknown } = await browser.storage.local.get("preferences");
      if (preferences && typeof preferences === "object") {
        const { rate, mix, bass } = preferencesInput(preferences);
        state = await engine({ rate, mix, bass });
      }
    }
    enabled.checked = state.enabled;
    rate.value = String(state.rate);
    mix.value = String(state.mix);
    bass.value = String(state.bass);
    enabled.disabled = false;
    controls.disabled = false;
    labels();
    show(state);
  } catch (error) { status.textContent = message(error); }
}

initialize().catch(error => { status.textContent = message(error); });
