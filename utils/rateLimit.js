// XPorter — Rate Limit Manager
// Handles request throttling to avoid X API rate limits

class RateLimitManager {
    constructor(options = {}) {
        this.requestDelay = options.requestDelay || 3000;        // ms between requests
        this.batchSize = options.batchSize || 20;                // requests before cooldown
        this.cooldownDuration = options.cooldownDuration || 180000; // 3 min cooldown
        this.rateLimitPause = options.rateLimitPause || 60000;   // 60s on 429
        this.maxRetries = options.maxRetries || 5;

        this.requestCount = 0;
        this.totalRequests = 0;
        this.status = 'idle'; // idle, fetching, cooldown, error, retrying
        this.listeners = [];
        this._aborted = false;
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
            try { cb(event); } catch (e) { console.error('Status listener error:', e); }
        });
    }

    /**
     * Wait for specified ms, respecting abort
     */
    async _wait(ms) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            // Check abort periodically
            const check = setInterval(() => {
                if (this._aborted) {
                    clearTimeout(timer);
                    clearInterval(check);
                    reject(new Error('ABORTED'));
                }
            }, 500);
            setTimeout(() => clearInterval(check), ms + 100);
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
                    const waitTime = 10000 * (attempt + 1);
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
                    const waitTime = 30000 * (attempt + 1);
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
     * Abort all pending operations
     */
    abort() {
        this._aborted = true;
        this._emitStatus('idle', { reason: 'Aborted by user' });
    }

    /**
     * Reset the manager
     */
    reset() {
        this.requestCount = 0;
        this.totalRequests = 0;
        this._aborted = false;
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
