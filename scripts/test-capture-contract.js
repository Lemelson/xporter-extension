#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkerHarness } = require('./test-extension-core/worker-harness.js');
const { withTimeout } = require('./test-extension-core/support.js');

const ROOT = path.join(__dirname, '..');
const CONTRACT_FILE = 'utils/capture-contract.js';
const EXPECTED_OPERATIONS = [
    'Followers',
    'Following',
    'BlueVerifiedFollowers',
    'UserTweets',
    'UserOriginalsTimeline',
    'UserRepliesTimeline',
    'UserTweetsAndReplies',
    'Bookmarks',
    'TweetResultsByRestIds',
    'UserByScreenName',
    'AboutAccountQuery',
    'SearchTimeline'
];

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function load(file, context) {
    vm.runInContext(read(file), context, { filename: file });
}

function testSharedContractShape() {
    assert(
        fs.existsSync(path.join(ROOT, CONTRACT_FILE)),
        'capture operations and caps must have one shared classic-script contract'
    );
    const context = vm.createContext({ globalThis: {} });
    load(CONTRACT_FILE, context);
    const contract = context.globalThis.XPorterCaptureContract;

    assert(contract, 'contract facade must be published');
    assert.deepEqual(
        JSON.parse(JSON.stringify(contract.TRACKED_OPERATIONS)),
        EXPECTED_OPERATIONS
    );
    assert.equal(contract.MAX_BODY_CHARS, 8 * 1024 * 1024);
    assert.equal(contract.MAX_FEED_BODY_CHARS, 2 * 1024 * 1024);
    assert.equal(contract.MAX_POSTS_PER_MESSAGE, 250);
    assert.equal(contract.MAX_POST_TEXT_CHARS, 25_000);
    assert.equal(contract.isTrackedOperation('SearchTimeline'), true);
    assert.equal(contract.isTrackedOperation('NotAnXPorterOperation'), false);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.TRACKED_OPERATIONS), true);
    assert.throws(
        () => contract.TRACKED_OPERATIONS.push('DriftedOperation'),
        error => error?.name === 'TypeError'
    );
}

function testManifestOrderAndConsumerOwnership() {
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.minimum_chrome_version, '111');
    const main = manifest.content_scripts.find(entry => entry.world === 'MAIN');
    const isolated = manifest.content_scripts.find(entry => !entry.world);
    // Chromium deduplicates script paths per extension, across execution worlds.
    const injected = new Set();
    for (const [entry, consumer] of [
        [main, 'content/interceptor.js'], [isolated, 'content/content.js']
    ]) {
        const context = vm.createContext({ globalThis: {} });
        for (const file of entry.js) {
            if (file === consumer || file === 'content/feed-parser.js') continue;
            if (injected.has(file)) continue;
            injected.add(file);
            load(file, context);
        }
        assert.equal(typeof context.globalThis.XPorterCaptureContract?.isTrackedOperation, 'function',
            `capture contract must survive cross-world path deduplication before ${consumer}`);
        assert.equal(typeof context.globalThis.XPorterNativeTemplate?.parseRequestUrl, 'function');
    }

    const interceptor = read('content/interceptor.js');
    const relay = read('content/content.js');
    assert.match(interceptor, /XPorterCaptureContract/);
    assert.match(relay, /XPorterCaptureContract/);
    assert.doesNotMatch(interceptor, /const\s+TRACKED\s*=/);
    assert.doesNotMatch(relay, /const\s+RELAY_TRACKED_OPERATIONS\s*=/);
    assert.match(relay, /RELAY_POST_ID_PATTERN/);
    // One post-operation allowlist, owned by the contract (no local copies).
    const feedParser = read('content/feed-parser.js');
    for (const source of [relay, feedParser]) {
        assert.match(source, /isPostOperation/);
        assert.doesNotMatch(source, /TweetDetail\|Bookmarks\|Likes/);
    }
    assert.match(interceptor, /operationFromUrl/);
    assert.match(interceptor, /XPorterNativeTemplate\?\.parseRequestUrl/);
    for (const source of [interceptor, relay]) {
        assert.doesNotMatch(source, /8\s*\*\s*1024\s*\*\s*1024/);
    }
}

