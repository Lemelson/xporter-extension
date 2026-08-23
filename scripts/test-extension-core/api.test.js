'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source } = require('./support.js');

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
    vm.runInContext(source('utils/capture-contract.js'), context, {
        filename: 'utils/capture-contract.js'
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
    vm.runInContext(source('utils/capture-contract.js'), context, {
        filename: 'utils/capture-contract.js'
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
                    url: 'https://t.co/profile',
                    entities: {
                        url: {
                            urls: [{
                                expanded_url: 'https://example.com/profile'
                            }]
                        }
                    },
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
        'https://x.com/i/api/1.1/friends/list.json?user_id=1890388644273258496&count=100&skip_status=true&include_user_entities=true&cursor=123',
        'Following must use the REST friends list and request expanded profile URLs'
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
        url: 'https://example.com/profile',
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

function testNestedTimelineV2UserListsAreParsed() {
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
                                                    core: { name: 'First', screen_name: 'first' },
                                                    legacy: {}
                                                }
                                            }
                                        }
                                    }
                                }]
                            }, {
                                type: 'TimelineAddToModule',
                                moduleItems: [{
                                    entryId: 'user-2',
                                    item: {
                                        itemContent: {
                                            user_results: {
                                                result: {
                                                    rest_id: '2',
                                                    is_blue_verified: false,
                                                    core: { name: 'Second', screen_name: 'second' },
                                                    legacy: {
                                                        verified: true,
                                                        url: 'https://t.co/short',
                                                        entities: {
                                                            url: {
                                                                urls: [{
                                                                    expanded_url: 'https://example.com/second'
                                                                }]
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
                                    entryId: 'cursor-bottom-2',
                                    content: {
                                        __typename: 'TimelineTimelineCursor',
                                        cursorType: 'Bottom',
                                        value: 'next-nested-page'
                                    }
                                }
                            }]
                        }
                    }
                }
            }
        }
    };

    const result = vm.runInContext('XPorterApiParsers.parseFollowersResponse(__payload)', context);
    assert.deepEqual(
        JSON.parse(JSON.stringify(result.users.map(user => user.id))),
        ['1', '2'],
        'TimelineAddToModule user rows must not disappear'
    );
    assert.equal(
        result.nextCursor,
        'next-nested-page',
        'TimelineReplaceEntry must advance user-list pagination'
    );
    assert.equal(result.users[1].verified, true,
        'legacy verified accounts must remain verified in the export');
    assert.equal(result.users[1].url, 'https://example.com/second',
        'profile URLs must use the expanded user entity');
}

const tests = [
    { name: "Bookmarks viewer timeline", run: testBookmarksEndpointUsesViewerTimelineWithoutUsername, order: 0 },
    { name: "SearchTimeline error relay", run: testSearchErrorsAreRelayed, order: 1 },
    { name: "native request template capture", run: testNativeRequestTemplateCaptureIsAtomicAndPrivate, order: 2 },
    { name: "reply-parent batch fetch", run: testTweetResultsEndpointFetchesReplyParentsInOneBatch, order: 3 },
    { name: "native request template atomic replay", run: testNativeRequestTemplateReplaysAtomicallyAcrossWorkerRestart, order: 4 },
    { name: "transaction ID deterministic header", run: testTransactionIdGeneratorProducesDeterministicHeader, order: 5 },
    { name: "transaction initialization failure cache", run: testTransactionInitializationFailureIsCached, order: 6 },
    { name: "Replies transaction header", run: testRepliesRequestIncludesFreshTransactionHeader, order: 7 },
    { name: "Replies transaction refresh retry", run: testRepliesStaleRefreshRetriesSameCandidateOnce, order: 8 },
    { name: "GraphQL errors are not empty success", run: testGraphqlErrorsWithoutTimelineAreNotSuccessfulEmptyExports, order: 9 },
    { name: "stale candidate exhaustion marker", run: testStaleCandidateExhaustionIsMarkedTerminal, order: 10 },
    { name: "stale endpoint persistence invalidation", run: testStaleDiscoveredEndpointInvalidatesPersistedCache, order: 11 },
    { name: "required-operation discovery", run: testRequiredOperationBypassesPartialDiscoveryCache, order: 12 },
    { name: "About Account region", run: testAboutAccountRegionIsRequestedAndParsed, order: 13 },
    { name: "stale bearer retry", run: testStaleBearerRetriesImmediately, order: 25 },
    { name: "Following REST fallback", run: testFollowingUsesRestEndpointAndNormalizesUsers, order: 26 },
    { name: "missing profile counts stay unknown", run: testMissingProfileCountsRemainUnknown, order: 27 },
    { name: "profile feed endpoint selection", run: testProfileFeedSelectsMatchingTimeline, order: 28 },
    { name: "active request cancellation", run: testActiveApiRequestCanBeAborted, order: 29 },
    { name: "active response-body cancellation", run: testActiveResponseBodyCanBeAborted, order: 30 },
    { name: "deep timeline module parser", run: testTimelineModuleItemsAreParsed, order: 68 },
    { name: "timeline_v2 user-list parser", run: testTimelineV2UserListsAreParsed, order: 69 },
    { name: "nested timeline_v2 user-list parser", run: testNestedTimelineV2UserListsAreParsed, order: 74 }
];

module.exports = {
    id: "api",
    tests
};
