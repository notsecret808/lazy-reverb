# Lazy Reverb agent instructions

## Purpose and scope

Lazy Reverb is a small WebExtension for **Zen Browser** and Firefox 128+. It offers 0.5–2× playback with pitch following speed, 0–100% reverb, and 0–12 dB bass boost on YouTube, YouTube Music, and SoundCloud. Keep overhead low and the controls simple.

Follow the environment instructions and any parent AGENTS.md. Use RTK for shell commands where the environment requires it. The project itself does not require RTK. Start with this file, README.md, ARCHITECTURE.md, and the files relevant to the task. Do not scan the home directory or user browser profiles.

## Project map

| File | Responsibility |
| --- | --- |
| `manifest.json` | Permissions, supported URLs, early engine loading in MAIN, and the `_execute_action` shortcut |
| `src/engine.ts` | Audio graph, player discovery, playback rate, effect state, and `window.__lazyReverb.get()/set()` |
| `popup.html`, `popup.css`, `src/popup.ts` | Popup, current-tab controls, local preferences, and the update queue |
| `tests/engine.test.ts`, `tests/popup.test.ts` | Behavior of the bundled engine and popup |
| `tests/native/`, `tools/browser-session.ts` | Native tests of the real ZIP in temporary Firefox or Zen profiles, using local fixtures and audio measurements |
| `tools/performance.ts`, `tools/process-sampler.ts`, `tools/performance-gate.ts`, `performance-budget.json` | Comparative CPU/PSS sampling, validation, budget checks, and noise detection |
| `tests/performance-gate.test.ts`, `tests/process-sampler.test.ts`, `tools/test.ts` | CPU/PSS fixtures and the combined functional check, which builds once |
| `tools/build.ts`, `tools/package.ts` | Firefox 128 build and ZIP containing the same six extension files |
| `ARCHITECTURE.md`, `.github/workflows/check.yml` | Control flow, resource ownership, and GitHub Actions checks |

## Invariants

1. Effects start off in every new or reloaded tab. The rate, reverb, and bass preferences persist. The enabled flag belongs to the current document.
2. Turning effects off restores the original `playbackRate` and `preservesPitch`, disconnects the bass and reverb branches, and clears `ConvolverNode.buffer`. The dry path stays connected.
3. Each element gets one `MediaElementAudioSourceNode`. Closing or suspending its context when effects turn off would mute the player. Preserve site-owned contexts and connections.
4. SoundCloud may use detached `new Audio()` players and a site-owned Web Audio graph. Keep discovery through `play()` and the source factory. Redirect `connect(destination)` and `disconnect(destination)` consistently. Leave `OfflineAudioContext` alone.
5. Keep DRM-protected streams and cross-origin streams without CORS out of Web Audio. Preserve playback and offer rate control.
6. The extension has no background process, network requests, analytics, polling, or document-wide `MutationObserver`. Scan for existing players on enable. Slider edits should reuse that result and the graph.
7. At 0% reverb, disconnect convolution. At 0 dB bass, disconnect the filter. A normal media element needs no `AudioContext` for rate control alone. Repeated toggles should reuse nodes and sources.
8. Bass uses a native 200 Hz low-shelf filter with no gain compensation. A loud source may clip. Automatic attenuation would change the product requirements. The engine validates input types and ranges independently of the popup.
9. Page code has no access to extension APIs or secrets. Scope permissions to the supported sites. The runtime has no npm or Python dependencies and loads no remote code.
10. Player and context registries must allow garbage collection. Retire paused, detached players and retain detached players that are still playing. Reconnect a previously created extension source on the next `play()` even with effects off. Preserve site-owned sources and contexts.

## Checks and gates

Run `nvm install`, `nvm use`, and `rtk run pnpm install --frozen-lockfile`. Node and pnpm are pinned in `.nvmrc` and `packageManager`. Native tests require GeckoDriver 0.37.1. Pass `--driver`, put it on `PATH`, or use `dist/drivers/geckodriver`. CI uses the same Node and pnpm versions and Firefox 159.0.

Run the functional gate with Zen:

```sh
rtk run pnpm run check --browser /opt/zen/zen
```