function createContentHarness({ onRuntimeMessage, postToMain, pathname = '/home', querySelector } = {}) {
    const windowListeners = new Map();
    const navigationListeners = new Map();
    const runtimeMessages = [];
    const timers = new Set();
    let runtimeListener;
    let mutationObservers = 0;
    const window = {
        location: {
            pathname,
            href: `https://x.com${pathname}`,
            origin: 'https://x.com'
        },
        navigation: {
            addEventListener(type, listener) { navigationListeners.set(type, listener); },
            removeEventListener(type) { navigationListeners.delete(type); }
        },
        addEventListener(type, listener) {
            windowListeners.set(type, listener);
        },
        removeEventListener(type, listener) {
            if (windowListeners.get(type) === listener) windowListeners.delete(type);
        },
        postMessage(message) { postToMain?.(message); }
    };
    window.window = window;
    const document = {
        documentElement: {},
        body: null,
        querySelector: querySelector || (() => null),
        addEventListener() {},
        getElementById() { return null; }
    };
    const runtime = {
        id: 'xporter-test',
        sendMessage(message) {
            runtimeMessages.push(
                JSON.parse(JSON.stringify(message))
            );
            return Promise.resolve(onRuntimeMessage?.(message) || { success: true });
        },
        onMessage: { addListener(listener) { runtimeListener = listener; } }
    };
    const context = vm.createContext({
        globalThis: window,
        window,
        document,
        URL,
        console,
        setTimeout(callback, delay) {
            const id = setTimeout(() => { timers.delete(id); callback(); }, delay);
            timers.add(id);
            return id;
        },
        clearTimeout(id) { timers.delete(id); clearTimeout(id); },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; mutationObservers += 1; }
            observe() {}
            disconnect() {}
        },
        chrome: { runtime }
    });
    load(CONTRACT_FILE, context);
    load('content/content.js', context);
    return {
        context,
        runtime,
        runtimeMessages,
        windowListeners,
        navigationListeners,
        pendingTimers: () => timers.size,
        mutationObservers: () => mutationObservers,
        dispatchRuntime(message) {
            return new Promise(resolve => runtimeListener(message, {}, resolve));
        },
        dispatch(data, eventOverrides = {}) {
            windowListeners.get('message')({
                source: window,
                origin: window.location.origin,
                data,
                ...eventOverrides
            });
        }
    };
}

function createInterceptorHarness({ postToContent } = {}) {
    const posted = [];
    const listeners = new Map();
    class FakeXHR {
        constructor() { this.listeners = {}; this.responseType = ''; }
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
        emit(type) {
            const pending = (this.listeners[type] || []).splice(0);
            for (const callback of pending) callback();
        }
        emitLoad() { this.emit('load'); }
    }
    FakeXHR.prototype.open = function (_method, url) { this.responseURL = url; };
    FakeXHR.prototype.getResponseHeader = function (name) {
        return this.responseHeaders?.[name.toLowerCase()] ?? null;
    };

    const window = {
        location: { origin: 'https://x.com', pathname: '/search' },
        _bodyText: '{}',
        addEventListener(type, listener) { listeners.set(type, listener); },
        postMessage(message) {
            posted.push(JSON.parse(JSON.stringify(message)));
            postToContent?.(message);
        },
        async fetch() {
            if (this._networkError) throw this._networkError;
            const bodyText = this._bodyText;
            const readError = this._readError;
            const headers = this._headers || {};
            return {
                status: this._status || 200,
                headers: { get: name => headers[name.toLowerCase()] ?? null },
                clone() {
                    return {
                        async text() { if (readError) throw readError; return bodyText; }
                    };
                }
            };
        },
        XPorterFeedParser: {
            supportsOperation(operationName) {
                return operationName === 'HomeTimeline';
            },
            extractPosts() {
                return [{ id: '1234567890', text: 'seen' }];
            }
        },
        XPorterNativeTemplate: {
            parseRequestUrl() { return null; }
        }
    };
    window.window = window;
    const context = vm.createContext({
        globalThis: window,
        window,
        XMLHttpRequest: FakeXHR,
        Request,
        URL,
        console,
        setTimeout,
        clearTimeout
    });
    load(CONTRACT_FILE, context);
    load('content/interceptor.js', context);
    return { context, window, posted, FakeXHR,
        dispatch(data) { listeners.get('message')?.({source:window, origin:window.location.origin, data}); }
    };
}

