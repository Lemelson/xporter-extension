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
        adaptiveFloor: 3000,
        adaptivePad: 1000,
        rateLimitProvider: () => budget({ remaining: 0, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert.deepEqual(
        exhausted,
        { delay: 4000, waiting: false },
        'advertised exhaustion must keep the selected pace until X actually rejects a request'
    );

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

    // A 429 is a distinct visible phase: first pause with a countdown, then
    // keep the actual retry labelled as a retry while it is in flight. Calling
    // that second request "Fetching..." made the popup look stuck and hid why
    // the same About batch was being attempted again.
    const retryEvents = [];
    const retryLimiter = new RateLimitManager({
        adaptivePacing: false,
        rateLimitPause: 30000,
        maxRetries: 1
    });
    retryLimiter.onStatusChange(event => retryEvents.push(event));
    retryLimiter._wait = async () => {};
    let retryCalls = 0;
    const retryResult = await retryLimiter.executeWithRateLimit(async () => {
        retryCalls += 1;
        if (retryCalls === 1) throw new Error('RATE_LIMITED');
        return 'recovered';
    });
    assert.equal(retryResult, 'recovered');
    assert.deepEqual(
        retryEvents.map(event => event.status),
        ['fetching', 'rate_limited', 'retrying'],
        'a rate-limit retry must never fall back to the generic fetching label'
    );
    assert.equal(retryEvents[1]?.retryIn, 30000);
    assert.equal(retryEvents[1]?.kind, 'window');
    assert.equal(retryEvents[2]?.attempt, 1);
    assert.equal(retryEvents[2]?.batch, 1);

    // The shared UI helper resumes an in-flight wait at the correct point and
    // fills smoothly to 100% at the same deadline.
    const uiContext = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../utils/shared.js'), 'utf8'),
        uiContext,
        { filename: 'utils/shared.js' }
    );
    const localizedDecimals = vm.runInContext(`([
        parseLocalizedDecimal('0.5', 5),
        parseLocalizedDecimal('0,5', 5),
        parseLocalizedDecimal(' 1,25 ', 5),
        parseLocalizedDecimal('not-a-number', 5)
    ])`, uiContext);
    assert.deepEqual(
        Array.from(localizedDecimals),
        [0.5, 0.5, 1.25, 5],
        'Custom pacing must accept decimal dots and commas without truncating'
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

    const repeatedWaitProgress = vm.runInContext(`(() => {
        let now = 1000;
        Date.now = () => now;
        const widthWrites = [];
        const style = {
            transition: '',
            set width(value) { widthWrites.push(value); },
            get width() { return widthWrites.at(-1) || ''; },
            removeProperty(name) { delete this[name]; }
        };
        const element = {
            classList: { remove() {} },
            style,
            offsetWidth: 100
        };
        startWaitProgress(element, 61000, 60000);
        now = 3000;
        startWaitProgress(element, 61000, 58000);
        stopWaitProgress(element);
        startWaitProgress(element, 61000, 58000);
        return widthWrites;
    })()`, uiContext);
    assert.deepEqual(
        Array.from(repeatedWaitProgress),
        ['0%', '100%', '0%', '100%'],
        'polling must not restart the same wait, but Stop must clear the guard for a new wait'
    );

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
    // …and once the budget hits the reserve, keep that same selected pace.
    // The headers are advisory; only an actual failed request may pause the
    // export for a retry.
    const raceDrained = new RateLimitManager({
        adaptiveFloor: 2500,
        adaptivePad: 0,
        raceReserve: 5,
        rateLimitProvider: () => budget({ remaining: 5, resetInMs: 600000 })
    })._computeAdaptiveDelay();
    assert.deepEqual(
        raceDrained,
        { delay: 2500, waiting: false },
        'a low advertised reserve must not schedule a multi-minute hold'
    );

    // Independent Scheduled breaks must inject the batch pause even while
    // adaptive pacing is active (normally adaptive skips it).
    const customWaits = [];
    const scheduledBreak = new RateLimitManager({
        adaptiveFloor: 2000,
        adaptivePad: 0,
        raceReserve: 2,
        batchSize: 20,
        cooldownDuration: 180000,
        alwaysBatchCooldown: true,
        rateLimitProvider: () => budget({ remaining: 100, resetInMs: 600000 })
    });
    scheduledBreak.restoreState({ requestCount: 20, totalRequests: 20, lastRequestAt: Date.now() });
    scheduledBreak._wait = async (ms) => customWaits.push(ms);
    await scheduledBreak.executeWithRateLimit(async () => 'ok');
    assert.equal(customWaits.length, 2, 'Scheduled breaks must wait for the batch pause AND the adaptive delay');
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

    const namedFallback = new RateLimitManager({
        adaptivePacing: false,
        batchSize: 20,
        cooldownDuration: 180000,
        fallbackMinDelay: 4000,
        fallbackMaxDelay: 4000
    });
    namedFallback.restoreState({
        requestCount: 20,
        totalRequests: 20,
        lastRequestAt: Date.now()
    });
    const namedFallbackWaits = [];
    namedFallback._wait = async (ms) => namedFallbackWaits.push(ms);
    await namedFallback.executeWithRateLimit(async () => 'ok');
    assert.deepEqual(
        namedFallbackWaits,
        [4000],
        'a named speed without live headers must not inject a scheduled batch cooldown'
    );

    const livePacing = new RateLimitManager({
        adaptiveFloor: 12000,
        adaptivePad: 4000,
        batchSize: 10,
        cooldownDuration: 480000,
        fallbackMinDelay: 15000,
        fallbackMaxDelay: 25000
    });
    livePacing.restoreState({
        requestCount: 7,
        totalRequests: 9,
        lastRequestAt: 123
    });
    livePacing.reconfigure({
        adaptiveFloor: 2000,
        adaptivePad: 500,
        batchSize: 30,
        cooldownDuration: 45000,
        fallbackMinDelay: 2000,
        fallbackMaxDelay: 2500
    });
    assert.equal(livePacing.adaptiveFloor, 2000,
        'a running limiter must accept the newly selected speed');
    assert.equal(livePacing.batchSize, 30);
    assert.equal(livePacing.fallbackMinDelay, 2000);
    assert.equal(livePacing.requestCount, 7,
        'live pacing changes must preserve request counters');
    assert.equal(livePacing.totalRequests, 9);
    assert.equal(livePacing.lastRequestAt, 123,
        'live pacing changes must preserve cooldown timing');

    const changedPacing = new RateLimitManager({
        requestDelay: 12000,
        batchSize: 50,
        cooldownDuration: 600000
    });
    changedPacing.restoreState({
        requestCount: 7,
        totalRequests: 9,
        requestDelay: 2000,
        batchSize: 5,
        cooldownDuration: 30000,
        lastRequestAt: 123
    });
    assert.equal(changedPacing.requestDelay, 12000, 'resume must keep the newly selected request delay');
    assert.equal(changedPacing.batchSize, 50, 'resume must keep the newly selected batch size');
    assert.equal(changedPacing.cooldownDuration, 600000, 'resume must keep the newly selected cooldown');
    assert.equal(changedPacing.requestCount, 7, 'resume must restore request counters');
    assert.equal(changedPacing.lastRequestAt, 123, 'resume must restore cooldown timing');

    let attempts = 0;
    const waits = [];
    const retry = new RateLimitManager({
        rateLimitProvider: () => budget({ remaining: 0, resetInMs: 600000 }),
        rateLimitPause: 60000,
        maxRetries: 1
    });
    retry._wait = async (ms) => waits.push(ms);
    const result = await retry.executeWithRateLimit(async () => {
        if (attempts++ === 0) throw new Error('RATE_LIMITED');
        return 'ok';
    });
    assert.equal(result, 'ok');
    assert.deepEqual(
        waits,
        [60000],
        'an actual 429 must retry after one minute instead of waiting for the advertised reset'
    );

    let repeatedAttempts = 0;
    const repeatedWaits = [];
    const repeated429 = new RateLimitManager({
        rateLimitPause: 60000,
        maxRetries: 2
    });
    repeated429._wait = async (ms) => repeatedWaits.push(ms);
    const repeatedResult = await repeated429.executeWithRateLimit(async () => {
        repeatedAttempts += 1;
        if (repeatedAttempts < 3) throw new Error('RATE_LIMITED');
        return 'ok';
    });
    assert.equal(repeatedResult, 'ok');
    assert.deepEqual(
        repeatedWaits,
        [60000, 60000],
        'each repeated 429 must retry on the same one-minute cadence'
    );

    let networkAttempts = 0;
    const networkWaits = [];
    const networkRetry = new RateLimitManager({
        rateLimitPause: 60000,
        maxRetries: 1
    });
    networkRetry._wait = async (ms) => networkWaits.push(ms);
    const networkResult = await networkRetry.executeWithRateLimit(async () => {
        networkAttempts += 1;
        if (networkAttempts === 1) throw new Error('NETWORK_TIMEOUT');
        return 'ok';
    });
    assert.equal(networkResult, 'ok');
    assert.deepEqual(
        networkWaits,
        [60000],
        'an actual network failure must retry after one minute'
    );

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

    const exhaustedStaleWaits = [];
    let exhaustedStaleCalls = 0;
    const exhaustedStale = new RateLimitManager({ maxRetries: 5 });
    exhaustedStale._wait = async (ms) => exhaustedStaleWaits.push(ms);
    await assert.rejects(
        exhaustedStale.executeWithRateLimit(async () => {
            exhaustedStaleCalls += 1;
            const error = new Error('STALE_QUERY_ID');
            error.staleCandidatesExhausted = true;
            throw error;
        }),
        error => error.message === 'STALE_QUERY_ID' && error.staleCandidatesExhausted === true
    );
    assert.equal(
        exhaustedStaleCalls,
        1,
        'a fully exhausted API recovery cycle must not be repeated by RateLimitManager'
    );
    assert.deepEqual(
        exhaustedStaleWaits,
        [],
        'terminal stale exhaustion must not add another 10/20/30/40/50 second wait'
    );

    let recoverableStaleCalls = 0;
    const recoverableStaleWaits = [];
    const recoverableStale = new RateLimitManager({ maxRetries: 1 });
    recoverableStale._wait = async (ms) => recoverableStaleWaits.push(ms);
    const recoveredStaleResult = await recoverableStale.executeWithRateLimit(async () => {
        recoverableStaleCalls += 1;
        if (recoverableStaleCalls === 1) throw new Error('STALE_QUERY_ID');
        return 'recovered';
    });
    assert.equal(recoveredStaleResult, 'recovered');
    assert.equal(recoverableStaleCalls, 2, 'a non-exhausted stale signal may still use one outer retry');
    assert.deepEqual(recoverableStaleWaits, [10000]);

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
        fs.readFileSync(path.join(__dirname, '../utils/api-parsers.js'), 'utf8'),
        { filename: 'utils/api-parsers.js' }
    );
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

    const settingsCache = { theme: 'dark' };
    uiContext.__settingsCache = settingsCache;
    uiContext.chrome = {
        runtime: {
            lastError: null,
            sendMessage(_message, callback) { callback({ error: 'STORAGE_FULL' }); }
        }
    };
    const failedPatch = await vm.runInContext(
        'persistSettingsPatch(__settingsCache, { theme: "light" })',
        uiContext
    );
    assert.equal(failedPatch.error, 'STORAGE_FULL');
    assert.equal(settingsCache.theme, 'dark', 'a failed settings write must not advance the popup cache');
    uiContext.chrome.runtime.sendMessage = (_message, callback) => callback({ success: true });
    await vm.runInContext('persistSettingsPatch(__settingsCache, { theme: "light" })', uiContext);
    assert.equal(settingsCache.theme, 'light', 'a confirmed settings write must advance the popup cache');
    await XPorterStorage.saveSettings({ theme: 'light' });
    const savedSettings = await XPorterStorage.loadSettings();
    assert.equal(savedSettings.theme, 'light');
    assert.equal(
        savedSettings.adaptivePacing,
        false,
        'partial settings saves must preserve adaptivePacing=false'
    );

    await XPorterStorage.recordExportStart('verified_followers', 'csv');
    let usage = await XPorterStorage.loadUsage();
    assert.equal(usage.byMode.verifiedFollowers, 1);
    assert.equal(
        usage.byMode.verified_followers,
        undefined,
        'verified follower usage must use the uninstall-report field name'
    );

    assert.equal(usage.lastPhase, 'resolving_user');
    assert.equal(usage.firstItemMs, 0);
    await XPorterStorage.recordExportPhase('fetching');
    await XPorterStorage.recordFirstItem(usage.currentExportStartedAt + 1250);
    usage = await XPorterStorage.loadUsage();
    assert.equal(usage.lastPhase, 'fetching');
    assert.equal(usage.firstItemMs, 1250);
    await XPorterStorage.recordExportPhase('not-a-real-phase');
    assert.equal(
        (await XPorterStorage.loadUsage()).lastPhase,
        'fetching',
        'unknown phases must not enter uninstall telemetry'
    );

    storageData.xporter_export_history = [{ id: 123, username: 'legacy' }];
    await XPorterStorage.deleteExportHistoryEntry('123');
    assert.deepEqual(
        storageData.xporter_export_history,
        [],
        'legacy numeric history IDs must remain deletable after DOM string conversion'
    );

    const now = Date.now();
    storageData.xporter_export_history = [
        {
            id: 'old',
            completedAt: now - (5 * 60 * 60 * 1000),
            hasData: true,
            items: [{ id: 'old-post' }]
        },
        {
            id: 'fresh',
            completedAt: now - (30 * 60 * 1000),
            hasData: true,
            items: [{ id: 'fresh-post' }]
        }
    ];
    await XPorterStorage.pruneExpiredExportHistory({ autoExpireEnabled: true, autoExpireHours: 4 }, now);
    assert.equal(
        storageData.xporter_export_history[0].items,
        undefined,
        'expired history entries must drop their saved export payload'
    );
    assert.equal(storageData.xporter_export_history[0].hasData, false);
    assert.deepEqual(
        storageData.xporter_export_history[1].items,
        [{ id: 'fresh-post' }],
        'fresh history entries must remain downloadable'
    );

    storageData.xporter_export_history = [
        {
            id: 'disabled',
            completedAt: now - (5 * 60 * 60 * 1000),
            hasData: true,
            items: [{ id: 'kept-post' }]
        }
    ];
    await XPorterStorage.pruneExpiredExportHistory({ autoExpireEnabled: false, autoExpireHours: 4 }, now);
    assert.deepEqual(
        storageData.xporter_export_history[0].items,
        [{ id: 'kept-post' }],
        'disabled auto-expire must keep history payloads'
    );

    console.log('Rate-limit tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
