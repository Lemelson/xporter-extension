// XPorter — Configuration & Constants
// Centralized config for all tunable parameters and debug logging

const XPORTER_CONFIG = {
    // Debug mode — set to true to enable verbose console output
    DEBUG: false,

    // Rate limiting. REQUEST_DELAY is used when adaptive pacing is explicitly
    // disabled; header-less adaptive requests use the mode-specific ranges below.
    REQUEST_DELAY: 3000,           // ms between API requests
    COOLDOWN_DURATION: 180000,     // 3 min cooldown after each batch
    RATE_LIMIT_PAUSE: 60000,       // 60s base wait on 429 (exponential backoff applied)
    MAX_RETRIES: 5,                // max retry attempts per request
    BATCH_SIZE: 20,                // requests before cooldown

    // Adaptive pacing — derive the wait between requests from X's own
    // x-rate-limit-* response headers instead of a blind fixed delay. Much
    // faster on high-limit GraphQL endpoints, and safer: we stay inside the
    // exact budget X advertises, so we rarely trip a 429. Falls back to a
    // conservative per-mode range when no valid current headers are present.
    ADAPTIVE_PACING: true,         // master switch
    ADAPTIVE_MIN_DELAY: 5000,      // floor: never pace faster than this (anti-bot)
    ADAPTIVE_PAD: 2000,            // safety margin added to every computed wait
    ADAPTIVE_HEADER_TTL: 300000,   // ignore a captured budget older than 5 min
    FALLBACK_REQUEST_DELAYS: {
        posts: [4000, 5000],
        followers: [60000, 60000],
        following: [5000, 10000],
        verified_followers: [5000, 10000]
    },

    // Export speed presets — the single user-facing pacing knob (settings →
    // "Export Speed"). Adaptive pacing stays the primary throttle in every
    // preset; these only shift the safety margin around it.
    //   adaptiveFloor/adaptivePad  — override the ADAPTIVE_* values above
    //   budgetFraction             — pace as if only this share of X's
    //                                remaining budget were available (<1 = safer)
    //   raceReserve                — hold the promised floor pace while X has
    //                                more than this many requests left, then
    //                                wait out the window reset. All named
    //                                presets use this burst-first model because
    //                                exports are finite foreground jobs, not a
    //                                continuous background sync.
    //   fallbackScale              — multiplier on FALLBACK_REQUEST_DELAYS
    //   batchSize/cooldownDuration — headerless-fallback batch rhythm
    SPEED_PRESETS: {
        turbo: {
            adaptiveFloor: 1500, adaptivePad: 500, budgetFraction: 1,
            raceReserve: 2, fallbackScale: 0.5,
            batchSize: 30, cooldownDuration: 45000
        },
        fast: {
            adaptiveFloor: 2500, adaptivePad: 500, budgetFraction: 1,
            raceReserve: 3, fallbackScale: 0.75,
            batchSize: 25, cooldownDuration: 60000
        },
        standard: {
            adaptiveFloor: 3000, adaptivePad: 1000, budgetFraction: 1,
            raceReserve: 5, fallbackScale: 1,
            batchSize: 20, cooldownDuration: 180000
        },
        careful: {
            adaptiveFloor: 5000, adaptivePad: 2000, budgetFraction: 1,
            raceReserve: 8, fallbackScale: 1.5,
            batchSize: 15, cooldownDuration: 300000
        },
        turtle: {
            adaptiveFloor: 8000, adaptivePad: 4000, budgetFraction: 1,
            raceReserve: 12, fallbackScale: 2.5,
            batchSize: 10, cooldownDuration: 480000
        }
        // 'custom' is not listed here — createRateLimiter() builds it from the
        // user's customDelaySec / customBatchSize / customCooldownMin settings,
        // clamped to CUSTOM_SPEED_LIMITS below.
    },
    // Clamp ranges (and defaults) for the Custom speed's user-typed values.
    CUSTOM_SPEED_LIMITS: {
        delaySec: [2, 120, 5],     // [min, max, default] s between requests
        batch: [5, 100, 20],       // requests per batch
        cooldownMin: [1, 30, 3]    // minutes of pause after each batch
    },

    // API
    // 24h: queryIds only change on X deploys, and a stale id self-heals via
    // withStaleRetry's forced re-discovery. A short TTL made nearly every
    // export session re-download X's multi-MB JS bundles first — on a slow
    // connection/VPN that is 10-60s of "Resolving user…" dead air (churn).
    ENDPOINT_CACHE_TTL: 24 * 60 * 60 * 1000,
    STALE_RETRY_BASE_WAIT: 10000,        // base wait on STALE_QUERY_ID (multiplied by attempt)
    NETWORK_RETRY_BASE_WAIT: 30000,      // base wait on network errors
    API_FETCH_TIMEOUT: 30000,            // ms per GraphQL/REST request — a hung fetch must fail visibly, not hang the export forever
    DISCOVERY_FETCH_TIMEOUT: 15000,      // ms per discovery fetch (x.com page / JS bundle)
    DISCOVERY_TOTAL_TIMEOUT: 25000,      // ms cap on a whole discovery pass before falling back to known queryIds

    // Storage
    TWEETS_PER_BATCH: 50,          // tweets per storage batch
    STORAGE_WARN_THRESHOLD: 0.8,   // warn when storage usage exceeds 80%

    // Messaging
    MESSAGE_TIMEOUT: 5000,           // ms timeout for sendMessage (popup ↔ service worker)
    MESSAGE_TIMEOUT_SHORT: 2000,     // short timeout for simple queries
    DOWNLOAD_MESSAGE_TIMEOUT: 30000, // downloads: large XLSX/JSON builds can exceed 5s

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
