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
    const cooldownMinutes = document.getElementById('cooldownMinutes');
    const cooldownBatch = document.getElementById('cooldownBatch');
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

    // Error state elements
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');

    let exportStartTime = null;
    let timeInterval = null;
    let cooldownInterval = null;

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
        // Update select options for quantity limit
        const options = quantityLimit.querySelectorAll('option');
        const posts = currentTranslations.posts || 'posts';
        if (options.length >= 1) options[0].textContent = currentTranslations.unlimited || 'Unlimited';
        if (options.length >= 2) options[1].textContent = `100 ${posts}`;
        if (options.length >= 3) options[2].textContent = `500 ${posts}`;
        if (options.length >= 4) options[3].textContent = `1,000 ${posts}`;
        if (options.length >= 5) options[4].textContent = `5,000 ${posts}`;
        if (options.length >= 6) options[5].textContent = `10,000 ${posts}`;
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

    // Apply settings to controls
    includeRetweets.checked = settings.includeRetweets !== false;
    includeReplies.checked = settings.includeReplies !== false;
    quantityLimit.value = String(settings.quantityLimit || 0);
    cooldownMinutes.value = Math.round((settings.cooldownDuration || 180000) / 60000);
    cooldownBatch.value = settings.batchSize || 20;

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
        await sendMessage({
            type: 'SAVE_SETTINGS',
            settings: { ...settings, theme: isLight ? 'light' : 'dark' }
        });
    });

    // ==================== Date Toggle ====================
    dateCheck.addEventListener('change', () => {
        dateFields.classList.toggle('hidden', !dateCheck.checked);
    });

    // ==================== Save Settings on Change ====================
    const saveSettings = debounce(async () => {
        await sendMessage({
            type: 'SAVE_SETTINGS',
            settings: {
                includeRetweets: includeRetweets.checked,
                includeReplies: includeReplies.checked,
                quantityLimit: parseInt(quantityLimit.value) || 0,
                requestDelay: 3000,
                batchSize: parseInt(cooldownBatch.value) || 20,
                cooldownDuration: (parseInt(cooldownMinutes.value) || 3) * 60000,
                theme: body.classList.contains('light') ? 'light' : 'dark'
            }
        });
    }, 500);

    [includeRetweets, includeReplies, quantityLimit, cooldownMinutes, cooldownBatch].forEach(el => {
        el.addEventListener('change', saveSettings);
    });

    // ==================== Start Export ====================
    startBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim().replace('@', '');
        if (!username) {
            usernameInput.focus();
            usernameInput.parentElement.style.borderColor = 'var(--danger)';
            setTimeout(() => {
                usernameInput.parentElement.style.borderColor = '';
            }, 2000);
            return;
        }

        // Save settings first
        await saveSettings.flush?.() || saveSettings();

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

        exportStartTime = Date.now();
        startTimeCounter();
        showState('active');
        exportUsername.textContent = `@${username}`;
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

        resumeBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        startTimeCounter();
        statusDot.className = 'status-dot green';
        statusMsg.textContent = t('resuming');
    });

    // ==================== Download CSV ====================
    downloadBtn.addEventListener('click', async () => {
        const labelSpan = downloadBtn.querySelector('[data-i18n="downloadCsv"]');
        downloadBtn.disabled = true;
        if (labelSpan) labelSpan.textContent = t('preparing');

        const result = await sendMessage({ type: 'DOWNLOAD_CSV' });

        downloadBtn.disabled = false;
        if (labelSpan) labelSpan.textContent = t('downloadCsv');

        if (result?.error) {
            showError(t('downloadError'), formatError(result.error, t));
        } else {
            showToast(t('downloadStarted'), 'success');
        }
    });

    // ==================== New Export ====================
    newExportBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'CLEAR_EXPORT' });
        showState('idle');
        usernameInput.value = '';
        usernameInput.focus();
        stopTimeCounter();
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
        switch (state.status) {
            case 'resolving_user':
                showState('active');
                exportUsername.textContent = `@${state.username || usernameInput.value}`;
                statusDot.className = 'status-dot green';
                statusMsg.textContent = t('resolvingUser');
                progressFill.classList.add('indeterminate');
                if (!exportStartTime) { exportStartTime = Date.now(); startTimeCounter(); }
                break;

            case 'fetching':
                showState('active');
                if (state.username) exportUsername.textContent = `@${state.username}`;
                if (state.expectedTweets) exportExpected.textContent = `~${formatNumber(state.expectedTweets, currentLang)} ${t('totalTweets')}`;

                counter.textContent = formatNumber(state.tweetCount || 0, currentLang);
                statusDot.className = 'status-dot green';
                statusMsg.textContent = `${t('fetching')} (${t('batch')} ${state.batch || '?'})`;

                // Honest progress: only show a real percentage when we know the
                // target (an explicit limit or the account's known total).
                // Otherwise keep the indeterminate shimmer instead of faking a
                // percentage against a guessed denominator.
                {
                    const limit = parseInt(quantityLimit.value) || 0;
                    const target = limit > 0 ? limit : (state.expectedTweets || 0);
                    if (target > 0) {
                        progressFill.classList.remove('indeterminate');
                        progressFill.style.width = Math.min(95, ((state.tweetCount || 0) / target) * 100) + '%';
                    } else {
                        progressFill.classList.add('indeterminate');
                    }
                }

                if (state.totalRequests) statRequests.textContent = state.totalRequests;
                if (state.batch) statBatch.textContent = state.batch;

                // Show stop button
                stopBtn.classList.remove('hidden');
                resumeBtn.classList.add('hidden');
                startBtn.classList.add('hidden');

                if (!exportStartTime) { exportStartTime = state.startedAt || Date.now(); startTimeCounter(); }
                break;

            case 'cooldown':
                statusDot.className = 'status-dot yellow';
                startCooldownTimer(state.duration || 180000);
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
                        showError(t('exportError'), errorMsg);
                    }
                    stopTimeCounter();
                }
                break;

            case 'retrying':
                statusDot.className = 'status-dot yellow';
                statusMsg.textContent = `${t('retrying')} (${t('attempt')} ${state.attempt})...`;
                break;

            case 'complete':
                showState('complete');
                completeUser.textContent = `@${state.username || usernameInput.value}`;
                completeCount.textContent = formatNumber(state.tweetCount || 0, currentLang);
                stopTimeCounter();
                break;

            case 'stopped':
                showState('active');
                stopBtn.classList.add('hidden');
                resumeBtn.classList.remove('hidden');
                statusDot.className = 'status-dot yellow';
                statusMsg.textContent = t('stoppedClickResume');
                counter.textContent = formatNumber(state.tweetCount || 0, currentLang);
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

    function showError(title, message) {
        showState('error');
        errorTitle.textContent = title;
        errorMessage.textContent = message;
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
        if (cooldownInterval) {
            clearInterval(cooldownInterval);
            cooldownInterval = null;
        }
    }

    function startCooldownTimer(duration) {
        // Guard against stacked intervals — each cooldown event used to spawn a
        // new setInterval without clearing the previous one, making the timer
        // jump.
        if (cooldownInterval) { clearInterval(cooldownInterval); cooldownInterval = null; }
        let remaining = Math.round(duration / 1000);
        const render = () => {
            statusMsg.textContent = `${t('cooldown')} ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
        };
        render();
        cooldownInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(cooldownInterval);
                cooldownInterval = null;
                return;
            }
            render();
        }, 1000);
    }

    // ==================== Helpers ====================
    // sendMessage, formatError, debounce — loaded from /utils/shared.js
});
