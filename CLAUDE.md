# CLAUDE.md — quick orientation

**XPorter** — a Chrome **Manifest V3** extension (vanilla JS, **no build step, no dependencies**) that exports X/Twitter posts, personal bookmarks, followers, following, and verified followers to **CSV / JSON / XLSX / TXT**, using X's internal GraphQL API through the user's own logged-in session.

- **Version:** 1.6.5 packaged September 6, 2026 (`manifest.json`); the `v1.6.4` tag is the Chrome Web Store release.
- **Run it:** `chrome://extensions` → Developer mode → *Load unpacked* → this folder. No npm, no compile.
- **Deep docs:** read **[`agent.md`](agent.md)** for the full architecture/reference. `README.md` is the user-facing doc.

## Where things live (start here)

| You want to… | Go to |
|---|---|
| Export orchestration, messages, lifecycle | `background/service-worker.js` (~2,300-line coordinator); pure selection/pacing/resume decisions are in `background/export-policy.js` |
| X GraphQL calls + endpoint discovery | `utils/api.js` (`utils/api-features.js` = flags; `utils/api-parsers.js` = pure response normalization) |
| Live queryId + seen-post capture / page hooks | `utils/capture-contract.js` (immutable cross-world limits/operations) → `content/feed-parser.js` + `content/interceptor.js` (MAIN world) / generated `content/capture-prerequisites.js` → `content/content.js` (isolated world), all at `document_start` |
| Rate limiting (cooldowns, retries, abort) | `utils/rateLimit.js`; the worker owns primary, bookmark-context, and About-account limiters as one export lifecycle |
| Storage, settings + defaults | `utils/storage.js`; partial settings writes and usage-counter mutations each use recoverable promise queues |
| Passive seen-post database | `utils/post-database.js` (IndexedDB; one row per post ID, 50k-row cap) |
| Tunable constants + logger (`XLog`) | `utils/config.js` |
| Popup UI (Home/Settings/About tabs) | `popup/popup.html` · `popup/popup.js` · `popup/popup.css`; history and seen-post UI live in `popup/history.js` / `popup/seen-posts.js`; the editable target account and viewer-owned Bookmarks use shared name/avatar/handle cards sourced from the active X tab via `GET_ACCOUNT_CONTEXT`; post types, XLSX photo choices, and stopped/resumable states use official Tabler outline SVGs while retaining native inputs, Links is visibly recommended, the one-time photo-permission explanation persists as `xporter_photo_permission_intro_seen`, and the export-status card places compact Stop/Download/Copy actions below full-width status content |
| Popup UI helpers | `utils/shared.js` (incl. `sendMessage` w/ error sentinels, `formatError`, `isValidUsername`, `bidiIsolate`, `localizeQuantityOptions`, `createCooldownTicker`) |
| In-app UI strings (14 languages) | `popup/locales/*.json` (`en.json` = fallback) |
| Localized CSV/XLSX column headers | `utils/columns-i18n.js` (`XPorterColumns`; data keys + JSON stay English; gated by the `localizeExportHeaders` setting, default on) |
| Store name/description i18n | `_locales/*/messages.json` (≠ `popup/locales/`) |
| Ladybug Easter egg (About tab) | `popup/ladybug.js` |
| "Rate XPorter" prompt | `popup/rate-prompt.{js,css}` (self-contained; state in `chrome.storage.local` key `xporter_rate_prompt`; deep-links to the CWS reviews page) |
| Downloads + uninstall feedback | `background/downloads.js` atomically reserves one current download, freezes its state/plan/settings/permission/timestamp, splits parts incrementally, and fetches bounded `name=small` previews through a timeout plus LRU cache; `background/uninstall-feedback.js` builds the uninstall URL. Disclosures live in `docs/privacy-policy.html`. |
| Engagement signals (opens + active time) | `utils/usage-tracker.js` (loaded by `popup.html`) sends `XP_SESSION_OPEN` / `XP_ACTIVE_TICK` to the SW → `XPorterStorage.recordOpen` / `addActiveMs`. Surfaced in the uninstall URL as `os`, `installed_at`, `opens`, `active_s`; `feedback.html` adds `page_s` (dwell) and `apps-script.gs` computes `lived_min` (tenure). |
| Theme bootstrap (anti-FOUC) | `popup/theme-init.js` (must load first) |
| Public site | `docs/` only (`index.html`, `privacy-policy.html`, `feedback.html`, `assets/`); root site copies were removed |
| Tests and packaging | `node scripts/test-all.js` runs the 12 deterministic suites; the 99-test core is split under `scripts/test-extension-core/`; browser-only popup/smoke checks live beside them and fail closed inside `CODEX_SANDBOX`; `scripts/package.sh` runs the deterministic and explicit LibreOffice gates before atomically replacing an allowlist ZIP |

## Gotchas that bite