async function testMainWorldRejectionBehavior() {
    let signalFeed;
    const feed = new Promise(resolve => { signalFeed = resolve; });
    const harness = createInterceptorHarness({postToContent: message => {
        if (message.type === '__XPORTER_SEEN_POSTS__') signalFeed();
    }});
    const contract =
        harness.context.globalThis.XPorterCaptureContract;
    const graphqlUrl = operation =>
        `https://x.com/i/api/graphql/abcdefghijk/${operation}`;

    await harness.window.fetch(graphqlUrl('NotAnXPorterOperation'));

    harness.window._bodyText = 'x'.repeat(contract.MAX_BODY_CHARS + 1);
    await harness.window.fetch(graphqlUrl('SearchTimeline'));

    harness.window._bodyText = '{}';
    await harness.window.fetch(graphqlUrl('SearchTimeline'));

    harness.window._bodyText =
        'x'.repeat(contract.MAX_FEED_BODY_CHARS + 1);
    await harness.window.fetch(graphqlUrl('HomeTimeline'));

    harness.window._bodyText = '{"tweet_results":{}}';
    await harness.window.fetch(graphqlUrl('HomeTimeline'));
    // The passive parser schedules work once; wait for that event explicitly.
    // Its own bounded test deadline catches a missing dispatch.
    await withTimeout(() => feed, 'passive feed dispatch', 1000);

    assert.deepEqual(
        harness.posted.map(message => message.type),
        ['__XPORTER_GRAPHQL_RESPONSE__', '__XPORTER_GRAPHQL_RESPONSE__', '__XPORTER_SEEN_POSTS__']
    );
    assert.equal(harness.posted[0].error, 'SEARCH_RESPONSE_TOO_LARGE');
    assert.equal(harness.posted[0].bodyText, '', 'oversized data must never cross the relay');
}

async function testIsolatedRelayRejectionBehavior() {
    const offSearch = createContentHarness({ pathname: '/home' });
    offSearch.dispatch({
        type: '__XPORTER_GRAPHQL_RESPONSE__',
        operationName: 'SearchTimeline',
        url: 'https://x.com/i/api/graphql/query/SearchTimeline',
        status: 200,
        bodyText: '{}'
    });
    await Promise.resolve();
    assert.deepEqual(offSearch.runtimeMessages.map(message => message.type), [],
        'search bodies from ordinary X tabs must never reach the worker');

    const harness = createContentHarness({ pathname: '/search' });
    const contract =
        harness.context.globalThis.XPorterCaptureContract;
    const baseResponse = {
        type: '__XPORTER_GRAPHQL_RESPONSE__',
        url: 'https://x.com/i/api/graphql/query/SearchTimeline',
        status: 200,
        bodyText: '{}'
    };
    // Behavioral checks replace source-pattern assertions: the same spelling
    // in a comment would not satisfy these rejection cases.
    for (const invalidEvent of [{origin:'https://example.invalid'}, {source:{}}]) {
        harness.dispatch({...baseResponse, operationName:'SearchTimeline'}, invalidEvent);
    }
    for (const status of [0, 99, 600, 200.5]) {
        harness.dispatch({...baseResponse, operationName:'SearchTimeline', status});
    }

    harness.dispatch({
        ...baseResponse,
        operationName: 'NotAnXPorterOperation'
    });
    harness.dispatch({
        ...baseResponse,
        operationName: 'SearchTimeline',
        bodyText: 'x'.repeat(contract.MAX_BODY_CHARS + 1)
    });
    harness.dispatch({
        ...baseResponse,
        operationName: 'SearchTimeline'
    });

    const validSeenPost = {
        id: '1234567890',
        text: 'seen',
        author_username: 'ada'
    };
    harness.dispatch({
        type: '__XPORTER_SEEN_POSTS__',
        operationName: 'HomeTimeline',
        posts: [{
            ...validSeenPost,
            text: 'x'.repeat(contract.MAX_POST_TEXT_CHARS + 1)
        }]
    });
    harness.dispatch({
        type: '__XPORTER_SEEN_POSTS__',
        operationName: 'HomeTimeline',
        posts: Array.from(
            { length: contract.MAX_POSTS_PER_MESSAGE + 1 },
            (_, index) => ({
                ...validSeenPost,
                id: String(1_000_000 + index)
            })
        )
    });
    harness.dispatch({
        type: '__XPORTER_SEEN_POSTS__',
        operationName: 'HomeTimeline',
        posts: [validSeenPost]
    });
    await Promise.resolve();

    assert.deepEqual(
        harness.runtimeMessages.map(message => message.type),
        ['PAGE_GRAPHQL_RESPONSE', 'CAPTURE_FEED_POSTS']
    );
}

