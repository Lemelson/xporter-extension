# Telemetry deployment verification — 2026-09-08

- Google account and workbook binding checked in browser by opening Apps Script from the target spreadsheet.
- Bound spreadsheet ID: `1P-X_y88WQQb5vU7BIL5uR_477G6BiLWMtWxf7P0clss`.
- Existing deployment ID retained: `AKfycby70Cfxrt-lHWoKHUrtOdaiz5eG4gDQYCuM9TpmaV6OvH8qh1dcn0YBY3-pnxFc7XiFJg`.
- Apps Script reports successful update to deployment **version 3, 2026-09-08**. Saved editor code was copied back and exactly matched the canonical collector (21,919 characters). Health returns `collector_version:2` and the exact workbook ID.
- A subsequent final read also observed one new non-synthetic uninstall feedback row through collector 2; Sheet1 grew to 356 records and 61 columns. All original 355 rows retained every original cell value (new columns are blank for old rows).
- `setupTelemetrySchema` completed. `TelemetrySchema` has 147 definitions. Compared all 355 existing Sheet1 rows and their 53 columns before/after deployment: unchanged.
- Synthetic open/reason/detail/delayed-reason requests were acknowledged in `TelemetryTests`. Readback confirmed Chinese locale, 17 partial rows, blank unknown latency, immutable first timestamp, and preservation of the newer selected reason. The detail receipt was verified against the real server.
- GitHub Pages deployment for `5b1d01fc7a15570ab10d850f6f5e958ac26a10d7` succeeded. Live feedback HTML, privacy HTML and three JS assets matched local SHA-256 hashes. Real live form submissions in Chinese (`zh_Cn`, with an English browser), Arabic and Russian each showed success only after a server receipt. All used the dedicated test sheet.
- Website fixture browser checks passed on all 14 supported languages, including selection changes, compressed data, receipt and reload. Responsive copy checks: 616 states, no clipped text.
- Unpacked Chrome check passed: sharing off by default, optional permission required, generic settings cannot bypass consent, local JSON report, rejected launch and a real browser-completed synthetic seen-post download. Diagnostics exclude the synthetic post text and identifiers. Settings inspected in English, Russian, Chinese and Arabic at 350 px.
- Extension candidate package passed 18 deterministic suites and the LibreOffice XLSX integration gate.

The extension is a local candidate retaining version 1.6.5; it has not been published to Chrome Web Store or installed into users' existing profiles. It includes the current local product worktree, including pre-existing interface changes. New per-install diagnostics begin only after an updated extension runs. Existing installed versions continue using the compatible legacy flow. No authenticated live X export was performed for this telemetry change. Opt-in upload logic was tested with intercepted transport; no synthetic usage record was put in the real Usage dataset.

Canonical semantics and limitations: [README.md](README.md). Synthetic test sheets must be excluded from product analysis. The public repository contains this verification summary, not private feedback snapshots.