The gate runs `pnpm run lint` and `pnpm run typecheck` before building, then runs the unit and native tests against a fresh ZIP. Oxlint checks authored source, configuration, tools, and tests with type information. Warnings and backend failures fail the gate. TypeScript checks the browser and Node projects separately. Preserve nonzero exit codes and run automatic fixes separately. Engine tests require `node --expose-gc`. For a narrow change, start with the relevant check.

Changes to the audio graph, lifecycle, player discovery, or resource use also require the comparative gate:

```sh
rtk run pnpm run check:perf --browser /opt/zen/zen
```

The report is `dist/performance-zen.json`. Exit codes are `0` for pass, `1` for regression, and `2` for missing or noisy data. An inconclusive run does not pass. Keep the budgets fixed when diagnosing a failure. CPU is percent of one core. Memory is PSS for the entire test browser process group. The synthetic benchmark measures a narrower workload than a full YouTube or SoundCloud page.

Method 2 measures DSP using Linux `/proc`. One AudioBufferSource and one AudioContext start on a real click. GeckoDriver injects the built engine into the controlled content page between `native_before` and `native_after`. The `paused` phase disconnects the source. Each phase keeps four raw CPU/PSS samples and their intervals, with the median as both summaries. Audio-clock and signal checks run outside sampling windows. Missing samples, process churn, inactive DSP, and noise prevent a pass. CI tests the sampler and verdict against fixtures. A native result of `fail` or `inconclusive` blocks the push.

Report benchmark results and measurement limits. Keep local JSON reports in ignored `dist/`, especially reports from live-page diagnostics.

WebdriverIO installs the fresh ZIP through GeckoDriver. A normal music tab is active when the real popup document initializes in the background. Opening the popup from the toolbar and pressing the physical shortcut are manual checks. On failure, save any available screenshot, HTML, console output, driver log, and scenario step. Use temporary profiles. See [architecture](ARCHITECTURE.md).

All end-to-end tests use local HTML and WAV data. Before navigation, BiDi serves approved fixtures and aborts all other HTTP(S) requests. Service workers are disabled. Live diagnostics are separate commands, `live:probe`, `live:control`, and `live:perf`, which require an explicit URL.

CI checks lint, types, the commit range, unit fixtures, native Firefox, and the ZIP. Zen and the hardware-dependent DSP benchmark run locally.

## Packaging and manual verification

`pnpm run build` creates `dist/firefox/`. To load the directory as a temporary extension, select `dist/firefox/manifest.json`. `pnpm run package` builds the same files and writes `dist/lazy-reverb-<version>.zip`.

Loading the unsigned extension through `about:debugging` is temporary and ends on browser restart. Refresh music tabs after reloading the extension to load the new engine. Permanent installations require Mozilla signing.

The default shortcut is **Ctrl+Shift+F8**. The popup shows the registered shortcut and can assign it through `browser.commands.update`. An older assignment may persist through an update. The Zen extensions menu can pin the icon. The **Lazy** preset enables processing. **Faster** selects 1.25× with 0% reverb. For bass alone, set speed to **1.00×** and reverb to **0%**.

Report concrete changes, checks run, and measurement limits. State whether the performance gate passed.

## Commits and documentation

Use separate logical commits with Conventional Commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, or `chore:`. Describe the behavior change. Keep installed dependencies, build output, and local reports out of Git. Keep the versions in `manifest.json` and `package.json` in sync. Use `pnpm install --frozen-lockfile` to verify dependencies.

The `prepare` script enables Husky. Pre-commit checks the staged OpenSpec boundary, source/index parity, lint, types, and unit tests. Commit-msg runs local commitlint. Pre-push checks that the tree being pushed matches HEAD and runs the native functional and local DSP gates on one package. GUI Git clients need the same Node and pnpm versions as the shell after `nvm use`.

Write repository documentation, comments, and visible text in English. Use exact API names and describe what the checks cover. Update the relevant README section and architecture invariants when behavior changes. Agree on licensing and signed-extension publication separately from source publication.

## Code Review Rules

- Put the overall assessment, checks run, and remaining work in the review summary or a general PR comment.
- Put actionable findings on the relevant lines in the diff. Explain what can go wrong, when it happens, and how to fix it.
- Answer existing feedback in its review thread. Link to the commit that addresses it when available.
- When asked to publish through the GitHub App, follow the [review bot guide](.github/REVIEW_BOT.md).