function createLinkedCaptureHarness() {
    const worker = createWorkerHarness();
    vm.runInContext(`
        currentExport={running:true};
        searchCapture={tabId:42,rawQuery:'(from:test)',queue:[],resolver:null,seenUrls:new Set()};
    `, worker.context);
    let main;
    const content = createContentHarness({
        pathname: '/search',
        postToMain: message => queueMicrotask(() => main.dispatch(message)),
        onRuntimeMessage: message => worker.dispatchRuntime(message, {tab:{id:42,url:'https://x.com/search'}})
    });
    main = createInterceptorHarness({postToContent: message => queueMicrotask(() => content.dispatch(message))});
    const url = 'https://x.com/i/api/graphql/query/SearchTimeline?variables=' +
        encodeURIComponent(JSON.stringify({rawQuery:'(from:test)',product:'Latest'}));
    return {main, content, worker, url,
        nextPayload() { return vm.runInContext('waitForSearchCapturePayload(1000)', worker.context); }
    };
}

async function testLinkedCaptureReadinessAndResponses() {
    const harness = createLinkedCaptureHarness();
    const ready = await harness.content.dispatchRuntime({type:'XPORTER_SEARCH_PAGE_STATE'});
    assert.equal(ready.hookReady, true, 'real MAIN/isolated listeners must complete the readiness probe');
    const body = JSON.stringify({data:{search_by_raw_query:{search_timeline:{timeline:{
        instructions:[{type:'TimelineTerminateTimeline',direction:'Bottom'}]
    }}}}});
    harness.main.window._bodyText = body;
    const pending = harness.nextPayload();
    const response = await harness.main.window.fetch(harness.url);
    const payload = await pending;
    assert.equal(response.status, 200, 'page fetch must still receive its response');
    assert.equal(payload?.bodyText, body);
    assert.equal(payload?.url, harness.url);
    assert.equal(payload?.error, undefined);

    // Independently cover the XHR capture branch, with a real load callback.
    const xhrHarness = createLinkedCaptureHarness();
    const xhrPayload = xhrHarness.nextPayload();
    const xhr = new xhrHarness.main.FakeXHR();
    xhr.open('GET', xhrHarness.url);
    xhr.status = 429;
    xhr.responseText = '{"errors":[{"message":"rate limited"}]}';
    xhr.emitLoad();
    assert.equal((await xhrPayload)?.status, 429);
}

async function testLinkedCaptureNetworkFailureAndSameUrlRetry() {
    const harness = createLinkedCaptureHarness();
    harness.main.window._networkError = new Error('temporary connection failure');
    const pendingFailure = harness.nextPayload();
    await assert.rejects(harness.main.window.fetch(harness.url), /temporary connection failure/);
    const failure = await pendingFailure;
    assert.equal(failure?.error, 'SEARCH_NETWORK_ERROR');
    assert.equal(failure?.bodyText, '');
    assert.equal(vm.runInContext('searchCapture.seenUrls.size', harness.worker.context), 0,
        'a transport error must not make the request URL permanently seen');

    harness.main.window._networkError = null;
    harness.main.window._bodyText = '{"retry":"succeeded"}';
    const pendingRetry = harness.nextPayload();
    await harness.main.window.fetch(harness.url);
    assert.equal((await pendingRetry)?.bodyText, '{"retry":"succeeded"}');

    const oversized = createLinkedCaptureHarness();
    oversized.main.window._bodyText = 'x'.repeat(oversized.main.window.XPorterCaptureContract.MAX_BODY_CHARS + 1);
    const pendingOversized = oversized.nextPayload();
    await oversized.main.window.fetch(oversized.url);
    const diagnostic = await pendingOversized;
    assert.equal(diagnostic?.error, 'SEARCH_RESPONSE_TOO_LARGE');
    assert.equal(diagnostic?.bodyText, '');
}

