# Testing XPorter

Run `node scripts/test-all.js` and `git diff --check` before committing. That runner lists the complete deterministic gate; each core test has a deadline so an unresolved Promise cannot silently end the process with success.

For focused work, use `node scripts/test-extension-core.js --suite=date-export` (also `worker-state`, `api`, `serialization-download`, `ui-content`) or run the relevant standalone suite. The core runner validates every test registration even during a focused run. An unknown suite is an error. A focused run does not replace the complete gate.

| Coverage | Evidence and boundary |
| --- | --- |
| Dates and Resume | `date-export.test.js` covers selection, retries, state schema, end reasons, real worker terminal handling and Stop. Fixed expected UTC instants in `fixtures/calendar-boundaries.json` check Moscow, UTC+14 and 23/25-hour New York days independently of the implementation's date calculation. |
| Storage lifecycle | `worker-state.test.js` drives a real failed export and then real Resume, checking the persisted cursor, saved rows and UI status. `worker-harness.js` supplies detached JSON storage values rather than shared object references. |
| Capture wiring | `test-capture-contract.js` connects the real MAIN-world interceptor, isolated relay and worker message handler in VMs. It checks readiness, fetch/XHR responses, network-error forwarding, same-URL recovery and bounded oversized diagnostics. This is not an installed-browser test. |
| XLSX contents | Core tests check the ZIP plus actual worksheet text cells and exact long IDs without depending on a locally installed spreadsheet application. |
| Localization | Static contracts check all 14 key sets and interpolation placeholders, including `{count}` in download labels. They do not assess translation quality or visual layout. |

Run `node scripts/test-xlsx-libreoffice.js` for real workbook compatibility. It opens a generated workbook in a separate LibreOffice profile and checks converted Unicode text and the full long ID. Missing LibreOffice, timeout, failed conversion or altered values fail this check. CI installs LibreOffice explicitly in its own job; the packager requires this gate as well as the deterministic gate. Packaging tests inject failures into each gate and verify that the previous ZIP stays unchanged.

CI runs deterministic tests under `Etc/UTC`, `Europe/Moscow`, `America/New_York` and `Pacific/Kiritimati`. Run the relevant timezone locally with `TZ=America/New_York node scripts/test-extension-core.js --suite=date-export` when investigating dates.

Keep real-X and browser verification separate. `fixtures/search-endings.synthetic.json` contains constructed cases, not captured responses. A green gate does not establish which final-page/alert shapes X currently emits, authenticated endpoint compatibility, popup layout, or completed Chrome download behavior. See `fixtures/README.md` for the outstanding live-search captures and the repository browser policy for unpacked checks.

The core includes guarded-dialog cancellation, focus restoration and synchronous confirmation. `test-storage-concurrency.js` exercises concurrent history saves/deletes/expiry/clear, failed reads and recoverable queues. `test-worker-lifecycle.js` exercises retries, Stop/Resume and worker message boundaries; `test-download-transaction.js` also runs the dedicated `test-xlsx-export.js` serializer suite.

For the September 22 fixes, run `node scripts/test-popup-review-fixes.mjs` in an approved disposable browser profile. It exercises mode rollback after failed clearing, history refresh, settings read/write failure and overlapping saves, close flushing, unavailable export status and recovery, Stop/Resume, dates and keyboard actions. `node scripts/test-popup-menu-layout.mjs` checks narrow/short language-menu bounds, large text, RTL navigation and long selected mode labels. Both accept `XPORTER_BROWSER_EXECUTABLE`; these synthetic scenarios do not establish authenticated X compatibility.

Run `node scripts/test-quality-regressions.mjs` outside the macOS sandbox (approved unsandboxed exec in Codex). It loads the unpacked extension into a disposable Chromium profile and checks old quantity presets, pending-save confirmation boundaries (including retry typing before blur, cancel, confirm and a subsequent decrease), concurrent IndexedDB trimming at 50,000 rows, and whole-batch rollback after an injected write failure. `XPORTER_TEST_EXTENSION_ROOT` can point this test at a separate baseline checkout for before/after proof; its synthetic data never enters a user's browser profile.

