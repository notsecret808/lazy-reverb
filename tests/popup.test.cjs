const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const code = readFileSync(`${__dirname}/../popup.js`, 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function popup({ url = 'https://www.youtube.com/watch?v=test', preferences, configured = true, unavailable = false, shortcut = 'Ctrl+Shift+F8' } = {}) {
  const selectors = ['enabled', 'rate', 'mix', 'bass', 'controls', 'status', 'rate-value', 'mix-value', 'bass-value', 'shortcut', 'shortcut-reset'];
  const elements = Object.fromEntries(selectors.map(name => [name, {
    value: '', checked: false, disabled: true, textContent: '', events: {},
    addEventListener(name, listener) { this.events[name] = listener; },
  }]));
  const preset = { dataset: { rate: '0.85', mix: '0.25' }, events: {},
    addEventListener(name, listener) { this.events[name] = listener; }, setAttribute() {} };
  let state = { enabled: false, rate: 0.85, mix: 0.25, bass: 0, configured, mediaCount: 1, graphCount: 0 };
  const calls = []; const saves = [];
  const failures = { injection: false, storage: false, shortcut: false };
  const browser = {
    commands: {
      getAll: async () => [{ name: '_execute_action', shortcut }],
      update: async command => {
        if (failures.shortcut) { failures.shortcut = false; throw Error('Сочетание недоступно'); }
        assert.equal(command.name, '_execute_action'); shortcut = command.shortcut;
      },
    },
    tabs: { query: async () => [{ id: 42, url }] },
    scripting: { executeScript: async request => {
      calls.push(request);
      if (failures.injection) { failures.injection = false; throw Error('Вкладка недоступна'); }
      if (unavailable) return [{ result: null }];
      if (request.args[0]) state = { ...state, ...Object.fromEntries(Object.entries(request.args[0]).filter(([, value]) => value !== undefined)), configured: true };
      return [{ result: { ...state } }];
    } },
    storage: { local: {
      get: async () => ({ preferences }),
      set: async data => {
        if (failures.storage) { failures.storage = false; throw Error('Не удалось сохранить настройки'); }
        saves.push(data);
      },
    } },
  };
  vm.runInNewContext(code, {
    browser, URL, document: {
      querySelector: selector => elements[selector.slice(1)],
      querySelectorAll: () => [preset],
    },
  });
  await settle();
  return { elements, calls, saves, failures, preset, state: () => state };
}

test('unsupported protocols and lookalike hosts never receive injected code', async () => {
  for (const url of ['about:blank', 'https://www.youtube.com.evil.test/', 'http://soundcloud.com/']) {
    const { elements, calls } = await popup({ url });
    assert.equal(calls.length, 0, url);
    assert.equal(elements.enabled.disabled, true);
    assert.match(elements.status.textContent, /Откройте YouTube или SoundCloud/);
  }
});

test('old saved preferences load with bass off, and loading preferences does not enable effects', async () => {
  const { state, elements } = await popup({ configured: false, preferences: { rate: 0.8, mix: 0.4 } });
  assert.equal(state().rate, 0.8); assert.equal(state().mix, 0.4); assert.equal(state().bass, 0);
  assert.equal(state().enabled, false); assert.equal(elements.enabled.disabled, false);
  assert.equal(elements['rate-value'].value, '0,80×');
  assert.equal(elements['bass-value'].value, '0 дБ');
});

test('rapid slider input applies and saves the final combination without replaying stale values', async () => {
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
  assert.equal(elements['bass-value'].value, '+6 дБ');
});

test('presets turn the effect on and preserve the separately chosen bass level', async () => {
  const { preset, elements, state } = await popup();
  elements.bass.value = '8';
  preset.events.click(); await settle();
  assert.equal(state().enabled, true); assert.equal(state().rate, 0.85); assert.equal(state().mix, 0.25); assert.equal(state().bass, 8);
});

test('missing engine explains that the page needs refreshing, with controls disabled', async () => {
  const { elements } = await popup({ unavailable: true });
  assert.equal(elements.enabled.disabled, true);
  assert.match(elements.status.textContent, /Обновите страницу/);
});

test('a failed injection does not poison the update queue or save unapplied settings', async () => {
  const { elements, failures, saves, state } = await popup();
  elements.rate.value = '0.7'; elements.mix.value = '0.3'; elements.bass.value = '4'; elements.enabled.checked = true;
  failures.injection = true; elements.bass.events.input(); await settle();
  assert.equal(saves.length, 0); assert.match(elements.status.textContent, /Вкладка недоступна/);
  elements.bass.value = '5'; elements.bass.events.input(); await settle();
  assert.equal(state().bass, 5); assert.equal(saves.length, 1);
  assert.match(elements.status.textContent, /Эффект включён/);
});

test('a storage failure is visible and subsequent updates can still be saved', async () => {
  const { elements, failures, saves, state } = await popup();
  elements.rate.value = '0.9'; elements.mix.value = '0'; elements.bass.value = '6'; elements.enabled.checked = true;
  failures.storage = true; elements.bass.events.input(); await settle();
  assert.equal(state().bass, 6); assert.match(elements.status.textContent, /Не удалось сохранить/);
  elements.bass.value = '7'; elements.bass.events.input(); await settle();
  assert.equal(saves.length, 1); assert.equal(saves[0].preferences.bass, 7);
});

test('the actual registered shortcut is shown and can be reassigned even on unsupported tabs', async () => {
  const { elements, calls } = await popup({ url: 'about:blank', shortcut: 'Alt+Shift+L' });
  assert.match(elements.shortcut.textContent, /Alt\+Shift\+L/);
  elements['shortcut-reset'].events.click(); await settle();
  assert.match(elements.shortcut.textContent, /Ctrl\+Shift\+F8/);
  assert.equal(calls.length, 0); assert.equal(elements.enabled.disabled, true);
});

test('unassigned shortcuts and binding errors are visible without disrupting media controls', async () => {
  const { elements, failures } = await popup({ shortcut: '' });
  assert.match(elements.shortcut.textContent, /не назначена/);
  failures.shortcut = true; elements['shortcut-reset'].events.click(); await settle();
  assert.match(elements.shortcut.textContent, /Сочетание недоступно/);
  assert.equal(elements.enabled.disabled, false);
});
