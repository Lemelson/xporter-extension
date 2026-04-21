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

    if (exportVersion && chrome.runtime?.getManifest) {
        exportVersion.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    // ==================== i18n ====================
    let currentTranslations = {};

    // Load saved language preference and apply translations
    async function initI18n() {
        const stored = await chrome.storage.local.get('xporter_lang');
        const lang = stored.xporter_lang || 'en';
        if (typeof loadTranslations === 'function') {
            currentTranslations = await loadTranslations(lang);
        }
        applyTranslations();
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
    if (settings.theme === 'light') {
        body.classList.remove('dark');
        body.classList.add('light');
        themeIcon.textContent = '🌙';
    }

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
        themeIcon.textContent = isLight ? '🌙' : '☀️';
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
            showError('Export Error', result.error);
            return;
        }

        exportStartTime = Date.now();
        startTimeCounter();
        showState('active');
        exportUsername.textContent = `@${username}`;
        counter.textContent = '0';
        statusDot.className = 'status-dot green';
        statusMsg.textContent = 'Resolving user...';
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
        statusMsg.textContent = 'Stopped — can resume';
    });

    // ==================== Resume Export ====================
    resumeBtn.addEventListener('click', async () => {
        const result = await sendMessage({ type: 'RESUME_EXPORT' });
        if (result?.error) {
            showError('Resume Error', result.error);
            return;
        }

        resumeBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        startTimeCounter();
        statusDot.className = 'status-dot green';
        statusMsg.textContent = 'Resuming...';
    });

    // ==================== Download CSV ====================
    downloadBtn.addEventListener('click', async () => {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<span>⏳</span> Preparing...';

        const result = await sendMessage({ type: 'DOWNLOAD_CSV' });

        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<span>📥</span> Download CSV';

        if (result?.error) {
            showError('Download Error', result.error);
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
                statusMsg.textContent = 'Resolving user...';
                progressFill.classList.add('indeterminate');
                if (!exportStartTime) { exportStartTime = Date.now(); startTimeCounter(); }
                break;

            case 'fetching':
                showState('active');
                if (state.username) exportUsername.textContent = `@${state.username}`;
                if (state.expectedTweets) exportExpected.textContent = `~${Number(state.expectedTweets).toLocaleString()} total tweets`;

                counter.textContent = Number(state.tweetCount || 0).toLocaleString();
                statusDot.className = 'status-dot green';
                statusMsg.textContent = `Fetching... (batch ${state.batch || '?'})`;
                progressFill.classList.remove('indeterminate');

                // Calculate approximate progress
                const expectedCount = state.expectedTweets || 5000;
                const progress = Math.min(95, ((state.tweetCount || 0) / expectedCount) * 100);
                progressFill.style.width = progress + '%';

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
                const seconds = Math.round((state.duration || 180000) / 1000);
                statusMsg.textContent = `Cooldown: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} — ${state.reason || ''}`;
                startCooldownTimer(state.duration || 180000);
                break;

            case 'error':
                if (state.retryIn) {
                    statusDot.className = 'status-dot red';
                    statusMsg.textContent = `${state.error} — retry in ${Math.round(state.retryIn / 1000)}s`;
                } else {
                    const errorMsg = formatError(state.error, t);
                    if (state.error === 'NOT_LOGGED_IN') {
                        showState('auth');
                    } else {
                        showError('Export Error', errorMsg);
                    }
                    stopTimeCounter();
                }
                break;

            case 'retrying':
                statusDot.className = 'status-dot yellow';
                statusMsg.textContent = `Retrying (attempt ${state.attempt})...`;
                break;

            case 'complete':
                showState('complete');
                completeUser.textContent = `@${state.username || usernameInput.value}`;
                completeCount.textContent = Number(state.tweetCount || 0).toLocaleString();
                stopTimeCounter();
                break;

            case 'stopped':
                showState('active');
                stopBtn.classList.add('hidden');
                resumeBtn.classList.remove('hidden');
                statusDot.className = 'status-dot yellow';
                statusMsg.textContent = 'Stopped — click Resume to continue';
                counter.textContent = Number(state.tweetCount || 0).toLocaleString();
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
    }

    function startCooldownTimer(duration) {
        let remaining = Math.round(duration / 1000);
        const cooldownInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(cooldownInterval);
                return;
            }
            statusMsg.textContent = `Cooldown: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
        }, 1000);
    }

    // ==================== Helpers ====================
    // sendMessage, formatError, debounce — loaded from /utils/shared.js
});
