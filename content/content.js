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
});
