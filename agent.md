# XPorter — Agent Context File

> **Purpose**: This file gives any AI/LLM working on this codebase a complete, structured understanding of the project. Read this before making changes. **Keep this file updated** when adding new features, changing architecture, or modifying critical logic.

---

## 1. Project Overview

**XPorter** is a Chrome Extension (Manifest V3) for exporting data from X (Twitter) — tweets, followers, following, and verified followers — into CSV, JSON, or XLSX files. It uses X's **internal GraphQL API** through the user's authenticated browser session (no official paid API required).

| Property | Value |
|---|---|
| Type | Chrome Extension (Manifest V3) |
| Language | Vanilla JavaScript (ES2020+), HTML, CSS |
| Frameworks | None — zero dependencies |
| Build System | None — raw source, no bundler |
| Target Browser | Chrome / Chromium-based |
| Min Chrome Version | 88+ (MV3 support) |

### Key Selling Points
- **Free & unlimited** — competitors charge $12–15/mo and cap at 150–200 posts
- **Multi-mode** — posts, followers, following, verified followers
- **Multi-format** — CSV, JSON, XLSX (XML SpreadsheetML)
- **14 languages** — automatic browser language detection
- **Dynamic endpoint discovery** — auto-extracts GraphQL queryIds from X's JS bundles

---

## 2. Architecture & Data Flow

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│ content.js   │────▶│ service-worker.js │◀───▶│ popup.js / export.js │
│ (x.com page) │     │ (background)      │     │ (UI layer)           │
│              │     │                   │     │                      │
│ Detects      │     │ • Export engine   │     │ • User input         │
│ username     │     │ • API calls       │     │ • Progress display   │
│ from URL     │     │ • Rate limiting   │     │ • Settings           │
│              │     │ • Storage mgmt    │     │ • Download trigger    │
│              │     │ • CSV/JSON/XLSX   │     │                      │
└──────────────┘     └──────────────────┘     └──────────────────────┘
                              │
                              ▼
                     ┌───────────────┐
                     │ X GraphQL API │
                     │ (api.x.com)   │
                     └───────────────┘
```

### Communication Pattern
All inter-component communication uses `chrome.runtime.sendMessage` / `onMessage`:
- **popup/export → service-worker**: Commands (`START_EXPORT`, `STOP_EXPORT`, `GET_STATUS`, `DOWNLOAD_CSV`, etc.)
- **service-worker → popup/export**: Status updates (`EXPORT_STATUS_UPDATE` broadcast)
- **content.js → service-worker**: Username detection (`SET_USERNAME`)

### Export Flow (High-Level)
1. User enters username + options in popup
2. Popup sends `START_EXPORT` message to service worker
3. Service worker resolves user ID via `UserByScreenName` GraphQL
4. Fetches data in batches using the appropriate API endpoint
5. Each batch is parsed and stored in `chrome.storage.local` (batched at 50 items)
6. Rate limiter manages cooldowns and retries
7. On completion, user clicks Download → service worker assembles all batches and triggers `chrome.downloads`

---

## 3. File Structure & Responsibilities

```
xporter/
├── manifest.json                    # Extension manifest (MV3)
├── agent.md                         # THIS FILE — AI context
├── README.md                        # User-facing documentation
├── LICENSE                          # Custom license
├── .gitignore                       # Git ignore rules
│
├── background/
│   └── service-worker.js            # 🔑 CORE: Export engine, message router
│
├── content/
│   └── content.js                   # Username detection from X page URL
│
├── popup/                           # Popup UI (compact 350px view)
│   ├── popup.html                   # Popup structure
│   ├── popup.css                    # All styles (dark/light theme via CSS vars)
│   ├── popup.js                     # Popup logic (tabs, export trigger, status)
│   ├── theme.js                     # Theme toggle + SVG icon templates
│   ├── i18n.js                      # Internationalization engine
│   ├── utils.js                     # Messaging, auth check, URL parsing, debounce
│   └── locales/                     # 14 language files
│       ├── en.json                  # English (fallback/default)
│       ├── ru.json, es.json, ...    # Other languages
│
├── export/                          # Full-page export UI (alternative to popup)
│   ├── export.html                  # Export page structure
│   ├── export.css                   # Export page styles
│   └── export.js                    # Export page logic (mirrors popup flow)
│
├── utils/                           # Shared utility modules (loaded by service-worker)
│   ├── config.js                    # 🔑 Centralized config constants + XLog logger
│   ├── api.js                       # 🔑 X GraphQL API integration + endpoint discovery
│   ├── rateLimit.js                 # RateLimitManager class (batch, cooldown, retry)
│   ├── csv.js                       # CSV generation with BOM for Excel
│   └── storage.js                   # chrome.storage.local wrapper (quota-aware)
│
├── scripts/
│   └── discover_endpoints.js        # Standalone debugging script for finding queryIds
│
└── icons/
    ├── icon16.png, icon48.png, icon128.png
