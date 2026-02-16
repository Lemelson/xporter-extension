// XPorter Popup — Logic (optimized)
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
    const autoExpireEnabled = document.getElementById('autoExpireEnabled');
    const autoExpireHours = document.getElementById('autoExpireHours');
    const autoExpireRow = document.getElementById('autoExpireRow');

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

    // ==================== Parallel Init ====================
    // Fire all independent async requests at once instead of sequentially
    const [settingsResult, authResult, status, activeTabs] = await Promise.all([
        sendMessage({ type: 'GET_SETTINGS' }),
        checkAuth().catch(() => null),
        sendMessage({ type: 'GET_STATUS' }),
        chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    ]);

    const currentSettings = settingsResult?.settings || {};

    // ==================== Theme & Design ====================
    // Apply saved theme (uses theme.js)
    initTheme(currentSettings.theme, themeIcon);

    // Theme toggle (dark <-> light)
    themeToggle.addEventListener('click', async () => {
        currentSettings.theme = toggleTheme(themeIcon);
        await sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    });

    // ==================== Language Selector ====================
    // Auto-detect Chrome UI language on first launch; respect saved choice afterwards
    let currentLang = currentSettings.language || detectBrowserLanguage();

    // If language was auto-detected (not saved yet), persist it immediately
    // so auto-detection only happens once — on the very first launch
    if (!currentSettings.language) {
        currentSettings.language = currentLang;
        sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    }

    // Lazy-build flag: dropdown is built only on first click
    let dropdownBuilt = false;

    // Build dropdown options (called lazily)
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
        dropdownBuilt = true;
    }

    // Update the language button display
    function updateLangButton(code) {
        const lang = LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
        langFlag.textContent = lang.flag;
        langCode.textContent = code.toUpperCase();
    }

    // Current translations cache (populated by applyLanguage)
    let currentTranslations = {};

    // Apply translations to all data-i18n elements — single-pass optimization
    async function applyLanguage(code) {
        const t = await loadTranslations(code);
        currentTranslations = t;

        // Single pass: translate all data-i18n, data-i18n-placeholder, data-i18n-title
        document.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title]').forEach(el => {
            const textKey = el.getAttribute('data-i18n');
            if (textKey && t[textKey] !== undefined) {
                el.textContent = t[textKey];
            }
            const placeholderKey = el.getAttribute('data-i18n-placeholder');
            if (placeholderKey && t[placeholderKey] !== undefined) {
                el.placeholder = t[placeholderKey];
            }
            const titleKey = el.getAttribute('data-i18n-title');
            if (titleKey && t[titleKey] !== undefined) {
                el.title = t[titleKey];
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
        await applyLanguage(code);
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
        // Lazy-build on first open
        if (!dropdownBuilt) {
            buildLangDropdown();
        }
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

    // Initialize language (dropdown built lazily on first click)
    updateLangButton(currentLang);
    await applyLanguage(currentLang);

    // Helper to get translated text for dynamic content
    function t(key) {
        return currentTranslations[key] || key;
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
        // Auto-expire setting
        autoExpireEnabled.checked = currentSettings.autoExpireEnabled !== false;
        autoExpireHours.value = currentSettings.autoExpireHours || 4;
        autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
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

    // Toggle auto-expire hours visibility
    autoExpireEnabled.addEventListener('change', () => {
        autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
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
                language: currentLang,
                autoExpireEnabled: autoExpireEnabled.checked,
                autoExpireHours: Math.max(1, Math.min(48, parseInt(autoExpireHours.value) || 4))
            }
        });
    }, 500);

    [includeRetweets, includeReplies, quantityLimit, cooldownMinutes, cooldownBatch, customQuantity, autoExpireHours].forEach(el => {
        el.addEventListener('change', saveSettingsDebounced);
    });
    customQuantity.addEventListener('input', saveSettingsDebounced);

    // ==================== Date Range Toggle ====================
    dateCheck.addEventListener('change', () => {
        dateFields.classList.toggle('hidden', !dateCheck.checked);
    });

    // Username helpers are in utils.js (extractUsernameFromInput, RESERVED_PATHS)

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

    // ==================== Apply Auth Result ====================
    if (!authResult) {
        authWarning.classList.remove('hidden');
    }

    // ==================== Apply Export Status ====================
    if (status) {
        updateUI(status);
    }

    // ==================== Auto-fill Username from Active Tab ====================
    // Run AFTER updateUI so stale export state doesn't overwrite the fresh tab URL.
    // Only auto-fill when idle — never replace the username of an active/paused export.
    const isIdle = !status || status.status === 'idle' || !status.running;
    if (isIdle) {
        const activeTab = activeTabs[0];
        if (activeTab?.url) {
            const tabUsername = extractUsernameFromInput(activeTab.url);
            if (tabUsername) {
                usernameInput.value = tabUsername;
            }
        } else if (!activeTab) {
            // Fallback to stored username if tabs API failed
            const usernameResult = await sendMessage({ type: 'GET_USERNAME' });
            if (usernameResult?.username) {
                usernameInput.value = usernameResult.username;
            }
        }
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
                alert(formatError(result.error, t));
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
                    statusText.textContent = `Error: ${formatError(state.error, t)}`;
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

    // formatError uses the shared utils.js version with t() passed in
    // (sendMessage, checkAuth, extractUsernameFromInput, debounce are global from utils.js)
});
