# XPorter — Agent Context File

> **Purpose**: This file gives any AI/LLM working on this codebase a complete, structured understanding of the project. Read this (and `CLAUDE.md` for the short version) before making changes. **Keep this file updated** when adding files, changing architecture, or modifying critical logic.
>
> Last verified against the codebase at **v1.4.7** (2026-07-11).

---

## 1. Project Overview

**XPorter** is a Chrome Extension (Manifest V3) for exporting data from X (Twitter) — posts, followers, following, and verified followers — into CSV, JSON, or XLSX files. It uses X's **internal GraphQL API** through the user's authenticated browser session (no official paid API required).

| Property | Value |
|---|---|
| Type | Chrome Extension (Manifest V3) |
| Version | 1.4.7 (`manifest.json`) |
| Language | Vanilla JavaScript (ES2020+), HTML, CSS |
| Frameworks | None — zero dependencies, no build step, no bundler |
| Target Browser | Chrome / Chromium-based, 111+ |

### Key Selling Points
- **Free & unlimited** — competitors charge $12–15/mo and cap at 150–200 posts
- **Multi-mode** — posts, followers, following, verified followers
- **Multi-format** — CSV, JSON, real OOXML XLSX
- **Date-range filtering** for posts (via an X search tab — see §5)
- **14 languages** — auto-detected from the browser
- **Self-healing API** — discovers GraphQL queryIds from X's JS bundles AND captures them live from X's own network traffic

---

## 2. Architecture & Data Flow

