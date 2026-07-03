<p align="center">
  <img src="icons/icon128.png" alt="XPorter" width="80" />
</p>

<h1 align="center">XPorter</h1>

<p align="center">
  Free, unlimited export of X (Twitter) posts, followers, and following to CSV, JSON, or XLSX.<br/>
  A Chrome extension — no servers or subscriptions; your exported data stays local.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/jghmghialodmkmbcpfnhkgllkmjafmja">
    <img src="https://img.shields.io/badge/Chrome%20Web%20Store-Install-1a73e8?logo=googlechrome&logoColor=white" alt="Install from the Chrome Web Store" />
  </a>
  <img src="https://img.shields.io/badge/Manifest-V3-34a853" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen" alt="Zero dependencies" />
  <img src="https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue" alt="MIT with Commons Clause" />
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

> **Why is this open source?** XPorter runs inside your browser with access to your X session. You shouldn't have to *trust* that — you should be able to *check* it. This repository is the exact code that ships to the Chrome Web Store: no backend, no bundler, no minification. Read every line.

## Features

- **Full engagement metrics** — views, likes, retweets, replies, quotes, bookmarks
- **Passive seen-post dataset** — stores one local row per non-reply post already loaded while you browse X, with first/latest metrics and no extra API requests
- **Multiple export modes** — posts, followers, following, and verified followers
- **CSV, JSON, and XLSX output** — choose the format that fits your workflow
- **Date range filtering** — export posts from a specific time window
- **Pause and resume** — stop mid-export and continue later with zero data loss
- **Smart rate limiting** — handles X API limits automatically with configurable batch sizes and cooldowns
- **100% local processing** — everything happens in your browser; your exported data is never transmitted anywhere
- **Dark and light themes** — glassmorphism UI with a one-click toggle
- **14 languages** — auto-detects Chrome's UI language on first launch
- **Dynamic API discovery** — extracts fresh GraphQL query IDs from X's JS bundles at runtime; gracefully falls back to hardcoded IDs
- **Crash-resilient** — export progress is persisted to Chrome storage and survives browser restarts
- **Zero dependencies** — no npm packages, no build step, pure vanilla JavaScript

## Installation

### From the Chrome Web Store (recommended)

**[→ Install XPorter](https://chromewebstore.google.com/detail/jghmghialodmkmbcpfnhkgllkmjafmja)**

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

All settings are persisted in Chrome storage and synced between the popup and export page.

| Setting | Default | Description |
|---|---|---|
| Include retweets | On | Export retweets alongside original posts |
| Include replies | On | Export replies alongside original posts |
| Export mode | Posts | Data type to export: posts, followers, following, or verified followers |
| Output format | CSV | File format: CSV, JSON, or XLSX |
| Quantity limit | 500 | Maximum posts or users per export (0 = unlimited) |
| Cooldown duration | 3 min | Pause between request batches |
| Batch size | 20 | Requests before triggering a cooldown |

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
xporter-extension/
├── manifest.json             # Manifest V3 configuration
├── background/
│   └── service-worker.js     # Export engine, message router, state machine
├── content/
│   ├── feed-parser.js        # Extracts compact non-reply post rows from page responses
│   ├── content.js            # Username detection from the active X tab
│   └── interceptor.js        # Page-context hook for GraphQL IDs and seen-post capture
├── popup/                    # Compact popup UI
│   ├── popup.html/.css/.js   # Markup, glassmorphism styles (dark + light), logic
│   ├── theme-init.js/theme.js# Theme bootstrap (anti-FOUC) + toggle
│   ├── i18n.js               # In-app translation engine
│   ├── rate-prompt.js/.css   # "Rate XPorter" prompt (shared by popup + export page)
│   ├── ladybug.js            # Easter-egg ladybug on the About tab
│   └── locales/*.json        # UI strings for 14 languages (en = fallback)
├── export/
│   └── export.html/.css/.js  # Full-page export UI
├── utils/
│   ├── api.js                # X GraphQL client, endpoint discovery
│   ├── api-features.js       # GraphQL feature-flag constants
│   ├── config.js             # Tunable constants + logger
│   ├── rateLimit.js          # Batch rate limiter with cooldowns
│   ├── csv.js                # CSV / XLSX generation (JSON is built in the worker)
│   ├── columns-i18n.js       # Localized CSV/XLSX column headers
│   ├── storage.js            # Chrome storage abstraction + settings
│   ├── post-database.js      # Deduplicated seen-post IndexedDB store
│   ├── usage-tracker.js      # Anonymous local usage counters (opens, active time)
│   └── shared.js             # Helpers shared by the popup and export pages
├── _locales/                 # Chrome Web Store metadata translations
└── icons/                    # icon16/48/128.png + bolt16/48/128.png (toolbar action icons)
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
- **One exception:** when you uninstall XPorter, an anonymous usage summary (no X data, no usernames, nothing that identifies you) is sent once to help improve the extension — see the [privacy policy](https://lemelson.github.io/xporter/privacy-policy.html) for exactly what it contains

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/Lemelson/xporter-extension/issues) for bugs or feature requests, or submit a pull request directly.

## Contact

- Telegram: [@Lemelson](https://t.me/Lemelson)
- GitHub: [@Lemelson](https://github.com/Lemelson)

## Disclaimer

This project is not affiliated with, endorsed by, or connected to X Corp. It is an independent tool that uses your own authenticated browser session to export publicly available data. Use in accordance with applicable terms of service.

## License

Licensed under the **MIT License with Commons Clause**.

You are free to use, modify, and redistribute this software at no cost. You may **not** sell it, offer it as a paid service, or publish paid derivatives on browser extension marketplaces.

See [LICENSE](LICENSE) for full terms.

---

<p align="center">
  Built by <a href="https://github.com/Lemelson">Lemelson</a>
</p>
