// XPorter — Configuration & Constants
// Centralized config for all tunable parameters and debug logging

const XPORTER_CONFIG = {
    // Debug mode — set to true to enable verbose console output
    DEBUG: false,

    // Rate limiting
    REQUEST_DELAY: 3000,           // ms between API requests
    COOLDOWN_DURATION: 180000,     // 3 min cooldown after each batch
    RATE_LIMIT_PAUSE: 60000,       // 60s base wait on 429 (exponential backoff applied)
    MAX_RETRIES: 5,                // max retry attempts per request
    BATCH_SIZE: 20,                // requests before cooldown

    // API
    ENDPOINT_CACHE_TTL: 30 * 60 * 1000, // 30 min cache for discovered endpoints
    STALE_RETRY_BASE_WAIT: 10000,        // base wait on STALE_QUERY_ID (multiplied by attempt)
    NETWORK_RETRY_BASE_WAIT: 30000,      // base wait on network errors

    // Storage
    TWEETS_PER_BATCH: 50,          // tweets per storage batch
    STORAGE_WARN_THRESHOLD: 0.8,   // warn when storage usage exceeds 80%

    // Messaging
    MESSAGE_TIMEOUT: 5000,         // ms timeout for sendMessage (popup ↔ service worker)
    MESSAGE_TIMEOUT_SHORT: 2000,   // short timeout for simple queries

    // Bearer token (fallback — dynamically extracted at runtime)
    FALLBACK_BEARER_TOKEN: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
};

// ==================== Debug Logging ====================
// Only outputs when DEBUG is true. Use instead of console.log/warn/error.

const XLog = {
    log: (...args) => XPORTER_CONFIG.DEBUG && console.log('[XPorter]', ...args),
    warn: (...args) => XPORTER_CONFIG.DEBUG && console.warn('[XPorter]', ...args),
    error: (...args) => console.error('[XPorter]', ...args), // errors always log
    info: (...args) => XPORTER_CONFIG.DEBUG && console.info('[XPorter]', ...args)
};

// Export for use across all scripts
if (typeof globalThis !== 'undefined') {
    globalThis.XPORTER_CONFIG = XPORTER_CONFIG;
    globalThis.XLog = XLog;
}
