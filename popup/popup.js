// XPorter Popup — Logic (optimized, multi-mode)
document.addEventListener('DOMContentLoaded', async () => {
    mountHomeSizing();
    // ==================== Elements ====================
    const popup = document.getElementById('popup');
    const usernameInput = document.getElementById('usernameInput');
    const usernameError = document.getElementById('usernameError');
    const targetAccountCard = document.getElementById('targetAccountCard');
    const exportMode = document.getElementById('exportMode');
    const outputFormat = document.getElementById('outputFormat');
    const outputFormatHint = document.getElementById('outputFormatHint');
    const postsOnlyOptions = document.getElementById('postsOnlyOptions');
    const dateCheck = document.getElementById('dateCheck');
    const dateFields = document.getElementById('dateFields');
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const copyBtn = document.getElementById('copyBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const resumeQuantity = document.getElementById('resumeQuantity');
    const resumeLabel = document.querySelector('.resume-label');
    const continuePostsOnlyBtn = document.getElementById('continuePostsOnlyBtn');
    const retryRepliesBtn = document.getElementById('retryRepliesBtn');
    const newExportBtn = document.getElementById('newExportBtn');
    const statusMessage = document.getElementById('statusMessage');
    const downloadPlanEl = document.getElementById('downloadPlan');
    const authWarning = document.getElementById('authWarning');

    const xlsxPhotoOptions = document.getElementById('xlsxPhotoOptions');
    const xlsxPhotoLinks = document.getElementById('xlsxPhotoLinks');
    const xlsxPhotoEmbed = document.getElementById('xlsxPhotoEmbed');
    const aboutRiskDialog = document.getElementById('aboutRiskDialog');
    const aboutRiskTitle = document.getElementById('aboutRiskTitle');
    const aboutRiskBody = document.getElementById('aboutRiskBody');
    const aboutRiskCancel = document.getElementById('aboutRiskCancel');
    const aboutRiskConfirm = document.getElementById('aboutRiskConfirm');
    const aboutRiskCountdownStatus = document.getElementById('aboutRiskCountdownStatus');
    const photoPermissionDialog = document.getElementById('photoPermissionDialog');
    const photoPermissionTitle = document.getElementById('photoPermissionTitle');
    const photoPermissionBody = document.getElementById('photoPermissionBody');
    const photoPermissionCancel = document.getElementById('photoPermissionCancel');
    const photoPermissionConfirm = document.getElementById('photoPermissionConfirm');
    const photoPermissionCountdownStatus =
        document.getElementById('photoPermissionCountdownStatus');
    const PHOTO_EMBED_ORIGIN = 'https://pbs.twimg.com/*';
    const PHOTO_PERMISSION_INTRO_KEY = 'xporter_photo_permission_intro_seen';
    const PHOTO_PERMISSION_INTRO_SECONDS = 5;
    const SETTINGS_LOAD_ATTEMPTS = 3;
    // Start/Resume/Stop can wait for the worker to abort in-flight requests
    // and flush saved progress (up to ~8 s); the default 5 s timeout is too short.
    const EXPORT_COMMAND_TIMEOUT = 15000;
    const dateRangeError = document.getElementById('dateRangeError');

    // Settings tab — posts-only elements
    const settingsBookmarksOnly = document.getElementById('settingsBookmarksOnly');

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
    let historyView = null;
    let lastDownloadPlan = null;
    let downloadPlanRequest = 0;
    let downloadInProgress = false;
    // Unknown saved state is not idle: starting a new export clears its rows.
    let statusAvailable = false;
    startBtn.disabled = true;
    exportMode.disabled = true;
    outputFormat.disabled = true;
    newExportBtn.disabled = true;
    let pendingXlsxPhotoChoice = Promise.resolve({ success: true });
    let resumeAddsItems = false;
    let currentTranslations = {};
    const { showToast, writeClipboardText } = XPorterPopupUI.mount({ popup, t });

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

    const exportStatusView = XPorterExportStatus.mount({
        t, modeLabel,
        getLocale: () => ({ language: currentLang, translations: currentTranslations })
    });

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
    // Set while a Stop request is unanswered; running renders then say
    // "Stopping…" instead of flipping back to an active-looking status.
    let stopPending = false;

    function handleStatusUpdate(state) {
        if (state.running && Date.now() < ignoreRunningUntil) return;
        if (!uiReady) {
            bufferedState = state;
            return;
        }
        updateUI(state);
    }

    // Busy-label source for re-rendering after a language switch: the latest
    // current-export progress event, or null while the request is preparing.
    let lastDownloadProgress = null;

    function renderDownloadProgress(message = lastDownloadProgress) {
        const downloadLabel = downloadBtn.querySelector('[data-i18n="download"]');
        if (!message) {
            downloadLabel.textContent = t('preparing');
            return;
        }
        if (message.stage === 'photos') {
            const current = formatNumber(message.photoCurrent || 0, currentLang);
            const total = formatNumber(message.photoTotal || 0, currentLang);
            downloadLabel.textContent = `${current} / ${total}`;
            statusMessage.textContent = templateText(
                'downloadStagePhotos',
                { current, total }
            );
        } else if (message.stage === 'building_xlsx') {
            downloadLabel.textContent = t('preparing');
            statusMessage.textContent = t('downloadStageBuildingXlsx');
        } else {
            downloadLabel.textContent =
                `${message.partNumber} / ${message.partCount}`;
            statusMessage.textContent = templateText(
                'downloadingPart',
                { current: message.partNumber, total: message.partCount }
            );
        }
    }

    function handleDownloadUpdate(message) {
        // History downloads report their own progress; they must never lock
        // or relabel the current export's Home controls. Missing = current.
        if (message.source === 'history') return;
        if (!uiReady) {
            bufferedDownloadUpdate = message;
            return;
        }
        if (message.type === 'DOWNLOAD_PROGRESS') {
            setDownloadBusy(true);
            lastDownloadProgress = message;
            renderDownloadProgress(message);
        } else if (message.type === 'DOWNLOAD_COMPLETE') {
            lastDownloadProgress = null;
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
                    lang: currentLang
                });
            }, 800);
        } else if (message.type === 'DOWNLOAD_ERROR') {
            lastDownloadProgress = null;
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
    const activeTabsPromise =
        chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const liveAccountContextPromise = activeTabsPromise.then(async ([activeTab]) => {
        if (!activeTab?.id ||
            !/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(activeTab.url || '')) {
            return null;
        }
        try {
            return await chrome.tabs.sendMessage(activeTab.id, {
                type: 'GET_ACCOUNT_CONTEXT'
            });
        } catch (_) {
            return null;
        }
    });
    // The worker applies defaults on read, so a loaded object is complete. A
    // failed read is retried; if it still fails the popup must not persist its
    // display fallbacks (or the browser language) over the user's real choices.
    async function loadSettingsWithRetry() {
        for (let attempt = 0; attempt < SETTINGS_LOAD_ATTEMPTS; attempt++) {
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
            const result = await sendMessage({ type: 'GET_SETTINGS' });
            if (result?.settings && typeof result.settings === 'object') return result.settings;
        }
        return null;
    }

    const [loadedSettings, authResult, status, activeTabs, currentAccountResult,
        liveAccountContext, photoPermissionIntroState] = await Promise.all([
        loadSettingsWithRetry(),
        checkAuth().catch(() => null),
        sendMessage({ type: 'GET_STATUS' }),
        activeTabsPromise,
        sendMessage({ type: 'GET_CURRENT_ACCOUNT' }).catch(() => null),
        liveAccountContextPromise,
        chrome.storage.local.get(PHOTO_PERMISSION_INTRO_KEY).catch(() => ({}))
    ]);

    const settingsLoaded = loadedSettings !== null;
    const currentSettings = settingsLoaded
        ? loadedSettings
        : markSettingsUnavailable({});
    let currentLang = currentSettings.language || detectBrowserLanguage();
    let photoPermissionIntroSeen =
        photoPermissionIntroState?.[PHOTO_PERMISSION_INTRO_KEY] === true;
    const activeTabSupportsAccountContext = Boolean(
        activeTabs[0]?.id &&
        /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(activeTabs[0].url || '')
    );
    // Reloading the extension disconnects content scripts in already-open X
    // tabs. Keep URL-based export available, but never silently hide recovery.
    const accountContextNotice = document.getElementById('accountContextNotice');
    accountContextNotice.classList.toggle('hidden',
        !activeTabSupportsAccountContext || Boolean(liveAccountContext));
    const reloadAccountTab = document.getElementById('reloadAccountTab');
    reloadAccountTab.addEventListener('click', async () => {
        const tabId = activeTabs[0]?.id;
        if (!activeTabSupportsAccountContext || !tabId) return;
        reloadAccountTab.disabled = true;
        try {
            await chrome.tabs.reload(tabId);
            window.close();
        } catch (_) {
            reloadAccountTab.disabled = false;
            showToast(t('accountContextUnavailable'), 'error');
        }
    });
    const detectedCurrentAccount = liveAccountContext
        ? (liveAccountContext.currentAccount || null)
        : (activeTabSupportsAccountContext ? null : (currentAccountResult?.account || null));
    const detectedTargetAccount = liveAccountContext?.targetAccount || null;

    const accountFields = XPorterAccountFields.mount({
        detectedCurrentAccount, detectedTargetAccount,
        getTranslations: () => currentTranslations
    });

    // ==================== Theme & Design ====================
    initTheme(XPorterThemes.resolve(currentSettings).mode);
    mountAppearanceSettings({ currentSettings, t, showToast });
    mountThemePicker({ currentSettings, t, showToast });

    // ==================== Export Mode Switching ====================
    function modeEmbedsXlsxPhotos(mode = exportMode.value) {
        if (mode === 'posts') return currentSettings.embedPostPhotos === true;
        if (mode === 'bookmarks') return currentSettings.embedBookmarkPhotos === true;
        return false;
    }

    function syncXlsxPhotoChoice(mode = exportMode.value) {
        const embeds = modeEmbedsXlsxPhotos(mode);
        xlsxPhotoEmbed.checked = embeds;
        xlsxPhotoLinks.checked = !embeds;
    }

    async function persistXlsxPhotoChoice(embeds, mode = exportMode.value) {
        const key = mode === 'bookmarks' ? 'embedBookmarkPhotos' : 'embedPostPhotos';
        const result = await persistSettingsPatch(currentSettings, { [key]: embeds });
        if (result?.success !== true) {
            syncXlsxPhotoChoice(mode);
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        } else {
            await refreshDownloadPlan(lastExportState);
        }
        return result;
    }

    function trackXlsxPhotoChoice(promise) {
        const tracked = Promise.resolve(promise).catch((error) => {
            showToast(formatError(error?.message || 'STORAGE_FULL', t), 'error');
            return { error: error?.message || 'STORAGE_FULL' };
        });
        pendingXlsxPhotoChoice = tracked;
        return tracked;
    }

    function applyModeUI(mode) {
        const isPostsMode = (mode === 'posts');
        const isBookmarksMode = (mode === 'bookmarks');
        const isPostRows = isPostsMode || isBookmarksMode;
        refreshQuantityLabels();
        // Show/hide posts-only options in Home tab
        postsOnlyOptions.classList.toggle('hidden', !isPostsMode);
        if (settingsBookmarksOnly) {
            settingsBookmarksOnly.classList.toggle('hidden', !isBookmarksMode);
        }
        accountFields.applyMode(mode);
        const txtOption = outputFormat.querySelector('option[value="txt"]');
        if (txtOption) txtOption.disabled = !isPostRows;
        if (!isPostRows && outputFormat.value === 'txt') outputFormat.value = 'csv';
        xlsxPhotoOptions.classList.toggle(
            'hidden',
            !isPostRows || outputFormat.value !== 'xlsx'
        );
        syncXlsxPhotoChoice(mode);
        outputFormatHint.classList.toggle(
            'hidden',
            !isPostRows || outputFormat.value !== 'txt'
        );
        window.XPorterMotion?.modeChanged(mode);
    }

    function refreshQuantityLabels() {
        localizeQuantityOptions(document.getElementById('quantityLimit'), currentLang,
            currentTranslations, exportMode.value === 'posts' && !dateCheck.checked);
    }

    // Apply saved mode or default
    if (currentSettings.exportMode) {
        exportMode.value = currentSettings.exportMode;
    }
    // The mode actually shown and accepted; a cancelled switch reverts to it.
    let committedMode = exportMode.value;

    // Switching modes clears the current export. Rows that exist only in the
    // current export (not stopped/error resumable state, nor a completed export
    // too large for the history payload) must not vanish behind a keypress —
    // arrow keys on a focused select fire `change` on Windows.
    function switchingModeLosesRows(state) {
        if (!state || state.running || !((state.tweetCount ?? 0) > 0)) return false;
        if (state.status === 'stopped' || state.status === 'error') return true;
        if (state.status !== 'complete') return false;
        const historyLimit = Number(XPORTER_CONFIG.EXPORT_HISTORY_DATA_LIMIT) || 5000;
        return state.tweetCount > historyLimit;
    }

    async function commitModeChange(nextMode) {
        const previousMode = committedMode;
        const previousFormat = currentSettings.outputFormat || outputFormat.value;
        exportMode.value = nextMode;
        applyModeUI(nextMode);
        const patch = { exportMode: nextMode };
        if (currentSettings.outputFormat !== outputFormat.value) patch.outputFormat = outputFormat.value;
        const result = await persistSettingsPatch(currentSettings, patch);
        if (result?.success !== true) {
            exportMode.value = committedMode;
            outputFormat.value = previousFormat;
            applyModeUI(committedMode);
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
            return;
        }
        // A stopped/completed/failed export belongs to the previous mode;
        // reset it like New Export (after confirmation when rows are at stake).
        const currentStatus = lastExportState?.status;
        if (currentStatus === 'stopped' || currentStatus === 'complete' || currentStatus === 'error') {
            const cleared = await sendMessage({ type: 'CLEAR_EXPORT' });
            if (cleared?.success !== true) {
                // Keep the existing rows and their controls together when the
                // worker refuses to clear (quota, active download, etc.).
                const rollback = await persistSettingsPatch(currentSettings, {
                    exportMode: previousMode,
                    outputFormat: previousFormat
                });
                exportMode.value = previousMode;
                outputFormat.value = previousFormat;
                applyModeUI(previousMode);
                if (rollback?.success !== true) {
                    showToast(formatError(rollback?.error || 'STORAGE_FULL', t), 'error');
                }
                showToast(formatError(cleared?.error || 'STORAGE_FULL', t), 'error');
                return;
            }
            updateUI({ running: false, status: 'idle' });
        }
        committedMode = nextMode;
    }

    exportMode.addEventListener('change', async () => {
        if (!statusAvailable) {
            exportMode.value = committedMode;
            return;
        }
        const nextMode = exportMode.value;
        if (nextMode === committedMode) return;
        if (switchingModeLosesRows(lastExportState)) {
            // Keep showing the current mode until the user explicitly agrees.
            exportMode.value = committedMode;
            const confirmed = await confirmAction({
                title: t('modeChangeTitle'),
                body: t('modeChangeBody'),
                confirm: t('modeChangeConfirm'),
                cancel: t('modeChangeCancel'),
                trigger: exportMode
            });
            if (!confirmed || exportMode.disabled) return;
        }
        await commitModeChange(nextMode);
    });

    // Apply saved output format
    if (currentSettings.outputFormat) {
        outputFormat.value = currentSettings.outputFormat;
    }
    applyModeUI(exportMode.value);
    outputFormat.addEventListener('change', async () => {
        applyModeUI(exportMode.value);
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

    // Persist the detected language only over a successfully loaded settings
    // object; after a failed read it could overwrite the user's saved choice.
    if (settingsLoaded && !currentSettings.language) {
        await persistSettingsPatch(currentSettings, { language: currentLang });
    }

    let dropdownBuilt = false;

    function buildLangDropdown() {
        langDropdown.innerHTML = '';
        LANGUAGES.forEach(lang => {
            const selected = lang.code === currentLang;
            const opt = document.createElement('button');
            opt.type = 'button';
            opt.className = 'lang-option' + (selected ? ' active' : '');
            opt.setAttribute('role', 'menuitemradio');
            opt.setAttribute('aria-checked', selected ? 'true' : 'false');
            opt.lang = lang.code;
            opt.tabIndex = -1;
            opt.innerHTML = `
                <span class="lang-option-flag" aria-hidden="true">${lang.flag}</span>
                <span class="lang-option-name">${lang.name}</span>
                <svg class="lang-option-check" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>
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
        // The visible flag + code is not a usable accessible name.
        langBtn.setAttribute('aria-label', templateText('languageButtonLabel', { language: lang.name }));
    }

    function templateText(key, values = {}) {
        return formatTemplate(t(key), values);
    }

    function setDownloadBusy(busy) {
        downloadInProgress = busy;
        downloadBtn.disabled = busy;
        xlsxPhotoLinks.disabled = busy;
        xlsxPhotoEmbed.disabled = busy;
        outputFormat.disabled = !statusAvailable || busy || !!lastExportState?.running;
        exportMode.disabled = !statusAvailable || busy || !!lastExportState?.running;
        newExportBtn.disabled = !statusAvailable || busy;
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
            if (!downloadInProgress) label.textContent = templateText('downloadRows', { count: formatNumber(plan?.count ?? lastItemCount, currentLang) });
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
            label.textContent = templateText('downloadRows', { count: formatNumber(plan.count ?? lastItemCount, currentLang) });
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
        localizeQuantityOptions(document.getElementById('quantityLimit'), code, t,
            exportMode.value === 'posts' && !dateCheck.checked);

        document.documentElement.lang = code;
        formatReleaseDates(code);
        applyLanguageDirection(code); // RTL for Arabic, LTR otherwise
        updateLangButton(code);
        applyModeUI(exportMode.value);
        updateResumeQuantityLabel();
    }

    function formatReleaseDates(code) {
        const formatters = {
            long: new Intl.DateTimeFormat(code, {
                year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
            }),
            short: new Intl.DateTimeFormat(code, {
                year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
            })
        };

        document.querySelectorAll('time[data-release-date]').forEach((time) => {
            const [year, month, day] = time.dateTime.split('-').map(Number);
            const formatter = formatters[time.dataset.dateStyle] || formatters.long;
            time.textContent = formatter.format(new Date(Date.UTC(year, month - 1, day)));
        });
    }

    // Re-render every language-dependent surface for the current language.
    async function renderLanguage(code) {
        updateLangButton(code);
        await applyLanguage(code);
        if (lastExportState) {
            updateUI(lastExportState);
        }
        // applyI18nToDOM resets the Download label; restore an active download.
        if (downloadInProgress) renderDownloadProgress();
        if (dropdownBuilt) buildLangDropdown();
        historyView?.refreshLanguage();
        seenPostsView?.refreshLanguage();
    }

    async function selectLanguage(code) {
        const previousLang = currentLang;
        const returnFocus = langDropdown.contains(document.activeElement);
        closeLangDropdown({ returnFocus });
        if (code === previousLang) return;
        currentLang = code;
        await (window.XPorterMotion?.viewTransition(() => renderLanguage(code)) ?? renderLanguage(code));

        const result = await persistSettingsPatch(currentSettings, { language: code });
        if (result?.success !== true) {
            currentLang = previousLang;
            await renderLanguage(previousLang);
            showToast(formatError(result?.error || 'STORAGE_FULL', t), 'error');
        }
    }

    function langOptions() {
        return Array.from(langDropdown.querySelectorAll('.lang-option'));
    }

    function focusLangOption(index) {
        const options = langOptions();
        if (options.length === 0) return;
        options[(index + options.length) % options.length].focus();
    }

    function openLangDropdown({ focusLast = false } = {}) {
        if (!dropdownBuilt) {
            buildLangDropdown();
        }
        langDropdown.classList.remove('hidden');
        langBtn.classList.add('active');
        langBtn.setAttribute('aria-expanded', 'true');
        // The menu scrolls within the fixed workspace height (workspace.css).
        // Growing the native action window here would clip its bottom controls.
        const options = langOptions();
        const selected = options.findIndex(option => option.classList.contains('active'));
        focusLangOption(focusLast ? options.length - 1 : Math.max(0, selected));
    }

    function closeLangDropdown({ returnFocus = false } = {}) {
        if (langDropdown.classList.contains('hidden')) return;
        langDropdown.classList.add('hidden');
        langBtn.classList.remove('active');
        langBtn.setAttribute('aria-expanded', 'false');
        if (returnFocus) langBtn.focus();
    }

    langBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (langDropdown.classList.contains('hidden')) openLangDropdown();
        else closeLangDropdown({ returnFocus: true });
    });

    langBtn.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openLangDropdown({ focusLast: event.key === 'ArrowUp' });
    });

    langDropdown.addEventListener('keydown', (event) => {
        const options = langOptions();
        const index = options.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') focusLangOption(index + 1);
        else if (event.key === 'ArrowUp') focusLangOption(index - 1);
        else if (event.key === 'Home') focusLangOption(0);
        else if (event.key === 'End') focusLangOption(options.length - 1);
        else if (event.key === 'Escape') closeLangDropdown({ returnFocus: true });
        else if (event.key === 'Tab') {
            // Close and continue the normal tab order from the menu button.
            closeLangDropdown({ returnFocus: true });
            return;
        } else return;
        event.preventDefault();
        event.stopPropagation();
    });

    document.addEventListener('click', (e) => {
        if (!langDropdown.classList.contains('hidden') && !e.target.closest('.lang-selector')) {
            closeLangDropdown();
        }
    });

    await applyLanguage(currentLang);
    if (!settingsLoaded) showToast(t('errSettingsUnavailable'), 'error');

    function t(key) {
        return translateKey(currentTranslations, key);
    }

    const aboutDialog = XPorterGuardedDialog.mount({
        popup, dialog: aboutRiskDialog,
        cancelButton: aboutRiskCancel, confirmButton: aboutRiskConfirm,
        countdownStatus: aboutRiskCountdownStatus
    });
    const photoDialog = XPorterGuardedDialog.mount({
        popup, dialog: photoPermissionDialog,
        cancelButton: photoPermissionCancel, confirmButton: photoPermissionConfirm,
        countdownStatus: photoPermissionCountdownStatus
    });
    let photoPermissionSelectionVersion = 0;

    // Destructive confirmations reuse the guarded risk dialog without the
    // five-second lock: the consequence is data loss, not an expensive request.
    function confirmAction({ title, body, confirm, cancel, trigger }) {
        return new Promise((resolve) => {
            aboutRiskTitle.textContent = title;
            aboutRiskBody.textContent = body;
            aboutRiskCancel.textContent = cancel || t('confirmCancel');
            aboutRiskConfirm.textContent = confirm;
            aboutDialog.open({
                trigger,
                seconds: 0,
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false)
            });
        });
    }

    function openAboutRiskDialog(kind, { trigger, onConfirm, onCancel }) {
        const isRetryRisk = kind === 'retries';
        aboutRiskTitle.textContent = t(isRetryRisk ? 'aboutRetryRiskTitle' : 'aboutEnableRiskTitle');
        aboutRiskBody.textContent = t(isRetryRisk ? 'aboutRetryRiskBody' : 'aboutEnableRiskBody');
        aboutRiskCancel.textContent = t('aboutRiskCancel');
        aboutRiskConfirm.textContent = t(isRetryRisk ? 'aboutRetryRiskConfirm' : 'aboutEnableRiskConfirm');
        aboutDialog.open({
            trigger, onConfirm, onCancel,
            waitingLabel: (action, remaining) => templateText('acknowledgementCountdown', {
                action, seconds: formatNumber(remaining, currentLang)
            })
        });
    }

    function openPhotoPermissionDialog(checkbox) {
        photoPermissionTitle.textContent = t('photoPermissionTitle');
        photoPermissionBody.innerHTML = renderHelpMarkup(t('photoPermissionBody'));
        photoPermissionCancel.textContent = t('photoPermissionCancel');
        photoPermissionConfirm.textContent = t('photoPermissionContinue');
        photoDialog.open({
            trigger: checkbox,
            seconds: PHOTO_PERMISSION_INTRO_SECONDS,
            waitingLabel: (_action, remaining) => templateText('photoPermissionWaiting', {
                seconds: formatNumber(remaining, currentLang)
            }),
            onConfirm() {
                // No await before the native permission request: preserve the click.
                trackXlsxPhotoChoice(requestAndSavePhotoEmbedPermission(checkbox, true));
            },
            onCancel() {
                checkbox.checked = false;
                xlsxPhotoLinks.checked = true;
            }
        });
    }

    const settingsForm = XPorterSettingsForm.mount({
        currentSettings, t, showToast, openAboutRiskDialog
    });

    // Photo embedding needs https://pbs.twimg.com/* access. That origin lives
    // in optional_host_permissions (never required), so extension updates
    // cannot disable existing installations — the 1.5.9 incident. The first
    // enable attempt explains the scope; its guarded Continue click is then
    // the direct user gesture that opens Chromium's native permission prompt.
    function requestPhotoEmbedPermission(checkbox) {
        if (!checkbox.checked) return Promise.resolve(true);
        if (typeof chrome === 'undefined' || !chrome.permissions?.request) {
            return Promise.resolve(true);
        }
        try {
            return chrome.permissions.request({ origins: [PHOTO_EMBED_ORIGIN] });
        } catch (_) {
            return Promise.resolve(false);
        }
    }

    async function requestAndSavePhotoEmbedPermission(checkbox, rememberIntro = false) {
        // Invoke request() before the first await. An async contains() preflight
        // consumes Chromium's transient user activation and can make the
        // native permission prompt fail even though this came from a click.
        const selectionVersion = photoPermissionSelectionVersion;
        const permissionRequest = requestPhotoEmbedPermission(checkbox);
        if (rememberIntro) {
            photoPermissionIntroSeen = true;
            try {
                const write = chrome.storage.local.set({
                    [PHOTO_PERMISSION_INTRO_KEY]: true
                });
                if (write?.catch) void write.catch(() => {});
            } catch (_) { /* the in-memory acknowledgement still avoids a loop */ }
        }
        let granted = false;
        try {
            granted = await permissionRequest;
        } catch (_) { /* fail closed below */ }
        if (selectionVersion !== photoPermissionSelectionVersion) {
            return { error: 'SELECTION_SUPERSEDED' };
        }
        if (!granted) {
            checkbox.checked = false;
            xlsxPhotoLinks.checked = true;
        }
        return await persistXlsxPhotoChoice(granted);
    }

    function handleEmbedPhotosChange(checkbox) {
        if (!checkbox.checked) {
            return;
        }
        photoPermissionSelectionVersion += 1;
        if (!photoPermissionIntroSeen) {
            openPhotoPermissionDialog(checkbox);
            return;
        }
        trackXlsxPhotoChoice(requestAndSavePhotoEmbedPermission(checkbox));
    }

    async function syncEmbedPhotoPermissionState() {
        if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return;
        const selectionVersion = photoPermissionSelectionVersion;
        let granted = false;
        try {
            granted = await chrome.permissions.contains({
                origins: [PHOTO_EMBED_ORIGIN]
            });
        } catch (_) { /* fail closed below */ }
        if (selectionVersion !== photoPermissionSelectionVersion) return;
        if (granted ||
            (currentSettings.embedPostPhotos !== true &&
                currentSettings.embedBookmarkPhotos !== true)) return;
        xlsxPhotoLinks.checked = true;
        xlsxPhotoEmbed.checked = false;
        await persistSettingsPatch(currentSettings, {
            embedPostPhotos: false,
            embedBookmarkPhotos: false
        });
    }

    xlsxPhotoLinks.addEventListener('change', () => {
        if (xlsxPhotoLinks.checked) {
            photoPermissionSelectionVersion += 1;
            trackXlsxPhotoChoice(persistXlsxPhotoChoice(false));
        }
    });
    xlsxPhotoEmbed.addEventListener('change', () => {
        if (xlsxPhotoEmbed.checked) handleEmbedPhotosChange(xlsxPhotoEmbed);
    });
    await syncEmbedPhotoPermissionState();
    resumeQuantity.addEventListener('input', updateResumeQuantityLabel);

    // ==================== Date Range Toggle ====================
    function setDateRangeInvalid(invalid) {
        dateRangeError.classList.toggle('hidden', !invalid);
        for (const input of [dateFrom, dateTo]) {
            if (invalid) input.setAttribute('aria-invalid', 'true');
            else input.removeAttribute('aria-invalid');
        }
    }

    // An enabled date filter needs at least one complete date. Otherwise the
    // worker would silently run an ordinary feed export instead.
    function dateRangeIsUsable() {
        const complete = input => Boolean(input.value) && !input.validity.badInput;
        const partial = input => input.validity.badInput;
        return !partial(dateFrom) && !partial(dateTo) && (complete(dateFrom) || complete(dateTo));
    }

    dateCheck.addEventListener('change', () => {
        dateFields.classList.toggle('hidden', !dateCheck.checked);
        setDateRangeInvalid(false);
        refreshQuantityLabels();
    });
    for (const input of [dateFrom, dateTo]) {
        input.addEventListener('input', () => setDateRangeInvalid(false));
    }

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
    } else {
        showToast(formatError(status?.error || 'MESSAGING_ERROR', t), 'error');
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
    // while running or waiting for a readable initial state, and visible.
    setInterval(async () => {
        if ((statusAvailable && !lastExportState?.running) || document.visibilityState !== 'visible') return;
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
    applyModeUI(exportMode.value);

    // "+N more" input: never send 0, negatives or more than the input allows.
    function resumeExtraItems() {
        const parsed = parseInt(resumeQuantity.value, 10);
        const min = Math.max(1, parseInt(resumeQuantity.min, 10) || 1);
        const max = parseInt(resumeQuantity.max, 10);
        const value = Math.max(min, Math.min(Number.isFinite(max) ? max : Infinity,
            Number.isFinite(parsed) ? parsed : 100));
        resumeQuantity.value = String(value);
        return value;
    }

    function updateResumeQuantityLabel() {
        if (!resumeLabel) return;
        const count = parseInt(resumeQuantity.value, 10) || 0;
        const mode = lastExportState?.exportMode || exportMode.value;
        const key = (mode === 'posts' || mode === 'bookmarks')
            ? 'morePosts'
            : 'moreUsers';
        resumeLabel.textContent = pluralLabel(key, count, currentLang, currentTranslations);
    }

    // Localized, emoji-stripped label for the history mode badge.
    function modeLabel(mode) {
        const key = {
            posts: 'modePosts',
            bookmarks: 'modeBookmarks',
            followers: 'modeFollowers',
            following: 'modeFollowing',
            verified_followers: 'modeVerifiedFollowers'
        }[mode] || 'modePosts';
        return t(key).replace(/^[^\p{L}]+/u, '').trim() || mode;
    }

    // ==================== Start Export ====================
    startBtn.addEventListener('click', async () => {
        if (startBtn.disabled) return;
        const rejectedStart = error => sendMessage({ type:'DIAGNOSTIC_START_REJECTED',
            error, mode:exportMode.value, format:outputFormat.value,
            dateRange:exportMode.value === 'posts' && dateCheck.checked });
        // One request at a time: a second click would otherwise be rejected
        // by the worker as ALREADY_RUNNING and shown as a false error.
        startBtn.disabled = true;
        try {
            const mode = exportMode.value;
            if (mode === 'posts' && !settingsForm.validatePostSelection()) {
                rejectedStart('NO_POST_TYPES_SELECTED'); return;
            }
            if (mode === 'posts' && dateCheck.checked && !dateRangeIsUsable()) {
                setDateRangeInvalid(true);
                (dateFrom.value && !dateFrom.validity.badInput ? dateTo : dateFrom).focus();
                showToast(t('errDateRangeRequired'), 'error');
                rejectedStart('INVALID_DATE_RANGE');
                return;
            }
            // extractUsernameFromInput returns '' for anything that is not a
            // valid username or X profile URL — never submit garbage.
            const username = mode === 'bookmarks'
                ? ''
                : extractUsernameFromInput(usernameInput.value);
            if (mode !== 'bookmarks' && (!username || !isValidUsername(username))) {
                usernameInput.focus();
                targetAccountCard.classList.add('is-invalid');
                usernameInput.setAttribute('aria-invalid', 'true');
                usernameError.classList.remove('hidden');
                // A silent red flash left first-time users stranded (churn
                // rows: opened popup, never started an export). Say what to do.
                showToast(t('errEnterUsername'), 'error');
                rejectedStart('INVALID_USERNAME');
                return;
            }
            targetAccountCard.classList.remove('is-invalid');
            usernameInput.removeAttribute('aria-invalid');
            usernameError.classList.add('hidden');

            ratePromptCounted = false; // fresh export — allow it to be counted again

            // Apply any pending settings edit before the worker snapshots
            // settings for this export.
            const settingsSave = await settingsForm.flush();
            if (settingsSave?.success !== true) {
                rejectedStart(settingsSave?.error || 'STORAGE_FULL');
                showToast(formatError(settingsSave?.error || 'STORAGE_FULL', t), 'error');
                return;
            }

            const params = {
                type: 'START_EXPORT',
                username: username,
                exportMode: mode,
                outputFormat: outputFormat.value,
                dateFrom: (mode === 'posts' && dateCheck.checked) ? dateFrom.value : null,
                dateTo: (mode === 'posts' && dateCheck.checked) ? dateTo.value : null
            };

            const result = await sendMessage(params, EXPORT_COMMAND_TIMEOUT);
            if (result?.error) {
                showToast(formatError(result.error, t), 'error');
                return;
            }

            updateUI({ running: true, status: 'resolving_user', username, tweetCount: 0, exportMode: mode });
        } catch (err) {
            showToast(`${t('exportError')}: ${err.message}`, 'error');
        } finally {
            startBtn.disabled = false;
        }
    });

    // ==================== Stop Export ====================
    stopBtn.addEventListener('click', async () => {
        if (stopBtn.disabled) return;
        stopPending = true;
        stopBtn.disabled = true;
        statusMessage.textContent = t('ovStopping');
        // In-flight `running:true` broadcasts must not flip the UI back
        // after the local stopped render below.
        ignoreRunningUntil = Date.now() + 1500;
        const result = await sendMessage({ type: 'STOP_EXPORT' }, EXPORT_COMMAND_TIMEOUT);
        if (result?.error === 'TIMEOUT') {
            // The worker may still be aborting and saving. Keep "Stopping…"
            // and let the status poll/broadcast report the real outcome.
            ignoreRunningUntil = 0;
            stopBtn.disabled = false; // a repeated Stop is harmless
            const fresh = await sendMessage({ type: 'GET_STATUS' });
            if (fresh?.status) handleStatusUpdate(fresh);
            return;
        }
        stopPending = false;
        stopBtn.disabled = false;
        if (result?.success !== true) {
            ignoreRunningUntil = 0;
            showToast(formatError(result?.error || 'MESSAGING_ERROR', t), 'error');
            if (lastExportState) updateUI(lastExportState);
            return;
        }
        updateUI({
            ...lastExportState,
            running: false,
            status: 'stopped',
            tweetCount: lastItemCount || 0
        });
        // The worker may have saved a different terminal state (e.g. complete).
        const fresh = await sendMessage({ type: 'GET_STATUS' });
        if (fresh?.status && !fresh.running) handleStatusUpdate(fresh);
    });

    // ==================== Download ====================
    downloadBtn.addEventListener('click', async () => {
        setDownloadBusy(true);
        lastDownloadProgress = null;
        renderDownloadProgress();
        await pendingXlsxPhotoChoice;
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
            sendMessage({ type: 'DIAGNOSTIC_CLIPBOARD_COPIED' });
            showToast(t('contactCopied'), 'success');
        } else {
            showToast(result?.error ? formatError(result.error, t) : t('errCopyFailed'), 'error');
        }
    });

    // ==================== Resume ====================
    resumeBtn.addEventListener('click', async () => {
        if (resumeBtn.disabled) return;
        const message = { type: 'RESUME_EXPORT' };
        // "+N more" belongs only to a completed export. Stopped/error Resume
        // must preserve the original target instead of silently replacing,
        // for example, a 500-item export with the input's default 100.
        if (resumeAddsItems) message.extraItems = resumeExtraItems();
        resumeBtn.disabled = true;
        let result;
        try {
            result = await sendMessage(message, EXPORT_COMMAND_TIMEOUT);
        } finally {
            resumeBtn.disabled = downloadInProgress;
        }
        if (result?.error) {
            showToast(formatError(result.error, t), 'error');
            return;
        }
        if (await renderRefusedResume(result)) return;
        updateUI({
            ...lastExportState,
            running: true,
            status: 'fetching',
            tweetCount: result.tweetCount || 0,
            partialReason: result.partialReason ?? lastExportState.partialReason ?? null,
            completionReason: null
        });
    });

    // A successful Resume reply can carry a terminal status instead of a
    // running export (for example `complete` when the source was already
    // exhausted). Render the worker's saved state, never a fake "running".
    async function renderRefusedResume(result) {
        // An accepted Resume answers status 'resumed'.
        if (!['complete', 'stopped', 'error', 'idle'].includes(result?.status)) return false;
        const fresh = await sendMessage({ type: 'GET_STATUS' });
        updateUI(fresh?.status
            ? fresh
            : { ...lastExportState, ...result, running: false });
        return true;
    }

    async function resumeFromRepliesError(type) {
        continuePostsOnlyBtn.disabled = true;
        retryRepliesBtn.disabled = true;
        const result = await sendMessage({ type }, EXPORT_COMMAND_TIMEOUT);
        continuePostsOnlyBtn.disabled = false;
        retryRepliesBtn.disabled = false;
        if (result?.error) {
            showToast(formatError(result.error, t), 'error');
            return;
        }
        if (await renderRefusedResume(result)) return;
        updateUI({
            running: true,
            status: 'fetching',
            tweetCount: result.tweetCount || 0,
            partialReason: result.partialReason || null
        });
    }

    continuePostsOnlyBtn.addEventListener('click', () =>
        resumeFromRepliesError('RESUME_POSTS_ONLY'));
    retryRepliesBtn.addEventListener('click', () =>
        resumeFromRepliesError('RESUME_EXPORT'));

    // ==================== New Export ====================
    newExportBtn.addEventListener('click', async () => {
        if (!statusAvailable || newExportBtn.disabled) return;
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
        applyModeUI(exportMode.value);
        if (exportMode.value !== 'bookmarks') usernameInput.focus();
    });

    // ==================== Rate Prompt ====================
    // About: low-pressure, always-available link straight to the store.
    if (rateAboutBtn) {
        rateAboutBtn.addEventListener('click', () => {
            window.XPorterRatePrompt?.rateNow();
        });
    }

    // ==================== UI Update Function ====================
    function updateUI(state) {
        if (!state?.status) return;
        if (!statusAvailable) {
            statusAvailable = true;
            startBtn.disabled = false;
            newExportBtn.disabled = downloadInProgress;
        }
        lastExportState = { ...state };
        if (state.tweetCount != null) lastItemCount = state.tweetCount;
        if (state.expectedTweets != null) lastExpectedItems = state.expectedTweets;
        if (state.quantityLimit !== undefined) lastQuantityLimit = state.quantityLimit;
        const mode = state.exportMode || exportMode.value;
        exportMode.disabled = state.running || downloadInProgress;
        outputFormat.disabled = state.running || downloadInProgress;
        if (state.username && mode !== 'bookmarks') usernameInput.value = state.username;
        accountFields.updateExportAccount(state);
        if (!state.running && stopPending) {
            stopPending = false;
            stopBtn.disabled = false;
        }
        applyModeUI(mode);
        const view = exportStatusView.render({
            ...state,
            exportMode: mode,
            outputFormat: outputFormat.value,
            tweetCount: lastItemCount,
            expectedTweets: lastExpectedItems,
            quantityLimit: lastQuantityLimit
        }, { username: usernameInput.value });
        resumeAddsItems = view.resumeAddsItems;
        // A Stop request is still settling: never show an active status line.
        if (state.running && stopPending) statusMessage.textContent = t('ovStopping');
        if (state.status === 'complete' && !ratePromptCounted) {
            ratePromptCounted = true;
            window.XPorterRatePrompt?.incrementExports(ratePromptExportKey(state));
        }
        updateResumeQuantityLabel();
        void refreshDownloadPlan(state);
    }

    // ==================== Export History ====================
    historyView = XPorterHistory.mount({
        t,
        showToast,
        modeLabel,
        confirmAction,
        getLanguage: () => currentLang
    });
    seenPostsView = XPorterSeenPosts.mount({
        t,
        showToast,
        confirmAction,
        getLanguage: () => currentLang
    });
    // Later state changes are user-driven and may animate (motion.js).
    document.dispatchEvent(new Event('xporter:ready'));
});
