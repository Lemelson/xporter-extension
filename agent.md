# XPorter — Agent Context File

> **Purpose**: This file gives any AI/LLM working on this codebase a complete, structured understanding of the project. Read this (and `CLAUDE.md` for the short version) before making changes. **Keep this file updated** when adding files, changing architecture, or modifying critical logic.
>
> Last verified against the codebase at **v1.1.0**.

---

## 1. Project Overview

**XPorter** is a Chrome Extension (Manifest V3) for exporting data from X (Twitter) — posts, followers, following, and verified followers — into CSV, JSON, or XLSX files. It uses X's **internal GraphQL API** through the user's authenticated browser session (no official paid API required).

| Property | Value |
|---|---|
| Type | Chrome Extension (Manifest V3) |
| Version | 1.1.0 (`manifest.json`) |
| Language | Vanilla JavaScript (ES2020+), HTML, CSS |
| Frameworks | None — zero dependencies, no build step, no bundler |
| Target Browser | Chrome / Chromium-based, 88+ (MV3) |

### Key Selling Points
- **Free & unlimited** — competitors charge $12–15/mo and cap at 150–200 posts
- **Multi-mode** — posts, followers, following, verified followers
- **Multi-format** — CSV, JSON, XLSX (XML SpreadsheetML)
- **Date-range filtering** for posts (via an X search tab — see §5)
- **14 languages** — auto-detected from the browser
- **Self-healing API** — discovers GraphQL queryIds from X's JS bundles AND captures them live from X's own network traffic

---

## 2. Architecture & Data Flow

```
┌─────────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ content/content.js      │     │ background/          │◀───▶│ popup/popup.js       │
│  + interceptor.js       │────▶│ service-worker.js    │     │ export/export.js     │
│ (runs on x.com)         │     │ (the engine)         │     │ (the two UIs)        │
│                         │     │                      │     │                      │
│ • detect username       │     │ • export state mach. │     │ • user input         │
│ • capture live queryIds │     │ • GraphQL API calls  │     │ • live progress      │
│   (MAIN-world fetch/XHR │     │ • rate limiting      │     │ • settings           │
│   interception)         │     │ • storage / batching │     │ • download trigger   │
│ • drive the date-range  │     │ • CSV/JSON/XLSX build │     │                      │
│   search-capture tab    │     │ • date-range capture │     │                      │
└─────────────────────────┘     └──────────────────────┘     └──────────────────────┘
                                          │
                                          ▼
                                 ┌───────────────────┐
                                 │ X GraphQL API     │
                                 │ x.com/i/api/...   │
                                 └───────────────────┘
```

### Communication Pattern
All inter-component communication uses `chrome.runtime.sendMessage` / `onMessage`:
- **popup/export → service-worker**: commands (`START_EXPORT`, `STOP_EXPORT`, `GET_STATUS`, `DOWNLOAD_EXPORT`, `SAVE_SETTINGS`, …)
- **service-worker → popup/export**: live status (`EXPORT_STATUS_UPDATE` broadcast)
- **content.js → service-worker**: username detection (`SET_USERNAME`) and captured queryIds
- **interceptor.js → content.js**: `window.postMessage({type:'__XPORTER_QUERYID__'})` (page MAIN world → content-script isolated world)

### Export Flow (High-Level)
1. User enters username + options in popup/export page
2. UI sends `START_EXPORT` to the service worker
3. SW resolves user ID via `UserByScreenName` GraphQL
4. Fetches data in batches via the appropriate endpoint, parsing each page
5. Items are buffered in memory and flushed to `chrome.storage.local` in batches of 50
6. `RateLimitManager` manages spacing, batch cooldowns, and retries
7. On completion the user clicks Download → SW assembles all batches and calls `chrome.downloads`
8. **Posts + date range** takes a different path — see §5.

---

## 3. File Structure & Responsibilities