async function testRelativeSearchUrlsReachWorker() {
    for (const transport of ['fetch', 'xhr', 'xhr-error']) {
        const harness = createLinkedCaptureHarness();
        const relative = harness.url.replace('https://x.com', '');
        const pending = harness.nextPayload();
        if (transport === 'fetch') {
            await harness.main.window.fetch(relative);
        } else {
            const xhr = new harness.main.FakeXHR();
            xhr.open('GET', relative);
            xhr.status = 200;
            xhr.responseText = '{}';
            xhr.emit(transport === 'xhr' ? 'load' : 'error');
        }
        const payload = await pending;
        assert.equal(payload?.url, harness.url, `${transport}: worker must receive an absolute X URL`);
        assert.equal(payload?.error, transport === 'xhr-error' ? 'SEARCH_NETWORK_ERROR' : undefined);
    }
}

async function testLinkedXhrTransportFailureIsReported() {
    const harness = createLinkedCaptureHarness();
    for (const type of ['error', 'abort', 'timeout']) {
        const pending = harness.nextPayload();
        const xhr = new harness.main.FakeXHR();
        xhr.open('GET', harness.url);
        xhr.emit(type);
        const failure = await pending;
        assert.equal(failure?.error, 'SEARCH_NETWORK_ERROR', `XHR ${type} must reach the worker`);
        assert.equal(failure?.bodyText, '');
    }
    // A re-opened XHR must not report the previous request's failure.
    const posted = harness.main.posted.length;
    const xhr = new harness.main.FakeXHR();
    xhr.open('GET', harness.url);
    const staleError = xhr.listeners.error[0];
    xhr.open('GET', harness.url);
    staleError();
    assert.equal(harness.main.posted.length, posted);
}

async function testAccountDetectionIsBoundedAndNavigationDriven() {
    let reads = 0;
    let rendered = false;
    const switcher = {
        get innerText() { reads += 1; return 'Ada\n@ada'; },
        querySelector() { return null; }
    };
    const harness = createContentHarness({
        pathname: '/home',
        querySelector(selector) {
            if (rendered && selector.includes('SideNav_AccountSwitcher_Button')) return switcher;
            return null;
        }
    });
    assert.equal(harness.mutationObservers(), 0,
        'account detection must not observe every DOM mutation');

    // Not rendered yet: bounded retries, then silence.
    await new Promise(resolve => setTimeout(resolve, 5_600));
    assert.equal(harness.pendingTimers(), 0, 'retries must stop after the bounded window');
    assert.equal(harness.runtimeMessages.some(message => message.type === 'SET_CURRENT_ACCOUNT'), false);

    // An SPA navigation starts a new short detection window.
    rendered = true;
    harness.context.window.location.pathname = '/ada';
    harness.context.window.location.href = 'https://x.com/ada';
    harness.navigationListeners.get('currententrychange')();
    await new Promise(resolve => setTimeout(resolve, 300));
    const account = harness.runtimeMessages.find(message => message.type === 'SET_CURRENT_ACCOUNT');
    assert.deepEqual(account?.account, { name: 'Ada', username: 'ada', avatarUrl: '' });
    assert(harness.runtimeMessages.some(message => message.type === 'SET_USERNAME' && message.username === 'ada'),
        'URL changes must still report the profile username');
    assert.equal(harness.pendingTimers(), 0, 'a detected account ends the retry window');
    assert.equal(reads, 1);
}

