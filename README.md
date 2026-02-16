<p align="center">
  <img src="icons/icon128.png" alt="XPorter Logo" width="80" />
</p>

<h1 align="center">XPorter</h1>

<p align="center">
  <strong>Free & unlimited export of X (Twitter) posts to CSV</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#csv-fields">CSV Fields</a> •
  <a href="#settings">Settings</a> •
  <a href="#languages">Languages</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#license">License</a>
</p>

---

## ✨ Features

- **🆓 Completely free** — no subscriptions, no trials, no limits
- **📊 All engagement metrics** — views, likes, retweets, replies, quotes, bookmarks
- **📅 Date range filtering** — export posts from a specific time period
- **⏸️ Pause & resume** — stop mid-export and continue later, no data loss
- **🔄 Auto-resume & smart rate limiting** — handles X's API limits automatically with configurable cooldown
- **🔒 100% local processing** — your data never leaves your browser. No external servers.
- **🌗 Dark & Light themes** — beautiful glassmorphism UI with theme toggle
- **🌍 14 languages** — auto-detects your Chrome language on first launch
- **📋 Clean CSV output** — properly escaped, UTF-8 with BOM for Excel compatibility
- **🔗 Smart username detection** — paste a URL, type `@username`, or let it auto-detect from the active tab
- **🧠 Dynamic API discovery** — automatically extracts fresh GraphQL query IDs from X's JS bundles, with hardcoded fallbacks
- **💾 Crash-resilient** — export progress is saved to Chrome storage; survives browser restarts

## 📸 Screenshots

<p align="center">
  <em>Dark mode — Home tab</em>
</p>

> 📷 *Screenshots coming soon — contributions welcome!*

## 📦 Installation

### From Source (Developer Mode)

1. **Clone this repository:**
   ```bash
   git clone https://github.com/Lemelson/xporter.git
   ```

2. **Open Chrome** and navigate to `chrome://extensions/`

3. **Enable Developer Mode** (toggle in the top-right corner)

4. **Click "Load unpacked"** and select the cloned `xporter` folder