1. **Two i18n systems:** `popup/locales/` = in-app strings; `_locales/` = Chrome Store metadata. Don't confuse them.
2. **Adding a setting or string → update ALL 14 `popup/locales/*.json`** (add to `en.json` first). Settings also need a default in `utils/storage.js` + `onInstalled` in the SW.
3. **Cross-world capture contract:** `utils/capture-contract.js` and `utils/native-request-template.js` load in MAIN; their generated `content/capture-prerequisites.js` bundle loads first in the isolated world. Distinct resource paths avoid Chromium cross-world script deduplication. Run `node scripts/check-capture-bundle.js --write` after canonical prerequisite edits; the deterministic gate rejects stale bundles. Each world still validates at its own trust boundary.
4. **Single UI:** user-facing export controls live in `popup/`; keep popup status rendering in sync with the worker protocol.
5. **Help tooltips** (`!` icons) support `**bold**` markup for the "gist" — keep both `**…**` spans when editing/translating; aria-labels are auto-stripped (`renderHelpMarkup` / `stripHelpMarkup` in `utils/shared.js`).
6. **X API is fragile:** 400s usually = a changed GraphQL **feature flag** (`utils/api-features.js`); queryIds drift (auto-discovered + live-captured, with `FALLBACK_ENDPOINTS` to refresh). Use `encodeURIComponent`, never `URLSearchParams`.
7. **Service worker can be killed mid-export** — persist after every page. Stop, terminal cleanup, and a fresh run must abort/clear all three active limiter slots, not only the primary limiter.
8. **Queued storage mutations:** never bypass `XPorterStorage.saveSettings()` or the queued usage mutators with a new load→modify→save path; concurrent handlers would lose updates.
9. **Current downloads are transactions:** reserve the starting lock before the first async snapshot read; do not reload mutable state/settings or re-check photo permission between parts. Reuse the frozen transaction and its byte-bounded LRU photo cache; in-flight URLs share a promise, settled entries may be evicted, and preview fetch/body reads must retain their abort and byte bounds.
10. **Date-range posts** use a separate path: open an X **search tab** and scroll it; the user must keep it open. Local calendar bounds and a persisted launch-time cutoff filter padded search results. Versioned state prevents UTC-era date Resume from mixing semantics: old/unknown date states require a new export while saved rows stay downloadable. Coverage is display-only; only explicit bottom termination proves source completion under the conservative parser policy. Other cursorless endings are unconfirmed pending live fixtures. Retry limits live in `XPORTER_CONFIG.SEARCH_CAPTURE`. See `agent.md` §5.
11. **`tweetCount`/`tweetBuffer`** mean item count/buffer even for user exports (historical naming).
12. **CSS:** never hardcode colours — everything is CSS custom properties with `dark`/`light` (`.light` on `<body>`).
13. **Rate-limit budgets are endpoint-specific:** use `XPorterAPI.getRateLimit(operationName)` and never reuse one operation's headers for another. Header-less responses must take the mode-specific fallback path.
14. **Deterministic proof has a boundary:** `test-all.js` proves repository contracts, not current authenticated X behavior. Query IDs, feature flags, cookies, and live response shapes require separate authenticated live-X verification.
15. **Large downloads are multipart:** never call `loadAllTweets()` for the current export download path. `downloads.js` reads bounded batch ranges and uses `DOWNLOAD_PART_LIMITS`; XLSX/JSON/CSV/TXT parts must remain below their configured row ceilings. Embedded-photo XLSX parts use bounded previews and report `photos` plus `building_xlsx` stages.
16. **Post types are explicit and feed plans are resumable:** originals/quotes/articles use `UserOriginalsTimeline`; selecting reposts upgrades that pass to `UserTweets`; replies-only uses `UserRepliesTimeline`. Replies mixed with any other selected type use the one-pass `UserTweetsAndReplies` timeline and filter exact row types locally, matching the pre-1.6.1 request surface. Filter combined rows by the parser's non-exported stable author ID before display-field fallback, persist `postFeedPlan`/`postFeedIndex`, keep foreign parent rows only as nested context, and never reuse a cursor across feeds.
17. **Cursor de-duplication is bounded:** ordinary posts/user-list exports keep only `RECENT_EXPORT_ID_LIMIT` IDs in memory. Do not restore an unbounded per-run `Set`; date-range search is the separate path that needs full saved-ID de-duplication on resume.

## When you change things
Keep **`agent.md`** and this file in sync (new files, messages, storage keys, settings, export modes, and load order). Run `node scripts/test-all.js` plus `git diff --check`; outside `CODEX_SANDBOX`, run the unpacked smoke and the popup footer, tooltip, XLSX-photo-layout, and permission-rationale browser checks. Record authenticated live-X proof separately. The strict `node scripts/test-xlsx-libreoffice.js` compatibility gate is separate from deterministic tests and mandatory in the packager. See `scripts/TESTING.md` for focused runs, timezone CI and proof boundaries. Bump `version` in `manifest.json` only for releases. Build the CWS ZIP with `scripts/package.sh`.