```

---

## 4. Critical Files — Detailed Reference

### 4.1. `utils/config.js` — Central Configuration

All tunable parameters are centralized here. **Never hardcode magic numbers elsewhere.**

| Constant | Default | Purpose |
|---|---|---|
| `DEBUG` | `true` | Enable/disable verbose `[XPorter]` console logging |
| `REQUEST_DELAY` | `3000` | ms pause between API requests |
| `COOLDOWN_DURATION` | `180000` | 3 min cooldown after each batch |
| `BATCH_SIZE` | `20` | Requests per batch before cooldown |
| `RATE_LIMIT_PAUSE` | `60000` | Base wait on 429 (exponential backoff) |
| `MAX_RETRIES` | `5` | Max retry attempts per request |
| `ENDPOINT_CACHE_TTL` | `1800000` | 30 min cache for discovered queryIds |
| `TWEETS_PER_BATCH` | `50` | Items per storage batch |
| `FALLBACK_BEARER_TOKEN` | `AAAA...` | Static bearer (same for all X users) |

**`XLog`** — Debug logger used throughout. Always use `XLog.log()`, `XLog.warn()`, `XLog.error()` instead of `console.*` in service worker code.

### 4.2. `utils/api.js` — X GraphQL API Integration

This is the most complex and fragile file. Key concepts:

#### Endpoint Discovery
The extension dynamically discovers GraphQL `queryId` values by:
1. Fetching `https://x.com` HTML
2. Extracting JS bundle URLs (`abs.twimg.com/responsive-web/client-web*.js`)
3. Scanning bundle source code with regex for `queryId:"...",operationName:"..."`
4. Caching results for 30 minutes

If discovery fails, hardcoded `FALLBACK_ENDPOINTS` are used. These **will become stale** when X updates their bundles — they must be manually updated.

#### Target Operations
| Operation | Purpose | Feature Set |
|---|---|---|
| `UserByScreenName` | Resolve username → userId | `USER_FEATURES` |
| `UserTweets` | Fetch user's tweets | `TWEETS_FEATURES` (39 flags!) |
| `Followers` | Fetch user's followers | `FOLLOWERS_FEATURES` |
| `Following` | Fetch user's following | `FOLLOWERS_FEATURES` |
| `BlueVerifiedFollowers` | Fetch verified followers | `FOLLOWERS_FEATURES` |

#### Feature Flags (CRITICAL)
X requires specific boolean feature flags in every GraphQL request. Missing flags cause `400 Bad Request`. These flags change periodically — especially Grok-related ones added in 2025+. **When updating, use the actual flags sent by x.com in DevTools Network tab.**

#### Stale Query ID Retry
```
withStaleRetry(endpointKey, makeRequest)
```
Wrapper that catches `STALE_QUERY_ID` errors, forces endpoint re-discovery, and retries once with fresh IDs. This is the self-healing mechanism against X API changes.

#### Authentication
The extension reads cookies directly from the browser:
- `ct0` cookie → CSRF token (`x-csrf-token` header)
- `auth_token` cookie → session authentication
- Bearer token → extracted from X's JS bundles or hardcoded fallback

**Important**: Requests go through `https://x.com/i/api/graphql/...` (not `api.x.com`) and use `encodeURIComponent` for URL params (NOT `URLSearchParams` — X rejects `+` encoding for spaces).

### 4.3. `background/service-worker.js` — Export Engine

Central orchestrator. Key state object:

