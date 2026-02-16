// XPorter Popup — Utility Functions
// Extracted from popup.js for modularity

// ==================== Messaging ====================

/**
 * Send a message to the service worker with timeout and error handling.
 * Returns an empty object on failure (never throws).
 */
function sendMessage(msg) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.warn('sendMessage timeout for:', msg.type);
            resolve({});
        }, (typeof XPORTER_CONFIG !== 'undefined' ? XPORTER_CONFIG.MESSAGE_TIMEOUT : 5000));
        try {
            chrome.runtime.sendMessage(msg, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    console.error('sendMessage error:', chrome.runtime.lastError.message);
                    resolve({});
                    return;
                }
                resolve(response || {});
            });
        } catch (e) {
            clearTimeout(timeout);
            console.error('sendMessage exception:', e);
            resolve({});
        }
    });
}

// ==================== Auth ====================

/**
 * Check if the user is logged in to X by looking for the auth_token cookie.
 */
async function checkAuth() {
    return new Promise((resolve) => {
        chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }, (cookie) => {
            resolve(!!cookie);
        });
    });
}

// ==================== Error Formatting ====================

/**
 * Map internal error codes to i18n translation keys.
 * Requires a `t(key)` function in scope (provided by the caller).
 */
function formatError(error, t) {
    const errorMap = {
        'NOT_LOGGED_IN': 'errNotLoggedIn',
        'USER_NOT_FOUND': 'errUserNotFound',
        'USER_SUSPENDED': 'errUserSuspended',
        'ACCOUNT_PRIVATE': 'errAccountPrivate',
        'AUTH_ERROR': 'errAuthError',
        'RATE_LIMITED': 'errRateLimited',
        'STALE_QUERY_ID': 'errStaleQuery',
        'ENDPOINT_DISCOVERY_FAILED': 'errEndpointFailed'
    };
    const key = errorMap[error];
    return key ? t(key) : error;
}

// ==================== Username Parsing ====================

// Reserved X/Twitter paths that are NOT usernames
const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'intent', 'account', 'login',
    'logout', 'signup', 'tos', 'privacy', 'about', 'help',
    'hashtag', 'lists', 'communities', 'premium', 'jobs',
    'who_to_follow', 'trending'
]);

/**
 * Extracts a clean username from various input formats:
 *  - https://x.com/beffjezos
 *  - https://twitter.com/beffjezos/status/123
 *  - @beffjezos
 *  - beffjezos
 */
function extractUsernameFromInput(input) {
    if (!input) return '';
    let val = input.trim();

    // Try to parse as URL
    try {
        const url = new URL(val);
        if (url.hostname === 'x.com' || url.hostname === 'www.x.com' ||
            url.hostname === 'twitter.com' || url.hostname === 'www.twitter.com') {
            const pathMatch = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})(\/|$)/);
            if (pathMatch && !RESERVED_PATHS.has(pathMatch[1].toLowerCase())) {
                return pathMatch[1];
            }
        }
        // It's a URL but not a valid X profile — return empty
        return '';
    } catch (_) {
        // Not a URL — continue
    }

    // Strip @ prefix
    val = val.replace(/^@/, '');

    // Validate as username (1-15 alphanumeric + underscore chars)
    const usernameMatch = val.match(/^([a-zA-Z0-9_]{1,15})$/);
    return usernameMatch ? usernameMatch[1] : val;
}

// ==================== General ====================

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
