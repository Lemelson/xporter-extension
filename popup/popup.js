// XPorter Popup — Logic
document.addEventListener('DOMContentLoaded', async () => {
    // ==================== Elements ====================
    const popup = document.getElementById('popup');
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const usernameInput = document.getElementById('usernameInput');
    const dateCheck = document.getElementById('dateCheck');
    const dateFields = document.getElementById('dateFields');
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const resumeRow = document.getElementById('resumeRow');
    const resumeQuantity = document.getElementById('resumeQuantity');
    const newExportBtn = document.getElementById('newExportBtn');
    const exportStatus = document.getElementById('exportStatus');
    const statusText = document.getElementById('statusText');
    const statusDetail = document.getElementById('statusDetail');
    const statusIndicator = document.getElementById('statusIndicator');
    const statusMessage = document.getElementById('statusMessage');
    const progressFill = document.getElementById('progressFill');
    const tweetCountEl = document.getElementById('tweetCount');
    const authWarning = document.getElementById('authWarning');
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    // Settings elements
    const includeRetweets = document.getElementById('includeRetweets');
    const includeReplies = document.getElementById('includeReplies');
    const quantityLimit = document.getElementById('quantityLimit');
    const cooldownMinutes = document.getElementById('cooldownMinutes');
    const cooldownBatch = document.getElementById('cooldownBatch');
    const customQuantityRow = document.getElementById('customQuantityRow');
    const customQuantity = document.getElementById('customQuantity');

    // Language selector elements
    const langBtn = document.getElementById('langBtn');
    const langFlag = document.getElementById('langFlag');
    const langCode = document.getElementById('langCode');
    const langDropdown = document.getElementById('langDropdown');

    // Cache values for updateUI — must be declared before any updateUI call
    let lastTweetCount = 0;
    let lastExpectedTweets = 0;
    let lastQuantityLimit = 0;
    let lastExportState = null; // cached state for language switch re-apply

    // ==================== Theme & Design ====================
    // SVG icon templates
    const ICONS = {
        sun: '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
        moon: '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
        circleCheck: '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
        circlePause: '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/></svg>',
        download: '<svg class="icon icon-btn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>'
    };

    const settings = await sendMessage({ type: 'GET_SETTINGS' });
    const currentSettings = settings?.settings || {};

    // Apply saved theme
    if (currentSettings.theme === 'light') {
        document.body.classList.add('light');
        themeIcon.innerHTML = ICONS.moon;
    }

    // Theme toggle (dark ↔ light)
    themeToggle.addEventListener('click', async () => {
        document.body.classList.toggle('light');
        const isLight = document.body.classList.contains('light');
        themeIcon.innerHTML = isLight ? ICONS.moon : ICONS.sun;
        currentSettings.theme = isLight ? 'light' : 'dark';
        await sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    });

    // ==================== Language Selector ====================
    // Auto-detect Chrome UI language on first launch; respect saved choice afterwards
    function detectBrowserLanguage() {
        const uiLang = chrome.i18n.getUILanguage(); // e.g. "en-US", "ru", "zh-CN"
        const base = uiLang.split('-')[0].toLowerCase(); // e.g. "en", "ru", "zh"
        return LANGUAGES.find(l => l.code === base) ? base : 'en';
    }
    let currentLang = currentSettings.language || detectBrowserLanguage();

    // If language was auto-detected (not saved yet), persist it immediately
    // so auto-detection only happens once — on the very first launch
    if (!currentSettings.language) {
        currentSettings.language = currentLang;
        sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    }

    // Build dropdown options
    function buildLangDropdown() {
        langDropdown.innerHTML = '';
        LANGUAGES.forEach(lang => {
            const opt = document.createElement('button');
            opt.className = 'lang-option' + (lang.code === currentLang ? ' active' : '');
            opt.innerHTML = `
                <span class="lang-option-flag">${lang.flag}</span>
                <span class="lang-option-name">${lang.name}</span>
                <svg class="lang-option-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>
            `;
            opt.addEventListener('click', () => selectLanguage(lang.code));
            langDropdown.appendChild(opt);
        });
    }

    // Update the language button display
    function updateLangButton(code) {
        const lang = LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
        langFlag.textContent = lang.flag;
        langCode.textContent = code.toUpperCase();
    }

    // Apply translations to all data-i18n elements
    function applyLanguage(code) {
        const t = TRANSLATIONS[code] || TRANSLATIONS['en'];

        // Translate all data-i18n elements
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (t[key] !== undefined) {
                el.textContent = t[key];
            }
        });

        // Translate data-i18n-placeholder
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (t[key] !== undefined) {
                el.placeholder = t[key];
            }
        });

        // Translate data-i18n-title
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (t[key] !== undefined) {
                el.title = t[key];
            }
        });

        // Update select options for quantity limit
        const options = quantityLimit.querySelectorAll('option');
        if (options.length >= 1) options[0].textContent = t.unlimited || 'Unlimited';
        if (options.length >= 2) options[1].textContent = `100 ${t.posts || 'posts'}`;
        if (options.length >= 3) options[2].textContent = `500 ${t.posts || 'posts'}`;
        if (options.length >= 4) options[3].textContent = `1,000 ${t.posts || 'posts'}`;
        if (options.length >= 5) options[4].textContent = `5,000 ${t.posts || 'posts'}`;
        if (options.length >= 6) options[5].textContent = `10,000 ${t.posts || 'posts'}`;
        if (options.length >= 7) options[6].textContent = t.custom || 'Custom';

        // Update html lang attribute
        document.documentElement.lang = code;
    }

    // Select a language
    async function selectLanguage(code) {
        currentLang = code;
        updateLangButton(code);
        applyLanguage(code);
        // Re-apply current export state to fix dynamic text overwritten by applyLanguage
        if (lastExportState) {
            updateUI(lastExportState);
        }
        buildLangDropdown(); // rebuild to update active state
        closeLangDropdown();

        // Save to settings
        currentSettings.language = code;
        await sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    }

    // Toggle dropdown
    function toggleLangDropdown() {
        const isOpen = !langDropdown.classList.contains('hidden');
        if (isOpen) {
            closeLangDropdown();
        } else {
            openLangDropdown();
        }
    }

    function openLangDropdown() {
        langDropdown.classList.remove('hidden');
        langBtn.classList.add('active');
        // Dynamically extend .popup min-height so glass background covers the dropdown
        requestAnimationFrame(() => {
            const dropdownRect = langDropdown.getBoundingClientRect();
            const popupRect = popup.getBoundingClientRect();
            const neededHeight = dropdownRect.bottom - popupRect.top + 20;
            if (neededHeight > popupRect.height) {
                popup.style.minHeight = neededHeight + 'px';
            }
        });
    }

    function closeLangDropdown() {
        langDropdown.classList.add('hidden');
        langBtn.classList.remove('active');
        popup.style.minHeight = '';
    }

    langBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLangDropdown();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!langDropdown.classList.contains('hidden') && !e.target.closest('.lang-selector')) {
            closeLangDropdown();
        }
    });

    // Initialize language
    buildLangDropdown();
    updateLangButton(currentLang);
    applyLanguage(currentLang);

    // Helper to get translated text for dynamic content
    function t(key) {
        const translations = TRANSLATIONS[currentLang] || TRANSLATIONS['en'];
        return translations[key] || TRANSLATIONS['en'][key] || key;
    }

    // ==================== Tabs ====================
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        });
    });

    // ==================== Load Settings ====================
    if (currentSettings) {
        includeRetweets.checked = currentSettings.includeRetweets !== false;
        includeReplies.checked = currentSettings.includeReplies !== false;
        const savedLimit = currentSettings.quantityLimit ?? 500;
        // Check if saved limit matches a preset option
        const presetValues = ['0', '100', '500', '1000', '5000', '10000'];
        if (presetValues.includes(String(savedLimit))) {
            quantityLimit.value = String(savedLimit);
        } else {
            quantityLimit.value = 'custom';
            customQuantityRow.classList.remove('hidden');
            customQuantity.value = String(savedLimit);
        }
        cooldownMinutes.value = Math.round((currentSettings.cooldownDuration || 180000) / 60000);
        cooldownBatch.value = currentSettings.batchSize || 20;
    }

    // Show/hide custom quantity input based on select value
    quantityLimit.addEventListener('change', () => {
        if (quantityLimit.value === 'custom') {
            customQuantityRow.classList.remove('hidden');
            customQuantity.focus();
        } else {
            customQuantityRow.classList.add('hidden');
        }
        saveSettingsDebounced();
    });

    // Save settings on change
    const saveSettingsDebounced = debounce(async () => {
        let qLimit;
        if (quantityLimit.value === 'custom') {
            qLimit = parseInt(customQuantity.value) || 0;
        } else {
            qLimit = parseInt(quantityLimit.value) || 0;
        }
        await sendMessage({
            type: 'SAVE_SETTINGS',
            settings: {
                includeRetweets: includeRetweets.checked,
                includeReplies: includeReplies.checked,
                quantityLimit: qLimit,
                requestDelay: 3000,
                batchSize: parseInt(cooldownBatch.value) || 20,
                cooldownDuration: (parseInt(cooldownMinutes.value) || 3) * 60000,
                theme: document.body.classList.contains('light') ? 'light' : 'dark',
                language: currentLang
            }
        });
    }, 500);

    [includeRetweets, includeReplies, quantityLimit, cooldownMinutes, cooldownBatch, customQuantity].forEach(el => {
        el.addEventListener('change', saveSettingsDebounced);
    });
    customQuantity.addEventListener('input', saveSettingsDebounced);

    // ==================== Date Range Toggle ====================
    dateCheck.addEventListener('change', () => {
        dateFields.classList.toggle('hidden', !dateCheck.checked);
    });

    // ==================== Username Helpers ====================
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

    // Auto-clean input on paste or type (e.g. pasting a full URL)
    usernameInput.addEventListener('input', () => {
        const raw = usernameInput.value;
        // Only auto-clean if it looks like a URL or @handle
        if (raw.includes('x.com/') || raw.includes('twitter.com/') || raw.startsWith('@')) {
            const cleaned = extractUsernameFromInput(raw);
            if (cleaned && cleaned !== raw) {
                usernameInput.value = cleaned;
            }
        }
    });

    // ==================== Auto-fill Username from Active Tab ====================
    // Query the active tab URL directly — always fresh, no stale storage
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.url) {
            const tabUsername = extractUsernameFromInput(activeTab.url);
            if (tabUsername) {
                usernameInput.value = tabUsername;
            }
        }
    } catch (_) {
        // Fallback to stored username if tabs API fails
        const usernameResult = await sendMessage({ type: 'GET_USERNAME' });
        if (usernameResult?.username) {
            usernameInput.value = usernameResult.username;
        }
    }

    // ==================== Check Auth ====================
    try {
        const auth = await checkAuth();
        if (!auth) {
            authWarning.classList.remove('hidden');
            // Don't disable button — let the export attempt handle auth errors
            // startBtn.disabled = true;
        }
    } catch (e) {
        // cookies API may not be available from popup directly
    }

    // ==================== Check Existing Export State ====================
    const status = await sendMessage({ type: 'GET_STATUS' });
    if (status) {
        updateUI(status);
    }

    // ==================== Start Export ====================
    startBtn.addEventListener('click', async () => {
        try {
            const username = usernameInput.value.trim().replace('@', '');
            if (!username) {
                usernameInput.focus();
                usernameInput.style.borderColor = 'var(--danger)';
                setTimeout(() => usernameInput.style.borderColor = '', 2000);
                return;
            }

            const params = {
                type: 'START_EXPORT',
                username: username,
                dateFrom: dateCheck.checked ? dateFrom.value : null,
                dateTo: dateCheck.checked ? dateTo.value : null
            };

            const result = await sendMessage(params);
            if (result?.error) {
                alert(formatError(result.error));
                return;
            }

            updateUI({ running: true, status: 'resolving_user', username, tweetCount: 0 });
        } catch (err) {
            alert('Export error: ' + err.message);
        }
    });

    // ==================== Stop Export ====================
    stopBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'STOP_EXPORT' });
        updateUI({ running: false, status: 'stopped', tweetCount: parseInt(tweetCountEl.textContent) || 0 });
    });

    // ==================== Download CSV ====================
    downloadBtn.addEventListener('click', async () => {
        downloadBtn.disabled = true;
        downloadBtn.querySelector('[data-i18n="downloadCsv"]').textContent = t('preparing');
        const result = await sendMessage({ type: 'DOWNLOAD_CSV' });
        downloadBtn.disabled = false;
        if (result?.error) {
            alert(result.error);
        }
        downloadBtn.querySelector('[data-i18n="downloadCsv"]').textContent = t('downloadCsv');
    });

    // ==================== Resume ====================
    resumeBtn.addEventListener('click', async () => {
        // Update quantity limit before resuming
        const extraPosts = parseInt(resumeQuantity.value) || 100;
        const currentCount = lastTweetCount || 0;
        const newLimit = currentCount + extraPosts;

        // Save the new limit to settings
        await sendMessage({
            type: 'SAVE_SETTINGS',
            settings: {
                ...currentSettings,
                quantityLimit: newLimit
            }
        });

        const result = await sendMessage({ type: 'RESUME_EXPORT' });
        if (result?.error) {
            alert(result.error);
            return;
        }
        updateUI({ running: true, status: 'fetching', tweetCount: result.tweetCount || 0 });
    });

    // ==================== New Export ====================
    newExportBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'CLEAR_EXPORT' });
        updateUI({ running: false, status: 'idle' });
        // Auto-fill username from current X page
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab?.url) {
                const tabUsername = extractUsernameFromInput(activeTab.url);
                usernameInput.value = tabUsername || '';
            } else {
                usernameInput.value = '';
            }
        } catch (_) {
            usernameInput.value = '';
        }
        usernameInput.focus();
    });

    // ==================== UI Update Function ====================

    // ==================== Listen for Status Updates ====================
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'EXPORT_STATUS_UPDATE') {
            updateUI(message);
        }
    });

    function updateUI(state) {
        // Cache the state for language switch re-apply
        lastExportState = { ...state };

        const isRunning = state.running;
        const status = state.status;

        // Update cached values only if present in state
        if (state.tweetCount !== undefined && state.tweetCount !== null) {
            lastTweetCount = state.tweetCount;
        }
        if (state.expectedTweets) lastExpectedTweets = state.expectedTweets;
        if (state.quantityLimit !== undefined) lastQuantityLimit = state.quantityLimit;

        const tweetCount = lastTweetCount;

        // Show/hide elements based on state
        startBtn.classList.toggle('hidden', isRunning || status === 'complete' || status === 'stopped');
        stopBtn.classList.toggle('hidden', !isRunning);
        // Show download if we have tweets AND export is not actively running
        downloadBtn.classList.toggle('hidden', !((status === 'complete' || status === 'stopped') && tweetCount > 0));
        // Show resume on both stopped AND complete (user may want more posts)
        resumeRow.classList.toggle('hidden', !(status === 'stopped' || status === 'complete'));
        newExportBtn.classList.toggle('hidden', status !== 'complete' && status !== 'stopped' && status !== 'error');
        exportStatus.classList.toggle('hidden', status === 'idle');
        statusDetail.classList.remove('hidden');

        if (state.username) {
            usernameInput.value = state.username;
        }

        // Calculate progress percentage
        // Use quantityLimit as target if set, otherwise expectedTweets
        const target = (lastQuantityLimit > 0) ? lastQuantityLimit : (lastExpectedTweets || 1000);
        const progressPct = Math.min(100, Math.round(tweetCount / target * 100));

        // Helper to set status dot color
        function setDotColor(color) {
            statusIndicator.className = 'status-dot status-' + color;
        }

        // Update status display
        switch (status) {
            case 'resolving_user':
                statusText.textContent = `${t('lookingUp')} @${state.username}...`;
                setDotColor('green');
                statusMessage.textContent = t('resolvingUser');
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'fetching':
                statusText.textContent = `${t('exporting')} @${state.username || usernameInput.value}...`;
                setDotColor('green');
                statusMessage.textContent = `${t('fetching')} (${t('batch')} ${state.batch || 1})`;
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
                break;

            case 'cooldown':
                setDotColor('yellow');
                const seconds = Math.round((state.duration || 180000) / 1000);
                statusMessage.textContent = `${t('cooldown')} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
                // Keep progress bar position — don't change it
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
                break;

            case 'error':
                if (state.retryIn) {
                    setDotColor('red');
                    statusMessage.textContent = `${state.error} — ${t('retryIn')} ${Math.round(state.retryIn / 1000)}s`;
                } else {
                    statusText.textContent = `Error: ${formatError(state.error)}`;
                    setDotColor('red');
                    statusMessage.textContent = state.error;
                }
                // Keep progress bar position
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
                break;

            case 'retrying':
                setDotColor('yellow');
                statusMessage.textContent = `${t('retrying')} (${t('attempt')} ${state.attempt})...`;
                // Keep progress bar position
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
                break;

            case 'complete':
                statusText.innerHTML = ICONS.circleCheck + ` ${t('exportComplete')}`;
                setDotColor('green');
                statusMessage.textContent = t('canContinue');
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'stopped':
                statusText.innerHTML = ICONS.circlePause + ` ${t('exportStopped')}`;
                setDotColor('yellow');
                statusMessage.textContent = t('canBeResumed');
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
                break;
        }

        // Update tweet count display (always use cached value)
        tweetCountEl.innerHTML = `${Number(tweetCount).toLocaleString()} <span data-i18n="postsCollected">${t('postsCollected')}</span>`;
    }

    // ==================== Helpers ====================
    function sendMessage(msg) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn('sendMessage timeout for:', msg.type);
                resolve({});
            }, 3000);
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

    async function checkAuth() {
        return new Promise((resolve) => {
            chrome.cookies.get({ url: 'https://x.com', name: 'auth_token' }, (cookie) => {
                resolve(!!cookie);
            });
        });
    }

    function formatError(error) {
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

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }
});
