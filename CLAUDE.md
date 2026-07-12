# CLAUDE.md — quick orientation

**XPorter** — a Chrome **Manifest V3** extension (vanilla JS, **no build step, no dependencies**) that exports X/Twitter posts, followers, following, and verified followers to **CSV / JSON / XLSX**, using X's internal GraphQL API through the user's own logged-in session.

- **Version:** 1.4.8 (`manifest.json`)
- **Run it:** `chrome://extensions` → Developer mode → *Load unpacked* → this folder. No npm, no compile.
- **Deep docs:** read **[`agent.md`](agent.md)** for the full architecture/reference. `README.md` is the user-facing doc.

## Where things live (start here)

| You want to… | Go to |
|---|---|
| Export engine, message routing, state machine | `background/service-worker.js` |
| X GraphQL calls + endpoint discovery | `utils/api.js` (`utils/api-features.js` = flags; `utils/api-parsers.js` = pure response normalization) |
| Live queryId + seen-post capture / page hooks | `content/feed-parser.js` + `content/content.js` + `content/interceptor.js` (manifest-registered at `document_start`; parser/interceptor run in the page MAIN world) |
| Rate limiting (cooldowns, retries, abort) | `utils/rateLimit.js` |
| Storage, settings + defaults | `utils/storage.js` |
| Passive seen-post database | `utils/post-database.js` (IndexedDB; one row per post ID, 50k-row cap) |
| Tunable constants + logger (`XLog`) | `utils/config.js` |
| Popup UI (Home/Settings/About tabs) | `popup/popup.html` · `popup/popup.js` · `popup/popup.css`; history and seen-post UI live in `popup/history.js` / `popup/seen-posts.js` |
| Popup UI helpers | `utils/shared.js` (incl. `sendMessage` w/ error sentinels, `formatError`, `isValidUsername`, `bidiIsolate`, `localizeQuantityOptions`, `createCooldownTicker`) |
| In-app UI strings (14 languages) | `popup/locales/*.json` (`en.json` = fallback) |
| Localized CSV/XLSX column headers | `utils/columns-i18n.js` (`XPorterColumns`; data keys + JSON stay English; gated by the `localizeExportHeaders` setting, default on) |
| Store name/description i18n | `_locales/*/messages.json` (≠ `popup/locales/`) |
| Ladybug Easter egg (About tab) | `popup/ladybug.js` |
| "Rate XPorter" prompt | `popup/rate-prompt.{js,css}` (self-contained; state in `chrome.storage.local` key `xporter_rate_prompt`; deep-links to the CWS reviews page) |
| Downloads + uninstall feedback | `background/downloads.js` owns serialization/download handoff; `background/uninstall-feedback.js` builds `chrome.runtime.setUninstallURL`; counters remain in `XPorterStorage.recordExport*`. NO X data is sent — disclosed in `privacy-policy.html`. |
| Engagement signals (opens + active time) | `utils/usage-tracker.js` (loaded by `popup.html`) sends `XP_SESSION_OPEN` / `XP_ACTIVE_TICK` to the SW → `XPorterStorage.recordOpen` / `addActiveMs`. Surfaced in the uninstall URL as `os`, `installed_at`, `opens`, `active_s`; `feedback.html` adds `page_s` (dwell) and `apps-script.gs` computes `lived_min` (tenure). |
| Theme bootstrap (anti-FOUC) | `popup/theme-init.js` (must load first) |
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
10. **Rate-limit budgets are endpoint-specific:** use `XPorterAPI.getRateLimit(operationName)` and never reuse one operation's headers for another. Header-less responses must take the mode-specific fallback path.
11. **Static proof has a boundary:** repo tests can prove manifest/DOM/i18n/message contracts, parsers, persistence, pacing, and file generation. They cannot prove that X's current queryIds, feature flags, cookies, or live response shapes still work; that requires an authenticated browser smoke test.

## When you change things
Keep **`agent.md`** and this file in sync (new files, message types, storage keys, settings, export modes). Run `node scripts/test-static-contracts.js`, `node scripts/test-extension-core.js`, `node scripts/test-rate-limit.js`, and `node scripts/test-feed-capture.js`; use `scripts/test-extension-smoke.mjs` for a real unpacked-Chromium check. Bump `version` in `manifest.json` for releases. Build the CWS zip with `scripts/package.sh` (allowlist-based — never zip the folder naively; that would leak `.git/`, docs and dev scripts).
