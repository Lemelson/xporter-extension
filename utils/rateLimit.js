// XPorter — Rate Limit Manager
// Handles request throttling to avoid X API rate limits

class RateLimitManager {
    constructor(options = {}) {
        const C = (typeof XPORTER_CONFIG !== 'undefined') ? XPORTER_CONFIG : {};
        this.requestDelay = options.requestDelay || C.REQUEST_DELAY || 3000;
        this.batchSize = options.batchSize || C.BATCH_SIZE || 20;
        this.cooldownDuration = options.cooldownDuration || C.COOLDOWN_DURATION || 180000;
        this.rateLimitPause = options.rateLimitPause || C.RATE_LIMIT_PAUSE || 60000;
        this.maxRetries = options.maxRetries || C.MAX_RETRIES || 5;

        // Adaptive pacing: when a provider hands us X's live x-rate-limit-*
        // budget, we space requests to fit that budget instead of using the
        // configured fallback delay/cooldown above.
        this.adaptivePacing = (options.adaptivePacing !== undefined)
            ? options.adaptivePacing
            : (C.ADAPTIVE_PACING !== false);
        this.rateLimitProvider = (typeof options.rateLimitProvider === 'function')
            ? options.rateLimitProvider
            : null;
        this.adaptiveFloor = options.adaptiveFloor || C.ADAPTIVE_MIN_DELAY || 5000;
        this.adaptivePad = (options.adaptivePad != null)
            ? options.adaptivePad
            : (C.ADAPTIVE_PAD != null ? C.ADAPTIVE_PAD : 2000);
        // Speed-preset knobs (see XPORTER_CONFIG.SPEED_PRESETS):
        // budgetFraction < 1 paces as if only that share of X's remaining
        // budget existed; raceReserve > 0 marks a racing preset — hold the
        // floor pace while the budget lasts, then wait out the window reset.
        this.budgetFraction = (options.budgetFraction > 0 && options.budgetFraction <= 1)
            ? options.budgetFraction
            : 1;
        this.raceReserve = options.raceReserve || 0;
        // Custom preset: the user explicitly asked for "pause N min every M
        // requests", so honor the batch cooldown even while adaptive pacing
        // is active (normally it only applies on the headerless fallback path).
        this.alwaysBatchCooldown = !!options.alwaysBatchCooldown;
        this.adaptiveHeaderTtl = options.adaptiveHeaderTtl || C.ADAPTIVE_HEADER_TTL || 300000;
        this.fallbackMinDelay = options.fallbackMinDelay || this.requestDelay;
        this.fallbackMaxDelay = Math.max(
            this.fallbackMinDelay,
            options.fallbackMaxDelay || this.fallbackMinDelay
        );

        this.requestCount = 0;
        this.totalRequests = 0;
        this.status = 'idle'; // idle, fetching, cooldown, error, retrying
        this.listeners = [];
        this._aborted = false;
        this._abortController = null;
        this.lastRequestAt = null; // wall-clock of the last successful request
        this.waitUntil = null;     // epoch ms the current _wait() ends (UI countdown)
    }

    /**
     * Register a status change listener
     */
    onStatusChange(callback) {
        this.listeners.push(callback);
    }

    /**
     * Emit status change event
     */
    _emitStatus(status, detail = {}) {
        this.status = status;
        const event = { running: true, status, ...detail, totalRequests: this.totalRequests };
        // Absolute end-of-wait timestamp so the UI can render a live countdown
        // that stays correct even when the event itself arrives late.
        if (Number.isFinite(detail.duration)) event.until = Date.now() + detail.duration;
        if (Number.isFinite(detail.retryIn)) event.until = Date.now() + detail.retryIn;
        this.listeners.forEach(cb => {
            try { cb(event); } catch (e) { XLog.error('Status listener error:', e); }
        });
    }

    /**
     * Wait for specified ms, instantly cancellable via AbortController.
     * No polling — uses a single event listener for abort.
     */
    async _wait(ms) {
        this.waitUntil = Date.now() + ms;
        try {
            return await this._waitInner(ms);
        } finally {
            this.waitUntil = null;
        }
    }

