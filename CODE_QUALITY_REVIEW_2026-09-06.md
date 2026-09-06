# XPorter code-quality review — 2026-09-06

Reviewed the extension runtime rooted at `67735e1` (1.6.5 development), using the thermo-nuclear maintainability criteria. Implemented fixes on `codex/thermonuclear-quality-2026-09-06`. The original checkout was clean. The manifest version remains 1.6.5.

## Findings implemented

| Problem | Result |
| --- | --- |
| The 1,962-line popup mixed settings, account identity, modal lifecycle, rendering and commands. Its general autosave also scraped settings owned by other flows. | `popup.js` is now a 1,000-line coordinator. Five focused modules own the form, status rendering, account cards, guarded dialogs and shell interactions. Form saves cannot persist photo choices or navigation preferences. |
| Saved limits of 5,000/10,000 were treated as preset options that no longer exist in HTML. The empty select could subsequently save zero, meaning Unlimited. | The form reads actual option values and restores those limits through Custom. |
| An unrelated pending autosave could persist an About retry increase before confirmation, or enable photo embedding while its explanation was still open. | Unconfirmed retry values are restored until acceptance. Photo preferences have one owner: the permission flow. Both races were reproduced in Chromium before the fix. |
| Two dialog implementations duplicated timers, focus restoration, inert state and keyboard handling. | `guarded-dialog.js` owns that lifecycle, rejects disabled confirmation and cancels stale focus callbacks. The confirmed action runs synchronously in the click stack, preserving Chrome permission activation. |
| Concurrent history saves/deletes/expiry/clear could overwrite each other. A failed history read could replace real history with an empty fallback. | History has one recoverable mutation queue; read failures stop the transaction. |
| Usage mutations repeated read/write orchestration, and a failed read could reset existing counters. | One `mutateUsage` boundary owns persistence and queue recovery; individual mutators only edit a snapshot. Failed reads preserve previous counters. |
| Seen-post insertion, size measurement and eviction used separate IndexedDB transactions. Concurrent batches over-evicted rows; an exception could leave a partial batch committed. | Upsert and eviction share one write transaction. A common transaction owner handles completion, abort and connection cleanup. The original concurrent test produced 49,998 rows; the fixed version retains exactly 50,000. Failed batches now roll back their earlier inserts. |
| Live and restored export status duplicated the same field projection and resume rules. Installation duplicated settings defaults. | One status projection handles both sources. Defaults live in `loadSettings`; removing the installation snapshot write also avoids racing the first popup edit. |
| Locale loading had separate English/fallback caches and cached only completed loads. | One promise cache shares concurrent loads, including English fallback, and removes failed loads for retry. The concurrency test changed from four fetches to one. |

## Scope and retained boundaries

The review covered popup components and localization, worker lifecycle/status and export policy, settings/history/usage persistence, the passive database, downloads/serialization, API/parser/rate-limiter boundaries, cross-world capture registration, and test/package wiring.

The existing download transaction, bounded photo cache, parser/network split, independent endpoint limiters, immutable capture contract and generated isolated-world prerequisites already provide useful ownership boundaries. Their behavior is exercised by the existing deterministic suites. This change adds no dependency or build step and changes no API endpoint, permission declaration, export schema or locale copy.

The worker remains large (2,326 lines); the API client remains 1,248 lines. They remain architecture debt, especially the worker's search-tab lifecycle and the API's discovery/transport state. A mechanical split would distribute shared mutable state across files rather than reduce it. This review does not claim that every legacy module now meets the strict structural ideal; the implemented changes target boundaries with concrete simplifications and regression evidence.

## Verification

- Original baseline: all 12 deterministic suites passed, despite the uncovered races.
- Added storage tests reproduce lost history, destructive read fallbacks and queue recovery.
- Core suite now has 101 cases, including dialog lifecycle and locale request sharing/retry.
- `scripts/test-quality-regressions.mjs`: all five scenarios fail against the original checkout and pass against the changed extension in disposable Chromium profiles. These cover the three settings errors, concurrent database trimming, and transaction rollback.
- Unpacked extension smoke plus footer, tooltip, XLSX-photo choices, permission rationale, stopped/resume layout, and the new regression runner: all seven browser checks pass. Applicable layout/permission/status checks cover 14 locales; status checks also cover both themes, focus and reduced motion.
- Final `node scripts/test-all.js`: all 12 suites passed, including 101 core cases. `git diff --check` passed. Reproduction and browser commands are documented in `scripts/TESTING.md`.

Authenticated live-X compatibility and Store publication are separate from this local review. No release ZIP or published release is part of this change.
