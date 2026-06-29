#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

globalThis.XPORTER_CONFIG = {
    REQUEST_DELAY: 3000,
    COOLDOWN_DURATION: 180000,
    RATE_LIMIT_PAUSE: 60000,
    MAX_RETRIES: 5,
    BATCH_SIZE: 20,
    ADAPTIVE_PACING: true,
    ADAPTIVE_MIN_DELAY: 5000,
    ADAPTIVE_PAD: 2000,
    ADAPTIVE_HEADER_TTL: 300000
};
globalThis.XLog = {
    log() {},
    warn() {},
    error() {},
    info() {}
};

vm.runInThisContext(
    fs.readFileSync(path.join(__dirname, '../utils/rateLimit.js'), 'utf8'),
    { filename: 'utils/rateLimit.js' }
);

function budget({ remaining, resetInMs, ageMs = 0 }) {
    const now = Date.now();
    return {
        remaining,
        reset: Math.floor((now + resetInMs) / 1000),
        at: now - ageMs
    };
}

async function run() {
    const oneLeft = new RateLimitManager({
        rateLimitProvider: () => budget({ remaining: 1, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert(oneLeft.delay >= 600000, 'normal pacing must not be capped before reset');

    const exhausted = new RateLimitManager({
        rateLimitProvider: () => budget({ remaining: 0, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert.equal(exhausted.waiting, true);
    assert(exhausted.delay >= 600000, 'exhausted budget must wait for reset');

    const invalid = new RateLimitManager({
        rateLimitProvider: () => ({ remaining: Number.NaN, reset: Number.NaN, at: Date.now() })
    })._computeAdaptiveDelay();
    assert.equal(invalid, null, 'invalid headers must use fallback pacing');

    const fallback = new RateLimitManager({
        fallbackMinDelay: 5000,
        fallbackMaxDelay: 10000
    });
    for (let i = 0; i < 100; i++) {
        const delay = fallback._computeFallbackDelay();
        assert(delay >= 5000 && delay <= 10000, 'fallback jitter must stay in range');
    }

    let attempts = 0;
    const waits = [];
    const retry = new RateLimitManager({
        rateLimitProvider: () => budget({ remaining: 0, resetInMs: 600000 }),
        maxRetries: 1
    });
    retry._wait = async (ms) => waits.push(ms);
    const result = await retry.executeWithRateLimit(async () => {
        if (attempts++ === 0) throw new Error('RATE_LIMITED');
        return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(waits.length, 1);
    assert(waits[0] >= 600000, '429 retry must honor the advertised reset');

    const finalFailureWaits = [];
    const finalFailure = new RateLimitManager({ maxRetries: 1 });
    finalFailure._wait = async (ms) => finalFailureWaits.push(ms);
    await assert.rejects(
        finalFailure.executeWithRateLimit(async () => {
            throw new Error('RATE_LIMITED');
        }),
        /RATE_LIMITED/
    );
    assert.equal(finalFailureWaits.length, 1, 'must not sleep after the final failed attempt');

    globalThis.USER_FEATURES = {};
    globalThis.USER_FIELD_TOGGLES = {};
    globalThis.TWEETS_FEATURES = {};
    globalThis.FOLLOWERS_FEATURES = {};
    globalThis.FOLLOWERS_FIELD_TOGGLES = {};
    globalThis.chrome = {
        cookies: {
            get({ name }, callback) {
                callback({ value: name === 'ct0' ? 'csrf' : 'auth' });
            }
        }
    };
    vm.runInThisContext(
        fs.readFileSync(path.join(__dirname, '../utils/api.js'), 'utf8'),
        { filename: 'utils/api.js' }
    );

    const reset = Math.floor((Date.now() + 900000) / 1000);
    const responses = [
        new Response(JSON.stringify({
            data: {
                user: {
                    result: {
                        rest_id: '1',
                        core: { name: 'Test', screen_name: 'test' },
                        legacy: {}
                    }
                }
            }
        }), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'x-rate-limit-limit': '500',
                'x-rate-limit-remaining': '499',
                'x-rate-limit-reset': String(reset)
            }
        }),
        new Response(JSON.stringify({ users: [], next_cursor_str: '0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    ];
    globalThis.fetch = async () => responses.shift();

    XPorterAPI.setLiveQueryId('UserByScreenName', 'test-query-id');
    await XPorterAPI.getUserByScreenName('test');
    assert.equal(XPorterAPI.getRateLimit('UserByScreenName').remaining, 499);
    await XPorterAPI.fetchFollowers('1');
    assert.equal(
        XPorterAPI.getRateLimit('Followers'),
        null,
        'a header-less response must clear only its endpoint budget'
    );
    assert.equal(
        XPorterAPI.getRateLimit('UserByScreenName').remaining,
        499,
        'one endpoint must not overwrite another endpoint budget'
    );

    const storageData = {
        xporter_settings: {
            adaptivePacing: false,
            theme: 'dark'
        }
    };
    chrome.runtime = { lastError: null };
    chrome.storage = {
        local: {
            async get(key) {
                return { [key]: storageData[key] };
            },
            async set(values) {
                Object.assign(storageData, values);
            }
        }
    };
    vm.runInThisContext(
        fs.readFileSync(path.join(__dirname, '../utils/storage.js'), 'utf8'),
        { filename: 'utils/storage.js' }
    );
    await XPorterStorage.saveSettings({ theme: 'light' });
    const savedSettings = await XPorterStorage.loadSettings();
    assert.equal(savedSettings.theme, 'light');
    assert.equal(
        savedSettings.adaptivePacing,
        false,
        'partial settings saves must preserve adaptivePacing=false'
    );

    console.log('Rate-limit tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