```javascript
currentExport = {
    running: boolean,
    username: string,
    exportMode: 'posts' | 'followers' | 'following' | 'verified_followers',
    outputFormat: 'csv' | 'json' | 'xlsx',
    dateFrom: Date | null,      // posts only
    dateTo: Date | null,        // posts only
    settings: object,
    tweetCount: number,         // actually "item count" (tweets or users)
    totalBatches: number,
    tweetBuffer: array,         // in-memory buffer flushed to storage
    userId: string,
    cursor: string,             // pagination cursor
    status: 'resolving_user' | 'fetching' | 'complete' | 'stopped' | 'error'
}
```

#### Message Types
| Message | Direction | Purpose |
|---|---|---|
| `SET_USERNAME` | content → SW | Auto-detected username |
| `GET_USERNAME` | popup → SW | Retrieve cached username |
| `START_EXPORT` | popup → SW | Begin export (username, mode, options) |
| `STOP_EXPORT` | popup → SW | Stop running export |
| `RESUME_EXPORT` | popup → SW | Resume stopped/errored export |
| `GET_STATUS` | popup → SW | Get current export state |
| `DOWNLOAD_CSV` / `DOWNLOAD_EXPORT` | popup → SW | Trigger file download |
| `SAVE_SETTINGS` / `GET_SETTINGS` | popup → SW | Persist/load user settings |
| `CLEAR_EXPORT` | popup → SW | Clear saved export data |
| `EXPORT_STATUS_UPDATE` | SW → popup | Live status broadcast |

#### Service Worker Lifecycle
- Can be **killed by Chrome** at any time during long exports
- State is periodically saved to `chrome.storage.local` via `saveCurrentState()`
- On startup (`onStartup`): marks interrupted exports as `stopped`
- On install (`onInstalled`): initializes default settings

### 4.4. `utils/rateLimit.js` — Rate Limiting

`RateLimitManager` class handles:
- **Batch cooldowns** — pause after every N requests
- **Request spacing** — delay between individual requests
- **429 handling** — exponential backoff (`base * 2^attempt`)
- **STALE_QUERY_ID** — linear backoff with re-discovery
- **Network errors** — linear backoff
- **Abort** — instant cancellation via `AbortController`

Key methods:
- `executeWithRateLimit(requestFn)` — wraps any async function with rate limiting
- `abort()` — immediately cancels any pending wait
- `getState()` / `restoreState()` — serialize for storage persistence

### 4.5. `utils/storage.js` — Chrome Storage

Uses `chrome.storage.local` (10 MB quota). Storage keys:

| Key | Purpose |
|---|---|
| `xporter_export_state` | Current export metadata (cursor, counts, status) |
| `xporter_settings` | User preferences |
| `xporter_detected_username` | Auto-detected username from content script |
| `xporter_tweets_batch_N` | Exported data batches (N = 0, 1, 2, ...) |

Includes quota monitoring (`checkStorageQuota`) and safe read/write wrappers.

### 4.6. `popup/i18n.js` — Internationalization

- 14 languages with per-language JSON files in `popup/locales/`
- English is the **fallback locale** — any missing key falls through to `en.json`
- Browser language is auto-detected on first run via `chrome.i18n.getUILanguage()`
- Translation keys are applied via `data-i18n` attributes in HTML
- Locales are cached in memory after first load

### 4.7. `content/content.js` — Username Detection

Runs on x.com/twitter.com pages. Extracts username from URL path:
- Filters out reserved paths (`home`, `explore`, `messages`, etc.)
- Handles SPA navigation via `MutationObserver` + `popstate`
- Sends `SET_USERNAME` to service worker for popup auto-fill

---

## 5. Export Modes & Data Schemas

### Posts Export
CSV columns: `id`, `text`, `tweet_url`, `language`, `type`, `author_name`, `author_username`, `view_count`, `bookmark_count`, `favorite_count`, `retweet_count`, `reply_count`, `quote_count`, `created_at`, `source`, `hashtags`, `urls`, `media_type`, `media_urls`

Tweet types: `tweet`, `retweet`, `reply`, `quote`

### Users Export (Followers/Following/Verified)
CSV columns: `id`, `name`, `username`, `bio`, `location`, `url`, `followers_count`, `following_count`, `tweet_count`, `listed_count`, `verified`, `protected`, `created_at`, `profile_image_url`, `profile_url`

### Output Formats
- **CSV** — BOM-prefixed UTF-8 for Excel compatibility
- **JSON** — Pretty-printed `JSON.stringify(data, null, 2)`
- **XLSX** — XML SpreadsheetML (no external library needed)

---

## 6. Theme System