```
┌─────────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ content/content.js      │     │ background/          │◀───▶│ popup/popup.js       │
│  + interceptor.js       │────▶│ service-worker.js    │     │ (the extension UI)   │
│ (runs on x.com)         │     │ (the engine)         │     │                      │
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
- **content.js → service-worker**: username detection (`SET_USERNAME`), captured queryIds, and compact seen-post batches
- **interceptor.js → content.js**: validated `window.postMessage` events for queryIds, date-range payloads, and passively seen posts (page MAIN world → content-script isolated world)

### Export Flow (High-Level)
1. User enters username + options in the popup
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
│   ├── feed-parser.js           # MAIN-world parser for compact non-reply rows from
│   │                            #   GraphQL responses already loaded by X
│   ├── content.js               # Username detection from the X page URL; validates + relays
│   │                            #   interceptor messages; drives the search-capture tab.
│   │                            #   Manifest-registered at document_start (isolated world).
│   └── interceptor.js           # Manifest-registered at document_start in the page MAIN
│                                #   world (Chrome 111+); wraps fetch/XHR to capture live
│                                #   GraphQL queryIds + timeline payloads
│
├── popup/                       # Compact popup UI (~350px)
│   ├── popup.html               # Markup (Home / Settings / About tabs)
│   ├── popup.css                # 🔑 ALL popup styles (themes, animations, ladybug, logo)
│   ├── popup.js                 # Tabs, export controls, settings, status, history
│   ├── ladybug.js               # Easter-egg ladybug on the About tab (see §6.2)
│   ├── theme-init.js            # Inline-loaded FIRST: applies saved theme to avoid FOUC
│   ├── theme.js                 # Theme toggle logic + SVG icon helpers
│   ├── i18n.js                  # In-app i18n engine + LANGUAGES list + loadTranslations()
│   └── locales/                 # 🔑 In-app UI strings — 14 JSON files (en is the fallback)
│       └── en.json, ru.json, es.json, de.json, fr.json, pt.json, it.json,
│           tr.json, id.json, hi.json, ja.json, ko.json, zh.json, ar.json
│
├── utils/                       # Shared modules (some load in SW, some in pages)
│   ├── config.js                # 🔑 XPORTER_CONFIG constants + XLog logger
│   ├── api.js                   # 🔑 X GraphQL client + endpoint discovery + parsers
│   ├── api-features.js          # GraphQL feature-flag constant objects (split from api.js)
│   ├── rateLimit.js             # RateLimitManager (spacing, batch cooldown, retry, abort)
│   ├── csv.js                   # CSV / XLSX output generation (JSON is built in the SW)
│   ├── storage.js               # chrome.storage.local wrapper (quota-aware) + settings
│   ├── post-database.js         # IndexedDB seen-post store (dedupe by ID; 50k cap)
│   └── shared.js                # 🔑 Shared popup/UI helpers (see §4.6)
│
├── _locales/                    # Chrome STORE metadata i18n (manifest __MSG_extName__ etc.)
│   └── en/, ru/, … (messages.json per language)  ← NOT the same as popup/locales/
│
├── scripts/                     # Dev/debug only — NOT shipped in the extension
│   ├── package.sh                             # allowlist-based CWS zip builder (use this!)
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
| `FALLBACK_REQUEST_DELAYS` | mode-specific | header-less delay ranges (posts 4–5 s at Standard, followers 60 s, following/verified 5–10 s; speed preset scales the range) |
| `SPEED_PRESETS` / `CUSTOM_SPEED_LIMITS` | turbo…turtle / clamp ranges | Export Speed presets: adaptive floor/pad, `budgetFraction`, `raceReserve`, fallback scale + batch rhythm; clamp ranges for the Custom tier (§4.4) |
| `ENDPOINT_CACHE_TTL` | `86400000` | 24-h queryId cache (stale ids self-heal via `withStaleRetry`; a failed pass caches fallbacks for only 10 min) |
| `API_FETCH_TIMEOUT` | `30000` | deadline per GraphQL/REST fetch (`fetchTimed`) |
| `DISCOVERY_FETCH_TIMEOUT` / `DISCOVERY_TOTAL_TIMEOUT` | `15000` / `25000` | per-fetch / whole-pass discovery deadlines (single-flight; timed-out pass keeps scanning in background to refresh the cache) |
| `TWEETS_PER_BATCH` | `50` | items per storage batch |
| `FALLBACK_BEARER_TOKEN` | `AAAA…` | static public bearer |

**`XLog`** — use `XLog.log/warn/error/info()` instead of `console.*` in SW code.

### 4.2. `utils/api.js` + `utils/api-features.js` — X GraphQL Integration
The most complex, most fragile area.

- **Endpoint discovery** (`discoverEndpoints`): fetch `x.com` HTML → find `client-web*.js` bundles → regex for `queryId:"…",operationName:"…"` → cache 24 h (persisted; failed passes cache `FALLBACK_ENDPOINTS` for 10 min only). One scan at a time (single-flight), whole pass capped at `DISCOVERY_TOTAL_TIMEOUT`. `FALLBACK_ENDPOINTS` go stale when X ships new bundles — update periodically. On 401/403 a discovered bearer is reverted to the built-in public token (`noteAuthFailure`).
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

**Message types** (`onMessage` cases): `SET_USERNAME`, `GET_USERNAME`, `START_EXPORT`, `STOP_EXPORT`, `RESUME_EXPORT` (optional `extraItems` — "+N more" becomes a per-export `limitOverride` baked into the settings snapshot and persisted with the export state; the stored `quantityLimit` setting is NEVER modified by a resume. A resume keeps the snapshot's data FILTERS but takes PACING keys from the current stored settings — `buildResumeSettings` in the SW — so slowing the Export Speed down actually applies to the resumed run), `GET_STATUS`, `DOWNLOAD_CSV`/`DOWNLOAD_EXPORT`/`DOWNLOAD_HISTORY_ENTRY`, `SAVE_SETTINGS`/`GET_SETTINGS`, `CLEAR_EXPORT`, `GET_EXPORT_HISTORY`/`DELETE_HISTORY_ENTRY`/`CLEAR_HISTORY`, `DISCOVERED_QUERYID`/`PAGE_GRAPHQL_RESPONSE`, `CAPTURE_FEED_POSTS`, `GET_FEED_DB_SUMMARY`/`DOWNLOAD_FEED_DB`/`CLEAR_FEED_DB`. Plus the `EXPORT_STATUS_UPDATE` broadcast SW→UI.

**Lifecycle**: Chrome can kill the SW mid-export. State is saved to storage after each batch. `onStartup` marks interrupted exports `stopped`; `onInstalled` seeds default settings.

### 4.4. `utils/rateLimit.js` — `RateLimitManager`
Request spacing, 429 exponential backoff, `STALE_QUERY_ID`/network linear backoff, instant `abort()` via `AbortController`. `executeWithRateLimit(fn)` wraps any async request; `getState()`/`restoreState()` for persistence.

**Adaptive pacing (default).** `api.js` stores validated rate-limit budgets separately for `UserTweets`, `Followers`, `Following`, and `BlueVerifiedFollowers`; a missing or malformed header clears that endpoint's reading. The SW supplies only the active mode's budget to `RateLimitManager`. All five named presets use burst-first pacing: they run at their advertised delay while `remaining > raceReserve`, then hold until the advertised window reset (an explicit `'window'` wait). This fits finite exports: a small job finishes promptly, while a large job waits honestly when X's quota is spent. Missing/stale headers use mode-specific fallback delays plus the existing batch cooldown. Every inter-request wait emits a `cooldown` status carrying a `kind` (`'pacing'` / `'window'` / `'batch'`). The popup renders pacing as a 4→3→2→1 countdown with an amber bar that fills exactly over the wait, then returns to the full blue fetching animation; longer window/batch waits use `m:ss`. Page sizes are followers REST `count=100`, following/verified `count=50`, tweets `count=20`; actual speed depends on the live endpoint budget and must be benchmarked against X.

**Export Speed presets.** The single user-facing pacing knob: the `exportSpeed` setting (`'turbo' | 'fast' | 'standard' | 'careful' | 'turtle' | 'custom'`, default `'standard'`; a `<select>` in popup settings). The five named tiers advertise 2 / 3 / 4 / 7 / 12 second delays; Standard is the recommended 4-second default. `XPORTER_CONFIG.SPEED_PRESETS` maps each named tier to `adaptiveFloor`/`adaptivePad`/`budgetFraction`/`raceReserve` plus fallback-path `fallbackScale`/`batchSize`/`cooldownDuration`; `resolveSpeedPreset()` in the SW resolves it. **`'custom'` (⚠️ in the UI)** is built from the user-typed `customDelaySec`/`customCooldownMin`/`customBatchSize` settings (revealed under the select when picked; clamped to `CUSTOM_SPEED_LIMITS`), and sets `alwaysBatchCooldown` so "pause N min every M requests" is honored even while adaptive pacing is active — named tiers only apply the batch cooldown on the headerless fallback path. Every tier still obeys X's advertised budget. Replaced the old "Request Cooldown" min/batch numeric inputs; the legacy `batchSize`/`cooldownDuration` settings remain stored but are overridden by the preset.

### 4.5. `utils/storage.js` — Chrome Storage + Settings
`chrome.storage.local` with the `unlimitedStorage` permission. Access is restricted to trusted extension contexts with `setAccessLevel`; X.com content scripts use messages instead of reading export data directly. Keys: `xporter_export_state`, `xporter_settings`, `xporter_detected_username`, `xporter_tweets_batch_N`. `loadSettings()` returns defaults merged with saved values; `saveSettings()` also merges partial updates so hidden/runtime settings are not dropped by UI patches:

| Setting | Default | Notes |
|---|---|---|
| `includeRetweets` / `includeReplies` / `includeArticles` | `true` | posts filter (`includeArticles` gates X long-form Articles, type `article`) |
| `quantityLimit` | `500` | 0 = unlimited |
| `exportSpeed` | `'standard'` | speed tier `turbo/fast/standard/careful/turtle/custom` → `SPEED_PRESETS` (§4.4) |
| `customDelaySec` / `customCooldownMin` / `customBatchSize` | `5` / `3` / `20` | the Custom tier's user-typed pace (clamped to `CUSTOM_SPEED_LIMITS`) |
| `requestDelay` / `batchSize` / `cooldownDuration` | from config | legacy rate-limit knobs; preset values override them |
| `adaptivePacing` | `true` | pace from X's `x-rate-limit-*` headers (see §4.4) |
| `theme` | `'dark'` | `'dark'`/`'light'` |
| `language` | auto-detected | locale code |
| `exportMode` / `outputFormat` | posts / csv | |
| `autoExpireEnabled` / `autoExpireHours` | `true` / `4` | auto-clear old exports |
| `ladybugEnabled` | `true` | show the Easter-egg ladybug (§6.2) |

### 4.6. `utils/shared.js` — Shared UI Helpers
Loaded by `popup.html` (`popup/utils.js` was removed in v1.4.0). Provides:
- `sendMessage(msg, timeoutMs?)` — promisified `chrome.runtime.sendMessage`; resolves `{error:'TIMEOUT'}` / `{error:'MESSAGING_ERROR'}` on failure (callers must check `result.success === true` for actions)
- `checkAuth()` — looks for the `auth_token` cookie
- `formatError(code, t)` — maps error codes → i18n key / English fallback
- `extractUsernameFromInput(input)` + `RESERVED_PATHS` — parse @handle / URL (returns `''` for invalid input); `isValidUsername(v)`
- `applyI18nToDOM(translations)` — applies all `data-i18n*` attributes (§6.1)
- `escapeHtml`, `renderHelpMarkup`, `stripHelpMarkup` — tooltip markup (§6.1)
- `bidiIsolate(v)` — FSI/PDI wrapper for @handles inside RTL sentences
- `localizeQuantityOptions(select, lang, translations)` — quantity `<select>` relabeling
- `createCooldownTicker(render)` — live cooldown countdown driven by the SW's `until` timestamps
- RTL + number-formatting helpers

### 4.7. `content/content.js` + `content/interceptor.js`
- **content.js** (isolated world, `document_start`): username detection from the URL (filters reserved paths, handles SPA nav via `MutationObserver`/`popstate`), validates + relays `__XPORTER_QUERYID__` messages to the SW (operation whitelist + queryId regex — the channel is page-spoofable), and drives the date-range search-capture tab.
- **interceptor.js** (page MAIN world via manifest `"world": "MAIN"`, `document_start`, Chrome 111+ — no `web_accessible_resources`, no script-tag injection): wraps `fetch`/`XHR` to read GraphQL queryIds + `SearchTimeline` response bodies (≤8 MB), posting them back via `window.postMessage` with `location.origin` as target.
- Validation is layered: content.js → SW (`VALID_LIVE_OPERATIONS` + regex) → `api.js setLiveQueryId` (last gate before URL interpolation).

---

## 5. Export Modes, Date Range & Data Schemas

### Standard exports (posts without dates, followers, following, verified)
Direct GraphQL paging from the service worker.

### Posts + Date Range (special path)
X has no clean date-filter on the timeline GraphQL, so XPorter:
1. Opens an **X search tab** at `https://x.com/search?q=…&f=live` (`openSearchCaptureTab` / `buildSearchTimelinePageUrl`).
2. `interceptor.js` captures the page's own `SearchTimeline` responses; `content.js` scrolls the tab to load more (each scroll ping also clicks X's "Retry" button if the timeline errored).
3. SW parses captured payloads (`parseSearchTimelineResponse`) and drives the in-page overlay via `XPORTER_SEARCH_CAPTURE_STATUS` (localized via `i18n.js` — that's why the SW imports it). The overlay shows: phase subtitle, a progress bar (determinate when `progressPct` is computable — max of items/limit and date-depth of the oldest collected post via `searchCapture.oldestCollectedMs`, sweeping otherwise), a **Stop export** button (sends `STOP_EXPORT`), and an amber countdown when the SW sends `pauseUntil` (rate-limit pause). Overlay strings are the `ov*` locale keys.
4. **Stall/ban handling:** HTTP ≥400 captures pause 10–60 s (>5 in a row → `RATE_LIMITED`). If X advertises a cursor but stops answering (timeline stuck on "Something went wrong"), `recoverStalledSearchCapture()` waits 60 s × 3 rounds with the overlay countdown, then the export **errors as `RATE_LIMITED`** (buffer flushed, resumable) — it never fake-"completes" with partial data.
5. **The user must keep that tab open until the export finishes** — this is what the `dateRangeHelp` tooltip warns about.

### Passive seen-post dataset
`feed-parser.js` inspects only post-bearing GraphQL responses that X has already loaded in the page. It emits compact rows; `content.js` validates them before the SW writes them through `post-database.js`. Replies are excluded as rows, while `reply_count` is retained. IndexedDB uses the post ID as its primary key, so repeat sightings update latest metrics, `last_seen_at`, and `seen_count` without creating duplicates. The first metric snapshot is retained in `first_*` columns. No additional X requests are made, page URLs are not stored, and the oldest rows are trimmed above 50,000 unique posts. Settings exposes count, CSV/JSON download, and explicit clear.

### Schemas
- **Posts CSV**: `id, text, tweet_url, language, type, author_name, author_username, view_count, bookmark_count, favorite_count, retweet_count, reply_count, quote_count, created_at, source, hashtags, urls, media_type, media_urls` (types: `tweet`/`retweet`/`reply`/`quote`).
- **Users CSV**: `id, name, username, bio, location, url, followers_count, following_count, tweet_count, listed_count, verified, protected, created_at, profile_image_url, profile_url`.
- **Formats**: CSV (BOM-prefixed UTF-8), JSON (pretty), XLSX (dependency-free OOXML ZIP).

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

### 6.5. Toolbar Badge (service worker)
The popup closes on any outside click, so a running export was invisible — churn rows showed users start an export, lose the popup and uninstall minutes later thinking nothing happened. `updateBadgeForStatus()` in `background/service-worker.js` (called from `broadcastStatus`) keeps the export alive on the toolbar icon: live item count while running (blue), `✓` complete (green), `!` terminal error (red), `II` stopped (yellow). Transient retry errors (`retryIn` set) do **not** show `!`. A terminal badge is cleared once any UI actually renders the final state (`GET_STATUS` returning `running:false`) or on `CLEAR_EXPORT`.

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
| `NETWORK_TIMEOUT` | a fetch hit its deadline (`fetchTimed` in `utils/api.js`; per-request 30s, discovery 15s/fetch + 25s total cap) | retried like a network error |
| `MAX_RETRIES_EXCEEDED` | gave up | error message |
| `ABORTED` | user stopped | save state for resume |
| `STORAGE_FULL` | a batch write failed (quota) | export aborts loudly; collected data stays downloadable |
| `DOWNLOAD_FAILED` | FileReader error / blocked download | error toast (never a false success) |
| `ALREADY_RUNNING` | second START/RESUME while running | ignored with error |
| `NO_DATA` / `HISTORY_NOT_FOUND` / `HISTORY_DATA_GONE` | nothing to download / stale history | error toast |

Error codes ↔ i18n keys are mapped in `formatError()` (`utils/shared.js`). `recordExportError`
whitelists codes before they reach the anonymous uninstall URL (unknown → `UNKNOWN`).

On `status:'error'` the popup still offers **Download** (when items were collected) and **Resume**
(`canResume` travels in error broadcasts and GET_STATUS). `getExportStatus` repairs a persisted
`running:true` with no live export (SW killed mid-export) into a resumable `stopped`.

---

## 8. Known Pitfalls & Gotchas

1. **Feature flags are fragile** — 400s usually mean a new/renamed flag. Copy the live `features` object from DevTools into `api-features.js`.
2. **URL encoding** — use `encodeURIComponent`, never `URLSearchParams` (X rejects `+`).
3. **QueryIds change** — handled by discovery + live capture + `withStaleRetry`, but refresh `FALLBACK_ENDPOINTS` periodically.
4. **Response paths vary** — some endpoints use `timeline_v2.timeline`, others `timeline.timeline`. Check both.
5. **Service worker sleep** — Chrome kills the SW at will; persist after every batch.
6. **Single UI surface** — export controls live in `popup/`; keep its status handling aligned with service-worker messages.
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
4. Add the UI option in `popup.html`; add CSV headers; add i18n keys to all 14 locales.

### Add a setting
1. Default in `loadSettings()` (`storage.js`) and `onInstalled` (SW).
2. UI in the Settings tab of `popup.html`.
3. Wire save handler in `popup.js` (read → `SAVE_SETTINGS`), apply on load.
4. Add the i18n key to all 14 locales (en first).

### Update feature flags / queryIds
DevTools → Network → `graphql` → copy `features` / queryId → update `api-features.js` / `FALLBACK_ENDPOINTS`. Or run `scripts/discover_endpoints.js` in an x.com console.

### Bump the version
Update `version` in `manifest.json` (the footer reads it via `chrome.runtime.getManifest().version`). The footer date in `popup.html` (`.footer-build-date`) is manual.

### Testing
Run `node scripts/test-extension-core.js`, `node scripts/test-rate-limit.js`, and `node scripts/test-feed-capture.js`. For a real unpacked-browser check, run `scripts/test-extension-smoke.mjs` with Playwright available (or set `PLAYWRIGHT_MODULE` to its `index.mjs`). The authenticated date-range debug scripts may require macOS Full Disk Access to read a copied browser cookie database. Also verify both themes; stop/resume; large exports (>1000 → storage batching); CSV/XLSX in a spreadsheet app; every language; and a live date range when an authenticated test profile is available.

---

## 10. Permissions

| Permission | Purpose |
|---|---|
| `cookies` | read `ct0` value for the csrf header; `auth_token` is checked for EXISTENCE only (value never read) |
| `activeTab` | username detection on the active x.com tab (`tabs` permission was dropped in v1.4.0 — `tabs.create/remove/update/query` don't need it, and it triggered the "read browsing activity" install warning) |
| `downloads` | save files |
| `storage` + `unlimitedStorage` | export state, settings, batches (no 10 MB ceiling → no silent row loss on huge exports) |
| `host_permissions` | `https://x.com/*`, `https://twitter.com/*` |

Both content scripts are manifest-registered at `document_start`; `interceptor.js` uses `"world": "MAIN"` (hence `minimum_chrome_version: 111`). There are no `web_accessible_resources`.

---

## 11. Script Loading Order

**Service worker** (`importScripts`, order matters):
`config.js` → `api-features.js` → `api.js` → `rateLimit.js` → `columns-i18n.js` → `csv.js` → `storage.js` → `popup/i18n.js` (for the localized capture overlay).

**Popup** (`popup.html`; theme-init is the first tag inside `<body>`, the rest at end of body):
`theme-init.js` → `utils/config.js` → `utils/shared.js` → `utils/usage-tracker.js` → `i18n.js` → `theme.js` → `rate-prompt.js` → `popup.js` → `ladybug.js`.

---

## 12. Global Objects (Service Worker Scope)

| Global | Source | Notes |
|---|---|---|
| `XPORTER_CONFIG`, `XLog` | `config.js` | constants + logger |
| `XPorterAPI` | `api.js` | `.getUserByScreenName`, `.fetchUserTweets`, `.fetchFollowers/Following/VerifiedFollowers`, `.discoverEndpoints`, search-capture parsers |
| `RateLimitManager` | `rateLimit.js` | class |
| `XPorterCSV` | `csv.js` | `.generateCSV`, `.generateXLSX`, `.generateExportFilename` |
| `XPorterStorage` | `storage.js` | export state, batches, settings, username |

In pages, `utils/shared.js` exposes its helpers as plain globals; `ladybug.js` exposes `window.XPorterLadybug`.

---

## 13. Future / Backlog
- Export likes & bookmarks; media download; built-in analytics; threads as units; Firefox build.
- Refactor: rename `tweetCount`/`tweetBuffer` → `itemCount`/`itemBuffer`; keep expanding focused regression coverage.

---

## 14. How to Update This File
Update `agent.md` (and `CLAUDE.md`) whenever you add/rename a file, change the message protocol or storage schema, add export modes/formats/settings, update feature flags or queryIds, or change the data flow. Keep sections numbered; update §2's diagram for architectural changes.
