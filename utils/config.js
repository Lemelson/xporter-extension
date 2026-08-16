// XPorter — Configuration & Constants
// Centralized config for all tunable parameters and debug logging

const XPORTER_CONFIG = {
    // Debug mode — set to true to enable verbose console output
    DEBUG: false,

    // Rate limiting. REQUEST_DELAY is used when adaptive pacing is explicitly
    // disabled; header-less adaptive requests use the mode-specific ranges below.
    REQUEST_DELAY: 3000,           // ms between API requests
    COOLDOWN_DURATION: 180000,     // 3 min cooldown after each batch
    RATE_LIMIT_PAUSE: 60000,       // fixed 60s retry wait after a real 429/network failure
    MAX_RETRIES: 5,                // max retry attempts per request
    BATCH_SIZE: 20,                // requests before cooldown

    // Adaptive pacing — use current x-rate-limit-* headers when available, but
    // never schedule a wait until the advertised reset. The selected speed
    // continues until X actually rejects a request; that failure retries after
    // one minute. Missing headers use the per-mode fallback range below.
    ADAPTIVE_PACING: true,         // master switch
    ADAPTIVE_MIN_DELAY: 5000,      // floor: never pace faster than this (anti-bot)
    ADAPTIVE_PAD: 2000,            // safety margin added to every computed wait
    ADAPTIVE_HEADER_TTL: 300000,   // ignore a captured budget older than 5 min
    FALLBACK_REQUEST_DELAYS: {
        posts: [4000, 5000],
        followers: [60000, 60000],
        following: [5000, 10000],
        verified_followers: [5000, 10000],
        about_account: [5000, 10000]
    },

    // Shared export-speed tiers behind the two independent user-facing controls
    // ("Posts Export Speed" and "User Lists Export Speed"). Adaptive pacing
    // stays the primary throttle; these only shift the safety margin around it.
    //   adaptiveFloor/adaptivePad  — override the ADAPTIVE_* values above
    //   budgetFraction             — pace as if only this share of X's
    //                                remaining budget were available (<1 = safer)
    //   raceReserve                — fixed-pace marker; advertised low budget
    //                                no longer creates a scheduled reset wait
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
        // mode's own Custom fields, clamped to CUSTOM_SPEED_LIMITS below.
    },
    // Clamp ranges (and defaults) for the Custom speed's user-typed values.
    CUSTOM_SPEED_LIMITS: {
        delaySec: [2, 120, 5],     // [min, max, default] s between requests
        batch: [5, 100, 20],       // requests per batch
        cooldownMin: [1, 30, 3]    // minutes of pause after each batch
    },

    // Bound each generated file so a multi-million-row export is never loaded
    // into one JS array/string. Posts use a smaller ceiling because article and
    // text fields can be much larger than user-list rows.
    DOWNLOAD_PART_LIMITS: {
        posts: { csv: 10000, json: 10000, xlsx: 10000, txt: 10000 },
        users: { csv: 100000, json: 50000, xlsx: 25000 }
    },
    STORAGE_BATCH_READ_SIZE: 100,
    RECENT_EXPORT_ID_LIMIT: 1000,
    // History duplicates row payloads. Large completed exports keep metadata
    // only; their current saved batches remain available from the main screen.
    EXPORT_HISTORY_DATA_LIMIT: 5000,

    // API
    // 24h: queryIds only change on X deploys, and a stale id self-heals via
    // withStaleRetry's forced re-discovery. A short TTL made nearly every
    // export session re-download X's multi-MB JS bundles first — on a slow
    // connection/VPN that is 10-60s of "Resolving user…" dead air (churn).
    ENDPOINT_CACHE_TTL: 24 * 60 * 60 * 1000,
    ABOUT_ACCOUNT_CACHE_TTL: 7 * 24 * 60 * 60 * 1000,
    ABOUT_ACCOUNT_FAILURE_CACHE_TTL: 60 * 60 * 1000,
    ABOUT_ACCOUNT_CACHE_MAX_ENTRIES: 25000,
    ABOUT_ACCOUNT_BATCH_SIZES: {
        turtle: 1,
        careful: 3,
        standard: 5,
        fast: 10,
        turbo: 20
    },
    ABOUT_ACCOUNT_CUSTOM_BATCH_RANGE: [1, 50, 5],
    ABOUT_ACCOUNT_RETRY_RANGE: [1, 1440, 5],
    STALE_RETRY_BASE_WAIT: 10000,        // base wait on STALE_QUERY_ID (multiplied by attempt)
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
