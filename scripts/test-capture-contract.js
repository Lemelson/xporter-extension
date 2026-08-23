#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    assert.match(relay, /event\.source\s*!==\s*window/);
    assert.match(relay, /event\.origin\s*!==\s*window\.location\.origin/);
    assert.match(relay, /Number\.isInteger\(status\)/);
    assert.match(relay, /RELAY_POST_ID_PATTERN/);
    assert.match(relay, /RELAY_POST_OPERATION_PATTERN/);
    assert.match(interceptor, /operationFromUrl/);
    assert.match(interceptor, /XPorterNativeTemplate\?\.parseRequestUrl/);
    for (const source of [interceptor, relay]) {
        assert.doesNotMatch(source, /8\s*\*\s*1024\s*\*\s*1024/);
    }
}

function createContentHarness() {
    const windowListeners = new Map();
    const runtimeMessages = [];
    const window = {
        location: {
            pathname: '/home',
            href: 'https://x.com/home',
            origin: 'https://x.com'
        },
        addEventListener(type, listener) {
            windowListeners.set(type, listener);
        }
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
                    return Promise.resolve({ success: true });
                },
                onMessage: { addListener() {} }
            }
        }
    });
    load(CONTRACT_FILE, context);
    load('content/content.js', context);
    return {
        context,
        runtimeMessages,
        dispatch(data) {
            windowListeners.get('message')({
                source: window,
                origin: window.location.origin,
                data
            });
        }
    };
}

function createInterceptorHarness() {
    const posted = [];
    class FakeXHR {
        addEventListener() {}
    }
    FakeXHR.prototype.open = function () {};

    const window = {
        location: { origin: 'https://x.com' },
        _bodyText: '{}',
        postMessage(message) {
            posted.push(JSON.parse(JSON.stringify(message)));
        },
        async fetch() {
            const bodyText = this._bodyText;
            return {
                status: 200,
                clone() {
                    return {
                        async text() { return bodyText; }
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
    return { context, window, posted };
}

async function testMainWorldRejectionBehavior() {
    const harness = createInterceptorHarness();
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
    await new Promise(resolve => setTimeout(resolve, 5));

    assert.deepEqual(
        harness.posted.map(message => message.type),
        ['__XPORTER_GRAPHQL_RESPONSE__', '__XPORTER_SEEN_POSTS__']
    );
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

const tests = [
    ['shared immutable contract', testSharedContractShape],
    ['manifest order and consumer ownership', testManifestOrderAndConsumerOwnership],
    ['MAIN-world rejection behavior', testMainWorldRejectionBehavior],
    ['isolated relay rejection behavior', testIsolatedRelayRejectionBehavior]
];

(async () => {
    const failures = [];
    for (const [name, test] of tests) {
        try {
            await test();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    if (failures.length > 0) process.exitCode = 1;
    else console.log('Capture contract tests passed');
})();
