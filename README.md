<p align="center">
  <img src="icons/icon128.png" alt="XPorter" width="80" />
</p>

<h1 align="center">XPorter</h1>

<p align="center">
  Free export of X (Twitter) posts, bookmarks, followers, and following to CSV, JSON, XLSX, or AI-friendly TXT.<br/>
  A Chrome extension with no subscription or export backend; export processing stays in your browser.
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
- **Multiple export modes** — posts, personal bookmarks, followers, following, and verified followers
- **CSV, JSON, XLSX, and post-row TXT output** — posts and bookmarks can use the AI-friendly TXT or copy it straight to your clipboard
- **Complete post-export profile context** — TXT and XLSX start with the target account's name, handle, bio, profile location, website, join date, public “About this account” country, Premium status/history, connection source, and username-change history when X provides them
- **Optional detailed audience metadata** — an off-by-default user-list setting can add each exported account's public “About this Account” fields through a paced, cached per-user queue
- **Date range filtering** — export posts from a specific time window
- **Transparent quantity controls** — Unlimited requests every item X makes accessible; X's upstream timeline limits still apply
- **Pause and resume** — stop mid-export and continue later with zero data loss
- **Smart rate limiting** — separate six-mode speed controls for posts and user lists, plus live quota-aware pauses and retries
- **Local export processing** — exported X content is processed and saved in your browser, never uploaded to an XPorter backend
- **Dark and light themes** — glassmorphism UI with a one-click toggle
- **14 languages** — auto-detects Chrome's UI language on first launch
- **Dynamic API discovery** — extracts fresh GraphQL query IDs from X's JS bundles at runtime; gracefully falls back to hardcoded IDs
- **Crash-resilient** — export progress is persisted to Chrome storage and survives browser restarts
- **No install-time dependencies** — no npm packages or build step; the extension ships as browser-ready JavaScript

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
Popup UI ──▶ Service Worker ──▶ X APIs ──▶ CSV / JSON / XLSX / TXT File
                  │
            Chrome Storage
            (incremental saves)
                  │
Content Script ── detects username from active tab
               └─ records posts already loaded by X into local IndexedDB
```

**Export flow:**

1. **Content script** detects the currently viewed profile from the X tab URL
2. **Popup** collects the target username and export settings. Bookmarks is viewer-owned, so that mode replaces the username field with the signed-in account's avatar, display name, handle, and a “Your account” badge
3. **Service worker** resolves profile modes through `UserByScreenName`; Bookmarks instead opens `https://x.com/i/bookmarks` and paginates the signed-in viewer's `Bookmarks` timeline without accepting a profile username
4. Items are saved incrementally to Chrome local storage (batches of 50)
5. On completion (or manual download), items are compiled locally into CSV, JSON, XLSX, or post-row TXT. Each numbered profile row is one post by the exported profile; each bookmark row is one post explicitly saved by the current account. When the Replies feed includes the foreign post that a profile reply answered, XPorter attaches that post and any quote inside it as context without increasing the post count. JSON keeps this context nested; CSV/XLSX use clearly prefixed context columns; TXT shows it under the matching reply. Large exports automatically download as safe, numbered parts.

While you browse X, the page hook also extracts non-reply posts from timeline responses X has already loaded. They are deduplicated by post ID in a local IndexedDB database; repeat sightings update metrics and exposure count instead of adding rows. The Settings tab can export this dataset as CSV/JSON or clear it. Collection is capped at the 50,000 most recently seen unique posts.

**Endpoint discovery:**

X periodically rotates its GraphQL `queryId` values. XPorter handles this by:
1. Reusing a privacy-filtered request shape after X successfully makes the same native request
2. Fetching the X main page and scanning linked JS bundles when a fresh request shape is unavailable
3. Caching discovered IDs for 24 hours (stale IDs self-heal on failure)
4. Falling back to known IDs only after live capture and discovery candidates are exhausted
5. Automatically retrying discovery on stale-request failures

