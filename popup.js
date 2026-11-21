"use strict";
const enabled = document.querySelector("#enabled");
const rate = document.querySelector("#rate");
const mix = document.querySelector("#mix");
const bass = document.querySelector("#bass");
const controls = document.querySelector("#controls");
const status = document.querySelector("#status");
const shortcutLabel = document.querySelector("#shortcut");
const shortcutReset = document.querySelector("#shortcut-reset");
let tabId;
let queue = Promise.resolve();
let revision = 0;

async function showShortcut() {
  try {
    const commands = await browser.commands.getAll();
    const shortcut = commands.find(command => command.name === "_execute_action")?.shortcut;
    shortcutLabel.textContent = shortcut ? `${shortcut} — открыть панель` : "Горячая клавиша не назначена";
  } catch {
    shortcutLabel.textContent = "Не удалось прочитать горячую клавишу";
  }
}

shortcutReset.addEventListener("click", async () => {
  try {
    await browser.commands.update({ name: "_execute_action", shortcut: "Ctrl+Shift+F8" });
    await showShortcut();
  } catch (error) { shortcutLabel.textContent = `Не удалось назначить: ${error.message}`; }
});
showShortcut();

function labels() {
  document.querySelector("#rate-value").value = `${Number(rate.value).toLocaleString("ru-RU", { minimumFractionDigits: 2 })}×`;
  document.querySelector("#mix-value").value = `${Math.round(Number(mix.value) * 100)} %`;
  document.querySelector("#bass-value").value = `${Number(bass.value) > 0 ? "+" : ""}${Number(bass.value)} дБ`;
  for (const button of document.querySelectorAll("[data-rate]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.rate) === Number(rate.value) && Number(button.dataset.mix) === Number(mix.value)));
  }
}

async function engine(options) {
  const [result] = await browser.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: options => {
      if (!window.__lazyReverb) return null;
      return options ? window.__lazyReverb.set(options) : window.__lazyReverb.get();
    }, args: [options ?? null]
  });
  if (!result?.result) throw new Error("Обновите страницу после установки расширения.");
  return result.result;
}

function show(state) {
  if (!state.enabled) status.textContent = "Эффект выключен. Исходная скорость и тон восстановлены.";
  else if (state.error) status.textContent = state.error;
  else if (state.suspended) status.textContent = "Нажмите Play или щёлкните по странице, чтобы запустить обработку.";
  else if (state.blockedCount) status.textContent = "Скорость изменена. Для части плееров реверберация и бас-буст недоступны из-за защиты аудио.";
  else if (!state.mediaCount && !state.graphCount) status.textContent = "Настройки готовы. Включите трек или видео на странице.";
  else status.textContent = "Эффект включён в этой вкладке.";
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
  }).catch(error => { status.textContent = error.message; });
}

enabled.addEventListener("change", update);
rate.addEventListener("input", update);
mix.addEventListener("input", update);
bass.addEventListener("input", update);
for (const button of document.querySelectorAll("[data-rate]")) {
  button.addEventListener("click", () => {
    rate.value = button.dataset.rate;
    mix.value = button.dataset.mix;
    enabled.checked = true;
    update();
  });
}

(async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "about:blank");
    if (url.protocol !== "https:" || !/^(?:[\w-]+\.)*youtube\.com$|^(?:www\.)?soundcloud\.com$/.test(url.hostname)) {
      status.textContent = "Откройте YouTube или SoundCloud, чтобы включить эффект.";
      return;
    }
    tabId = tab.id;
    let state = await engine();
    if (!state.configured) {
      const { preferences } = await browser.storage.local.get("preferences");
      if (preferences) state = await engine({ rate: preferences.rate, mix: preferences.mix, bass: preferences.bass });
    }
    enabled.checked = state.enabled;
    rate.value = state.rate;
    mix.value = state.mix;
    bass.value = state.bass;
    enabled.disabled = false;
    controls.disabled = false;
    labels();
    show(state);
  } catch (error) { status.textContent = error.message; }
})();
