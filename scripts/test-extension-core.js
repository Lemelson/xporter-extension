#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { requireSofficeExecutable } = require('./tooling-policy.js');

const ROOT = path.join(__dirname, '..');

function source(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function createApiHarness({ stored = {}, fetchImpl, config = {}, globals = {} } = {}) {
    const removedStorageKeys = [];
    const context = vm.createContext({
        console,
        Response,
        Headers,
        Request,
        URL,
        URLSearchParams,
        AbortController,
        AbortSignal,
        navigator: { userAgent: 'XPorter test' },
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: {
            FALLBACK_BEARER_TOKEN: 'fallback',
            API_FETCH_TIMEOUT: 1000,
            DISCOVERY_FETCH_TIMEOUT: 1000,
            DISCOVERY_TOTAL_TIMEOUT: 2000,
            ENDPOINT_CACHE_TTL: 60_000,
            ...config
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        BOOKMARKS_FEATURES: {},
        BOOKMARKS_FIELD_TOGGLES: {},
        TWEET_RESULTS_FEATURES: {},
        TWEET_RESULTS_FIELD_TOGGLES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            },
            storage: {
                local: {
                    async get(key) { return { [key]: stored[key] }; },
                    async set(values) { Object.assign(stored, values); },
                    async remove(key) {
                        for (const item of [].concat(key)) {
                            removedStorageKeys.push(item);
                            delete stored[item];
                        }
                    }
                }
            }
        },
        fetch: fetchImpl || (async () => {
            throw new Error('Unexpected fetch');
        }),
        ...globals
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/native-request-template.js'), context, {
        filename: 'utils/native-request-template.js'
    });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    return { context, stored, removedStorageKeys };
}

