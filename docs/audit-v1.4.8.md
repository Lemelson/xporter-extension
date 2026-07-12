# XPorter 1.4.8 code audit

## Scope and boundary

The audit started from clean XPorter 1.4.7 source and covered every shipped JavaScript file, the Manifest V3 loading graph, message protocol, storage/persistence, API and parser paths, rate limiting, downloads, popup state, package allowlist, documentation, and automated tests.

Computer Use, Playwright, an authenticated X session, and live browser interaction were intentionally excluded. Those checks are listed in `docs/verification-v1.4.8.md`.

## Correctness fixes

1. **Resume pacing used stale configuration.** `RateLimitManager.restoreState()` restored the old delay, batch size, and cooldown after the worker had already built a limiter from the user's current speed settings. It now restores counters/timing only. Obsolete persisted configuration fields and the unused `reset()` method were removed.
2. **Failed settings writes poisoned the popup cache.** The popup updated `currentSettings` before `SAVE_SETTINGS` succeeded. `persistSettingsPatch()` now advances the cache only after `{success:true}`; direct theme, language, mode, format, and debounced setting writes use the same interface and revert visible controls when appropriate.
3. **Resume limit was not persisted before work.** A “+N more” override could disappear if Chrome terminated the worker before the first new page completed. Resume now saves its running state and limit before launching the loop.
4. **Stop did not cancel an active fetch.** The rate limiter could cancel waits but not a request already in flight. API requests now have tracked abort controllers; Stop aborts them immediately, while fetch and response-body reads retain one shared deadline.
5. **State write failures could advance an export.** `saveCurrentState()` now treats a failed storage write as `STORAGE_FULL`; start/resume do not acknowledge success unless their initial state is durable. Terminal error reporting uses best-effort persistence so the UI still receives a definitive state.
6. **Clear/delete actions returned false success.** Current-export clearing and history delete/clear now propagate storage failures. Popup history and New Export change only after the worker confirms success.
7. **Theme rollback was incomplete.** `initTheme('dark')` did not remove a previously applied `.light` class. Theme initialization now sets both directions deterministically.
8. **Malformed rows could leak into exports.** User/tweet parser rows without stable IDs are discarded, malformed REST follower rows are filtered, and authorless post payloads receive the canonical `x.com/i/web/status/<id>` URL instead of a broken double-slash URL.

## Architecture changes

The split follows deep Module seams rather than arbitrary file-size slicing:

| Before | After | Interface |
|---|---|---|
| `utils/api.js` mixed transport and payload traversal | `api.js` owns auth/network/queryId/cancellation; `api-parsers.js` owns pure response normalization | `XPorterApiParsers` |
| service worker built files and called Chrome downloads | `background/downloads.js` owns current/history/seen-post download behavior | `XPorterDownloads` |
| service worker built and throttled uninstall URLs | `background/uninstall-feedback.js` owns the anonymous snapshot | `XPorterFeedback` |
| popup controller rendered and mutated export history | `popup/history.js` owns history UI | `XPorterHistory` |
| popup controller owned the passive dataset UI | `popup/seen-posts.js` owns summary/download/clear UI | `XPorterSeenPosts` |

Core file sizes changed from 1.4.7 to 1.4.8:

- `background/service-worker.js`: 1,992 → 1,747 lines
- `utils/api.js`: 1,086 → 783 lines
- `popup/popup.js`: 1,132 → 939 lines

The date-range state machine remains in the service worker. Moving it now would require an interface containing most of the mutable export session, reducing locality rather than improving it.

## Automated proof

- `scripts/test-static-contracts.js`: manifest/import/popup assets, script ordering, DOM IDs, CSS consumers, both locale sets, message producers/consumers, syntax for all shipped runtime scripts.
- `scripts/test-extension-core.js`: parser, API cancellation, download module, anonymous uninstall module, persistence, Resume behavior, XLSX, theme rollback, and error-path regressions.
- `scripts/test-rate-limit.js`: pacing presets, retries, current-vs-saved Resume configuration, settings transaction semantics, storage/history, and usage telemetry.
- `scripts/test-feed-capture.js`: passive feed parsing, retweet/quote handling, deduplication, and IndexedDB merge behavior.
- `scripts/package.sh` + `unzip -t`: allowlist-only Chrome Web Store archive and ZIP integrity.

## Residual runtime risk

Static proof cannot establish that X's current queryIds, feature flags, cookies, REST/GraphQL response shapes, rate-limit headers, and search UI still match the implementation. It also cannot establish real Chrome popup layout, Save dialogs, toolbar badges, service-worker lifecycle timing, or spreadsheet-app rendering. Complete `docs/verification-v1.4.8.md` before treating 1.4.8 as live-runtime verified.
