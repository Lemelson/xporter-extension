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

function sanitizeAccountAvatarUrl(rawAvatar) {
    try {
        const parsed = new URL(String(rawAvatar || ''));
        if (parsed.protocol === 'https:' &&
            ['pbs.twimg.com', 'abs.twimg.com'].includes(parsed.hostname)) {
            return parsed.href;
        }
    } catch (_) { /* avatar is optional */ }
    return '';
}

function accountIdentityFromText(container, username) {
    const lines = String(container?.innerText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const normalizedUsername = String(username || '').replace(/^@/, '').toLowerCase();
    const handleIndex = lines.findIndex(
        (line) => line.toLowerCase() === `@${normalizedUsername}`
    );
    if (handleIndex < 0) return null;
    const name = lines.slice(0, handleIndex).find(
        (line) => line !== '·' && !/^@[a-zA-Z0-9_]{1,15}$/.test(line)
    ) || '';
    return {
        name: name.slice(0, 200),
        username: String(username || '').replace(/^@/, '')
    };
}

function extractCurrentAccount() {
    const switcher = document.querySelector?.(
        '[data-testid="SideNav_AccountSwitcher_Button"]'
    );
    const profileLink = document.querySelector?.(
        'a[data-testid="AppTabBar_Profile_Link"][href^="/"]'
    );
    const lines = String(switcher?.innerText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const handleLine = lines.find((line) => /^@[a-zA-Z0-9_]{1,15}$/.test(line));
    const linkHandle = String(profileLink?.getAttribute?.('href') || '')
        .match(/^\/([a-zA-Z0-9_]{1,15})(?:\/|$)/)?.[1] || '';
    const username = String(handleLine || linkHandle).replace(/^@/, '');
    if (!username || RESERVED_PATHS.has(username.toLowerCase())) return null;

    const avatar = switcher?.querySelector?.('img');
    const avatarName = String(avatar?.alt || '').trim();
    const name = (
        avatarName &&
        !/^@[a-zA-Z0-9_]{1,15}$/.test(avatarName) &&
        avatarName.length <= 200
    ) ? avatarName : (lines.find((line) =>
        line !== handleLine &&
        !/^@[a-zA-Z0-9_]{1,15}$/.test(line) &&
        line.length <= 200
    ) || '');
    const rawAvatar = avatar?.src || '';
    const avatarUrl = sanitizeAccountAvatarUrl(rawAvatar);
    return { name, username, avatarUrl };
}

function extractTargetAccount(currentAccount = null) {
    const username = extractUsername();
    if (!username) return null;
    const normalizedUsername = username.toLowerCase();
    let identity = null;
    let avatar = null;

    const profileIdentity = document.querySelector?.('[data-testid="UserName"]');
    identity = accountIdentityFromText(profileIdentity, username);
    if (identity) {
        const avatarContainers = Array.from(
            document.querySelectorAll?.('[data-testid^="UserAvatar-Container-"]') || []
        );
        const avatarContainer = avatarContainers.find((element) => {
            const testId = String(element?.getAttribute?.('data-testid') || '');
            return testId.slice('UserAvatar-Container-'.length).toLowerCase() ===
                normalizedUsername;
        });
        avatar = avatarContainer?.querySelector?.('img') ||
            document.querySelector?.(`a[href="/${username}/photo"] img`);
    }

    if (!identity) {
        const tweets = Array.from(
            document.querySelectorAll?.('article[data-testid="tweet"]') || []
        );
        const targetTweet = tweets.find((tweet) =>
            accountIdentityFromText(
                tweet?.querySelector?.('[data-testid="User-Name"]'),
                username
            )
        );
        identity = accountIdentityFromText(
            targetTweet?.querySelector?.('[data-testid="User-Name"]'),
            username
        );
        avatar = targetTweet?.querySelector?.(
            '[data-testid="Tweet-User-Avatar"] img'
        );
    }

    const isCurrentAccount = Boolean(
        currentAccount?.username &&
        String(currentAccount.username).toLowerCase() === normalizedUsername
    );
    if (!identity) {
        identity = { name: '', username };
    }
    if (isCurrentAccount) {
        if (!identity.name) identity.name = currentAccount.name || '';
        if (!avatar) {
            return {
                ...identity,
                avatarUrl: currentAccount.avatarUrl || '',
                isCurrentAccount: true
            };
        }
    }
    return {
        ...identity,
        avatarUrl: sanitizeAccountAvatarUrl(avatar?.src || ''),
        isCurrentAccount
    };
}

let lastCurrentAccountKey = '';
let currentAccountTimer = null;

function detectCurrentAccount() {
    currentAccountTimer = null;
    const account = extractCurrentAccount();
    if (!account) return;
    const key = JSON.stringify(account);
    if (key === lastCurrentAccountKey) return;
    lastCurrentAccountKey = key;
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({
        type: 'SET_CURRENT_ACCOUNT',
        account
    }).catch(() => {});
}

function scheduleCurrentAccountDetection() {
    if (currentAccountTimer !== null) return;
    currentAccountTimer = setTimeout(detectCurrentAccount, 250);
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
    scheduleCurrentAccountDetection();
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
    scheduleCurrentAccountDetection();
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

const CAPTURE_CONTRACT = globalThis.XPorterCaptureContract;
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
        text: text(post.text, CAPTURE_CONTRACT.MAX_POST_TEXT_CHARS),
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

let captureProbeNonce = '';
let captureHookReady = false;

// Listen for messages from the MAIN-world interceptor
window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === '__XPORTER_CAPTURE_READY__' &&
        captureProbeNonce && event.data.nonce === captureProbeNonce) {
        captureHookReady = true;
        return;
    }
    if (event.data?.type === '__XPORTER_NATIVE_REQUEST_TEMPLATE__') {
        // Page scripts can spoof postMessage, so relay only the shared
        // low-authority schema. Reconstruct a fresh object: never spread page
        // data into an authenticated extension message.
        const template = globalThis.XPorterNativeTemplate
            ?.sanitizeWireTemplate(event.data.template);
        if (!template) return;
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'DISCOVERED_REQUEST_TEMPLATE',
            template
        }).catch(() => { });
    }
    if (event.data?.type === '__XPORTER_GRAPHQL_RESPONSE__') {
        const { operationName, bodyText } = event.data;
        if (!CAPTURE_CONTRACT.isTrackedOperation(operationName)) return;
        // Cap relayed body size — oversized payloads are dropped, not truncated.
        if (typeof bodyText !== 'string' ||
            bodyText.length > CAPTURE_CONTRACT.MAX_BODY_CHARS) return;
        const status = Number(event.data.status);
        if (!Number.isInteger(status) || status < 100 || status > 599) return;
        if (typeof event.data.url !== 'string' || !event.data.url.includes('/i/api/graphql/')) return;
        const captureError = ['SEARCH_RESPONSE_TOO_LARGE', 'SEARCH_NETWORK_ERROR'].includes(event.data.error)
            ? event.data.error : null;
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'PAGE_GRAPHQL_RESPONSE',
            operationName: operationName,
            url: event.data.url,
            status: status,
            bodyText: bodyText,
            ...(captureError ? { error: captureError } : {})
        }).catch(() => { });
    }
    if (event.data?.type === '__XPORTER_SEEN_POSTS__') {
        const { operationName, posts } = event.data;
        if (typeof operationName !== 'string' ||
            !/^[A-Za-z0-9_]{1,80}$/.test(operationName) ||
            !RELAY_POST_OPERATION_PATTERN.test(operationName)) return;
        if (!Array.isArray(posts) || posts.length === 0 ||
            posts.length > CAPTURE_CONTRACT.MAX_POSTS_PER_MESSAGE) return;
        if (!posts.every(post => (
            post && typeof post === 'object' &&
            RELAY_POST_ID_PATTERN.test(String(post.id || '')) &&
            typeof post.text === 'string' &&
            post.text.length <= CAPTURE_CONTRACT.MAX_POST_TEXT_CHARS
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
        <button class="xporter-capture-toggle" type="button" aria-label="Collapse XPorter status" aria-expanded="true">−</button>
        <div class="xporter-capture-title">XPorter date range export</div>
        <div class="xporter-capture-subtitle" data-xporter-subtitle>Preparing search page...</div>
        <div class="xporter-capture-meta">
            <span data-xporter-count>0 posts collected</span>
            <span class="xporter-capture-pct" data-xporter-pct></span>
        </div>
        <div class="xporter-capture-bar"><span data-xporter-bar></span></div>
        <div class="xporter-capture-details">
            <span class="xporter-capture-range" data-xporter-range></span>
            <span class="xporter-capture-limit" data-xporter-limit>No post limit</span>
        </div>
        <div class="xporter-capture-footer">
            <div class="xporter-capture-note">Keep this tab open. XPorter is scrolling it to collect posts.</div>
            <button class="xporter-capture-stop" type="button" data-xporter-stop>Stop export</button>
        </div>
    `;

    const style = document.createElement('style');
    style.id = 'xporter-capture-overlay-style';
    style.textContent = `
        #xporter-capture-overlay {
            --xp-surface: linear-gradient(135deg, #203655, #303e62);
            --xp-text: #f1f6ff;
            --xp-muted: #c4d3e8;
            --xp-accent: #78c5ff;
            --xp-track: #516582;
            --xp-border: #5a7190;
            --xp-scale: 1;
            position: fixed;
            inset-inline-end: 20px;
            bottom: 88px;
            z-index: 2147483647;
            box-sizing: border-box;
            width: min(380px, calc(100vw / var(--xp-scale) - 32px));
            zoom: var(--xp-scale);
            max-height: calc(100dvh / var(--xp-scale) - 104px);
            overflow-y: auto;
            padding: 16px;
            border: 1px solid var(--xp-border);
            border-radius: 14px;
            background: var(--xp-surface);
            color: var(--xp-text);
            box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-variant-numeric: tabular-nums;
            text-align: start;
            pointer-events: auto;
        }
        #xporter-capture-overlay * { box-sizing: border-box; }
        #xporter-capture-overlay .xporter-capture-toggle {
            position: absolute;
            top: 10px;
            inset-inline-end: 10px;
            display: grid;
            place-items: center;
            width: 30px;
            height: 30px;
            padding: 0;
            border: 1px solid transparent;
            border-radius: 7px;
            background: transparent;
            color: var(--xp-muted);
            cursor: pointer;
            font: 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #xporter-capture-overlay .xporter-capture-toggle:hover { background: #293341; color: #fff; }
        #xporter-capture-overlay button:focus-visible { outline: 2px solid var(--xp-accent); outline-offset: 3px; }
        #xporter-capture-overlay .xporter-capture-title {
            padding-inline-end: 26px;
            color: var(--xp-text);
            font-size: 13px;
            font-weight: 650;
            line-height: 1.4;
            overflow-wrap: anywhere;
        }
        #xporter-capture-overlay .xporter-capture-subtitle {
            margin-top: 5px;
            padding-inline-end: 20px;
            color: var(--xp-muted);
            font-size: 12px;
            line-height: 1.45;
        }
        #xporter-capture-overlay .xporter-capture-meta {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 12px;
            margin-top: 16px;
            font-size: 22px;
            font-weight: 650;
            letter-spacing: -.5px;
            line-height: 1.2;
        }
        #xporter-capture-overlay .xporter-capture-pct {
            flex-shrink: 0;
            color: var(--xp-accent);
            font-size: 12px;
            letter-spacing: 0;
        }
        #xporter-capture-overlay .xporter-capture-bar {
            height: 7px;
            margin-top: 12px;
            overflow: hidden;
            border-radius: 8px;
            background: var(--xp-track);
        }
        #xporter-capture-overlay .xporter-capture-bar span {
            display: block;
            width: 34%;
            height: 100%;
            border-radius: inherit;
            position: relative;
            overflow: hidden;
            background: linear-gradient(90deg, color-mix(in srgb, var(--xp-accent) 40%, transparent), var(--xp-accent));
            box-shadow: 0 0 12px color-mix(in srgb, var(--xp-accent) 40%, transparent);
            animation: xporter-capture-bar-sweep 2.2s cubic-bezier(.45,0,.55,1) infinite alternate;
        }
        #xporter-capture-overlay .xporter-capture-bar span::after {
            content: ''; position: absolute; inset: 0;
            background: linear-gradient(90deg, transparent, #ffffff80, transparent);
            animation: xporter-capture-glint 2.4s ease-in-out infinite;
        }
        @keyframes xporter-capture-glint { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        #xporter-capture-overlay.xporter-capture-paused .xporter-capture-bar span::after { animation: none; opacity: 0; }
        #xporter-capture-overlay.xporter-capture-determinate .xporter-capture-bar span {
            animation: none;
            transform: none;
            transition: width .35s ease;
        }
        #xporter-capture-overlay.xporter-capture-paused .xporter-capture-bar span {
            animation: none;
            background: #e5b967;
        }
        #xporter-capture-overlay.xporter-capture-paused .xporter-capture-pct,
        #xporter-capture-overlay.xporter-capture-paused [data-xporter-subtitle] { color: #e5b967; }
        @keyframes xporter-capture-bar-sweep {
            from { transform: translateX(-100%); }
            to { transform: translateX(300%); }
        }
        #xporter-capture-overlay .xporter-capture-details {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: 4px 12px;
            margin-top: 9px;
            color: var(--xp-muted);
            font-size: 11px;
            line-height: 1.4;
        }
        #xporter-capture-overlay .xporter-capture-range { direction: ltr; unicode-bidi: isolate; }
        #xporter-capture-overlay .xporter-capture-footer {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 14px;
            padding-top: 12px;
            border-top: 1px solid var(--xp-border);
        }
        #xporter-capture-overlay .xporter-capture-note {
            flex: 1;
            color: var(--xp-muted);
            font-size: 11px;
            line-height: 1.45;
        }
        #xporter-capture-overlay .xporter-capture-stop {
            flex: 0 1 auto;
            max-width: 46%;
            min-height: 40px;
            padding: 7px 10px;
            border: 1px solid var(--xp-border);
            border-radius: 7px;
            background: transparent;
            color: var(--xp-text);
            cursor: pointer;
            font: 550 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            transition: background .15s ease, color .15s ease;
        }
        #xporter-capture-overlay .xporter-capture-stop:hover { background: #3b242c; color: #ff8b95; border-color: #c34e5c; }
        #xporter-capture-overlay .xporter-capture-stop:disabled { cursor: default; opacity: .6; }
        #xporter-capture-overlay.xporter-capture-collapsed { width: min(280px, calc(100vw / var(--xp-scale) - 32px)); padding: 12px 14px; }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-subtitle,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-details,
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-footer { display: none; }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-title { font-size: 11px; }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-toggle { top: 8px; width: 24px; height: 24px; }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-meta { font-size: 16px; margin-top: 10px; }
        #xporter-capture-overlay.xporter-capture-collapsed .xporter-capture-bar { margin-top: 9px; height: 3px; }
        #xporter-capture-overlay.xporter-capture-light {
            --xp-surface: linear-gradient(135deg, #d2e6ff, #e3dff5);
            --xp-text: #182b43; --xp-muted: #405975;
            --xp-accent: #0869b4; --xp-track: #b5c9df; --xp-border: #9ab1cd;
        }
        #xporter-capture-overlay.xporter-capture-simple {
            --xp-surface: #181e26; --xp-text: #eef2f7; --xp-muted: #a9b4c2;
            --xp-accent: #78bcff; --xp-track: #343d49; --xp-border: #36414f;
        }
        #xporter-capture-overlay.xporter-capture-light.xporter-capture-simple {
            --xp-surface: #f8fafc; --xp-text: #1d2735; --xp-muted: #536278;
            --xp-accent: #1268bc; --xp-track: #cbd4e0; --xp-border: #cbd4e0;
        }
        #xporter-capture-overlay.xporter-capture-light.xporter-capture-paused [data-xporter-subtitle],
        #xporter-capture-overlay.xporter-capture-light.xporter-capture-paused .xporter-capture-pct { color: #865308; }
        @media (max-width: 420px) { #xporter-capture-overlay { inset-inline-end: 16px; bottom: 16px; max-height: calc(100dvh / var(--xp-scale) - 32px); } }
        @media (prefers-reduced-motion: reduce) {
            #xporter-capture-overlay .xporter-capture-bar span,
            #xporter-capture-overlay .xporter-capture-bar span::after { animation: none; transition: none; }
        }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);

    overlay.querySelector('.xporter-capture-toggle').addEventListener('click', () => {
        const collapsed = overlay.classList.toggle('xporter-capture-collapsed');
        const button = overlay.querySelector('.xporter-capture-toggle');
        const i = overlay._xporterI18n || {};
        button.textContent = collapsed ? '+' : '−';
        button.setAttribute('aria-expanded', String(!collapsed));
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
    const appearance = i.appearance || {};
    overlay.classList.toggle('xporter-capture-simple', appearance.simplifiedDesign === true);
    overlay.classList.toggle('xporter-capture-light', appearance.theme === 'light');
    const scale = [85, 100, 115, 130].includes(Number(appearance.uiScale)) ? Number(appearance.uiScale) / 100 : 1;
    overlay.style.setProperty('--xp-scale', String(scale));
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

    XPorterRollingCounter.render(overlay.querySelector('[data-xporter-count]'),
        `${count.toLocaleString(locale)} ${capturePluralLabel('postsCollected', count, i)}`);
    overlay.querySelector('[data-xporter-range]').textContent = range;
    overlay.querySelector('[data-xporter-limit]').textContent = limitText;

    // Stop button label (unless a click already put it into "Stopping…").
    const stopBtn = overlay.querySelector('[data-xporter-stop]');
    if (stopBtn && !stopBtn.disabled) stopBtn.textContent = i.stop || 'Stop export';

    // A limit supplies an exact denominator. The span of dates already visited
    // does not tell us how many posts remain; use activity without a percentage.
    const pct = limit > 0 ? count / limit * 100 : NaN;
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
            subtitleEl.textContent = `${status.pauseLabel || i.rateLimited || 'X rate limit — retrying in'} ` +
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
    if (message?.type === 'XPORTER_SEARCH_PAGE_STATE') {
        captureHookReady = false;
        captureProbeNonce = String(Math.random());
        window.postMessage({ type: '__XPORTER_CAPTURE_PROBE__', nonce: captureProbeNonce }, window.location.origin);
        setTimeout(() => {
            sendResponse({ ready: true, hookReady: captureHookReady });
        }, 150);
        return true;
    }
    if (message?.type === 'GET_ACCOUNT_CONTEXT') {
        const currentAccount = extractCurrentAccount();
        sendResponse({
            currentAccount,
            targetAccount: extractTargetAccount(currentAccount)
        });
        return true;
    }

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
