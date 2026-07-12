<p align="center">
  <img src="icons/icon128.png" alt="XPorter" width="80" />
</p>

<h1 align="center">XPorter</h1>

<p align="center">
  Free, unlimited export of X (Twitter) posts, followers, and following to CSV, JSON, or XLSX.<br/>
  A Chrome extension — no servers or subscriptions; your exported data stays local.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#export-output">Export Output</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#supported-languages">Languages</a> ·
  <a href="#project-structure">Project Structure</a> ·
  <a href="#license">License</a>
</p>

---

## Features

- **Full engagement metrics** — views, likes, retweets, replies, quotes, bookmarks
- **Passive seen-post dataset** — stores one local row per non-reply post already loaded while you browse X, with first/latest metrics and no extra API requests
- **Multiple export modes** — posts, followers, following, and verified followers
- **CSV, JSON, and XLSX output** — choose the format that fits your workflow
- **Date range filtering** — export posts from a specific time window
- **Pause and resume** — stop mid-export and continue later with zero data loss
- **Smart rate limiting** — six Export Speed modes plus live quota-aware pauses and retries
- **100% local processing** — everything happens in your browser; your exported data is never transmitted anywhere
- **Dark and light themes** — glassmorphism UI with a one-click toggle
- **14 languages** — auto-detects Chrome's UI language on first launch
- **Dynamic API discovery** — extracts fresh GraphQL query IDs from X's JS bundles at runtime; gracefully falls back to hardcoded IDs
- **Crash-resilient** — export progress is persisted to Chrome storage and survives browser restarts
- **Zero dependencies** — no npm packages, no build step, pure vanilla JavaScript

## Installation

### From Source (Developer Mode)

