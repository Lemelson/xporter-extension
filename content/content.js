// XPorter — Content Script
// Detects the current X/Twitter username from the page URL
// Runs on x.com and twitter.com pages at document_start (document.body
// does not exist yet — never touch it at top level).

const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'intent', 'account', 'login',
    'logout', 'signup', 'tos', 'privacy', 'about', 'help',
    'hashtag', 'lists', 'communities', 'premium', 'jobs',
    'who_to_follow', 'trending', 'bookmarks', 'topics',
    'display', 'download', 'follower_requests'
]);

function extractUsername() {
    const path = window.location.pathname;

    // Match /username or /username/anything
    const match = path.match(/^\/([a-zA-Z0-9_]{1,15})(\/|$)/);

    if (!match) return null;

    const potentialUsername = match[1].toLowerCase();

    // Skip reserved paths
    if (RESERVED_PATHS.has(potentialUsername)) return null;

    return match[1]; // Return original case
}

function sendUsername(username) {
    if (username) {
        // Guard: chrome.runtime may be undefined after extension update/reload
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'SET_USERNAME',
            username: username
        }).catch(() => {
            // Extension context may not be available
        });
    }
}

// Detect on initial page load
const initialUsername = extractUsername();
if (initialUsername) {
    sendUsername(initialUsername);
}

// Detect on SPA navigation (X is a single-page app)
let lastUrl = window.location.href;

// Use MutationObserver to detect URL changes in SPA.
// We run at document_start, where document.body is still null —
// observe document.documentElement instead (it exists at document_start),
// and fall back to DOMContentLoaded just in case.
const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        const username = extractUsername();
        sendUsername(username);
    }
});

function startUrlObserver() {
    const root = document.documentElement || document.body;
    if (!root) return false;
    observer.observe(root, {
        childList: true,
        subtree: true
    });
    return true;
}

if (!startUrlObserver()) {
    document.addEventListener('DOMContentLoaded', startUrlObserver, { once: true });
}

// Also listen for popstate events (back/forward navigation)
window.addEventListener('popstate', () => {
    const username = extractUsername();
    sendUsername(username);
});

// ==================== GraphQL QueryId Discovery via Fetch Interception ====================
// X.com makes GraphQL requests with the correct queryIds.
// content/interceptor.js (registered in manifest.json in the MAIN world at
// document_start) intercepts these in the page context and forwards them to
// us via window.postMessage; we relay them to the service worker so the
// extension always has up-to-date queryIds without fragile JS-bundle scanning.
// This listener must attach at document_start so early captures are not lost.

// Must mirror TRACKED in content/interceptor.js — anything else is dropped.
const RELAY_TRACKED_OPERATIONS = new Set([
    'Followers', 'Following', 'BlueVerifiedFollowers',
    'UserTweets', 'UserByScreenName', 'SearchTimeline'
]);
const RELAY_QUERYID_PATTERN = /^[A-Za-z0-9_-]{10,40}$/;
const RELAY_MAX_BODY_CHARS = 8 * 1024 * 1024; // must match interceptor.js
const RELAY_MAX_SEEN_POSTS = 250;
const RELAY_POST_ID_PATTERN = /^\d{5,30}$/;
const RELAY_POST_OPERATION_PATTERN = /(Timeline|Tweets|TweetDetail|Bookmarks|Likes|Community|ListLatest|UserMedia)/i;

function sanitizeSeenPost(post) {
    const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
    const count = (value) => {
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
    };
    return {
        id: String(post.id),
        text: text(post.text, 25000),
        tweet_url: text(post.tweet_url, 300),
        language: text(post.language, 16),
        created_at: text(post.created_at, 80),
        author_id: text(post.author_id, 32),
        author_name: text(post.author_name, 200),
        author_username: text(post.author_username, 40),
        author_followers_count: count(post.author_followers_count),
        author_verified: post.author_verified === true,
        view_count: count(post.view_count),
        bookmark_count: count(post.bookmark_count),
        favorite_count: count(post.favorite_count),
        retweet_count: count(post.retweet_count),
        reply_count: count(post.reply_count),
        quote_count: count(post.quote_count),
        is_quote: post.is_quote === true,
        is_retweet: post.is_retweet === true,
        media_count: count(post.media_count),
        media_types: text(post.media_types, 80)
    };
}

