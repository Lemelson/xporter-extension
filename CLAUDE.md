# CLAUDE.md — quick orientation

**XPorter** — a Chrome **Manifest V3** extension (vanilla JS, **no build step or package install**) that exports X/Twitter posts, personal bookmarks, followers, following, and verified followers to **CSV / JSON / XLSX**, plus an AI-friendly post-row **TXT**, using X's internal GraphQL API through the user's own logged-in session.

- **Version:** 1.5.9 (`manifest.json`)
- **Run it:** `chrome://extensions` → Developer mode → *Load unpacked* → this folder. No npm, no compile.
- **Deep docs:** read **[`agent.md`](agent.md)** for the full architecture/reference. `README.md` is the user-facing doc.

## Where things live (start here)

| You want to… | Go to |
|---|---|
| Export engine, message routing, state machine | `background/service-worker.js` |
| X GraphQL calls + endpoint discovery | `utils/api.js` (`utils/api-features.js` = fallback flags; `utils/api-parsers.js` = pure response normalization and reply-parent context linking; `utils/transaction-id.js` = local Replies transaction header) |
| Native request-shape + seen-post capture / page hooks | `utils/native-request-template.js` + `content/feed-parser.js` + `content/content.js` + `content/interceptor.js` (manifest-registered at `document_start`; parser/interceptor run in the page MAIN world) |
| Rate limiting (cooldowns, retries, abort) | `utils/rateLimit.js` |
| Storage, settings + defaults | `utils/storage.js` |
| Passive seen-post database | `utils/post-database.js` (IndexedDB; one row per post ID, 50k-row cap) |
| Tunable constants + logger (`XLog`) | `utils/config.js` |
| Popup UI (Home/Settings/About tabs) | `popup/popup.html` · `popup/popup.js` · `popup/popup.css`; history and seen-post UI live in `popup/history.js` / `popup/seen-posts.js` |
| Guarded risk acknowledgements | `popup/acknowledgement-timer.js` |
| Popup UI helpers | `utils/shared.js` (incl. `sendMessage` w/ error sentinels, `formatError`, `isValidUsername`, `bidiIsolate`, `localizeQuantityOptions`, `createCooldownTicker`) |
| In-app UI strings (14 languages) | `popup/locales/*.json` (`en.json` = fallback) |
| Localized CSV/XLSX column headers | `utils/columns-i18n.js` (`XPorterColumns`; data keys + JSON stay English; gated by the `localizeExportHeaders` setting, default on) |
| Store name/description i18n | `_locales/*/messages.json` (≠ `popup/locales/`) |
| Ladybug Easter egg (About tab) | `popup/ladybug.js` |
| "Rate XPorter" prompt | `popup/rate-prompt.{js,css}` (self-contained; state in `chrome.storage.local` key `xporter_rate_prompt`; deep-links to the CWS reviews page) |
| Downloads + uninstall feedback | `background/downloads.js` owns serialization/download handoff, including incremental numbered parts for large exports; `background/uninstall-feedback.js` builds `chrome.runtime.setUninstallURL`; counters remain in `XPorterStorage.recordExport*`. NO X data is sent — disclosed in `privacy-policy.html`. |
| Engagement signals (opens + active time) | `utils/usage-tracker.js` (loaded by `popup.html`) sends `XP_SESSION_OPEN` / `XP_ACTIVE_TICK` to the SW → `XPorterStorage.recordOpen` / `addActiveMs`. Surfaced in the uninstall URL as `os`, `installed_at`, `opens`, `active_s`; `feedback.html` adds `page_s` (dwell) and `apps-script.gs` computes `lived_min` (tenure). |
| Theme bootstrap (anti-FOUC) | `popup/theme-init.js` (must load first) |
| Third-party source attribution | `THIRD_PARTY_NOTICES` (ships in the extension package) and `docs/vendor/*.LICENSE` |
| Dev/debug scripts (not shipped) | `scripts/`, `index.html`, `docs/` |

## Gotchas that bite

