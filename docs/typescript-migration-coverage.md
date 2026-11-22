# TypeScript migration test coverage

The engine keeps `window.__lazyReverb.get()/set()`, `MAIN` injection at `document_start`, and the existing DSP. The popup still reads and writes `storage.local.preferences` with `rate`, `mix`, and `bass`. Each document keeps its own enabled flag. Old preferences without `bass` default to 0 dB. The storage format needs no migration. To roll back, load the previous build and refresh music tabs after reloading the extension.

The rows follow the order of each original source file and describe the expected coverage after migration.

## Engine (`tests/engine.test.cjs`)

| Original check | Coverage after migration |
| --- | --- |
| Disabled state, pitch, and restoration | Unit tests verify the original `playbackRate` and `preservesPitch` after bypass. A native scenario checks output before and after. |
| Cross-origin stream without CORS | Unit tests check that rate control works without capturing or reloading the player. A native test checks the status and advancing playback. |
| Detached `Audio` and a single source | Unit tests discover the player through `play()` and reject duplicate sources. The native fixture tests detached playback. |
| Transition from CORS restriction to a site-owned graph | A unit test checks that the engine reassesses the player when the site creates its own source. |
| Site graph and port indices | Unit tests verify `connect` and `disconnect` semantics, a single rack, and intermediate connections. |
| SPA player replacement and rate reset | Unit tests cover `play` and `ratechange`. A native test checks the replacement element and its original settings. |
| Validation, ranges, and offline graphs | Unit tests check settings types and the exclusion of `OfflineAudioContext`. DRM and CORS have separate coverage. |
| No background work and rate-only mode | Unit tests check scans, observers, and node counts. |
| Rate control without a context, and CORS warnings | Unit and native tests check `graphCount` and the absence of an unnecessary context. |
| Low-shelf filter and impulse release | Unit tests cover the uncompensated gain path, filter bypass, and `buffer = null`. Native checks measure bass boost and the reverb tail. |
| Repeated toggles and slider edits | Unit tests check that node and source counts stay bounded and scans do not repeat. |
| Faster playback and 100% wet | Unit tests check ranges, zero dry gain, and restoration. Native cases use real sliders. |
| Paused player cleanup and later `play()` | Unit tests check settings restoration and verify that the engine disconnects and reconnects its source in bypass. |
| Detached active player and site ownership | Unit tests check that detached players and site-owned connections remain active. |
| Garbage collection | A unit test checks that unreachable players and contexts are collectable using `--expose-gc`. |

For routing assertions, follow the entire route to `destination`, including the dry and wet outputs and filter bypass. Removing the dry connection or impulse release should fail the corresponding test. The native check verifies both the topology and a nonzero signal on the main route.

## Popup (`tests/popup.test.cjs`)

| Original check | Coverage after migration |
| --- | --- |
| Protocols and look-alike domains | Unit tests verify that an unsupported tab triggers no `scripting` call. |
| Old preferences | A unit test loads the previous shape with 0 dB bass, keeping effects off. |
| Rapid input | Controlled promises hold `executeScript` and `storage.set` while new input arrives. The unit tests check the final UI, engine, and storage. |
| Presets enable effects and preserve bass | Unit and native tests verify independent bass and actual preset application. |
| Unavailable engine | A unit test checks the hint and disabled controls. A negative native check verifies missing bootstrap detection. |
| Injection failure | A unit test rejects an obsolete request after new input and checks that the failed update is skipped and the queue continues. |
| Storage failure | A unit test rejects a delayed write, checks the error message, and verifies that the next update persists. |
| Actual shortcut and reassignment | Unit and native tests cover `browser.commands` and show the result on unsupported tabs. |
| Unassigned shortcut and binding error | A unit test simulates both cases and verifies that audio controls remain independent. |

## Performance verdict (`tests/test_performance_gate.py`)

| Original check | Coverage after migration |
| --- | --- |
| Stable run with low overhead | Four raw samples give `pass`. |
| Overhead after bypass | Consistent CPU samples give `fail` for residual overhead. |
| Enabled DSP budget | Fixtures check the boundary and a result over +20 percentage points. |
| Residual memory budget | Fixtures check the boundary and a result over +64 MiB against `native_before`. |
| Memory retained in the final control | Post-use PSS growth remains visible when `native_after` is equally high. |
| Control phase drift | Drift beyond tolerance produces `inconclusive`. |
| High noise | Variation in the central samples produces `inconclusive`. |
| Single outlier | A stable median remains usable if it passes the noise rules. |
| Missing memory or phase | A partial report gives `inconclusive` with a reason. |

Include fixtures for `NaN`, `Infinity`, strings, duplicate phases, invalid counts or intervals, summaries inconsistent with the samples, and unverified audio output. Separate sampler tests parse `/proc`, track PIDs by start time, and detect process loss, unavailable PSS, and counter resets. Physical measurements of synthetic DSP remain a separate local check.

## Browser (`tests/player.spec.cjs`)

| Original scenario | Coverage after migration using the installed ZIP |
| --- | --- |
| Default playback | Automatic `MAIN` bootstrap, effects off, and the original player settings. |
| Lazy preset and bypass | The real popup changes rate and pitch, then restores the original signal. |
| Bass via keyboard | An arrow key on the slider updates the displayed dB and engine state. |
| Rapid slider edits and reopening | The last value applies through `scripting`, persists, and appears again when the popup opens. |
| Preferences in a new tab | Real `storage.local` returns the preferences while the toggle and effects start off. |
| Detached SoundCloud player | Early interception of the site's connection, one rack, and continued audio output. |
| Tab isolation | The real active tab is selected through `tabs.query` while the other page keeps its state. |
| SPA player replacement | The replacement gets the current document's settings. Bypass restores its original rate. |
| Reload | The new document starts in bypass. The real preferences appear when the popup opens. |
| Stream without CORS | The local cross-origin stream stays audible, advances at the chosen rate, and shows the restriction. |
| Rate only | Zero bass and reverb, working rate controls, and no audio graph. |
| Unsupported site | No bootstrap. The popup shows which sites it supports and keeps effects off. |
| 2× and 100% wet | Real sliders verify display formatting and rate and pitch restoration. |
| Faster preset | 1.25× at 0% reverb without an extra graph. |
| Shortcut reset | Real `browser.commands` verifies shortcut registration while the player keeps its settings. |

HTTP(S) interception supplies the local HTML and WAV. The functional audio check measures the main output before, during, and after processing, including reverb and bass boost. Opening the toolbar popup and using the physical shortcut are manual checks.
