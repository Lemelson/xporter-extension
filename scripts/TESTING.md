# Testing XPorter

Run `node scripts/test-all.js` and `git diff --check` before committing. The complete deterministic gate still runs all 11 suites; each core test has a deadline so an unresolved Promise cannot silently end the process with success.

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
