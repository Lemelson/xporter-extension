// XPorter — Shared Utilities
// Common helpers used by the popup and other extension UI contexts.

// ==================== Messaging ====================

/**
 * Send a message to the service worker with timeout and error handling.
 * Never throws. Failures resolve to `{ error: 'TIMEOUT' }` (no response in
 * time) or `{ error: 'MESSAGING_ERROR' }` (channel failure) so callers can
 * tell them apart from a successful empty response.
 * @param {Object} msg - Message for the service worker
 * @param {number} [timeoutMs] - Optional timeout override (e.g. for downloads)
 */
function sendMessage(msg, timeoutMs) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.warn('sendMessage timeout for:', msg.type);
            resolve({ error: 'TIMEOUT' });
        }, timeoutMs || (typeof XPORTER_CONFIG !== 'undefined' ? XPORTER_CONFIG.MESSAGE_TIMEOUT : 5000));
        try {
            chrome.runtime.sendMessage(msg, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    console.error('sendMessage error:', chrome.runtime.lastError.message);
                    resolve({ error: 'MESSAGING_ERROR' });
                    return;
                }
                resolve(response || {});
            });
        } catch (e) {
            clearTimeout(timeout);
            console.error('sendMessage exception:', e);
            resolve({ error: 'MESSAGING_ERROR' });
        }
    });
}

/**
 * Persist a partial settings update and advance the caller's cache only after
 * storage confirms the write. Keeping this transaction in one place prevents
 * a failed save from becoming the popup's new in-memory source of truth.
 */
async function persistSettingsPatch(currentSettings, patch) {
    if (!patch || Object.keys(patch).length === 0) return { success: true };
    const result = await sendMessage({ type: 'SAVE_SETTINGS', settings: patch });
    if (result?.success === true) {
        Object.assign(currentSettings, patch);
    }
    return result;
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
        'MAX_RETRIES_EXCEEDED': 'errMaxRetries',
        'ALREADY_RUNNING': 'errAlreadyRunning',
        'NO_DATA': 'errNoData',
        'HISTORY_NOT_FOUND': 'errHistoryNotFound',
        'HISTORY_DATA_GONE': 'errHistoryDataGone',
        'STORAGE_FULL': 'errStorageFull',
        'DOWNLOAD_FAILED': 'errDownloadFailed',
        'DOWNLOAD_IN_PROGRESS': 'errDownloadInProgress',
        'COPY_TOO_LARGE': 'errCopyTooLarge',
        'SEARCH_CAPTURE_TIMEOUT': 'errSearchCapture',
        // Timed-out fetch — same user guidance as a failed connection
        'NETWORK_TIMEOUT': 'errEndpointFailed'
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
        'RATE_LIMITED': 'Routine pause — progress saved, please wait',
        'STALE_QUERY_ID': 'X API changed — retrying with fresh data...',
        'ENDPOINT_DISCOVERY_FAILED': 'Could not connect to X API — make sure x.com is accessible',
        'MAX_RETRIES_EXCEEDED': 'Maximum retries exceeded — please try again later',
        'ALREADY_RUNNING': 'An export is already running — stop it first',
        'NO_DATA': 'No data to download',
        'HISTORY_NOT_FOUND': 'History entry not found',
        'HISTORY_DATA_GONE': 'The saved data for this export has expired and can no longer be downloaded',
        'STORAGE_FULL': 'Storage is full — export stopped early. Download what was collected.',
        'DOWNLOAD_FAILED': 'Download failed — please try again',
        'DOWNLOAD_IN_PROGRESS': 'A download is already in progress',
        'COPY_TOO_LARGE': 'This export is too large to copy — download the numbered files instead',
        'SEARCH_CAPTURE_TIMEOUT': 'Could not read X\'s search results — keep the search tab open and press Resume to try again',
        'NETWORK_TIMEOUT': 'Could not connect to X API — make sure x.com is accessible',
        'TIMEOUT': 'No response from the extension — please try again',
        'MESSAGING_ERROR': 'Could not reach the extension — please try again'
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
    'who_to_follow', 'trending', 'bookmarks', 'topics',
    'display', 'download', 'follower_requests'
]);

// Valid X username: 1-15 alphanumeric + underscore chars.
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Check whether a string is a valid X username.
 */
function isValidUsername(value) {
    return USERNAME_PATTERN.test(String(value || ''));
}

/**
 * Extracts a clean username from various input formats:
 *  - https://x.com/beffjezos
 *  - https://twitter.com/beffjezos/status/123
 *  - x.com/beffjezos (schemeless)
 *  - @beffjezos
 *  - beffjezos
 * Returns '' for anything that is not a valid username or X profile URL,
 * never the invalid input verbatim.
 */
