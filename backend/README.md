# XPorter diagnostic schema 2

Canonical collector: `apps-script.gs`. Bound workbook: `1P-X_y88WQQb5vU7BIL5uR_477G6BiLWMtWxf7P0clss` (the existing UninstallsXPorter book). The script refuses to write when its bound ID differs. Keep the existing web-app deployment URL; edit that deployment and select a new version.

## Sheets and compatibility

- `Sheet1`: existing uninstall/direct feedback. Existing rows and legacy column meanings remain; new columns are appended as needed. Blank `schema_version` means legacy 1. Never backfill missing historical fields with zero.
- `Usage`: voluntary snapshots during use, one installation/UTC-day. Cumulative counters: **do not sum rows**. Use differences between ordered snapshots for activity over an interval. This is a consenting sample, not the total installed population or a churn denominator.
- `TelemetryTests`: synthetic traffic; always exclude from analysis. `test:true` in a POST or `?test=1` in the feedback page routes here.
- `TelemetrySchema`: field dictionary and caveats created by `setupTelemetrySchema()`. Setup only adds documentation and never migrates Sheet1.

Legacy `dl` means a download was handed to the browser, not proof of a saved file. Legacy `exp_ok` means collection finished, not that all requested rows or photos were saved. Legacy `received` was previously updated on subsequent events. New rows keep immutable `received` and `first_received`; old timestamps cannot be reconstructed. Raw UA is no longer collected. New `browser_family`/`browser_major` are coarse browser details. Existing reason and subreason codes retain their meanings across wording changes.

## New measurements

`schema_version=2` identifies extension semantics, `collector_version=2` identifies the first collector, and `form_version=2` identifies the website. `schema_since` is when new measurement began locally. All `diag_first_*_ms` milestones are first **observed since that time**, not reconstructed lifetime firsts. `diag_historical` flags known older export history. Null is unknown/unobserved; zero is a measured zero. Approximate install dates stay flagged by `inst_approx`.

`diag_attempts` retains up to five recent launch attempts, including early rejections. It records mode, format, settings at launch, resume/date-range flags, version, phase, terminal result/error/completion reason, row count, first-new-item latency, duration, and request/retry/429/timeout/network-error/pause measurements. Settings may change during a run; the stored settings describe launch. Worker restart marks an unfinished attempt interrupted with unknown duration. Requests outside an active export are excluded; counters describe instrumented API/limiter paths, not every browser request.

`diag_downloads` retains up to five save operations, separate from collection: generation time, bytes, rows, parts, browser complete/interrupted/error, and photo-preview counts. All parts must complete before an operation counts complete. Completed means Chrome reported completion, not that a user opened the file. `downloadUnknown` counts operations whose tracking was evicted/lost; it is not failure. Browser download IDs stay local. Clipboard success is separate. Photo counts concern preview embedding, not every media URL.

`diag_totals` contains cumulative counters since `schema_since`; `d_*` columns flatten them. `last_attempt_*` and `last_download_*` flatten the last retained record for spreadsheet analysis. `diag_revision` orders snapshots. The random `install_id` links reports from the same local installation; clearing extension storage resets it. This is pseudonymous, not anonymous.

## Current settings (additive schema-2 fields)

`s_colorful` is the current Colorful appearance choice (the legacy storage key `simplifiedDesign=true` now means colorful). `s_ladybug` records Show ladybug. `s_window_width`, `s_window_height`, `s_element_size` and `s_text_size` are the saved slider percentages, not screen pixels or measured rendered text scale. `s_auto_expire` and `s_auto_expire_hours` retain both the toggle and saved duration, including when disabled.

`s_mode` and `s_format` describe the current saved selection, independently of the last attempt. `s_originals`, `s_quotes`, `s_bookmark_context`, `s_bookmark_articles`, `s_post_photos`, `s_bookmark_photos`, `s_about`, `s_about_speed`, `s_about_batch` and `s_about_retries` complement existing current export preferences. `f_txt` counts lifetime TXT-selected starts, matching the existing format counters. No change history or custom background colors are sent. Missing or invalid preferences remain unknown; old rows are not backfilled.

Deploy the updated collector allowlist first, then the website codec/privacy policy, then distribute the extension. The URL field order is append-only; an older website codec cannot decode the longer payload. The page already forwards codec fields, so its recording algorithm is unchanged. New columns are appended on receipt; no migration is required.

## Transport and consent

The extension collects bounded local diagnostics without uploading them during ordinary use by default. The dedicated Settings control plus optional Google host permission enables usage snapshots. `diagnosticsConsentVersion=1` is required. Disabling sharing aborts pending uploads. Failed attempts are throttled; a sleeping worker may defer an upload until the next activity. Local report download never enables sharing.

Uninstall URL `d2` uses append-only positional fields, dictionary codes, DEFLATE and base64url, limited to 1023 characters. It is **not encryption**. When needed, oldest download/attempt records are removed with `transport_omitted_*` counts; `transport_summary_only` or `transport_error` signals degraded transport. Never infer that omitted attempts did not happen. Preserve codec ordering and mirror files exactly.

The form prefers normalized extension language, then browser language, then English. `language_source` records that choice or a manual switch. Reasons/subreasons use stable codes; English label columns are convenience text. Reloads reuse a session, initial open does not clear prior answers, event sequence prevents delayed feedback replacing newer choices, and dwell time is monotonic. Explicit Send displays success only after an unguessable server receipt confirms persistence. Unconfirmed receipt does not prove the POST failed. Client labels and IDs are untrusted and can be fabricated; public traffic is not authenticated proof of uninstall.

## Deploy and verify

1. Run `node scripts/test-all.js` and `git diff --check`.
2. Back up the current source and Sheet1 values. Open Apps Script **from the target spreadsheet**, confirm account and existing deployment ID.
3. Replace Code.gs with this canonical source, save, and run `setupTelemetrySchema`.
4. Manage deployments → edit the existing deployment → new version → Deploy. Preserve the URL and existing access settings.
5. Check GET health: `collector_version:2` and exact spreadsheet ID.
6. Send synthetic open/reason/detail records with `test:true`; verify `TelemetryTests`, receipt, stable timestamp and no legacy-row changes. Do not put synthetic traffic into Sheet1/Usage.
7. Publish the owned `docs/` changes to the canonical GitHub Pages repository; verify live asset hashes and a synthetic real browser form submission.

The current workbook is viewable by anyone with its link; the privacy policy reflects this. Do not put credentials or sensitive personal data in feedback. Schema changes do not alter workbook sharing.

Deterministic/fixture browser tests do not prove live X API compatibility or that installed store copies contain the update. Ship the extension package separately through the usual store release process.