**Rate limiting:**
- Five named speed presets target roughly 2 / 3 / 4 / 7 / 12 seconds between requests; Standard (~4 s) is the default
- A Custom mode exposes the request delay, batch size, and longer batch cooldown
- Valid `x-rate-limit-*` headers always take priority so XPorter stops at the live quota instead of overrunning it
- Missing headers use conservative mode-specific fallback delays; 429s and network timeouts retry automatically
- Stale GraphQL query IDs trigger live capture or endpoint re-discovery before the export fails

## Export Output

Post and bookmark exports include:

TXT and XLSX profile-post files begin with a profile block. Bookmark files use
`BOOKMARKS (N)` instead because saved posts may belong to many authors. Optional values are omitted
when X does not return them. The block can include display name, handle, profile
URL, bio, professional category, self-entered location, website, join date,
`Account based in`, Premium status and start date, connection source, affiliated
account, username-change count and last-change date, account counters, and avatar.
The `Account based in` value is X's separate public transparency field; it is not
the free-form location written in the profile.

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
| `reply_to_id` / `reply_to_username` / `conversation_id` | Direct reply relationship |
| `reply_to_post_*` | The available post that this reply answered: type, author, text, date, URL, and media |
| `reply_to_quoted_post_*` | A quoted post nested inside the replied-to post |
| `quoted_post_*` | A quoted post nested directly inside the exported profile post |

JSON keeps `reply_to_post` and `quoted_post` as nested objects. Context never
counts as another exported profile post, so a limit of 100 still produces at
most 100 primary rows.

For saved replies, Bookmarks can additionally retrieve the replied-to post in
ID batches and attach it to the same bookmark row. Deleted, private, blocked, or
otherwise unavailable posts remain represented only by their reply ID/URL.
Articles retain the title, URL, and all plain text returned by X, including
Articles nested inside quoted or replied-to posts; some Articles expose only a
preview.

Media URLs are always exported. When photo embedding is enabled for an XLSX
export, XPorter downloads the available `pbs.twimg.com` photos locally and adds
a separate **Media** sheet. Each image row identifies the primary export row,
the post that owns the image, its relationship (`post`, `quoted_post`,
`reply_to_post`, or nested quote), and the original URL. Multiple photos remain
separate rows. Videos and animated GIFs remain links rather than embedded
binary media.

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

Follower/following rows intentionally use the fields returned by X's paginated
user-list endpoint by default. The optional **Include “About this Account”
details** setting adds the following columns:

| Optional field | Description |
|---|---|
| `account_based_in` | X-inferred public account country or region |
| `account_location_accurate` | Accuracy flag returned by X |
| `premium_since` | Premium start timestamp when X provides a usable value |
| `account_source` | `Connected via` value, such as Web or a regional App Store |
| `affiliate_username` | Affiliated account handle when present |
| `username_change_count` | Number of username changes |
| `username_last_changed_at` | Last username-change timestamp |

This detailed mode requires up to one additional request per exported user
(for example, 10,000 extra requests for 10,000 followers). It is therefore off
by default, uses its own paced request queue, and caches successful results
locally for seven days. Its separate concurrency control runs 1 (Turtle), 3
(Careful), 5 (Standard), 10 (Fast), or 20 (Turbo) account requests at once;
Custom accepts 1–50. Excel's normal header filters can then filter the exported
`Account based in` column. The setting enriches the collected rows; it does not
exclude users before the file is created.

## Configuration

All settings are persisted in Chrome storage and reused across popup sessions.

