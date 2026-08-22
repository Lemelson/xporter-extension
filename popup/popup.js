// XPorter Popup — Logic (optimized, multi-mode)
document.addEventListener('DOMContentLoaded', async () => {
    // ==================== Elements ====================
    const popup = document.getElementById('popup');
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const usernameInput = document.getElementById('usernameInput');
    const usernameLabel = document.getElementById('usernameLabel');
    const usernamePrefix = document.getElementById('usernamePrefix');
    const usernameField = document.getElementById('usernameField');
    const bookmarksAccountField = document.getElementById('bookmarksAccountField');
    const bookmarksAccountName = document.getElementById('bookmarksAccountName');
    const bookmarksAccountHandle = document.getElementById('bookmarksAccountHandle');
    const bookmarksAccountAvatar = document.getElementById('bookmarksAccountAvatar');
    const bookmarksAccountAvatarFallback =
        document.getElementById('bookmarksAccountAvatarFallback');
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
    const statusActionStack = document.getElementById('statusActionStack');
    const resumeBtn = document.getElementById('resumeBtn');
    const resumeRow = document.getElementById('resumeRow');
    const resumeQuantity = document.getElementById('resumeQuantity');
    const resumeLabel = document.querySelector('.resume-label');
    const repliesFallbackActions = document.getElementById('repliesFallbackActions');
    const continuePostsOnlyBtn = document.getElementById('continuePostsOnlyBtn');
    const retryRepliesBtn = document.getElementById('retryRepliesBtn');
    const newExportBtn = document.getElementById('newExportBtn');
    const exportStatus = document.getElementById('exportStatus');
    const statusText = document.getElementById('statusText');
    const statusPhaseIcon = document.getElementById('statusPhaseIcon');
    const statusSubtitle = document.getElementById('statusSubtitle');
    const statusPhaseHelp = document.getElementById('statusPhaseHelp');
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
    const includeOriginalPosts = document.getElementById('includeOriginalPosts');
    const includeQuotes = document.getElementById('includeQuotes');
    const includeReplies = document.getElementById('includeReplies');
    const includeRetweets = document.getElementById('includeRetweets');
    const includeArticles = document.getElementById('includeArticles');
    const postSelectionPanel = document.getElementById('postSelectionPanel');
    const postSelectionCount = document.getElementById('postSelectionCount');
    const postSelectionNote = document.getElementById('postSelectionNote');
    const postSelectionError = document.getElementById('postSelectionError');
    const postOutputOptions = document.getElementById('postOutputOptions');
    const includeBookmarkReplyContext =
        document.getElementById('includeBookmarkReplyContext');
    const includeBookmarkArticles = document.getElementById('includeBookmarkArticles');
    const embedPostPhotos = document.getElementById('embedPostPhotos');
    const embedBookmarkPhotos = document.getElementById('embedBookmarkPhotos');
    const quantityLimit = document.getElementById('quantityLimit');
    const exportSpeed = document.getElementById('exportSpeed');
    const customSpeedRows = document.getElementById('customSpeedRows');
    const customDelaySec = document.getElementById('customDelaySec');
    const postSafetyBreakEnabled = document.getElementById('postSafetyBreakEnabled');
    const postSafetyBreakRows = document.getElementById('postSafetyBreakRows');
    const postSafetyBreakMin = document.getElementById('postSafetyBreakMin');
    const postSafetyBreakEvery = document.getElementById('postSafetyBreakEvery');
    const userExportSpeed = document.getElementById('userExportSpeed');
    const userCustomSpeedRows = document.getElementById('userCustomSpeedRows');
    const userCustomDelaySec = document.getElementById('userCustomDelaySec');
    const userSafetyBreakEnabled = document.getElementById('userSafetyBreakEnabled');
    const userSafetyBreakRows = document.getElementById('userSafetyBreakRows');
    const userSafetyBreakMin = document.getElementById('userSafetyBreakMin');
    const userSafetyBreakEvery = document.getElementById('userSafetyBreakEvery');
    const includeAboutAccountDetails = document.getElementById('includeAboutAccountDetails');
    const aboutAccountOptions = document.getElementById('aboutAccountOptions');
    const aboutAccountSpeed = document.getElementById('aboutAccountSpeed');
    const aboutAccountCustomRows = document.getElementById('aboutAccountCustomRows');
    const aboutAccountCustomBatchSize = document.getElementById('aboutAccountCustomBatchSize');
    const aboutAccountMaxRetries = document.getElementById('aboutAccountMaxRetries');
    const aboutRiskDialog = document.getElementById('aboutRiskDialog');
    const aboutRiskTitle = document.getElementById('aboutRiskTitle');
    const aboutRiskBody = document.getElementById('aboutRiskBody');
    const aboutRiskCancel = document.getElementById('aboutRiskCancel');
    const aboutRiskConfirm = document.getElementById('aboutRiskConfirm');
    const aboutRiskCountdownStatus = document.getElementById('aboutRiskCountdownStatus');
    const customQuantityRow = document.getElementById('customQuantityRow');
    const customQuantity = document.getElementById('customQuantity');
    const autoExpireEnabled = document.getElementById('autoExpireEnabled');
    const autoExpireHours = document.getElementById('autoExpireHours');
    const autoExpireRow = document.getElementById('autoExpireRow');
    const ladybugEnabled = document.getElementById('ladybugEnabled');
    const localizeExportHeaders = document.getElementById('localizeExportHeaders');

    // Long localized help must use the visible popup area below the tabs.
    // Recalculate on every open because Chromium can scroll the popup between
    // interactions, which changes whether the header and tabs are still visible.
    function positionViewportHelp(trigger) {
        const tooltip = trigger.querySelector(':scope > .help-pop');
        if (!tooltip) return;
        const tabsRect = document.querySelector('.tabs')?.getBoundingClientRect();
        const tabsAreVisible = tabsRect &&
            tabsRect.bottom > 0 &&
            tabsRect.top < window.innerHeight;
        const safeTop = tabsAreVisible ? Math.max(8, tabsRect.bottom + 8) : 8;
        const footerRect = document.querySelector('.footer')?.getBoundingClientRect();
        const safeBottom = footerRect && footerRect.top > 0 && footerRect.top < window.innerHeight
            ? footerRect.top - 8
            : window.innerHeight - 8;
        const triggerRect = trigger.getBoundingClientRect();
        const tooltipTop = trigger.classList.contains('help-below')
            ? Math.max(safeTop + 4, triggerRect.bottom + 8)
            : safeTop + 4;
        const maxHeight = Math.max(48, safeBottom - tooltipTop);
        // The active tab briefly animates with transform, so a fixed child can
        // unexpectedly become relative to that tab. Position explicitly from
        // the tooltip's actual offset parent to keep viewport geometry stable.
        const parentRect = tooltip.offsetParent?.getBoundingClientRect() ||
            trigger.parentElement.getBoundingClientRect();
        trigger.style.setProperty('--help-pop-safe-top', `${tooltipTop - parentRect.top}px`);
        trigger.style.setProperty('--help-pop-left', `${16 - parentRect.left}px`);
        trigger.style.setProperty('--help-pop-width', `${window.innerWidth - 32}px`);
        trigger.style.setProperty('--help-pop-max-height', `${maxHeight}px`);
    }

    document.querySelectorAll('.help-viewport').forEach((trigger) => {
        trigger.addEventListener('pointerenter', () => positionViewportHelp(trigger));
        trigger.addEventListener('pointermove', () => positionViewportHelp(trigger));
        trigger.addEventListener('focus', () => positionViewportHelp(trigger));
    });

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
    let lastDownloadPlan = null;
    let downloadPlanRequest = 0;
    let downloadInProgress = false;
    let resumeAddsItems = false;
    let bookmarksUsernameBackup = '';
    let detectedCurrentAccount = null;
    let currentTranslations = {};

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

    function clearStatusPhase() {
        exportStatus.classList.remove('phase-rate-limit', 'phase-safety-break');
        statusPhaseIcon.classList.add('hidden');
        statusPhaseIcon.replaceChildren();
        statusSubtitle.classList.add('hidden');
        statusSubtitle.textContent = '';
        statusPhaseHelp.classList.add('hidden');
    }

    function setStatusPhase(kind) {
        const isRateLimit = kind === 'rate-limit';
        const titleKey = isRateLimit ? 'statusRateLimitTitle' : 'statusSafetyBreakTitle';
        const subtitleKey = isRateLimit
            ? 'statusRateLimitSubtitle'
            : 'statusSafetyBreakSubtitle';
        const helpKey = isRateLimit ? 'statusRateLimitHelp' : 'statusSafetyBreakHelp';
        exportStatus.classList.add(
            isRateLimit ? 'phase-rate-limit' : 'phase-safety-break'
        );
        statusPhaseIcon.innerHTML = isRateLimit ? ICONS.rateLimit : ICONS.safetyBreak;
        statusPhaseIcon.classList.remove('hidden');
        statusText.textContent = t(titleKey);
        statusSubtitle.textContent = t(subtitleKey);
        statusSubtitle.classList.remove('hidden');
        const helpText = currentTranslations[helpKey] || helpKey;
        statusPhaseHelp.setAttribute('aria-label', stripHelpMarkup(helpText));
        const helpPop = statusPhaseHelp.querySelector(':scope > .help-pop');
        if (helpPop) helpPop.innerHTML = renderHelpMarkup(helpText);
        statusPhaseHelp.classList.remove('hidden');
    }

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
    const [settingsResult, authResult, status, activeTabs, currentAccountResult] = await Promise.all([
        sendMessage({ type: 'GET_SETTINGS' }),
        checkAuth().catch(() => null),
        sendMessage({ type: 'GET_STATUS' }),
        chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
        sendMessage({ type: 'GET_CURRENT_ACCOUNT' }).catch(() => null)
    ]);

    const currentSettings = settingsResult?.settings || {};
    detectedCurrentAccount = currentAccountResult?.account || null;

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
    const postTypeControls = [
        includeOriginalPosts,
        includeQuotes,
        includeReplies,
        includeRetweets,
        includeArticles
    ];

    function syncPostSelectionUI() {
        const selectedCount = postTypeControls.filter(control => control.checked).length;
        postSelectionCount.textContent = `${selectedCount}/${postTypeControls.length}`;
        postSelectionPanel.classList.toggle('is-empty', selectedCount === 0);
        postSelectionError.classList.toggle('hidden', selectedCount !== 0);
        const hasOtherTypes = postTypeControls.some(
            control => control !== includeReplies && control.checked
        );
        postSelectionNote.classList.toggle(
            'hidden',
            !includeReplies.checked || !hasOtherTypes
        );
        return selectedCount;
    }

    function applyModeUI(mode) {
        const isPostsMode = (mode === 'posts');
        const isBookmarksMode = (mode === 'bookmarks');
        const isPostRows = isPostsMode || isBookmarksMode;
        // Show/hide posts-only options in Home tab
        postsOnlyOptions.classList.toggle('hidden', !isPostsMode);
        if (settingsBookmarksOnly) {
            settingsBookmarksOnly.classList.toggle('hidden', !isBookmarksMode);
        }
        if (isBookmarksMode) {
            if (!usernameInput.disabled) bookmarksUsernameBackup = usernameInput.value;
            usernameInput.disabled = true;
            usernameInput.value = '';
            usernameField.classList.add('hidden');
            bookmarksAccountField.classList.remove('hidden');
            renderBookmarksAccount();
        } else {
            if (usernameInput.disabled) usernameInput.value = bookmarksUsernameBackup;
            usernameInput.disabled = false;
            usernameField.classList.remove('hidden');
            bookmarksAccountField.classList.add('hidden');
            usernameLabel.textContent =
                currentTranslations.fieldUsername || 'Twitter Username';
            usernamePrefix.classList.remove('hidden');
        }
        const txtOption = outputFormat.querySelector('option[value="txt"]');
        if (txtOption) txtOption.disabled = !isPostRows;
        if (!isPostRows && outputFormat.value === 'txt') outputFormat.value = 'csv';
        postOutputOptions.classList.toggle(
            'hidden',
            !isPostsMode || outputFormat.value !== 'xlsx'
        );
        outputFormatHint.classList.toggle(
            'hidden',
            !isPostRows || outputFormat.value !== 'txt'
        );
        syncPostSelectionUI();
    }

    function renderBookmarksAccount() {
        const account = detectedCurrentAccount || {};
        const username = String(account.username || '').replace(/^@/, '');
        bookmarksAccountName.textContent = account.name ||
            currentTranslations.signedInXAccount || 'Signed-in X account';
        bookmarksAccountHandle.textContent = username ? `@${username}` : '';
        bookmarksAccountHandle.classList.toggle('hidden', !username);

        const avatarUrl = String(account.avatarUrl || '');
        if (avatarUrl) {
            bookmarksAccountAvatar.src = avatarUrl;
            bookmarksAccountAvatar.classList.remove('hidden');
            bookmarksAccountAvatarFallback.classList.add('hidden');
        } else {
            bookmarksAccountAvatar.removeAttribute('src');
            bookmarksAccountAvatar.classList.add('hidden');
            bookmarksAccountAvatarFallback.classList.remove('hidden');
        }
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
        formatReleaseDates(code);
        applyLanguageDirection(code); // RTL for Arabic, LTR otherwise
        applyModeUI(exportMode.value);
        updateResumeQuantityLabel();
    }

    function formatReleaseDates(code) {
        const formatter = new Intl.DateTimeFormat(code, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        });

        document.querySelectorAll('time[data-release-date]').forEach((time) => {
            const [year, month, day] = time.dateTime.split('-').map(Number);
            time.textContent = formatter.format(new Date(Date.UTC(year, month - 1, day)));
        });
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

    const ABOUT_RETRY_WARNING_THRESHOLD = 60;
    let activeAboutRisk = null;
    let aboutRiskCountdown = null;

    function guardedButtonCountdown(button, readyLabel, statusElement) {
        return window.XPorterAcknowledgementTimer.start(button, {
            seconds: 5,
            readyLabel,
            waitingLabel: (action, seconds) => templateText(
                'acknowledgementCountdown',
                { action, seconds: formatNumber(seconds, currentLang) }
            ),
            onChange({ text }) {
                if (statusElement) statusElement.textContent = text;
            }
        });
    }

    function closeAboutRiskDialog(confirmed) {
        if (!activeAboutRisk) return;
        const action = activeAboutRisk;
        activeAboutRisk = null;
        aboutRiskCountdown?.cancel();
        aboutRiskCountdown = null;
        aboutRiskDialog.classList.add('hidden');
        popup.inert = false;
        if (confirmed) action.onConfirm();
        else action.onCancel();
        requestAnimationFrame(() => action.trigger?.focus());
    }

    function openAboutRiskDialog(kind, { trigger, onConfirm, onCancel }) {
        const isRetryRisk = kind === 'retries';
        aboutRiskTitle.textContent = t(isRetryRisk
            ? 'aboutRetryRiskTitle'
            : 'aboutEnableRiskTitle');
        aboutRiskBody.textContent = t(isRetryRisk
            ? 'aboutRetryRiskBody'
            : 'aboutEnableRiskBody');
        aboutRiskCancel.textContent = t('aboutRiskCancel');
        aboutRiskConfirm.textContent = t(isRetryRisk
            ? 'aboutRetryRiskConfirm'
            : 'aboutEnableRiskConfirm');
        aboutRiskCountdown?.cancel();
        aboutRiskCountdown = guardedButtonCountdown(
            aboutRiskConfirm,
            aboutRiskConfirm.textContent,
            aboutRiskCountdownStatus
        );
        activeAboutRisk = { trigger, onConfirm, onCancel };
        popup.inert = true;
        aboutRiskDialog.classList.remove('hidden');
        requestAnimationFrame(() => aboutRiskCancel.focus());
    }

    aboutRiskCancel.addEventListener('click', () => closeAboutRiskDialog(false));
    aboutRiskConfirm.addEventListener('click', () => closeAboutRiskDialog(true));
    aboutRiskDialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeAboutRiskDialog(false);
            return;
        }
        if (event.key !== 'Tab') return;
        const first = aboutRiskCancel;
        const last = aboutRiskConfirm;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

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

    // ==================== About-tab accordions ====================
    document.querySelectorAll('.detail-head').forEach(head => {
        head.addEventListener('click', () => {
            const item = head.closest('.detail-item');
            const isOpen = item.classList.toggle('open');
            head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
    });

    // ==================== Load Settings ====================
    let lastAcceptedAboutRetries = 5;
    if (currentSettings) {
        includeOriginalPosts.checked = currentSettings.includeOriginalPosts !== false;
        includeQuotes.checked = currentSettings.includeQuotes !== false;
        includeReplies.checked = currentSettings.includeReplies === true;
        includeRetweets.checked = currentSettings.includeRetweets === true;
        includeArticles.checked = currentSettings.includeArticles === true;
        syncPostSelectionUI();
        includeBookmarkReplyContext.checked =
            currentSettings.includeBookmarkReplyContext !== false;
        includeBookmarkArticles.checked =
            currentSettings.includeBookmarkArticles !== false;
        embedPostPhotos.checked = currentSettings.embedPostPhotos === true;
        embedBookmarkPhotos.checked = currentSettings.embedBookmarkPhotos === true;
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
        customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');
        postSafetyBreakEnabled.checked = currentSettings.postSafetyBreakEnabled === true;
        postSafetyBreakMin.value = currentSettings.postSafetyBreakMin ?? 3;
        postSafetyBreakEvery.value = currentSettings.postSafetyBreakEvery ?? 20;
        userExportSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom'].includes(currentSettings.userExportSpeed)
            ? currentSettings.userExportSpeed
            : 'standard';
        userCustomDelaySec.value = currentSettings.userCustomDelaySec || 5;
        userCustomSpeedRows.classList.toggle('hidden', userExportSpeed.value !== 'custom');
        userSafetyBreakEnabled.checked = currentSettings.userSafetyBreakEnabled === true;
        userSafetyBreakMin.value = currentSettings.userSafetyBreakMin ?? 3;
        userSafetyBreakEvery.value = currentSettings.userSafetyBreakEvery ?? 20;
        syncSafetyBreakVisibility();
        includeAboutAccountDetails.checked =
            currentSettings.includeAboutAccountDetails === true;
        aboutAccountSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom']
            .includes(currentSettings.aboutAccountSpeed)
            ? currentSettings.aboutAccountSpeed
            : 'standard';
        aboutAccountCustomBatchSize.value =
            currentSettings.aboutAccountCustomBatchSize || 5;
        aboutAccountMaxRetries.value =
            currentSettings.aboutAccountMaxRetries || 5;
        lastAcceptedAboutRetries = clampToInput(aboutAccountMaxRetries, 5);
        syncAboutAccountSpeedVisibility();
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

    function clampDecimalInput(el, fallback) {
        const parsed = parseLocalizedDecimal(el.value, fallback);
        const min = parseLocalizedDecimal(el.dataset.min, parsed);
        const max = parseLocalizedDecimal(el.dataset.max, parsed);
        return Math.max(min, Math.min(max, parsed));
    }

    function syncAboutAccountSpeedVisibility() {
        aboutAccountOptions.classList.toggle(
            'hidden',
            !includeAboutAccountDetails.checked
        );
        aboutAccountCustomRows.classList.toggle(
            'hidden',
            !includeAboutAccountDetails.checked || aboutAccountSpeed.value !== 'custom'
        );
    }

    function syncSafetyBreakVisibility() {
        postSafetyBreakRows.classList.toggle('hidden', !postSafetyBreakEnabled.checked);
        userSafetyBreakRows.classList.toggle('hidden', !userSafetyBreakEnabled.checked);
        postSafetyBreakEnabled.setAttribute(
            'aria-expanded',
            String(postSafetyBreakEnabled.checked)
        );
        userSafetyBreakEnabled.setAttribute(
            'aria-expanded',
            String(userSafetyBreakEnabled.checked)
        );
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
            postSelectionVersion: 1,
            includeOriginalPosts: includeOriginalPosts.checked,
            includeQuotes: includeQuotes.checked,
            includeReplies: includeReplies.checked,
            includeRetweets: includeRetweets.checked,
            includeArticles: includeArticles.checked,
            includeBookmarkReplyContext: includeBookmarkReplyContext.checked,
            includeBookmarkArticles: includeBookmarkArticles.checked,
            embedPostPhotos: embedPostPhotos.checked,
            embedBookmarkPhotos: embedBookmarkPhotos.checked,
            quantityLimit: qLimit,
            requestDelay: 3000,
            exportSpeed: exportSpeed.value || 'standard',
            customDelaySec: clampDecimalInput(customDelaySec, 5),
            postSafetyBreakEnabled: postSafetyBreakEnabled.checked,
            postSafetyBreakMin: clampDecimalInput(postSafetyBreakMin, 3),
            postSafetyBreakEvery: clampToInput(postSafetyBreakEvery, 20),
            userExportSpeed: userExportSpeed.value || 'standard',
            userCustomDelaySec: clampDecimalInput(userCustomDelaySec, 5),
            userSafetyBreakEnabled: userSafetyBreakEnabled.checked,
            userSafetyBreakMin: clampDecimalInput(userSafetyBreakMin, 3),
            userSafetyBreakEvery: clampToInput(userSafetyBreakEvery, 20),
            includeAboutAccountDetails: includeAboutAccountDetails.checked,
            aboutAccountSpeed: aboutAccountSpeed.value || 'standard',
            aboutAccountCustomBatchSize: clampToInput(aboutAccountCustomBatchSize, 5),
            aboutAccountMaxRetries: clampToInput(aboutAccountMaxRetries, 5),
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
    userExportSpeed.addEventListener('change', () => {
        userCustomSpeedRows.classList.toggle('hidden', userExportSpeed.value !== 'custom');
    });
    [postSafetyBreakEnabled, userSafetyBreakEnabled].forEach((control) => {
        control.addEventListener('change', syncSafetyBreakVisibility);
    });
    includeAboutAccountDetails.addEventListener('change', () => {
        if (!includeAboutAccountDetails.checked) {
            syncAboutAccountSpeedVisibility();
            saveSettingsDebounced();
            return;
        }

        // Revert until the consequence is explicitly confirmed. This prevents
        // the debounced settings save from enabling expensive requests behind
        // a dismissed warning.
        includeAboutAccountDetails.checked = false;
        syncAboutAccountSpeedVisibility();
        openAboutRiskDialog('enable', {
            trigger: includeAboutAccountDetails,
            onConfirm() {
                includeAboutAccountDetails.checked = true;
                syncAboutAccountSpeedVisibility();
                saveSettingsDebounced();
            },
            onCancel() {}
        });
    });
    aboutAccountSpeed.addEventListener('change', syncAboutAccountSpeedVisibility);
    aboutAccountMaxRetries.addEventListener('change', () => {
        const nextRetries = clampToInput(aboutAccountMaxRetries, 5);
        aboutAccountMaxRetries.value = String(nextRetries);
        if (nextRetries > ABOUT_RETRY_WARNING_THRESHOLD &&
            nextRetries !== lastAcceptedAboutRetries) {
            openAboutRiskDialog('retries', {
                trigger: aboutAccountMaxRetries,
                onConfirm() {
                    lastAcceptedAboutRetries = nextRetries;
                    saveSettingsDebounced();
                },
                onCancel() {
                    aboutAccountMaxRetries.value = String(lastAcceptedAboutRetries);
                }
            });
            return;
        }
        lastAcceptedAboutRetries = nextRetries;
        saveSettingsDebounced();
    });

    // Photo embedding needs https://pbs.twimg.com/* access. That origin lives
    // in optional_host_permissions (never required), so extension updates can
    // not disable existing installations — the 1.5.9 incident. The grant is
    // requested here, from the checkbox's own user gesture; declining keeps
    // ordinary URL-only exports fully functional.
    const PHOTO_EMBED_ORIGIN = 'https://pbs.twimg.com/*';
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
    async function handleEmbedPhotosChange(checkbox) {
        // Invoke request() before the first await. An async contains() preflight
        // consumes Chromium's transient user activation and can make the
        // permission prompt fail even though this handler came from a click.
        const permissionRequest = requestPhotoEmbedPermission(checkbox);
        let granted = false;
        try {
            granted = await permissionRequest;
        } catch (_) { /* fail closed below */ }
        if (!granted) {
            checkbox.checked = false;
        }
        saveSettingsDebounced();
    }

    async function syncEmbedPhotoPermissionState() {
        if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return;
        let granted = false;
        try {
            granted = await chrome.permissions.contains({
                origins: [PHOTO_EMBED_ORIGIN]
            });
        } catch (_) { /* fail closed below */ }
        if (granted || (!embedPostPhotos.checked && !embedBookmarkPhotos.checked)) return;
        embedPostPhotos.checked = false;
        embedBookmarkPhotos.checked = false;
        saveSettingsDebounced();
    }

    [includeOriginalPosts, includeQuotes, includeReplies, includeRetweets, includeArticles,
        includeBookmarkReplyContext, includeBookmarkArticles,
        quantityLimit, exportSpeed, customQuantity, autoExpireHours,
        customDelaySec, postSafetyBreakEnabled, postSafetyBreakMin, postSafetyBreakEvery,
        userExportSpeed, userCustomDelaySec, userSafetyBreakEnabled,
        userSafetyBreakMin, userSafetyBreakEvery,
        aboutAccountSpeed, aboutAccountCustomBatchSize].forEach(el => {
        el.addEventListener('change', saveSettingsDebounced);
    });
    embedPostPhotos.addEventListener('change', () => handleEmbedPhotosChange(embedPostPhotos));
    embedBookmarkPhotos.addEventListener('change', () => handleEmbedPhotosChange(embedBookmarkPhotos));
    void syncEmbedPhotoPermissionState();
    customQuantity.addEventListener('input', saveSettingsDebounced);
    postTypeControls.forEach(control => {
        control.addEventListener('change', syncPostSelectionUI);
    });
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
    applyModeUI(exportMode.value);
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
        try {
            const mode = exportMode.value;
            if (mode === 'posts' && syncPostSelectionUI() === 0) {
                postSelectionPanel.scrollIntoView({ block: 'nearest' });
                showToast(t('postSelectionRequired'), 'error');
                return;
            }
            // extractUsernameFromInput returns '' for anything that is not a
            // valid username or X profile URL — never submit garbage.
            const username = mode === 'bookmarks'
                ? ''
                : extractUsernameFromInput(usernameInput.value);
            if (mode !== 'bookmarks' && (!username || !isValidUsername(username))) {
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
        updateUI({
            ...lastExportState,
            running: false,
            status: 'stopped',
            tweetCount: lastItemCount || 0
        });
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
        const message = { type: 'RESUME_EXPORT' };
        // "+N more" belongs only to a completed export. Stopped/error Resume
        // must preserve the original target instead of silently replacing,
        // for example, a 500-item export with the input's default 100.
        if (resumeAddsItems) message.extraItems = extraPosts;
        const result = await sendMessage(message);
        if (result?.error) {
            showToast(formatError(result.error, t), 'error');
            return;
        }
        updateUI({
            ...lastExportState,
            running: true,
            status: 'fetching',
            tweetCount: result.tweetCount || 0,
            partialReason: result.partialReason ?? lastExportState.partialReason ?? null,
            completionReason: null
        });
    });

    async function resumeFromRepliesError(type) {
        continuePostsOnlyBtn.disabled = true;
        retryRepliesBtn.disabled = true;
        const result = await sendMessage({ type });
        continuePostsOnlyBtn.disabled = false;
        retryRepliesBtn.disabled = false;
        if (result?.error) {
            showToast(formatError(result.error, t), 'error');
            return;
        }
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
        const showTxtCopy = showTerminalActions &&
            (mode === 'posts' || mode === 'bookmarks') &&
            outputFormat.value === 'txt';
        startBtn.classList.toggle(
            'hidden',
            isRunning || status === 'complete' || status === 'stopped' || finalError
        );
        stopBtn.classList.toggle('hidden', !isRunning);
        downloadBtn.classList.toggle('hidden', !showTerminalActions);
        copyBtn.classList.toggle('hidden', !showTxtCopy);
        statusActionStack.classList.toggle('txt-actions', showTxtCopy);
        const canContinueComplete = status === 'complete' && itemCount > 0 &&
            state.completionReason !== 'source_exhausted';
        const showRepliesFallback = finalError && state.canFallbackWithoutReplies === true;
        resumeAddsItems = canContinueComplete;
        resumeQuantity.classList.toggle('hidden', !resumeAddsItems);
        resumeLabel?.classList.toggle('hidden', !resumeAddsItems);
        repliesFallbackActions.classList.toggle('hidden', !showRepliesFallback);
        resumeRow.classList.toggle(
            'hidden',
            showRepliesFallback ||
            !(status === 'stopped' || canContinueComplete || (finalError && state.canResume))
        );
        newExportBtn.classList.toggle('hidden', status !== 'complete' && status !== 'stopped' && status !== 'error');
        exportStatus.classList.toggle('hidden', status === 'idle');
        statusDetail.classList.remove('hidden');

        // Lock mode selector only during active export (not when stopped/complete)
        exportMode.disabled = isRunning || downloadInProgress;
        outputFormat.disabled = isRunning || downloadInProgress;

        if (state.username && mode !== 'bookmarks') {
            usernameInput.value = state.username;
        }
        applyModeUI(mode);

        const subject = mode === 'bookmarks'
            ? modeLabel('bookmarks')
            : bidiIsolate('@' + (state.username || usernameInput.value));

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

        // Wait styling is per-state; clear it before each render, re-add below.
        progressFill.classList.remove('cooldown', 'rate-limit', 'safety-break');
        clearStatusPhase();

        // Ordinary pacing and a real X rate-limit pause both own the live
        // countdown. Every other state stops it immediately.
        if (status !== 'cooldown' && status !== 'rate_limited') {
            cooldownTicker.stop();
            stopWaitProgress(progressFill);
        }

        // Status-specific display
        switch (status) {
            case 'resolving_user':
                statusText.textContent = `${t('lookingUp')} ${subject}`;
                setDotColor('green', true);
                statusMessage.textContent = t('resolvingUser');
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'fetching':
                statusText.textContent = `${t('exporting').replace(/[.…\s]+$/, '')} ${subject}`;
                setDotColor('green', true);
                statusMessage.textContent = state.partialReason === 'replies_unavailable'
                    ? `${t('postsOnlyFallbackActive')} · ${t('batch')} ${state.batch || 1}`
                    : `${t('fetching')} (${t('batch')} ${state.batch || 1})`;
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'cooldown':
                setDotColor('yellow', true);
                if (state.kind === 'batch') {
                    setStatusPhase('safety-break');
                    cooldownLabelKey = 'statusResumesIn';
                    progressFill.classList.add('safety-break');
                } else if (state.kind === 'window') {
                    setStatusPhase('rate-limit');
                    cooldownLabelKey = 'retryIn';
                    progressFill.classList.add('rate-limit');
                } else {
                    statusText.textContent =
                        `${t('exporting').replace(/[.…\s]+$/, '')} ${subject}`;
                    cooldownLabelKey = 'statusPacing';
                    progressFill.classList.add('cooldown');
                }
                // Live countdown to the SW's absolute deadline (duration is
                // the fallback for events that predate `until`).
                cooldownTicker.start(state.until, state.duration || 180000);
                startWaitProgress(progressFill, state.until, state.duration || 180000);
                break;

            case 'rate_limited':
                setStatusPhase('rate-limit');
                setDotColor('yellow', true);
                cooldownLabelKey = 'retryIn';
                cooldownTicker.start(state.until, state.duration || state.retryIn || 60000);
                progressFill.classList.add('rate-limit');
                startWaitProgress(
                    progressFill,
                    state.until,
                    state.duration || state.retryIn || 60000
                );
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
                        statusMessage.textContent = state.error === 'REPLIES_UNAVAILABLE'
                            ? t('repliesUnavailableBody')
                            : ((state.error === 'RATE_LIMITED' && state.canResume)
                                ? t('rateLimitedResumeHint')
                                : formatError(state.error, t));
                    }
                }
                setMeasuredProgress();
                break;

            case 'retrying':
                statusText.textContent = `${t('exporting').replace(/[.…\s]+$/, '')} ${subject}`;
                setDotColor('yellow', true);
                statusMessage.textContent = `${t('retrying')} (${t('attempt')} ${state.attempt})...`;
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';
                break;

            case 'complete':
                // Icon markup is ours; the translated text goes in as a text
                // node so locale strings can never inject HTML.
                statusText.innerHTML = ICONS.circleCheck + ' ';
                statusText.appendChild(document.createTextNode(t('exportComplete')));
                setDotColor('green');
                statusMessage.textContent = itemCount === 0
                    ? t('errNoData')
                    : (state.partialReason === 'replies_unavailable'
                        ? t('postsOnlyFallbackComplete')
                        : (state.completionReason === 'source_exhausted'
                            ? t('sourceExhausted')
                            : t('canContinue')));
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
                statusMessage.textContent = state.partialReason === 'replies_unavailable'
                    ? t('postsOnlyFallbackActive')
                    : t('canBeResumed');
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