```
xporter/
├── manifest.json                # MV3 manifest (name/desc via __MSG__ i18n)
├── agent.md                     # THIS FILE — detailed AI context
├── CLAUDE.md                    # Short orientation / file map (auto-read by Claude Code)
├── README.md                    # User-facing documentation
├── LICENSE                      # Custom license
├── index.html                  # GitHub Pages landing page (marketing, not part of the extension)
├── privacy-policy.html          # Hosted privacy policy
├── icon128.png                  # Loose copy of the store icon (also in icons/ and docs/)
│
├── background/
│   └── service-worker.js        # 🔑 CORE: export engine, message router, state machine,
│                                #         date-range search-capture orchestration
│
├── content/
│   ├── content.js               # Username detection from the X page URL; injects + relays
│   │                            #   interceptor messages; drives the search-capture tab
│   └── interceptor.js           # Injected into the page MAIN world; wraps fetch/XHR to
│                                #   capture live GraphQL queryIds + SearchTimeline payloads
│
├── popup/                       # Compact popup UI (~350px)
│   ├── popup.html               # Markup (Home / Settings / About tabs)
│   ├── popup.css                # 🔑 ALL popup styles (themes, animations, ladybug, logo)
│   ├── popup.js                 # Tabs, export controls, settings, status, history
│   ├── ladybug.js               # Easter-egg ladybug on the About tab (see §6.2)
│   ├── theme-init.js            # Inline-loaded FIRST: applies saved theme to avoid FOUC
│   ├── theme.js                 # Theme toggle logic + SVG icon helpers
│   ├── i18n.js                  # In-app i18n engine + LANGUAGES list + loadTranslations()
│   ├── utils.js                 # Thin popup-only wrapper (most helpers live in utils/shared.js)
│   └── locales/                 # 🔑 In-app UI strings — 14 JSON files (en is the fallback)
│       └── en.json, ru.json, es.json, de.json, fr.json, pt.json, it.json,
│           tr.json, id.json, hi.json, ja.json, ko.json, zh.json, ar.json
│
├── export/                      # Full-page export UI (alternative surface, mirrors popup)
│   ├── export.html
│   ├── export.css
│   └── export.js
│
├── utils/                       # Shared modules (some load in SW, some in pages)
│   ├── config.js                # 🔑 XPORTER_CONFIG constants + XLog logger
│   ├── api.js                   # 🔑 X GraphQL client + endpoint discovery + parsers
│   ├── api-features.js          # GraphQL feature-flag constant objects (split from api.js)
│   ├── rateLimit.js             # RateLimitManager (spacing, batch cooldown, retry, abort)
│   ├── csv.js                   # CSV / XLSX / JSON output generation
│   ├── storage.js               # chrome.storage.local wrapper (quota-aware) + settings
│   └── shared.js                # 🔑 Helpers shared by popup + export pages (see §4.6)
│
├── _locales/                    # Chrome STORE metadata i18n (manifest __MSG_extName__ etc.)
│   └── en/, ru/, … (messages.json per language)  ← NOT the same as popup/locales/
│
├── scripts/                     # Dev/debug only — NOT shipped in the extension
│   ├── discover_endpoints.js                  # find current queryIds from a console
│   ├── debug-date-range-playwright.mjs        # Playwright repro for date-range
│   └── debug-extension-date-range-playwright.mjs
│
├── docs/                        # GitHub Pages copy (icon, index, privacy)
├── icons/                       # icon16/48/128.png
└── .github/workflows/           # CI (e.g. Pages deploy)
```

> ⚠️ **Two separate i18n systems.** `popup/locales/*.json` are the **in-app UI strings** (loaded by `i18n.js`). `_locales/*/messages.json` are the **Chrome Web Store** name/description, referenced from `manifest.json` as `__MSG_extName__` / `__MSG_extDescription__`. Keep them straight.

---

## 4. Critical Files — Detailed Reference

### 4.1. `utils/config.js` — Central Configuration
All tunable parameters live here. **Never hardcode magic numbers elsewhere.**

| Constant | Default | Purpose |
|---|---|---|
| `DEBUG` | `false` | toggle verbose `[XPorter]` logging |
| `REQUEST_DELAY` | `3000` | ms between API requests (**fallback** when adaptive pacing off / no headers) |
| `COOLDOWN_DURATION` | `180000` | 3-min cooldown after each batch (**fallback only**) |
| `BATCH_SIZE` | `20` | requests per batch before cooldown (fallback) |
| `RATE_LIMIT_PAUSE` | `60000` | base 429 wait (exponential backoff) |
| `MAX_RETRIES` | `5` | retries per request |
| `ADAPTIVE_PACING` | `true` | pace from X's `x-rate-limit-*` headers instead of the fixed delay |
| `ADAPTIVE_MIN_DELAY` / `_PAD` / `_HEADER_TTL` | `5000` / `2000` / `300000` | pacing floor / margin / budget freshness |
| `FALLBACK_REQUEST_DELAYS` | mode-specific | conservative header-less delay ranges (posts 20–25 s, followers 60 s, following/verified 5–10 s) |
| `ENDPOINT_CACHE_TTL` | `1800000` | 30-min queryId cache |
| `TWEETS_PER_BATCH` | `50` | items per storage batch |
| `FALLBACK_BEARER_TOKEN` | `AAAA…` | static public bearer |