5. **Navigate to [x.com](https://x.com)** and log in to your account

6. **Click the XPorter icon** in your browser toolbar to start exporting!

## 🔧 How It Works

XPorter uses your existing, authenticated X (Twitter) browser session to fetch public data through X's internal GraphQL API. Here's the flow:

```
┌──────────┐     ┌───────────────┐     ┌──────────────┐     ┌───────┐
│  Popup   │────▶│ Service Worker│────▶│ X GraphQL API│────▶│  CSV  │
│   UI     │◀────│  (Background) │◀────│ (your session│◀────│ File  │
└──────────┘     └───────────────┘     └──────────────┘     └───────┘
      │                 │
      │          ┌──────┴──────┐
      │          │ Chrome      │
      │          │ Storage     │
      │          │ (progress)  │
      │          └─────────────┘
      │
┌─────┴─────┐
│  Content  │  ← Detects username from active X tab
│  Script   │
└───────────┘
```

1. **Content Script** runs on x.com pages and detects the currently viewed profile username
2. **Popup UI** lets you enter a username, configure settings, and start the export
3. **Service Worker** orchestrates the export loop:
   - Resolves the username to a user ID via `UserByScreenName` GraphQL endpoint
   - Fetches tweets in batches via `UserTweets` GraphQL endpoint
   - Handles pagination, rate limiting, cooldowns, and retries
   - Saves tweet batches to Chrome's local storage incrementally
4. **CSV Generator** compiles all saved batches into a properly formatted CSV file
5. **Dynamic Endpoint Discovery** — on each session, XPorter fetches X's JavaScript bundles and extracts the current `queryId` values, so the extension keeps working even when X rotates their API

### Rate Limiting Strategy

X's API enforces rate limits. XPorter handles this gracefully:

- **Configurable batch size** (default: 20 requests per batch)
- **Configurable cooldown** (default: 3 minutes between batches)
- **Automatic retry** on 429 (rate limited) responses with exponential backoff
- **Auto-recovery** from `STALE_QUERY_ID` errors by re-discovering GraphQL endpoints

## 📋 CSV Fields

Each exported post includes the following columns:

| Field | Description |
|-------|-------------|
| `id` | Unique tweet ID |
| `text` | Full text content (including long-form notes) |
| `tweet_url` | Direct link to the post |
| `language` | Language code (e.g., `en`, `ru`) |
| `type` | `tweet`, `retweet`, `reply`, or `quote` |
| `author_name` | Display name |
| `author_username` | @handle |
| `view_count` | Number of views |
| `bookmark_count` | Number of bookmarks |
| `favorite_count` | Number of likes |
| `retweet_count` | Number of retweets |
| `reply_count` | Number of replies |
| `quote_count` | Number of quote tweets |
| `created_at` | Post creation timestamp |
| `source` | Posting client (e.g., "Twitter Web App") |
| `hashtags` | Comma-separated hashtags |
| `urls` | Comma-separated expanded URLs |
| `media_type` | `photo`, `video`, `animated_gif`, or empty |
| `media_urls` | Direct media URLs (highest quality video) |

## ⚙️ Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Include retweets | ✅ On | Include retweets in export |
| Include replies | ✅ On | Include replies in export |
| Quantity limit | 500 | Max posts to export (0 = unlimited). Preset options: 100, 500, 1K, 5K, 10K, or custom |
| Cooldown duration | 3 min | Pause duration between request batches |
| Cooldown batch size | 20 | Number of API requests before cooldown |

## 🌍 Languages

XPorter auto-detects your Chrome browser language on first launch. You can switch languages anytime from the header dropdown. Supported languages:

| Language | Code |
|----------|------|
| 🇺🇸 English | `en` |
| 🇪🇸 Español | `es` |
| 🇧🇷 Português | `pt` |
| 🇮🇳 हिन्दी | `hi` |
| 🇨🇳 中文 | `zh` |
| 🇷🇺 Русский | `ru` |
| 🇸🇦 العربية | `ar` |
| 🇫🇷 Français | `fr` |
| 🇩🇪 Deutsch | `de` |
| 🇯🇵 日本語 | `ja` |
| 🇰🇷 한국어 | `ko` |
| 🇹🇷 Türkçe | `tr` |
| 🇮🇩 Bahasa Indonesia | `id` |
| 🇮🇹 Italiano | `it` |

## 🏗️ Architecture

```
xporter/
├── manifest.json          # Chrome extension manifest (Manifest V3)
├── background/
│   └── service-worker.js  # Export engine, message handling, state management
├── content/
│   └── content.js         # Username detection from active X tab
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Glassmorphism styles, dark/light themes
│   ├── popup.js           # Popup logic, settings, export controls
│   └── i18n.js            # Translations for 14 languages
├── export/
│   ├── export.html        # Full-page export view
│   ├── export.css          # Export page styles
│   └── export.js          # Export page logic
├── utils/
│   ├── api.js             # X GraphQL API integration, dynamic endpoint discovery
│   ├── rateLimit.js       # Smart rate limiting with cooldowns
│   ├── csv.js             # CSV generation with Unicode BOM
│   └── storage.js         # Chrome storage helpers for crash resilience
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Key Technical Decisions

- **Manifest V3** — uses background service workers (not persistent background pages)
- **No external dependencies** — zero npm packages, pure vanilla JS
- **No build step** — load directly from source, no webpack/vite needed
- **Dynamic GraphQL discovery** — parses X's JS bundles at runtime to extract fresh `queryId` values
- **Incremental storage** — tweets are saved in batches of 50 to Chrome's local storage, preventing data loss
- **BOM-prefixed CSV** — ensures correct Unicode rendering in Microsoft Excel

## 🔒 Privacy

- **No data collection** — XPorter does not collect, transmit, or store any user data externally
- **No analytics** — no tracking, no telemetry
- **No external servers** — all processing happens locally in your browser
- **Session-based** — uses your existing X login session; does not store credentials

## 🤝 Contributing

Contributions are welcome! Feel free to:

- 🐛 Report bugs via [Issues](https://github.com/Lemelson/xporter/issues)
- 💡 Suggest features
- 🌐 Improve translations
- 🔧 Submit pull requests

## 📬 Contact

- **Telegram:** [@lemelson](https://t.me/lemelson)
- **GitHub:** [@Lemelson](https://github.com/Lemelson)

## ⚠️ Disclaimer

This extension is **not affiliated with, endorsed by, or connected to X Corp.** (formerly Twitter, Inc.). It is an independent, open-source tool that uses public browser APIs and your own authenticated session to export your data. Use responsibly and in accordance with X's Terms of Service.

## 📄 License

This project is licensed under the **MIT License with Commons Clause** — see the [LICENSE](LICENSE) file for details.

**In short:**
- ✅ Free to use, modify, and share
- ✅ Free to fork and create non-commercial derivatives
- ❌ Cannot be sold or used to create paid/subscription products
- ❌ Cannot be published on Chrome Web Store or similar marketplaces as a competing product

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/Lemelson">Lemelson</a>
</p>
