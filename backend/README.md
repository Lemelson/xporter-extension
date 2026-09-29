# XPorter diagnostic schema 2

Canonical collector: `apps-script.gs`, container-bound to the existing UninstallsXPorter workbook. Run `configureBoundSpreadsheet()` once from its editor to store the workbook ID in the private Script Property `SPREADSHEET_ID`; an existing conflicting property is rejected. Web requests use `SpreadsheetApp.openById()` with that property and fail closed when configuration is missing. `getActiveSpreadsheet()` is available to the editor initializer, [not to web-app executions](https://developers.google.com/apps-script/guides/bound). The workbook ID is never committed or returned by the collector. Keep the existing web-app deployment URL; edit that deployment and select a new version.

## Sheets and compatibility

- `Sheet1`: existing uninstall/direct feedback. Existing rows and legacy column meanings remain; new columns are appended as needed. Blank `schema_version` means legacy 1. Never backfill missing historical fields with zero.
- `Usage`: legacy opt-in snapshots from the abandoned during-use experiment; no longer written (the collector rejects `source=usage`). Cumulative counters: **do not sum rows**.
- `TelemetryTests`: synthetic traffic; always exclude from analysis. `test:true` in a POST or `?test=1` in the feedback page routes here.
- `TelemetrySchema`: field dictionary and caveats created by `setupTelemetrySchema()`. Setup only adds documentation and never migrates Sheet1.

Legacy `dl` means a download was handed to the browser, not proof of a saved file. Legacy `exp_ok` means collection finished, not that all requested rows or photos were saved. Legacy `received` was previously updated on subsequent events. New rows keep immutable `received` and `first_received`; old timestamps cannot be reconstructed. Raw UA is no longer collected. New `browser_family`/`browser_major` are coarse browser details. Existing reason and subreason codes retain their meanings across wording changes.

## New measurements

`schema_version=2` identifies extension semantics and `collector_version=2` identifies the first collector. `form_version=3` identifies the optional window/download and requested-format clarifications; older website rows retain `form_version=2`. New question choices use the existing `subreasons`, canonical English labels and reason-history fields, without changing exported-format counters. `schema_since` is when new measurement began locally. All `diag_first_*_ms` milestones are first **observed since that time**, not reconstructed lifetime firsts. `diag_historical` flags known older export history. Null is unknown/unobserved; zero is a measured zero. Approximate install dates stay flagged by `inst_approx`.

`diag_attempts` retains up to five recent launch attempts, including early rejections. It records mode, format, settings at launch, resume/date-range flags, version, phase, terminal result/error/completion reason, row count, first-new-item latency, duration, and request/retry/429/timeout/network-error/pause measurements. Settings may change during a run; the stored settings describe launch. Worker restart marks an unfinished attempt interrupted with unknown duration. Requests outside an active export are excluded; counters describe instrumented API/limiter paths, not every browser request.

`diag_downloads` retains up to five save operations, separate from collection: generation time, bytes, rows, parts, browser complete/interrupted/error, and photo-preview counts. All parts must complete before an operation counts complete. Completed means Chrome reported completion, not that a user opened the file. `downloadUnknown` counts operations whose tracking was evicted/lost; it is not failure. Browser download IDs stay local. Clipboard success is separate. Photo counts concern preview embedding, not every media URL.

`diag_totals` contains cumulative counters since `schema_since`; `d_*` columns flatten them. `last_attempt_*` and `last_download_*` flatten the last retained record for spreadsheet analysis. `diag_revision` orders snapshots. The random `install_id` links reports from the same local installation; clearing extension storage resets it. This is pseudonymous, not anonymous.

## Current settings (additive schema-2 fields)

`s_colorful` is the legacy `simplifiedDesign` appearance flag; it does not measure use of the colorful theme catalog. Use `theme_preset` for the final selected preset and `ui_theme_changes` for observed committed changes. `s_ladybug` records Show ladybug. `s_window_width`, `s_window_height`, `s_element_size` and `s_text_size` are the saved slider percentages, not screen pixels or measured rendered text scale. `s_auto_expire` and `s_auto_expire_hours` retain both the toggle and saved duration, including when disabled.

`s_mode` and `s_format` describe the current saved selection, independently of the last attempt. `s_originals`, `s_quotes`, `s_bookmark_context`, `s_bookmark_articles`, `s_post_photos`, `s_bookmark_photos`, `s_about`, `s_about_speed`, `s_about_batch` and `s_about_retries` complement existing current export preferences. `f_txt` counts lifetime TXT-selected starts, matching the existing format counters. No change history or custom background colors are sent. Missing or invalid preferences remain unknown; old rows are not backfilled.

Deploy the updated collector allowlist first, then the website codec/privacy policy, then distribute the extension. The URL field order is append-only; an older website codec cannot decode the longer payload. The page already forwards codec fields, so its recording algorithm is unchanged. New columns are appended on receipt; no migration is required.

## Transport and abuse limits

The extension keeps bounded diagnostics locally and uploads nothing during use; only the uninstall feedback page posts to the collector. The collector accepts `source` `uninstall`/`direct`, event types `open`/`reason`/`reason_update`/`detail`, `schema_version` 1/2, drops unknown keys, caps strings (detail 4,000 = chip summary + 2,000-character textarea; subreason lists 4,000; stats 128; other text ≤ 200) and the body at 64 KB. `CacheService` applies best-effort budgets of 40 writes per session per 10 minutes and 300 new sessions per hour (`rate_limited` / `busy`), before the ScriptLock (`tryLock` 5 s) is requested. Counters are non-atomic and may be evicted; cache failures are logged and do not reject feedback. These budgets reduce casual flooding, not sustained concurrent abuse. Clients get generic codes (`invalid`, `too_large`, `busy`, `rate_limited`, `unavailable`); details go to the Apps Script execution log. Every string cell is formula-escaped on every write (including merged rewrites) and text cells get the plain-text `@` format; digit-only values and ISO timestamps keep default parsing.

Uninstall URL `d2` uses append-only positional fields, dictionary codes, DEFLATE and base64url, limited to 1023 characters. It is **not encryption**. When needed, oldest download/attempt records are removed with `transport_omitted_*` counts; `transport_summary_only` or `transport_error` signals degraded transport. Never infer that omitted attempts did not happen. Preserve codec ordering and mirror files exactly.

The form prefers normalized extension language, then browser language, then English. `language_source` records that choice or a manual switch. Reasons/subreasons use stable codes; English label columns are convenience text. Reloads reuse a session, initial open does not clear prior answers, event sequence prevents delayed feedback replacing newer choices, and dwell time is monotonic. Explicit Send displays success only after an unguessable server receipt confirms persistence. Unconfirmed receipt does not prove the POST failed. Client labels and IDs are untrusted and can be fabricated; public traffic is not authenticated proof of uninstall.

Collector merges preserve the complete newer URL snapshot when an incoming `snapshot_at` or `diag_revision` is older. This includes current preferences, lifetime counters, diagnostic JSON and expanded `d_*`/`last_attempt_*`/`last_download_*` cells. Feedback revisions and page dwell still update independently. A URL describes its refresh time, not necessarily the uninstall time; use `snapshot_at` to assess freshness.

UI observation version 1 appends `ui_diag_version`, `ui_diag_since`, `ui_start_clicks`, `ui_start_sent`, `ui_start_accepted`, `ui_start_invalid`, `ui_start_worker_error`, `ui_no_session_views`, `ui_status_read_errors`, `ui_theme_changes`, `ui_speed_changes`, `ui_settings_views` and `ui_about_views`. These are local cumulative event counts since the explicit `ui_diag_since` baseline, sent only through uninstall feedback. Repeated views/clicks count separately. Missing baseline or counters remain unknown in old reports; never fill them with zero or treat them as lifetime measurements. No account names, preference values, event histories or per-event timestamps are added. Publish the collector and Pages codec before distributing an extension with the longer payload.

## Deploy and verify

1. Run `node scripts/test-all.js` and `git diff --check`.
2. Open the workbook in Google Sheets → **Extensions → Apps Script** (this opens the bound script). Back up the current Code.gs and Sheet1 values.
3. Replace Code.gs with `apps-script.gs` and save. Run `configureBoundSpreadsheet` once from this bound editor (authorize if asked). It privately saves `SPREADSHEET_ID`; no ID needs to be pasted into the code. If it reports a mismatch, check the workbook and existing Script Property before changing either.
4. Run `setupTelemetrySchema` once. It uses the configured workbook and only appends schema documentation.
5. **Deploy → Manage deployments** → edit (pencil) the existing web-app deployment → Version: **New version** → Deploy. This keeps the `/exec` URL and its access settings (Execute as: Me; Who has access: Anyone).
6. Open the `/exec` URL: the response is only `{ok, service, collector_version, time}`.
7. Submit the live form with `?test=1`; confirm the row in `TelemetryTests`, the receipt, and that no legacy Sheet1 row changed.

Keep the workbook's sharing **Restricted** (only the developer). The web app runs as the owner, so it needs no public link. Do not put credentials or sensitive personal data in feedback.

Deterministic/fixture browser tests do not prove live X API compatibility or that installed store copies contain the update. Ship the extension package separately through the usual store release process.

Ladybug telemetry: `XP_LADYBUG_SQUASH` records one live-bug squash in the worker-serialized `ladybugSquashes` usage counter and immediately refreshes the uninstall URL. `ladybug_squashes` is appended to the compact codec and collector schema; missing historical values remain unknown. Counts start with this feature, not the original installation. After the splat fully fades, a replacement enters from a random viewport side at contact-card walking height; reduced motion uses a static replacement. Collector and Pages changes must be published to receive this field in production.

Uninstall field `theme_preset` records the selected catalog ID (for example `obsidian` or `glass-dark`); `theme` remains light/dark. The worker loads `popup/theme-presets.js` before `uninstall-feedback.js` to resolve legacy settings exactly like the UI. Codec fields are appended, and the collector validates catalog IDs. Older reports stay blank. Publish the matching Pages codec and Apps Script collector to receive this new column in production.
# September 10 compatibility fix

The published decoder accepts the 83 positional fields shipped in extension 2.0.0,
including `ladybug_squashes` and `theme_preset`. Replace the existing bound Apps
Script code with `apps-script.gs`, then edit the existing web-app deployment and
select a new version. Keep its URL unchanged. Existing rows are preserved; new
columns are added when received. The feedback compatibility test covers the
released 83-field payload, its 81-field predecessor, and legacy query parameters.

`f_pdf` counts PDF-selected starts, analogous to `f_txt`; printable HTML handoff and browser Save as PDF are separate actions. This counter does not prove a PDF was saved. Missing older values remain unknown.
