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
    fs.readFileSync(path.join(__dirname, '../utils/config.js'), 'utf8'),
    { filename: 'utils/config.js' }
);

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

    // The generic non-burst path can still spread a budget evenly.
    const evenSpread = new RateLimitManager({
        adaptivePad: 0,
        rateLimitProvider: () => budget({ remaining: 100, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    const careful = new RateLimitManager({
        adaptivePad: 0,
        budgetFraction: 0.5,
        rateLimitProvider: () => budget({ remaining: 100, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert(careful.delay >= evenSpread.delay * 1.9, 'budgetFraction 0.5 must roughly double the spacing');

    // All five named presets are burst-first. This is the user-facing contract:
    // small post exports run at 2/3/4/7/12 s instead of silently stretching to
    // ~20 s as the rate-limit window gets older.
    const expectedPresetDelays = {
        turbo: 2000,
        fast: 3000,
        standard: 4000,
        careful: 7000,
        turtle: 12000
    };
    for (const [name, expectedDelay] of Object.entries(expectedPresetDelays)) {
        const preset = XPORTER_CONFIG.SPEED_PRESETS[name];
        assert(preset.raceReserve > 0, `${name} must use burst-first pacing`);
        const pacing = new RateLimitManager({
            ...preset,
            rateLimitProvider: () => budget({ remaining: 50, resetInMs: 600000 })
        })._computeAdaptiveDelay();
        assert.equal(pacing.delay, expectedDelay, `${name} must keep its advertised delay`);
        assert.equal(pacing.waiting, false);
    }
    assert.deepEqual(
        XPORTER_CONFIG.FALLBACK_REQUEST_DELAYS.posts,
        [4000, 5000],
        'headerless Standard post exports must not fall back to 20–25 s'
    );

    // A short Standard pause must still reach the UI. Without this event the
    // popup remains stuck on "Fetching..." throughout the four-second wait.
    const standardEvents = [];
    const standard = new RateLimitManager({
        ...XPORTER_CONFIG.SPEED_PRESETS.standard,
        rateLimitProvider: () => budget({ remaining: 50, resetInMs: 600000 })
    });
    standard.restoreState({ requestCount: 1, totalRequests: 1 });
    standard.onStatusChange(event => standardEvents.push(event));
    standard._wait = async () => {};
    await standard.executeWithRateLimit(async () => 'ok');
    assert.equal(standardEvents[0]?.status, 'cooldown', 'Standard wait must emit a UI pacing event');
    assert.equal(standardEvents[0]?.kind, 'pacing');
    assert.equal(standardEvents[0]?.duration, 4000);
    assert.equal(standardEvents[1]?.status, 'fetching', 'fetching must follow the visible countdown');
    assert.equal(standardEvents[1]?.batch, 2, 'the next fetched page must be shown as batch 2');

    // The shared UI helper resumes an in-flight wait at the correct point and
    // fills smoothly to 100% at the same deadline.
    const uiContext = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../utils/shared.js'), 'utf8'),
        uiContext,
        { filename: 'utils/shared.js' }
    );
    const waitProgress = vm.runInContext(`(() => {
        Date.now = () => 1000;
        const classes = new Set(['indeterminate']);
        const style = {
            transition: '',
            width: '',
            removeProperty(name) { delete this[name]; }
        };
        const element = {
            classList: { remove(name) { classes.delete(name); } },
            style,
            offsetWidth: 100
        };
        startWaitProgress(element, 4000, 4000);
        return {
            indeterminate: classes.has('indeterminate'),
            transition: style.transition,
            width: style.width
        };
    })()`, uiContext);
    assert.equal(waitProgress.indeterminate, false);
    assert.equal(waitProgress.transition, 'width 3000ms linear');
    assert.equal(waitProgress.width, '100%');

    // Budget above the reserve → hold the promised floor pace instead of
    // spreading over the whole window…
    const race = new RateLimitManager({
        adaptiveFloor: 2500,
        adaptivePad: 1000,
        raceReserve: 5,
        rateLimitProvider: () => budget({ remaining: 100, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert.equal(race.delay, 3500, 'racing preset must pace at floor + pad');
    assert.equal(race.waiting, false);
    // …and once the budget hits the reserve, wait out the window reset (an
    // honest hold) — never quietly stretch the pace to 10× the promised one.
    const raceDrained = new RateLimitManager({
        adaptiveFloor: 2500,
        adaptivePad: 0,
        raceReserve: 5,
        rateLimitProvider: () => budget({ remaining: 5, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert.equal(raceDrained.waiting, true, 'drained racing preset must hold for the reset');
    // (reset is floored to whole seconds, so allow ~1s of slack)
    assert(raceDrained.delay >= 599000, 'the hold must last until the window rolls over');

    // Custom preset: alwaysBatchCooldown must inject the batch pause even
    // while adaptive pacing is active (normally adaptive skips it).
    const customWaits = [];
    const custom = new RateLimitManager({
        adaptiveFloor: 2000,
        adaptivePad: 0,
        raceReserve: 2,
        batchSize: 20,
        cooldownDuration: 180000,
        alwaysBatchCooldown: true,
        rateLimitProvider: () => budget({ remaining: 100, resetInMs: 600000 })
    });
    custom.restoreState({ requestCount: 20, totalRequests: 20, lastRequestAt: Date.now() });
    custom._wait = async (ms) => customWaits.push(ms);
    await custom.executeWithRateLimit(async () => 'ok');
    assert.equal(customWaits.length, 2, 'custom must wait for batch cooldown AND the adaptive delay');
    assert(customWaits[0] > 170000, 'first wait must be the (nearly full) batch cooldown');
    assert.equal(customWaits[1], 2000, 'second wait must be the adaptive burst delay (floor + pad)');

    const fallback = new RateLimitManager({
        fallbackMinDelay: 5000,
        fallbackMaxDelay: 10000
    });
    for (let i = 0; i < 100; i++) {
        const delay = fallback._computeFallbackDelay();
        assert(delay >= 5000 && delay <= 10000, 'fallback jitter must stay in range');
    }

    const resumedAfterCooldown = new RateLimitManager({
        adaptivePacing: false,
        batchSize: 20,
        cooldownDuration: 180000,
        fallbackMinDelay: 3000,
        fallbackMaxDelay: 3000
    });
    resumedAfterCooldown.restoreState({
        requestCount: 20,
        totalRequests: 20,
        lastRequestAt: Date.now() - 181000
    });
    const resumedWaits = [];
    resumedAfterCooldown._wait = async (ms) => resumedWaits.push(ms);
    await resumedAfterCooldown.executeWithRateLimit(async () => 'ok');
    assert.deepEqual(
        resumedWaits,
        [3000],
        'resume after elapsed wall-clock cooldown must only use the normal request delay'
    );

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
                if (key === null) return { ...storageData };
                return { [key]: storageData[key] };
            },
            async set(values) {
                Object.assign(storageData, values);
            },
            async remove(keys) {
                for (const key of [].concat(keys)) delete storageData[key];
            },
            async getBytesInUse() {
                return 0;
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

    await XPorterStorage.recordExportStart('verified_followers', 'csv');
    const usage = await XPorterStorage.loadUsage();
    assert.equal(usage.byMode.verifiedFollowers, 1);
    assert.equal(
        usage.byMode.verified_followers,
        undefined,
        'verified follower usage must use the uninstall-report field name'
    );

    storageData.xporter_export_history = [{ id: 123, username: 'legacy' }];
    await XPorterStorage.deleteExportHistoryEntry('123');
    assert.deepEqual(
        storageData.xporter_export_history,
        [],
        'legacy numeric history IDs must remain deletable after DOM string conversion'
    );

    console.log('Rate-limit tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
