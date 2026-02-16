<p align="center">
  <img src="icons/icon128.png" alt="XPorter" width="80" />
</p>

<h1 align="center">XPorter</h1>

<p align="center">
  Free, unlimited export of X (Twitter) posts to CSV.<br/>
  A Chrome extension — no servers, no subscriptions, no tracking.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#csv-output">CSV Output</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#supported-languages">Languages</a> ·
  <a href="#project-structure">Project Structure</a> ·
  <a href="#license">License</a>
</p>

---

## Features

- **Full engagement metrics** — views, likes, retweets, replies, quotes, bookmarks
- **Date range filtering** — export posts from a specific time window
- **Pause and resume** — stop mid-export and continue later with zero data loss
- **Smart rate limiting** — handles X API limits automatically with configurable batch sizes and cooldowns
- **100% local** — all processing happens in your browser; no data is transmitted externally
- **Dark and light themes** — glassmorphism UI with a one-click toggle
- **14 languages** — auto-detects Chrome's UI language on first launch
- **Dynamic API discovery** — extracts fresh GraphQL query IDs from X's JS bundles at runtime; gracefully falls back to hardcoded IDs
- **Crash-resilient** — export progress is persisted to Chrome storage and survives browser restarts
- **Zero dependencies** — no npm packages, no build step, pure vanilla JavaScript

## Installation

### From Source (Developer Mode)

```bash
git clone https://github.com/Lemelson/xporter.git
```

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked** and select the cloned `xporter/` directory
4. Navigate to [x.com](https://x.com) and log in
5. Click the XPorter icon in the toolbar

## How It Works

XPorter leverages your existing authenticated X session to access X's internal GraphQL API. No API keys, no OAuth flow — it piggybacks on the cookies you already have.

```
Popup UI ──▶ Service Worker ──▶ X GraphQL API ──▶ CSV File
                  │
            Chrome Storage
            (incremental saves)
                  │
Content Script ── detects username from active tab
```

**Export flow:**

1. **Content script** detects the currently viewed profile from the X tab URL
2. **Popup** collects the target username and export settings
3. **Service worker** resolves the username to a user ID via `UserByScreenName`, then fetches tweets in paginated batches via `UserTweets`
4. Tweets are saved incrementally to Chrome local storage (batches of 50)
5. On completion (or manual download), tweets are compiled into a UTF-8 CSV with BOM for Excel compatibility

**Endpoint discovery:**

X periodically rotates its GraphQL `queryId` values. XPorter handles this by:
1. Fetching the X main page HTML
2. Scanning linked JS bundles for `queryId` + `operationName` patterns
3. Caching discovered IDs for 30 minutes
4. Falling back to hardcoded IDs if discovery fails
5. Automatically re-discovering on `STALE_QUERY_ID` (HTTP 400) errors

**Rate limiting:**
- Configurable batch size (default: 20 requests)
- Configurable cooldown between batches (default: 3 minutes)
- Exponential backoff on 429 responses
- Automatic retry with fresh endpoints on stale query errors

## CSV Output

Each row in the exported CSV contains:

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

## Configuration

All settings are persisted in Chrome storage and synced between the popup and export page.

| Setting | Default | Description |
|---|---|---|
| Include retweets | On | Export retweets alongside original posts |
| Include replies | On | Export replies alongside original posts |
| Quantity limit | 500 | Maximum posts per export (0 = unlimited) |
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
xporter/
├── manifest.json             # Manifest V3 configuration
├── background/
│   └── service-worker.js     # Export engine, message router, state machine
├── content/
│   └── content.js            # Username detection from active X tab
├── popup/
│   ├── popup.html            # Extension popup markup
│   ├── popup.css             # Glassmorphism styles (dark + light)
│   ├── popup.js              # UI logic, settings, export controls
│   └── i18n.js               # Translation strings for 14 languages
├── export/
│   ├── export.html           # Full-page export interface
│   ├── export.css            # Export page styles
│   └── export.js             # Export page logic
├── utils/
│   ├── api.js                # X GraphQL client, endpoint discovery
│   ├── rateLimit.js          # Batch rate limiter with cooldowns
│   ├── csv.js                # CSV generation (BOM, escaping)
│   └── storage.js            # Chrome storage abstraction
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Design Decisions

- **Manifest V3** — service workers instead of persistent background pages
- **No bundler** — load directly from source; no webpack, no Vite
- **No npm dependencies** — the entire extension is vanilla JS
- **Incremental persistence** — tweets are saved in batches of 50 to prevent data loss on service worker termination
- **BOM-prefixed CSV** — ensures correct Unicode rendering in Excel

## Privacy

- No data leaves your browser
- No analytics, telemetry, or tracking
- No external server communication
- Authentication uses your existing X session cookies — XPorter never stores or transmits credentials

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/Lemelson/xporter/issues) for bugs or feature requests, or submit a pull request directly.

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