// Listen for messages from the MAIN-world interceptor
window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__XPORTER_QUERYID__') {
        // Strict validation before relaying to the SW (defense in depth —
        // any page script can postMessage; drop anything unexpected silently).
        const { queryId, operationName } = event.data;
        if (typeof operationName !== 'string' || !RELAY_TRACKED_OPERATIONS.has(operationName)) return;
        if (typeof queryId !== 'string' || !RELAY_QUERYID_PATTERN.test(queryId)) return;
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'DISCOVERED_QUERYID',
            queryId: queryId,
            operationName: operationName
        }).catch(() => { });
    }
    if (event.data?.type === '__XPORTER_GRAPHQL_RESPONSE__') {
        const { operationName, bodyText } = event.data;
        if (typeof operationName !== 'string' || !RELAY_TRACKED_OPERATIONS.has(operationName)) return;
        // Cap relayed body size — oversized payloads are dropped, not truncated.
        if (typeof bodyText !== 'string' || bodyText.length > RELAY_MAX_BODY_CHARS) return;
        const status = Number(event.data.status);
        if (!Number.isInteger(status) || status < 100 || status > 599) return;
        if (typeof event.data.url !== 'string' || !event.data.url.includes('/i/api/graphql/')) return;
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'PAGE_GRAPHQL_RESPONSE',
            operationName: operationName,
            url: event.data.url,
            status: status,
            bodyText: bodyText
        }).catch(() => { });
    }
    if (event.data?.type === '__XPORTER_SEEN_POSTS__') {
        const { operationName, posts } = event.data;
        if (typeof operationName !== 'string' ||
            !/^[A-Za-z0-9_]{1,80}$/.test(operationName) ||
            !RELAY_POST_OPERATION_PATTERN.test(operationName)) return;
        if (!Array.isArray(posts) || posts.length === 0 || posts.length > RELAY_MAX_SEEN_POSTS) return;
        if (!posts.every(post => (
            post && typeof post === 'object' &&
            RELAY_POST_ID_PATTERN.test(String(post.id || '')) &&
            typeof post.text === 'string' &&
            post.text.length <= 25000
        ))) return;
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'CAPTURE_FEED_POSTS',
            operationName,
            posts: posts.map(sanitizeSeenPost)
        }).catch(() => { });
    }
});

