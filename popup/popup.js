// XPorter Popup — Logic (optimized, multi-mode)
document.addEventListener('DOMContentLoaded', async () => {
    // ==================== Elements ====================
    const popup = document.getElementById('popup');
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const usernameInput = document.getElementById('usernameInput');
    const exportMode = document.getElementById('exportMode');
    const outputFormat = document.getElementById('outputFormat');
    const postsOnlyOptions = document.getElementById('postsOnlyOptions');
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

    // Settings tab — posts-only elements
    const settingsPostsOnly = document.getElementById('settingsPostsOnly');

    // Language selector elements
    const langBtn = document.getElementById('langBtn');
    const langFlag = document.getElementById('langFlag');
    const langCode = document.getElementById('langCode');
    const langDropdown = document.getElementById('langDropdown');
    const extensionVersion = document.getElementById('extensionVersion');

    // Cache values for updateUI — must be declared before any updateUI call
    let lastItemCount = 0;
    let lastExpectedItems = 0;
    let lastQuantityLimit = 0;
    let lastExportState = null; // cached state for language switch re-apply

    if (extensionVersion && chrome.runtime?.getManifest) {
        extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;
    }

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
    initTheme(currentSettings.theme, themeIcon);

    themeToggle.addEventListener('click', async () => {
        currentSettings.theme = toggleTheme(themeIcon);
        await sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    });

    // ==================== Export Mode Switching ====================
    function applyModeUI(mode) {
        const isPostsMode = (mode === 'posts');
        // Show/hide posts-only options in Home tab
        postsOnlyOptions.classList.toggle('hidden', !isPostsMode);
        // Show/hide posts-only settings in Settings tab
        if (settingsPostsOnly) {
            settingsPostsOnly.classList.toggle('hidden', !isPostsMode);
        }
    }

    // Apply saved mode or default
    if (currentSettings.exportMode) {
        exportMode.value = currentSettings.exportMode;
    }
    applyModeUI(exportMode.value);

    exportMode.addEventListener('change', async () => {
        applyModeUI(exportMode.value);
        currentSettings.exportMode = exportMode.value;
        sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });

        // If there's an active/stopped/completed export, auto-reset (like New Export)
        const currentStatus = lastExportState?.status;
        if (currentStatus === 'stopped' || currentStatus === 'complete' || currentStatus === 'error') {
            await sendMessage({ type: 'CLEAR_EXPORT' });
            updateUI({ running: false, status: 'idle' });
        }
    });

    // Apply saved output format
    if (currentSettings.outputFormat) {
        outputFormat.value = currentSettings.outputFormat;
    }
    outputFormat.addEventListener('change', () => {
        currentSettings.outputFormat = outputFormat.value;
        sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    });

    // ==================== Language Selector ====================
    let currentLang = currentSettings.language || detectBrowserLanguage();

    if (!currentSettings.language) {
        currentSettings.language = currentLang;
        sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    }

    let dropdownBuilt = false;

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

    function updateLangButton(code) {
        const lang = LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
        langFlag.textContent = lang.flag;
        langCode.textContent = code.toUpperCase();
    }

    let currentTranslations = {};

    async function applyLanguage(code) {
        const t = await loadTranslations(code);
        currentTranslations = t;

        // Apply all data-i18n attributes via shared utility
        applyI18nToDOM(t);

        // Update quantity limit options
        const options = quantityLimit.querySelectorAll('option');
        if (options.length >= 1) options[0].textContent = t.unlimited || 'Unlimited';
        if (options.length >= 2) options[1].textContent = `100 ${t.posts || 'posts'}`;
        if (options.length >= 3) options[2].textContent = `500 ${t.posts || 'posts'}`;
        if (options.length >= 4) options[3].textContent = `1,000 ${t.posts || 'posts'}`;
        if (options.length >= 5) options[4].textContent = `5,000 ${t.posts || 'posts'}`;
        if (options.length >= 6) options[5].textContent = `10,000 ${t.posts || 'posts'}`;
        if (options.length >= 7) options[6].textContent = t.custom || 'Custom';

        document.documentElement.lang = code;
    }

    async function selectLanguage(code) {
        currentLang = code;
        updateLangButton(code);
        await applyLanguage(code);
        if (lastExportState) {
            updateUI(lastExportState);
        }
        buildLangDropdown();
        closeLangDropdown();

        currentSettings.language = code;
        await sendMessage({ type: 'SAVE_SETTINGS', settings: { ...currentSettings } });
    }

    function toggleLangDropdown() {
        const isOpen = !langDropdown.classList.contains('hidden');
        if (isOpen) {
            closeLangDropdown();
        } else {
            openLangDropdown();
        }
    }

    function openLangDropdown() {
        if (!dropdownBuilt) {
            buildLangDropdown();
        }
        langDropdown.classList.remove('hidden');
        langBtn.classList.add('active');
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

    document.addEventListener('click', (e) => {
        if (!langDropdown.classList.contains('hidden') && !e.target.closest('.lang-selector')) {
            closeLangDropdown();
        }
    });

    updateLangButton(currentLang);
    await applyLanguage(currentLang);

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
        autoExpireEnabled.checked = currentSettings.autoExpireEnabled !== false;
        autoExpireHours.value = currentSettings.autoExpireHours || 4;
        autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
    }

    quantityLimit.addEventListener('change', () => {
        if (quantityLimit.value === 'custom') {
            customQuantityRow.classList.remove('hidden');
            customQuantity.focus();
        } else {
            customQuantityRow.classList.add('hidden');
        }
        saveSettingsDebounced();
    });

    autoExpireEnabled.addEventListener('change', () => {
        autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
        saveSettingsDebounced();
    });

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
                exportMode: exportMode.value,
                outputFormat: outputFormat.value,
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

    // Auto-clean input on paste or type
    usernameInput.addEventListener('input', () => {
        const raw = usernameInput.value;
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
    const isIdle = !status || status.status === 'idle' || !status.running;
    if (isIdle) {
        const activeTab = activeTabs[0];
        if (activeTab?.url) {
            const tabUsername = extractUsernameFromInput(activeTab.url);
            if (tabUsername) {
                usernameInput.value = tabUsername;
            }
        } else if (!activeTab) {
            const usernameResult = await sendMessage({ type: 'GET_USERNAME' });
            if (usernameResult?.username) {
                usernameInput.value = usernameResult.username;
            }
        }
    }

    // ==================== Helper: mode-specific item label ====================
    function itemLabel() {
        const mode = exportMode.value;
        if (mode === 'followers' || mode === 'verified_followers') return t('usersCollected') || 'users collected';
        if (mode === 'following') return t('usersCollected') || 'users collected';
        return t('postsCollected');
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

            const mode = exportMode.value;
            const params = {
                type: 'START_EXPORT',
                username: username,
                exportMode: mode,
                outputFormat: outputFormat.value,
                dateFrom: (mode === 'posts' && dateCheck.checked) ? dateFrom.value : null,
                dateTo: (mode === 'posts' && dateCheck.checked) ? dateTo.value : null
            };

            const result = await sendMessage(params);
            if (result?.error) {
                alert(formatError(result.error, t));
                return;
            }

            updateUI({ running: true, status: 'resolving_user', username, tweetCount: 0, exportMode: mode });
        } catch (err) {
            alert('Export error: ' + err.message);
        }
    });

    // ==================== Stop Export ====================
    stopBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'STOP_EXPORT' });
        updateUI({ running: false, status: 'stopped', tweetCount: parseInt(tweetCountEl.textContent) || 0 });
    });

    // ==================== Download ====================
    downloadBtn.addEventListener('click', async () => {
        downloadBtn.disabled = true;
        downloadBtn.querySelector('[data-i18n="download"]').textContent = t('preparing');
        const result = await sendMessage({ type: 'DOWNLOAD_EXPORT', outputFormat: outputFormat.value });
        downloadBtn.disabled = false;
        if (result?.error) {
            alert(result.error);
        }
        downloadBtn.querySelector('[data-i18n="download"]').textContent = t('download');
    });

    // ==================== Resume ====================
    resumeBtn.addEventListener('click', async () => {
        const extraPosts = parseInt(resumeQuantity.value) || 100;
        const currentCount = lastItemCount || 0;
        const newLimit = currentCount + extraPosts;

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

    // ==================== Listen for Status Updates ====================
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'EXPORT_STATUS_UPDATE') {
            updateUI(message);
        }
    });

    // ==================== UI Update Function ====================
    function updateUI(state) {
        lastExportState = { ...state };

        const isRunning = state.running;
        const status = state.status;
        const mode = state.exportMode || exportMode.value;

        // Update cached values
        if (state.tweetCount !== undefined && state.tweetCount !== null) {
            lastItemCount = state.tweetCount;
        }
        if (state.expectedTweets) lastExpectedItems = state.expectedTweets;
        if (state.quantityLimit !== undefined) lastQuantityLimit = state.quantityLimit;

        const itemCount = lastItemCount;
        const label = (mode === 'posts') ? t('postsCollected') : (t('usersCollected') || 'users collected');

        // Show/hide elements
        startBtn.classList.toggle('hidden', isRunning || status === 'complete' || status === 'stopped');
        stopBtn.classList.toggle('hidden', !isRunning);
        downloadBtn.classList.toggle('hidden', !((status === 'complete' || status === 'stopped') && itemCount > 0));
        resumeRow.classList.toggle('hidden', !(status === 'stopped' || status === 'complete'));
        newExportBtn.classList.toggle('hidden', status !== 'complete' && status !== 'stopped' && status !== 'error');
        exportStatus.classList.toggle('hidden', status === 'idle');
        statusDetail.classList.remove('hidden');

        // Lock mode selector only during active export (not when stopped/complete)
        exportMode.disabled = isRunning;
        outputFormat.disabled = isRunning;

        if (state.username) {
            usernameInput.value = state.username;
        }

        // Calculate progress
        const target = (lastQuantityLimit > 0) ? lastQuantityLimit : (lastExpectedItems || 1000);
        const progressPct = Math.min(100, Math.round(itemCount / target * 100));

        function setDotColor(color) {
            statusIndicator.className = 'status-dot status-' + color;
        }

        // Status-specific display
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
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
                break;

            case 'retrying':
                setDotColor('yellow');
                statusMessage.textContent = `${t('retrying')} (${t('attempt')} ${state.attempt})...`;
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

        // Update count display
        tweetCountEl.innerHTML = `${Number(itemCount).toLocaleString()} <span>${label}</span>`;
    }

    // ==================== Export History ====================
    const historyToggle = document.getElementById('historyToggle');
    const historyChevron = document.getElementById('historyChevron');
    const historyList = document.getElementById('historyList');
    const historyEmpty = document.getElementById('historyEmpty');

    historyToggle.addEventListener('click', async () => {
        const isOpen = !historyList.classList.contains('hidden');
        historyList.classList.toggle('hidden');
        historyChevron.classList.toggle('open');
        if (!isOpen) {
            await loadAndRenderHistory();
        }
    });

    async function loadAndRenderHistory() {
        const result = await sendMessage({ type: 'GET_EXPORT_HISTORY' });
        const history = result?.history || [];
        renderHistory(history);
    }

    function renderHistory(history) {
        // Clear existing cards (preserve empty placeholder)
        historyList.querySelectorAll('.history-card, .history-clear-btn').forEach(el => el.remove());

        if (history.length === 0) {
            historyEmpty.classList.remove('hidden');
            return;
        }
        historyEmpty.classList.add('hidden');

        history.forEach((entry, index) => {
            const card = document.createElement('div');
            card.className = 'history-card';
            card.dataset.id = entry.id;

            // Avatar
            if (entry.profileImageUrl) {
                const avatar = document.createElement('img');
                avatar.className = 'history-avatar';
                avatar.src = entry.profileImageUrl;
                avatar.alt = entry.displayName || entry.username;
                avatar.onerror = () => {
                    // Replace broken image with placeholder
                    const ph = document.createElement('div');
                    ph.className = 'history-avatar-placeholder';
                    ph.textContent = (entry.displayName || entry.username || '?')[0].toUpperCase();
                    avatar.replaceWith(ph);
                };
                card.appendChild(avatar);
            } else {
                const ph = document.createElement('div');
                ph.className = 'history-avatar-placeholder';
                ph.textContent = (entry.displayName || entry.username || '?')[0].toUpperCase();
                card.appendChild(ph);
            }

            // Info block
            const info = document.createElement('div');
            info.className = 'history-info';

            const name = document.createElement('div');
            name.className = 'history-name';
            name.textContent = entry.displayName || entry.username;
            info.appendChild(name);

            const handle = document.createElement('div');
            handle.className = 'history-handle';
            handle.textContent = '@' + (entry.username || '');
            info.appendChild(handle);

            const meta = document.createElement('div');
            meta.className = 'history-meta';

            const badge = document.createElement('span');
            badge.className = 'history-badge';
            badge.textContent = (entry.exportMode || 'posts').replace('_', ' ');
            meta.appendChild(badge);

            const count = document.createTextNode(` · ${Number(entry.itemCount || 0).toLocaleString()} · ${(entry.outputFormat || 'csv').toUpperCase()}`);
            meta.appendChild(count);

            // Date
            if (entry.completedAt) {
                const dateStr = new Date(entry.completedAt).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric', year: 'numeric'
                });
                const dateSpan = document.createTextNode(` · ${dateStr}`);
                meta.appendChild(dateSpan);
            }
            info.appendChild(meta);
            card.appendChild(info);

            // Actions
            const actions = document.createElement('div');
            actions.className = 'history-actions';

            // Download button for entries whose data snapshot is still available.
            if (entry.hasData || Array.isArray(entry.items)) {
                const dlBtn = document.createElement('button');
                dlBtn.className = 'history-dl-btn';
                dlBtn.title = 'Download';
                dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
                dlBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    dlBtn.disabled = true;
                    const result = await sendMessage({
                        type: 'DOWNLOAD_HISTORY_ENTRY',
                        id: entry.id,
                        outputFormat: entry.outputFormat || 'csv'
                    });
                    dlBtn.disabled = false;
                    if (result?.error) {
                        alert(result.error);
                    }
                });
                actions.appendChild(dlBtn);
            }

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'history-del-btn';
            delBtn.title = 'Remove';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await sendMessage({ type: 'DELETE_HISTORY_ENTRY', id: entry.id });
                card.style.opacity = '0';
                card.style.transform = 'translateX(20px)';
                card.style.transition = 'opacity 0.25s, transform 0.25s';
                setTimeout(() => {
                    card.remove();
                    // Check if empty
                    if (!historyList.querySelector('.history-card')) {
                        historyEmpty.classList.remove('hidden');
                        const clearBtn = historyList.querySelector('.history-clear-btn');
                        if (clearBtn) clearBtn.remove();
                    }
                }, 250);
            });
            actions.appendChild(delBtn);
            card.appendChild(actions);

            historyList.appendChild(card);
        });

        // Clear all button
        if (history.length > 1) {
            const clearBtn = document.createElement('button');
            clearBtn.className = 'history-clear-btn';
            clearBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Clear all';
            clearBtn.addEventListener('click', async () => {
                await sendMessage({ type: 'CLEAR_HISTORY' });
                renderHistory([]);
            });
            historyList.appendChild(clearBtn);
        }
    }
});