**`XLog`** — use `XLog.log/warn/error/info()` instead of `console.*` in SW code.

### 4.2. `utils/api.js` + `utils/api-features.js` — X GraphQL Integration
The most complex, most fragile area.

- **Endpoint discovery** (`discoverEndpoints`): fetch `x.com` HTML → find `client-web*.js` bundles → regex for `queryId:"…",operationName:"…"` → cache 30 min. Falls back to `FALLBACK_ENDPOINTS` (these go stale when X ships new bundles — update periodically).
- **Live queryId capture**: `content/interceptor.js` also captures real queryIds (and `SearchTimeline` bodies) from X's own traffic and forwards them to the SW, which is more reliable than scraping bundles.
- **Feature flags** (`api-features.js`): `USER_FEATURES`, `TWEETS_FEATURES` (large!), `FOLLOWERS_FEATURES`. Missing/renamed flags → `400 Bad Request`. To fix: copy the live `features` object from a real x.com GraphQL request in DevTools.
- **`withStaleRetry(key, fn)`**: catches `STALE_QUERY_ID`, forces re-discovery, retries once. Self-healing against X changes.
- **Auth**: reads cookies directly — `ct0` → `x-csrf-token`, `auth_token` → session. Requests go to `https://x.com/i/api/graphql/…` and use `encodeURIComponent` (NOT `URLSearchParams` — X rejects `+` for spaces).
- **Target ops**: `UserByScreenName`, `UserTweets`, `Followers`, `Following`, `BlueVerifiedFollowers`, `SearchTimeline` (date range).

### 4.3. `background/service-worker.js` — Export Engine
Central orchestrator + message router. Loads utils via `importScripts` (§11). Key state:

```javascript
currentExport = {
  running, username,
  exportMode: 'posts'|'followers'|'following'|'verified_followers',
  outputFormat: 'csv'|'json'|'xlsx',
  dateFrom, dateTo,        // posts only → triggers the search-capture path (§5)
  settings, tweetCount,    // "tweetCount"/"tweetBuffer" = item count/buffer (historical names)
  totalBatches, tweetBuffer, userId, cursor,
  status: 'resolving_user'|'fetching'|'scrolling'|'complete'|'stopped'|'error'
}
```

**Message types** (`onMessage` cases): `SET_USERNAME`, `GET_USERNAME`, `START_EXPORT`, `STOP_EXPORT`, `RESUME_EXPORT`, `GET_STATUS`, `DOWNLOAD_CSV`/`DOWNLOAD_EXPORT`/`DOWNLOAD_HISTORY_ENTRY`, `SAVE_SETTINGS`/`GET_SETTINGS`, `CLEAR_EXPORT`, `GET_EXPORT_HISTORY`/`DELETE_HISTORY_ENTRY`/`CLEAR_HISTORY`, `DISCOVERED_QUERYID`/`PAGE_GRAPHQL_RESPONSE` (from content/interceptor). Plus the `EXPORT_STATUS_UPDATE` broadcast SW→UI.

**Lifecycle**: Chrome can kill the SW mid-export. State is saved to storage after each batch. `onStartup` marks interrupted exports `stopped`; `onInstalled` seeds default settings.

### 4.4. `utils/rateLimit.js` — `RateLimitManager`
Request spacing, 429 exponential backoff, `STALE_QUERY_ID`/network linear backoff, instant `abort()` via `AbortController`. `executeWithRateLimit(fn)` wraps any async request; `getState()`/`restoreState()` for persistence.

**Adaptive pacing (default).** `api.js` stores validated rate-limit budgets separately for `UserTweets`, `Followers`, `Following`, and `BlueVerifiedFollowers`; a missing or malformed header clears that endpoint's reading. The SW supplies only the active mode's budget to `RateLimitManager`. `_computeAdaptiveDelay()` uses `ceil(msLeftInWindow / remaining) + PAD`, floored at `ADAPTIVE_MIN_DELAY`, without shortening a valid wait; when `remaining ≤ 0` or a 429 reports exhausted quota, it waits until the advertised reset. Missing/stale headers use conservative mode-specific fallback delays plus the existing batch cooldown. Long waits emit a `cooldown` status so the UI shows a countdown. Page sizes are followers REST `count=100`, following/verified `count=50`, tweets `count=20`; actual speed depends on the live endpoint budget and must be benchmarked against X.

