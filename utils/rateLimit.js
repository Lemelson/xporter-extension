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

            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);

            function onAbort() {
                clearTimeout(timer);
                reject(new Error('ABORTED'));
            }

            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Execute a request with rate limiting
     */
    async executeWithRateLimit(requestFn) {
        if (this._aborted) throw new Error('ABORTED');

        // Check if we need a cooldown after batch
        if (this.requestCount > 0 && this.requestCount % this.batchSize === 0) {
            this._emitStatus('cooldown', {
                duration: this.cooldownDuration,
                reason: `Cooldown after ${this.batchSize} requests`
            });
            await this._wait(this.cooldownDuration);
        }

        // Delay between requests
        if (this.requestCount > 0) {
            await this._wait(this.requestDelay);
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
                    const waitTime = this.rateLimitPause * Math.pow(2, attempt);
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