- Two themes: `dark` (default) and `light`
- Toggled via `.light` class on `<body>`
- All colors in `popup.css` use CSS custom properties (`:root` / `.light` selectors)
- Early theme application via inline `<script>` in HTML prevents FOUC (flash of unstyled content)

---

## 7. Common Errors & Error Handling

| Error Code | Cause | Action |
|---|---|---|
| `NOT_LOGGED_IN` | No `auth_token` / `ct0` cookie | Show login prompt |
| `USER_NOT_FOUND` | Invalid username | Show error message |
| `USER_SUSPENDED` | Account suspended | Show error message |
| `ACCOUNT_PRIVATE` | Protected account | Show error message |
| `RATE_LIMITED` | HTTP 429 | Exponential backoff, auto-retry |
| `STALE_QUERY_ID` | HTTP 400/404 (queryId changed) | Invalidate cache, re-discover, retry |
| `AUTH_ERROR` | HTTP 401/403 | Re-auth required |
| `ABORTED` | User stopped export | Save state for resume |

---

## 8. Known Pitfalls & Gotchas

### API-Related
1. **Feature flags are fragile** — X periodically adds new required flags. If you get 400 errors, open DevTools on x.com, find a GraphQL request, and copy the current `features` object.
2. **URL encoding matters** — Use `encodeURIComponent`, NOT `URLSearchParams`. X rejects `+` for spaces.
3. **Bearer token is public** — The same token works for all users. It changes very rarely but can be dynamically extracted from X's JS bundles.
4. **QueryIds change frequently** — The dynamic discovery system handles this, but fallback IDs in `api.js` should be periodically updated for resilience.
5. **Response paths vary** — Some endpoints use `timeline_v2.timeline`, others use `timeline.timeline`. Always check both.
6. **Grok features** — As of 2025+, Grok-related feature flags are required in `TWEETS_FEATURES`. Omitting them causes 400 errors.

### Extension-Related
7. **Service worker sleep** — Chrome can kill the service worker at any time. All progress must be saved to `chrome.storage.local` after every batch.
8. **Message timeout** — `sendMessage` can fail silently if the service worker is asleep. The popup uses timeout-based fallback (5s default).
9. **Dual UI surfaces** — Both `popup.js` and `export.js` implement similar logic. Changes to messaging protocol or status handling **must be reflected in both**.
10. **Naming inconsistency** — The code uses `tweetCount`/`tweetBuffer` even for user exports (followers/following). This is a historical artifact — treat them as `itemCount`/`itemBuffer`.

### CSS/Theme
11. **FOUC prevention** — Theme is applied via an inline `<script>` in `popup.html` (before CSS loads) to prevent flash of wrong theme. Don't remove this.
12. **CSS variables** — All colors use CSS vars. Never hardcode hex/rgb values.

---

## 9. Development Guidelines

### Adding a New Export Mode
1. Add GraphQL endpoint to `FALLBACK_ENDPOINTS` and `discoverEndpoints()` in `api.js`
2. Create fetch function (follow `fetchFollowers` pattern)
3. Create response parser (follow `parseFollowersResponse` pattern)
4. Export new function via `globalThis.XPorterAPI`
5. Add mode to `_fetchUsersLoop` dispatch in `service-worker.js`
6. Add UI option in `popup.html` and `export.html`
7. Add CSV column headers in `generateUsersCSV` or create new generator
8. Add i18n keys to all 14 locale files

### Adding a New Setting
1. Add default value in `loadSettings()` in `storage.js`
2. Add default in `onInstalled` handler in `service-worker.js`
3. Add UI element in settings tab of `popup.html` / `export.html`
4. Wire up save handler in `popup.js` / `export.js`
5. Add i18n key to all 14 locale files

### Updating Feature Flags
1. Open x.com in Chrome DevTools → Network tab
2. Filter by `graphql`
3. Find a request for the target operation (e.g., `UserTweets`)
4. Copy the `features` query parameter value
5. Replace the corresponding constant (`TWEETS_FEATURES`, `USER_FEATURES`, etc.) in `api.js`

### Updating Fallback QueryIds
1. Run `scripts/discover_endpoints.js` in a x.com tab console, OR
2. Use DevTools Network tab to find current queryIds
3. Update `FALLBACK_ENDPOINTS` in `api.js`

