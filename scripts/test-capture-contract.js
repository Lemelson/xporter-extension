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
    for (const [entry, consumer] of [
        [main, 'content/interceptor.js'],
        [isolated, 'content/content.js']
    ]) {
        const contractIndex = entry.js.indexOf(CONTRACT_FILE);
        const nativeTemplateIndex = entry.js.indexOf('utils/native-request-template.js');
        const consumerIndex = entry.js.indexOf(consumer);
        assert(contractIndex >= 0, `${CONTRACT_FILE} must load in both worlds`);
        assert(contractIndex < consumerIndex, `${CONTRACT_FILE} must load before ${consumer}`);
        assert(nativeTemplateIndex < consumerIndex,
            `native request template validation must still load before ${consumer}`);
    }

    const interceptor = read('content/interceptor.js');
    const relay = read('content/content.js');
    assert.match(interceptor, /XPorterCaptureContract/);
    assert.match(relay, /XPorterCaptureContract/);
    assert.doesNotMatch(interceptor, /const\s+TRACKED\s*=/);
    assert.doesNotMatch(relay, /const\s+RELAY_TRACKED_OPERATIONS\s*=/);
    assert.match(relay, /RELAY_POST_ID_PATTERN/);
    assert.match(relay, /RELAY_POST_OPERATION_PATTERN/);
    assert.match(interceptor, /operationFromUrl/);
    assert.match(interceptor, /XPorterNativeTemplate\?\.parseRequestUrl/);
    for (const source of [interceptor, relay]) {
        assert.doesNotMatch(source, /8\s*\*\s*1024\s*\*\s*1024/);
    }
}

function createContentHarness({ onRuntimeMessage, postToMain } = {}) {
    const windowListeners = new Map();
    const runtimeMessages = [];
    let runtimeListener;
    const window = {
        location: {
            pathname: '/home',
            href: 'https://x.com/home',
            origin: 'https://x.com'
        },
        addEventListener(type, listener) {
            windowListeners.set(type, listener);
        },
        postMessage(message) { postToMain?.(message); }
    };
    window.window = window;
    const document = {
        documentElement: {},
        body: null,
        querySelector() { return null; },
        addEventListener() {},
        getElementById() { return null; }
    };
    const context = vm.createContext({
        globalThis: window,
        window,
        document,
        URL,
        console,
        setTimeout,
        clearTimeout,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {}
        },
        chrome: {
            runtime: {
                sendMessage(message) {
                    runtimeMessages.push(
                        JSON.parse(JSON.stringify(message))
                    );
                    return Promise.resolve(onRuntimeMessage?.(message) || { success: true });
                },
                onMessage: { addListener(listener) { runtimeListener = listener; } }
            }
        }
    });
    load(CONTRACT_FILE, context);
    load('content/content.js', context);
    return {
        context,
        runtimeMessages,
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
        constructor() { this.listeners = []; this.responseType = ''; }
        addEventListener(type, callback) { if (type === 'load') this.listeners.push(callback); }
        emitLoad() {
            const pending = this.listeners.splice(0);
            for (const callback of pending) callback();
        }
    }
    FakeXHR.prototype.open = function (_method, url) { this.responseURL = url; };

    const window = {
        location: { origin: 'https://x.com' },
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
            return {
                status: this._status || 200,
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
    const harness = createContentHarness();
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

const tests = [
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