async function testSearchErrorsAreRelayed() {
    const posted = [];
    const window = {
        location: { origin: 'https://x.com' },
        postMessage(message) { posted.push(message); },
        fetch: async () => new Response('{"errors":[{"code":88}]}', { status: 429 })
    };
    window.window = window;

    class FakeXHR {
        addEventListener(type, listener) {
            if (type === 'load') this.loadListener = listener;
        }
        open() {}
    }

    const context = vm.createContext({
        window,
        XMLHttpRequest: FakeXHR,
        Request,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source('content/interceptor.js'), context, { filename: 'content/interceptor.js' });

    await window.fetch('https://x.com/i/api/graphql/query-id/SearchTimeline?variables=%7B%7D');
    await new Promise(resolve => setImmediate(resolve));

    const capture = posted.find(message => message.type === '__XPORTER_GRAPHQL_RESPONSE__');
    assert.equal(capture?.status, 429, 'SearchTimeline HTTP errors must reach the worker');
    assert.match(capture?.bodyText || '', /"code":88/);

    const xhr = new FakeXHR();
    const xhrUrl = 'https://x.com/i/api/graphql/query-id/SearchTimeline?cursor=next';
    xhr.open('GET', xhrUrl);
    xhr.status = 429;
    xhr.responseType = '';
    xhr.responseText = '';
    xhr.responseURL = xhrUrl;
    xhr.loadListener();
    const xhrCapture = posted.filter(message => message.type === '__XPORTER_GRAPHQL_RESPONSE__').at(-1);
    assert.equal(xhrCapture?.status, 429, 'empty XHR error responses must also reach the worker');

    await window.fetch('https://x.com/i/api/graphql/replies-query-id/UserTweetsAndReplies?variables=%7B%7D');
    const rejectedRepliesTemplate = posted.find(message =>
        message.type === '__XPORTER_NATIVE_REQUEST_TEMPLATE__');
    assert.equal(rejectedRepliesTemplate, undefined,
        'a failed native request must not publish a query-only endpoint candidate');
}

async function testNativeRequestTemplateCaptureIsAtomicAndPrivate() {
    const posted = [];
    let nextStatus = 200;
    const window = {
        location: { origin: 'https://x.com' },
        postMessage(message) { posted.push(message); },
        fetch: async () => new Response('{}', { status: nextStatus })
    };
    window.window = window;

    class FakeXHR {
        addEventListener(type, listener) {
            if (type === 'load') this.loadListener = listener;
        }
        open() {}
    }

    const context = vm.createContext({
        window,
        XMLHttpRequest: FakeXHR,
        Request,
        Response,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source('utils/native-request-template.js'), context, {
        filename: 'utils/native-request-template.js'
    });
    vm.runInContext(source('content/interceptor.js'), context, { filename: 'content/interceptor.js' });

    const features = encodeURIComponent(JSON.stringify({
        responsive_web_graphql_timeline_navigation_enabled: true,
        creator_subscriptions_tweet_preview_api_enabled: false
    }));
    const fieldToggles = encodeURIComponent(JSON.stringify({ withArticlePlainText: true }));
    const variables = encodeURIComponent(JSON.stringify({
        userId: 'secret-user-id',
        cursor: 'secret-cursor',
        count: 20
    }));
    const nativeUrl =
        'https://x.com/i/api/graphql/native-replies-id/UserTweetsAndReplies' +
        `?variables=${variables}&features=${features}&fieldToggles=${fieldToggles}`;

    await window.fetch(nativeUrl);
    const fetchTemplate = posted.find(message =>
        message.type === '__XPORTER_NATIVE_REQUEST_TEMPLATE__');
    assert.deepEqual(JSON.parse(JSON.stringify(fetchTemplate?.template)), {
        operationName: 'UserTweetsAndReplies',
        queryId: 'native-replies-id',
        features: {
            responsive_web_graphql_timeline_navigation_enabled: true,
            creator_subscriptions_tweet_preview_api_enabled: false
        },
        fieldToggles: { withArticlePlainText: true }
    });
    const serialized = JSON.stringify(fetchTemplate);
    assert.doesNotMatch(serialized, /secret-user-id|secret-cursor|variables|headers|authorization|cookie/i,
        'the native template must never relay variables, identity, cursor, or request headers');

    nextStatus = 400;
    await window.fetch(nativeUrl.replace('native-replies-id', 'rejected-query-id'));
    assert.equal(
        posted.filter(message => message.type === '__XPORTER_NATIVE_REQUEST_TEMPLATE__').length,
        1,
        'an X request template is trusted only after X accepts the native request'
    );

    nextStatus = 200;
    await window.fetch(nativeUrl, { method: 'POST' });
    await window.fetch(new Request(nativeUrl, { method: 'GET' }), { method: 'POST' });
    await window.fetch(
        nativeUrl + `&features=${encodeURIComponent(JSON.stringify({ duplicate: true }))}`
    );
    assert.equal(
        posted.filter(message => message.type === '__XPORTER_NATIVE_REQUEST_TEMPLATE__').length,
        1,
        'POST overrides and duplicate query parameters must be rejected'
    );

    const xhr = new FakeXHR();
    const xhrUrl = nativeUrl.replace('native-replies-id', 'native-xhr-id');
    xhr.open('GET', xhrUrl);
    xhr.status = 200;
    xhr.responseType = '';
    xhr.responseText = '{}';
    xhr.responseURL = xhrUrl;
    xhr.loadListener();
    const xhrTemplate = posted.filter(message =>
        message.type === '__XPORTER_NATIVE_REQUEST_TEMPLATE__').at(-1);
    assert.equal(xhrTemplate?.template?.queryId, 'native-xhr-id',
        'successful native XHR requests must publish the same sanitized template');

    
}

async function testBookmarksEndpointUsesViewerTimelineWithoutUsername() {
    const requestUrls = [];
    const responseBody = JSON.stringify({
        data: {
            bookmark_timeline_v2: {
                timeline: {
                    instructions: [{
                        type: 'TimelineAddEntries',
                        entries: [{
                            entryId: 'tweet-700',
                            content: {
                                itemContent: {
                                    tweet_results: {
                                        result: {
                                            legacy: {
                                                id_str: '700',
                                                full_text: 'Saved post',
                                                bookmark_count: 3
                                            },
                                            core: {
                                                user_results: {
                                                    result: {
                                                        core: {
                                                            name: 'Other author',
                                                            screen_name: 'other'
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }, {
                            entryId: 'cursor-bottom-1',
                            content: {
                                __typename: 'TimelineTimelineCursor',
                                cursorType: 'Bottom',
                                value: 'next-bookmarks-page'
                            }
                        }]
                    }]
                }
            }
        }
    });
    const { context } = createApiHarness({
        fetchImpl: async (url) => {
            requestUrls.push(String(url));
            return new Response(responseBody, {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    context.XPorterAPI.setLiveQueryId('Bookmarks', 'current-bookmarks-query');

    const first = await context.XPorterAPI.fetchBookmarks(null, 20);
    assert.deepEqual(JSON.parse(JSON.stringify(first.tweets.map(tweet => tweet.id))), ['700']);
    assert.equal(first.tweets[0].author_username, 'other');
    assert.equal(first.nextCursor, 'next-bookmarks-page');

    const firstUrl = new URL(requestUrls[0]);
    assert.match(firstUrl.pathname, /current-bookmarks-query\/Bookmarks$/);
    assert.deepEqual(JSON.parse(firstUrl.searchParams.get('variables')), {
        count: 20,
        includePromotedContent: true
    }, 'Bookmarks belong to the signed-in viewer and must not accept a profile username or user ID');

    await context.XPorterAPI.fetchBookmarks('next-bookmarks-page', 50);
    assert.equal(
        JSON.parse(new URL(requestUrls[1]).searchParams.get('variables')).cursor,
        'next-bookmarks-page'
    );
}

async function testTweetResultsEndpointFetchesReplyParentsInOneBatch() {
    const requestUrls = [];
    const responseBody = JSON.stringify({
        data: {
            tweetResult: [{
                result: {
                    legacy: {
                        id_str: '10000',
                        full_text: 'The complete parent post',
                        bookmark_count: 9
                    },
                    core: {
                        user_results: {
                            result: {
                                core: { name: 'Parent author', screen_name: 'parent_author' }
                            }
                        }
                    }
                }
            }, {
                result: {
                    legacy: {
                        id_str: '20000',
                        full_text: 'A second parent post'
                    },
                    core: {
                        user_results: {
                            result: {
                                core: { name: 'Second author', screen_name: 'second_author' }
                            }
                        }
                    }
                }
            }]
        }
    });
    const { context } = createApiHarness({
        fetchImpl: async (url) => {
            requestUrls.push(String(url));
            return new Response(responseBody, {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    context.XPorterAPI.setLiveQueryId('TweetResultsByRestIds', 'current-parent-query');

    const parents = await context.XPorterAPI.fetchTweetsByIds(['10000', '20000', '10000']);
    assert.deepEqual(
        JSON.parse(JSON.stringify(parents.map((tweet) => tweet.id))),
        ['10000', '20000']
    );
    const requestUrl = new URL(requestUrls[0]);
    assert.match(requestUrl.pathname, /current-parent-query\/TweetResultsByRestIds$/);
    assert.deepEqual(JSON.parse(requestUrl.searchParams.get('variables')), {
        tweetIds: ['10000', '20000'],
        includePromotedContent: true,
        withBirdwatchNotes: true,
        withVoice: true,
        withCommunity: true
    });
}

async function testNativeRequestTemplateReplaysAtomicallyAcrossWorkerRestart() {
    const stored = {};
    const requestUrls = [];
    const responseBody = JSON.stringify({
        data: { user: { result: { timeline_v2: { timeline: { instructions: [] } } } } }
    });
    const fetchImpl = async (url) => {
        requestUrls.push(String(url));
        return new Response(responseBody, {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };
    const first = createApiHarness({
        stored,
        fetchImpl,
        globals: {
            TWEETS_FEATURES: { stale_static_flag: true }
        }
    });
    const nativeTemplate = {
        operationName: 'UserTweetsAndReplies',
        queryId: 'accepted-native-replies-id',
        features: {
            responsive_web_graphql_timeline_navigation_enabled: true,
            stale_static_flag: false
        },
        fieldToggles: { withArticlePlainText: false }
    };

    assert.equal(
        await first.context.XPorterAPI.setLiveRequestTemplate(nativeTemplate),
        true,
        'a valid native template must be accepted'
    );
    await first.context.XPorterAPI.fetchUserTweets('target-user-id', null, 20, true);

    const firstUrl = new URL(requestUrls.at(-1));
    assert.match(firstUrl.pathname, /accepted-native-replies-id\/UserTweetsAndReplies$/);
    assert.deepEqual(JSON.parse(firstUrl.searchParams.get('features')), nativeTemplate.features,
        'captured features must travel atomically with their accepted query ID');
    assert.deepEqual(JSON.parse(firstUrl.searchParams.get('fieldToggles')), nativeTemplate.fieldToggles);
    assert.equal(JSON.parse(firstUrl.searchParams.get('variables')).userId, 'target-user-id',
        'dynamic variables must still come from XPorter, never the captured page request');
    assert(stored.xporter_native_request_templates_v1,
        'the safe template must persist for an MV3 service-worker restart');

    const second = createApiHarness({
        stored,
        fetchImpl,
        globals: {
            TWEETS_FEATURES: { stale_static_flag: true }
        }
    });
    await second.context.XPorterAPI.fetchUserTweets('target-user-id', null, 20, true);
    const restartedUrl = new URL(requestUrls.at(-1));
    assert.match(restartedUrl.pathname, /accepted-native-replies-id\/UserTweetsAndReplies$/,
        'a fresh persisted native template must survive worker restart');
    assert.deepEqual(JSON.parse(restartedUrl.searchParams.get('features')), nativeTemplate.features);

    assert.equal(
        await second.context.XPorterAPI.setLiveRequestTemplate({
            ...nativeTemplate,
            capturedAt: Date.now()
        }),
        false,
        'page-supplied timestamps or any extra wire properties must be rejected'
    );
    assert.equal(
        await second.context.XPorterAPI.setLiveRequestTemplate({
            ...nativeTemplate,
            queryId: 'malicious-query-id',
            features: { nested: { value: true } }
        }),
        false,
        'nested or non-boolean feature values must be rejected'
    );
}

async function testTransactionIdGeneratorProducesDeterministicHeader() {
    const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const verificationKey = Buffer.from(keyBytes).toString('base64');
    const frameRows = Array.from({ length: 16 }, (_, row) => {
        const values = Array.from({ length: 11 }, (_, column) => ((row + 1) * (column + 3)) % 251);
        return `C ${values.join(',')}`;
    }).join(' ');
    const frames = Array.from({ length: 4 }, (_, index) =>
        `<svg id="loading-x-anim-${index}"><g><path d="M0 0"></path>` +
        `<path d="M 10,30 ${frameRows}"></path></g></svg>`
    ).join('');
    const html =
        `<html><head><meta name="twitter-site-verification" content="${verificationKey}"></head>` +
        `<body>${frames}<script>1:"ondemand.s",foo})[e]||e)+"."+({1:"fixture_"}</script></body></html>`;
    const onDemandSource = [
        '(a[0], 16)', '(b[1], 16)', '(c[2], 16)', '(d[3], 16)', '(e[4], 16)'
    ].join('');
    const context = vm.createContext({
        console,
        TextEncoder,
        Uint8Array,
        crypto,
        btoa,
        atob,
        fetch,
        Response,
        AbortController,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source('utils/transaction-id.js'), context, {
        filename: 'utils/transaction-id.js'
    });

    const generator = context.XPorterTransactionId.createContextFromSources(html, onDemandSource);
    const first = await generator.generate(
        'GET',
        '/i/api/graphql/native-replies-id/UserTweetsAndReplies',
        { timeNow: 123456, randomByte: 7 }
    );
    const second = await generator.generate(
        'GET',
        '/i/api/graphql/native-replies-id/UserTweetsAndReplies',
        { timeNow: 123456, randomByte: 7 }
    );
    assert.equal(first, second, 'fixed time and random byte must produce a deterministic test vector');
    assert.doesNotMatch(first, /=/, 'X transaction IDs omit base64 padding');

    const decoded = Buffer.from(first, 'base64');
    assert.equal(decoded[0], 7);
    const payload = Uint8Array.from(decoded.subarray(1), byte => byte ^ 7);
    assert.deepEqual([...payload.subarray(0, keyBytes.length)], [...keyBytes],
        'the encoded transaction payload must retain the current X verification key bytes');
    assert.deepEqual([...payload.subarray(keyBytes.length, keyBytes.length + 4)], [64, 226, 1, 0],
        'the transaction payload must encode the supplied timestamp little-endian');
    assert.equal(payload.at(-1), 3, 'the X transaction payload terminator must be present');
}

async function testTransactionInitializationFailureIsCached() {
    let fetchCalls = 0;
    const context = vm.createContext({
        console,
        TextEncoder,
        Uint8Array,
        crypto,
        btoa,
        atob,
        fetch: async () => {
            fetchCalls += 1;
            throw new Error('fixture offline');
        },
        Response,
        AbortController,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source('utils/transaction-id.js'), context, {
        filename: 'utils/transaction-id.js'
    });

    await assert.rejects(
        context.XPorterTransactionId.generate('GET', '/i/api/graphql/query/UserTweetsAndReplies'),
        /fixture offline/
    );
    await assert.rejects(
        context.XPorterTransactionId.generate('GET', '/i/api/graphql/query/UserTweetsAndReplies'),
        /fixture offline/
    );
    assert.equal(fetchCalls, 1,
        'one transaction initialization failure must not repeat for every query candidate');

    context.XPorterTransactionId.invalidate();
    await assert.rejects(
        context.XPorterTransactionId.generate('GET', '/i/api/graphql/query/UserTweetsAndReplies'),
        /fixture offline/
    );
    assert.equal(fetchCalls, 2, 'explicit invalidation must permit one fresh initialization attempt');
}

async function testRepliesRequestIncludesFreshTransactionHeader() {
    const generated = [];
    const requestOptions = [];
    const transactionProvider = {
        async generate(method, path) {
            generated.push({ method, path });
            return `transaction-${generated.length}`;
        },
        invalidate() {},
        abortActiveRequests() {}
    };
    const responseBody = JSON.stringify({
        data: { user: { result: { timeline_v2: { timeline: { instructions: [] } } } } }
    });
    const { context } = createApiHarness({
        globals: { XPorterTransactionId: transactionProvider },
        fetchImpl: async (_url, options) => {
            requestOptions.push(options);
            return new Response(responseBody, {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    await context.XPorterAPI.setLiveRequestTemplate({
        operationName: 'UserTweetsAndReplies',
        queryId: 'transaction-replies-id',
        features: {},
        fieldToggles: {}
    });
    await context.XPorterAPI.setLiveRequestTemplate({
        operationName: 'UserRepliesTimeline',
        queryId: 'transaction-current-replies-id',
        features: {},
        fieldToggles: {}
    });
    context.XPorterAPI.setLiveQueryId('UserTweets', 'transaction-posts-id');

    await context.XPorterAPI.fetchUserTweets('1', null, 20, 'replies');
    await context.XPorterAPI.fetchUserTweets('1', null, 20, true);
    await context.XPorterAPI.fetchUserTweets('1', null, 20, false);

    assert.deepEqual(generated, [{
        method: 'GET',
        path: '/i/api/graphql/transaction-current-replies-id/UserRepliesTimeline'
    }, {
        method: 'GET',
        path: '/i/api/graphql/transaction-replies-id/UserTweetsAndReplies'
    }], 'both current and legacy Replies requests need the X transaction challenge');
    assert.equal(requestOptions[0].headers['x-client-transaction-id'], 'transaction-1');
    assert.equal(requestOptions[1].headers['x-client-transaction-id'], 'transaction-2');
    assert.equal(requestOptions[2].headers['x-client-transaction-id'], undefined,
        'the stable Posts endpoint must not pay the transaction initialization cost');
}

async function testRepliesStaleRefreshRetriesSameCandidateOnce() {
    let nativeAttempts = 0;
    let invalidations = 0;
    const generated = [];
    const transactionProvider = {
        async generate(method, path) {
            generated.push({ method, path });
            return `transaction-${generated.length}`;
        },
        invalidate() { invalidations += 1; },
        abortActiveRequests() {}
    };
    const responseBody = JSON.stringify({
        data: { user: { result: { timeline_v2: { timeline: { instructions: [] } } } } }
    });
    const { context } = createApiHarness({
        globals: { XPorterTransactionId: transactionProvider },
        fetchImpl: async (url) => {
            const value = String(url);
            if (value.includes('/refresh-native-replies-id/UserTweetsAndReplies')) {
                nativeAttempts += 1;
                return new Response(nativeAttempts === 1 ? '{}' : responseBody, {
                    status: nativeAttempts === 1 ? 404 : 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
            if (value === 'https://x.com') {
                return new Response('<html><head></head><body></body></html>', { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }
    });
    await context.XPorterAPI.setLiveRequestTemplate({
        operationName: 'UserTweetsAndReplies',
        queryId: 'refresh-native-replies-id',
        features: {},
        fieldToggles: {}
    });

    const result = await context.XPorterAPI.fetchUserTweets('1', null, 20, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        tweets: [],
        nextCursor: null,
        previousCursor: null
    });
    assert.equal(nativeAttempts, 2,
        'the same accepted native template must get one retry after transaction refresh');
    assert.equal(invalidations, 1, 'transaction context must refresh exactly once');
    assert.equal(generated.length, 2, 'both bounded attempts must carry a fresh transaction ID');
}

async function testGraphqlErrorsWithoutTimelineAreNotSuccessfulEmptyExports() {
    const { context } = createApiHarness({
        fetchImpl: async (url) => {
            if (String(url) === 'https://x.com') {
                return new Response('<html><head></head><body></body></html>', { status: 200 });
            }
            return new Response(JSON.stringify({
                errors: [{ message: 'The operation failed', code: 131 }]
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });
    context.XPorterAPI.setLiveQueryId('UserTweets', 'invalid-payload-posts-id');

    await assert.rejects(
        context.XPorterAPI.fetchUserTweets('1'),
        error => error.message === 'STALE_QUERY_ID' && error.staleCandidatesExhausted === true,
        'HTTP 200 with GraphQL errors and no timeline must not become a green zero-row export'
    );
}

async function testStaleCandidateExhaustionIsMarkedTerminal() {
    const { context } = createApiHarness({
        fetchImpl: async (url) => {
            if (String(url) === 'https://x.com') {
                return new Response('<html><head></head><body></body></html>', { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }
    });
    context.XPorterAPI.setLiveQueryId('UserTweets', 'live-query-id');

    await assert.rejects(
        context.XPorterAPI.fetchUserTweets('1'),
        error => error.message === 'STALE_QUERY_ID' && error.staleCandidatesExhausted === true
    );
}

async function testStaleDiscoveredEndpointInvalidatesPersistedCache() {
    const cachedEndpoints = {
        UserByScreenName: { queryId: 'cached-user-id', operationName: 'UserByScreenName' },
        UserTweets: { queryId: 'cached-posts-id', operationName: 'UserTweets' },
        UserTweetsAndReplies: { queryId: 'cached-replies-id', operationName: 'UserTweetsAndReplies' },
        SearchTimeline: { queryId: 'cached-search-id', operationName: 'SearchTimeline' },
        Followers: { queryId: 'cached-followers-id', operationName: 'Followers' },
        Following: { queryId: 'cached-following-id', operationName: 'Following' },
        BlueVerifiedFollowers: { queryId: 'cached-verified-id', operationName: 'BlueVerifiedFollowers' }
    };
    const stored = {
        xporter_discovered_endpoints: {
            endpoints: cachedEndpoints,
            time: Date.now(),
            bearer: 'cached-bearer',
            discoveredOperations: Object.keys(cachedEndpoints)
        }
    };
    const harness = createApiHarness({
        stored,
        fetchImpl: async (url) => {
            if (String(url) === 'https://x.com') {
                return new Response('<html><head></head><body></body></html>', { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }
    });

    await assert.rejects(harness.context.XPorterAPI.fetchUserTweets('1'), /STALE_QUERY_ID/);
    assert.equal(
        stored.xporter_discovered_endpoints,
        undefined,
        'a stale discovered endpoint must not survive a worker restart'
    );
    assert(
        harness.removedStorageKeys.includes('xporter_discovered_endpoints'),
        'cache invalidation must explicitly remove the persisted endpoint record'
    );
}

async function testRequiredOperationBypassesPartialDiscoveryCache() {
    const stored = {};
    let includeReplies = false;
    let bundleFetches = 0;
    const mainBundleUrl = 'https://abs.twimg.com/responsive-web/client-web/main.test.js';
    const baseBundle = [
        'queryId:"fresh-user-id",operationName:"UserByScreenName"',
        'queryId:"fresh-posts-id",operationName:"UserTweets"'
    ].join(';');
    const { context } = createApiHarness({
        stored,
        fetchImpl: async (url) => {
            if (String(url) === 'https://x.com') {
                return new Response(`<html><script src="${mainBundleUrl}"></script></html>`, { status: 200 });
            }
            if (String(url) === mainBundleUrl) {
                bundleFetches += 1;
                const replies = includeReplies
                    ? ';queryId:"fresh-replies-id",operationName:"UserTweetsAndReplies"'
                    : '';
                return new Response(baseBundle + replies, { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }
    });

    const first = await context.XPorterAPI.discoverEndpoints(true, 'UserTweetsAndReplies');
    assert.notEqual(first.UserTweetsAndReplies.queryId, 'fresh-replies-id');

    includeReplies = true;
    const second = await context.XPorterAPI.discoverEndpoints(false, 'UserTweetsAndReplies');
    assert.equal(
        second.UserTweetsAndReplies.queryId,
        'fresh-replies-id',
        'a fallback-only partial scan must not satisfy required-operation discovery'
    );
    assert.equal(bundleFetches, 2, 'missing required operation must force another bundle scan');
    assert.equal(
        stored.xporter_discovered_endpoints.discoveredOperations.includes('UserTweetsAndReplies'),
        true,
        'persisted metadata must distinguish discovered operations from fallback stand-ins'
    );
}

async function testAboutAccountRegionIsRequestedAndParsed() {
    const requestUrls = [];
    const { context } = createApiHarness({
        fetchImpl: async (url) => {
            requestUrls.push(String(url));
            return new Response(JSON.stringify({
                data: {
                    user_result_by_screen_name: {
                        result: {
                            verified_since: '1675209600000',
                            about_profile: {
                                account_based_in: 'Germany',
                                location_accurate: true,
                                source: 'Germany App Store',
                                affiliate_username: 'ExampleOrg',
                                username_changes: {
                                    count: 2,
                                    last_changed_at_msec: '1693526400000'
                                }
                            }
                        }
                    }
                }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    context.XPorterAPI.setLiveQueryId('AboutAccountQuery', 'about-account-query-id');

    const about = await context.XPorterAPI.getAccountAbout('example');

    assert.deepEqual(JSON.parse(JSON.stringify(about)), {
        accountBasedIn: 'Germany',
        locationAccurate: true,
        accountSource: 'Germany App Store',
        affiliateUsername: 'ExampleOrg',
        premiumSince: '2023-02-01T00:00:00.000Z',
        usernameChangeCount: 2,
        usernameLastChangedAt: '2023-09-01T00:00:00.000Z'
    });
    assert.match(requestUrls[0], /\/about-account-query-id\/AboutAccountQuery\?/);
    assert.match(decodeURIComponent(requestUrls[0]), /"screenName":"example"/);
}

async function testXlsxIsRealOoxmlZip() {
    const context = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const bytes = context.XPorterCSV.generateXLSX([
        { id: '2075277820528607704', text: 'Привет & hello', favorite_count: 12 }
    ]);
    assert(bytes instanceof Uint8Array, 'XLSX generator must return binary bytes');
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);

    const archiveText = new TextDecoder().decode(bytes);
    for (const required of [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/worksheets/sheet1.xml'
    ]) {
        assert(archiveText.includes(required), `XLSX archive is missing ${required}`);
    }
    assert(archiveText.includes('2075277820528607704'), 'long IDs must remain exact text');
    assert(archiveText.includes('Привет &amp; hello'), 'worksheet strings must be XML-escaped');
    const partFilename = context.XPorterCSV.generateExportFilename('large', 'followers', 'csv', {
        exportedAt: '2026-07-14T12:00:00Z',
        partNumber: 2,
        partCount: 32
    });
    assert.match(partFilename, /_part-002-of-032_exported_.*\.csv$/,
        'multipart filenames must sort naturally and show their total');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-xlsx-test-'));
    const workbookPath = path.join(tempDir, 'export.xlsx');
    try {
        fs.writeFileSync(workbookPath, bytes);
        execFileSync('unzip', ['-t', workbookPath], { stdio: 'pipe' });
        const soffice = requireSofficeExecutable();
        if (soffice) {
            const profileUrl = `file://${path.join(tempDir, 'libreoffice-profile')}`;
            execFileSync(soffice, [
                `-env:UserInstallation=${profileUrl}`,
                '--headless', '--convert-to', 'csv', '--outdir', tempDir, workbookPath
            ], { stdio: 'pipe', timeout: 30_000 });
            const converted = fs.readFileSync(path.join(tempDir, 'export.csv'), 'utf8');
            assert(converted.includes('2075277820528607704'), 'LibreOffice must preserve long IDs');
            assert(converted.includes('Привет & hello'), 'LibreOffice must open Unicode cell text');
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testXlsxEmbedsMultiplePhotosOnSeparateMediaSheet() {
    const context = vm.createContext({
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        ArrayBuffer
    });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const firstImage = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const secondImage = new Uint8Array([255, 216, 255, 224, 5, 6, 7, 8]);
    const bytes = context.XPorterCSV.generateXLSX([{
        id: '90001',
        text: 'Post with several photos',
        media_type: 'photo',
        media_urls: 'https://pbs.twimg.com/media/one.png, https://pbs.twimg.com/media/two.jpg'
    }], false, {
        mediaAssets: [{
            postId: '90001',
            relation: 'post',
            sourceUrl: 'https://pbs.twimg.com/media/one.png',
            contentType: 'image/png',
            extension: 'png',
            bytes: firstImage,
            width: 1200,
            height: 800
        }, {
            postId: '90001',
            relation: 'quoted_post',
            sourceUrl: 'https://pbs.twimg.com/media/two.jpg',
            contentType: 'image/jpeg',
            extension: 'jpg',
            bytes: secondImage,
            width: 800,
            height: 1200
        }]
    });

    const archiveText = new TextDecoder().decode(bytes);
    for (const required of [
        'name="Media"',
        'xl/worksheets/sheet2.xml',
        'xl/worksheets/_rels/sheet2.xml.rels',
        'xl/drawings/drawing1.xml',
        'xl/drawings/_rels/drawing1.xml.rels',
        'xl/media/image1.png',
        'xl/media/image2.jpg',
        'quoted_post',
        'https://pbs.twimg.com/media/two.jpg'
    ]) {
        assert(archiveText.includes(required), `photo XLSX is missing ${required}`);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-photo-xlsx-'));
    const workbookPath = path.join(tempDir, 'photos.xlsx');
    try {
        fs.writeFileSync(workbookPath, bytes);
        execFileSync('unzip', ['-t', workbookPath], { stdio: 'pipe' });
        assert.deepEqual(
            execFileSync('unzip', ['-p', workbookPath, 'xl/media/image1.png']),
            Buffer.from(firstImage),
            'the XLSX package must preserve the original photo bytes'
        );
        assert.deepEqual(
            execFileSync('unzip', ['-p', workbookPath, 'xl/media/image2.jpg']),
            Buffer.from(secondImage)
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testPostsXlsxStartsWithProfileMetadata() {
    const context = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const bytes = context.XPorterCSV.generateXLSX([{
        id: '1',
        text: 'A post'
    }], false, {
        profile: {
            name: 'Example Person',
            screenName: 'example',
            bio: 'A complete profile description',
            location: 'Berlin',
            accountBasedIn: 'Germany',
            locationAccurate: true,
            isVerified: true,
            premiumSince: '2023-02-01T00:00:00.000Z',
            accountSource: 'Germany App Store',
            affiliateUsername: 'ExampleOrg',
            usernameChangeCount: 2,
            usernameLastChangedAt: '2023-09-01T00:00:00.000Z',
            followersCount: 123,
            followingCount: 45
        }
    });
    const archiveText = new TextDecoder().decode(bytes);

    for (const required of [
        'xl/styles.xml',
        'PROFILE',
        'Name',
        'Example Person',
        'Username',
        '@example',
        'Bio',
        'A complete profile description',
        'Location',
        'Berlin',
        'Account based in',
        'Germany',
        'Account location accurate',
        'yes',
        'Premium',
        'yes',
        'Premium since',
        '2023-02-01T00:00:00.000Z',
        'Connected via',
        'Germany App Store',
        'Affiliate account',
        '@ExampleOrg',
        'Username changes',
        '2',
        'Username last changed',
        '2023-09-01T00:00:00.000Z',
        'Followers',
        '123',
        'Following',
        '45',
        'POSTS (1)'
    ]) {
        assert(archiveText.includes(required), `post XLSX profile block is missing ${required}`);
    }
    assert.match(archiveText, /<cols>[\s\S]*customWidth="1"[\s\S]*<\/cols>/,
        'post XLSX must define readable column widths');
    assert.match(archiveText, /<c r="A1" s="1"/,
        'the PROFILE row must use the section-header style');
    assert.match(archiveText, /<c r="A2" s="2"/,
        'profile labels must be visually distinct from their values');
    assert(
        archiveText.indexOf('PROFILE') < archiveText.indexOf('POSTS (1)') &&
        archiveText.indexOf('POSTS (1)') < archiveText.indexOf('A post'),
        'post XLSX must place profile metadata before the post table'
    );
}

function testDetailedUserListColumnsAreOptIn() {
    const context = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const user = {
        id: '123',
        name: 'Example User',
        username: 'example',
        location: 'A self-entered location',
        account_based_in: 'Canada',
        account_location_accurate: true,
        premium_since: '2025-10-01T00:00:00.000Z',
        account_source: 'Canada App Store',
        affiliate_username: 'ExampleOrg',
        username_change_count: 2,
        username_last_changed_at: '2023-09-01T00:00:00.000Z'
    };

    const normalCsv = context.XPorterCSV.generateCSV([user], true, {
        includeAboutAccountDetails: false
    });
    assert.equal(normalCsv.includes('account_based_in'), false,
        'the default fast user-list export must not add About columns');

    const detailedCsv = context.XPorterCSV.generateCSV([user], true, {
        includeAboutAccountDetails: true
    });
    for (const value of [
        'account_based_in',
        'account_location_accurate',
        'premium_since',
        'account_source',
        'affiliate_username',
        'username_change_count',
        'username_last_changed_at',
        'Canada',
        'Canada App Store',
        'ExampleOrg'
    ]) {
        assert(detailedCsv.includes(value), `detailed user CSV is missing ${value}`);
    }

    const detailedXlsx = context.XPorterCSV.generateXLSX([user], true, {
        includeAboutAccountDetails: true
    });
    const archiveText = new TextDecoder().decode(detailedXlsx);
    for (const value of [
        'account_based_in',
        'account_location_accurate',
        'premium_since',
        'account_source',
        'affiliate_username',
        'username_change_count',
        'username_last_changed_at',
        'Canada App Store'
    ]) {
        assert(archiveText.includes(value), `detailed user XLSX is missing ${value}`);
    }
}

function testPostsTxtIsAiFriendly() {
    const context = vm.createContext({ Date, Number });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const text = context.XPorterCSV.generatePostsText([{
        id: '1',
        type: 'tweet',
        text: 'First line\nSecond line',
        author_name: 'Matt Paulson',
        author_username: 'MediaKing',
        created_at: 'Tue Jul 07 12:00:00 +0000 2026',
        view_count: '1200',
        favorite_count: 47,
        retweet_count: 3,
        reply_count: 2,
        quote_count: 1,
        bookmark_count: 9,
        tweet_url: 'https://x.com/MediaKing/status/1'
    }, {
        id: '2',
        type: 'reply',
        reply_to_id: '1',
        reply_to_username: 'MediaKing',
        text: 'A direct continuation',
        author_name: 'Matt Paulson',
        author_username: 'MediaKing',
        created_at: 'Tue Jul 07 12:05:00 +0000 2026',
        tweet_url: 'https://x.com/MediaKing/status/2'
    }, {
        id: '3',
        type: 'article',
        text: 'My introduction to the article',
        author_name: 'Matt Paulson',
        author_username: 'MediaKing',
        created_at: 'Tue Jul 07 13:00:00 +0000 2026',
        article_title: 'How durable businesses are built',
        article_text: 'The complete article body.\nIt keeps every paragraph.',
        article_url: 'https://x.com/MediaKing/article/99',
        tweet_url: 'https://x.com/MediaKing/status/3'
    }, {
        id: '4',
        type: 'reply',
        reply_to_id: '900',
        reply_to_username: 'another_writer',
        text: 'A reply to a post outside this export',
        author_name: 'Matt Paulson',
        author_username: 'MediaKing',
        tweet_url: 'https://x.com/MediaKing/status/4'
    }, {
        id: '5',
        type: 'retweet',
        text: 'A reposted post',
        author_name: 'Matt Paulson',
        author_username: 'MediaKing',
        created_at: 'Tue Jul 07 14:00:00 +0000 2026',
        tweet_url: 'https://x.com/MediaKing/status/5'
    }], {
        name: 'Matt Paulson',
        screenName: 'MediaKing',
        bio: 'Founder and CEO',
        location: 'Sioux Falls, South Dakota',
        accountBasedIn: 'United States',
        locationAccurate: false,
        isVerified: true,
        premiumSince: '2023-02-01T00:00:00.000Z',
        accountSource: 'United States App Store',
        affiliateUsername: 'ExampleOrg',
        usernameChangeCount: 1,
        usernameLastChangedAt: '2023-09-01T00:00:00.000Z',
        url: 'https://mattpaulson.com',
        followersCount: 76000,
        followingCount: 3252,
        subscriptionsCount: 2,
        createdAt: 'Sat Mar 01 00:00:00 +0000 2008'
    }, {
        postSelection: {
            postSelectionVersion: 1,
            includeOriginalPosts: true,
            includeQuotes: false,
            includeReplies: true,
            includeRetweets: true,
            includeArticles: true
        }
    });

    assert.match(text, /^PROFILE\nName: Matt Paulson\nUsername: @MediaKing/m);
    assert.match(text, /Profile: https:\/\/x\.com\/MediaKing/);
    assert.match(text, /Account based in: United States/);
    assert.match(text, /Account location accurate: no/);
    assert.match(text, /Premium: yes/);
    assert.match(text, /Premium since: 2023-02-01T00:00:00.000Z/);
    assert.match(text, /Connected via: United States App Store/);
    assert.match(text, /Affiliate account: @ExampleOrg/);
    assert.match(text, /Username changes: 1/);
    assert.match(text, /Username last changed: 2023-09-01T00:00:00.000Z/);
    assert.match(text, /Followers: 76000/);
    assert.match(text, /Subscriptions: 2/);
    assert.match(text, /POSTS \(5\)/);
    assert.match(
        text,
        /Included types: Original posts, Replies, Reposts, Articles/,
        'AI-friendly TXT must state the exact content menu that produced the rows'
    );
    assert.match(text,
        /1\. POST\nPost: "First line\nSecond line"\nPost metrics: 1200 views, 47 likes, 3 reposts, 2 replies, 1 quotes, 9 bookmarks\nDate: 2026-07-07T12:00:00\.000Z\nPost URL: https:\/\/x\.com\/MediaKing\/status\/1/);
    assert.match(text,
        /2\. REPLY\nPost: "A direct continuation"\nReply to: post #1 — https:\/\/x\.com\/MediaKing\/status\/1\nReply chain: #1 → #2\nDate: 2026-07-07T12:05:00\.000Z\nPost URL: https:\/\/x\.com\/MediaKing\/status\/2/);
    assert.match(text,
        /3\. ARTICLE\nPost: "My introduction to the article"\nArticle title: How durable businesses are built\nArticle: \(The complete article body\.\nIt keeps every paragraph\.\)\nArticle URL: https:\/\/x\.com\/MediaKing\/article\/99\nDate: 2026-07-07T13:00:00\.000Z\nPost URL: https:\/\/x\.com\/MediaKing\/status\/3/);
    assert.match(text,
        /4\. REPLY\nPost: "A reply to a post outside this export"\nReply to: https:\/\/x\.com\/another_writer\/status\/900\nPost URL: https:\/\/x\.com\/MediaKing\/status\/4/);
    assert.match(text,
        /5\. REPOST\nAuthor: Matt Paulson \(@MediaKing\)\nPost: "A reposted post"\nDate: 2026-07-07T14:00:00\.000Z\nPost URL: https:\/\/x\.com\/MediaKing\/status\/5/);
    assert.equal((text.match(/Author: Matt Paulson \(@MediaKing\)/g) || []).length, 1,
        'the profile owner must be omitted except for an explicit repost');
    assert.doesNotMatch(text, /^\s*Post: \(/m,
        'post text must not be wrapped in parentheses');
    assert.doesNotMatch(text, /undefined|null/);

    
}

function testPostsTxtUsesSequentialNumbersAndExplainsReplyChains() {
    const context = vm.createContext({ Date, Number });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const items = Array.from({ length: 1000 }, (_, index) => {
        const number = index + 1;
        return {
            id: String(number),
            type: 'tweet',
            text: `Post ${number}`,
            author_username: 'example',
            tweet_url: `https://x.com/example/status/${number}`
        };
    });
    for (let index = 1; index <= 3; index++) {
        items[index].type = 'reply';
        items[index].reply_to_id = String(index);
        items[index].reply_to_username = 'example';
    }
    items[4].type = 'reply';
    items[4].reply_to_id = 'outside';
    items[4].reply_to_username = 'another_writer';

    const text = context.XPorterCSV.generatePostsText(items, {
        name: 'Example',
        screenName: 'example'
    });
    const entryNumbers = [...text.matchAll(/^(\d+(?:\.\d+)*)\. (?:POST|REPLY|REPOST|QUOTE|ARTICLE)$/gm)]
        .map(match => match[1]);

    assert.match(text, /POSTS \(1000\)/);
    assert.deepEqual(
        entryNumbers,
        Array.from({ length: 1000 }, (_, index) => String(index + 1)),
        'the last visible number must match the advertised export total'
    );
    assert.match(
        text,
        /4\. REPLY\nPost: "Post 4"\nReply to: post #3 — https:\/\/x\.com\/example\/status\/3\nReply chain: #1 → #2 → #3 → #4/
    );
    assert.match(
        text,
        /5\. REPLY\nPost: "Post 5"\nReply to: https:\/\/x\.com\/another_writer\/status\/outside/
    );
    assert.doesNotMatch(
        text,
        /5\. REPLY[\s\S]*?Reply chain:/,
        'an unavailable external parent must not get an invented in-export chain'
    );
    assert.equal((text.match(/^Post URL:/gm) || []).length, 1000);
}

function testPostsTxtIncludesQuotedPostContextFromTimelinePayload() {
    const context = vm.createContext({
        Date,
        Number,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        ArrayBuffer
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const quote = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: {
            id_str: '200',
            full_text: 'My comment above the quoted post',
            created_at: 'Tue Jul 07 12:00:00 +0000 2026',
            favorite_count: 10,
            retweet_count: 2,
            reply_count: 1,
            quote_count: 0,
            bookmark_count: 3
        },
        core: {
            user_results: {
                result: {
                    core: { name: 'Profile Owner', screen_name: 'profile_owner' }
                }
            }
        },
        views: { count: '500' },
        quoted_status_result: {
            result: {
                legacy: {
                    id_str: '100',
                    full_text: 'The original post that gives the quote its context',
                    created_at: 'Tue Jul 07 11:00:00 +0000 2026',
                    favorite_count: 47,
                    retweet_count: 6,
                    reply_count: 5,
                    quote_count: 4,
                    bookmark_count: 2
                },
                core: {
                    user_results: {
                        result: {
                            core: { name: 'Original Author', screen_name: 'original_author' }
                        }
                    }
                },
                views: { count: '1200' },
                article: {
                    article_results: {
                        result: {
                            rest_id: 'article-100',
                            title: 'The complete quoted article',
                            plain_text: 'Every available paragraph from the quoted Article.'
                        }
                    }
                }
            }
        }
    })`, context);

    const text = context.XPorterCSV.generatePostsText([quote], {
        name: 'Profile Owner',
        screenName: 'profile_owner'
    });

    assert.match(text,
        /  Post: "The original post that gives the quote its context"\n  Quoted post metrics: 1200 views, 47 likes, 6 reposts, 5 replies, 4 quotes, 2 bookmarks/);
    assert.match(text,
        /  Date: 2026-07-07T11:00:00\.000Z\n  Post URL: https:\/\/x\.com\/original_author\/status\/100/);
    assert.match(text,
        /  Post URL: https:\/\/x\.com\/original_author\/status\/100\nDate: 2026-07-07T12:00:00\.000Z\nPost URL: https:\/\/x\.com\/profile_owner\/status\/200/);
    assert.match(text,
        /Post: "My comment above the quoted post"\nPost metrics: 500 views, 10 likes, 2 reposts, 1 replies, 0 quotes, 3 bookmarks\nQuoted post:/);
}

function testQuotedPostContextOmitsMetricsMissingFromTimelinePayload() {
    const context = vm.createContext({ Date, Number });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const quote = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: {
            id_str: '201',
            full_text: 'A quote whose embedded card has no metrics'
        },
        core: {
            user_results: {
                result: {
                    core: { name: 'Profile Owner', screen_name: 'profile_owner' }
                }
            }
        },
        quoted_status_result: {
            result: {
                legacy: {
                    id_str: '101',
                    full_text: 'Context without engagement fields'
                },
                core: {
                    user_results: {
                        result: {
                            core: { name: 'Original Author', screen_name: 'original_author' }
                        }
                    }
                }
            }
        }
    })`, context);

    const text = context.XPorterCSV.generatePostsText([quote], {
        name: 'Profile Owner',
        screenName: 'profile_owner'
    });
    const quotedBlock = text.slice(text.indexOf('Quoted post:'));

    assert.doesNotMatch(quotedBlock, /  Metrics:/,
        'unavailable quoted-post metrics must not be presented as zero');
    assert.match(quotedBlock, /  Post: "Context without engagement fields"/);
}

function testPostsXlsxOmitsColumnsWithoutValues() {
    const context = vm.createContext({
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        ArrayBuffer
    });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const bytes = context.XPorterCSV.generateXLSX([{
        id: '200',
        type: 'quote',
        text: 'My comment',
        tweet_url: 'https://x.com/example/status/200',
        author_name: 'Example',
        author_username: 'example',
        favorite_count: 0,
        quoted_post: {
            id: '100',
            type: 'tweet',
            text: 'Quoted context',
            tweet_url: 'https://x.com/original/status/100',
            author_name: 'Original',
            author_username: 'original'
        }
    }], false);
    const workbookText = new TextDecoder().decode(bytes);

    for (const present of [
        'author_username',
        'favorite_count',
        'quoted_post_id',
        'quoted_post_text',
        'Quoted context'
    ]) {
        assert(workbookText.includes(present), `posts XLSX must keep populated column ${present}`);
    }
    for (const absent of [
        'source',
        'hashtags',
        'media_alt_texts',
        'reply_to_post_text',
        'reply_to_quoted_post_text',
        'quoted_post_article_text'
    ]) {
        assert(!workbookText.includes(absent), `posts XLSX must omit empty column ${absent}`);
    }
}

function testSavedFormatsOmitEmptyFieldsButKeepZerosAndFalse() {
    const context = vm.createContext({
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        ArrayBuffer,
        Date,
        Number
    });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const post = {
        id: '200',
        type: 'quote',
        text: 'My comment',
        tweet_url: 'https://x.com/example/status/200',
        source: '',
        hashtags: '   ',
        media_alt_texts: null,
        favorite_count: 0,
        protected: false,
        quoted_post: {
            id: '100',
            text: '',
            view_count: 0,
            media_urls: '',
            article_url: null
        }
    };

    const csv = context.XPorterCSV.generateCSV([post], false);
    const csvHeaders = csv.slice(1).split('\n')[0].split(',');
    assert(csvHeaders.includes('favorite_count'), 'CSV must keep a real zero-valued metric');
    assert(csvHeaders.includes('quoted_post_view_count'),
        'CSV must keep a real zero-valued nested metric');
    for (const emptyHeader of [
        'source',
        'hashtags',
        'media_alt_texts',
        'quoted_post_text',
        'quoted_post_media_urls',
        'quoted_post_article_url'
    ]) {
        assert(!csvHeaders.includes(emptyHeader), `CSV must omit empty column ${emptyHeader}`);
    }

    const compact = context.XPorterCSV.compactExportData([post]);
    assert.deepEqual(JSON.parse(JSON.stringify(compact)), [{
        id: '200',
        type: 'quote',
        text: 'My comment',
        tweet_url: 'https://x.com/example/status/200',
        favorite_count: 0,
        protected: false,
        quoted_post: {
            id: '100',
            view_count: 0
        }
    }]);

    const userCsv = context.XPorterCSV.generateCSV([{
        id: 'u1',
        name: 'Example',
        bio: '',
        location: null,
        followers_count: 0,
        verified: false,
        protected: false
    }], true);
    const userHeaders = userCsv.slice(1).split('\n')[0].split(',');
    for (const keptHeader of ['id', 'name', 'followers_count', 'verified', 'protected']) {
        assert(userHeaders.includes(keptHeader), `user CSV must keep ${keptHeader}`);
    }
    assert(!userHeaders.includes('bio'), 'user CSV must omit an all-empty bio column');
    assert(!userHeaders.includes('location'), 'user CSV must omit an all-empty location column');

    const txt = context.XPorterCSV.generatePostsText([post], {}, { mode: 'bookmarks' });
    assert.doesNotMatch(txt, /undefined|null|Source:|Hashtags:/,
        'TXT must continue omitting empty or unsupported fields');
}

function testReplyContextIsRenderedAcrossExportFormats() {
    const context = vm.createContext({
        Date,
        Number,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        ArrayBuffer
    });
    vm.runInContext(source('utils/columns-i18n.js'), context, {
        filename: 'utils/columns-i18n.js'
    });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const reply = {
        id: '200',
        type: 'reply',
        text: 'My reply to Alex',
        author_name: 'Profile Owner',
        author_username: 'profile_owner',
        reply_to_id: '100',
        reply_to_username: 'alex',
        conversation_id: '100',
        tweet_url: 'https://x.com/profile_owner/status/200',
        reply_to_post: {
            id: '100',
            type: 'quote',
            text: 'Alex comments on the Claude watermark announcement',
            tweet_url: 'https://x.com/alex/status/100',
            author_name: 'Alex',
            author_username: 'alex',
            created_at: 'Tue Jul 07 11:00:00 +0000 2026',
            favorite_count: 17,
            media_type: '',
            media_urls: '',
            media_alt_texts: '',
            quoted_post: {
                id: '90',
                text: 'Claude models will now have invisible watermarks',
                tweet_url: 'https://x.com/nik/status/90',
                author_name: 'NIK',
                author_username: 'nik',
                created_at: 'Tue Jul 07 10:00:00 +0000 2026',
                view_count: '9001',
                media_type: 'photo',
                media_urls: 'https://pbs.twimg.com/media/watermark.jpg',
                media_alt_texts: 'Claude watermark announcement'
            }
        }
    };

    const csv = context.XPorterCSV.generateCSV([reply], false);
    const csvHeader = csv.slice(1).split('\n')[0].split(',');
    for (const header of [
        'reply_to_id',
        'reply_to_username',
        'conversation_id',
        'reply_to_post_text',
        'reply_to_post_author_username',
        'reply_to_post_favorite_count',
        'reply_to_quoted_post_text',
        'reply_to_quoted_post_author_username',
        'reply_to_quoted_post_view_count'
    ]) {
        assert(csvHeader.includes(header), `posts CSV is missing ${header}`);
    }
    assert(!csvHeader.includes('quoted_post_text'),
        'CSV must not keep an empty primary quoted-post column');
    for (const value of [
        'Alex comments on the Claude watermark announcement',
        'Claude models will now have invisible watermarks',
        '9001',
        'https://pbs.twimg.com/media/watermark.jpg'
    ]) {
        assert(csv.includes(value), `posts CSV is missing reply context: ${value}`);
    }
    const russianCsv = context.XPorterCSV.generateCSV([reply], false, {
        localize: true,
        lang: 'ru'
    });
    assert.match(russianCsv, /ID исходного поста/);
    assert.match(russianCsv, /Исходный пост: Текст/);
    assert.match(russianCsv, /Цитата в исходном посте: Текст/);

    const xlsx = context.XPorterCSV.generateXLSX([reply], false, {
        profile: { name: 'Profile Owner', screenName: 'profile_owner' }
    });
    const workbookText = new TextDecoder().decode(xlsx);
    for (const value of [
        'reply_to_post_text',
        'reply_to_quoted_post_text',
        'Alex comments on the Claude watermark announcement',
        'Claude models will now have invisible watermarks'
    ]) {
        assert(workbookText.includes(value), `posts XLSX is missing reply context: ${value}`);
    }

    const text = context.XPorterCSV.generatePostsText([reply], {
        name: 'Profile Owner',
        screenName: 'profile_owner'
    });
    assert.match(text, /Reply to post:\n  Author: Alex \(@alex\)/);
    assert.match(text, /  Post: "Alex comments on the Claude watermark announcement"/);
    assert.match(text, /  Quoted post:\n    Author: NIK \(@nik\)/);
    assert.match(text, /    Post: "Claude models will now have invisible watermarks"/);
    assert.match(text, /    Media: photo — https:\/\/pbs\.twimg\.com\/media\/watermark\.jpg/);

    const parsedJson = JSON.parse(JSON.stringify(
        context.XPorterCSV.compactExportData([reply]),
        null,
        2
    ));
    assert.equal(parsedJson.length, 1, 'reply context must not count as another exported post');
    assert.equal(parsedJson[0].reply_to_post.author_username, 'alex');
    assert.equal(parsedJson[0].reply_to_post.quoted_post.author_username, 'nik');
    assert.equal('media_type' in parsedJson[0].reply_to_post, false,
        'JSON must omit empty nested fields');
}

async function testStaleBearerRetriesImmediately() {
    const fallbackBearer = 'FALLBACK_BEARER';
    const cachedEndpoints = {
        UserByScreenName: { queryId: 'cached-query-id', operationName: 'UserByScreenName' },
        UserTweets: { queryId: 'posts-query-id', operationName: 'UserTweets' },
        UserTweetsAndReplies: { queryId: 'replies-query-id', operationName: 'UserTweetsAndReplies' },
        Bookmarks: { queryId: 'bookmarks-query-id', operationName: 'Bookmarks' },
        SearchTimeline: { queryId: 'search-query-id', operationName: 'SearchTimeline' },
        Followers: { queryId: 'followers-query-id', operationName: 'Followers' },
        Following: { queryId: 'following-query-id', operationName: 'Following' },
        BlueVerifiedFollowers: { queryId: 'verified-query-id', operationName: 'BlueVerifiedFollowers' }
    };
    const stored = {
        xporter_discovered_endpoints: {
            endpoints: cachedEndpoints,
            time: Date.now(),
            bearer: 'STALE_DYNAMIC_BEARER',
            discoveredOperations: Object.keys(cachedEndpoints)
        }
    };
    const authHeaders = [];
    const responses = [
        new Response('{}', { status: 401 }),
        new Response(JSON.stringify({
            data: {
                user: {
                    result: {
                        rest_id: '1',
                        core: { name: 'Test', screen_name: 'test' },
                        is_blue_verified: true,
                        professional: { category: [{ name: 'Entrepreneur' }] },
                        creator_subscriptions_count: 2,
                        legacy: {
                            description: 'Founder',
                            location: 'Sioux Falls',
                            followers_count: 76000,
                            friends_count: 3252,
                            listed_count: 900,
                            favourites_count: 12,
                            created_at: 'Sat Mar 01 00:00:00 +0000 2008',
                            entities: { url: { urls: [{ expanded_url: 'https://example.com' }] } }
                        }
                    }
                }
            }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
    ];

    const context = vm.createContext({
        console,
        Response,
        AbortController,
        AbortSignal,
        navigator: { userAgent: 'XPorter test' },
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: {
            FALLBACK_BEARER_TOKEN: fallbackBearer,
            API_FETCH_TIMEOUT: 1000,
            ENDPOINT_CACHE_TTL: 60_000
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            },
            storage: {
                local: {
                    async get(key) { return { [key]: stored[key] }; },
                    async set(values) { Object.assign(stored, values); }
                }
            }
        },
        fetch: async (_url, options) => {
            authHeaders.push(options.headers.authorization);
            return responses.shift();
        }
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });

    await context.XPorterAPI.discoverEndpoints();
    const user = await context.XPorterAPI.getUserByScreenName('test');
    assert.equal(user.id, '1');
    assert.equal(user.bio, 'Founder');
    assert.equal(user.location, 'Sioux Falls');
    assert.equal(user.url, 'https://example.com');
    assert.equal(user.followersCount, 76000);
    assert.equal(user.subscriptionsCount, 2);
    assert.equal(user.professionalCategory, 'Entrepreneur');
    assert.equal(user.isVerified, true);
    assert.deepEqual(authHeaders, [
        'Bearer STALE_DYNAMIC_BEARER',
        `Bearer ${fallbackBearer}`
    ], 'the same request must retry once with the built-in bearer');
}

async function testFollowingUsesRestEndpointAndNormalizesUsers() {
    let requestUrl = '';
    let requestOptions = null;
    const context = vm.createContext({
        console,
        Response,
        AbortController,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'XPorter test' },
        XPORTER_CONFIG: {
            FALLBACK_BEARER_TOKEN: 'fallback',
            API_FETCH_TIMEOUT: 1000
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async (url, options) => {
            requestUrl = String(url);
            requestOptions = options;
            return new Response(JSON.stringify({
                users: [{
                    id_str: '42',
                    name: 'Followed User',
                    screen_name: 'followed',
                    description: 'Line one\nLine two',
                    followers_count: 12,
                    friends_count: 34,
                    statuses_count: 56,
                    listed_count: 7,
                    is_blue_verified: true,
                    protected: false,
                    created_at: 'Tue Jul 28 00:00:00 +0000 2026',
                    profile_image_url_https: 'https://pbs.twimg.com/avatar_normal.jpg'
                }],
                next_cursor_str: '987654321'
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'x-rate-limit-limit': '15',
                    'x-rate-limit-remaining': '14',
                    'x-rate-limit-reset': '1785240000'
                }
            });
        }
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });

    const result = await context.XPorterAPI.fetchFollowing('1890388644273258496', '123', 100);

    assert.equal(
        requestUrl,
        'https://x.com/i/api/1.1/friends/list.json?user_id=1890388644273258496&count=100&skip_status=true&include_user_entities=false&cursor=123',
        'Following must use the REST friends list instead of the currently empty GraphQL timeline'
    );
    assert.equal(requestOptions.credentials, 'include');
    assert.equal(requestOptions.headers['x-csrf-token'], 'csrf');
    assert.equal(result.users.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result.users[0])), {
        id: '42',
        name: 'Followed User',
        username: 'followed',
        bio: 'Line one Line two',
        location: '',
        url: '',
        followers_count: 12,
        following_count: 34,
        tweet_count: 56,
        listed_count: 7,
        verified: true,
        protected: false,
        created_at: 'Tue Jul 28 00:00:00 +0000 2026',
        profile_image_url: 'https://pbs.twimg.com/avatar_400x400.jpg',
        profile_url: 'https://x.com/followed'
    });
    assert.equal(result.nextCursor, '987654321');
}

async function testMissingProfileCountsRemainUnknown() {
    const context = vm.createContext({
        console,
        Response,
        AbortController,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'XPorter test' },
        XPORTER_CONFIG: {
            FALLBACK_BEARER_TOKEN: 'fallback',
            API_FETCH_TIMEOUT: 1000
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async () => new Response(JSON.stringify({
            data: {
                user: {
                    result: {
                        rest_id: '1890388644273258496',
                        core: {
                            name: 'Ernesto Lopez',
                            screen_name: 'ErnestoSOFTWARE',
                            created_at: 'Fri Feb 14 13:12:38 +0000 2025'
                        },
                        legacy: {},
                        is_blue_verified: true
                    }
                }
            }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    context.XPorterAPI.setLiveQueryId('UserByScreenName', 'current-user-query-id');

    const user = await context.XPorterAPI.getUserByScreenName('ErnestoSOFTWARE');

    assert.equal(user.followersCount, null);
    assert.equal(user.followingCount, null);
    assert.equal(user.tweetCount, null);
}

async function testProfileFeedSelectsMatchingTimeline() {
    const requestUrls = [];
    const context = vm.createContext({
        console,
        Response,
        AbortController,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'XPorter test' },
        XPORTER_CONFIG: { FALLBACK_BEARER_TOKEN: 'fallback', API_FETCH_TIMEOUT: 1000 },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async (url) => {
            requestUrls.push(String(url));
            return new Response(JSON.stringify({
                data: { user: { result: { timeline_v2: { timeline: { instructions: [] } } } } }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    context.XPorterAPI.setLiveQueryId('UserTweets', 'all-query-id');
    context.XPorterAPI.setLiveQueryId('UserOriginalsTimeline', 'posts-query-id');
    context.XPorterAPI.setLiveQueryId('UserRepliesTimeline', 'replies-query-id');

    await context.XPorterAPI.fetchUserTweets('1', null, 20, 'all');
    await context.XPorterAPI.fetchUserTweets('1', null, 20, 'posts');
    await context.XPorterAPI.fetchUserTweets('1', null, 20, 'replies');

    assert.match(requestUrls[0], /\/all-query-id\/UserTweets\?/,
        'All must use the redesigned profile All timeline');
    assert.match(requestUrls[1], /\/posts-query-id\/UserOriginalsTimeline\?/,
        'Posts must use the redesigned original-posts timeline');
    assert.match(requestUrls[2], /\/replies-query-id\/UserRepliesTimeline\?/,
        'Replies must use the current profile Replies timeline');
}

async function testActiveApiRequestCanBeAborted() {
    const context = vm.createContext({
        console,
        AbortController,
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: { API_FETCH_TIMEOUT: 60_000 },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        })
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    context.XPorterAPI.setLiveQueryId('UserByScreenName', 'test-query-id');
    const request = context.XPorterAPI.getUserByScreenName('test');
    await new Promise(resolve => setImmediate(resolve));
    context.XPorterAPI.abortActiveRequests();
    await assert.rejects(request, /ABORTED/, 'Stop must cancel an in-flight API request immediately');
}

async function testActiveResponseBodyCanBeAborted() {
    const context = vm.createContext({
        console,
        AbortController,
        Headers,
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: { API_FETCH_TIMEOUT: 60_000 },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async (_url, options) => ({
            status: 200,
            ok: true,
            headers: new Headers(),
            json: () => new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('aborted body');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            })
        })
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    context.XPorterAPI.setLiveQueryId('UserByScreenName', 'test-query-id');
    const request = context.XPorterAPI.getUserByScreenName('test');
    await new Promise(resolve => setImmediate(resolve));
    context.XPorterAPI.abortActiveRequests();
    await assert.rejects(request, /ABORTED/, 'Stop must also cancel a response body read without a timeout retry');
}

async function testDownloadModulePreservesCurrentExportContract() {
    let downloadRecorded = 0;
    let feedbackRefreshes = 0;
    let txtProfile = null;
    let xlsxProfile = null;
    let xlsxMediaAssets = null;
    let photoFetches = 0;
    let photoPermissionState = 'granted';
    let keepAliveCallback = null;
    let keepAliveCleared = 0;
    let keepAliveTouches = 0;
    let currentMode = 'posts';
    let csvIsUsers = null;
    let jsonCompactions = 0;
    class FakeFileReader {
        readAsDataURL() {
            this.result = 'data:text/csv;base64,ZmFrZQ==';
            this.onload();
        }
    }
    const context = vm.createContext({
        Blob,
        Response,
        URL,
        DataView,
        Uint8Array,
        FileReader: FakeFileReader,
        fetch: async (url) => {
            photoFetches += 1;
            assert.equal(String(url), 'https://pbs.twimg.com/media/download-test.png');
            return new Response(new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10,
                0, 0, 0, 13, 73, 72, 68, 82,
                0, 0, 0, 2, 0, 0, 0, 3
            ]), {
                status: 200,
                headers: { 'content-type': 'image/png' }
            });
        },
        setInterval(callback) {
            keepAliveCallback = callback;
            return 7;
        },
        clearInterval(timer) {
            assert.equal(timer, 7);
            keepAliveCleared += 1;
        },
        XLog: { error() {} },
        XPORTER_CONFIG: {
            DOWNLOAD_PART_LIMITS: {
                posts: { csv: 10, json: 10, xlsx: 10, txt: 10 },
                users: { csv: 10, json: 10, xlsx: 10 }
            },
            STORAGE_BATCH_READ_SIZE: 100
        },
        XPorterStorage: {
            async loadTweetBatches() {
                return [[{
                    id: '12345',
                    text: 'hello',
                    media_type: 'photo',
                    media_urls: 'https://pbs.twimg.com/media/download-test.png'
                }]];
            },
            async loadAllTweets() { throw new Error('current downloads must not load the whole export'); },
            async loadExportState() {
                return {
                    username: 'test', exportMode: currentMode, outputFormat: 'csv',
                    tweetCount: 1, totalBatches: 1,
                    userInfo: { name: 'Test User', screenName: 'test' }
                };
            },
            async loadSettings() {
                return {
                    localizeExportHeaders: false,
                    language: 'en',
                    embedPostPhotos: true,
                    embedBookmarkPhotos: true
                };
            },
            async recordDownload() { downloadRecorded += 1; }
        },
        XPorterPostDB: { async getAllPosts() { return []; } },
        XPorterCSV: {
            generateCSV(_items, isUsers) {
                csvIsUsers = isUsers;
                return 'id,text\n12345,hello\n';
            },
            generatePostsText(_items, profile) { txtProfile = profile; return 'PROFILE\n'; },
            generateXLSX(_items, _isUsers, opts) {
                xlsxProfile = opts?.profile || null;
                xlsxMediaAssets = opts?.mediaAssets || null;
                return new Uint8Array([1]);
            },
            compactExportData(items) {
                jsonCompactions += 1;
                return items;
            },
            generateExportFilename(_username, _mode, extension) { return `XPorter_posts_test.${extension}`; },
            escapeCSVValue(value) { return String(value ?? ''); }
        },
        XPorterFeedback: { refresh() { feedbackRefreshes += 1; } },
        chrome: {
            permissions: {
                async contains() {
                    if (photoPermissionState === 'error') {
                        throw new Error('permissions unavailable');
                    }
                    return photoPermissionState === 'granted';
                }
            },
            runtime: {
                lastError: null,
                sendMessage: async () => ({}),
                getPlatformInfo(callback) {
                    keepAliveTouches += 1;
                    callback?.({ os: 'mac' });
                }
            },
            downloads: { download(_options, callback) { callback(42); } }
        }
    });
    vm.runInContext(source('background/downloads.js'), context, { filename: 'background/downloads.js' });
    const result = await context.XPorterDownloads.downloadCurrent('csv');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        success: true,
        downloadId: 42,
        count: 1,
        filename: 'XPorter_posts_test.csv'
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(downloadRecorded, 1, 'successful export downloads must update usage counters');
    assert.equal(feedbackRefreshes, 1, 'successful export downloads must refresh uninstall telemetry');

    const jsonResult = await context.XPorterDownloads.downloadCurrent('json');
    assert.equal(jsonResult.filename, 'XPorter_posts_test.json');

    const txtResult = await context.XPorterDownloads.downloadCurrent('txt');
    assert.equal(txtResult.filename, 'XPorter_posts_test.txt');
    assert.deepEqual(JSON.parse(JSON.stringify(txtProfile)), { name: 'Test User', screenName: 'test' });

    const clipboardResult = await context.XPorterDownloads.getCurrentPostsText();
    assert.equal(clipboardResult.success, true);
    assert.equal(clipboardResult.text, 'PROFILE\n');
    assert.equal(clipboardResult.count, 1);

    const xlsxResult = await context.XPorterDownloads.downloadCurrent('xlsx');
    assert.equal(xlsxResult.filename, 'XPorter_posts_test.xlsx');
    assert.deepEqual(
        JSON.parse(JSON.stringify(xlsxProfile)),
        { name: 'Test User', screenName: 'test' },
        'post XLSX generation must receive the same profile snapshot as TXT'
    );
    assert.equal(photoFetches, 1, 'granted photo access must embed the requested media');
    assert.equal(xlsxMediaAssets?.length, 1);

    photoPermissionState = 'denied';
    await context.XPorterDownloads.downloadCurrent('xlsx');
    assert.equal(photoFetches, 1,
        'revoked photo access must keep the URL-only workbook without fetching media');
    assert.equal(xlsxMediaAssets, null);

    photoPermissionState = 'error';
    await context.XPorterDownloads.downloadCurrent('xlsx');
    assert.equal(photoFetches, 1,
        'a permissions API failure must fail closed and keep the URL-only workbook');
    assert.equal(xlsxMediaAssets, null);
    

    const detached = await context.XPorterDownloads.startCurrentDownload('csv');
    assert.equal(detached.started, true);
    assert.equal(typeof keepAliveCallback, 'function',
        'detached downloads must keep the MV3 worker alive');
    keepAliveCallback();
    assert.equal(keepAliveTouches, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(keepAliveCleared, 1, 'download keepalive must stop after completion');

    
}

async function testLargeDownloadsAreSplitAndReadIncrementally() {
    const sourceBatches = [
        [{ id: '1' }, { id: '2' }],
        [{ id: '3' }, { id: '4' }],
        [{ id: '5' }]
    ];
    const rangeReads = [];
    const generatedParts = [];
    const startedDownloads = [];
    const progressEvents = [];
    const exportedAtValues = [];

    class FakeFileReader {
        readAsDataURL() {
            this.result = 'data:text/csv;base64,ZmFrZQ==';
            this.onload();
        }
    }

    const context = vm.createContext({
        Blob,
        FileReader: FakeFileReader,
        XLog: { error() {} },
        XPORTER_CONFIG: {
            DOWNLOAD_PART_LIMITS: {
                posts: { csv: 2, json: 2, xlsx: 2, txt: 2 },
                users: { csv: 2, json: 2, xlsx: 2 }
            },
            STORAGE_BATCH_READ_SIZE: 2
        },
        XPorterStorage: {
            async loadExportState() {
                return {
                    username: 'large', exportMode: 'followers', outputFormat: 'csv',
                    tweetCount: 5, totalBatches: 3
                };
            },
            async loadTweetBatches(start, count) {
                rangeReads.push([start, count]);
                return sourceBatches.slice(start, start + count);
            },
            async loadAllTweets() { throw new Error('multipart download loaded all rows at once'); },
            async loadSettings() { return { localizeExportHeaders: false, language: 'en' }; },
            async recordDownload() {}
        },
        XPorterPostDB: { async getAllPosts() { return []; } },
        XPorterCSV: {
            generateCSV(items) { generatedParts.push(items.map(item => item.id)); return 'csv'; },
            generatePostsText() { return 'txt'; },
            generateXLSX() { return new Uint8Array([1]); },
            generateExportFilename(_username, _mode, extension, options) {
                exportedAtValues.push(options.exportedAt.getTime());
                const suffix = options.partCount > 1
                    ? `_part-${String(options.partNumber).padStart(3, '0')}-of-${String(options.partCount).padStart(3, '0')}`
                    : '';
                return `XPorter${suffix}.${extension}`;
            },
            escapeCSVValue(value) { return String(value ?? ''); }
        },
        XPorterFeedback: { refresh() {} },
        chrome: {
            runtime: {
                lastError: null,
                sendMessage(message) { progressEvents.push(message); return Promise.resolve({}); }
            },
            downloads: {
                download(options, callback) {
                    startedDownloads.push(options);
                    callback(startedDownloads.length);
                }
            }
        }
    });

    vm.runInContext(source('background/downloads.js'), context, { filename: 'background/downloads.js' });
    const plan = await context.XPorterDownloads.getCurrentPlan('csv');
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), {
        count: 5,
        format: 'csv',
        partSize: 2,
        partCount: 3,
        multipart: true,
        active: false
    });

    const result = await context.XPorterDownloads.downloadCurrent('csv');
    assert.equal(result.success, true);
    assert.equal(result.partCount, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(generatedParts)), [['1', '2'], ['3', '4'], ['5']]);
    assert.deepEqual(rangeReads, [[0, 2], [2, 1]]);
    assert.deepEqual(startedDownloads.map(download => download.saveAs), [false, false, false]);
    assert.deepEqual(startedDownloads.map(download => download.filename), [
        'XPorter_part-001-of-003.csv',
        'XPorter_part-002-of-003.csv',
        'XPorter_part-003-of-003.csv'
    ]);
    assert.equal(new Set(exportedAtValues).size, 1,
        'all parts from one export must share the same timestamp');
    assert(progressEvents.some(event => event.type === 'DOWNLOAD_PROGRESS' && event.partNumber === 2));
}

async function testSeenPostDownloadsOmitEmptyFields() {
    const downloadedContents = [];
    const downloadedFilenames = [];
    class FakeFileReader {
        readAsDataURL(blob) {
            blob.text().then((text) => {
                downloadedContents.push(text);
                this.result = 'data:application/octet-stream;base64,ZmFrZQ==';
                this.onload();
            }, () => this.onerror());
        }
    }
    const context = vm.createContext({
        Blob,
        Date,
        Number,
        TextEncoder,
        Uint8Array,
        DataView,
        ArrayBuffer,
        FileReader: FakeFileReader,
        XLog: { error() {} },
        XPORTER_CONFIG: {},
        XPorterStorage: {},
        XPorterPostDB: {
            async getAllPosts() {
                return [{
                    id: 'seen-1',
                    text: 'Seen post',
                    author_followers_count: 0,
                    author_verified: false,
                    first_seen_at: 1720000000000,
                    last_seen_at: 1720000005000,
                    last_surface: '',
                    media_types: null
                }];
            }
        },
        chrome: {
            runtime: { lastError: null },
            downloads: {
                download(options, callback) {
                    downloadedFilenames.push(options.filename);
                    callback(downloadedFilenames.length);
                }
            }
        }
    });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });
    vm.runInContext(source('background/downloads.js'), context, {
        filename: 'background/downloads.js'
    });

    const csvResult = await context.XPorterDownloads.downloadSeenPosts('csv');
    assert.equal(csvResult.success, true);
    const csvHeaders = downloadedContents[0].slice(1).split('\n')[0].split(',');
    assert(csvHeaders.includes('author_followers_count'));
    assert(csvHeaders.includes('author_verified'));
    assert(!csvHeaders.includes('last_surface'));
    assert(!csvHeaders.includes('media_types'));

    const jsonResult = await context.XPorterDownloads.downloadSeenPosts('json');
    assert.equal(jsonResult.success, true);
    assert.deepEqual(JSON.parse(downloadedContents[1]), [{
        id: 'seen-1',
        text: 'Seen post',
        author_followers_count: 0,
        author_verified: false,
        first_seen_at: '2024-07-03T09:46:40.000Z',
        last_seen_at: '2024-07-03T09:46:45.000Z'
    }]);
}

async function testUninstallFeedbackModuleKeepsAnonymousContract() {
    let uninstallUrl = '';
    const context = vm.createContext({
        URL,
        setTimeout,
        clearTimeout,
        detectBrowserLanguage: () => 'en',
        XPorterStorage: {
            async loadSettings() {
                return { language: 'en', theme: 'dark', quantityLimit: 500, exportSpeed: 'standard' };
            },
            async loadUsage() {
                return {
                    installedAt: Date.now() - 86400000,
                    byMode: { posts: 1 },
                    byFormat: { csv: 1 },
                    exportsStarted: 1,
                    exportsOk: 1,
                    itemsTotal: 5
                };
            },
            async markInstalled() {},
            async backfillInstalledAt() {}
        },
        chrome: {
            runtime: {
                onInstalled: { addListener() {} },
                onStartup: { addListener() {} },
                getManifest: () => ({ version: '1.4.8' }),
                getPlatformInfo: async () => ({ os: 'mac' }),
                setUninstallURL(url) { uninstallUrl = url; }
            }
        }
    });
    vm.runInContext(source('background/uninstall-feedback.js'), context, {
        filename: 'background/uninstall-feedback.js'
    });
    await context.XPorterFeedback.refresh();
    const parsed = new URL(uninstallUrl);
    assert.equal(parsed.searchParams.get('v'), '1.4.8');
    assert.equal(parsed.searchParams.get('items'), '5');
    assert.equal(parsed.searchParams.has('username'), false, 'uninstall URL must never include usernames');
}

function createWorkerHarness() {
    let savedState = null;
    let cleared = false;
    let firstItemRecords = 0;
    let saveStateSucceeds = true;
    let loadAllCalls = 0;
    let savedHistory = null;
    let aboutAccountCache = {};
    const savedBatches = [];
    const settings = {
        quantityLimit: 500,
        autoExpireEnabled: true,
        autoExpireHours: 4
    };

    const context = vm.createContext({
        console,
        URL,
        Blob,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        importScripts() {},
        XPORTER_CONFIG: { SPEED_PRESETS: { standard: {} } },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        XPorterAPI: {
            discoverEndpoints: async () => ({}),
            getRateLimit: () => null,
            toPostContext: (tweet) => ({ ...tweet }),
            setLiveQueryId() {}
        },
        XPorterCSV: {},
        XPorterColumns: {},
        XPorterFeedback: { refresh() {}, maybeRefresh() {} },
        XPorterDownloads: {
            async downloadCurrent() { return { success: true }; },
            async downloadHistory() { return { success: true }; },
            async downloadSeenPosts() { return { success: true }; }
        },
        XPorterPostDB: {
            upsertPosts: async () => ({}),
            getSummary: async () => ({ count: 0 }),
            getAllPosts: async () => [],
            clear: async () => {}
        },
        XPorterStorage: {
            async saveExportState(state) {
                if (!saveStateSucceeds) return false;
                savedState = { ...state, updatedAt: Date.now() };
                return true;
            },
            async loadExportState() { return savedState; },
            async loadSettings() { return { ...settings }; },
            async clearExportState() { cleared = true; savedState = null; return true; },
            async pruneExpiredExportHistory() { return { changed: false, expired: 0 }; },
            async loadDetectedUsername() { return ''; },
            async loadUsage() { return {}; },
            async markInstalled() {},
            async backfillInstalledAt() {},
            async saveSettings() { return true; },
            async recordExportStart() {},
            async recordExportPhase() {},
            async recordFirstItem() { firstItemRecords += 1; },
            async recordExportComplete() {},
            async recordExportStopped() {},
            async recordExportError() {},
            async loadAllTweets() { loadAllCalls += 1; return [{ id: '1' }]; },
            async saveTweetBatch(index, items) { savedBatches[index] = items.map(item => ({ ...item })); return true; },
            async loadTweetBatch(index) { return savedBatches[index] || []; },
            async loadAboutAccountCache() {
                return JSON.parse(JSON.stringify(aboutAccountCache));
            },
            async saveAboutAccountCache(cache) {
                aboutAccountCache = JSON.parse(JSON.stringify(cache));
                return true;
            },
            async saveExportHistory(entry) { savedHistory = entry; return true; }
        },
        RateLimitManager: class {
            constructor(options) {
                Object.assign(this, options);
            }
        },
        detectBrowserLanguage: () => 'en',
        loadTranslations: async () => ({}),
        chrome: {
            storage: { local: { setAccessLevel: async () => {} } },
            runtime: {
                id: 'test-extension',
                onInstalled: { addListener() {} },
                onStartup: { addListener() {} },
                onMessage: { addListener() {} },
                getManifest: () => ({ version: '1.4.8' }),
                setUninstallURL() {},
                getPlatformInfo: async () => ({ os: 'mac' }),
                sendMessage: async () => ({})
            },
            tabs: {
                query: async () => [],
                create: async () => ({ id: 1 }),
                remove: async () => {},
                update: async () => {},
                sendMessage: async () => ({})
            },
            action: {
                setBadgeText() {},
                setBadgeBackgroundColor() {}
            }
        }
    });
    vm.runInContext(source('utils/shared.js'), context, { filename: 'utils/shared.js' });
    vm.runInContext(source('background/service-worker.js'), context, { filename: 'background/service-worker.js' });
    return {
        context,
        setSavedState(state) { savedState = state; },
        getSavedState() { return savedState; },
        wasCleared() { return cleared; },
        firstItemRecords() { return firstItemRecords; },
        setSaveStateSucceeds(value) { saveStateSucceeds = value; },
        loadAllCalls() { return loadAllCalls; },
        getSavedHistory() { return savedHistory; },
        setAboutAccountCache(cache) { aboutAccountCache = JSON.parse(JSON.stringify(cache)); },
        getAboutAccountCache() { return aboutAccountCache; },
        getSavedBatches() { return savedBatches; }
    };
}

async function testRepliesFallbackRequiresZeroRowsAndPreservesSnapshot() {
    const eligibilityHarness = createWorkerHarness();
    assert.equal(
        vm.runInContext(`canFallbackWithoutReplies({
            running: false,
            status: 'error',
            error: 'REPLIES_UNAVAILABLE',
            exportMode: 'posts',
            tweetCount: 0,
            userId: '10',
            settings: { includeReplies: true }
        })`, eligibilityHarness.context),
        true
    );
    for (const ineligible of [
        `{ running:false, status:'error', error:'REPLIES_UNAVAILABLE', exportMode:'posts',
           tweetCount:1, userId:'10', settings:{includeReplies:true} }`,
        `{ running:false, status:'error', error:'RATE_LIMITED', exportMode:'posts',
           tweetCount:0, userId:'10', settings:{includeReplies:true} }`,
        `{ running:false, status:'error', error:'REPLIES_UNAVAILABLE', exportMode:'followers',
           tweetCount:0, userId:'10', settings:{includeReplies:true} }`,
        `{ running:false, status:'error', error:'REPLIES_UNAVAILABLE', exportMode:'posts',
           tweetCount:0, userId:null, settings:{includeReplies:true} }`
    ]) {
        assert.equal(vm.runInContext(`canFallbackWithoutReplies(${ineligible})`, eligibilityHarness.context), false);
    }

    const harness = createWorkerHarness();
    harness.setSavedState({
        running: false,
        status: 'error',
        error: 'REPLIES_UNAVAILABLE',
        username: 'target',
        userId: '10',
        userInfo: { id: '10', screenName: 'target' },
        exportMode: 'posts',
        outputFormat: 'xlsx',
        tweetCount: 0,
        totalBatches: 0,
        cursor: 'replies-cursor',
        startedAt: 123,
        settings: {
            includeReplies: true,
            includeRetweets: false,
            includeArticles: true,
            quantityLimit: 500,
            exportSpeed: 'standard'
        },
        rateLimiterState: { requestCount: 9, totalRequests: 9 }
    });
    harness.context.__fallbackLimiterRestores = 0;
    vm.runInContext(`
        RateLimitManager = class {
            constructor() { this.totalRequests = 0; }
            onStatusChange() {}
            restoreState() { __fallbackLimiterRestores += 1; }
            getState() { return { requestCount: 0, totalRequests: 0 }; }
        };
        launchExportLoop = () => {};
    `, harness.context);

    const result = await vm.runInContext('resumePostsOnly()', harness.context);
    assert.equal(result.success, true);
    const saved = harness.getSavedState();
    assert.equal(saved.settings.profileFeed, 'legacy_posts',
        'Posts-only fallback must switch only the current export snapshot to UserTweets');
    assert.equal(saved.settings.includeReplies, undefined,
        'the legacy Include replies flag must be migrated out of the export snapshot');
    
    assert.equal(saved.settings.includeRetweets, false);
    assert.equal(saved.settings.includeArticles, true);
    assert.equal(saved.settings.quantityLimit, 500,
        'fallback must preserve the original quantity target');
    assert.equal(saved.outputFormat, 'xlsx');
    assert.equal(saved.cursor, null, 'switching endpoints must reset the Replies cursor');
    assert.equal(saved.partialReason, 'replies_unavailable');
    assert.equal(harness.context.__fallbackLimiterRestores, 0,
        'UserTweets must start with its own endpoint budget and request counters');
}

async function testAllFeedKeepsOnlyProfilePostsAndContext() {
    const harness = createWorkerHarness();
    const parserContext = vm.createContext({
        console,
        XLog: { log() {}, warn() {}, error() {}, info() {} }
    });
    vm.runInContext(source('utils/api-parsers.js'), parserContext, {
        filename: 'utils/api-parsers.js'
    });
    parserContext.__payload = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [{
                                type: 'TimelineAddToModule',
                                moduleItems: [{
                                    entryId: 'conversationthread-root-150',
                                    item: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    legacy: {
                                                        id_str: '150',
                                                        full_text: 'Thread root from the exported profile',
                                                        conversation_id_str: '150'
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                core: {
                                                                    name: 'Target',
                                                                    screen_name: 'TargetUser'
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }, {
                                    entryId: 'tweet-100',
                                    item: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    legacy: {
                                                        id_str: '100',
                                                        full_text: 'Alex comments on the watermark announcement',
                                                        created_at: 'Tue Jul 07 11:00:00 +0000 2026'
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                core: {
                                                                    name: 'Alex',
                                                                    screen_name: 'OtherUser'
                                                                }
                                                            }
                                                        }
                                                    },
                                                    quoted_status_result: {
                                                        result: {
                                                            legacy: {
                                                                id_str: '90',
                                                                full_text: 'Claude models will now have invisible watermarks'
                                                            },
                                                            core: {
                                                                user_results: {
                                                                    result: {
                                                                        core: {
                                                                            name: 'NIK',
                                                                            screen_name: 'nik'
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }, {
                                    entryId: 'tweet-200',
                                    item: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    legacy: {
                                                        id_str: '200',
                                                        full_text: 'My reply to Alex',
                                                        in_reply_to_status_id_str: '100',
                                                        in_reply_to_screen_name: 'OtherUser',
                                                        conversation_id_str: '100'
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                core: {
                                                                    name: 'Target',
                                                                    screen_name: 'TargetUser'
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }, {
                                    entryId: 'conversationthread-continuation-250',
                                    item: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    legacy: {
                                                        id_str: '250',
                                                        full_text: 'Second author reply in the same thread',
                                                        in_reply_to_status_id_str: '200',
                                                        in_reply_to_screen_name: 'TargetUser',
                                                        conversation_id_str: '100'
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                core: {
                                                                    name: 'Target',
                                                                    screen_name: 'TargetUser'
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }, {
                                    entryId: 'tweet-300',
                                    item: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    legacy: {
                                                        id_str: '300',
                                                        full_text: 'Unrelated foreign conversation row'
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                core: {
                                                                    name: 'Bystander',
                                                                    screen_name: 'Bystander'
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }]
                            }]
                        }
                    }
                }
            }
        }
    };
    const parsedTimeline = vm.runInContext(
        'XPorterApiParsers.parseTimelineResponse(__payload)',
        parserContext
    );
    let fetchArgs = null;
    let fetchCalls = 0;
    harness.context.XPorterAPI.fetchUserTweets = async (...args) => {
        fetchCalls += 1;
        fetchArgs = args;
        return {
            tweets: parsedTimeline.tweets,
            nextCursor: null
        };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'targetuser',
            userId: '10',
            exportMode: 'posts',
            outputFormat: 'csv',
            userInfo: { screenName: 'TargetUser', tweetCount: 3 },
            settings: { includeRetweets: true, profileFeed: 'all', includeArticles: true, quantityLimit: 500 },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        _fetchPostsLoop();
    `, harness.context);

    assert.equal(fetchArgs[3], 'all', 'the saved All feed must reach the API request');
    assert.equal(fetchCalls, 1, 'All must use one timeline, not a second hidden pass');
    const savedItems = harness.getSavedBatches().flat();
    assert.deepEqual(
        savedItems.map(item => item.id),
        ['150', '200', '250'],
        'All must keep every author row from a conversation module and drop unrelated foreign rows'
    );
    assert.equal(savedItems[1].reply_to_post.id, '100',
        'the filtered foreign parent must remain attached to the profile reply');
    assert.equal(savedItems[1].reply_to_post.author_username, 'OtherUser');
    assert.equal(savedItems[1].reply_to_post.quoted_post.id, '90',
        'a quote nested inside the replied-to post must remain attached as context');
    assert.equal(savedItems[1].reply_to_post.quoted_post.author_username, 'nik');
    assert.equal(savedItems[2].reply_to_post.id, '200',
        'a later self-reply must retain the preceding author post as thread context');
    assert.equal(
        vm.runInContext("rateLimitKeyForMode('posts', { profileFeed: 'all' })", harness.context),
        'UserTweets',
        'adaptive pacing must read the quota for the endpoint actually in use'
    );
    assert.equal(
        vm.runInContext("rateLimitKeyForMode('posts', { profileFeed: 'posts' })", harness.context),
        'UserOriginalsTimeline',
        'Posts must pace against its own redesigned endpoint budget'
    );

    const repliesHarness = createWorkerHarness();
    let repliesFetchArgs = null;
    repliesHarness.context.XPorterAPI.fetchUserTweets = async (...args) => {
        repliesFetchArgs = args;
        return {
            tweets: parsedTimeline.tweets,
            nextCursor: null
        };
    };
    repliesHarness.context.__makeRateLimiter = harness.context.__makeRateLimiter;

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'targetuser',
            userId: '10',
            exportMode: 'posts',
            outputFormat: 'csv',
            userInfo: { screenName: 'TargetUser', tweetCount: 3 },
            settings: { includeRetweets: true, profileFeed: 'replies', includeArticles: true, quantityLimit: 500 },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        _fetchPostsLoop();
    `, repliesHarness.context);

    assert.equal(repliesFetchArgs[3], 'replies',
        'the saved Replies feed must reach the current profile Replies API');
    const savedReplies = repliesHarness.getSavedBatches().flat();
    assert.deepEqual(
        savedReplies.map(item => item.id),
        ['200', '250'],
        'Replies must keep only target-author replies and drop roots plus foreign context rows'
    );
    assert.equal(savedReplies[0].reply_to_post.id, '100',
        'Replies must preserve the filtered foreign parent as nested context');
    assert.equal(savedReplies[1].reply_to_post.id, '200',
        'Replies must preserve a preceding author reply as nested thread context');
    assert.equal(
        vm.runInContext("rateLimitKeyForMode('posts', { profileFeed: 'replies' })", repliesHarness.context),
        'UserRepliesTimeline',
        'Replies must pace against the endpoint actually in use'
    );
}

async function testExplicitPostTypeSelectionPlansAndCombinesFeeds() {
    const helperHarness = createWorkerHarness();
    const plan = (settings) => JSON.parse(JSON.stringify(
        vm.runInContext(`postFeedPlanForSettings(${JSON.stringify(settings)})`, helperHarness.context)
    ));

    assert.deepEqual(plan({
        postSelectionVersion: 1,
        includeOriginalPosts: false,
        includeQuotes: true,
        includeReplies: false,
        includeRetweets: false,
        includeArticles: false
    }), ['posts'], 'quotes-only must use the originals timeline and filter locally');
    assert.deepEqual(plan({
        postSelectionVersion: 1,
        includeOriginalPosts: false,
        includeQuotes: false,
        includeReplies: true,
        includeRetweets: false,
        includeArticles: false
    }), ['replies'], 'replies-only must use the current Replies timeline');
    assert.deepEqual(plan({
        postSelectionVersion: 1,
        includeOriginalPosts: true,
        includeQuotes: true,
        includeReplies: true,
        includeRetweets: false,
        includeArticles: false
    }), ['posts', 'replies'],
    'originals/quotes plus replies must combine the two native X timelines');
    assert.deepEqual(plan({
        postSelectionVersion: 1,
        includeOriginalPosts: true,
        includeQuotes: false,
        includeReplies: false,
        includeRetweets: true,
        includeArticles: false
    }), ['all'], 'reposts require the All timeline');
    assert.deepEqual(plan({
        postSelectionVersion: 1,
        includeOriginalPosts: false,
        includeQuotes: false,
        includeReplies: false,
        includeRetweets: false,
        includeArticles: false
    }), [], 'an empty menu selection must never start a hidden default feed');

    const selectionKeys = [
        'includeOriginalPosts',
        'includeQuotes',
        'includeReplies',
        'includeRetweets',
        'includeArticles'
    ];
    for (let mask = 1; mask < (1 << selectionKeys.length); mask += 1) {
        const settings = { postSelectionVersion: 1 };
        selectionKeys.forEach((key, index) => {
            settings[key] = Boolean(mask & (1 << index));
        });
        const expected = [];
        const hasNonReplies = settings.includeOriginalPosts ||
            settings.includeQuotes ||
            settings.includeRetweets ||
            settings.includeArticles;
        if (hasNonReplies) {
            expected.push(settings.includeRetweets ? 'all' : 'posts');
        }
        if (settings.includeReplies) expected.push('replies');
        assert.deepEqual(
            plan(settings),
            expected,
            `post selection combination ${mask.toString(2).padStart(selectionKeys.length, '0')} must use the exact feed plan`
        );
    }

    const harness = createWorkerHarness();
    const requestedFeeds = [];
    const rowsByFeed = {
        posts: [{
            id: 'original',
            type: 'tweet',
            author_username: 'TargetUser'
        }, {
            id: 'quote',
            type: 'quote',
            author_username: 'TargetUser'
        }, {
            id: 'article',
            type: 'article',
            author_username: 'TargetUser'
        }, {
            id: 'opportunistic-reply',
            type: 'reply',
            author_username: 'TargetUser'
        }],
        replies: [{
            id: 'reply',
            type: 'reply',
            author_username: 'TargetUser',
            reply_to_id: 'foreign-parent'
        }, {
            id: 'foreign-parent',
            type: 'tweet',
            author_username: 'OtherUser'
        }, {
            id: 'reply',
            type: 'reply',
            author_username: 'TargetUser'
        }]
    };
    harness.context.XPorterAPI.fetchUserTweets = async (_userId, _cursor, _count, feed) => {
        requestedFeeds.push(feed);
        return { tweets: rowsByFeed[feed], nextCursor: null };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        reconfigure() {},
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'targetuser',
            userId: '10',
            exportMode: 'posts',
            outputFormat: 'txt',
            userInfo: { screenName: 'TargetUser', tweetCount: 6 },
            settings: {
                postSelectionVersion: 1,
                includeOriginalPosts: true,
                includeQuotes: true,
                includeReplies: true,
                includeRetweets: false,
                includeArticles: false,
                quantityLimit: 3
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null,
            postFeedIndex: 0
        };
        rateLimiter = __makeRateLimiter();
        _fetchPostsLoop();
    `, harness.context);

    assert.deepEqual(requestedFeeds, ['posts', 'replies'],
        'a mixed selection must fetch each required native feed exactly once');
    assert.deepEqual(
        harness.getSavedBatches().flat().map(item => item.id),
        ['original', 'quote', 'reply'],
        'a small global limit must reserve room for both feeds while exact filters remove foreign rows'
    );
    const saved = harness.getSavedState();
    assert.equal(saved.postFeedIndex, 1,
        'resume state must identify the feed whose cursor was last persisted');
}

async function testLiveQuantityChangeUpdatesMixedFeedBudget() {
    const harness = createWorkerHarness();
    const rowsByFeed = {
        posts: ['p1', 'p2', 'p3', 'p4'].map(id => ({
            id,
            type: 'tweet',
            author_username: 'TargetUser'
        })),
        replies: ['r1', 'r2', 'r3', 'r4'].map(id => ({
            id,
            type: 'reply',
            author_username: 'TargetUser'
        }))
    };
    let raised = false;
    harness.context.XPorterAPI.fetchUserTweets = async (_userId, _cursor, _count, feed) => {
        if (feed === 'posts' && !raised) {
            raised = true;
            await harness.context.handleMessage({
                type: 'SAVE_SETTINGS',
                settings: { quantityLimit: 8 }
            }, {});
        }
        return { tweets: rowsByFeed[feed], nextCursor: null };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        reconfigure() {},
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'targetuser',
            userId: '10',
            exportMode: 'posts',
            outputFormat: 'txt',
            userInfo: { screenName: 'TargetUser', tweetCount: 8 },
            settings: {
                postSelectionVersion: 1,
                includeOriginalPosts: true,
                includeQuotes: false,
                includeReplies: true,
                includeRetweets: false,
                includeArticles: false,
                quantityLimit: 4
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null,
            postFeedIndex: 0,
            limitOverride: 0
        };
        rateLimiter = __makeRateLimiter();
        _fetchPostsLoop();
    `, harness.context);

    assert.deepEqual(
        harness.getSavedBatches().flat().map(item => item.id),
        ['p1', 'p2', 'p3', 'p4', 'r1', 'r2', 'r3', 'r4'],
        'raising the live target must recalculate the current feed share instead of keeping its old smaller budget'
    );
}

async function testBookmarksModeSkipsUsernameResolutionAndKeepsEverySavedAuthor() {
    const harness = createWorkerHarness();
    let resolvedUsers = 0;
    let bookmarkRequests = 0;
    let parentRequests = 0;
    const openedTabs = [];
    harness.context.chrome.tabs.create = async (options) => {
        openedTabs.push(options);
        return { id: 77 };
    };
    harness.context.XPorterAPI.getUserByScreenName = async () => {
        resolvedUsers += 1;
        throw new Error('Bookmarks must not resolve a typed username');
    };
    harness.context.XPorterAPI.fetchBookmarks = async () => {
        bookmarkRequests += 1;
        return {
            tweets: [{
                id: '501',
                type: 'tweet',
                text: 'Saved from another author',
                author_name: 'Another author',
                author_username: 'another'
            }, {
                id: '502',
                type: 'reply',
                text: 'Saved reply',
                author_name: 'Reply author',
                author_username: 'reply_author',
                reply_to_id: '60000',
                reply_to_username: 'parent_author'
            }],
            nextCursor: null
        };
    };
    harness.context.XPorterAPI.fetchTweetsByIds = async (ids) => {
        parentRequests += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(ids)), ['60000']);
        return [{
            id: '60000',
            type: 'article',
            text: 'The full post answered by the bookmark',
            author_name: 'Parent author',
            author_username: 'parent_author',
            article_title: 'Parent Article',
            article_text: 'The available parent Article body.',
            article_url: 'https://x.com/parent_author/article/70000'
        }];
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        onStatusChange() {},
        getState() { return {}; }
    });
    vm.runInContext(`
        launchExportLoop = () => {};
        createRateLimiter = () => __makeRateLimiter();
        rateLimiter = __makeRateLimiter();
    `, harness.context);

    const started = await vm.runInContext(`_startExportInner({
        username: 'someone_else',
        exportMode: 'bookmarks',
        outputFormat: 'json'
    })`, harness.context);
    assert.equal(started.success, true);
    assert.equal(vm.runInContext('currentExport.username', harness.context), '',
        'a typed username must never become part of a personal bookmark export');
    assert.equal(vm.runInContext('currentExport.userId', harness.context), 'current-account',
        'Bookmarks must start from a viewer-owned sentinel instead of a profile lookup');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(openedTabs)), [{
        url: 'https://x.com/i/bookmarks',
        active: true
    }], 'starting Bookmarks must open the one viewer-owned bookmarks page');

    await vm.runInContext(`
        currentExport.running = true;
        currentExport.status = 'fetching';
        currentExport.tweetCount = 0;
        currentExport.totalBatches = 0;
        currentExport.tweetBuffer = [];
        currentExport.cursor = null;
        currentExport.settings.includeBookmarkReplyContext = true;
        rateLimiter = __makeRateLimiter();
        bookmarkContextRateLimiter = __makeRateLimiter();
        _fetchBookmarksLoop();
    `, harness.context);
    assert.equal(resolvedUsers, 0);
    assert.equal(bookmarkRequests, 1);
    assert.equal(parentRequests, 1,
        'all reply parents from one Bookmarks page must use one bulk request');
    assert.deepEqual(
        harness.getSavedBatches().flat().map(item => item.id),
        ['501', '502'],
        'all bookmarked posts count as primary rows regardless of author or post type'
    );
    const savedReply = harness.getSavedBatches().flat()[1];
    assert.equal(savedReply.reply_to_post.id, '60000');
    assert.equal(savedReply.reply_to_post.author_username, 'parent_author');
    assert.equal(savedReply.reply_to_post.article_title, 'Parent Article');
    assert.equal(savedReply.reply_to_post.article_text, 'The available parent Article body.');
    assert.equal(
        vm.runInContext("rateLimitKeyForMode('bookmarks', {})", harness.context),
        'Bookmarks'
    );
}

async function testBookmarkArticleSettingRemovesOnlyArticlePayload() {
    const harness = createWorkerHarness();
    harness.context.XPorterAPI.fetchBookmarks = async () => ({
        tweets: [{
            id: '701',
            type: 'article',
            text: 'Saved Article seed',
            article_title: 'Top-level title',
            article_text: 'Top-level body',
            article_url: 'https://x.com/writer/article/701'
        }, {
            id: '702',
            type: 'quote',
            text: 'Comment on an Article',
            quoted_post: {
                id: '703',
                type: 'article',
                text: 'Quoted seed',
                article_title: 'Quoted title',
                article_text: 'Quoted body',
                article_url: 'https://x.com/writer/article/703'
            }
        }],
        nextCursor: null
    });
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            exportMode: 'bookmarks',
            settings: {
                includeBookmarkReplyContext: false,
                includeBookmarkArticles: false,
                quantityLimit: 500
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        _fetchBookmarksLoop();
    `, harness.context);

    const saved = harness.getSavedBatches().flat();
    assert.deepEqual(saved.map((item) => item.id), ['701', '702'],
        'disabling Article text must not remove bookmarked rows');
    assert.equal(saved[0].type, 'article');
    assert.equal(saved[0].article_title, '');
    assert.equal(saved[0].article_text, '');
    assert.equal(saved[0].article_url, '');
    assert.equal(saved[1].quoted_post.article_title, '');
    assert.equal(saved[1].quoted_post.article_text, '');
    assert.equal(saved[1].quoted_post.article_url, '');
}

async function testSearchCaptureIsArmedBeforeNavigation() {
    const harness = createWorkerHarness();
    let createOptions = null;
    let updateOptions = null;
    let armedBeforeNavigation = false;
    let relayResult = null;

    harness.context.__searchRelayMessage = {
        operationName: 'SearchTimeline',
        url: 'https://x.com/i/api/graphql/test/SearchTimeline?variables=%7B%7D',
        status: 200,
        bodyText: '{}'
    };
    harness.context.__searchRelaySender = { tab: { id: 42 } };

    harness.context.chrome.tabs.create = async (options) => {
        createOptions = options;
        return { id: 42 };
    };
    harness.context.chrome.tabs.update = async (tabId, options) => {
        assert.equal(tabId, 42);
        updateOptions = options;
        armedBeforeNavigation = vm.runInContext('searchCapture?.tabId === 42', harness.context);
        relayResult = vm.runInContext(
            'handlePageGraphqlResponse(__searchRelayMessage, __searchRelaySender)',
            harness.context
        );
    };

    await vm.runInContext("openSearchCaptureTab('(from:test) since:2026-01-01')", harness.context);
    assert.deepEqual(JSON.parse(JSON.stringify(createOptions)), { url: 'about:blank', active: true });
    assert.equal(armedBeforeNavigation, true,
        'capture state must exist before X can emit its first SearchTimeline response');
    assert.equal(relayResult?.success, true,
        'a SearchTimeline relay emitted during navigation must be queued, not ignored');
    assert.equal(vm.runInContext('searchCapture.queue.length', harness.context), 1);
    assert.match(updateOptions.url, /^https:\/\/x\.com\/search\?/);
    await vm.runInContext('closeSearchCaptureTab()', harness.context);
}

async function testUnexpectedEmptyUserListDoesNotComplete() {
    const harness = createWorkerHarness();
    let fetchCalls = 0;
    const fetchEmptyList = async () => {
        fetchCalls += 1;
        return { users: [], nextCursor: null };
    };
    harness.context.XPorterAPI.fetchFollowers = fetchEmptyList;
    harness.context.XPorterAPI.fetchFollowing = fetchEmptyList;
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    vm.runInContext(`
        currentExport = {
            running: true,
            username: 'has-followers',
            exportMode: 'followers',
            outputFormat: 'csv',
            userInfo: { followersCount: 12 },
            settings: { quantityLimit: 500 },
            tweetCount: 0,
            itemsRecordedBase: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
    `, harness.context);
    await assert.rejects(
        vm.runInContext('_fetchUsersLoop()', harness.context),
        /MAX_RETRIES_EXCEEDED/,
        'an unexpectedly empty first page must not become a successful export'
    );
    assert.equal(fetchCalls, 3, 'unexpected empty first pages should be retried');

    fetchCalls = 0;
    vm.runInContext(`
        currentExport.exportMode = 'following';
        currentExport.userInfo = { followingCount: null };
        currentExport.cursor = null;
        rateLimiter = __makeRateLimiter();
    `, harness.context);
    await assert.rejects(
        vm.runInContext('_fetchUsersLoop()', harness.context),
        /MAX_RETRIES_EXCEEDED/,
        'a missing profile counter must not be mistaken for a confirmed empty list'
    );
    assert.equal(fetchCalls, 3, 'unknown list counts should keep the empty-page guard active');

    fetchCalls = 0;
    vm.runInContext(`
        currentExport.exportMode = 'followers';
        currentExport.userInfo = { followersCount: 0 };
        currentExport.cursor = null;
        rateLimiter = __makeRateLimiter();
    `, harness.context);
    await vm.runInContext('_fetchUsersLoop()', harness.context);
    assert.equal(fetchCalls, 1, 'a genuinely empty profile should still finish normally');
}

async function testUserListAboutDetailsAreOptInAndCached() {
    const fastHarness = createWorkerHarness();
    let fastAboutCalls = 0;
    fastHarness.context.XPorterAPI.fetchFollowing = async () => ({
        users: [{ id: '1', username: 'first', location: 'Berlin' }],
        nextCursor: null
    });
    fastHarness.context.XPorterAPI.getAccountAbout = async () => {
        fastAboutCalls += 1;
        return { accountBasedIn: 'Germany' };
    };
    fastHarness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });
    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'target',
            userId: '10',
            exportMode: 'following',
            outputFormat: 'csv',
            userInfo: { screenName: 'target', followingCount: 1 },
            settings: { quantityLimit: 500, includeAboutAccountDetails: false },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        aboutRateLimiter = __makeRateLimiter();
        _fetchUsersLoop();
    `, fastHarness.context);
    assert.equal(fastAboutCalls, 0,
        'the default user-list mode must not send per-user AboutAccountQuery requests');
    assert.equal(
        Object.hasOwn(fastHarness.getSavedBatches().flat()[0], 'account_based_in'),
        false,
        'the default user-list rows must remain unchanged'
    );

    const detailedHarness = createWorkerHarness();
    const now = Date.now();
    detailedHarness.setAboutAccountCache({
        '1': {
            cachedAt: now,
            data: {
                accountBasedIn: 'Canada',
                locationAccurate: true,
                accountSource: 'Canada App Store',
                premiumSince: '2025-10-01T00:00:00.000Z',
                usernameChangeCount: 2,
                usernameLastChangedAt: '2023-09-01T00:00:00.000Z'
            }
        }
    });
    const detailedAboutCalls = [];
    detailedHarness.context.XPorterAPI.fetchFollowing = async () => ({
        users: [
            { id: '1', username: 'cached_user', location: 'Toronto' },
            { id: '2', username: 'fresh_user', location: '' }
        ],
        nextCursor: null
    });
    detailedHarness.context.XPorterAPI.getAccountAbout = async username => {
        detailedAboutCalls.push(username);
        return {
            accountBasedIn: 'United States',
            locationAccurate: false,
            accountSource: 'Web',
            affiliateUsername: 'ExampleOrg',
            premiumSince: '',
            usernameChangeCount: 0,
            usernameLastChangedAt: ''
        };
    };
    detailedHarness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });
    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'target',
            userId: '10',
            exportMode: 'following',
            outputFormat: 'xlsx',
            userInfo: { screenName: 'target', followingCount: 2 },
            settings: { quantityLimit: 500, includeAboutAccountDetails: true },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        aboutRateLimiter = __makeRateLimiter();
        _fetchUsersLoop();
    `, detailedHarness.context);

    assert.deepEqual(detailedAboutCalls, ['fresh_user'],
        'a fresh cache hit must avoid repeating the per-user About request');
    const detailedRows = detailedHarness.getSavedBatches().flat();
    assert.deepEqual(
        detailedRows.map(row => ({
            id: row.id,
            country: row.account_based_in,
            accurate: row.account_location_accurate,
            source: row.account_source,
            changes: row.username_change_count
        })),
        [
            { id: '1', country: 'Canada', accurate: true, source: 'Canada App Store', changes: 2 },
            { id: '2', country: 'United States', accurate: false, source: 'Web', changes: 0 }
        ]
    );
    assert.equal(detailedRows[1].affiliate_username, 'ExampleOrg');
    assert.equal(Object.hasOwn(detailedHarness.getAboutAccountCache(), '2'), true,
        'new About results must be persisted for later exports and resumes');
}

async function testAboutAccountDetailsUseSelectedBatchConcurrency() {
    const harness = createWorkerHarness();
    const users = Array.from({ length: 12 }, (_, index) => ({
        id: String(index + 1),
        username: `user_${index + 1}`,
        location: ''
    }));
    let active = 0;
    let maxActive = 0;
    let batchCalls = 0;

    harness.context.XPorterAPI.fetchFollowing = async () => ({
        users,
        nextCursor: null
    });
    harness.context.XPorterAPI.getAccountAbout = async username => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return { accountBasedIn: username };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            batchCalls += 1;
            return request();
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'target',
            userId: '10',
            exportMode: 'following',
            outputFormat: 'xlsx',
            userInfo: { screenName: 'target', followingCount: 12 },
            settings: {
                quantityLimit: 500,
                includeAboutAccountDetails: true,
                aboutAccountSpeed: 'standard'
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        aboutRateLimiter = __makeRateLimiter();
        _fetchUsersLoop();
    `, harness.context);

    assert.equal(vm.runInContext(
        `resolveAboutAccountBatchSize({ aboutAccountSpeed: 'turtle' })`,
        harness.context
    ), 1);
    assert.equal(vm.runInContext(
        `resolveAboutAccountBatchSize({ aboutAccountSpeed: 'careful' })`,
        harness.context
    ), 3);
    assert.equal(vm.runInContext(
        `resolveAboutAccountBatchSize({ aboutAccountSpeed: 'standard' })`,
        harness.context
    ), 5);
    assert.equal(vm.runInContext(
        `resolveAboutAccountBatchSize({ aboutAccountSpeed: 'fast' })`,
        harness.context
    ), 10);
    assert.equal(vm.runInContext(
        `resolveAboutAccountBatchSize({ aboutAccountSpeed: 'turbo' })`,
        harness.context
    ), 20);
    assert.equal(vm.runInContext(
        `resolveAboutAccountBatchSize({
            aboutAccountSpeed: 'custom',
            aboutAccountCustomBatchSize: 999
        })`,
        harness.context
    ), 50, 'Custom concurrency must be clamped to its safe maximum');

    assert.equal(batchCalls, 4,
        'one list request plus three paced About batches should be issued for 12 users at Standard 5');
    assert.equal(maxActive, 5,
        'Standard must run at most five About requests concurrently');
    assert.deepEqual(
        harness.getSavedBatches().flat().map(row => row.account_based_in),
        users.map(user => user.username),
        'batched enrichment must preserve user-list order'
    );
}

async function testAboutAccountDetailsCommitEachFinishedBatchImmediately() {
    const harness = createWorkerHarness();
    const users = Array.from({ length: 6 }, (_, index) => ({
        id: String(index + 1),
        username: `user_${index + 1}`,
        location: ''
    }));
    let releaseLastUser;
    const lastUserBlocked = new Promise(resolve => {
        releaseLastUser = resolve;
    });

    harness.context.XPorterAPI.fetchFollowing = async () => ({
        users,
        nextCursor: null
    });
    harness.context.XPorterAPI.getAccountAbout = async username => {
        if (username === 'user_6') await lastUserBlocked;
        return { accountBasedIn: username };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    harness.context.__exportPromise = vm.runInContext(`
        currentExport = {
            running: true,
            username: 'target',
            userId: '10',
            exportMode: 'following',
            outputFormat: 'xlsx',
            userInfo: { screenName: 'target', followingCount: 6 },
            settings: {
                quantityLimit: 500,
                includeAboutAccountDetails: true,
                aboutAccountSpeed: 'standard'
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null
        };
        rateLimiter = __makeRateLimiter();
        aboutRateLimiter = __makeRateLimiter();
        _fetchUsersLoop();
    `, harness.context);

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(
        vm.runInContext('currentExport.tweetCount', harness.context),
        5,
        'the first finished About batch must update progress before a later batch completes'
    );
    assert.equal(
        vm.runInContext('currentExport.tweetBuffer.length', harness.context),
        5,
        'the first finished About batch must enter the export buffer immediately'
    );

    releaseLastUser();
    await harness.context.__exportPromise;
    assert.equal(harness.getSavedBatches().flat().length, 6);
}

async function testAboutAccountSpeedChangesApplyToTheNextBatch() {
    const harness = createWorkerHarness();
    const users = Array.from({ length: 12 }, (_, index) => ({
        id: String(index + 1),
        username: `user_${index + 1}`
    }));
    harness.context.__users = users;
    harness.context.__batchSizes = [];
    harness.context.XPorterAPI.getAccountAbout = async username => ({
        accountBasedIn: username
    });
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            exportMode: 'following',
            settings: {
                includeAboutAccountDetails: true,
                aboutAccountSpeed: 'turtle'
            }
        };
        aboutAccountCache = {};
        aboutRateLimiter = __makeRateLimiter();
        enrichUsersWithAboutDetails(__users, async finishedBatch => {
            __batchSizes.push(finishedBatch.length);
            if (__batchSizes.length === 1) {
                currentExport.settings.aboutAccountSpeed = 'standard';
            }
        });
    `, harness.context);

    assert.deepEqual(
        Array.from(harness.context.__batchSizes),
        [1, 5, 5, 1],
        'changing Turtle to Standard must resize the next About batch without restarting'
    );
}

async function testAboutAccountCacheExpiresAndStaysBounded() {
    const now = Date.now();
    const storage = {
        xporter_about_account_cache: {
            fresh: { cachedAt: now - 100, data: { accountBasedIn: 'Canada' } },
            expired: { cachedAt: now - 2000, data: { accountBasedIn: 'Germany' } },
            recentFailure: { cachedAt: now - 50, failed: true, data: {} },
            oldFailure: { cachedAt: now - 500, failed: true, data: {} }
        }
    };
    const context = vm.createContext({
        console,
        Date,
        crypto: { randomUUID: () => 'uuid' },
        XPORTER_CONFIG: {
            TWEETS_PER_BATCH: 50,
            ABOUT_ACCOUNT_CACHE_TTL: 1000,
            ABOUT_ACCOUNT_FAILURE_CACHE_TTL: 100,
            ABOUT_ACCOUNT_CACHE_MAX_ENTRIES: 2
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        chrome: {
            runtime: { getManifest: () => ({ permissions: ['unlimitedStorage'] }) },
            storage: {
                local: {
                    QUOTA_BYTES: 10_000_000,
                    async get(key) {
                        if (key === null) return { ...storage };
                        if (Array.isArray(key)) {
                            return Object.fromEntries(key.map(item => [item, storage[item]]));
                        }
                        return { [key]: storage[key] };
                    },
                    async set(values) { Object.assign(storage, values); },
                    async getBytesInUse() { return 0; }
                }
            }
        }
    });
    vm.runInContext(source('utils/storage.js'), context, { filename: 'utils/storage.js' });

    const loaded = await context.XPorterStorage.loadAboutAccountCache();
    assert.deepEqual(Object.keys(loaded).sort(), ['fresh', 'recentFailure']);

    await context.XPorterStorage.saveAboutAccountCache({
        oldest: { cachedAt: now - 3, data: {} },
        middle: { cachedAt: now - 2, data: {} },
        newest: { cachedAt: now - 1, data: {} }
    });
    assert.deepEqual(
        Object.keys(storage.xporter_about_account_cache),
        ['newest', 'middle'],
        'the persistent cache must cap its size by keeping the newest entries'
    );
}

async function testProfileFeedDefaultsAndMigratesLegacyReplySetting() {
    const createSettingsHarness = (savedSettings) => {
        const storage = { xporter_settings: savedSettings };
        const context = vm.createContext({
            console,
            Date,
            crypto: { randomUUID: () => 'uuid' },
            XPORTER_CONFIG: { TWEETS_PER_BATCH: 50 },
            XLog: { log() {}, warn() {}, error() {}, info() {} },
            chrome: {
                runtime: { getManifest: () => ({ permissions: ['unlimitedStorage'] }) },
                storage: {
                    local: {
                        QUOTA_BYTES: 10_000_000,
                        async get(key) {
                            if (key === null) return { ...storage };
                            return { [key]: storage[key] };
                        },
                        async set(values) { Object.assign(storage, values); },
                        async getBytesInUse() { return 0; }
                    }
                }
            }
        });
        vm.runInContext(source('utils/storage.js'), context, { filename: 'utils/storage.js' });
        return { context, storage };
    };

    const fresh = await createSettingsHarness({}).context.XPorterStorage.loadSettings();
    assert.deepEqual(
        {
            originals: fresh.includeOriginalPosts,
            quotes: fresh.includeQuotes,
            replies: fresh.includeReplies,
            reposts: fresh.includeRetweets,
            articles: fresh.includeArticles
        },
        { originals: true, quotes: true, replies: true, reposts: true, articles: true },
        'fresh installs must start with every explicit post type selected'
    );
    assert.equal(Object.hasOwn(fresh, 'profileFeed'), false,
        'runtime settings must not expose the obsolete profile-feed model');

    const formerPostsOnly =
        await createSettingsHarness({ includeReplies: false }).context.XPorterStorage.loadSettings();
    assert.equal(formerPostsOnly.includeOriginalPosts, true);
    assert.equal(formerPostsOnly.includeQuotes, true);
    assert.equal(formerPostsOnly.includeReplies, false,
        'an existing reply-off choice must migrate without enabling replies');

    const formerCombined =
        await createSettingsHarness({ includeReplies: true }).context.XPorterStorage.loadSettings();
    assert.equal(formerCombined.includeOriginalPosts, true);
    assert.equal(formerCombined.includeReplies, true,
        'an existing reply-on choice must migrate to originals plus replies');

    const explicit =
        await createSettingsHarness({ profileFeed: 'posts', includeReplies: true })
            .context.XPorterStorage.loadSettings();
    assert.equal(explicit.includeOriginalPosts, true);
    assert.equal(explicit.includeQuotes, true);
    assert.equal(explicit.includeReplies, false,
        'the newer Posts feed choice must win over the older reply toggle');

    const explicitReplies =
        await createSettingsHarness({ profileFeed: 'replies' })
            .context.XPorterStorage.loadSettings();
    assert.equal(explicitReplies.includeOriginalPosts, false);
    assert.equal(explicitReplies.includeQuotes, false);
    assert.equal(explicitReplies.includeReplies, true);
    assert.equal(explicitReplies.includeRetweets, false);
    assert.equal(explicitReplies.includeArticles, false,
        'the former Replies feed must migrate to a true replies-only selection');

    const savedMigration = createSettingsHarness({ includeReplies: false, language: 'ru' });
    await savedMigration.context.XPorterStorage.saveSettings({ theme: 'light' });
    assert.deepEqual(
        JSON.parse(JSON.stringify(savedMigration.storage.xporter_settings)),
        {
            language: 'ru',
            postSelectionVersion: 1,
            includeOriginalPosts: true,
            includeQuotes: true,
            includeReplies: false,
            includeRetweets: true,
            includeArticles: true,
            theme: 'light'
        },
        'the next settings write must persist explicit choices and remove obsolete keys'
    );
}

async function testUnknownFollowingCountCannotBecomeZeroRowSuccess() {
    const harness = createWorkerHarness();
    const broadcasts = [];
    let fetchCalls = 0;
    let targetAboutCalls = 0;
    let completedExports = 0;
    let failedExports = 0;

    harness.context.chrome.runtime.sendMessage = async message => {
        if (message?.type === 'EXPORT_STATUS_UPDATE') {
            broadcasts.push(JSON.parse(JSON.stringify(message)));
        }
        return {};
    };
    harness.context.XPorterAPI.getUserByScreenName = async () => ({
        id: '1890388644273258496',
        name: 'Ernesto Lopez',
        screenName: 'ErnestoSOFTWARE',
        isProtected: false,
        followingCount: null
    });
    harness.context.XPorterAPI.getAccountAbout = async () => {
        targetAboutCalls += 1;
        return {};
    };
    harness.context.XPorterAPI.fetchFollowing = async () => {
        fetchCalls += 1;
        return { users: [], nextCursor: null };
    };
    harness.context.XPorterStorage.recordExportComplete = async () => {
        completedExports += 1;
    };
    harness.context.XPorterStorage.recordExportError = async () => {
        failedExports += 1;
    };
    harness.context.__makeRateLimiter = () => ({
        requestCount: 0,
        totalRequests: 0,
        batchSize: 20,
        lastRequestAt: null,
        async executeWithRateLimit(request) {
            this.requestCount += 1;
            this.totalRequests += 1;
            return request();
        },
        getState() {
            return {
                requestCount: this.requestCount,
                totalRequests: this.totalRequests,
                lastRequestAt: this.lastRequestAt
            };
        }
    });

    vm.runInContext(`
        currentExport = {
            running: true,
            username: 'ErnestoSOFTWARE',
            exportMode: 'following',
            outputFormat: 'csv',
            settings: { quantityLimit: 500 },
            tweetCount: 0,
            itemsRecordedBase: 0,
            totalBatches: 0,
            tweetBuffer: [],
            userId: null,
            userInfo: null,
            cursor: null,
            startedAt: 1785236971507,
            status: 'resolving_user',
            completionReason: null
        };
        rateLimiter = __makeRateLimiter();
        launchExportLoop('Following regression:');
    `, harness.context);
    await vm.runInContext('exportLoopPromise', harness.context);

    const terminalState = harness.getSavedState();
    assert.equal(fetchCalls, 3,
        'an unknown list count must retry empty Following pages before failing');
    assert.equal(targetAboutCalls, 0,
        'user-list exports must not waste an About request on the list owner');
    assert.equal(terminalState.status, 'error');
    assert.equal(terminalState.error, 'MAX_RETRIES_EXCEEDED');
    assert.equal(terminalState.tweetCount, 0);
    assert.equal(completedExports, 0,
        'a zero-row Following failure must never be recorded as a successful export');
    assert.equal(failedExports, 1);
    assert.equal(harness.getSavedHistory(), null,
        'a zero-row Following failure must not create completed export history');
    assert.equal(
        broadcasts.some(message => message.status === 'complete'),
        false,
        'the popup must never receive a green complete state for this failure'
    );
    assert.equal(
        broadcasts.some(message =>
            message.status === 'error' &&
            message.error === 'MAX_RETRIES_EXCEEDED' &&
            message.tweetCount === 0),
        true,
        'the popup must receive an explicit terminal error instead'
    );
}

async function testResumeRunLoopPreservesLimiterAndCount() {
    const harness = createWorkerHarness();
    let userLookups = 0;
    const broadcasts = [];
    harness.context.chrome.runtime.sendMessage = async message => {
        if (message?.type === 'EXPORT_STATUS_UPDATE') {
            broadcasts.push(JSON.parse(JSON.stringify(message)));
        }
        return {};
    };
    harness.context.XPorterAPI.getUserByScreenName = async () => {
        userLookups += 1;
        return {
            id: '1',
            name: 'Resume User',
            screenName: 'resume-user',
            tweetCount: 50,
            isProtected: false
        };
    };
    harness.context.XPorterAPI.fetchUserTweets = async () => ({
        tweets: [{
            id: '6',
            text: 'resumed item',
            author_username: 'resume-user',
            tweet_url: 'https://x.com/resume-user/status/6'
        }],
        nextCursor: null
    });
    harness.context.__makeResumedLimiter = () => ({
        requestCount: 7,
        totalRequests: 7,
        lastRequestAt: 123,
        batchSize: 20,
        waitUntil: null,
        async executeWithRateLimit(request) {
            const result = await request();
            this.requestCount += 1;
            this.totalRequests += 1;
            this.lastRequestAt = 456;
            return result;
        },
        getState() {
            return {
                requestCount: this.requestCount,
                totalRequests: this.totalRequests,
                lastRequestAt: this.lastRequestAt
            };
        }
    });

    vm.runInContext(`
        currentExport = {
            running: true,
            username: 'resume-user',
            exportMode: 'posts',
            outputFormat: 'csv',
            settings: {
                quantityLimit: 10,
                includeReplies: false,
                includeRetweets: true,
                includeArticles: true
            },
            tweetCount: 5,
            itemsRecordedBase: 5,
            totalBatches: 0,
            tweetBuffer: [],
            userId: '1',
            userInfo: {
                id: '1',
                name: 'Resume User',
                screenName: 'resume-user',
                tweetCount: 50,
                isProtected: false
            },
            cursor: 'saved-cursor',
            startedAt: 100,
            status: 'fetching'
        };
        rateLimiter = __makeResumedLimiter();
    `, harness.context);

    await vm.runInContext('runExportLoop()', harness.context);
    assert.equal(userLookups, 0, 'resume with a saved user must not re-resolve and reset pacing');
    assert.equal(vm.runInContext('rateLimiter.totalRequests', harness.context), 8,
        'saved request counters must continue from their persisted value');
    const firstFetching = broadcasts.find(message => message.status === 'fetching');
    assert.equal(firstFetching?.tweetCount, 5,
        'resume must broadcast the already-collected count instead of flashing back to zero');
}

async function testFreshExportEnrichesProfileWithAccountRegion() {
    const harness = createWorkerHarness();
    let aboutLookups = 0;
    harness.context.XPorterAPI.getUserByScreenName = async () => ({
        id: '1',
        name: 'Region User',
        screenName: 'region-user',
        tweetCount: 1,
        isProtected: false
    });
    harness.context.XPorterAPI.getAccountAbout = async (username) => {
        aboutLookups += 1;
        assert.equal(username, 'region-user');
        return { accountBasedIn: 'Japan', locationAccurate: true };
    };
    harness.context.XPorterAPI.fetchUserTweets = async () => ({
        tweets: [{
            id: '1',
            text: 'hello',
            author_username: 'region-user',
            tweet_url: 'https://x.com/region-user/status/1'
        }],
        nextCursor: null
    });
    harness.context.__makeLimiter = () => ({
        requestCount: 0,
        totalRequests: 0,
        lastRequestAt: null,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.requestCount += 1;
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    vm.runInContext(`
        currentExport = {
            running: true,
            username: 'region-user',
            exportMode: 'posts',
            outputFormat: 'xlsx',
            settings: {
                quantityLimit: 10,
                includeReplies: false,
                includeRetweets: true,
                includeArticles: true
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            userId: null,
            userInfo: null,
            cursor: null,
            startedAt: 100,
            status: 'resolving_user'
        };
        rateLimiter = __makeLimiter();
    `, harness.context);

    await vm.runInContext('runExportLoop()', harness.context);

    assert.equal(aboutLookups, 1, 'a fresh export must resolve About this Account once');
    assert.equal(
        harness.getSavedState().userInfo.accountBasedIn,
        'Japan',
        'the persisted profile snapshot must retain Account Based In for later downloads'
    );
}

async function testLargeCompletionSkipsHistoryPayloadCopy() {
    const harness = createWorkerHarness();
    harness.context.XPORTER_CONFIG.EXPORT_HISTORY_DATA_LIMIT = 5000;
    await vm.runInContext(`
        currentExport = {
            username: 'large', exportMode: 'followers', outputFormat: 'csv',
            tweetCount: 3124700, completedAt: 123,
            userInfo: { name: 'Large Account', screenName: 'large' }
        };
        saveCompletedExportHistory();
    `, harness.context);

    assert.equal(harness.loadAllCalls(), 0,
        'large completion must not load every saved row just to duplicate it into history');
    assert.equal(harness.getSavedHistory().itemCount, 3124700);
    assert.equal(Object.hasOwn(harness.getSavedHistory(), 'items'), false,
        'large history entries should retain metadata without a duplicated payload');
}

function testCursorDedupMemoryIsBounded() {
    const harness = createWorkerHarness();
    const result = vm.runInContext(`
        (() => {
            const recent = createRecentIdTracker(new Set(['1', '2']), 3);
            const added = [recent.add('3'), recent.add('4'), recent.add('4'), recent.add('1')];
            return { size: recent.size, added };
        })()
    `, harness.context);
    assert.equal(result.size, 3, 'cursor exports must not retain every ID from a multi-million-row run');
    assert.deepEqual(Array.from(result.added), [true, true, false, true],
        'recent duplicates must be rejected while IDs outside the overlap window may be seen again');
}

async function testAboutRateLimitWaitSurvivesPopupReopen() {
    const harness = createWorkerHarness();
    const statuses = await vm.runInContext(`
        (async () => {
            const originalNow = Date.now;
            let now = 1000;
            Date.now = () => now;
            const until = 61000;
            currentExport = {
                running: true,
                username: 'rate-limited-user',
                exportMode: 'following',
                outputFormat: 'csv',
                settings: {
                    quantityLimit: 500,
                    includeAboutAccountDetails: true
                },
                tweetCount: 40,
                startedAt: Date.now(),
                status: 'fetching'
            };
            rateLimiter = { waitUntil: null };
            aboutRateLimiter = { waitUntil: until };
            lastTransientStatus = {
                running: true,
                status: 'rate_limited',
                retryIn: 60000,
                until,
                kind: 'window',
                attempt: 1
            };
            const first = await getExportStatus();
            now = 3000;
            const second = await getExportStatus();
            Date.now = originalNow;
            return [first, second];
        })()
    `, harness.context);
    const [status, polledStatus] = statuses;

    assert.equal(status.running, true);
    assert.equal(status.status, 'rate_limited',
        'reopening the popup during an About wait must restore the rate-limit pause');
    assert.equal(status.tweetCount, 40);
    assert(status.retryIn > 0 && status.retryIn <= 60000);
    assert.equal(status.duration, 60000,
        'status polling must preserve the original wait duration so the progress bar never restarts');
    assert.equal(status.until, 61000);
    assert.equal(polledStatus.retryIn, 58000);
    assert.equal(polledStatus.duration, 60000,
        'a later poll may shrink retryIn but must keep the original duration');
    assert.equal(polledStatus.until, 61000);
}

async function testExportSnapshotSurvivesWorkerRestart() {
    const harness = createWorkerHarness();
    harness.context.__testSettings = {
        includeRetweets: false,
        includeReplies: false,
        includeArticles: true,
        quantityLimit: 250,
        exportSpeed: 'careful'
    };
    await vm.runInContext(`
        currentExport = {
            username: 'test', exportMode: 'posts', outputFormat: 'csv',
            settings: __testSettings, tweetCount: 10, totalBatches: 1,
            running: false, status: 'stopped'
        };
        saveCurrentState();
    `, harness.context);

    assert.deepEqual(
        JSON.parse(JSON.stringify(harness.getSavedState().settings)),
        harness.context.__testSettings,
        'the per-export settings snapshot must be persisted'
    );
}

async function testResumeKeepsFiltersButFollowsCurrentPacing() {
    const harness = createWorkerHarness();
    const merged = vm.runInContext(`buildResumeSettings(
        { exportSpeed: 'turtle', customDelaySec: 9, includeRetweets: true,
          includeAboutAccountDetails: false, quantityLimit: 100 },
        { exportSpeed: 'turbo', includeRetweets: false,
          includeAboutAccountDetails: true, quantityLimit: 500 }
    )`, harness.context);
    assert.equal(merged.exportSpeed, 'turtle',
        'pacing must follow the user\'s current settings — slowing down is the rate-limit escape hatch');
    assert.equal(merged.customDelaySec, 9);
    assert.equal(merged.includeRetweets, false,
        'data filters must keep the export snapshot so resumed rows match collected rows');
    assert.equal(merged.includeAboutAccountDetails, true,
        'resume must keep the detailed user-list shape that produced the saved rows');
    assert.equal(merged.quantityLimit, 500,
        'the snapshot limit stays; raises go through limitOverride');
}

async function testSavedPacingChangesApplyToARunningExportOnly() {
    const harness = createWorkerHarness();
    harness.context.XPORTER_CONFIG.SPEED_PRESETS = {
        turbo: { adaptiveFloor: 2000 },
        standard: { adaptiveFloor: 4000 },
        turtle: { adaptiveFloor: 12000 }
    };
    const reconfigured = [];
    harness.context.__makeLiveLimiter = label => ({
        reconfigure(options) {
            reconfigured.push({
                label,
                adaptiveFloor: options.adaptiveFloor,
                safetyBreak: options.alwaysBatchCooldown === true,
                batchSize: options.batchSize,
                cooldownDuration: options.cooldownDuration
            });
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            exportMode: 'following',
            limitOverride: 0,
            tweetCount: 500,
            settings: {
                includeAboutAccountDetails: true,
                includeRetweets: false,
                quantityLimit: 500,
                exportSpeed: 'turtle',
                userExportSpeed: 'turtle',
                aboutAccountSpeed: 'turtle'
            }
        };
        rateLimiter = __makeLiveLimiter('list');
        aboutRateLimiter = __makeLiveLimiter('about');
        handleMessage({
            type: 'SAVE_SETTINGS',
            settings: {
                includeRetweets: true,
                quantityLimit: 1000,
                exportSpeed: 'turbo',
                userExportSpeed: 'turbo',
                aboutAccountSpeed: 'standard',
                userSafetyBreakEnabled: true,
                userSafetyBreakEvery: 25,
                userSafetyBreakMin: '1,5'
            }
        }, {});
    `, harness.context);

    const activeSettings = vm.runInContext('currentExport.settings', harness.context);
    assert.equal(activeSettings.userExportSpeed, 'turbo',
        'the next Followers/Following request must use the newly saved speed');
    assert.equal(activeSettings.aboutAccountSpeed, 'standard',
        'the next About batch must use the newly saved concurrency');
    assert.equal(activeSettings.userSafetyBreakEnabled, true,
        'scheduled breaks must apply live without restarting the user-list export');
    assert.equal(activeSettings.quantityLimit, 1000,
        'changing the configured quantity must immediately retarget an ordinary running export');
    assert.equal(vm.runInContext('quantityLimitReached()', harness.context), false,
        'raising a live target must allow the active export to continue');
    assert.equal(activeSettings.includeRetweets, false,
        'data-shape filters must stay frozen for the active export');
    assert.deepEqual(
        reconfigured,
        [
            {
                label: 'list',
                adaptiveFloor: 2000,
                safetyBreak: true,
                batchSize: 25,
                cooldownDuration: 90000
            },
            {
                label: 'about',
                adaptiveFloor: 2000,
                safetyBreak: true,
                batchSize: 25,
                cooldownDuration: 90000
            }
        ],
        'both active user-list limiters must receive the new pacing without being replaced'
    );

    await vm.runInContext(`
        handleMessage({
            type: 'SAVE_SETTINGS',
            settings: { quantityLimit: 300 }
        }, {});
    `, harness.context);
    assert.equal(vm.runInContext('quantityLimitReached()', harness.context), true,
        'lowering a live target below the collected count must stop at the next limit check');

    await vm.runInContext(`
        currentExport = {
            running: true,
            exportMode: 'posts',
            settings: {
                includeReplies: false,
                exportSpeed: 'turtle',
                userExportSpeed: 'standard'
            }
        };
        rateLimiter = __makeLiveLimiter('posts');
        aboutRateLimiter = null;
        handleMessage({
            type: 'SAVE_SETTINGS',
            settings: {
                includeReplies: true,
                exportSpeed: 'turbo'
            }
        }, {});
    `, harness.context);
    const postSettings = vm.runInContext('currentExport.settings', harness.context);
    assert.equal(postSettings.exportSpeed, 'turbo',
        'the next Posts request must use the newly saved speed');
    assert.equal(postSettings.includeReplies, false,
        'changing settings mid-export must not change the active Posts data shape');
    assert.deepEqual(reconfigured.at(-1), {
        label: 'posts',
        adaptiveFloor: 2000,
        safetyBreak: false,
        batchSize: undefined,
        cooldownDuration: undefined
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            exportMode: 'posts',
            limitOverride: 750,
            settings: {
                quantityLimit: 750,
                exportSpeed: 'standard'
            }
        };
        rateLimiter = __makeLiveLimiter('override');
        handleMessage({
            type: 'SAVE_SETTINGS',
            settings: {
                quantityLimit: 3200
            }
        }, {});
    `, harness.context);
    assert.equal(
        vm.runInContext('currentExport.settings.quantityLimit', harness.context),
        750,
        'an explicit per-run +N target must not be overwritten by later global quantity changes'
    );
}

function testPostsAndUserListsUseIndependentSpeedSettings() {
    const harness = createWorkerHarness();
    harness.context.XPORTER_CONFIG.SPEED_PRESETS = {
        turbo: { adaptiveFloor: 2000 },
        standard: { adaptiveFloor: 4000 },
        turtle: { adaptiveFloor: 12000 }
    };
    harness.context.XPORTER_CONFIG.CUSTOM_SPEED_LIMITS = {
        delaySec: [0.1, 120, 5],
        batch: [5, 100, 20],
        cooldownMin: [0.1, 30, 3]
    };
    const resolved = vm.runInContext(`({
        posts: createRateLimiter({
            exportSpeed: 'turbo',
            userExportSpeed: 'turtle'
        }, 'posts').adaptiveFloor,
        followers: createRateLimiter({
            exportSpeed: 'turbo',
            userExportSpeed: 'turtle'
        }, 'followers').adaptiveFloor,
        following: createRateLimiter({
            exportSpeed: 'turtle',
            userExportSpeed: 'turbo'
        }, 'following').adaptiveFloor,
        verifiedFollowers: createRateLimiter({
            exportSpeed: 'turtle',
            userExportSpeed: 'turbo'
        }, 'verified_followers').adaptiveFloor,
        aboutAccount: createRateLimiter({
            exportSpeed: 'turtle',
            userExportSpeed: 'turbo'
        }, 'about_account').adaptiveFloor,
        postCustom: resolveSpeedPreset({
            exportSpeed: 'custom',
            customDelaySec: 3,
            customBatchSize: 10,
            customCooldownMin: 2,
            userExportSpeed: 'custom',
            userCustomDelaySec: 17,
            userCustomBatchSize: 40,
            userCustomCooldownMin: 6
        }, 'posts'),
        userCustom: resolveSpeedPreset({
            exportSpeed: 'custom',
            customDelaySec: 3,
            customBatchSize: 10,
            customCooldownMin: 2,
            userExportSpeed: 'custom',
            userCustomDelaySec: 17,
            userCustomBatchSize: 40,
            userCustomCooldownMin: 6
        }, 'followers'),
        decimalCommaCustom: resolveSpeedPreset({
            exportSpeed: 'custom',
            customDelaySec: '0,5',
            customBatchSize: 7,
            customCooldownMin: '0,25'
        }, 'posts'),
        customWithoutAdaptive: (() => {
            const options = buildRateLimiterOptions({
                exportSpeed: 'custom',
                customDelaySec: '0,5',
                customBatchSize: 7,
                customCooldownMin: '0,25',
                adaptivePacing: false,
                requestDelay: 3000
            }, 'posts');
            return [options.fallbackMinDelay, options.fallbackMaxDelay];
        })(),
        postSafetyDisabled: buildRateLimiterOptions({
            exportSpeed: 'turbo',
            postSafetyBreakEnabled: false,
            postSafetyBreakMin: '2,5',
            postSafetyBreakEvery: 11
        }, 'posts'),
        postSafetyEnabled: buildRateLimiterOptions({
            exportSpeed: 'turbo',
            postSafetyBreakEnabled: true,
            postSafetyBreakMin: '2,5',
            postSafetyBreakEvery: 11
        }, 'bookmarks'),
        userSafetyEnabled: buildRateLimiterOptions({
            userExportSpeed: 'fast',
            userSafetyBreakEnabled: true,
            userSafetyBreakMin: '7,5',
            userSafetyBreakEvery: 33
        }, 'following')
    })`, harness.context);

    const plain = JSON.parse(JSON.stringify(resolved));
    assert.deepEqual({
        posts: plain.posts,
        followers: plain.followers,
        following: plain.following,
        verifiedFollowers: plain.verifiedFollowers,
        aboutAccount: plain.aboutAccount,
        postCustom: plain.postCustom,
        userCustom: plain.userCustom,
        decimalCommaCustom: plain.decimalCommaCustom,
        customWithoutAdaptive: plain.customWithoutAdaptive
    }, {
        posts: 2000,
        followers: 12000,
        following: 2000,
        verifiedFollowers: 2000,
        aboutAccount: 2000,
        postCustom: {
            adaptiveFloor: 3000,
            adaptivePad: 0,
            budgetFraction: 1,
            raceReserve: 2,
            customFallbackDelays: [3000, 3000]
        },
        userCustom: {
            adaptiveFloor: 17000,
            adaptivePad: 0,
            budgetFraction: 1,
            raceReserve: 2,
            customFallbackDelays: [17000, 17000]
        },
        decimalCommaCustom: {
            adaptiveFloor: 500,
            adaptivePad: 0,
            budgetFraction: 1,
            raceReserve: 2,
            customFallbackDelays: [500, 500]
        },
        customWithoutAdaptive: [500, 500]
    }, 'post exports and every user-list mode must resolve their own saved speed preset');
    assert.equal(plain.postSafetyDisabled.alwaysBatchCooldown, false,
        'scheduled breaks must be opt-in even when legacy batch values exist in a speed preset');
    assert.equal(plain.postSafetyEnabled.alwaysBatchCooldown, true);
    assert.equal(plain.postSafetyEnabled.batchSize, 11);
    assert.equal(plain.postSafetyEnabled.cooldownDuration, 150000,
        'posts/bookmarks scheduled breaks must accept fractional minutes with a comma');
    assert.equal(plain.userSafetyEnabled.alwaysBatchCooldown, true);
    assert.equal(plain.userSafetyEnabled.batchSize, 33);
    assert.equal(plain.userSafetyEnabled.cooldownDuration, 450000,
        'user-list scheduled breaks must be independent from posts/bookmarks');
}

function testAboutAccountRetriesAreConfigurable() {
    const harness = createWorkerHarness();
    harness.context.XPORTER_CONFIG.ABOUT_ACCOUNT_RETRY_RANGE = [1, 1440, 5];

    const retryOptions = vm.runInContext(`({
        defaultAbout: buildRateLimiterOptions({}, 'about_account').maxRetries,
        configuredAbout: buildRateLimiterOptions({
            aboutAccountMaxRetries: 60
        }, 'about_account').maxRetries,
        minimumAbout: buildRateLimiterOptions({
            aboutAccountMaxRetries: 0
        }, 'about_account').maxRetries,
        maximumAbout: buildRateLimiterOptions({
            aboutAccountMaxRetries: 9999
        }, 'about_account').maxRetries,
        ordinaryList: buildRateLimiterOptions({
            aboutAccountMaxRetries: 60
        }, 'followers').maxRetries
    })`, harness.context);

    assert.deepEqual(JSON.parse(JSON.stringify(retryOptions)), {
        defaultAbout: 5,
        configuredAbout: 60,
        minimumAbout: 1,
        maximumAbout: 1440
    }, 'only About requests must use the bounded retry setting');
}

async function testXlsxCellTruncationKeepsXmlValid() {
    const context = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    // 32,766 chars + an emoji: the 32,767 cut would otherwise strand half a
    // surrogate pair, which TextEncoder turns into U+FFFD garbage.
    const text = 'a'.repeat(32766) + '😀';
    const bytes = context.XPorterCSV.generateXLSX([{ id: '1', text }]);
    // Inspect only the worksheet XML (stored uncompressed): the ZIP's binary
    // headers legitimately decode to U+FFFD, the sheet text must not.
    const archiveText = new TextDecoder().decode(bytes);
    const sheetXml = archiveText.slice(archiveText.indexOf('<worksheet'), archiveText.indexOf('</worksheet>'));
    assert(sheetXml.length > 0, 'worksheet XML must be present');
    assert(!sheetXml.includes('�'), 'a truncated cell must not contain replacement characters');
}

async function testPersistedLimitOverrideIsReported() {
    const harness = createWorkerHarness();
    harness.setSavedState({
        username: 'test',
        exportMode: 'posts',
        outputFormat: 'csv',
        status: 'stopped',
        running: false,
        userId: '1',
        tweetCount: 500,
        limitOverride: 750,
        settings: { quantityLimit: 500 },
        updatedAt: Date.now()
    });

    const status = await vm.runInContext('currentExport = null; getExportStatus();', harness.context);
    assert.equal(status.quantityLimit, 750, 'status must show this export\'s overridden limit');
}

async function testStoppedResumeRejectsExtraQuantityOverride() {
    const harness = createWorkerHarness();
    harness.setSavedState({
        username: 'test',
        exportMode: 'posts',
        outputFormat: 'csv',
        status: 'stopped',
        running: false,
        userId: '1',
        userInfo: { id: '1', screenName: 'test' },
        tweetCount: 500,
        totalBatches: 10,
        cursor: 'saved-cursor',
        startedAt: 123,
        settings: {
            quantityLimit: 1000,
            includeReplies: false,
            exportSpeed: 'standard'
        }
    });
    vm.runInContext(`
        RateLimitManager = class {
            constructor() { this.totalRequests = 0; }
            onStatusChange() {}
            restoreState() {}
            getState() { return { requestCount: 0, totalRequests: 0 }; }
        };
        launchExportLoop = () => {};
    `, harness.context);

    const result = await vm.runInContext('_resumeExportInner(100)', harness.context);
    assert.equal(result.success, true);
    const resumed = harness.getSavedState();
    assert.equal(resumed.settings.quantityLimit, 1000,
        'stopped Resume must preserve the original target even if a caller sends extraItems');
    assert.equal(resumed.limitOverride, 0,
        'only a completed export may create a +N per-export limit override');
}

async function testTerminalExportActuallyExpires() {
    const harness = createWorkerHarness();
    harness.setSavedState({
        username: 'test',
        status: 'complete',
        running: false,
        tweetCount: 1,
        updatedAt: Date.now() - (5 * 60 * 60 * 1000)
    });
    const status = await vm.runInContext(`
        currentExport = {
            username: 'test', exportMode: 'posts', outputFormat: 'csv',
            settings: { quantityLimit: 500 }, tweetCount: 1,
            running: false, status: 'complete'
        };
        getExportStatus();
    `, harness.context);

    assert.equal(status.status, 'idle');
    assert.equal(harness.wasCleared(), true, 'expired terminal data must be cleared while the worker is alive');
}

async function testResumeRecordsFirstNewItem() {
    const harness = createWorkerHarness();
    vm.runInContext(`
        currentExport = { tweetCount: 500 };
        recordFirstItemOnce();
        recordFirstItemOnce();
    `, harness.context);
    assert.equal(
        harness.firstItemRecords(),
        1,
        'a resumed run must record latency for its first new item even when the saved count is non-zero'
    );
}

async function testStateWriteFailureIsTerminal() {
    const harness = createWorkerHarness();
    harness.setSaveStateSucceeds(false);
    await assert.rejects(
        vm.runInContext(`
            currentExport = {
                username: 'test', exportMode: 'posts', outputFormat: 'csv',
                settings: { quantityLimit: 500 }, tweetCount: 1, totalBatches: 0,
                running: true, status: 'fetching'
            };
            saveCurrentState();
        `, harness.context),
        /STORAGE_FULL/,
        'state persistence failures must stop the export instead of advancing with stale state'
    );
}

function testSavedDateRangeRowsAdvanceResumeCoverage() {
    const harness = createWorkerHarness();
    const coverage = vm.runInContext(`
        currentExport = {
            dateFrom: new Date('2026-01-01T00:00:00.000Z'),
            dateTo: new Date('2026-01-31T23:59:59.999Z'),
            settings: { quantityLimit: 500 },
            tweetCount: 244
        };
        searchCapture = { oldestCollectedMs: null };
        noteSearchTimelineCoverage({ created_at: '2026-01-02T12:00:00.000Z' });
        computeDateCoveragePct();
    `, harness.context);
    assert(coverage >= 95,
        'saved duplicate rows re-scanned on Resume must rebuild date coverage instead of looking stalled');
    const phase = vm.runInContext(`
        overlayPhase(
            { resumingFor: 'Checking saved progress for', posts: 'posts' },
            'resuming',
            'target',
            244
        )
    `, harness.context);
    assert.match(phase, /target.*244/,
        'date Resume must visibly count re-scanned saved rows instead of looking idle');
}

async function testRepeatedPostCursorTerminatesWithoutHanging() {
    const harness = createWorkerHarness();
    harness.getSavedBatches()[0] = [{ id: 'already-saved' }];
    let fetchCalls = 0;
    harness.context.XPorterAPI.fetchUserTweets = async () => {
        fetchCalls += 1;
        if (fetchCalls > 3) throw new Error('TEST_LOOP_OVERFLOW');
        return {
            tweets: [{
                id: 'already-saved',
                type: 'tweet',
                author_username: 'target'
            }],
            nextCursor: 'same-cursor'
        };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'target',
            userId: '10',
            exportMode: 'posts',
            outputFormat: 'csv',
            userInfo: { screenName: 'target', tweetCount: 1000 },
            settings: {
                includeRetweets: true,
                includeReplies: false,
                includeArticles: true,
                quantityLimit: 500
            },
            tweetCount: 244,
            totalBatches: 1,
            tweetBuffer: [],
            cursor: 'same-cursor'
        };
        rateLimiter = __makeRateLimiter();
        _fetchPostsLoop();
    `, harness.context);

    assert.equal(fetchCalls, 3,
        'a repeated cursor with no accepted rows must stop after a bounded number of retries');
    assert.equal(
        vm.runInContext('currentExport.completionReason', harness.context),
        'source_exhausted',
        'a bounded no-progress end must be explicit so the UI does not offer a useless Continue action'
    );
    assert.equal(vm.runInContext('currentExport.cursor', harness.context), null,
        'a terminal cursor must not be persisted as if it could continue');
}

async function testRepeatedUserListCursorTerminatesWithoutHanging() {
    const harness = createWorkerHarness();
    harness.getSavedBatches()[0] = [{ id: 'already-saved' }];
    let fetchCalls = 0;
    harness.context.XPorterAPI.fetchFollowing = async () => {
        fetchCalls += 1;
        if (fetchCalls > 3) throw new Error('TEST_LOOP_OVERFLOW');
        return {
            users: [{ id: 'already-saved', username: 'duplicate' }],
            nextCursor: 'same-cursor'
        };
    };
    harness.context.__makeRateLimiter = () => ({
        totalRequests: 0,
        batchSize: 20,
        async executeWithRateLimit(request) {
            this.totalRequests += 1;
            return request();
        },
        getState() { return {}; }
    });

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'target',
            userId: '10',
            exportMode: 'following',
            outputFormat: 'csv',
            userInfo: { screenName: 'target', followingCount: 1000 },
            settings: { quantityLimit: 500 },
            tweetCount: 244,
            totalBatches: 1,
            tweetBuffer: [],
            cursor: 'same-cursor'
        };
        rateLimiter = __makeRateLimiter();
        _fetchUsersLoop();
    `, harness.context);

    assert.equal(fetchCalls, 3,
        'a repeated user-list cursor with no accepted rows must stop after bounded retries');
    assert.equal(
        vm.runInContext('currentExport.completionReason', harness.context),
        'source_exhausted'
    );
    assert.equal(vm.runInContext('currentExport.cursor', harness.context), null);
}

function testTimelineModuleItemsAreParsed() {
    const context = vm.createContext({
        console,
        XLog: { log() {}, warn() {}, error() {}, info() {} }
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    context.__payload = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [{
                                type: 'TimelineAddToModule',
                                moduleItems: [{
                                    entryId: 'conversationthread-1',
                                    item: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    legacy: {
                                                        id_str: '9001',
                                                        full_text: 'deep timeline post'
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                core: {
                                                                    name: 'Target',
                                                                    screen_name: 'target'
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }]
                            }, {
                                type: 'TimelineReplaceEntry',
                                entry: {
                                    entryId: 'cursor-bottom-1',
                                    content: {
                                        __typename: 'TimelineTimelineCursor',
                                        cursorType: 'Bottom',
                                        value: 'next-deep-page'
                                    }
                                }
                            }]
                        }
                    }
                }
            }
        }
    };

    const parsed = vm.runInContext(
        'XPorterApiParsers.parseTimelineResponse(__payload)',
        context
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(parsed.tweets.map(tweet => tweet.id))),
        ['9001'],
        'TimelineAddToModule rows used by deep X timelines must not disappear'
    );
    assert.equal(parsed.nextCursor, 'next-deep-page');
}

function testTimelineV2UserListsAreParsed() {
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: {},
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {}
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    context.__payload = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [{
                                type: 'TimelineAddEntries',
                                entries: [{
                                    entryId: 'user-1',
                                    content: {
                                        itemContent: {
                                            user_results: {
                                                result: {
                                                    rest_id: '1',
                                                    core: { name: 'Test', screen_name: 'test' },
                                                    legacy: {}
                                                }
                                            }
                                        }
                                    }
                                }, {
                                    entryId: 'cursor-bottom-1',
                                    content: { value: 'next' }
                                }]
                            }]
                        }
                    }
                }
            }
        }
    };
    const result = vm.runInContext('XPorterApiParsers.parseFollowersResponse(__payload)', context);
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].username, 'test');
    assert.equal(result.nextCursor, 'next');

    const malformed = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: { full_text: 'missing id' }
    })`, context);
    assert.equal(malformed, null, 'malformed tweet rows without an id must be discarded');

    const authorless = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: { id_str: '12345', full_text: 'hello' }
    })`, context);
    assert.equal(
        authorless.tweet_url,
        'https://x.com/i/web/status/12345',
        'authorless payloads must still receive a valid canonical status URL'
    );

    const reply = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: {
            id_str: '222',
            full_text: 'reply body',
            in_reply_to_status_id_str: '111',
            in_reply_to_screen_name: 'parent_author',
            conversation_id_str: '111'
        },
        core: { user_results: { result: { core: { name: 'Writer', screen_name: 'writer' } } } }
    })`, context);
    assert.equal(reply.type, 'reply');
    assert.equal(reply.reply_to_id, '111');
    assert.equal(reply.reply_to_username, 'parent_author');
    assert.equal(reply.conversation_id, '111');
}

function testThemeInitializationCanRevertToDark() {
    const classes = new Set(['light']);
    const context = vm.createContext({
        document: {
            body: {
                classList: {
                    toggle(name, enabled) {
                        if (enabled) classes.add(name);
                        else classes.delete(name);
                    }
                }
            }
        }
    });
    vm.runInContext(source('popup/theme.js'), context, { filename: 'popup/theme.js' });
    context.__icon = { innerHTML: '' };
    const mode = vm.runInContext('initTheme("dark", __icon)', context);
    assert.equal(mode, 'dark');
    assert.equal(classes.has('light'), false, 'restoring dark must remove a previously applied light class');

    classes.add('light');
    const defaultMode = vm.runInContext('initTheme(undefined, __icon)', context);
    assert.equal(defaultMode, 'dark');
    assert.equal(classes.has('light'), false, 'missing saved theme must default to dark');
}

async function testContentScriptDetectsSignedInAccountFromXNavigation() {
    const messages = [];
    const switcher = {
        innerText: 'Lucas Strand\n@bylemelson',
        querySelector(selector) {
            return selector === 'img'
                ? { src: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg' }
                : null;
        }
    };
    const profileLink = {
        getAttribute(name) {
            return name === 'href' ? '/bylemelson' : null;
        }
    };
    const document = {
        documentElement: {},
        body: {},
        querySelector(selector) {
            if (selector.includes('SideNav_AccountSwitcher_Button')) return switcher;
            if (selector.includes('AppTabBar_Profile_Link')) return profileLink;
            return null;
        },
        addEventListener() {}
    };
    const window = {
        location: {
            pathname: '/i/bookmarks',
            href: 'https://x.com/i/bookmarks',
            origin: 'https://x.com'
        },
        addEventListener() {},
        postMessage() {}
    };
    const context = vm.createContext({
        console,
        URL,
        document,
        window,
        setTimeout,
        clearTimeout,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {}
        },
        chrome: {
            runtime: {
                onMessage: { addListener() {} },
                sendMessage(message) {
                    messages.push(message);
                    return Promise.resolve({ success: true });
                }
            }
        }
    });
    vm.runInContext(source('content/content.js'), context, { filename: 'content/content.js' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const accountMessage = messages.find((message) => message.type === 'SET_CURRENT_ACCOUNT');
    assert.deepEqual(JSON.parse(JSON.stringify(accountMessage?.account)), {
        name: 'Lucas Strand',
        username: 'bylemelson',
        avatarUrl: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg'
    });
}

async function testAcknowledgementCountdownRequiresFiveFullTicks() {
    const scheduled = [];
    const cleared = [];
    const button = {
        disabled: false,
        textContent: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; }
    };
    const context = vm.createContext({ globalThis: {}, window: {} });
    context.window = context.globalThis;
    vm.runInContext(source('popup/acknowledgement-timer.js'), context, {
        filename: 'popup/acknowledgement-timer.js'
    });

    const timer = context.globalThis.XPorterAcknowledgementTimer.start(button, {
        seconds: 5,
        readyLabel: 'I understand',
        waitingLabel: (label, seconds) => `${label} (${seconds})`,
        schedule(callback) {
            scheduled.push(callback);
            return scheduled.length;
        },
        cancelSchedule(id) {
            cleared.push(id);
        }
    });

    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'I understand (5)');
    assert.equal(button.attributes['aria-disabled'], 'true');
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (4)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (3)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (2)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand (1)');
    assert.equal(button.disabled, true);
    scheduled.shift()();
    assert.equal(button.textContent, 'I understand');
    assert.equal(button.disabled, false);
    assert.equal(button.attributes['aria-disabled'], undefined);

    const pendingTimer = context.globalThis.XPorterAcknowledgementTimer.start(button, {
        seconds: 5,
        readyLabel: 'I understand',
        schedule(callback) {
            scheduled.push(callback);
            return 99;
        },
        cancelSchedule(id) {
            cleared.push(id);
        }
    });
    pendingTimer.cancel();
    assert(cleared.length >= 1);
    timer.cancel();
}

const tests = [
    ['Bookmarks viewer timeline', testBookmarksEndpointUsesViewerTimelineWithoutUsername],
    ['SearchTimeline error relay', testSearchErrorsAreRelayed],
    ['native request template capture', testNativeRequestTemplateCaptureIsAtomicAndPrivate],
    ['native request template atomic replay', testNativeRequestTemplateReplaysAtomicallyAcrossWorkerRestart],
    ['transaction ID deterministic header', testTransactionIdGeneratorProducesDeterministicHeader],
    ['transaction initialization failure cache', testTransactionInitializationFailureIsCached],
    ['Replies transaction header', testRepliesRequestIncludesFreshTransactionHeader],
    ['Replies transaction refresh retry', testRepliesStaleRefreshRetriesSameCandidateOnce],
    ['GraphQL errors are not empty success', testGraphqlErrorsWithoutTimelineAreNotSuccessfulEmptyExports],
    ['stale candidate exhaustion marker', testStaleCandidateExhaustionIsMarkedTerminal],
    ['stale endpoint persistence invalidation', testStaleDiscoveredEndpointInvalidatesPersistedCache],
    ['required-operation discovery', testRequiredOperationBypassesPartialDiscoveryCache],
    ['About Account region', testAboutAccountRegionIsRequestedAndParsed],
    ['real XLSX OOXML', testXlsxIsRealOoxmlZip],
    ['photo XLSX Media sheet', testXlsxEmbedsMultiplePhotosOnSeparateMediaSheet],
    ['post XLSX profile metadata', testPostsXlsxStartsWithProfileMetadata],
    ['detailed user-list columns opt-in', testDetailedUserListColumnsAreOptIn],
    ['AI-friendly posts TXT', testPostsTxtIsAiFriendly],
    ['sequential TXT reply chains', testPostsTxtUsesSequentialNumbersAndExplainsReplyChains],
    ['quoted post context in TXT', testPostsTxtIncludesQuotedPostContextFromTimelinePayload],
    ['quoted post unavailable metrics', testQuotedPostContextOmitsMetricsMissingFromTimelinePayload],
    ['compact saved formats', testSavedFormatsOmitEmptyFieldsButKeepZerosAndFalse],
    ['reply context across formats', testReplyContextIsRenderedAcrossExportFormats],
    ['stale bearer retry', testStaleBearerRetriesImmediately],
    ['Following REST fallback', testFollowingUsesRestEndpointAndNormalizesUsers],
    ['missing profile counts stay unknown', testMissingProfileCountsRemainUnknown],
    ['profile feed endpoint selection', testProfileFeedSelectsMatchingTimeline],
    ['active request cancellation', testActiveApiRequestCanBeAborted],
    ['active response-body cancellation', testActiveResponseBodyCanBeAborted],
    ['download module contract', testDownloadModulePreservesCurrentExportContract],
    ['large downloads split incrementally', testLargeDownloadsAreSplitAndReadIncrementally],
    ['anonymous uninstall module', testUninstallFeedbackModuleKeepsAnonymousContract],
    ['explicit zero-row Replies fallback', testRepliesFallbackRequiresZeroRowsAndPreservesSnapshot],
    ['All feed profile filtering and context', testAllFeedKeepsOnlyProfilePostsAndContext],
    ['explicit post-type combinations', testExplicitPostTypeSelectionPlansAndCombinesFeeds],
    ['live mixed-feed quantity retargeting', testLiveQuantityChangeUpdatesMixedFeedBudget],
    ['Bookmarks mode and reply context', testBookmarksModeSkipsUsernameResolutionAndKeepsEverySavedAuthor],
    ['search capture arms before navigation', testSearchCaptureIsArmedBeforeNavigation],
    ['unexpected empty user list is not success', testUnexpectedEmptyUserListDoesNotComplete],
    ['user-list About details opt-in and cache', testUserListAboutDetailsAreOptInAndCached],
    ['About details selected batch concurrency', testAboutAccountDetailsUseSelectedBatchConcurrency],
    ['About details commit each finished batch', testAboutAccountDetailsCommitEachFinishedBatchImmediately],
    ['About details live batch speed change', testAboutAccountSpeedChangesApplyToTheNextBatch],
    ['About details cache expiry and bound', testAboutAccountCacheExpiresAndStaysBounded],
    ['unknown Following count never completes with zero rows', testUnknownFollowingCountCannotBecomeZeroRowSuccess],
    ['resume run loop preserves pacing and count', testResumeRunLoopPreservesLimiterAndCount],
    ['fresh export Account Based In', testFreshExportEnrichesProfileWithAccountRegion],
    ['About rate-limit wait survives popup reopen', testAboutRateLimitWaitSurvivesPopupReopen],
    ['export settings snapshot', testExportSnapshotSurvivesWorkerRestart],
    ['large completion skips history payload copy', testLargeCompletionSkipsHistoryPayloadCopy],
    ['cursor dedup memory is bounded', testCursorDedupMemoryIsBounded],
    ['resume pacing vs filters', testResumeKeepsFiltersButFollowsCurrentPacing],
    ['saved pacing applies live without changing filters', testSavedPacingChangesApplyToARunningExportOnly],
    ['independent post and user-list speeds', testPostsAndUserListsUseIndependentSpeedSettings],
    ['configurable About rate-limit retries', testAboutAccountRetriesAreConfigurable],
    ['XLSX truncation stays valid', testXlsxCellTruncationKeepsXmlValid],
    ['persisted limit override', testPersistedLimitOverrideIsReported],
    ['stopped Resume ignores extra quantity', testStoppedResumeRejectsExtraQuantityOverride],
    ['terminal auto-expiration', testTerminalExportActuallyExpires],
    ['resume first-item telemetry', testResumeRecordsFirstNewItem],
    ['state write failure', testStateWriteFailureIsTerminal],
    ['date Resume rebuilds coverage from saved rows', testSavedDateRangeRowsAdvanceResumeCoverage],
    ['repeated post cursor terminates', testRepeatedPostCursorTerminatesWithoutHanging],
    ['repeated user-list cursor terminates', testRepeatedUserListCursorTerminatesWithoutHanging],
    ['deep timeline module parser', testTimelineModuleItemsAreParsed],
    ['timeline_v2 user-list parser', testTimelineV2UserListsAreParsed],
    ['theme restore', testThemeInitializationCanRevertToDark],
    ['profile feed defaults and migration', testProfileFeedDefaultsAndMigratesLegacyReplySetting]
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
    if (failures.length > 0) {
        process.exitCode = 1;
    } else {
        console.log('Extension core tests passed');
    }
})();
