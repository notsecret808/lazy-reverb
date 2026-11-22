import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as settle } from "node:timers/promises";
import vm from "node:vm";
import type { EffectSettings, EffectState } from "../src/engine-api.js";

const code = readFileSync(new URL("../dist/firefox/popup.js", import.meta.url), "utf8");

interface PopupOptions {
  url?: string;
  preferences?: Partial<EffectSettings>;
  configured?: boolean;
  unavailable?: boolean;
  shortcut?: string;
}

interface InjectionRequest {
  world: string;
  target: { tabId: number };
  args: [Partial<EffectSettings> | null];
}

function deferred() {
  let resolve = () => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function control() {
  return {
    value: "", checked: false, disabled: true, textContent: "",
    events: {} as Record<string, () => void>,
    addEventListener(name: string, listener: () => void) { this.events[name] = listener; },
  };
}

async function popup({ url = 'https://www.youtube.com/watch?v=test', preferences, configured = true,
  unavailable = false, shortcut = 'Ctrl+Shift+F8' }: PopupOptions = {}) {
  const selectors = ['enabled', 'rate', 'mix', 'bass', 'controls', 'status', 'rate-value', 'mix-value', 'bass-value', 'shortcut', 'shortcut-reset'];
  const elements = Object.fromEntries(selectors.map(name => [name, control()]));
  const preset = { ...control(), dataset: { rate: '0.85', mix: '0.25' }, setAttribute() {} };
  let state: EffectState = { enabled: false, rate: 0.85, mix: 0.25, bass: 0, configured, mediaCount: 1, graphCount: 0, blockedCount: 0, suspended: false, error: '' };
  const calls: InjectionRequest[] = [];
  const saves: { preferences: Omit<EffectSettings, 'enabled'> }[] = [];
  const gates: { execute?: ReturnType<typeof deferred>; storage?: ReturnType<typeof deferred> } = {};
  const failures = { injection: false, storage: false, shortcut: false };
  const browser = {
    commands: {
      getAll: async () => [{ name: '_execute_action', shortcut }],
      update: async (command: { name: string; shortcut: string }) => {
        if (failures.shortcut) { failures.shortcut = false; throw Error('Shortcut unavailable'); }
        assert.equal(command.name, '_execute_action'); shortcut = command.shortcut;
      },
    },
    tabs: { query: async () => [{ id: 42, url }] },
    scripting: { executeScript: async (request: InjectionRequest) => {
      calls.push(request);
      const gate = gates.execute;
      delete gates.execute;
      await gate?.promise;
      if (failures.injection) { failures.injection = false; throw Error('Tab unavailable'); }
      if (unavailable) return [{ result: null }];
      const options = request.args[0];
      if (options) {
        state = {
          ...state, configured: true,
          enabled: options.enabled ?? state.enabled, rate: options.rate ?? state.rate,
          mix: options.mix ?? state.mix, bass: options.bass ?? state.bass,
        };
      }
      return [{ result: { ...state } }];
    } },
    storage: { local: {
      get: async () => ({ preferences }),
      set: async (data: { preferences: Omit<EffectSettings, "enabled"> }) => {
        const gate = gates.storage;
        delete gates.storage;
        await gate?.promise;
        if (failures.storage) { failures.storage = false; throw Error('Could not save preferences'); }
        saves.push(data);
      },
    } },
  };
  vm.runInNewContext(code, {
    browser, URL, Error, document: {
      querySelector: (selector: string) => elements[selector.slice(1)],
      querySelectorAll: () => [preset],
    },
  });
  await settle();
  return { elements, calls, saves, failures, preset, gates, state: () => state };
}

await test('unsupported protocols and lookalike hosts never receive injected code', async () => {
  for (const url of ['about:blank', 'https://www.youtube.com.evil.test/', 'http://soundcloud.com/']) {
    const { elements, calls } = await popup({ url });
    assert.equal(calls.length, 0, url);
    assert.equal(elements.enabled.disabled, true);
    assert.match(elements.status.textContent, /Open YouTube or SoundCloud/);
  }
});

await test('old saved preferences load with bass off, and loading preferences does not enable effects', async () => {
  const { state, elements } = await popup({ configured: false, preferences: { rate: 0.8, mix: 0.4 } });
  assert.equal(state().rate, 0.8); assert.equal(state().mix, 0.4); assert.equal(state().bass, 0);
  assert.equal(state().enabled, false); assert.equal(elements.enabled.disabled, false);
  assert.equal(elements['rate-value'].value, '0.80×');
  assert.equal(elements['bass-value'].value, '0 dB');
});

await test('rapid slider input applies and saves the final combination without replaying stale values', async () => {
  const { elements, calls, saves, state } = await popup();
  elements.enabled.checked = true;
  elements.rate.value = '0.66'; elements.mix.value = '0.2';
  for (let i = 0; i <= 6; i++) {
    elements.bass.value = String(i); elements.bass.events.input();
  }
  await settle();
  assert.equal(calls.length, 2); // Initial read plus the final update.
  assert.equal(state().bass, 6); assert.equal(state().rate, 0.66); assert.equal(state().mix, 0.2);
  assert.equal(saves.length, 1); assert.equal(saves[0].preferences.bass, 6);
  assert.equal(calls[1].world, 'MAIN'); assert.equal(calls[1].target.tabId, 42);
  assert.equal(elements['bass-value'].value, '+6 dB');
});

await test('presets turn the effect on and preserve the separately chosen bass level', async () => {
  const { preset, elements, state } = await popup();
  elements.bass.value = '8';
  preset.events.click(); await settle();
  assert.equal(state().enabled, true); assert.equal(state().rate, 0.85); assert.equal(state().mix, 0.25); assert.equal(state().bass, 8);
});

await test('missing engine explains that the page needs refreshing, with controls disabled', async () => {
  const { elements } = await popup({ unavailable: true });
  assert.equal(elements.enabled.disabled, true);
  assert.match(elements.status.textContent, /Reload the page/);
});

await test('a failed injection does not poison the update queue or save unapplied settings', async () => {
  const { elements, failures, saves, state } = await popup();
  elements.rate.value = '0.7'; elements.mix.value = '0.3'; elements.bass.value = '4'; elements.enabled.checked = true;
  failures.injection = true; elements.bass.events.input(); await settle();
  assert.equal(saves.length, 0); assert.match(elements.status.textContent, /Tab unavailable/);
  elements.bass.value = '5'; elements.bass.events.input(); await settle();
  assert.equal(state().bass, 5); assert.equal(saves.length, 1);
  assert.match(elements.status.textContent, /Effects are on/);
});

await test('a storage failure is visible and subsequent updates can still be saved', async () => {
  const { elements, failures, saves, state } = await popup();
  elements.rate.value = '0.9'; elements.mix.value = '0'; elements.bass.value = '6'; elements.enabled.checked = true;
  failures.storage = true; elements.bass.events.input(); await settle();
  assert.equal(state().bass, 6); assert.match(elements.status.textContent, /Could not save/);
  elements.bass.value = '7'; elements.bass.events.input(); await settle();
  assert.equal(saves.length, 1); assert.equal(saves[0].preferences.bass, 7);
});

await test('the actual registered shortcut is shown and can be reassigned even on unsupported tabs', async () => {
  const { elements, calls } = await popup({ url: 'about:blank', shortcut: 'Alt+Shift+L' });
  assert.match(elements.shortcut.textContent, /Alt\+Shift\+L/);
  elements['shortcut-reset'].events.click(); await settle();
  assert.match(elements.shortcut.textContent, /Ctrl\+Shift\+F8/);
  assert.equal(calls.length, 0); assert.equal(elements.enabled.disabled, true);
});

await test('unassigned shortcuts and binding errors are visible without disrupting media controls', async () => {
  const { elements, failures } = await popup({ shortcut: '' });
  assert.match(elements.shortcut.textContent, /No keyboard shortcut assigned/);
  failures.shortcut = true; elements['shortcut-reset'].events.click(); await settle();
  assert.match(elements.shortcut.textContent, /Shortcut unavailable/);
  assert.equal(elements.enabled.disabled, false);
});

await test("a superseded engine request failure leaves the UI and stored preferences alone", async () => {
  const { gates, elements, saves, state } = await popup();
  const pending = deferred();
  const next = deferred();
  gates.execute = pending;
  elements.enabled.checked = true;
  elements.bass.value = "2";
  elements.bass.events.input();
  await settle();

  gates.execute = next;
  elements.bass.value = "7";
  elements.bass.events.input();
  pending.reject(new Error("superseded request failure"));
  await settle();
  assert.doesNotMatch(elements.status.textContent, /superseded request failure/);
  assert.equal(saves.length, 0);
  next.resolve();
  await settle();
  assert.equal(state().bass, 7);
  assert.equal(saves[0].preferences.bass, 7);
  assert.equal(elements["bass-value"].value, "+7 dB");
});

await test("new input queues behind a write and survives a storage failure", async () => {
  const { gates, elements, saves, state } = await popup();
  const saving = deferred();
  gates.storage = saving;
  elements.enabled.checked = true;
  elements.bass.value = "2";
  elements.bass.events.input();
  await settle();
  assert.equal(state().bass, 2);
  assert.equal(saves.length, 0);

  elements.bass.value = "9";
  elements.bass.events.input();
  await settle();
  assert.equal(state().bass, 2);
  saving.reject(new Error("earlier write failure"));
  await settle();
  assert.equal(state().bass, 9);
  assert.deepEqual(saves.map(item => item.preferences.bass), [9]);
  assert.equal(elements["bass-value"].value, "+9 dB");
});