function extractUsernameFromInput(input) {
    if (!input) return '';
    let val = input.trim();

    // Try to parse as URL (schemeless "x.com/user" strings count too)
    let url = null;
    try {
        url = new URL(val);
    } catch (_) {
        // Not an absolute URL — retry with an https:// prefix for host-y input
        if (/^(www\.)?(x|twitter)\.com\//i.test(val)) {
            try { url = new URL('https://' + val); } catch (_) { /* not a URL */ }
        }
    }
    if (url) {
        if (url.hostname === 'x.com' || url.hostname === 'www.x.com' ||
            url.hostname === 'twitter.com' || url.hostname === 'www.twitter.com') {
            const pathMatch = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})(\/|$)/);
            if (pathMatch && !RESERVED_PATHS.has(pathMatch[1].toLowerCase())) {
                return pathMatch[1];
            }
        }
        // It's a URL but not a valid X profile — return empty
        return '';
    }

    // Strip @ prefix
    val = val.replace(/^@/, '');

    // Validate as username; invalid input yields '' (not the garbage itself)
    return isValidUsername(val) ? val : '';
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
 * Used by extension UI pages.
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

/**
 * Wrap a dynamic value (e.g. an @handle) in Unicode bidi isolates so LTR
 * usernames render correctly inside RTL (Arabic) sentences.
 * FSI (U+2068) … PDI (U+2069).
 */
function bidiIsolate(value) {
    return '\u2068' + String(value) + '\u2069';
}

/**
 * Localize the popup quantity-limit <select>:
 * translated "Unlimited"/"Custom" labels, and locale-aware number grouping
 * for every numeric preset (including a dynamically inserted custom value).
 */
function localizeQuantityOptions(select, langCode, translations) {
    if (!select) return;
    const posts = translations?.posts || 'posts';
    select.querySelectorAll('option').forEach(opt => {
        if (opt.value === '0') {
            opt.textContent = translations?.unlimited || 'Unlimited';
        } else if (opt.value === 'custom') {
            opt.textContent = translations?.custom || 'Custom';
        } else {
            const n = parseInt(opt.value, 10);
            if (n > 0) opt.textContent = `${formatNumber(n, langCode)} ${posts}`;
        }
    });
}

const PLURAL_LABELS = {
    en: {
        postsCollected: { one: 'post collected', other: 'posts collected' },
        usersCollected: { one: 'user collected', other: 'users collected' },
        morePosts: { one: 'more post', other: 'more posts' },
        moreUsers: { one: 'more user', other: 'more users' }
    },
    ru: {
        postsCollected: { one: 'пост собран', few: 'поста собрано', many: 'постов собрано', other: 'поста собрано' },
        usersCollected: { one: 'пользователь собран', few: 'пользователя собрано', many: 'пользователей собрано', other: 'пользователя собрано' },
        morePosts: { one: 'ещё пост', few: 'ещё поста', many: 'ещё постов', other: 'ещё поста' },
        moreUsers: { one: 'ещё пользователь', few: 'ещё пользователя', many: 'ещё пользователей', other: 'ещё пользователя' }
    },
    ar: {
        postsCollected: { zero: 'منشورات تم جمعها', one: 'منشور تم جمعه', two: 'منشوران تم جمعهما', few: 'منشورات تم جمعها', many: 'منشورًا تم جمعه', other: 'منشور تم جمعه' },
        usersCollected: { zero: 'مستخدمون تم جمعهم', one: 'مستخدم تم جمعه', two: 'مستخدمان تم جمعهما', few: 'مستخدمون تم جمعهم', many: 'مستخدمًا تم جمعه', other: 'مستخدم تم جمعه' },
        morePosts: { zero: 'منشورات إضافية', one: 'منشور إضافي', two: 'منشوران إضافيان', few: 'منشورات إضافية', many: 'منشورًا إضافيًا', other: 'منشور إضافي' },
        moreUsers: { zero: 'مستخدمون إضافيون', one: 'مستخدم إضافي', two: 'مستخدمان إضافيان', few: 'مستخدمون إضافيون', many: 'مستخدمًا إضافيًا', other: 'مستخدم إضافي' }
    },
    de: {
        postsCollected: { one: 'Beitrag gesammelt', other: 'Beiträge gesammelt' },
        usersCollected: { one: 'Benutzer gesammelt', other: 'Benutzer gesammelt' },
        morePosts: { one: 'weiterer Beitrag', other: 'weitere Beiträge' },
        moreUsers: { one: 'weiterer Benutzer', other: 'weitere Benutzer' }
    },
    es: {
        postsCollected: { one: 'publicación recopilada', other: 'publicaciones recopiladas' },
        usersCollected: { one: 'usuario recopilado', other: 'usuarios recopilados' },
        morePosts: { one: 'publicación más', other: 'publicaciones más' },
        moreUsers: { one: 'usuario más', other: 'usuarios más' }
    },
    fr: {
        postsCollected: { one: 'publication collectée', other: 'publications collectées' },
        usersCollected: { one: 'utilisateur collecté', other: 'utilisateurs collectés' },
        morePosts: { one: 'publication supplémentaire', other: 'publications supplémentaires' },
        moreUsers: { one: 'utilisateur de plus', other: 'utilisateurs de plus' }
    },
    it: {
        postsCollected: { one: 'post raccolto', other: 'post raccolti' },
        usersCollected: { one: 'utente raccolto', other: 'utenti raccolti' },
        morePosts: { one: 'post in più', other: 'post in più' },
        moreUsers: { one: 'utente in più', other: 'utenti in più' }
    },
    pt: {
        postsCollected: { one: 'publicação coletada', other: 'publicações coletadas' },
        usersCollected: { one: 'usuário coletado', other: 'usuários coletados' },
        morePosts: { one: 'publicação a mais', other: 'publicações a mais' },
        moreUsers: { one: 'usuário a mais', other: 'usuários a mais' }
    },
    tr: {
        postsCollected: { other: 'gönderi toplandı' },
        usersCollected: { other: 'kullanıcı toplandı' },
        morePosts: { other: 'daha fazla gönderi' },
        moreUsers: { other: 'daha fazla kullanıcı' }
    },
    id: {
        postsCollected: { other: 'postingan terkumpul' },
        usersCollected: { other: 'pengguna terkumpul' },
        morePosts: { other: 'postingan lagi' },
        moreUsers: { other: 'pengguna lagi' }
    },
    hi: {
        postsCollected: { other: 'पोस्ट एकत्रित' },
        usersCollected: { other: 'उपयोगकर्ता एकत्र' },
        morePosts: { other: 'और पोस्ट' },
        moreUsers: { other: 'और उपयोगकर्ता' }
    },
    ja: {
        postsCollected: { other: '件のポスト取得済み' },
        usersCollected: { other: '人のユーザー取得済み' },
        morePosts: { other: '件追加' },
        moreUsers: { other: '人追加' }
    },
    ko: {
        postsCollected: { other: '개 게시물 수집됨' },
        usersCollected: { other: '명 사용자 수집됨' },
        morePosts: { other: '개 게시물 추가' },
        moreUsers: { other: '명 사용자 추가' }
    },
    zh: {
        postsCollected: { other: '条帖子已收集' },
        usersCollected: { other: '位用户已收集' },
        morePosts: { other: '条帖子' },
        moreUsers: { other: '位用户' }
    }
};