For export UI changes, run `node scripts/test-ui-refresh.mjs` through an approved browser execution outside `CODEX_SANDBOX`. It loads the actual unpacked extension into a temporary profile, seeds synthetic worker status, and serves the overlay page locally. This covers 14 languages, dark/light popup themes, 320/350px layouts, desktop/mobile overlays, keyboard disclosures, terminal actions, and reduced motion. Screenshots go to `XPORTER_UI_OUTPUT` (default `/private/tmp/xporter-ui-qa`). `XPORTER_UI_ROOT` can select a baseline extension for before/after comparison. It does not launch an export or validate X endpoint behavior.

Run `node scripts/test-popup-appearance.mjs` outside the sandbox for default accent/optional simplified appearance, both themes, 85/100/115/130% scale, all 14 languages, normal and 320px widths, preserved independent settings, and bottom-edge tooltip placement. `XPORTER_APPEARANCE_LANGUAGES=ar,en,ru` selects a language subset for independent runs; screenshots go to `XPORTER_APPEARANCE_OUTPUT` (default `/private/tmp/xporter-appearance-qa`). It uses a disposable profile, never the user's account.

Run `node scripts/test-popup-workspace.mjs` outside the sandbox for all 224 locale/theme/style/scale combinations. It checks separate scrolling and action geometry, unobscured selection of the final post type, sign-in/export affordances, top-layer help, all export modes, date and XLSX controls, Settings/About scrolling, and the language menu in a short window. `XPORTER_WORKSPACE_LANGUAGES=en,ru,ar` narrows the locales; `XPORTER_WORKSPACE_ROOT` selects a baseline checkout. The signed-in renderer fixture does not use a real account or start an export.

Run `node scripts/test-popup-constrained-height.cjs` outside the sandbox for 12 English/Arabic, element-scale and viewport-height cases. It applies native-action CSS to a fixed extension-page viewport, then uses real wheel input and hit testing to check Home, Settings and About at 400/480/600px. This models a host height cap; it does not prove Vivaldi or Windows behavior. Keep the separate actual-native-window test for preferred-size regressions. `XPORTER_WORKSPACE_ROOT` selects the baseline extension; `XPORTER_BROWSER_EXECUTABLE` selects Chromium; `XPORTER_HEIGHT_SCREENSHOT` optionally saves a failure screenshot.

`node scripts/test-status-motion.mjs` is a browser check using a disposable extension profile. It reproduces missing live account context with an already-resolved profile, checks circular avatars, full-width Stop, digit reels (including rapid updates and reduced motion), truthful limit-only progress, and 64 locale/theme/design/scale combinations at normal and 320px widths. Output goes to `XPORTER_MOTION_OUTPUT` or `/private/tmp/xporter-motion-qa`. No live export runs.

Localization checks: `scripts/test-i18n-runtime.js` verifies all 14 key sets and interpolation variables, translated connection/resume errors, complete account-count templates, and the contextual quantity label. The approximate 3,200-post hint applies to posts without dates; date-filtered and other export modes use `noCustomLimit`. Safety-break labels are independent fields, and retry countdowns use `retryInSeconds`. `scripts/test-popup-localized-copy.mjs` checks glyph clipping, option widths, help scrolling, and conditional states at classic 100% in both themes. `scripts/test-feedback-localized-copy.mjs` checks all feedback reasons and success/return states at 350/1280px in both themes with preview mode and all external requests blocked. Both browser checks share `scripts/lib/inspect-localized-copy.mjs`, use disposable profiles, and accept `PLAYWRIGHT_MODULE`, `XPORTER_BROWSER_EXECUTABLE`, and `XPORTER_LOCALES`. Native popup checks accept `XPORTER_NATIVE_LOCALES`, `XPORTER_NATIVE_SCALES=100`, and `XPORTER_NATIVE_CLASSIC_ONLY=1`.

`test-popup-tooltip-layout.mjs` also emulates missing Popover methods and unsupported selectors in a real extension page, checking native title help and tab navigation. The core UI suite covers the same regression and language changes. This emulation does not replace running an actual Chrome 111 binary.

`test-popup-zoom-compat.mjs` validates help bounds for 32 en/ru, theme, style and scale combinations using browser-protocol boxes, correcting historical coordinates with the known browser version as an independent test oracle. Run it with `XPORTER_BROWSER_EXECUTABLE` pointing to both a Chrome 127 binary and current Chromium. The runtime detects coordinate semantics geometrically and does not inspect browser versions. Core tests also exercise both coordinate models and the no-Popover fallback.