async function testInvalidatedContextStopsRelaying() {
    const harness = createContentHarness({ pathname: '/search' });
    const response = {
        type: '__XPORTER_GRAPHQL_RESPONSE__',
        operationName: 'SearchTimeline',
        url: 'https://x.com/i/api/graphql/query/SearchTimeline',
        status: 200,
        bodyText: '{}'
    };
    harness.dispatch(response);
    assert.equal(harness.runtimeMessages.length, 1);

    // Extension reloaded: Chrome clears runtime.id and sendMessage throws.
    const messageListener = harness.windowListeners.get('message');
    harness.runtime.id = undefined;
    harness.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    assert.doesNotThrow(() => messageListener({ source: harness.context.window, origin: 'https://x.com', data: response }));
    assert.equal(harness.windowListeners.has('message'), false, 'page relay listener must be removed');
    assert.equal(harness.windowListeners.has('popstate'), false);
    assert.equal(harness.navigationListeners.has('currententrychange'), false);
    assert.equal(harness.pendingTimers(), 0, 'pending detection timers must be cleared');

    // A synchronous throw from a still-"alive" looking runtime is also handled.
    const second = createContentHarness({ pathname: '/search' });
    second.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    assert.doesNotThrow(() => second.dispatch(response));
    assert.equal(second.windowListeners.has('message'), false);
}

async function testRateLimitResetIsRelayedWith429() {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const harness = createLinkedCaptureHarness();
    harness.main.window._status = 429;
    harness.main.window._bodyText = '{"errors":[{"code":88}]}';
    harness.main.window._headers = { 'x-rate-limit-reset': String(reset) };
    const pendingFetch = harness.nextPayload();
    await harness.main.window.fetch(harness.url);
    const fetched = await pendingFetch;
    assert.equal(fetched?.status, 429);
    assert.equal(fetched?.rateLimitReset, reset, 'fetch 429 must carry x-rate-limit-reset');

    const xhrPending = harness.nextPayload();
    const xhr = new harness.main.FakeXHR();
    xhr.open('GET', harness.url);
    xhr.status = 429;
    xhr.responseText = '';
    xhr.responseHeaders = { 'x-rate-limit-reset': String(reset + 1) };
    xhr.emitLoad();
    assert.equal((await xhrPending)?.rateLimitReset, reset + 1, 'XHR 429 must carry x-rate-limit-reset');

    // Only a 429 with a plain integer header carries the field.
    const posted = harness.main.posted;
    harness.main.window._status = 200;
    await harness.main.window.fetch(harness.url);
    harness.main.window._status = 429;
    harness.main.window._headers = { 'x-rate-limit-reset': '12abc' };
    await harness.main.window.fetch(harness.url);
    await new Promise(resolve => setImmediate(resolve));
    const relayed = posted.filter(message => message.type === '__XPORTER_GRAPHQL_RESPONSE__').slice(-2);
    assert.deepEqual(relayed.map(message => message.rateLimitReset), [undefined, undefined]);

    // The isolated relay forwards only a positive integer, and only with 429.
    const content = createContentHarness({ pathname: '/search' });
    const base = {
        type: '__XPORTER_GRAPHQL_RESPONSE__',
        operationName: 'SearchTimeline',
        url: 'https://x.com/i/api/graphql/query/SearchTimeline',
        bodyText: ''
    };
    content.dispatch({ ...base, status: 429, rateLimitReset: reset });
    content.dispatch({ ...base, status: 429, rateLimitReset: '9999999999' });
    content.dispatch({ ...base, status: 200, rateLimitReset: reset });
    assert.deepEqual(content.runtimeMessages.map(message => message.rateLimitReset), [reset, undefined, undefined]);
}

const tests = [
    ['relative search URLs reach worker', testRelativeSearchUrlsReachWorker],
    ['429 rate-limit reset relay', testRateLimitResetIsRelayedWith429],
    ['linked XHR transport failure', testLinkedXhrTransportFailureIsReported],
    ['bounded navigation-driven account detection', testAccountDetectionIsBoundedAndNavigationDriven],
    ['invalidated extension context stops relaying', testInvalidatedContextStopsRelaying],
    ['linked capture readiness, fetch and XHR', testLinkedCaptureReadinessAndResponses],
    ['linked network failure and same-URL retry', testLinkedCaptureNetworkFailureAndSameUrlRetry],
    ['shared immutable contract', testSharedContractShape],
    ['manifest order and consumer ownership', testManifestOrderAndConsumerOwnership],
    ['MAIN-world rejection behavior', testMainWorldRejectionBehavior],
    ['isolated relay rejection behavior', testIsolatedRelayRejectionBehavior]
];

(async () => {
    const failures = [];
    for (const [name, test] of tests) {
        try {
            await withTimeout(test, name);
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    if (failures.length > 0) process.exitCode = 1;
    else console.log('Capture contract tests passed');
})();
