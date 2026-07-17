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
    const copyBtn = document.getElementById('copyBtn');
    const statusActionStack = document.getElementById('statusActionStack');
    const resumeBtn = document.getElementById('resumeBtn');
    const resumeRow = document.getElementById('resumeRow');
    const resumeQuantity = document.getElementById('resumeQuantity');
    const resumeLabel = document.querySelector('.resume-label');
    const newExportBtn = document.getElementById('newExportBtn');
    const exportStatus = document.getElementById('exportStatus');
    const statusText = document.getElementById('statusText');
    const statusDetail = document.getElementById('statusDetail');
    const statusIndicator = document.getElementById('statusIndicator');
    const statusMessage = document.getElementById('statusMessage');
    const progressFill = document.getElementById('progressFill');
    const tweetCountEl = document.getElementById('tweetCount');
    const downloadPlanEl = document.getElementById('downloadPlan');
    const authWarning = document.getElementById('authWarning');
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    // Settings elements
    const includeRetweets = document.getElementById('includeRetweets');
    const includeReplies = document.getElementById('includeReplies');
    const includeArticles = document.getElementById('includeArticles');
    const quantityLimit = document.getElementById('quantityLimit');
    const exportSpeed = document.getElementById('exportSpeed');
    const customSpeedRows = document.getElementById('customSpeedRows');
    const customDelaySec = document.getElementById('customDelaySec');
    const customCooldownMin = document.getElementById('customCooldownMin');
    const customBatchSize = document.getElementById('customBatchSize');
    const customQuantityRow = document.getElementById('customQuantityRow');
    const customQuantity = document.getElementById('customQuantity');
    const autoExpireEnabled = document.getElementById('autoExpireEnabled');
    const autoExpireHours = document.getElementById('autoExpireHours');
    const autoExpireRow = document.getElementById('autoExpireRow');
    const ladybugEnabled = document.getElementById('ladybugEnabled');
    const localizeExportHeaders = document.getElementById('localizeExportHeaders');

    // Settings tab — posts-only elements
    const settingsPostsOnly = document.getElementById('settingsPostsOnly');

    // Language selector elements
    const langBtn = document.getElementById('langBtn');
    const langFlag = document.getElementById('langFlag');
    const langCode = document.getElementById('langCode');
    const langDropdown = document.getElementById('langDropdown');
    const extensionVersion = document.getElementById('extensionVersion');

    // Rate-prompt elements + counter guard (one finished export counts once).
    const rateAboutBtn = document.getElementById('rateAboutBtn');
    let ratePromptCounted = false;

    // Cache values for updateUI — must be declared before any updateUI call
    let lastItemCount = 0;
    let lastExpectedItems = 0;
    let lastQuantityLimit = 0;
    let lastExportState = null; // cached state for language switch re-apply
    let seenPostsView = null;
    let lastDownloadPlan = null;
    let downloadPlanRequest = 0;
    let downloadInProgress = false;

    function ratePromptExportKey(state) {
        const completedAt = state?.completedAt || 'complete';
        const startedAt = state?.startedAt || 'unknown-start';
        const username = state?.username || usernameInput.value || 'unknown-user';
        const mode = state?.exportMode || exportMode.value || 'posts';
        const count = state?.tweetCount ?? lastItemCount ?? 0;
        return [startedAt, completedAt, username, mode, count].join('|');
    }

    if (extensionVersion && chrome.runtime?.getManifest) {
        extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    // ==================== Listen for Status Updates ====================
    // Registered BEFORE the awaited init chain so broadcasts that arrive while
    // the popup is still initializing are not lost. Until i18n is ready we
    // only buffer the latest state; it is re-rendered after init completes.
    let uiReady = false;
    let bufferedState = null;
    let bufferedDownloadUpdate = null;
    // A12: after a local Stop render, ignore stale `running:true` broadcasts
    // (already in flight from the SW) for a short grace period.
    let ignoreRunningUntil = 0;

    // Live cooldown countdown (shared ticker; driven by the SW's `until`).
    // Declared before the first updateUI call — updateUI stops it on every
    // non-cooldown render.
    // Which localized label the countdown uses — set per event from the SW's
    // `kind` ('pacing' = normal spacing, 'window' = X budget spent, 'batch' =
    // fallback batch cooldown).
    let cooldownLabelKey = 'cooldown';
    const cooldownTicker = createCooldownTicker((remaining) => {
        const countdown = cooldownLabelKey === 'statusPacing' && remaining < 60
            ? String(remaining)
            : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
        statusMessage.textContent = `${t(cooldownLabelKey)} ${countdown}`;
    });

    function handleStatusUpdate(state) {
        if (state.running && Date.now() < ignoreRunningUntil) return;
        if (!uiReady) {
            bufferedState = state;
            return;
        }
        updateUI(state);
    }

    function handleDownloadUpdate(message) {
        if (!uiReady) {
            bufferedDownloadUpdate = message;
            return;
        }
        if (message.type === 'DOWNLOAD_PROGRESS') {
            setDownloadBusy(true);
            downloadBtn.querySelector('[data-i18n="download"]').textContent =
                `${message.partNumber} / ${message.partCount}`;
            statusMessage.textContent = templateText(
                'downloadingPart',
                { current: message.partNumber, total: message.partCount }
            );
        } else if (message.type === 'DOWNLOAD_COMPLETE') {
            setDownloadBusy(false);
            if (lastDownloadPlan) lastDownloadPlan = { ...lastDownloadPlan, active: false };
            renderDownloadPlan(lastDownloadPlan);
            showToast(
                message.partCount > 1
                    ? templateText('downloadPartsStarted', { count: message.partCount })
                    : t('downloadStarted'),
                'success'
            );
            setTimeout(() => {
                window.XPorterRatePrompt?.maybeShow({
                    translations: currentTranslations,
                    lang: currentLang,
                    onReportBug: openAboutTab
                });
            }, 800);
        } else if (message.type === 'DOWNLOAD_ERROR') {
            setDownloadBusy(false);
            if (lastDownloadPlan) lastDownloadPlan = { ...lastDownloadPlan, active: false };
            renderDownloadPlan(lastDownloadPlan);
            showToast(formatError(message.error || 'DOWNLOAD_FAILED', t), 'error');
        }
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'EXPORT_STATUS_UPDATE') {
            handleStatusUpdate(message);
        } else if (message.type === 'DOWNLOAD_PROGRESS' ||
            message.type === 'DOWNLOAD_COMPLETE' || message.type === 'DOWNLOAD_ERROR') {
            handleDownloadUpdate(message);
        }
    });

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
        const previousTheme = currentSettings.theme || 'dark';
        const nextTheme = toggleTheme(themeIcon);
        // Send only the changed key — a full snapshot would revert newer
        // settings saved elsewhere (the SW merge is shallow/partial).
        const result = await persistSettingsPatch(currentSettings, { theme: nextTheme });
        if (result?.success !== true) {
            initTheme(previousTheme, themeIcon);
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        }
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
        const txtOption = outputFormat.querySelector('option[value="txt"]');
        if (txtOption) txtOption.disabled = !isPostsMode;
        if (!isPostsMode && outputFormat.value === 'txt') outputFormat.value = 'csv';
    }

    // Apply saved mode or default
    if (currentSettings.exportMode) {
        exportMode.value = currentSettings.exportMode;
    }
    applyModeUI(exportMode.value);

    exportMode.addEventListener('change', async () => {
        const previousMode = currentSettings.exportMode || 'posts';
        const previousFormat = currentSettings.outputFormat || 'csv';
        applyModeUI(exportMode.value);
        const patch = { exportMode: exportMode.value };
        if (currentSettings.outputFormat !== outputFormat.value) patch.outputFormat = outputFormat.value;
        const result = await persistSettingsPatch(currentSettings, patch);
        if (result?.success !== true) {
            exportMode.value = previousMode;
            outputFormat.value = previousFormat;
            applyModeUI(previousMode);
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
            return;
        }

        // If there's an active/stopped/completed export, auto-reset (like New Export)
        const currentStatus = lastExportState?.status;
        if (currentStatus === 'stopped' || currentStatus === 'complete' || currentStatus === 'error') {
            const cleared = await sendMessage({ type: 'CLEAR_EXPORT' });
            if (cleared?.success !== true) {
                showToast(formatError(cleared?.error || 'STORAGE_FULL', t), 'error');
                return;
            }
            updateUI({ running: false, status: 'idle' });
        }
    });

    // Apply saved output format
    if (currentSettings.outputFormat) {
        outputFormat.value = currentSettings.outputFormat;
    }
    applyModeUI(exportMode.value);
    outputFormat.addEventListener('change', async () => {
        const previousFormat = currentSettings.outputFormat || 'csv';
        const result = await persistSettingsPatch(currentSettings, { outputFormat: outputFormat.value });
        if (result?.success !== true) {
            outputFormat.value = previousFormat;
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        } else if (lastExportState) {
            updateUI(lastExportState);
        }
    });

    // ==================== Language Selector ====================
    let currentLang = currentSettings.language || detectBrowserLanguage();

    if (!currentSettings.language) {
        await persistSettingsPatch(currentSettings, { language: currentLang });
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
        const lang = LANGUAGES.find(l => l.code === code) || LANGUAGES.find(l => l.code === 'en');
        langFlag.textContent = lang.flag;
        langCode.textContent = code.toUpperCase();
    }

    let currentTranslations = {};

    function templateText(key, values = {}) {
        let text = t(key);
        for (const [name, value] of Object.entries(values)) {
            text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
    }

    function setDownloadBusy(busy) {
        downloadInProgress = busy;
        downloadBtn.disabled = busy;
        outputFormat.disabled = busy || !!lastExportState?.running;
        exportMode.disabled = busy || !!lastExportState?.running;
        newExportBtn.disabled = busy;
        resumeBtn.disabled = busy;
    }

    function renderDownloadPlan(plan) {
        lastDownloadPlan = plan || null;
        const label = downloadBtn.querySelector('[data-i18n="download"]');
        if (plan?.active) {
            setDownloadBusy(true);
        }
        if (!plan?.multipart) {
            downloadPlanEl.classList.add('hidden');
            downloadPlanEl.textContent = '';
            if (!downloadInProgress) label.textContent = t('download');
            return;
        }

        const hint = templateText('multipartDownloadHint', {
            count: formatNumber(plan.partCount, currentLang),
            format: String(plan.format || outputFormat.value).toUpperCase(),
            partSize: formatNumber(plan.partSize, currentLang)
        });
        downloadPlanEl.textContent = plan.format === 'csv'
            ? hint
            : `${hint} ${t('largeExportCsvTip')}`;
        downloadPlanEl.classList.remove('hidden');
        if (!downloadInProgress) {
            label.textContent = templateText('downloadFiles', { count: plan.partCount });
        }
        if (outputFormat.value === 'txt') copyBtn.classList.add('hidden');
    }

    async function refreshDownloadPlan(state = lastExportState) {
        const request = ++downloadPlanRequest;
        const terminal = state && !state.running &&
            (state.status === 'complete' || state.status === 'stopped' || state.status === 'error') &&
            (state.tweetCount ?? lastItemCount) > 0;
        if (!terminal) {
            renderDownloadPlan(null);
            return;
        }

        const plan = await sendMessage({
            type: 'GET_DOWNLOAD_PLAN',
            outputFormat: outputFormat.value
        });
        if (request !== downloadPlanRequest || plan?.error) return;
        renderDownloadPlan(plan);
    }

    async function applyLanguage(code) {
        const t = await loadTranslations(code);
        currentTranslations = t;

        // Apply all data-i18n attributes via shared utility
        applyI18nToDOM(t);

        // Update quantity limit options (shared: locale-aware number grouping)
        localizeQuantityOptions(quantityLimit, code, t);

        document.documentElement.lang = code;
        applyLanguageDirection(code); // RTL for Arabic, LTR otherwise
        updateResumeQuantityLabel();
    }

    async function selectLanguage(code) {
        const previousLang = currentLang;
        currentLang = code;
        updateLangButton(code);
        await applyLanguage(code);
        if (lastExportState) {
            updateUI(lastExportState);
        }
        buildLangDropdown();
        closeLangDropdown();

        const result = await persistSettingsPatch(currentSettings, { language: code });
        if (result?.success !== true) {
            currentLang = previousLang;
            updateLangButton(previousLang);
            await applyLanguage(previousLang);
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        }
        seenPostsView?.refreshLanguage();
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
        langBtn.setAttribute('aria-expanded', 'true');
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
        langBtn.setAttribute('aria-expanded', 'false');
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

    // ==================== Toast Notifications ====================
    // Replaces native alert() — keeps the glass aesthetic and is non-blocking.
    let toastContainer = null;
    function showToast(message, type = 'info') {
        if (!message) return;
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = 'toast-container';
            popup.appendChild(toastContainer);
        }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.textContent = message;
        toastContainer.appendChild(toast);
        // Force reflow then animate in
        requestAnimationFrame(() => toast.classList.add('toast-show'));
        setTimeout(() => {
            toast.classList.remove('toast-show');
            setTimeout(() => toast.remove(), 250);
        }, type === 'error' ? 4500 : 2800);
    }

    // ==================== Tabs ====================
    function activateTab(tab, focus = false) {
        tabs.forEach(t => {
            const selected = t === tab;
            t.classList.toggle('active', selected);
            t.setAttribute('aria-selected', selected ? 'true' : 'false');
            t.tabIndex = selected ? 0 : -1;
        });
        tabContents.forEach(c => c.classList.remove('active'));
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        if (focus) tab.focus();
    }

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', (event) => {
            let nextIndex = null;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            activateTab(tabs[nextIndex], true);
        });
    });
    activateTab(document.querySelector('.tab.active') || tabs[0]);

    async function writeClipboardText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fallback for older browsers / restricted clipboard access.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            let copied = false;
            try { copied = document.execCommand('copy'); } catch { /* noop */ }
            ta.remove();
            return copied;
        }
    }

    // ==================== Copy-to-clipboard (About tab email) ====================
    document.querySelectorAll('[data-copy]').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.preventDefault();
            const text = el.getAttribute('data-copy');
            if (!text) return;
            if (!await writeClipboardText(text)) {
                showToast(t('errCopyFailed'), 'error');
                return;
            }
            const target = el.closest('.email-action') || el;
            target.classList.add('is-copied');
            showToast(t('contactCopied') || 'Copied!', 'success');
            clearTimeout(el._copyTimer);
            el._copyTimer = setTimeout(() => target.classList.remove('is-copied'), 1800);
        });
    });

    // ==================== "How it works" accordion (About tab) ====================
    document.querySelectorAll('.detail-head').forEach(head => {
        head.addEventListener('click', () => {
            const item = head.closest('.detail-item');
            const isOpen = item.classList.toggle('open');
            head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
    });

    // ==================== Load Settings ====================
    if (currentSettings) {
        includeRetweets.checked = currentSettings.includeRetweets !== false;
        includeReplies.checked = currentSettings.includeReplies !== false;
        includeArticles.checked = currentSettings.includeArticles !== false;
        const savedLimit = currentSettings.quantityLimit ?? 500;
        const presetValues = ['0', '100', '500', '1000', '5000', '10000'];
        if (presetValues.includes(String(savedLimit))) {
            quantityLimit.value = String(savedLimit);
        } else {
            quantityLimit.value = 'custom';
            customQuantityRow.classList.remove('hidden');
            customQuantity.value = String(savedLimit);
        }
        exportSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom'].includes(currentSettings.exportSpeed)
            ? currentSettings.exportSpeed
            : 'standard';
        customDelaySec.value = currentSettings.customDelaySec || 5;
        customCooldownMin.value = currentSettings.customCooldownMin || 3;
        customBatchSize.value = currentSettings.customBatchSize || 20;
        customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');
        autoExpireEnabled.checked = currentSettings.autoExpireEnabled !== false;
        autoExpireHours.value = currentSettings.autoExpireHours || 4;
        autoExpireRow.classList.toggle('hidden', !autoExpireEnabled.checked);
        if (ladybugEnabled) {
            ladybugEnabled.checked = currentSettings.ladybugEnabled !== false;
            window.XPorterLadybug?.setEnabled?.(ladybugEnabled.checked);
        }
        if (localizeExportHeaders) {
            localizeExportHeaders.checked = currentSettings.localizeExportHeaders === true;
        }
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

    if (ladybugEnabled) {
        ladybugEnabled.addEventListener('change', () => {
            window.XPorterLadybug?.setEnabled?.(ladybugEnabled.checked);
            saveSettingsDebounced();
        });
    }

    // Clamp a typed number input to its own min/max attributes.
    function clampToInput(el, fallback) {
        const parsed = parseInt(el.value, 10);
        const value = Number.isFinite(parsed) ? parsed : fallback;
        const min = parseInt(el.min, 10);
        const max = parseInt(el.max, 10);
        return Math.max(Number.isFinite(min) ? min : value, Math.min(Number.isFinite(max) ? max : value, value));
    }

    const saveSettingsDebounced = debounce(async () => {
        let qLimit;
        if (quantityLimit.value === 'custom') {
            // Empty/0 custom value must keep the previous limit — never
            // silently persist 0 (= Unlimited).
            const parsed = parseInt(customQuantity.value, 10);
            qLimit = (parsed > 0) ? parsed : (currentSettings.quantityLimit ?? 500);
        } else {
            qLimit = parseInt(quantityLimit.value, 10) || 0;
        }
        const nextSettings = {
            includeRetweets: includeRetweets.checked,
            includeReplies: includeReplies.checked,
            includeArticles: includeArticles.checked,
            quantityLimit: qLimit,
            requestDelay: 3000,
            exportSpeed: exportSpeed.value || 'standard',
            customDelaySec: clampToInput(customDelaySec, 5),
            customCooldownMin: clampToInput(customCooldownMin, 3),
            customBatchSize: clampToInput(customBatchSize, 20),
            adaptivePacing: currentSettings?.adaptivePacing !== false,
            theme: document.body.classList.contains('light') ? 'light' : 'dark',
            language: currentLang,
            exportMode: exportMode.value,
            outputFormat: outputFormat.value,
            autoExpireEnabled: autoExpireEnabled.checked,
            autoExpireHours: clampToInput(autoExpireHours, 4),
            ladybugEnabled: ladybugEnabled ? ladybugEnabled.checked : true,
            localizeExportHeaders: localizeExportHeaders ? localizeExportHeaders.checked : false
        };
        // Send only values that this UI actually changed. A second open surface
        // may have updated another setting since our initial GET_SETTINGS; a
        // full stale snapshot would roll that newer value back.
        const patch = {};
        for (const [key, value] of Object.entries(nextSettings)) {
            if (currentSettings[key] !== value) patch[key] = value;
        }
        if (Object.keys(patch).length > 0) {
            return await persistSettingsPatch(currentSettings, patch);
        }
        return { success: true };
    }, 500);

    if (localizeExportHeaders) {
        localizeExportHeaders.addEventListener('change', saveSettingsDebounced);
    }

    exportSpeed.addEventListener('change', () => {
        customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');
    });

    [includeRetweets, includeReplies, includeArticles, quantityLimit, exportSpeed, customQuantity, autoExpireHours,
        customDelaySec, customCooldownMin, customBatchSize].forEach(el => {
        el.addEventListener('change', saveSettingsDebounced);
    });
    customQuantity.addEventListener('input', saveSettingsDebounced);
    resumeQuantity.addEventListener('input', updateResumeQuantityLabel);

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
    // i18n is ready — a broadcast buffered during init is newer than the
    // GET_STATUS snapshot, so it wins; otherwise render the snapshot.
    uiReady = true;
    if (bufferedState) {
        const buffered = bufferedState;
        bufferedState = null;
        handleStatusUpdate(buffered);
    } else if (status?.status) {
        updateUI(status);
    }
    if (bufferedDownloadUpdate) {
        const buffered = bufferedDownloadUpdate;
        bufferedDownloadUpdate = null;
        handleDownloadUpdate(buffered);
    }

    // Re-issue GET_STATUS once: catches transitions that happened while the
    // init chain was awaited (before the buffered listener could see them).
    sendMessage({ type: 'GET_STATUS' }).then((fresh) => {
        if (fresh?.status && !downloadInProgress) handleStatusUpdate(fresh);
    });

    // Safety poll: broadcasts can be dropped (SW restart, closed port). Poll
    // only while the last-known state is running and the popup is visible.
    setInterval(async () => {
        if (!lastExportState?.running || document.visibilityState !== 'visible') return;
        const fresh = await sendMessage({ type: 'GET_STATUS' });
        if (fresh?.status) handleStatusUpdate(fresh);
    }, 2000);

    // ==================== Auto-fill Username from Active Tab ====================
    // Only when truly idle — a finished export's username must not be
    // overwritten by whatever profile happens to be in the active tab.
    const isIdle = !status || status.status === 'idle';
    if (isIdle) {
        const activeTab = activeTabs[0];
        const tabUsername = activeTab?.url ? extractUsernameFromInput(activeTab.url) : '';
        if (tabUsername) {
            usernameInput.value = tabUsername;
        } else {
            // The active tab may be chrome://, a non-X page, or otherwise hide
            // its URL. Fall back to the last profile seen by content.js.
            const usernameResult = await sendMessage({ type: 'GET_USERNAME' });
            if (usernameResult?.username) {
                usernameInput.value = usernameResult.username;
            }
        }
    }

    function updateResumeQuantityLabel() {
        if (!resumeLabel) return;
        const count = parseInt(resumeQuantity.value, 10) || 0;
        const mode = lastExportState?.exportMode || exportMode.value;
        const key = (mode === 'posts') ? 'morePosts' : 'moreUsers';
        resumeLabel.textContent = pluralLabel(key, count, currentLang, currentTranslations);
    }

    // Localized, emoji-stripped label for the history mode badge.
    function modeLabel(mode) {
        const key = {
            posts: 'modePosts',
            followers: 'modeFollowers',
            following: 'modeFollowing',
            verified_followers: 'modeVerifiedFollowers'
        }[mode] || 'modePosts';
        return t(key).replace(/^[^\p{L}]+/u, '').trim() || mode;
    }

    // ==================== Start Export ====================
    startBtn.addEventListener('click', async () => {
        try {
            // extractUsernameFromInput returns '' for anything that is not a
            // valid username or X profile URL — never submit garbage.
            const username = extractUsernameFromInput(usernameInput.value);
            if (!username || !isValidUsername(username)) {
                usernameInput.focus();
                usernameInput.style.borderColor = 'var(--danger)';
                setTimeout(() => usernameInput.style.borderColor = '', 2000);
                // A silent red flash left first-time users stranded (churn
                // rows: opened popup, never started an export). Say what to do.
                showToast(t('errEnterUsername'), 'error');
                return;
            }

            ratePromptCounted = false; // fresh export — allow it to be counted again

            // Apply any pending settings edit before the worker snapshots
            // settings for this export.
            const settingsSave = await saveSettingsDebounced.flush();
            if (settingsSave?.success !== true) {
                showToast(formatError(settingsSave?.error || 'STORAGE_FULL', t), 'error');
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
                showToast(formatError(result.error, t), 'error');
                return;
            }

            updateUI({ running: true, status: 'resolving_user', username, tweetCount: 0, exportMode: mode });
        } catch (err) {
            showToast(`${t('exportError')}: ${err.message}`, 'error');
        }
    });

    // ==================== Stop Export ====================
    stopBtn.addEventListener('click', async () => {
        // In-flight `running:true` broadcasts must not flip the UI back
        // after the local stopped render below.
        ignoreRunningUntil = Date.now() + 1500;
        const result = await sendMessage({ type: 'STOP_EXPORT' });
        if (result?.success !== true) {
            ignoreRunningUntil = 0;
            showToast(formatError(result?.error || 'MESSAGING_ERROR', t), 'error');
            return;
        }
        updateUI({ running: false, status: 'stopped', tweetCount: lastItemCount || 0 });
    });

    // ==================== Download ====================
    downloadBtn.addEventListener('click', async () => {
        setDownloadBusy(true);
        downloadBtn.querySelector('[data-i18n="download"]').textContent = t('preparing');
        const result = await sendMessage({ type: 'DOWNLOAD_EXPORT', outputFormat: outputFormat.value });
        if (result?.success === true) {
            renderDownloadPlan(result);
        } else {
            setDownloadBusy(false);
            showToast(formatError(result?.error || 'DOWNLOAD_FAILED', t), 'error');
            renderDownloadPlan(lastDownloadPlan);
        }
    });

    copyBtn.addEventListener('click', async () => {
        copyBtn.disabled = true;
        const result = await sendMessage(
            { type: 'GET_EXPORT_TEXT' },
            XPORTER_CONFIG.DOWNLOAD_MESSAGE_TIMEOUT || 30000
        );
        let copied = false;
        if (result?.success === true && typeof result.text === 'string') {
            copied = await writeClipboardText(result.text);
        }
        copyBtn.disabled = false;
        if (copied) {
            showToast(t('contactCopied'), 'success');
        } else {
            showToast(result?.error ? formatError(result.error, t) : t('errCopyFailed'), 'error');
        }
    });

    // ==================== Resume ====================
    resumeBtn.addEventListener('click', async () => {
        const extraPosts = parseInt(resumeQuantity.value) || 100;

        // "+N more" applies to THIS export only (the SW turns it into a
        // per-export limit override). It used to be written into the saved
        // quantityLimit setting, permanently rewriting the user's configured
        // limit on every resume.
        const result = await sendMessage({ type: 'RESUME_EXPORT', extraItems: extraPosts });
        if (result?.error) {
            showToast(formatError(result.error, t), 'error');
            return;
        }
        updateUI({ running: true, status: 'fetching', tweetCount: result.tweetCount || 0 });
    });

    // ==================== New Export ====================
    newExportBtn.addEventListener('click', async () => {
        const cleared = await sendMessage({ type: 'CLEAR_EXPORT' });
        if (cleared?.success !== true) {
            showToast(formatError(cleared?.error || 'STORAGE_FULL', t), 'error');
            return;
        }
        updateUI({ running: false, status: 'idle' });
        ratePromptCounted = false;
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

    // ==================== Rate Prompt ====================
    // "Report a problem" in the prompt → jump to the About tab (Telegram/email).
    const openAboutTab = () => document.querySelector('.tab[data-tab="about"]')?.click();

    // About: low-pressure, always-available link straight to the store.
    if (rateAboutBtn) {
        rateAboutBtn.addEventListener('click', () => {
            window.XPorterRatePrompt?.rateNow();
        });
    }

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
        if (state.expectedTweets !== undefined && state.expectedTweets !== null) {
            lastExpectedItems = state.expectedTweets;
        }
        if (state.quantityLimit !== undefined) lastQuantityLimit = state.quantityLimit;

        const itemCount = lastItemCount;

        // Show/hide elements. A final error must still offer Download (data
        // was collected) and Resume (SW says it can continue) — otherwise
        // "New Export" is the only way out and destroys the collected data.
        const finalError = (status === 'error' && !isRunning);
        const showTerminalActions = (status === 'complete' || status === 'stopped' || finalError) && itemCount > 0;
        const showTxtCopy = showTerminalActions && mode === 'posts' && outputFormat.value === 'txt';
        startBtn.classList.toggle('hidden', isRunning || status === 'complete' || status === 'stopped');
        stopBtn.classList.toggle('hidden', !isRunning);
        downloadBtn.classList.toggle('hidden', !showTerminalActions);
        copyBtn.classList.toggle('hidden', !showTxtCopy);
        statusActionStack.classList.toggle('txt-actions', showTxtCopy);
        const canContinueComplete = status === 'complete' && itemCount > 0;
        resumeRow.classList.toggle('hidden', !(status === 'stopped' || canContinueComplete || (finalError && state.canResume)));
        newExportBtn.classList.toggle('hidden', status !== 'complete' && status !== 'stopped' && status !== 'error');
        exportStatus.classList.toggle('hidden', status === 'idle');
        statusDetail.classList.remove('hidden');

        // Lock mode selector only during active export (not when stopped/complete)
        exportMode.disabled = isRunning || downloadInProgress;
        outputFormat.disabled = isRunning || downloadInProgress;

        if (state.username) {
            usernameInput.value = state.username;
        }

        // Measured progress remains useful for paused/error states. While an
        // export is active, the bar instead communicates activity: blue while
        // fetching and a timed amber fill between requests.
        const hasTarget = lastQuantityLimit > 0 || lastExpectedItems > 0;
        const target = (lastQuantityLimit > 0) ? lastQuantityLimit : (lastExpectedItems || 1);
        const progressPct = Math.min(100, Math.round(itemCount / target * 100));

        // `live` adds a pulsing animation to the status dot while the export is
        // actively working (fetching / cooling down / retrying).
        function setDotColor(color, live = false) {
            statusIndicator.className = 'status-dot status-' + color + (live ? ' live' : '');
        }

        function setMeasuredProgress() {
            if (hasTarget) {
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = progressPct + '%';
            } else {
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
            }
        }

        // Cooldown tint is per-state; clear it before each render, re-add below.
        progressFill.classList.remove('cooldown');

        // Any non-cooldown status ends the live countdown.
        if (status !== 'cooldown') {
            cooldownTicker.stop();
            stopWaitProgress(progressFill);
        }

        // Status-specific display
        switch (status) {
            case 'resolving_user':
                statusText.textContent = `${t('lookingUp')} ${bidiIsolate('@' + state.username)}`;
                setDotColor('green', true);
                statusMessage.textContent = t('resolvingUser');
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'fetching':
                statusText.textContent = `${t('exporting').replace(/[.…\s]+$/, '')} ${bidiIsolate('@' + (state.username || usernameInput.value))}`;
                setDotColor('green', true);
                statusMessage.textContent = `${t('fetching')} (${t('batch')} ${state.batch || 1})`;
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'cooldown':
                setDotColor('yellow', true);
                // Pick the localized label for what this wait actually is —
                // "Cooldown" alone made normal pacing look like a penalty.
                cooldownLabelKey = state.kind === 'pacing' ? 'statusPacing'
                    : state.kind === 'window' ? 'statusRateLimitWait'
                        : 'cooldown';
                // Live countdown to the SW's absolute deadline (duration is
                // the fallback for events that predate `until`).
                cooldownTicker.start(state.until, state.duration || 180000);
                progressFill.classList.add('cooldown');
                startWaitProgress(progressFill, state.until, state.duration || 180000);
                break;

            case 'error':
                if (state.retryIn) {
                    setDotColor('red');
                    statusMessage.textContent = `${formatError(state.error, t)} — ${t('retryIn')} ${Math.round(state.retryIn / 1000)}s`;
                } else {
                    statusText.textContent = `${t('errorTitle')}: ${formatError(state.error, t)}`;
                    setDotColor('red');
                    // A dead rate-limited export reads as "waiting..." forever —
                    // tell the user the truth: progress is saved, come back and Resume.
                    if (state.error === 'NOT_LOGGED_IN') {
                        // Dead-end text loses first-run users — give them the
                        // actual login link using strings present in all locales.
                        statusMessage.textContent = '';
                        statusMessage.append(`${t('authWarning')} `);
                        const loginLink = document.createElement('a');
                        loginLink.href = 'https://x.com/login';
                        loginLink.target = '_blank';
                        loginLink.textContent = t('authLink');
                        statusMessage.append(loginLink);
                        const suffix = t('authSuffix');
                        statusMessage.append(`${suffix ? ' ' + suffix : ''}, ${t('thenTryAgain')}`);
                    } else {
                        statusMessage.textContent = (state.error === 'RATE_LIMITED' && state.canResume)
                            ? t('rateLimitedResumeHint')
                            : formatError(state.error, t);
                    }
                }
                setMeasuredProgress();
                break;

            case 'retrying':
                setDotColor('yellow');
                statusMessage.textContent = `${t('retrying')} (${t('attempt')} ${state.attempt})...`;
                setMeasuredProgress();
                break;

            case 'complete':
                // Icon markup is ours; the translated text goes in as a text
                // node so locale strings can never inject HTML.
                statusText.innerHTML = ICONS.circleCheck + ' ';
                statusText.appendChild(document.createTextNode(t('exportComplete')));
                setDotColor('green');
                statusMessage.textContent = itemCount > 0 ? t('canContinue') : t('errNoData');
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = '100%';
                if (!ratePromptCounted) {
                    ratePromptCounted = true;
                    window.XPorterRatePrompt?.incrementExports(ratePromptExportKey(state));
                }
                break;

            case 'stopped':
                statusText.innerHTML = ICONS.circlePause + ' ';
                statusText.appendChild(document.createTextNode(t('exportStopped')));
                setDotColor('yellow');
                statusMessage.textContent = t('canBeResumed');
                setMeasuredProgress();
                break;
        }

        // Update count display
        tweetCountEl.textContent = formatCollectedCount(itemCount, mode, currentLang, currentTranslations);

        // Resume label follows the export mode (posts vs user-list modes).
        updateResumeQuantityLabel();
        void refreshDownloadPlan(state);
    }

    // ==================== Export History ====================
    XPorterHistory.mount({
        t,
        showToast,
        modeLabel,
        getLanguage: () => currentLang
    });
    seenPostsView = XPorterSeenPosts.mount({
        t,
        showToast,
        getLanguage: () => currentLang
    });

});