```bash
git clone https://github.com/Lemelson/xporter-extension.git
```

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked** and select the cloned `xporter-extension/` directory
4. Navigate to [x.com](https://x.com) and log in
5. Click the XPorter icon in the toolbar

## How It Works

XPorter leverages your existing authenticated X session to access X's internal GraphQL API. No API keys, no OAuth flow — it piggybacks on the cookies you already have.

```
Popup UI ──▶ Service Worker ──▶ X APIs ──▶ CSV / JSON / XLSX File
                  │
            Chrome Storage
            (incremental saves)
                  │
Content Script ── detects username from active tab
               └─ records posts already loaded by X into local IndexedDB
```

**Export flow:**

1. **Content script** detects the currently viewed profile from the X tab URL
2. **Popup** collects the target username and export settings
3. **Service worker** resolves the username to a user ID via `UserByScreenName`, then fetches the selected data type in paginated batches
4. Items are saved incrementally to Chrome local storage (batches of 50)
5. On completion (or manual download), items are compiled into CSV, JSON, or XLSX locally in the browser

While you browse X, the page hook also extracts non-reply posts from timeline responses X has already loaded. They are deduplicated by post ID in a local IndexedDB database; repeat sightings update metrics and exposure count instead of adding rows. The Settings tab can export this dataset as CSV/JSON or clear it. Collection is capped at the 50,000 most recently seen unique posts.

**Endpoint discovery:**

X periodically rotates its GraphQL `queryId` values. XPorter handles this by:
1. Fetching the X main page HTML
2. Scanning linked JS bundles for `queryId` + `operationName` patterns
3. Caching discovered IDs for 24 hours (stale IDs self-heal on failure)
4. Falling back to hardcoded IDs if discovery fails
5. Automatically re-discovering on `STALE_QUERY_ID` (HTTP 400) errors

**Rate limiting:**
- Five named speed presets target roughly 2 / 3 / 4 / 7 / 12 seconds between requests; Standard (~4 s) is the default
- A Custom mode exposes the request delay, batch size, and longer batch cooldown
- Valid `x-rate-limit-*` headers always take priority so XPorter stops at the live quota instead of overrunning it
- Missing headers use conservative mode-specific fallback delays; 429s and network timeouts retry automatically
- Stale GraphQL query IDs trigger live capture or endpoint re-discovery before the export fails

## Export Output

Post exports include:

| Field | Description |
|---|---|
| `id` | Tweet ID |
| `text` | Full text (including long-form notes) |
| `tweet_url` | Direct link |
| `language` | ISO language code |
| `type` | `tweet` · `retweet` · `reply` · `quote` |
| `author_name` | Display name |
| `author_username` | Handle (without @) |
| `view_count` | Views |
| `bookmark_count` | Bookmarks |
| `favorite_count` | Likes |
| `retweet_count` | Retweets |
| `reply_count` | Replies |
| `quote_count` | Quote tweets |
| `created_at` | Timestamp |
| `source` | Posting client |
| `hashtags` | Comma-separated |
| `urls` | Expanded URLs, comma-separated |
| `media_type` | `photo` · `video` · `animated_gif` |
| `media_urls` | Direct media URLs (highest quality) |
| `media_alt_texts` | Author-written media descriptions, when present |
| `article_title` / `article_url` / `article_text` | X Article metadata and available plain text |

User-list exports include:

| Field | Description |
|---|---|
| `id` | User ID |
| `name` | Display name |
| `username` | Handle without @ |
| `bio` | Profile description |
| `location` | Profile location |
| `url` | Profile website |
| `followers_count` | Follower count |
| `following_count` | Following count |
| `tweet_count` | Post count |
| `listed_count` | List count |
| `verified` | Verification status |
| `protected` | Protected/private status |
| `created_at` | Account creation timestamp |
| `profile_image_url` | Profile image URL |
| `profile_url` | Direct X profile URL |

## Configuration

All settings are persisted in Chrome storage and reused across popup sessions.

| Setting | Default | Description |
|---|---|---|
| Include retweets | On | Export retweets alongside original posts |
| Include replies | On | Export replies alongside original posts |
| Include articles | On | Export X Articles alongside ordinary posts |
| Export mode | Posts | Data type to export: posts, followers, following, or verified followers |
| Output format | CSV | File format: CSV, JSON, or XLSX |
| Quantity limit | 500 | Maximum posts or users per export (0 = unlimited) |
| Export Speed | Standard | Turbo, Fast, Standard, Careful, Turtle, or Custom request pacing |
| Custom pacing | 5 s / 20 / 3 min | Delay, requests per batch, and batch pause used only by Custom |
| Auto-clear old exports | On / 4 hours | Removes old downloadable payloads while keeping history metadata |
| Localize column titles | On | Translate CSV/XLSX headers; JSON keys always remain English |

Preset quantity options: 100, 500, 1,000, 5,000, 10,000, unlimited, or a custom value.

## Supported Languages

The UI auto-detects your Chrome language on first launch and can be changed at any time via the header dropdown.

| Language | Code | Language | Code |
|---|---|---|---|
| English | `en` | Français | `fr` |
| Español | `es` | Deutsch | `de` |
| Português | `pt` | 日本語 | `ja` |
| हिन्दी | `hi` | 한국어 | `ko` |
| 中文 | `zh` | Türkçe | `tr` |
| Русский | `ru` | Bahasa Indonesia | `id` |
| العربية | `ar` | Italiano | `it` |

## Project Structure

```
xporter/
├── manifest.json             # Manifest V3 configuration
├── agent.md / CLAUDE.md      # Developer & AI context docs
├── background/
│   ├── service-worker.js     # Export engine, message router, state machine
│   ├── downloads.js          # File serialization + Chrome download handoff
│   └── uninstall-feedback.js # Anonymous uninstall-summary URL
├── content/
│   ├── feed-parser.js        # Extracts compact non-reply post rows from page responses
│   ├── content.js            # Username detection from the active X tab
│   └── interceptor.js        # Page-context hook for GraphQL IDs and seen-post capture
├── popup/                    # Compact popup UI
│   ├── popup.html/.css/.js   # Markup, glassmorphism styles (dark + light), logic
│   ├── theme-init.js/theme.js# Theme bootstrap (anti-FOUC) + toggle
│   ├── i18n.js               # In-app translation engine
│   ├── rate-prompt.js/.css   # "Rate XPorter" prompt
│   ├── history.js            # Export-history UI
│   ├── seen-posts.js         # Passive seen-post dataset UI
│   ├── ladybug.js            # Easter-egg ladybug on the About tab
│   └── locales/*.json        # UI strings for 14 languages (en = fallback)
├── utils/
│   ├── api.js                # X GraphQL client, endpoint discovery
│   ├── api-parsers.js        # Pure X response parsers
│   ├── api-features.js       # GraphQL feature-flag constants
│   ├── config.js             # Tunable constants + logger
│   ├── rateLimit.js          # Batch rate limiter with cooldowns
│   ├── csv.js                # CSV / XLSX generation (JSON is built in the worker)
│   ├── columns-i18n.js       # Localized CSV/XLSX column headers
│   ├── storage.js            # Chrome storage abstraction + settings
│   ├── post-database.js      # Deduplicated seen-post IndexedDB store
│   ├── usage-tracker.js      # Anonymous local usage counters (opens, active time)
│   └── shared.js             # Shared popup/UI helpers
├── _locales/                 # Chrome Web Store metadata translations
├── icons/                    # icon16/48/128.png + bolt16/48/128.png (toolbar action icons)
├── docs/                     # GitHub Pages site (landing, feedback, privacy policy)
└── scripts/                  # Dev/debug scripts + CWS packaging (not shipped)
```

### Design Decisions

- **Manifest V3** — service workers instead of persistent background pages
- **No bundler** — load directly from source; no webpack, no Vite
- **No npm dependencies** — the entire extension is vanilla JS
- **Incremental persistence** — export items are saved in batches of 50 to prevent data loss on service worker termination
- **BOM-prefixed CSV** — ensures correct Unicode rendering in Excel

## Privacy

- All exported data stays local — your X data never leaves your browser
- The seen-post dataset is stored only in local IndexedDB and can be exported or cleared from Settings
- No third-party analytics, advertising, or tracking SDKs
- No extension-owned backend; normal export traffic goes only to X.com
- Authentication uses your existing X session cookies — XPorter never stores or transmits credentials
- **One exception:** when you uninstall XPorter, an anonymous usage summary (no X data, no usernames, nothing that identifies you) is sent once to help improve the extension — see the [privacy policy](privacy-policy.html) for exactly what it contains

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/Lemelson/xporter-extension/issues) for bugs or feature requests, or submit a pull request directly.

## Contact

- Telegram: [@lemelson](https://t.me/lemelson)
- GitHub: [@Lemelson](https://github.com/Lemelson)

## Disclaimer

This project is not affiliated with, endorsed by, or connected to X Corp. It is an independent tool that uses your own authenticated browser session to export publicly available data. Use in accordance with applicable terms of service.

## License

Licensed under the **MIT License with Commons Clause**.

You are free to use, modify, and redistribute this software at no cost. You may not sell it, offer it as a paid service, or publish paid derivatives on browser extension marketplaces.

See [LICENSE](LICENSE) for full terms.

---

<p align="center">
  Built by <a href="https://github.com/Lemelson">Lemelson</a>
</p>