| Setting | Default | Description |
|---|---|---|
| Include retweets | On | Export retweets alongside original posts |
| Include replies | Off | Uses the profile's combined Posts + Replies feed regardless of which X profile tab is open. Available foreign parent/quote posts are saved as context, not extra rows. If X changes that feed, XPorter stops and offers an explicit Posts-only continuation instead of silently omitting replies |
| Include articles | On | Export X Articles alongside ordinary posts |
| Export mode | Posts | Data type to export: posts, personal bookmarks, followers, following, or verified followers. Bookmarks always uses the current signed-in X account and opens its personal bookmarks page |
| Output format | CSV | File format: CSV, JSON, XLSX, or AI-friendly TXT for posts and bookmarks |
| Quantity limit | 500 | Maximum posts or users per export (0 = unlimited) |
| Posts & Bookmarks Export Speed | Standard | Turbo, Fast, Standard, Careful, Turtle, or Custom pacing for posts and bookmarks |
| Embed photos in XLSX (Posts) | Off | Downloads available post, quote, and reply-context photos from X's media CDN while saving XLSX and places them on a mapped Media sheet; slower and produces larger files |
| Include replied-to posts (Bookmarks) | On | Retrieves the available parent of each saved reply in ID batches and stores it as context without increasing the bookmark count |
| Include Article text (Bookmarks) | On | Keeps titles, URLs, and all Article text returned by X, including nested quoted/reply context |
| Embed photos in XLSX (Bookmarks) | Off | Same mapped Media-sheet behavior for saved posts; slower and produces larger files |
| User Lists Export Speed | Standard | Independent pacing for followers, following, and verified followers |
| Include “About this Account” details | Off | Adds seven public account-transparency fields to user-list rows through up to one extra request per user; use small quantities and a slower speed |
| About Details Speed | Standard (5) | Concurrent About requests per paced batch: Turtle 1, Careful 3, Standard 5, Fast 10, Turbo 20, or Custom 1–50 |
| About Details Retry Limit | 5 | Maximum retries for a transient per-account details request; changing it requires the same five-second acknowledgement |
| Custom pacing | 5 s / 20 / 3 min | Separate delay, requests per batch, and batch pause values for posts and user lists |
| Auto-clear old exports | On / 4 hours | Removes old downloadable payloads while keeping history metadata |
| Localize column titles | On | Translate CSV/XLSX headers; JSON keys always remain English |

CSV/XLSX keep the complete field model, including rare reply, quote, Article,
media, and account context. Each generated file or numbered part includes only
columns that contain at least one value in that file, so short exports do not
open with dozens of empty columns. JSON keeps the same nested relationships but
omits empty strings, `null`, empty objects, and empty arrays. Real `0` and
`false` values are preserved in every format. TXT already emits only populated
sections. The positive actions in the separate detailed-account risk dialog
use a five-second guard.

Speed changes made while an export is running take effect safely on the next
request or detailed-account batch. The in-flight request finishes normally and
the limiter keeps its counters. Data-shape settings such as Replies, Retweets,
and detailed columns remain fixed until a new export so one file never mixes
different row formats.

The Replies default applies to fresh installs and missing settings only. Updates preserve an existing user's saved choice; the 1.5.1 recovery path protects those exports without silently changing their preference.