Native popup geometry uses focused help and CDP focus emulation so desktop focus/pointer changes cannot close the help under measurement. It waits for stable target geometry and retains the width, screen position, scroll width and reachable-footer assertions. `test-popup-tooltip-layout.mjs` separately checks pointer hover in a browser tab. Keep native browser jobs separate from other desktop browser launches, which can close an action window.

Date-export regression cases preserve available rows beside GraphQL errors but reject full completion after a subsequent clean terminal page; a clean replay recovers missing rows without duplicates. Unknown instructions cannot overwrite cursors or mask the captured cursor-only ending.

## Diagnostic schema 2

The deterministic gate includes reducer, compressed transport, collector migration and checks that the abandoned upload path stays disabled. Run `node scripts/test-telemetry-browser.mjs` for the 14-language website-to-collector fixture flow and `node scripts/test-telemetry-extension.mjs` for a disposable unpacked extension, disabled legacy sharing routes even with old saved consent, local diagnostics and real browser download completion. Both browser scripts require approved unsandboxed execution and send no production feedback. `test-feedback-localized-copy.mjs` covers 616 responsive/theme/form states. Live deployment evidence is recorded in `backend/VERIFICATION-2026-09-08.md`; it does not prove live X endpoint compatibility.

### Curated theme picker

`node scripts/test-theme-presets.cjs` is part of the deterministic gate. Run `node scripts/test-theme-picker.cjs` outside the sandbox for all 11 presets, persistence, error rollback, focus, miniature bounds and the 14-language/three-scale matrix. `test-popup-background.cjs` is a compatibility entry point for this replacement of custom color editing.

Run `node scripts/test-review-dismiss-delay.cjs` outside the sandbox for the real five-second review dismissal gate and photo/account/retry warning gates. It checks synthetic and native attempts to dismiss before expiry, keyboard focus, unlocking, and cancellation afterward in a disposable profile. No review is submitted and no photo permission is granted.

### Platform emoji

Apple platforms retain native emoji; other platforms use the local selected set:
Noto flags/posts/following, Emojitwo bookmarks, Twemoji followers/warnings,
Microsoft Fluent Color globe. Overrides are scoped to product copy, never user
text or exports. Sources, hashes and licenses are in `popup/emoji/`.
`node scripts/prepare-emoji-assets.cjs --download` refreshes sources and normalizes
PNGs (requires unsandboxed browser); omit --download to use verified local inputs.
`scripts/build-emoji-font.py` builds both WOFF2 copies offline with FontTools/Brotli.
Keep sbix originOffsetY at zero: negative origins clip artwork in Chromium.
GPOS centers the complete glyph within a 1.25em advance and lowers its baseline;
CSS size-adjust stays 100% so bitmap size is independent of text advance.
`test-emoji-assets.js` checks choices, coverage, hashes and platform policy;
`test-emoji-font.cjs` checks browser font selection, ligatures and geometry;
`test-emoji-bitmap.cjs` compares all 20 painted bitmaps to their source pixels.
`test-emoji-alignment.cjs` compares painted vertical centers to Apple at five text
sizes and checks horizontal centering within each glyph advance.
Browser checks need unsandboxed execution. Windows selection is simulated on Mac,
not verification on an actual Windows host. No Apple artwork is distributed.

`node scripts/capture-emoji-comparison.cjs` captures 12 paired screens under
`../outputs/emoji-selected/`, including all 20 glyphs and warning dialogs.


UI funnel checks live in the storage concurrency and worker lifecycle suites: legacy missing baselines, rejected reads, concurrent clicks, no-op/failed settings changes, sender allowlists and worker-certified acceptance. Cookie read failure/absent-cookie/present-cookie are separate outcomes in the i18n runtime suite. Telemetry fixture tests verify all new counts survive compressed transport/collector and remain absent from historical payloads. Browser tests use synthetic disposable installs and must not write production feedback.

`scripts/test-pdf-alt.js` covers Unicode, safe markup/links/CSP, ALT across all post formats, bounded multipart history/current exports and partial status. `scripts/test-pdf-browser.mjs` uses disposable Helium with generated content to check the explicit print button, no automatic printing, zero external requests and horizontal overflow, and writes an inspectable PDF. Browser printing does not prove an installed user's Save operation or live-X article completeness. Arabic PDF text extraction can use shaped glyphs/visual order despite readable rendering.
