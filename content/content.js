// XPorter — Content Script
// Detects the current X/Twitter username from the page URL
// Runs on x.com and twitter.com pages

const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'intent', 'account', 'login',
    'logout', 'signup', 'tos', 'privacy', 'about', 'help',
    'hashtag', 'lists', 'communities', 'premium', 'jobs',
    'who_to_follow', 'trending'
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

// Use MutationObserver to detect URL changes in SPA
const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        const username = extractUsername();
        sendUsername(username);
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Also listen for popstate events (back/forward navigation)
window.addEventListener('popstate', () => {
    const username = extractUsername();
    sendUsername(username);
});

// ==================== GraphQL QueryId Discovery via Fetch Interception ====================
// X.com makes GraphQL requests with the correct queryIds.
// We intercept these and forward them to the service worker so the extension
// always has up-to-date queryIds without relying on fragile JS-bundle scanning.

// Inject a fetch interceptor into the actual page context.
// Loaded via src (not inline textContent) so it doesn't violate x.com's CSP.
const interceptorScript = document.createElement('script');
interceptorScript.src = chrome.runtime.getURL('content/interceptor.js');
interceptorScript.onload = () => interceptorScript.remove();
(document.head || document.documentElement).appendChild(interceptorScript);

// Listen for messages from the injected script
window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__XPORTER_QUERYID__') {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'DISCOVERED_QUERYID',
            queryId: event.data.queryId,
            operationName: event.data.operationName
        }).catch(() => { });
    }
    if (event.data?.type === '__XPORTER_GRAPHQL_RESPONSE__') {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({
            type: 'PAGE_GRAPHQL_RESPONSE',
            operationName: event.data.operationName,
            url: event.data.url,
            status: event.data.status,
            bodyText: event.data.bodyText
        }).catch(() => { });
    }
});

function ensureXporterCaptureOverlay() {
    let overlay = document.getElementById('xporter-capture-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'xporter-capture-overlay';
    overlay.innerHTML = `
        <div class="xporter-capture-title">XPorter date range export</div>
        <div class="xporter-capture-subtitle" data-xporter-subtitle>Preparing search page...</div>
        <div class="xporter-capture-bar"><span data-xporter-bar></span></div>
        <div class="xporter-capture-meta">
            <span data-xporter-count>0 posts collected</span>
            <span data-xporter-range></span>
        </div>
        <div class="xporter-capture-note">Keep this tab open. XPorter is scrolling it to collect posts.</div>
    `;

    const style = document.createElement('style');
    style.id = 'xporter-capture-overlay-style';
    style.textContent = `
        #xporter-capture-overlay {
            position: fixed;
            left: 50%;
            top: 22px;
            z-index: 2147483647;
            width: min(520px, calc(100vw - 32px));
            transform: translateX(-50%);
            padding: 14px 16px;
            border: 1px solid rgba(96, 184, 255, 0.36);
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(12, 20, 32, 0.96), rgba(31, 41, 73, 0.96));
            color: #fff;
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.48);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            pointer-events: none;
        }
        #xporter-capture-overlay .xporter-capture-title {
            font-size: 15px;
            font-weight: 750;
            line-height: 1.25;
        }
        #xporter-capture-overlay .xporter-capture-subtitle,
        #xporter-capture-overlay .xporter-capture-note {
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
            width: 0;
            height: 100%;
            border-radius: inherit;
            background: linear-gradient(90deg, #60B8FF, #00BA7C);
            transition: width 0.25s ease;
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
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    return overlay;
}

function updateXporterCaptureOverlay(status) {
    const overlay = ensureXporterCaptureOverlay();
    const count = Number(status.tweetCount || 0);
    const limit = Number(status.quantityLimit || 0);
    const progress = limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : Math.min(100, count > 0 ? 12 : 5);
    const range = [status.dateFrom, status.dateTo].filter(Boolean).join(' to ');

    overlay.querySelector('[data-xporter-subtitle]').textContent = status.phase || `Exporting @${status.username || 'profile'}...`;
    overlay.querySelector('[data-xporter-count]').textContent = `${count} posts collected`;
    overlay.querySelector('[data-xporter-range]').textContent = range;
    overlay.querySelector('[data-xporter-bar]').style.width = `${progress}%`;
}

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
            const retryButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((button) => {
                const text = (button.textContent || '').trim().toLowerCase();
                return text === 'retry' || text === 'try again' || text === 'повторить';
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