### Adding a New Translation
1. Create `popup/locales/{code}.json` based on `en.json`
2. Add language entry to `LANGUAGES` array in `i18n.js`
3. Translate all keys

### Testing Considerations
- Always test with **both** dark and light themes
- Test with **export stopped/resumed** (service worker resilience)
- Test with large exports (>1000 items) to verify storage batching
- Verify CSV opens correctly in Excel (BOM, escaping of commas/quotes/newlines)
- Test error recovery: kill network mid-export, test 429 handling
- Test i18n: switch languages, verify all strings translate

---

## 10. Permissions Used

| Permission | Purpose |
|---|---|
| `cookies` | Read `ct0` and `auth_token` cookies for API auth |
| `activeTab` | Access current tab for username detection |
| `tabs` | Query active tab URL |
| `downloads` | Trigger file downloads |
| `storage` | Persist export state, settings, batched data |
| `host_permissions: x.com, api.x.com, twitter.com` | Make API requests to X |

---

## 11. Script Loading Order

### Service Worker (`background/service-worker.js`)
Loads utils via `importScripts()` in this order (order matters — later scripts depend on earlier ones):
1. `utils/config.js` — defines `XPORTER_CONFIG` and `XLog`
2. `utils/api.js` — defines `XPorterAPI` (uses `XPORTER_CONFIG`, `XLog`)
3. `utils/rateLimit.js` — defines `RateLimitManager` (uses `XPORTER_CONFIG`, `XLog`)
4. `utils/csv.js` — defines `XPorterCSV`
5. `utils/storage.js` — defines `XPorterStorage` (uses `XPORTER_CONFIG`, `XLog`)

### Popup (`popup/popup.html`)
Scripts loaded at end of `<body>`:
1. `popup/i18n.js`
2. `popup/theme.js`
3. `popup/utils.js`
4. `popup/popup.js`

### Export Page (`export/export.html`)
Loads `popup/i18n.js` and `popup/utils.js` via relative paths, then `export/export.js`.

---

## 12. Global Objects (Service Worker Scope)

All utility modules export to `globalThis` for use in the service worker:

| Global | Source | Key Methods/Properties |
|---|---|---|
| `XPORTER_CONFIG` | `config.js` | All config constants |
| `XLog` | `config.js` | `.log()`, `.warn()`, `.error()`, `.info()` |
| `XPorterAPI` | `api.js` | `.getUserByScreenName()`, `.fetchUserTweets()`, `.fetchFollowers()`, `.fetchFollowing()`, `.fetchVerifiedFollowers()`, `.discoverEndpoints()` |
| `RateLimitManager` | `rateLimit.js` | Class constructor |
| `XPorterCSV` | `csv.js` | `.generateCSV()`, `.generateFilename()` |
| `XPorterStorage` | `storage.js` | `.saveExportState()`, `.loadExportState()`, `.saveTweetBatch()`, `.loadAllTweets()`, `.clearExportState()`, `.saveSettings()`, `.loadSettings()`, `.saveDetectedUsername()`, `.loadDetectedUsername()` |

---

## 13. Future Development Notes

### Planned Features (from spec)
- [ ] Export likes, bookmarks
- [ ] Media download (photos/videos)
- [ ] Built-in analytics (average metrics, top tweets, charts)
- [ ] Export threads as single units
- [ ] `conversation_id` and location data in CSV
- [ ] Firefox version

### Architectural Improvements to Consider
- [ ] **Refactor dual UI**: `popup.js` and `export.js` share ~60% logic — extract shared module
- [ ] **Rename `tweetBuffer`/`tweetCount`** to generic `itemBuffer`/`itemCount` for clarity
- [ ] **Add unit tests**: CSV escaping, URL parsing, tweet type detection, error mapping
- [ ] **Consider Web Workers** for CSV/XLSX generation on very large datasets
- [ ] **Add storage cleanup** for orphaned batch keys after crashes

---

## 14. Quick Reference — How to Update This File

Update `agent.md` whenever you:
- Add/remove/rename a file
- Change the message protocol (message types, payload structure)
- Modify storage keys or schema
- Add new export modes or output formats
- Update feature flags or fallback queryIds
- Change settings defaults
- Add new error codes
- Modify the data flow or architecture

**Format**: Keep sections numbered. Add new info to the appropriate section. For major architectural changes, update the data flow diagram (Section 2).
