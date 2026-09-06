// Export status presentation. Receives a complete display snapshot; owns no
// messaging, settings persistence, download transaction, or rating side effects.
(function (root) {
    'use strict';
    function mount({ t, modeLabel, getLocale }) {
        const exportStatus = document.getElementById('exportStatus');
        const statusText = document.getElementById('statusText');
        const statusPhaseIcon = document.getElementById('statusPhaseIcon');
        const statusSubtitle = document.getElementById('statusSubtitle');
        const statusPhaseHelp = document.getElementById('statusPhaseHelp');
        const statusDetail = document.getElementById('statusDetail');
        const statusIndicator = document.getElementById('statusIndicator');
        const progressFill = document.getElementById('progressFill');
        const tweetCountEl = document.getElementById('tweetCount');
        const resumeLabel = document.querySelector('.resume-label');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        const downloadBtn = document.getElementById('downloadBtn');
        const copyBtn = document.getElementById('copyBtn');
        const statusActionStack = document.getElementById('statusActionStack');
        const resumeQuantity = document.getElementById('resumeQuantity');
        const repliesFallbackActions = document.getElementById('repliesFallbackActions');
        const resumeRow = document.getElementById('resumeRow');
        const newExportBtn = document.getElementById('newExportBtn');
        const statusMessage = document.getElementById('statusMessage');
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
            exportStatus.classList.remove('phase-rate-limit', 'phase-safety-break', 'phase-stopped');
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
            const helpText = t(helpKey);
            statusPhaseHelp.setAttribute('aria-label', stripHelpMarkup(helpText));
            const helpPop = statusPhaseHelp.querySelector(':scope > .help-pop');
            if (helpPop) helpPop.innerHTML = renderHelpMarkup(helpText);
            statusPhaseHelp.classList.remove('hidden');
        }

        function render(state, { username = '' } = {}) {
            const { language: currentLang, translations: currentTranslations } = getLocale();
            const { status, exportMode: mode, tweetCount: itemCount } = state;
            const isRunning = state.running;
            // Show/hide elements. A final error must still offer Download (data
            // was collected) and Resume (SW says it can continue) — otherwise
            // "New Export" is the only way out and destroys the collected data.
            const finalError = (status === 'error' && !isRunning);
            const showTerminalActions = (status === 'complete' || status === 'stopped' || finalError) && itemCount > 0;
            const showTxtCopy = showTerminalActions &&
                (mode === 'posts' || mode === 'bookmarks') &&
                state.outputFormat === 'txt';
            startBtn.classList.toggle(
                'hidden',
                isRunning || status === 'complete' || status === 'stopped' || finalError
            );
            stopBtn.classList.toggle('hidden', !isRunning);
            downloadBtn.classList.toggle('hidden', !showTerminalActions);
            copyBtn.classList.toggle('hidden', !showTxtCopy);
            statusActionStack.classList.toggle('hidden', !isRunning && !showTerminalActions);
            statusActionStack.classList.toggle('running-actions', isRunning);
            statusActionStack.classList.toggle('txt-actions', showTxtCopy);
            const canContinueComplete = status === 'complete' && itemCount > 0 &&
                !state.resumeBlockedReason &&
                !['source_exhausted', 'no_matches'].includes(state.completionReason);
            const showRepliesFallback = finalError && !state.resumeBlockedReason && state.canFallbackWithoutReplies === true;
            const resumeAddsItems = canContinueComplete;
            resumeQuantity.classList.toggle('hidden', !resumeAddsItems);
            resumeLabel?.classList.toggle('hidden', !resumeAddsItems);
            repliesFallbackActions.classList.toggle('hidden', !showRepliesFallback);
            resumeRow.classList.toggle(
                'hidden',
                showRepliesFallback ||
                !((status === 'stopped' && !state.resumeBlockedReason) ||
                    canContinueComplete || (finalError && state.canResume))
            );
            resumeRow.classList.toggle('is-stopped', status === 'stopped');
            newExportBtn.classList.toggle('hidden', status !== 'complete' && status !== 'stopped' && status !== 'error');
            exportStatus.classList.toggle('hidden', status === 'idle');
            statusDetail.classList.remove('hidden');

            const subject = mode === 'bookmarks'
                ? modeLabel('bookmarks')
                : bidiIsolate('@' + (state.username || username));

            // Measured progress remains useful for paused/error states. While an
            // export is active, the bar instead communicates activity: blue while
            // fetching and a timed amber fill between requests.
            const hasTarget = state.quantityLimit > 0;
            const target = state.quantityLimit || 1;
            const progressPct = Math.min(100, Math.round(itemCount / target * 100));
            progressFill.parentElement.classList.toggle('hidden',
                !isRunning && status !== 'complete' && !hasTarget);

            // `live` adds a pulsing animation to the status dot while the export is
            // actively working (fetching / cooling down / retrying).
            function setDotColor(color, live = false) {
                const statusClass = color === 'resumable'
                    ? 'status-resumable'
                    : 'status-' + color;
                statusIndicator.className = 'status-dot ' + statusClass + (live ? ' live' : '');
                statusIndicator.innerHTML = color === 'resumable' ? ICONS.playerPlay : '';
            }

            function setMeasuredProgress() {
                if (hasTarget) {
                    progressFill.classList.remove('indeterminate');
                    progressFill.style.width = progressPct + '%';
                } else {
                    progressFill.classList.remove('indeterminate');
                    progressFill.style.width = '0%';
                }
            }

            // Wait styling is per-state; clear it before each render, re-add below.
            progressFill.classList.remove('cooldown', 'rate-limit', 'safety-break', 'stopped');
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
                    const searchPhaseKey = { loading: 'searchLoading', connecting: 'searchConnecting', waiting: 'searchWaiting', collecting: 'searchCollecting', retrying: 'searchRetrying' }[state.searchPhase];
                    statusMessage.textContent = searchPhaseKey ? t(searchPhaseKey) : state.partialReason === 'replies_unavailable'
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
                        const retryMessage = t('retryInSeconds').replace('{seconds}',
                            formatNumber(Math.round(state.retryIn / 1000), currentLang));
                        statusMessage.textContent = `${formatError(state.error, t)} — ${retryMessage}`;
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
                        } else if (String(state.error || '').startsWith('SEARCH_')) {
                            statusMessage.textContent = `${itemCount > 0 ? t('partialSaved') + ' ' : ''}${t('searchResumeHint')}`;
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
                    statusMessage.textContent = state.completionReason === 'limit_reached'
                        ? t('limitReached')
                        : itemCount === 0
                        ? t(state.completionReason === 'no_matches' ? 'noMatchingPosts' : 'errNoData')
                        : (state.partialReason === 'replies_unavailable'
                            ? t('postsOnlyFallbackComplete')
                            : (state.completionReason === 'source_exhausted'
                                ? t('sourceExhausted')
                                : t('canContinue')));
                    progressFill.classList.remove('indeterminate');
                    progressFill.style.width = '100%';
                    break;

                case 'stopped':
                    exportStatus.classList.add('phase-stopped');
                    progressFill.classList.add('stopped');
                    statusText.innerHTML = ICONS.playerStop + ' ';
                    statusText.appendChild(document.createTextNode(t('exportStopped')));
                    setDotColor('resumable');
                    statusMessage.textContent = state.partialReason === 'replies_unavailable'
                        ? t('postsOnlyFallbackActive')
                        : t('canBeResumed');
                    setMeasuredProgress();
                    break;
            }

            if (!isRunning && state.resumeBlockedReason) {
                statusMessage.textContent = formatError(state.resumeBlockedReason, t);
            }

            // Update count display
            exportStatus.classList.toggle('is-running', isRunning);
            XPorterRollingCounter.render(tweetCountEl,
                formatCollectedCount(itemCount, mode, currentLang, currentTranslations),
                { animate: isRunning });

            return { resumeAddsItems };
        }

        return Object.freeze({ render });
    }
    root.XPorterExportStatus = Object.freeze({ mount });
})(globalThis);