1. **Two i18n systems:** `popup/locales/` = in-app strings; `_locales/` = Chrome Store metadata. Don't confuse them.
2. **Adding a setting or string → update ALL 14 `popup/locales/*.json`** (add to `en.json` first). Settings also need a default in `utils/storage.js` + `onInstalled` in the SW.
3. **Single UI:** user-facing export controls live in `popup/`; keep popup status rendering in sync with the worker protocol.
4. **Help tooltips** (`!` icons) support `**bold**` markup for the "gist" — keep both `**…**` spans when editing/translating; aria-labels are auto-stripped (`renderHelpMarkup` / `stripHelpMarkup` in `utils/shared.js`).
5. **X API is fragile:** 400s usually = a changed GraphQL **feature flag** (`utils/api-features.js`); queryIds drift (auto-discovered + live-captured, with `FALLBACK_ENDPOINTS` to refresh). Use `encodeURIComponent`, never `URLSearchParams`.
6. **Service worker can be killed mid-export** — the buffer is flushed and state persisted after every page; `getExportStatus` repairs a persisted `running:true` with no live export into a resumable `stopped`. A failed batch write throws `STORAGE_FULL` (never silently drops rows); on `error` the UI still offers Download + Resume.
7. **Date-range posts** use a separate path: open an X **search tab** and scroll it; the user must keep it open. See `agent.md` §5.
8. **`tweetCount`/`tweetBuffer`** mean item count/buffer even for user exports (historical naming).
9. **CSS:** never hardcode colours — everything is CSS custom properties with `dark`/`light` (`.light` on `<body>`).
10. **Rate-limit budgets are endpoint-specific:** posts use `UserTweets` when replies are off and `UserTweetsAndReplies` when replies are on; personal bookmarks use `Bookmarks`. Use `XPorterAPI.getRateLimit(operationName)` and never reuse one operation's headers for another. Header-less responses must take the mode-specific fallback path.
11. **Static proof has a boundary:** repo tests can prove manifest/DOM/i18n/message contracts, parsers, persistence, pacing, and file generation. They cannot prove that X's current queryIds, feature flags, cookies, or live response shapes still work; that requires an authenticated browser smoke test.
12. **Large downloads are multipart:** never call `loadAllTweets()` for the current export download path. `downloads.js` reads bounded batch ranges and uses `DOWNLOAD_PART_LIMITS`; XLSX/JSON/CSV/TXT parts must remain below their configured row ceilings.
13. **Cursor de-duplication is bounded:** ordinary posts/user-list exports keep only `RECENT_EXPORT_ID_LIMIT` IDs in memory. Do not restore an unbounded per-run `Set`; date-range search is the separate path that needs full saved-ID de-duplication on resume.
14. **About build history is manual:** keep the current build plus the two latest public releases, their ISO dates, all 14 popup locales, `manifest.json`, and the footer date synchronized. Label an unpublished current build as a build, not as released.
15. **Native request capture is low-authority and atomic:** retain only a successful request's operation/queryId/boolean feature maps through `native-request-template.js`; never capture or persist headers, cookies, variables, URLs, usernames, user IDs, or cursors.
16. **A quantity limit is a ceiling, not a promise:** persist `completionReason`. Only `limit_reached` may offer “+N more”; `source_exhausted` clears the terminal cursor and explains that X returned fewer accessible rows. Measure page progress after filters/de-dup, and let three same-cursor/no-new-row pages end instead of spinning.
17. **Date-range Resume replays X Search from the top:** full saved-ID de-dup is required, but duplicate timestamps must still rebuild date coverage. Keep the localized `ovResuming` counter visible while that replay catches up.
18. **Replies context is nested, not counted:** `api-parsers.js` attaches a matching foreign parent as `reply_to_post` before the worker filters standalone foreign rows. Keep that nested parent (and its `quoted_post`) through JSON/TXT and the prefixed CSV/XLSX columns without incrementing `tweetCount`. CSV/XLSX include only columns populated somewhere in the generated file or part; JSON recursively omits empty values while preserving `0` and `false`.
19. **Bookmarks are viewer-owned post rows:** the mode disables username entry, opens `https://x.com/i/bookmarks`, calls `Bookmarks` without a user ID, and retains every saved author/type. It uses post formats and post pacing, but never profile filters or profile metadata.
20. **macOS Codex tooling must not launch GUI app binaries inside the sandbox:** run XLSX compatibility checks through `node scripts/soffice-headless.js …`, never bare `soffice`. `node scripts/test-extension-smoke.mjs` intentionally refuses to start when `CODEX_SANDBOX` is set; use an approved `require_escalated` execution or a normal Terminal session. This prevents LaunchServices `SIGABRT` crash dialogs for LibreOffice and Google Chrome for Testing.
21. **Embedded photos are explicit XLSX-only work:** media URLs stay in every format; only the per-mode opt-in may fetch `pbs.twimg.com` photos. Keep images in a separate mapped Media sheet, keep videos as links, skip failed/oversized images safely, and preserve the 250-row photo-enabled XLSX part ceiling.
22. **Risk acknowledgements are guarded and accessible:** Reuse `popup/acknowledgement-timer.js` for the full 5→4→3→2→1 delay on About-details warnings. Keep background content inert, trap/restore focus, and keep safe cancellation immediately available.
23. **“No dependencies” means no package installation:** the browser-ready adaptation in `utils/transaction-id.js` is attributed in `THIRD_PARTY_NOTICES`; do not remove the notice from `scripts/package.sh` or imply that all source was written in-repo.

## When you change things
Keep **`agent.md`** and this file in sync (new files, message types, storage keys, settings, export modes). After changing API, parsing, posts/replies, user lists, or export formatting, first run `node --test test-lab/tests/offline-lab.test.js` and `node test-lab/run.js --sample 5 --seed local-check`; use `--all --seed full` for larger algorithm changes. This is the default no-Computer-Use check and loads the current production files directly. Also run `node scripts/test-static-contracts.js`, `node scripts/test-extension-core.js`, `node scripts/test-rate-limit.js`, `node scripts/test-feed-capture.js`, and `node scripts/test-tooling-policy.js`; use `scripts/test-extension-smoke.mjs` only for the unpacked-browser/live-X boundary and never launch it inside `CODEX_SANDBOX`. For XLSX compatibility, use `node scripts/soffice-headless.js …`, not bare `soffice`. `manifest.json` is the build-version source of truth; synchronize it with the popup footer date and all localized “Last updates” entries. Build the CWS zip with `scripts/package.sh` (allowlist-based — never zip the folder naively; that would leak `.git/`, docs and dev scripts).