function baseLanguage(langCode) {
    return String(langCode || 'en').toLowerCase().split('-')[0];
}

function pluralCategory(count, langCode) {
    try {
        return new Intl.PluralRules(baseLanguage(langCode)).select(Math.abs(Number(count) || 0));
    } catch (_) {
        return (Number(count) === 1) ? 'one' : 'other';
    }
}

function pluralLabel(key, count, langCode, translations) {
    const lang = baseLanguage(langCode);
    const forms = PLURAL_LABELS[lang]?.[key] || PLURAL_LABELS.en[key];
    const category = pluralCategory(count, lang);
    if (forms?.[category]) return forms[category];
    if (forms?.other) return forms.other;
    if (translations?.[key]) return translations[key];
    return key;
}

function collectedLabel(count, mode, langCode, translations) {
    const key = (mode === 'posts') ? 'postsCollected' : 'usersCollected';
    return pluralLabel(key, count, langCode, translations);
}

function formatCollectedCount(count, mode, langCode, translations) {
    return `${formatNumber(count, langCode)} ${collectedLabel(count, mode, langCode, translations)}`;
}

// ==================== Cooldown Countdown ====================

/**
 * Create a live cooldown countdown for extension UI.
 * Driven by an absolute `until` timestamp (epoch ms) from the service
 * worker's cooldown events, with a duration fallback for older events.
 * `render(secondsRemaining)` is called once per second.
 *
 * start() guards against stacked intervals: re-firing with the same deadline
 * (re-broadcasts, status polls) keeps the already-running interval.
 */
function createCooldownTicker(render) {
    let interval = null;
    let until = 0;

    function stop() {
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
    }

    function tick() {
        const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        if (remaining <= 0) {
            stop();
            return;
        }
        render(remaining);
    }

    function start(untilTs, fallbackDurationMs) {
        const target = Number(untilTs) || 0;
        if (interval) {
            // Same deadline already ticking → keep the running countdown.
            if (target && target === until) return;
            // Duration-only re-fire while ticking → keep counting down.
            if (!target) return;
        }
        stop();
        until = target || (Date.now() + (Number(fallbackDurationMs) || 180000));
        tick();
        interval = setInterval(tick, 1000);
    }

    return { start, stop, active: () => !!interval };
}

/**
 * Animate a progress element from elapsed wait time to 100% at the deadline.
 * This keeps a newly opened popup in sync with a wait already in progress.
 */
function startWaitProgress(element, untilTs, durationMs) {
    if (!element) return;
    const duration = Math.max(1, Number(durationMs) || 1);
    const deadline = Number(untilTs) || (Date.now() + duration);
    const remaining = Math.max(0, deadline - Date.now());
    const elapsedPct = Math.min(100, Math.max(0, (1 - remaining / duration) * 100));

    element.classList.remove('indeterminate');
    element.style.transition = 'none';
    element.style.width = `${elapsedPct}%`;
    void element.offsetWidth;
    element.style.transition = `width ${remaining}ms linear`;
    element.style.width = '100%';
}

function stopWaitProgress(element) {
    if (!element) return;
    element.style.removeProperty('transition');
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