    async _waitInner(ms) {
        return new Promise((resolve, reject) => {
            // Create a fresh controller for this wait
            this._abortController = new AbortController();
            const signal = this._abortController.signal;

            // If already aborted, reject immediately
            if (this._aborted) {
                reject(new Error('ABORTED'));
                return;
            }

            // Keep the MV3 service worker alive during long waits (e.g. the
            // multi-minute batch cooldown). Without this, Chrome unloads the
            // worker after ~30s of inactivity and the export silently dies in
            // the middle of a cooldown. Touching a chrome API every 20s resets
            // the idle timer. Only needed for long waits.
            let keepAlive = null;
            if (ms > 20000 && typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
                keepAlive = setInterval(() => {
                    try { chrome.runtime.getPlatformInfo(() => { }); } catch (_) { /* noop */ }
                }, 20000);
            }

            const cleanup = () => {
                if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
                signal.removeEventListener('abort', onAbort);
            };

            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);

            function onAbort() {
                clearTimeout(timer);
                cleanup();
                reject(new Error('ABORTED'));
            }

            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Work out the wait before the next request from X's advertised budget.
     * Spreads whatever quota is left evenly across the time remaining in the
     * window — the same way X's own web client paces itself. Returns null when
     * adaptive pacing isn't usable (disabled, no provider, or stale/missing
     * headers) so the caller falls back to its configured delay + batch cooldown.
     *
     * @returns {{delay:number, waiting:boolean}|null}
     */
    _computeAdaptiveDelay() {
        if (!this.adaptivePacing || !this.rateLimitProvider) return null;

        let rl;
        try { rl = this.rateLimitProvider(); } catch (_) { rl = null; }
        if (!rl) return null;

        const remaining = Number(rl.remaining);
        const reset = Number(rl.reset);
        if (!Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(reset) || reset <= 0) {
            return null;
        }

        // A budget we read too long ago no longer reflects reality.
        if (Number.isFinite(rl.at) && (Date.now() - rl.at) > this.adaptiveHeaderTtl) return null;

        const msLeftInWindow = Math.max(0, reset * 1000 - Date.now());

        // Out of quota → hold until the window rolls over, plus a small margin.
        if (remaining <= 0) {
            return {
                delay: msLeftInWindow + this.adaptivePad,
                waiting: true
            };
        }

        // Burst-first presets: hold the promised pace while the budget lasts,
        // then wait out the window reset. Even-spreading the tail silently
        // turns a short export into 20+ second pauses; an explicit "X limit
        // reached" hold is honest and no slower overall. The small reserve
        // absorbs requests the user's own X tab makes against the same budget.
        if (this.raceReserve > 0) {
            if (remaining > this.raceReserve) {
                return { delay: this.adaptiveFloor + this.adaptivePad, waiting: false };
            }
            return { delay: msLeftInWindow + this.adaptivePad, waiting: true };
        }

        // Quota left → fill the rest of the window evenly. budgetFraction < 1
        // pretends part of the budget is already spent (extra safety margin).
        const effectiveRemaining = Math.max(1, Math.floor(remaining * this.budgetFraction));
        let delay = Math.ceil(msLeftInWindow / effectiveRemaining) + this.adaptivePad;
        if (delay < this.adaptiveFloor) delay = this.adaptiveFloor;
        return { delay, waiting: false };
    }

    // Batch cooldown: pause after every batchSize-th request, crediting wall
    // time already spent idle (e.g. resuming hours later with a restored
    // requestCount) — otherwise a resume starts with a pointless full
    // cooldown before request #1.
    async _maybeBatchCooldown() {
        if (this.requestCount % this.batchSize !== 0) return;
        const elapsed = this.lastRequestAt ? Date.now() - this.lastRequestAt : Infinity;
        const cooldownLeft = this.cooldownDuration - elapsed;
        if (cooldownLeft > 0) {
            this._emitStatus('cooldown', {
                duration: cooldownLeft,
                kind: 'batch',
                reason: `Cooldown after ${this.batchSize} requests`
            });
            await this._wait(cooldownLeft);
        }
    }

    _computeFallbackDelay() {
        if (this.fallbackMaxDelay === this.fallbackMinDelay) return this.fallbackMinDelay;
        return this.fallbackMinDelay
            + Math.floor(Math.random() * (this.fallbackMaxDelay - this.fallbackMinDelay + 1));
    }

    /**
     * Execute a request with rate limiting
     */
    async executeWithRateLimit(requestFn) {
        if (this._aborted) throw new Error('ABORTED');

        if (this.requestCount > 0) {
            const adaptive = this._computeAdaptiveDelay();
            if (adaptive) {
                // Header-driven pacing IS the throttle, so we normally skip
                // the blanket batch cooldown (custom preset opts back in via
                // alwaysBatchCooldown).
                if (this.alwaysBatchCooldown) {
                    await this._maybeBatchCooldown();
                    if (this._aborted) throw new Error('ABORTED');
                }
                // Every wait is visible in the UI, including the 2–7 second
                // preset pauses. Hiding short waits leaves the status stuck on
                // "Fetching..." even though no request is in flight.
                this._emitStatus('cooldown', {
                    duration: adaptive.delay,
                    kind: adaptive.waiting ? 'window' : 'pacing',
                    reason: adaptive.waiting
                        ? 'Waiting for X rate-limit window to reset'
                        : 'Pacing to X rate limit'
                });
                await this._wait(adaptive.delay);
            } else {
                // Fallback: no live budget — use the configured per-mode delay
                // and inject a batch cooldown every N requests as a safety net.
                await this._maybeBatchCooldown();
                const fallbackDelay = this._computeFallbackDelay();
                this._emitStatus('cooldown', {
                    duration: fallbackDelay,
                    kind: 'pacing',
                    reason: 'Pacing between requests'
                });
                await this._wait(fallbackDelay);
            }
        }

        // Execute with retry logic
        let lastError = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (this._aborted) throw new Error('ABORTED');

            try {
                this._emitStatus('fetching', {
                    // User-facing batch = the API page currently being fetched.
                    // The internal cooldown group remains requestInBatch.
                    batch: this.totalRequests + 1,
                    requestInBatch: (this.requestCount % this.batchSize) + 1
                });

                const result = await requestFn();
                this.requestCount++;
                this.totalRequests++;
                this.lastRequestAt = Date.now();
                return result;

            } catch (error) {
                lastError = error;

                if (error.message === 'RATE_LIMITED') {
                    if (attempt >= this.maxRetries) break;
                    const advertised = this._computeAdaptiveDelay();
                    const waitTime = advertised?.waiting
                        ? advertised.delay
                        : this.rateLimitPause * Math.pow(2, attempt);
                    this._emitStatus('error', {
                        error: 'Rate limited (429)',
                        retryIn: waitTime,
                        attempt: attempt + 1
                    });
                    await this._wait(waitTime);
                    this._emitStatus('retrying', { attempt: attempt + 1 });
                    continue;
                }

                if (error.message === 'ABORTED') {
                    throw error;
                }

                // Stale query ID — API changed, retry after delay
                if (error.message === 'STALE_QUERY_ID') {
                    if (attempt >= this.maxRetries) break;
                    const C = (typeof XPORTER_CONFIG !== 'undefined') ? XPORTER_CONFIG : {};
                    const waitTime = (C.STALE_RETRY_BASE_WAIT || 10000) * (attempt + 1);
                    this._emitStatus('error', {
                        error: 'API changed, refreshing...',
                        retryIn: waitTime,
                        attempt: attempt + 1
                    });
                    await this._wait(waitTime);
                    this._emitStatus('retrying', { attempt: attempt + 1 });
                    continue;
                }

                // Network errors — retry (NETWORK_TIMEOUT = a fetch that hit
                // its deadline in api.js; same recovery path as any drop)
                if (error.message === 'NETWORK_TIMEOUT' || error.message.includes('fetch') || error.message.includes('network') || error.message.includes('Failed')) {
                    if (attempt >= this.maxRetries) break;
                    const C = (typeof XPORTER_CONFIG !== 'undefined') ? XPORTER_CONFIG : {};
                    const waitTime = (C.NETWORK_RETRY_BASE_WAIT || 30000) * (attempt + 1);
                    this._emitStatus('error', {
                        error: 'Network error',
                        retryIn: waitTime,
                        attempt: attempt + 1
                    });
                    await this._wait(waitTime);
                    this._emitStatus('retrying', { attempt: attempt + 1 });
                    continue;
                }

                // Non-retryable errors
                throw error;
            }
        }

        throw lastError || new Error('MAX_RETRIES_EXCEEDED');
    }

    /**
     * Abort all pending operations — instantly cancels any active _wait()
     */
    abort() {
        this._aborted = true;
        if (this._abortController) {
            this._abortController.abort();
        }
        // No emit here: _emitStatus events carry running:true, and the SW
        // broadcasts its own definitive 'stopped' — emitting {running:true,
        // status:'idle'} right before it flickered the UI back to running.
        this.status = 'idle';
    }

    /**
     * Get serializable state for storage
     */
    getState() {
        return {
            requestCount: this.requestCount,
            totalRequests: this.totalRequests,
            lastRequestAt: this.lastRequestAt
        };
    }

    /**
     * Restore state from storage
     */
    restoreState(state) {
        if (state) {
            this.requestCount = state.requestCount || 0;
            this.totalRequests = state.totalRequests || 0;
            if (state.lastRequestAt) this.lastRequestAt = state.lastRequestAt;
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.RateLimitManager = RateLimitManager;
}
