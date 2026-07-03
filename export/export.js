// XPorter Export Page — Logic
document.addEventListener('DOMContentLoaded', async () => {
    // ==================== Elements ====================
    const app = document.getElementById('app');
    const body = document.body;
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const usernameInput = document.getElementById('usernameInput');
    const dateCheck = document.getElementById('dateCheck');
    const dateFields = document.getElementById('dateFields');
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    const includeRetweets = document.getElementById('includeRetweets');
    const includeReplies = document.getElementById('includeReplies');
    const quantityLimit = document.getElementById('quantityLimit');
    const exportSpeed = document.getElementById('exportSpeed');
    const customSpeedRows = document.getElementById('customSpeedRows');
    const customDelaySec = document.getElementById('customDelaySec');
    const customCooldownMin = document.getElementById('customCooldownMin');
    const customBatchSize = document.getElementById('customBatchSize');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const newExportBtn = document.getElementById('newExportBtn');
    const errorRetryBtn = document.getElementById('errorRetryBtn');

    // States
    const stateIdle = document.getElementById('stateIdle');
    const stateActive = document.getElementById('stateActive');
    const stateComplete = document.getElementById('stateComplete');
    const stateError = document.getElementById('stateError');
    const stateAuth = document.getElementById('stateAuth');

    // Active state elements
    const exportUsername = document.getElementById('exportUsername');
    const exportExpected = document.getElementById('exportExpected');
    const counter = document.getElementById('counter');
    const counterLabel = document.querySelector('.counter-label');
    const progressFill = document.getElementById('progressFill');
    const statusDot = document.getElementById('statusDot');
    const statusMsg = document.getElementById('statusMsg');
    const statBatch = document.getElementById('statBatch');
    const statRequests = document.getElementById('statRequests');
    const statTime = document.getElementById('statTime');
    const exportVersion = document.getElementById('exportVersion');

    // Complete state elements
    const completeUser = document.getElementById('completeUser');
    const completeCount = document.getElementById('completeCount');
    const completePostsLabel = document.querySelector('#completeInfo [data-i18n="posts"]');

    // Error state elements
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const errorActions = document.getElementById('errorActions');

    // Download button label span + original home (it can be temporarily moved
    // into the error state to offer downloading already-collected items).
    const downloadLabel = downloadBtn.querySelector('[data-i18n="downloadCsv"]');
    const downloadBtnHome = downloadBtn.parentElement;
    const resumeBtnHome = resumeBtn.parentElement;

    let exportStartTime = null;
    let timeInterval = null;
    // Exports can be started from the popup in user-list modes and with
    // non-CSV formats — the status broadcasts tell us what is really running.
    let currentExportMode = 'posts';
    let currentOutputFormat = 'csv';
    // Live cooldown countdown driven by the SW's absolute `until` timestamp
    // (duration fallback for older events). createCooldownTicker guards
    // against stacked intervals internally.
    // Localized label for the countdown — set per event from the SW's `kind`
    // ('pacing' = normal spacing, 'window' = X budget spent, 'batch' = fallback).
    let cooldownLabelKey = 'cooldown';
    const cooldownTicker = createCooldownTicker((remaining) => {
        const countdown = cooldownLabelKey === 'statusPacing' && remaining < 60
            ? String(remaining)
            : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
        statusMsg.textContent = `${t(cooldownLabelKey)} ${countdown}`;
    });
    // Guards the rating prompt's export counter so one finished export counts
    // once, even though the 'complete' status can be re-broadcast.
    let ratePromptCounted = false;

    function ratePromptExportKey(state) {
        const completedAt = state?.completedAt || 'complete';
        const startedAt = state?.startedAt || exportStartTime || 'unknown-start';
        const username = state?.username || usernameInput.value || 'unknown-user';
        const mode = state?.exportMode || currentExportMode || 'posts';
        const count = state?.tweetCount ?? 0;
        return [startedAt, completedAt, username, mode, count].join('|');
    }

    // Label the download button with the export's real output format —
    // "Download CSV" on a JSON export would lie about what the file is.
    function updateDownloadLabel() {
        if (downloadLabel) {
            downloadLabel.textContent = `${t('download')} ${(currentOutputFormat || 'csv').toUpperCase()}`;
        }
    }

    if (exportVersion && chrome.runtime?.getManifest) {
        exportVersion.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    // ==================== Theme icons (SVG, matches popup) ====================
    const SUN_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    const MOON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>';
    function setThemeIcon(isLight) {
        themeIcon.innerHTML = isLight ? MOON_SVG : SUN_SVG;
    }

    // ==================== Toasts ====================
    let toastContainer = null;
    function showToast(message, type = 'info') {
        if (!message) return;
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = 'toast-container';
            document.body.appendChild(toastContainer);
        }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.textContent = message;
        toastContainer.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('toast-show'));
        setTimeout(() => {
            toast.classList.remove('toast-show');
            setTimeout(() => toast.remove(), 250);
        }, type === 'error' ? 4500 : 2800);
    }

    // ==================== i18n ====================
    let currentTranslations = {};
    let currentLang = 'en';

    // Load language from saved settings and apply translations.
    // NOTE: language lives in settings.language (the popup writes it there).
    // The page previously read a non-existent `xporter_lang` key, so it was
    // always English regardless of the user's choice.
    async function initI18n() {
        try {
            const settingsResult = await sendMessage({ type: 'GET_SETTINGS' });
            currentLang = settingsResult?.settings?.language
                || (typeof detectBrowserLanguage === 'function' ? detectBrowserLanguage() : 'en');
        } catch (_) {
            currentLang = 'en';
        }
        if (typeof loadTranslations === 'function') {
            currentTranslations = await loadTranslations(currentLang);
        }
        applyTranslations();
        document.documentElement.lang = currentLang;
        applyLanguageDirection(currentLang); // RTL for Arabic
    }

    function applyTranslations() {
        applyI18nToDOM(currentTranslations);
        // Update select options for quantity limit (shared helper: translated
        // "Unlimited" + locale-aware number grouping for every numeric preset)
        localizeQuantityOptions(quantityLimit, currentLang, currentTranslations);
        updateDownloadLabel();
    }

    function t(key) {
        return currentTranslations[key] || key;
    }

    await initI18n();

    // ==================== Load Settings & State ====================
    const settingsResult = await sendMessage({ type: 'GET_SETTINGS' });
    const settings = settingsResult?.settings || {};

    // Apply theme
    const isLightInit = settings.theme === 'light';
    if (isLightInit) {
        body.classList.remove('dark');
        body.classList.add('light');
    }
    setThemeIcon(isLightInit);

    // Ensure the select can represent a custom limit set in the popup (e.g.
    // 2500): without a matching <option> the select silently falls back to
    // value='' and the next settings save would persist 0 (Unlimited),
    // destroying the user's limit.
    function ensureQuantityOption(value) {
        const val = String(value);
        const options = Array.from(quantityLimit.options);
        if (options.some(opt => opt.value === val)) return;
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = `${formatNumber(value, currentLang)} ${currentTranslations.posts || 'posts'}`;
        // Keep numeric options sorted ("0" = Unlimited stays first)
        const next = options.find(o => parseInt(o.value, 10) > value);
        quantityLimit.insertBefore(opt, next || null);
    }

    // Apply settings to controls
    includeRetweets.checked = settings.includeRetweets !== false;
    includeReplies.checked = settings.includeReplies !== false;
    const savedQuantityLimit = parseInt(settings.quantityLimit, 10) || 0;
    if (savedQuantityLimit > 0) ensureQuantityOption(savedQuantityLimit);
    quantityLimit.value = String(savedQuantityLimit);
    exportSpeed.value = ['turbo', 'fast', 'standard', 'careful', 'turtle', 'custom'].includes(settings.exportSpeed)
        ? settings.exportSpeed
        : 'standard';
    customDelaySec.value = settings.customDelaySec || 5;
    customCooldownMin.value = settings.customCooldownMin || 3;
    customBatchSize.value = settings.customBatchSize || 20;
    customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');

    // Read URL params (username may be passed from popup)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('username')) {
        usernameInput.value = urlParams.get('username');
    } else {
        // Try to get detected username
        const usernameResult = await sendMessage({ type: 'GET_USERNAME' });
        if (usernameResult?.username) {
            usernameInput.value = usernameResult.username;
        }
    }

    // Check existing export state
    const status = await sendMessage({ type: 'GET_STATUS' });
    if (status && status.status !== 'idle') {
        handleStatusUpdate(status);
    }

    // ==================== Theme Toggle ====================
    themeToggle.addEventListener('click', async () => {
        body.classList.toggle('light');
        body.classList.toggle('dark');
        const isLight = body.classList.contains('light');
        setThemeIcon(isLight);
        settings.theme = isLight ? 'light' : 'dark';
        await sendMessage({
            type: 'SAVE_SETTINGS',
            settings: { theme: settings.theme }
        });
    });

    // ==================== Date Toggle ====================
    dateCheck.addEventListener('change', () => {
        dateFields.classList.toggle('hidden', !dateCheck.checked);
    });

    // ==================== Save Settings on Change ====================
    const saveSettings = debounce(async () => {
        const nextSettings = {
            includeRetweets: includeRetweets.checked,
            includeReplies: includeReplies.checked,
            requestDelay: 3000,
            exportSpeed: exportSpeed.value || 'standard',
            customDelaySec: clampNumberInput(customDelaySec, 5),
            customCooldownMin: clampNumberInput(customCooldownMin, 3),
            customBatchSize: clampNumberInput(customBatchSize, 20),
            theme: body.classList.contains('light') ? 'light' : 'dark'
        };
        // NEVER persist the limit from an empty select value — '' means the
        // select could not represent the saved value, and writing it back
        // would turn a custom limit into 0 (Unlimited).
        if (quantityLimit.value !== '') {
            nextSettings.quantityLimit = parseInt(quantityLimit.value) || 0;
        }
        const patch = {};
        for (const [key, value] of Object.entries(nextSettings)) {
            if (settings[key] !== value) patch[key] = value;
        }
        Object.assign(settings, patch);
        if (Object.keys(patch).length > 0) {
            return await sendMessage({ type: 'SAVE_SETTINGS', settings: patch });
        }
        return { success: true };
    }, 500);

    // Clamp a typed number input to its own min/max attributes.
    function clampNumberInput(el, fallback) {
        const parsed = parseInt(el.value, 10);
        const value = Number.isFinite(parsed) ? parsed : fallback;
        const min = parseInt(el.min, 10);
        const max = parseInt(el.max, 10);
        return Math.max(Number.isFinite(min) ? min : value, Math.min(Number.isFinite(max) ? max : value, value));
    }

    exportSpeed.addEventListener('change', () => {
        customSpeedRows.classList.toggle('hidden', exportSpeed.value !== 'custom');
    });

    [includeRetweets, includeReplies, quantityLimit, exportSpeed,
        customDelaySec, customCooldownMin, customBatchSize].forEach(el => {
        el.addEventListener('change', saveSettings);
    });

    // ==================== Start Export ====================
    startBtn.addEventListener('click', async () => {
        const username = extractUsernameFromInput(usernameInput.value);
        if (!username || !isValidUsername(username)) {
            usernameInput.focus();
            usernameInput.parentElement.style.borderColor = 'var(--danger)';
            setTimeout(() => {
                usernameInput.parentElement.style.borderColor = '';
            }, 2000);
            return;
        }

        // Save settings first (flush the pending debounce; the `||` chaining
        // used here before double-ran the save)
        let settingsSave;
        if (typeof saveSettings.flush === 'function') {
            settingsSave = await saveSettings.flush();
        } else {
            settingsSave = await saveSettings();
        }
        if (settingsSave?.success !== true) {
            showError(t('exportError'), formatError(settingsSave?.error || 'STORAGE_FULL', t));
            return;
        }

        ratePromptCounted = false; // fresh export — allow it to be counted again

        const result = await sendMessage({
            type: 'START_EXPORT',
            username,
            dateFrom: dateCheck.checked ? dateFrom.value : null,
            dateTo: dateCheck.checked ? dateTo.value : null
        });

        if (result?.error) {
            showError(t('exportError'), formatError(result.error, t));
            return;
        }

        // This page starts posts/CSV exports (no mode/format was sent, so the
        // SW defaults to them) — don't keep a previous export's mode/format.
        currentExportMode = 'posts';
        currentOutputFormat = 'csv';
        updateDownloadLabel();

        exportStartTime = Date.now();
        startTimeCounter();
        showState('active');
        exportUsername.textContent = bidiIsolate(`@${username}`);
        counter.textContent = '0';
        statusDot.className = 'status-dot green';
        statusMsg.textContent = t('resolvingUser');
        progressFill.classList.add('indeterminate');
    });

    // ==================== Stop Export ====================
    stopBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'STOP_EXPORT' });
        stopTimeCounter();

        // Show resume option
        stopBtn.classList.add('hidden');
        resumeBtn.classList.remove('hidden');
        statusDot.className = 'status-dot yellow';
        statusMsg.textContent = t('stoppedCanResume');
    });

    // ==================== Resume Export ====================
    resumeBtn.addEventListener('click', async () => {
        const result = await sendMessage({ type: 'RESUME_EXPORT' });
        if (result?.error) {
            showError(t('resumeError'), formatError(result.error, t));
            return;
        }

        // Resume can also be offered from the error screen — switch back to
        // the live view (no-op when already there, e.g. after a manual stop).
        showState('active');
        resumeBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        startTimeCounter();
        statusDot.className = 'status-dot green';
        statusMsg.textContent = t('resuming');
    });

    // ==================== Download ====================
    // No format in the message — the SW uses the export's own format, and the
    // button label (updateDownloadLabel) reflects it.
    downloadBtn.addEventListener('click', async () => {
        downloadBtn.disabled = true;
        if (downloadLabel) downloadLabel.textContent = t('preparing');

        // Downloads (large XLSX generation) can far exceed the default 5s
        // message timeout.
        const result = await sendMessage(
            { type: 'DOWNLOAD_CSV' },
            XPORTER_CONFIG.DOWNLOAD_MESSAGE_TIMEOUT || 30000
        );

        downloadBtn.disabled = false;
        updateDownloadLabel();

        if (result?.success === true) {
            showToast(t('downloadStarted'), 'success');
            // User just got their file — the natural moment to ask for a rating.
            setTimeout(() => {
                window.XPorterRatePrompt?.maybeShow({ translations: currentTranslations, lang: currentLang });
            }, 800);
        } else {
            // Anything that isn't an explicit success is a failure — including
            // an empty/malformed response that used to pass the old check.
            showError(t('downloadError'), formatError(result?.error || 'DOWNLOAD_FAILED', t));
        }
    });

    // ==================== New Export ====================
    newExportBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'CLEAR_EXPORT' });
        showState('idle');
        usernameInput.value = '';
        usernameInput.focus();
        stopTimeCounter();
        exportStartTime = null; // next export starts its own elapsed clock
        ratePromptCounted = false;
    });

    // ==================== Retry Error ====================
    errorRetryBtn.addEventListener('click', () => {
        showState('idle');
    });

    // ==================== Listen for Status Updates ====================
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'EXPORT_STATUS_UPDATE') {
            handleStatusUpdate(message);
        }
    });

    function handleStatusUpdate(state) {
        // Track what is actually being exported (mode/format may come from an
        // export started in the popup).
        if (state.exportMode) currentExportMode = state.exportMode;
        if (state.outputFormat) currentOutputFormat = state.outputFormat;
        // Keep the label honest — but not mid-download ("Preparing...").
        if (!downloadBtn.disabled) updateDownloadLabel();
        // The SW's startedAt is the authoritative elapsed-timer base (survives
        // page reloads and popup-started exports).
        if (state.startedAt) exportStartTime = state.startedAt;

        progressFill.classList.remove('cooldown');
        if (state.status !== 'cooldown') {
            cooldownTicker.stop();
            stopWaitProgress(progressFill);
        }

        switch (state.status) {
            case 'resolving_user':
                showState('active');
                exportUsername.textContent = bidiIsolate(`@${state.username || usernameInput.value}`);
                statusDot.className = 'status-dot green';
                statusMsg.textContent = t('resolvingUser');
                progressFill.classList.add('indeterminate');
                if (!exportStartTime) exportStartTime = Date.now();
                if (!timeInterval) startTimeCounter();
                break;

            case 'fetching':
                showState('active');
                if (state.username) exportUsername.textContent = bidiIsolate(`@${state.username}`);
                exportExpected.textContent = state.expectedTweets
                    ? `~${formatNumber(state.expectedTweets, currentLang)} ${pluralLabel('totalTweets', state.expectedTweets, currentLang, currentTranslations)}`
                    : '';

                counter.textContent = formatNumber(state.tweetCount || 0, currentLang);
                if (counterLabel) {
                    counterLabel.textContent = collectedLabel(state.tweetCount || 0, currentExportMode, currentLang, currentTranslations);
                }
                statusDot.className = 'status-dot green';
                statusMsg.textContent = `${t('fetching')} (${t('batch')} ${state.batch || '?'})`;
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '100%';

                if (state.totalRequests) statRequests.textContent = state.totalRequests;
                if (state.batch) statBatch.textContent = state.batch;

                // Show stop button
                stopBtn.classList.remove('hidden');
                resumeBtn.classList.add('hidden');
                startBtn.classList.add('hidden');

                if (!exportStartTime) exportStartTime = Date.now();
                if (!timeInterval) startTimeCounter();
                break;

            case 'cooldown':
                statusDot.className = 'status-dot yellow';
                // Label by wait type — plain "Cooldown" made normal pacing
                // look like a penalty.
                cooldownLabelKey = state.kind === 'pacing' ? 'statusPacing'
                    : state.kind === 'window' ? 'statusRateLimitWait'
                        : 'cooldown';
                cooldownTicker.start(state.until, state.duration || 180000);
                progressFill.classList.add('cooldown');
                startWaitProgress(progressFill, state.until, state.duration || 180000);
                break;

            case 'error':
                if (state.retryIn) {
                    statusDot.className = 'status-dot red';
                    statusMsg.textContent = `${formatError(state.error, t)} — ${t('retryIn')} ${Math.round(state.retryIn / 1000)}s`;
                } else {
                    const errorMsg = formatError(state.error, t);
                    if (state.error === 'NOT_LOGGED_IN') {
                        showState('auth');
                    } else {
                        // Collected items usually survive the error — offer
                        // Download / Resume instead of only "Try Again".
                        showError(t('exportError'), errorMsg, {
                            itemCount: state.tweetCount || 0,
                            canResume: !!state.canResume
                        });
                    }
                    stopTimeCounter();
                    exportStartTime = null;
                }
                break;

            case 'retrying':
                statusDot.className = 'status-dot yellow';
                statusMsg.textContent = `${t('retrying')} (${t('attempt')} ${state.attempt})...`;
                break;

            case 'complete': {
                showState('complete');
                const itemCount = state.tweetCount || 0;
                completeUser.textContent = bidiIsolate(`@${state.username || usernameInput.value}`);
                completeCount.textContent = formatNumber(itemCount, currentLang);
                if (completePostsLabel) {
                    completePostsLabel.textContent = ' ' + pluralLabel(
                        currentExportMode === 'posts' ? 'postsUnit' : 'usersCollected',
                        itemCount, currentLang, currentTranslations);
                }
                // Nothing collected (e.g. a 0-post account) → nothing to
                // download; hide the button instead of erroring on click.
                downloadBtn.classList.toggle('hidden', itemCount <= 0);
                stopTimeCounter();
                exportStartTime = null;
                if (!ratePromptCounted) {
                    ratePromptCounted = true;
                    window.XPorterRatePrompt?.incrementExports(ratePromptExportKey(state));
                }
                break;
            }

            case 'stopped':
                showState('active');
                stopBtn.classList.add('hidden');
                resumeBtn.classList.remove('hidden');
                statusDot.className = 'status-dot yellow';
                statusMsg.textContent = t('stoppedClickResume');
                counter.textContent = formatNumber(state.tweetCount || 0, currentLang);
                if (counterLabel) {
                    counterLabel.textContent = collectedLabel(state.tweetCount || 0, currentExportMode, currentLang, currentTranslations);
                }
                stopTimeCounter();
                break;
        }
    }

    // ==================== State Management ====================
    function showState(stateName) {
        [stateIdle, stateActive, stateComplete, stateError, stateAuth].forEach(s => s.classList.add('hidden'));

        // Reset button visibility
        startBtn.classList.toggle('hidden', stateName !== 'idle');
        stopBtn.classList.add('hidden');
        resumeBtn.classList.add('hidden');

        // Re-home the download button (the error state may have borrowed it)
        if (downloadBtn.parentElement !== downloadBtnHome) {
            downloadBtnHome.insertBefore(downloadBtn, downloadBtnHome.firstChild);
        }
        downloadBtn.classList.remove('hidden');
        if (resumeBtn.parentElement !== resumeBtnHome) {
            resumeBtnHome.appendChild(resumeBtn);
        }

        switch (stateName) {
            case 'idle':
                stateIdle.classList.remove('hidden');
                startBtn.classList.remove('hidden');
                break;
            case 'active':
                stateActive.classList.remove('hidden');
                stopBtn.classList.remove('hidden');
                break;
            case 'complete':
                stateComplete.classList.remove('hidden');
                break;
            case 'error':
                stateError.classList.remove('hidden');
                break;
            case 'auth':
                stateAuth.classList.remove('hidden');
                break;
        }
    }

    // opts: { itemCount, canResume } — when the failed export already
    // collected items, the user can still download them and/or resume
    // instead of being offered only "Try Again".
    function showError(title, message, opts = {}) {
        showState('error');
        errorTitle.textContent = title;
        errorMessage.textContent = message;
        if (opts.itemCount > 0) {
            errorActions.insertBefore(downloadBtn, errorRetryBtn);
        } else {
            downloadBtn.classList.add('hidden');
        }
        if (opts.canResume) {
            errorActions.insertBefore(resumeBtn, errorRetryBtn);
            resumeBtn.classList.remove('hidden');
        }
    }

    // ==================== Timer ====================
    function startTimeCounter() {
        stopTimeCounter();
        timeInterval = setInterval(() => {
            if (!exportStartTime) return;
            const elapsed = Math.floor((Date.now() - exportStartTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            statTime.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        }, 1000);
    }

    function stopTimeCounter() {
        if (timeInterval) {
            clearInterval(timeInterval);
            timeInterval = null;
        }
        cooldownTicker.stop();
    }

    // ==================== Helpers ====================
    // sendMessage, formatError, debounce — loaded from /utils/shared.js
});