Preset quantity options: 100, 500, 1,000, unlimited, or a custom value. For Posts, X typically exposes only about 3,200 of the most recent items even when a profile shows more; XPorter cannot bypass that upstream availability limit.

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
├── AGENTS.md                 # Repository, verification, and publication policy
├── agent.md / CLAUDE.md      # Detailed and quick developer/AI context
├── THIRD_PARTY_NOTICES       # Notices for adapted third-party source
├── background/
│   ├── service-worker.js     # Export engine, message router, state machine
│   ├── downloads.js          # File serialization + Chrome download handoff
│   └── uninstall-feedback.js # Anonymous uninstall-summary URL
├── content/
│   ├── feed-parser.js        # Extracts compact non-reply post rows from page responses
│   ├── content.js            # Username detection from the active X tab
│   └── interceptor.js        # Page hook for successful native GraphQL request templates + seen-post capture
├── popup/                    # Compact popup UI
│   ├── popup.html/.css/.js   # Markup, glassmorphism styles (dark + light), logic
│   ├── theme-init.js/theme.js# Theme bootstrap (anti-FOUC) + toggle
│   ├── i18n.js               # In-app translation engine
│   ├── rate-prompt.js/.css   # "Rate XPorter" prompt
│   ├── history.js            # Export-history UI
│   ├── seen-posts.js         # Passive seen-post dataset UI
│   ├── acknowledgement-timer.js # Accessible guarded-action countdown
│   ├── ladybug.js            # Easter-egg ladybug on the About tab
│   └── locales/*.json        # UI strings for 14 languages (en = fallback)
├── utils/
│   ├── api.js                # X GraphQL client, endpoint discovery
│   ├── api-parsers.js        # Pure X response parsers
│   ├── api-features.js       # GraphQL feature-flag constants
│   ├── native-request-template.js # Strict privacy-safe validator for captured request shapes
│   ├── transaction-id.js     # Local X client-transaction-id generation for protected feeds
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
├── test-lab/                 # Offline production-code export checks (not shipped)
└── scripts/                  # Dev/debug scripts + CWS packaging (not shipped)
```

### Design Decisions

- **Manifest V3** — service workers instead of persistent background pages
- **No bundler** — load directly from source; no webpack, no Vite
- **No npm dependencies** — no package installation is required; adapted third-party source is disclosed in `THIRD_PARTY_NOTICES`
- **Incremental persistence** — export items are saved in batches of 50 to prevent data loss on service worker termination
- **BOM-prefixed CSV** — ensures correct Unicode rendering in Excel

## Privacy

- All exported data stays local — your X data never leaves your browser
- The seen-post dataset is stored only in local IndexedDB and can be exported or cleared from Settings
- No third-party analytics, advertising, or tracking SDKs
- No export backend; normal export traffic goes only to X-owned `x.com` APIs and the public `abs.twimg.com` client-asset CDN. The CDN receives no cookies, auth headers, usernames, or export data
- The one-time target-profile lookup reads the same public “About this account” metadata visible on X. X may omit individual fields, and X's inferred account country is not the same as a user-written profile location
- Authentication uses your existing X session cookies — XPorter never stores or transmits credentials
- **One exception:** when you uninstall XPorter, an anonymous usage summary (no X data, no usernames, nothing that identifies you) is sent once to help improve the extension — see the [privacy policy](privacy-policy.html) for exactly what it contains

## Versioning

`manifest.json` is the source of truth for the current build number. A release
must update the manifest, the popup footer date, and the localized three-entry
“Last updates” history together. Historical audit files keep the version they
actually verified and are not renamed when a newer build is created.

## Testing Changes

After changing API requests, parsers, posts/replies, user lists, or export
formatting, test the production code through the Offline Test Lab first. This
does not require Computer Use, manual clicking, an authenticated browser, or
internet access:

```bash
node --test test-lab/tests/offline-lab.test.js
node test-lab/run.js --sample 5 --seed local-check
```

The second command selects five reproducible profiles from a pool of twenty and
generates inspectable CSV, JSON, XLSX, and TXT files under
`test-lab/output/`. Use `--all --seed full` after larger algorithm changes.
The lab reads the current production files directly, so it automatically tests
new code rather than a copied test implementation. See
[`test-lab/README.md`](test-lab/README.md) for details.

Use an unpacked-browser/live-X smoke test only for what the offline lab cannot
prove: current private X endpoints and response shapes, authentication,
permissions, content-script/DOM wiring, and popup behavior.

The complete deterministic release gate is:

```bash
node scripts/test-static-contracts.js
node scripts/test-extension-core.js
node scripts/test-rate-limit.js
node scripts/test-feed-capture.js
node scripts/test-tooling-policy.js
bash scripts/package.sh
```

On sandboxed macOS, use `node scripts/soffice-headless.js …` for manual XLSX
compatibility checks. Run `node scripts/test-extension-smoke.mjs` only outside
`CODEX_SANDBOX`; it launches a browser app and intentionally refuses the unsafe
sandboxed path.

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/Lemelson/xporter-extension/issues) for bugs or feature requests, or submit a pull request directly.

## Contact

- Telegram: [@lemelson](https://t.me/lemelson)
- GitHub: [@Lemelson](https://github.com/Lemelson)

## Disclaimer

This project is not affiliated with, endorsed by, or connected to X Corp. It is an independent tool that uses your own authenticated browser session to export data available to that signed-in account. Use it in accordance with applicable terms of service and the rights of the people whose data you export.

## License

Licensed under the **MIT License with Commons Clause**.

You are free to use, modify, and redistribute this software at no cost. You may not sell it, offer it as a paid service, or publish paid derivatives on browser extension marketplaces.

See [LICENSE](LICENSE) for full terms.
Adapted third-party source is listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

---

<p align="center">
  Built by <a href="https://github.com/Lemelson">Lemelson</a>
</p>
