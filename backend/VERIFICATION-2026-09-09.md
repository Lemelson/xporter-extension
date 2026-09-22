# Current settings telemetry — 2026-09-09

- Compared the live Apps Script editor with the saved pre-change collector: exact match, 21,919 characters. After editing, copied the editor contents back and verified exact equality with `backend/apps-script.gs`.
- Updated the existing deployment to version 4; deployment ID, endpoint, workbook and access settings preserved. Ran `setupTelemetrySchema`; execution completed.
- Website commit `532071d2fb5e1d619d9a33afc640774b914dae69` published successfully. Live diagnostics codec and privacy policy exactly matched local files.
- Actual browser submission to the live feedback page with `test=1` received a server receipt. Read back the matching row from `TelemetryTests`: all 21 added fields matched, including false toggles, retained expiry hours, percentages, TXT count, and current mode/format distinct from the latest attempt.
- Compared all 359 existing Sheet1 rows and their original field values before/after the test: unchanged; 359 rows remained.
- Local extension: 19 deterministic suites passed. Site worktree: 12 deterministic suites passed. Feedback browser checks passed in all 14 languages using the real collector with an in-memory workbook. A disposable unpacked extension verified the newly saved preferences in the decoded uninstall URL, along with browser-completed synthetic download and existing consent behavior. No production Usage uploads were made.

The extension source is updated in the main local working directory with unrelated user edits preserved. This task did not publish a Chrome Web Store extension release or replace existing release archives. Existing installed copies begin sending the added fields only after receiving the updated extension. Missing historical fields remain unknown.