function ensureXporterCaptureOverlay() {
    let overlay = document.getElementById('xporter-capture-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'xporter-capture-overlay';
    overlay.innerHTML = `
        <button class="xporter-capture-toggle" type="button" aria-label="Collapse XPorter status">−</button>
        <div class="xporter-capture-title">XPorter date range export</div>
        <div class="xporter-capture-subtitle" data-xporter-subtitle>Preparing search page...</div>
        <div class="xporter-capture-bar"><span data-xporter-bar></span></div>
        <div class="xporter-capture-meta">
            <span data-xporter-count>0 posts collected</span>
            <span class="xporter-capture-meta-right">
                <span class="xporter-capture-pct" data-xporter-pct></span>
                <span class="xporter-capture-range" data-xporter-range></span>
            </span>
        </div>
        <div class="xporter-capture-limit" data-xporter-limit>No post limit</div>
        <div class="xporter-capture-note">Keep this tab open. XPorter is scrolling it to collect posts.</div>
        <button class="xporter-capture-stop" type="button" data-xporter-stop>Stop export</button>
    `;

    const style = document.createElement('style');
    style.id = 'xporter-capture-overlay-style';
    style.textContent = `
        #xporter-capture-overlay {
            position: fixed;
            left: 50%;
            top: 112px;
            z-index: 2147483647;
            box-sizing: border-box;
            width: min(560px, calc(100vw - 32px));
            transform: translateX(-50%);
            padding: 14px 16px;
            border: 1px solid rgba(96, 184, 255, 0.28);
            border-radius: 14px;
            background: linear-gradient(150deg, rgba(13, 21, 34, 0.97), rgba(28, 39, 69, 0.97));
            color: #fff;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            pointer-events: auto;
            transition: width 0.2s ease, top 0.2s ease, right 0.2s ease, bottom 0.2s ease, left 0.2s ease, transform 0.2s ease;
        }
        #xporter-capture-overlay .xporter-capture-toggle {
            position: absolute;
            top: 10px;
            right: 10px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border: 1px solid rgba(255, 255, 255, 0.24);
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.08);
            color: rgba(255, 255, 255, 0.9);
            cursor: pointer;
            font: inherit;
            font-size: 15px;
            line-height: 1;
        }
        #xporter-capture-overlay .xporter-capture-title {
            padding-right: 28px;
            font-size: 15px;
            font-weight: 750;
            line-height: 1.25;
        }
        #xporter-capture-overlay .xporter-capture-subtitle,
        #xporter-capture-overlay .xporter-capture-note,
        #xporter-capture-overlay .xporter-capture-limit {
            margin-top: 4px;
            color: rgba(255, 255, 255, 0.78);
            font-size: 12px;
            line-height: 1.35;
        }
        #xporter-capture-overlay .xporter-capture-bar {
            height: 7px;
            margin-top: 10px;
            overflow: hidden;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.16);
        }
        #xporter-capture-overlay .xporter-capture-bar span {
            display: block;
            width: 42%;
            height: 100%;
            border-radius: inherit;
            background: linear-gradient(90deg, #60B8FF, #00BA7C);
            animation: xporter-capture-bar-sweep 1.35s ease-in-out infinite alternate;
        }
        /* Determinate mode: real progress is known — freeze the sweep and
           show a width-driven fill instead. */
        #xporter-capture-overlay.xporter-capture-determinate .xporter-capture-bar span {
            animation: none;
            transform: none;
            transition: width 0.35s ease;
        }
        /* Paused on a rate limit: amber fill, no motion. */
        #xporter-capture-overlay.xporter-capture-paused .xporter-capture-bar span {
            animation: none;
            background: linear-gradient(90deg, #FFD400, #FFAD1F);
        }
        @keyframes xporter-capture-bar-sweep {
            from { transform: translateX(-75%); }
            to { transform: translateX(220%); }
        }
        #xporter-capture-overlay .xporter-capture-meta {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            margin-top: 8px;
            color: rgba(255, 255, 255, 0.88);
            font-size: 12px;
            font-weight: 650;
        }
        #xporter-capture-overlay .xporter-capture-meta-right {
            display: inline-flex;
            gap: 10px;
            align-items: baseline;
        }
        #xporter-capture-overlay .xporter-capture-pct {
            color: #7CD4A8;
            font-variant-numeric: tabular-nums;
        }
        #xporter-capture-overlay.xporter-capture-paused .xporter-capture-pct,
        #xporter-capture-overlay.xporter-capture-paused [data-xporter-subtitle] {
            color: #FFD400;
        }
        #xporter-capture-overlay .xporter-capture-stop {
            display: block;
            box-sizing: border-box;
            width: 100%;
            margin-top: 12px;
            padding: 8px 12px;
            border: 1px solid rgba(244, 33, 46, 0.55);
            border-radius: 9px;
            background: rgba(244, 33, 46, 0.14);
            color: #FF6B72;
            cursor: pointer;
            font: inherit;
            font-size: 13px;
            font-weight: 700;
            line-height: 1.2;
            transition: background 0.15s ease, color 0.15s ease;
        }
        #xporter-capture-overlay .xporter-capture-stop:hover {
            background: rgba(244, 33, 46, 0.28);
            color: #fff;
        }
        #xporter-capture-overlay .xporter-capture-stop:disabled {
            cursor: default;
            opacity: 0.6;
        }
        #xporter-capture-overlay.xporter-capture-collapsed {
            left: auto;
            top: auto;
            right: 22px;
            bottom: 88px;
            width: min(260px, calc(100vw - 32px));
            transform: none;
            padding: 12px 44px 12px 14px;
        }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-subtitle,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-bar,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-range,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-limit,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-note,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-stop {
            display: none;
        }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-title {
            padding-right: 0;
            font-size: 13px;
        }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-meta {
            margin-top: 4px;
        }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);

    overlay.querySelector('.xporter-capture-toggle').addEventListener('click', () => {
        const collapsed = overlay.classList.toggle('xporter-capture-collapsed');
        const button = overlay.querySelector('.xporter-capture-toggle');
        const i = overlay._xporterI18n || {};
        button.textContent = collapsed ? '+' : '−';
        button.setAttribute('aria-label', collapsed
            ? (i.expand || 'Expand XPorter status')
            : (i.collapse || 'Collapse XPorter status'));
    });

    overlay.querySelector('[data-xporter-stop]').addEventListener('click', (event) => {
        const button = event.currentTarget;
        const i = overlay._xporterI18n || {};
        button.disabled = true;
        button.textContent = i.stopping || 'Stopping…';
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({ type: 'STOP_EXPORT' }).catch(() => { });
        }
    });

    return overlay;
}

const CAPTURE_POST_LABELS = {
    en: {
        postsCollected: { one: 'post collected', other: 'posts collected' },
        postsUnit: { one: 'post', other: 'posts' }
    },
    ru: {
        postsCollected: { one: 'пост собран', few: 'поста собрано', many: 'постов собрано', other: 'поста собрано' },
        postsUnit: { one: 'пост', few: 'поста', many: 'постов', other: 'поста' }
    },
    ar: {
        postsCollected: { zero: 'منشورات تم جمعها', one: 'منشور تم جمعه', two: 'منشوران تم جمعهما', few: 'منشورات تم جمعها', many: 'منشورًا تم جمعه', other: 'منشور تم جمعه' },
        postsUnit: { zero: 'منشورات', one: 'منشور', two: 'منشوران', few: 'منشورات', many: 'منشورًا', other: 'منشور' }
    },
    de: {
        postsCollected: { one: 'Beitrag gesammelt', other: 'Beiträge gesammelt' },
        postsUnit: { one: 'Beitrag', other: 'Beiträge' }
    },
    es: {
        postsCollected: { one: 'publicación recopilada', other: 'publicaciones recopiladas' },
        postsUnit: { one: 'publicación', other: 'publicaciones' }
    },
    fr: {
        postsCollected: { one: 'publication collectée', other: 'publications collectées' },
        postsUnit: { one: 'publication', other: 'publications' }
    },
    it: {
        postsCollected: { one: 'post raccolto', other: 'post raccolti' },
        postsUnit: { one: 'post', other: 'post' }
    },
    pt: {
        postsCollected: { one: 'publicação coletada', other: 'publicações coletadas' },
        postsUnit: { one: 'publicação', other: 'publicações' }
    },
    tr: {
        postsCollected: { other: 'gönderi toplandı' },
        postsUnit: { other: 'gönderi' }
    },
    id: {
        postsCollected: { other: 'postingan terkumpul' },
        postsUnit: { other: 'postingan' }
    },
    hi: {
        postsCollected: { other: 'पोस्ट एकत्रित' },
        postsUnit: { other: 'पोस्ट' }
    },
    ja: {
        postsCollected: { other: '件のポスト取得済み' },
        postsUnit: { other: '件のポスト' }
    },
    ko: {
        postsCollected: { other: '개 게시물 수집됨' },
        postsUnit: { other: '개 게시물' }
    },
    zh: {
        postsCollected: { other: '条帖子已收集' },
        postsUnit: { other: '条帖子' }
    }
};

function capturePluralLabel(key, count, i) {
    const lang = String(i.lang || 'en').toLowerCase().split('-')[0];
    const forms = CAPTURE_POST_LABELS[lang]?.[key] || CAPTURE_POST_LABELS.en[key];
    let category = (Number(count) === 1) ? 'one' : 'other';
    try {
        category = new Intl.PluralRules(lang).select(Math.abs(Number(count) || 0));
    } catch (_) { /* keep simple fallback */ }
    return forms?.[category] || forms?.other || i[key] || i.posts || 'posts';
}

function updateXporterCaptureOverlay(status) {
    const overlay = ensureXporterCaptureOverlay();
    const i = status.i18n || {};
    overlay._xporterI18n = i;
    if (i.lang) overlay.setAttribute('lang', i.lang);
    if (i.dir) overlay.setAttribute('dir', i.dir);
    const count = Number(status.tweetCount || 0);
    const limit = Number(status.quantityLimit || 0);
    const range = [status.dateFrom, status.dateTo].filter(Boolean).join(' → ');
    const locale = i.lang || undefined;
    const postsWord = capturePluralLabel('postsUnit', limit, i);
    const limitText = limit > 0
        ? `${i.limitLabel || 'Limit:'} ${limit.toLocaleString(locale)} ${postsWord}`
        : (i.noLimit || 'No post limit');

    // Localize static labels once translations arrive.
    if (status.i18n) {
        const titleEl = overlay.querySelector('.xporter-capture-title');
        if (titleEl && i.title) titleEl.textContent = i.title;
        const noteEl = overlay.querySelector('.xporter-capture-note');
        if (noteEl && i.note) noteEl.textContent = i.note;
        const toggle = overlay.querySelector('.xporter-capture-toggle');
        if (toggle) {
            const collapsed = overlay.classList.contains('xporter-capture-collapsed');
            toggle.setAttribute('aria-label', collapsed
                ? (i.expand || 'Expand XPorter status')
                : (i.collapse || 'Collapse XPorter status'));
        }
    }

    overlay.querySelector('[data-xporter-count]').textContent =
        `${count.toLocaleString(locale)} ${capturePluralLabel('postsCollected', count, i)}`;
    overlay.querySelector('[data-xporter-range]').textContent = range;
    overlay.querySelector('[data-xporter-limit]').textContent = limitText;

    // Stop button label (unless a click already put it into "Stopping…").
    const stopBtn = overlay.querySelector('[data-xporter-stop]');
    if (stopBtn && !stopBtn.disabled) stopBtn.textContent = i.stop || 'Stop export';

    // Real progress when the SW can compute it (quantity limit and/or how far
    // back into the date range we've collected); sweeping bar otherwise.
    // NB: null must stay indeterminate — Number(null) is 0, so gate on != null.
    const pct = (status.progressPct != null) ? Number(status.progressPct) : NaN;
    const barFill = overlay.querySelector('[data-xporter-bar]');
    const pctEl = overlay.querySelector('[data-xporter-pct]');
    if (Number.isFinite(pct) && pct >= 0) {
        overlay.classList.add('xporter-capture-determinate');
        const clamped = Math.max(0, Math.min(100, pct));
        // Never a fully empty track while running — keep a visible sliver.
        if (barFill) barFill.style.width = Math.max(2, clamped) + '%';
        if (pctEl) pctEl.textContent = Math.round(clamped) + '%';
    } else {
        overlay.classList.remove('xporter-capture-determinate');
        if (barFill) barFill.style.width = '';
        if (pctEl) pctEl.textContent = '';
    }

    // Rate-limit pause: live countdown in the subtitle until `pauseUntil`.
    const subtitleEl = overlay.querySelector('[data-xporter-subtitle]');
    if (overlay._xporterPauseTicker) {
        clearInterval(overlay._xporterPauseTicker);
        overlay._xporterPauseTicker = null;
    }
    const pauseUntil = Number(status.pauseUntil);
    if (Number.isFinite(pauseUntil) && pauseUntil > Date.now()) {
        overlay.classList.add('xporter-capture-paused');
        const renderPause = () => {
            const remaining = Math.max(0, Math.ceil((pauseUntil - Date.now()) / 1000));
            subtitleEl.textContent = `${i.rateLimited || 'X rate limit — retrying in'} ` +
                `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
            if (remaining <= 0 && overlay._xporterPauseTicker) {
                clearInterval(overlay._xporterPauseTicker);
                overlay._xporterPauseTicker = null;
            }
        };
        renderPause();
        overlay._xporterPauseTicker = setInterval(renderPause, 1000);
    } else {
        overlay.classList.remove('xporter-capture-paused');
        subtitleEl.textContent = status.phase || i.preparingPage || 'Preparing search page...';
    }
}

