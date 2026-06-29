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
        this.listeners.forEach(cb => {
            try { cb(event); } catch (e) { XLog.error('Status listener error:', e); }
        });
    }

    /**
     * Wait for specified ms, instantly cancellable via AbortController.
     * No polling — uses a single event listener for abort.
     */
    async _wait(ms) {
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
            if (ms > 25000 && typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
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

        // Quota left → fill the rest of the window evenly.
        let delay = Math.ceil(msLeftInWindow / remaining) + this.adaptivePad;
        if (delay < this.adaptiveFloor) delay = this.adaptiveFloor;
        return { delay, waiting: false };
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
                // Header-driven pacing IS the throttle, so we skip the blanket
                // batch cooldown entirely. Long waits (followers' tight window,
                // or a reset hold) are surfaced as 'cooldown' so the UI shows a
                // live countdown instead of looking frozen.
                if (adaptive.delay >= 8000) {
                    this._emitStatus('cooldown', {
                        duration: adaptive.delay,
                        reason: adaptive.waiting
                            ? 'Waiting for X rate-limit window to reset'
                            : 'Pacing to X rate limit'
                    });
                }
                await this._wait(adaptive.delay);
            } else {
                // Fallback: no live budget — use the configured per-mode delay
                // and inject a batch cooldown every N requests as a safety net.
                if (this.requestCount % this.batchSize === 0) {
                    this._emitStatus('cooldown', {
                        duration: this.cooldownDuration,
                        reason: `Cooldown after ${this.batchSize} requests`
                    });
                    await this._wait(this.cooldownDuration);
                }
                await this._wait(this._computeFallbackDelay());
            }
        }

        // Execute with retry logic
        let lastError = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (this._aborted) throw new Error('ABORTED');

            try {
                this._emitStatus('fetching', {
                    batch: Math.floor(this.totalRequests / this.batchSize) + 1,
                    requestInBatch: (this.requestCount % this.batchSize) + 1
                });

                const result = await requestFn();
                this.requestCount++;
                this.totalRequests++;
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

                // Network errors — retry
                if (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('Failed')) {
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
        this._emitStatus('idle', { reason: 'Aborted by user' });
    }

    /**
     * Reset the manager
     */
    reset() {
        this.requestCount = 0;
        this.totalRequests = 0;
        this._aborted = false;
        this._abortController = null;
        this.status = 'idle';
        this._emitStatus('idle');
    }

    /**
     * Get serializable state for storage
     */
    getState() {
        return {
            requestCount: this.requestCount,
            totalRequests: this.totalRequests,
            requestDelay: this.requestDelay,
            batchSize: this.batchSize,
            cooldownDuration: this.cooldownDuration
        };
    }

    /**
     * Restore state from storage
     */
    restoreState(state) {
        if (state) {
            this.requestCount = state.requestCount || 0;
            this.totalRequests = state.totalRequests || 0;
            if (state.requestDelay) this.requestDelay = state.requestDelay;
            if (state.batchSize) this.batchSize = state.batchSize;
            if (state.cooldownDuration) this.cooldownDuration = state.cooldownDuration;
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.RateLimitManager = RateLimitManager;
}