### 4.5. `utils/storage.js` — Chrome Storage + Settings
`chrome.storage.local` (10 MB). Keys: `xporter_export_state`, `xporter_settings`, `xporter_detected_username`, `xporter_tweets_batch_N`. `loadSettings()` returns defaults merged with saved values; `saveSettings()` also merges partial updates so hidden/runtime settings are not dropped by either UI:

| Setting | Default | Notes |
|---|---|---|
| `includeRetweets` / `includeReplies` | `true` | posts filter |
| `quantityLimit` | `500` | 0 = unlimited |
| `requestDelay` / `batchSize` / `cooldownDuration` | from config | rate limiting (fallback path) |
| `adaptivePacing` | `true` | pace from X's `x-rate-limit-*` headers (see §4.4) |
| `theme` | `'dark'` | `'dark'`/`'light'` |
| `language` | auto-detected | locale code |
| `exportMode` / `outputFormat` | posts / csv | |
| `autoExpireEnabled` / `autoExpireHours` | `true` / `4` | auto-clear old exports |
| `ladybugEnabled` | `true` | show the Easter-egg ladybug (§6.2) |

### 4.6. `utils/shared.js` — Shared Page Helpers (popup + export)
Loaded by BOTH `popup.html` and `export.html` (so don't duplicate these in `popup/utils.js`, which is now a thin wrapper). Provides:
- `sendMessage(msg)` — promisified `chrome.runtime.sendMessage` with timeout
- `checkAuth()` — looks for the `auth_token` cookie
- `formatError(code, t)` — maps error codes → i18n key / English fallback
- `extractUsernameFromInput(input)` + `RESERVED_PATHS` — parse @handle / URL
- `applyI18nToDOM(translations)` — applies all `data-i18n*` attributes (§6.1)
- `escapeHtml`, `renderHelpMarkup`, `stripHelpMarkup` — tooltip markup (§6.1)
- RTL + number-formatting helpers

### 4.7. `content/content.js` + `content/interceptor.js`
- **content.js** (isolated world): username detection from the URL (filters reserved paths, handles SPA nav via `MutationObserver`/`popstate`), injects `interceptor.js` into the page, relays `__XPORTER_QUERYID__` messages to the SW, and drives the date-range search-capture tab.
- **interceptor.js** (page MAIN world, a `web_accessible_resource`): wraps `fetch`/`XHR` to read GraphQL queryIds + `SearchTimeline` response bodies, posting them back via `window.postMessage`.

---

## 5. Export Modes, Date Range & Data Schemas

### Standard exports (posts without dates, followers, following, verified)
Direct GraphQL paging from the service worker.

### Posts + Date Range (special path)
X has no clean date-filter on the timeline GraphQL, so XPorter:
1. Opens an **X search tab** at `https://x.com/search?q=…&f=live` (`openSearchCaptureTab` / `buildSearchTimelinePageUrl`).
2. `interceptor.js` captures the page's own `SearchTimeline` responses; `content.js` scrolls the tab to load more.
3. SW parses captured payloads (`parseSearchTimelineResponse`) and emits `scrolling` status to the in-page overlay (localized via `i18n.js` — that's why the SW imports it).
4. **The user must keep that tab open until the export finishes** — this is what the `dateRangeHelp` tooltip warns about.

### Schemas
- **Posts CSV**: `id, text, tweet_url, language, type, author_name, author_username, view_count, bookmark_count, favorite_count, retweet_count, reply_count, quote_count, created_at, source, hashtags, urls, media_type, media_urls` (types: `tweet`/`retweet`/`reply`/`quote`).
- **Users CSV**: `id, name, username, bio, location, url, followers_count, following_count, tweet_count, listed_count, verified, protected, created_at, profile_image_url, profile_url`.
- **Formats**: CSV (BOM-prefixed UTF-8), JSON (pretty), XLSX (XML SpreadsheetML, no library).

---

## 6. UI Layer Details

### 6.1. Internationalization & Help Tooltips
- `popup/i18n.js` loads `popup/locales/{code}.json`; **`en.json` is the fallback** for any missing key. Language auto-detected on first run; cached in memory.
- Strings are applied by `applyI18nToDOM()` (in `utils/shared.js`) via attributes: `data-i18n` (textContent), `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-tooltip`, `data-i18n-aria-label`.
- **Help tooltips** (the `!` icons, class `.date-help`): the tooltip text supports a tiny markup — `**bold**` marks the "gist" so a reader can scan the bold for the essence or read it all. `applyI18nToDOM` renders it into a real `.help-pop` child element via `renderHelpMarkup` (escapes HTML, then `**…**` → `<strong>`, `\n` → `<br>`). The matching `aria-label` uses `stripHelpMarkup` so screen readers don't read the asterisks. **When writing/translating a help string, keep the two `**…**` spans.**
- **Adding a setting/string** → add the key to **all 14** `popup/locales/*.json` (en first).

### 6.2. Easter Egg: the Ladybug (`popup/ladybug.js`)
A ladybug wanders the "Questions or found a bug?" contact card on the **About** tab.
- **Behaviour**: spawns at a random spot above the Telegram button, wanders with a steering algorithm (biased away from pure-horizontal so it doesn't sit on a word), turns in place for big turns, pauses occasionally. Legs are CSS-animated; their gait is driven from JS state (`--gait-dur` + `.gait-paused`): legs freeze when it stops, shuffle while turning, step faster/slower with speed.
- **Click to squash**: flattens (`scale(1.32,0.16)`), leaves a translucent `.lb-splat` that holds then fades (`SPLAT_VISIBLE`/`SPLAT_FADE`, currently 3.5s each). It does **not** respawn until you leave and re-enter the About tab.
- **Respawn**: a `MutationObserver` on `#tab-about`'s `active` class spawns/despawns it.
- **Toggle**: Settings → "Show ladybug" (`ladybugEnabled`). `popup.js` calls `window.XPorterLadybug.setEnabled(bool)`.
- **Theming**: dark bug in both themes; a very subtle `.lb-shadow` underneath (white-ish on dark, dark on light).

### 6.3. Lightning Logo (`.logo`, `.about-icon`)
Yellow filled bolt with a glow + occasional "lightbulb" flicker:
- `@keyframes zap-glow` (breathing glow) + `@keyframes zap-flicker` (opacity dips). Both bolts use the **same periods** and `ladybug.js`'s `syncBolts()` re-syncs their phase when the About tab opens (the About bolt's animation only starts when its tab first shows).
- Glow colour/size are theme-aware via CSS vars (`--zap-c1/c2`, `--zap-glow/-hi`, `--zap-extra`). Light theme keeps the bolt yellow but adds a soft violet separation shadow so it reads on the pale background.

### 6.4. Theme System
`dark` (default) / `light` via a `.light` class on `<body>`. All colours are CSS custom properties. `theme-init.js` (inline, loaded first) applies the saved theme before CSS to prevent FOUC — **don't remove it**.

---

## 7. Common Errors

| Code | Cause | Action |
|---|---|---|
| `NOT_LOGGED_IN` | no `auth_token`/`ct0` | login prompt |
| `USER_NOT_FOUND` / `USER_SUSPENDED` / `ACCOUNT_PRIVATE` / `USER_UNAVAILABLE` | bad/unavailable account | error message |
| `INVALID_DATE_RANGE` | from > to | error message |
| `RATE_LIMITED` | 429 | exponential backoff |
| `STALE_QUERY_ID` | 400/404 (queryId changed) | re-discover + retry |
| `AUTH_ERROR` | 401/403 | re-auth |
| `ENDPOINT_DISCOVERY_FAILED` | can't reach x.com | surface to user |
| `MAX_RETRIES_EXCEEDED` | gave up | error message |
| `ABORTED` | user stopped | save state for resume |

Error codes ↔ i18n keys are mapped in `formatError()` (`utils/shared.js`).

---

## 8. Known Pitfalls & Gotchas

1. **Feature flags are fragile** — 400s usually mean a new/renamed flag. Copy the live `features` object from DevTools into `api-features.js`.
2. **URL encoding** — use `encodeURIComponent`, never `URLSearchParams` (X rejects `+`).
3. **QueryIds change** — handled by discovery + live capture + `withStaleRetry`, but refresh `FALLBACK_ENDPOINTS` periodically.
4. **Response paths vary** — some endpoints use `timeline_v2.timeline`, others `timeline.timeline`. Check both.
5. **Service worker sleep** — Chrome kills the SW at will; persist after every batch.
6. **Dual UI surfaces** — `popup.js` and `export.js` share logic via `utils/shared.js`, but messaging/status changes must be reflected in **both**.
7. **`tweetCount`/`tweetBuffer`** mean item count/buffer even for user exports — historical naming.
8. **Two i18n systems** — `popup/locales/` (in-app) vs `_locales/` (store metadata). See §3.
9. **Help-tooltip markup** — keep the `**bold**` spans when editing/translating; aria-labels are auto-stripped.
10. **FOUC** — `theme-init.js` must stay first in `popup.html`.
11. **CSS variables** — never hardcode colours.
12. **`scripts/` and `index.html`/`docs/` are not part of the runtime extension** — dev/marketing only.

---

## 9. Development Guidelines

### Add an export mode
1. Add endpoint to `FALLBACK_ENDPOINTS` + `discoverEndpoints()` in `api.js` (and `interceptor.js` `TRACKED` if capturing live).
2. Add fetch fn (follow `fetchFollowers`) + parser (`parseFollowersResponse`).
3. Export via `globalThis.XPorterAPI`; dispatch in the SW fetch loop.
4. Add UI option in `popup.html` **and** `export.html`; add CSV headers; add i18n keys to all 14 locales.

### Add a setting
1. Default in `loadSettings()` (`storage.js`) and `onInstalled` (SW).
2. UI in the Settings tab of `popup.html` (and export if relevant).
3. Wire save handler in `popup.js` (read → `SAVE_SETTINGS`), apply on load.
4. Add the i18n key to all 14 locales (en first).

### Update feature flags / queryIds
DevTools → Network → `graphql` → copy `features` / queryId → update `api-features.js` / `FALLBACK_ENDPOINTS`. Or run `scripts/discover_endpoints.js` in an x.com console.

### Bump the version
Update `version` in `manifest.json` (the footer reads it via `chrome.runtime.getManifest().version`). The footer date in `popup.html` (`.footer-build-date`) is manual.

### Testing
Run `node scripts/test-rate-limit.js` for deterministic pacing/retry checks. Also verify both themes; stop/resume (SW resilience); large exports (>1000 → storage batching); CSV in Excel (BOM/escaping); 429 + network-loss recovery; every language; date-range (keep the search tab open).

---

## 10. Permissions

| Permission | Purpose |
|---|---|
| `cookies` | read `ct0`/`auth_token` for auth |
| `activeTab` / `tabs` | username detection, search-capture tab |
| `downloads` | save files |
| `storage` | export state, settings, batches |
| `host_permissions` | `https://x.com/*`, `https://api.x.com/*`, `https://twitter.com/*` |

`interceptor.js` is injected via a page `<script>` from `content.js` (a `web_accessible_resource`), so no `scripting` permission is needed. (Confirm against the live `manifest.json` — permissions evolve.)

---

## 11. Script Loading Order

**Service worker** (`importScripts`, order matters):
`config.js` → `api-features.js` → `api.js` → `rateLimit.js` → `csv.js` → `storage.js` → `popup/i18n.js` (for the localized capture overlay).

**Popup** (`popup.html`, end of body):
`theme-init.js` (in `<head>`/top, first) → `utils/config.js` → `utils/shared.js` → `i18n.js` → `utils.js` → `theme.js` → `popup.js` → `ladybug.js`.

**Export page** (`export.html`):
`utils/config.js` → `utils/shared.js` → `popup/i18n.js` → `export.js`.

---

## 12. Global Objects (Service Worker Scope)

| Global | Source | Notes |
|---|---|---|
| `XPORTER_CONFIG`, `XLog` | `config.js` | constants + logger |
| `XPorterAPI` | `api.js` | `.getUserByScreenName`, `.fetchUserTweets`, `.fetchFollowers/Following/VerifiedFollowers`, `.discoverEndpoints`, search-capture parsers |
| `RateLimitManager` | `rateLimit.js` | class |
| `XPorterCSV` | `csv.js` | `.generateCSV`, `.generateFilename` (+ JSON/XLSX) |
| `XPorterStorage` | `storage.js` | export state, batches, settings, username |

In pages, `utils/shared.js` exposes its helpers as plain globals; `ladybug.js` exposes `window.XPorterLadybug`.

---

## 13. Future / Backlog
- Export likes & bookmarks; media download; built-in analytics; threads as units; Firefox build.
- Refactor: the dual UI still shares a lot — keep consolidating into `utils/shared.js`. Rename `tweetCount`/`tweetBuffer` → `itemCount`/`itemBuffer`. Add unit tests (CSV escaping, URL parsing, error mapping). Clean up orphaned batch keys after crashes.

---

## 14. How to Update This File
Update `agent.md` (and `CLAUDE.md`) whenever you add/rename a file, change the message protocol or storage schema, add export modes/formats/settings, update feature flags or queryIds, or change the data flow. Keep sections numbered; update §2's diagram for architectural changes.