// "Retry" button labels across the major X UI locales
// (compared against trimmed, lowercased button text).
const RETRY_BUTTON_LABELS = new Set([
    'retry', 'try again',               // en
    'повторить', 'повторить попытку',   // ru
    'إعادة المحاولة',                    // ar
    'erneut versuchen',                 // de
    'reintentar', 'intentar de nuevo',  // es
    'réessayer',                        // fr
    'riprova',                          // it
    'tentar novamente',                 // pt
    'tekrar dene',                      // tr
    'coba lagi',                        // id
    'पुनः प्रयास करें',                    // hi
    '再試行', '再試行する',               // ja
    '다시 시도', '다시 시도하기',          // ko
    '重试', '重試'                       // zh
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'XPORTER_SEARCH_CAPTURE_STATUS') {
        try {
            updateXporterCaptureOverlay(message);
            sendResponse({ success: true });
        } catch (error) {
            sendResponse({ error: error.message });
        }
        return true;
    }

    if (message?.type === 'XPORTER_SCROLL_SEARCH_PAGE') {
        try {
            // Scope to the timeline/main region when present so we never click
            // unrelated buttons elsewhere on the page.
            const scope = document.querySelector('main[role="main"]')
                || document.querySelector('[data-testid="primaryColumn"]')
                || document;
            const retryButton = Array.from(scope.querySelectorAll('button, [role="button"]')).find((button) => {
                const text = (button.textContent || '').trim().toLowerCase();
                return RETRY_BUTTON_LABELS.has(text);
            });
            retryButton?.click();

            const target = Math.max(
                document.documentElement?.scrollHeight || 0,
                document.body?.scrollHeight || 0
            );
            window.scrollTo(0, target);
            sendResponse({ success: true, scrollTop: target });
        } catch (error) {
            sendResponse({ error: error.message });
        }
        return true;
    }

    return false;
});
