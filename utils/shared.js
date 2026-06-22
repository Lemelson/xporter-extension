// XPorter — Shared Utilities
// Common functions used by both popup and export pages
// Eliminates duplication between popup/utils.js and export/export.js

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
 * If a `t(key)` function is provided, returns translated string.
 * Otherwise returns a human-readable English fallback.
 */
function formatError(error, t) {
    const errorMap = {
        'NOT_LOGGED_IN': 'errNotLoggedIn',
        'USER_NOT_FOUND': 'errUserNotFound',
        'USER_SUSPENDED': 'errUserSuspended',
        'USER_UNAVAILABLE': 'errUserUnavailable',
        'ACCOUNT_PRIVATE': 'errAccountPrivate',
        'INVALID_DATE_RANGE': 'errInvalidDateRange',
        'AUTH_ERROR': 'errAuthError',
        'RATE_LIMITED': 'errRateLimited',
        'STALE_QUERY_ID': 'errStaleQuery',
        'ENDPOINT_DISCOVERY_FAILED': 'errEndpointFailed',
        'MAX_RETRIES_EXCEEDED': 'errMaxRetries'
    };

    // English fallbacks for when no i18n `t` function is available
    const fallbacks = {
        'NOT_LOGGED_IN': 'Please log in to x.com first',
        'USER_NOT_FOUND': 'User not found — check the username',
        'USER_SUSPENDED': 'This account is suspended',
        'USER_UNAVAILABLE': 'This account is unavailable',
        'ACCOUNT_PRIVATE': 'This account is private',
        'INVALID_DATE_RANGE': 'Date range is invalid — "From" must be earlier than "To"',
        'AUTH_ERROR': 'Authentication failed — please refresh x.com and try again',
        'RATE_LIMITED': 'Rate limited by X — please wait',
        'STALE_QUERY_ID': 'X API changed — retrying with fresh data...',
        'ENDPOINT_DISCOVERY_FAILED': 'Could not connect to X API — make sure x.com is accessible',
        'MAX_RETRIES_EXCEEDED': 'Maximum retries exceeded — please try again later'
    };

    const i18nKey = errorMap[error];
    if (i18nKey && typeof t === 'function') {
        const translated = t(i18nKey);
        // If t() returns the key itself, fall back to English
        if (translated !== i18nKey) return translated;
    }
    return fallbacks[error] || error;
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

// ==================== i18n Helpers ====================

/**
 * Escape HTML so locale strings can never inject markup.
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Render help-tooltip text. Everything is escaped first, then the only
 * markup we allow — **bold** spans used to highlight the gist — becomes
 * <strong>. So a reader can scan the bold for the essence or read it all.
 */
function renderHelpMarkup(text) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

/**
 * Strip the **bold** markers from a string (for plain-text contexts like
 * aria-label, where screen readers would otherwise read the asterisks).
 */
function stripHelpMarkup(text) {
    return String(text).replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Apply translations to common i18n attributes.
 * Used by both popup and export pages.
 */
function applyI18nToDOM(translations) {
    document.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-tooltip], [data-i18n-aria-label]').forEach(el => {
        const textKey = el.getAttribute('data-i18n');
        if (textKey && translations[textKey] !== undefined) {
            el.textContent = translations[textKey];
        }
        const placeholderKey = el.getAttribute('data-i18n-placeholder');
        if (placeholderKey && translations[placeholderKey] !== undefined) {
            el.placeholder = translations[placeholderKey];
        }
        const titleKey = el.getAttribute('data-i18n-title');
        if (titleKey && translations[titleKey] !== undefined) {
            el.title = translations[titleKey];
        }
        const tooltipKey = el.getAttribute('data-i18n-tooltip');
        if (tooltipKey && translations[tooltipKey] !== undefined) {
            // Render into a real child element so **bold** gist markup works
            // (a CSS attr() tooltip can only show plain text).
            let pop = el.querySelector(':scope > .help-pop');
            if (!pop) {
                pop = document.createElement('span');
                pop.className = 'help-pop';
                pop.setAttribute('aria-hidden', 'true');
                el.appendChild(pop);
            }
            pop.innerHTML = renderHelpMarkup(translations[tooltipKey]);
            el.removeAttribute('title');
        }
        const ariaLabelKey = el.getAttribute('data-i18n-aria-label');
        if (ariaLabelKey && translations[ariaLabelKey] !== undefined) {
            el.setAttribute('aria-label', stripHelpMarkup(translations[ariaLabelKey]));
        }
    });
}

// ==================== Direction & Number Formatting ====================

// Languages that read right-to-left. Currently only Arabic is shipped.
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

/**
 * Apply text direction (LTR/RTL) for the given language to the document.
 */
function applyLanguageDirection(langCode) {
    const dir = RTL_LANGUAGES.has(langCode) ? 'rtl' : 'ltr';
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dir = dir;
    }
    return dir;
}

/**
 * Format a number using the selected UI language (not the browser locale).
 * Falls back gracefully if the locale is unsupported.
 */
function formatNumber(value, langCode) {
    const n = Number(value) || 0;
    try {
        return n.toLocaleString(langCode || undefined);
    } catch (_) {
        return n.toLocaleString();
    }
}

// ==================== General ====================

/**
 * Debounce a function. Returns a debounced version with an optional .flush() method.
 */
function debounce(fn, ms) {
    let timer;
    const debounced = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    debounced.flush = () => {
        clearTimeout(timer);
        return fn();
    };
    return debounced;
}
