#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8');

function createHarness(fetchImpl, config = {}) {
    const storage = {};
    const context = vm.createContext({
        console,
        AbortController,
        Response,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'XPorter test' },
        fetch: fetchImpl,
        XPORTER_CONFIG: {
            API_FETCH_TIMEOUT: 1000,
            DISCOVERY_FETCH_TIMEOUT: 1000,
            DISCOVERY_TOTAL_TIMEOUT: 10,
            ENDPOINT_CACHE_TTL: 24 * 60 * 60 * 1000,
            FALLBACK_BEARER_TOKEN: 'fallback-bearer',
            ...config
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        XPorterApiParsers: {},
        chrome: {
            storage: {
                local: {
                    async get(key) {
                        return { [key]: storage[key] };
                    },
                    async set(values) {
                        Object.assign(storage, structuredClone(values));
                    },
                    async remove(key) {
                        delete storage[key];
                    }
                }
            },
            cookies: {
                get(_details, callback) {
                    callback(null);
                }
            }
        }
    });

    vm.runInContext(apiSource, context, { filename: 'utils/api.js' });
    return { api: context.XPorterAPI, storage };
}

async function testUserAbortDoesNotBecomeFallbackDiscovery() {
    for (const useExport of [false, true]) {
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        const calls = [];
        const fetchImpl = (url, options) => new Promise((_resolve, reject) => {
            calls.push(String(url));
            started();
            options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
        });
        const harness = useExport
            ? createFullHarness(fetchImpl)
            : createHarness(fetchImpl, { DISCOVERY_TOTAL_TIMEOUT: 1000 });
        const request = useExport ? harness.api.fetchUserTweets('1') : harness.api.discoverEndpoints();
        await ready;
        harness.api.abortActiveRequests();
        await assert.rejects(request, /ABORTED/,
            'Stop must reject discovery rather than start a fallback authenticated request');
        assert.deepEqual(calls, ['https://x.com'], 'no request may follow the aborted discovery');
    }
}


async function testUserAbortDuringHydrationStartsNoNetwork() {
    for (const useExport of [false, true]) {
        let releaseRead;
        let readStarted;
        const ready = new Promise(resolve => { readStarted = resolve; });
        const calls = [];
        const harness = createFullHarness(async url => {
            calls.push(String(url));
            return new Response('<html></html>');
        });
        const key = useExport ? 'xporter_native_request_templates_v1' : 'xporter_discovered_endpoints';
        const originalGet = harness.context.chrome.storage.local.get;
        harness.context.chrome.storage.local.get = async name => {
            if (name !== key) return originalGet(name);
            readStarted();
            return new Promise(resolve => { releaseRead = () => resolve({}); });
        };
        const request = useExport ? harness.api.fetchUserTweets('1') : harness.api.discoverEndpoints();
        await ready;
        harness.api.abortActiveRequests();
        releaseRead();
        await assert.rejects(request, /ABORTED/);
        assert.deepEqual(calls, [], 'a storage read released after Stop must not initiate network');
    }
}

async function testTotalTimeoutAbortsOutstandingBundleFetch() {
    let bundleSignal = null;
    const pageHtml = [
        '<html><head>',
        '<script src="https://abs.twimg.com/responsive-web/client-web-test.js"></script>',
        '</head></html>'
    ].join('');
    const harness = createHarness(async (url, options = {}) => {
        if (url === 'https://x.com') {
            return new Response(pageHtml, { status: 200 });
        }
        bundleSignal = options.signal || null;
        return new Promise((_resolve, reject) => {
            bundleSignal?.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    });

    try {
        const result = await harness.api.discoverEndpoints(true);

        assert.equal(
            result.UserByScreenName.queryId,
            'AWbeRIdkLtqTRN7yL_H8yw',
            'the timed-out caller must still receive fallback endpoints'
        );
        assert.equal(bundleSignal?.aborted, true,
            'the total timeout must abort the underlying bundle fetch');
    } finally {
        harness.api.abortActiveRequests();
    }
}

function discoveryPage(bundleName) {
    return [
        '<html><head>',
        `<script src="https://abs.twimg.com/responsive-web/${bundleName}.js"></script>`,
        '</head></html>'
    ].join('');
}

function discoveryBundle(userQueryId, tweetsQueryId, bearer) {
    return [
        `queryId:"${userQueryId}",operationName:"UserByScreenName"`,
        `queryId:"${tweetsQueryId}",operationName:"UserTweets"`,
        `"${bearer}"`
    ].join(';');
}

async function testLateTimedOutGenerationCannotOverwriteNewerDiscovery() {
    const lateBearer = 'A'.repeat(110) + 'LATE';
    const freshBearer = 'A'.repeat(110) + 'FRESH';
    let pageNumber = 0;
    let resolveLateBundle;
    const harness = createHarness(async (url) => {
        if (url === 'https://x.com') {
            pageNumber += 1;
            return new Response(
                discoveryPage(pageNumber === 1 ? 'client-web-late' : 'client-web-fresh'),
                { status: 200 }
            );
        }
        if (url.includes('client-web-late')) {
            return new Promise(resolve => {
                resolveLateBundle = () => resolve(new Response(
                    discoveryBundle('late-user-id', 'late-tweets-id', lateBearer),
                    { status: 200 }
                ));
            });
        }
        return new Response(
            discoveryBundle('fresh-user-id', 'fresh-tweets-id', freshBearer),
            { status: 200 }
        );
    });

    const timedOut = await harness.api.discoverEndpoints(true);
    assert.equal(timedOut.UserByScreenName.queryId, 'AWbeRIdkLtqTRN7yL_H8yw');

    const fresh = await harness.api.discoverEndpoints(true);
    assert.equal(fresh.UserByScreenName.queryId, 'fresh-user-id');
    assert.equal(harness.api.BEARER_TOKEN, freshBearer);

    resolveLateBundle();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    const cached = await harness.api.discoverEndpoints(false);
    assert.equal(cached.UserByScreenName.queryId, 'fresh-user-id',
        'a late timed-out generation must not replace the newer endpoint cache');
    assert.equal(harness.api.BEARER_TOKEN, freshBearer,
        'a late timed-out generation must not replace the newer bearer');
    assert.equal(
        harness.storage.xporter_discovered_endpoints.endpoints.UserByScreenName.queryId,
        'fresh-user-id',
        'a late timed-out generation must not persist stale endpoints'
    );
}

async function testSuccessfulDiscoveryRemainsSingleFlightAndCached() {
    const bearer = 'A'.repeat(110) + 'CURRENT';
    let fetchCount = 0;
    const harness = createHarness(async (url) => {
        fetchCount += 1;
        if (url === 'https://x.com') {
            return new Response(discoveryPage('client-web-current'), { status: 200 });
        }
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(
            discoveryBundle('current-user-id', 'current-tweets-id', bearer),
            { status: 200 }
        );
    }, {
        DISCOVERY_TOTAL_TIMEOUT: 100
    });

    const [first, second] = await Promise.all([
        harness.api.discoverEndpoints(true),
        harness.api.discoverEndpoints(true)
    ]);

    assert.equal(first.UserByScreenName.queryId, 'current-user-id');
    assert.equal(second.UserByScreenName.queryId, 'current-user-id');
    assert.equal(fetchCount, 2,
        'concurrent discovery callers must share one page and bundle scan');

    const cached = await harness.api.discoverEndpoints(false);
    assert.equal(cached.UserByScreenName.queryId, 'current-user-id');
    assert.equal(fetchCount, 2,
        'a successful discovery must retain the existing 24-hour memory cache');
}

// ---------------------------------------------------------------------------
// Full API harness: real parsers + native templates + a signed-in cookie jar.
function createFullHarness(fetchImpl, { stored = {}, config = {} } = {}) {
    const writes = [];
    const removed = [];
    const context = vm.createContext({
        console,
        AbortController,
        Response,
        URL,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'XPorter test' },
        fetch: fetchImpl,
        XPORTER_CONFIG: {
            API_FETCH_TIMEOUT: 1000,
            DISCOVERY_FETCH_TIMEOUT: 1000,
            DISCOVERY_TOTAL_TIMEOUT: 2000,
            ENDPOINT_CACHE_TTL: 60 * 60 * 1000,
            FALLBACK_BEARER_TOKEN: 'fallback-bearer',
            ...config
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        BOOKMARKS_FEATURES: {},
        BOOKMARKS_FIELD_TOGGLES: { withArticlePlainText: true },
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
                    async set(values) {
                        writes.push(Object.keys(values));
                        Object.assign(stored, structuredClone(values));
                    },
                    async remove(key) {
                        for (const item of [].concat(key)) {
                            removed.push(item);
                            delete stored[item];
                        }
                    }
                }
            }
        }
    });
    for (const file of ['utils/api-parsers.js', 'utils/native-request-template.js', 'utils/api.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
    return { context, api: context.XPorterAPI, parsers: context.XPorterApiParsers, stored, writes, removed };
}

const MAIN_BUNDLE = 'https://abs.twimg.com/responsive-web/client-web/main.test.js';
const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
});
const timelineBody = (entries = []) => ({
    data: { user: { result: { timeline_v2: { timeline: { instructions: [{
        type: 'TimelineAddEntries', entries
    }] } } } } }
});

function tweetEntry(result) {
    return { entryId: `tweet-${result.legacy?.id_str}`, content: { itemContent: { tweet_results: { result } } } };
}

function userResult(id, screenName) {
    return { rest_id: id, core: { name: screenName.toUpperCase(), screen_name: screenName } };
}

function tweet(id, { text = `post ${id}`, user = userResult('1', 'owner'), legacy = {}, ...rest } = {}) {
    return {
        __typename: 'Tweet',
        rest_id: id,
        core: { user_results: { result: user } },
        views: { count: '1234' },
        legacy: {
            id_str: id,
            full_text: text,
            created_at: 'Wed Jul 01 12:00:00 +0000 2026',
            lang: 'en',
            favorite_count: 1,
            retweet_count: 2,
            reply_count: 3,
            quote_count: 4,
            bookmark_count: 5,
            entities: { urls: [], hashtags: [] },
            ...legacy
        },
        ...rest
    };
}

async function testGraphqlErrorsAreClassifiedWithoutTouchingCaches() {
    let body = null;
    let pageScans = 0;
    const { api, stored, removed } = createFullHarness(async (url) => {
        if (url === 'https://x.com') {
            pageScans += 1;
            return new Response('<html></html>', { status: 200 });
        }
        return typeof body === 'function' ? body(url) : json(body);
    });
    const template = {
        operationName: 'UserTweets',
        queryId: 'native-posts-id',
        features: { flag: true },
        fieldToggles: null
    };
    assert.equal(await api.setLiveRequestTemplate(template), true);

    const expectations = [
        [{ errors: [{ code: 88, message: 'Rate limit exceeded' }] }, 'RATE_LIMITED'],
        [{ errors: [{ code: 239, message: 'Bad guest token' }] }, 'AUTH_ERROR'],
        [{ errors: [{ code: 32, message: 'Could not authenticate you.' }], data: {} }, 'AUTH_ERROR'],
        [{ errors: [{ message: 'Dependency: Unspecified', extensions: { kind: 'Operational' } }] },
            'GRAPHQL_TRANSIENT'],
        [{ errors: [{ message: 'Timeout: Unspecified' }], data: { user: null } }, 'GRAPHQL_TRANSIENT'],
        // Data present but its timeline missing: the attached errors still decide.
        [{ errors: [{ message: 'Internal error', code: 131 }], data: { user: { result: { __typename: 'User' } } } },
            'GRAPHQL_TRANSIENT']
    ];
    for (const [payload, expected] of expectations) {
        body = payload;
        assert.equal(api.classifyGraphqlErrors(payload.errors).code, expected,
            'captured search responses must use the same public error classifier');
        await assert.rejects(api.fetchUserTweets('1'), error =>
            error.message === expected && error.code === expected && error.staleCandidatesExhausted !== true,
            `${JSON.stringify(payload)} must classify as ${expected}`);
    }
    assert.equal(pageScans, 0, 'non-stale GraphQL errors must never trigger a bundle scan');
    assert.equal(stored.xporter_native_request_templates_v1.templates.UserTweets.queryId, 'native-posts-id',
        'non-stale GraphQL errors must keep the working native template');
    assert.deepEqual(removed, []);

    // UserUnavailable inside the timeline response is a user-facing condition.
    body = { data: { user: { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } } };
    await assert.rejects(api.fetchUserTweets('1'), /USER_SUSPENDED/);
    body = { data: { user: { result: { __typename: 'UserUnavailable', reason: 'NoReason' } } } };
    await assert.rejects(api.fetchUserTweets('1'), /USER_UNAVAILABLE/);
    assert.equal(pageScans, 0);

    // Partial success (rows beside errors) keeps working.
    body = { ...timelineBody([tweetEntry(tweet('100'))]), errors: [{ message: 'Dependency: Unspecified' }] };
    const partial = await api.fetchUserTweets('1');
    assert.deepEqual(partial.tweets.map(item => item.id), ['100']);

    // A query-shape error is the stale path: the template is dropped.
    body = { errors: [{ message: 'Query: Unspecified', extensions: { kind: 'Validation' } }] };
    await assert.rejects(api.fetchUserTweets('1'), error =>
        error.message === 'STALE_QUERY_ID' && error.staleCandidatesExhausted === true);
    assert.equal(stored.xporter_native_request_templates_v1.templates.UserTweets, undefined);
}

async function testServerAndJsonFailuresHaveStableCodes() {
    let respond = () => json({}, 503);
    const { api } = createFullHarness(async (url) => respond(url));
    await assert.rejects(api.fetchUserTweets('1'), error =>
        error.message === 'API_ERROR_503' && error.code === 'API_SERVER_ERROR');

    respond = () => new Response('<html>maintenance</html>', { status: 200 });
    await assert.rejects(api.fetchUserTweets('1'), error =>
        error.message === 'INVALID_JSON_RESPONSE' && error.code === 'INVALID_JSON_RESPONSE');
    respond = () => new Response('null', { status: 200 });
    await assert.rejects(api.fetchUserTweets('1'), /INVALID_JSON_RESPONSE/);

    let restUrl = '';
    respond = (url) => { restUrl = url; return json({}, 502); };
    await assert.rejects(api.fetchFollowers('12&x=1', 'next+/=cursor'), error =>
        error.message === 'API_ERROR_502' && error.code === 'API_SERVER_ERROR');
    const parsed = new URL(restUrl);
    assert.equal(parsed.searchParams.get('user_id'), '12&x=1', 'REST user IDs must be URL-encoded');
    assert.equal(parsed.searchParams.get('cursor'), 'next+/=cursor', 'REST cursors must be URL-encoded');
    assert.equal(parsed.searchParams.get('x'), null);

    // A 4xx other than 400/404 keeps its plain message and has no server code.
    respond = () => json({}, 422);
    await assert.rejects(api.fetchUserTweets('1'), error =>
        error.message === 'API_ERROR_422' && error.code === undefined);
}

async function testNestedGraphqlFailuresCannotBecomeEmptySuccess() {
    let body = { data: { user: { result: null } }, errors: [{ code: 131, message: 'Internal error' }] };
    let scans = 0;
    const { api } = createFullHarness(async (url) => {
        if (url === 'https://x.com') scans += 1;
        return json(body);
    });
    for (const operationName of ['UserByScreenName', 'BlueVerifiedFollowers', 'UserTweets', 'Bookmarks',
        'AboutAccountQuery', 'TweetResultsByRestIds']) {
        await api.setLiveRequestTemplate({ operationName, queryId: 'native-query-id', features: {}, fieldToggles: null });
    }
    await assert.rejects(api.getUserByScreenName('owner'), /GRAPHQL_TRANSIENT/);
    await assert.rejects(api.fetchVerifiedFollowers('1'), /GRAPHQL_TRANSIENT/);
    await assert.rejects(api.fetchFollowers('1'), /GRAPHQL_TRANSIENT/);
    assert.equal(scans, 0, 'nested transient failures must preserve accepted native templates');

    body = { data: { user: { result: null } } };
    await assert.rejects(api.getUserByScreenName('missing'), /USER_NOT_FOUND/);
    body = { data: { user: { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } } };
    await assert.rejects(api.fetchVerifiedFollowers('1'), /USER_SUSPENDED/);
    body = timelineBody();
    assert.equal((await api.fetchVerifiedFollowers('1')).users.length, 0,
        'an explicit empty timeline remains a successful empty page');
    body = { users: [] , next_cursor_str: '0' };
    assert.equal((await api.fetchFollowers('1')).users.length, 0);
    body = { users: [], errors: [{ code: 88 }] };
    await assert.rejects(api.fetchFollowers('1'), /RATE_LIMITED/);
    for (const malformed of [{}, { users: {} }]) {
        body = malformed;
        await assert.rejects(api.fetchFollowing('1'), /INVALID_JSON_RESPONSE/);
    }
    body = { ...timelineBody(), errors: [{ code: 88, message: 'Rate limit exceeded' }] };
    await assert.rejects(api.fetchVerifiedFollowers('1'), /RATE_LIMITED/);
    await assert.rejects(api.fetchUserTweets('1'), /RATE_LIMITED/);
    body = { data: { bookmark_timeline_v2: { timeline: { instructions: [] } } }, errors: [{ code: 131 }] };
    await assert.rejects(api.fetchBookmarks(), /GRAPHQL_TRANSIENT/);
    body = { data: { user_result_by_screen_name: { result: null } }, errors: [{ code: 131 }] };
    await assert.rejects(api.getAccountAbout('owner'), /GRAPHQL_TRANSIENT/);
    body = { data: { tweetResult: [] }, errors: [{ code: 88 }] };
    await assert.rejects(api.fetchTweetsByIds(['12345']), /RATE_LIMITED/);
    body = { data: { user: { result: null } }, errors: [] };
    await assert.rejects(api.getUserByScreenName('missing'), /USER_NOT_FOUND/);
}

async function testOperationMissingFromBundlesIsNegativelyCached() {
    const stored = {};
    let pageScans = 0;
    let bundleOk = true;
    const requested = [];
    const bundle = [
        'queryId:"found-user-id",operationName:"UserByScreenName"',
        'queryId:"found-posts-id",operationName:"UserTweets"'
    ].join(';');
    const { api } = createFullHarness(async (url) => {
        if (url === 'https://x.com') {
            pageScans += 1;
            if (!bundleOk) throw new Error('Failed to fetch');
            return new Response(`<html><script src="${MAIN_BUNDLE}"></script></html>`, { status: 200 });
        }
        if (url === MAIN_BUNDLE) return new Response(bundle, { status: 200 });
        requested.push(new URL(url).pathname);
        return json(timelineBody([tweetEntry(tweet('200'))]));
    }, { stored });

    // Three pages of UserOriginalsTimeline, which the bundles do not contain.
    for (let page = 0; page < 3; page += 1) {
        const result = await api.fetchUserTweets('1', page ? `cursor-${page}` : null, 20, 'posts');
        assert.deepEqual(result.tweets.map(item => item.id), ['200']);
    }
    assert.equal(pageScans, 1, 'an operation absent from the bundles must be scanned for at most once');
    assert(requested.every(pathname => pathname.endsWith('/jcbfqPu_2XMNOwVyGypRhw/UserOriginalsTimeline')),
        'the missing operation uses its fallback queryId');

    // The other operations found by that scan remain discovered.
    await api.fetchUserTweets('1');
    assert.equal(requested.at(-1), '/i/api/graphql/found-posts-id/UserTweets');
    assert.equal(pageScans, 1);

    // After a worker restart the negative cache is hydrated, not re-scanned.
    const restarted = createFullHarness(async (url) => {
        if (url === 'https://x.com') pageScans += 1;
        return json(timelineBody());
    }, { stored });
    await restarted.api.fetchUserTweets('1', null, 20, 'posts');
    assert.equal(pageScans, 1, 'the negative cache must survive a worker restart');

    // A failing pass never discards successfully discovered operations.
    bundleOk = false;
    const afterFailure = await api.discoverEndpoints(true);
    assert.equal(pageScans, 2);
    assert.equal(afterFailure.UserTweets.queryId, 'found-posts-id');
    assert.equal(afterFailure.UserByScreenName.queryId, 'found-user-id');
    assert.equal(afterFailure.Bookmarks.queryId, 'iblrFnKr6PZUR-dWpfXG6g');
}

async function testConcurrentRequiredOperationsShareOneCommittedScan() {
    let pageScans = 0;
    const bundle = 'queryId:"found-posts-id",operationName:"UserTweets";' +
        'queryId:"found-user-id",operationName:"UserByScreenName"';
    const { api } = createFullHarness(async (url) => {
        if (url === 'https://x.com') {
            pageScans += 1;
            return new Response(`<html><script src="${MAIN_BUNDLE}"></script></html>`, { status: 200 });
        }
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(bundle, { status: 200 });
    });
    const results = await Promise.all([
        api.discoverEndpoints(false, 'UserOriginalsTimeline'),
        api.discoverEndpoints(false, 'Bookmarks'),
        api.discoverEndpoints(false, 'UserTweets')
    ]);
    assert.equal(pageScans, 1);
    for (const result of results) {
        assert.equal(result.UserTweets.queryId, 'found-posts-id',
            'a caller whose operation was missing must not overwrite the committed success');
    }
    const cached = await api.discoverEndpoints(false, 'UserOriginalsTimeline');
    assert.equal(cached.UserTweets.queryId, 'found-posts-id');
    assert.equal(pageScans, 1);
}

async function testNativeTemplateKeepsArticleTextAndSkipsRedundantWrites() {
    const urls = [];
    const harness = createFullHarness(async (url) => {
        urls.push(url);
        return json({ data: { bookmark_timeline_v2: { timeline: { instructions: [] } } } });
    });
    const template = {
        operationName: 'Bookmarks',
        queryId: 'native-bookmarks-id',
        features: { flag: true },
        fieldToggles: { withArticlePlainText: false, withPayments: false }
    };
    assert.equal(await harness.api.setLiveRequestTemplate(template), true);
    const writesAfterFirst = harness.writes.length;
    assert.equal(await harness.api.setLiveRequestTemplate({ ...template }), true);
    assert.equal(harness.writes.length, writesAfterFirst,
        'an identical young template must not rewrite chrome.storage.local');
    assert.equal(await harness.api.setLiveRequestTemplate({ ...template, queryId: 'rotated-bookmarks-id' }), true);
    assert.equal(harness.writes.length, writesAfterFirst + 1, 'a changed template must be persisted');

    await harness.api.fetchBookmarks();
    const toggles = JSON.parse(new URL(urls.at(-1)).searchParams.get('fieldToggles'));
    assert.deepEqual(toggles, { withArticlePlainText: true, withPayments: false },
        'native toggles are kept while the requested full article text is forced on');
}

function testParserContentNormalization() {
    const { context, parsers } = createFullHarness(async () => { throw new Error('offline'); });
    const plain = (value) => JSON.parse(JSON.stringify(value));

    // HTML entities (legacy text only; URLs/usernames untouched).
    const escaped = parsers.parseTweetObject(tweet('300', {
        text: 'Q&amp;A &lt;b&gt; &amp;amp; done',
        legacy: { entities: { urls: [{ expanded_url: 'https://e.com/?a=1&amp;b=2' }], hashtags: [] } }
    }));
    assert.equal(escaped.text, 'Q&A <b> &amp; done');
    assert.equal(escaped.urls, 'https://e.com/?a=1&amp;b=2');
    assert.equal(escaped.view_count, 1234, 'view counts are numbers');
    assert.equal(parsers.parseTweetObject(tweet('301', { views: {} })).view_count, '');
    assert.equal(parsers.parseTweetObject(tweet('302', { views: { count: 'n/a' } })).view_count, '');

    // Long post: note text with its own entity set.
    const long = parsers.parseTweetObject(tweet('310', {
        text: 'truncated https://t.co/x',
        legacy: { entities: { urls: [{ expanded_url: 'https://short.example' }], hashtags: [{ text: 'old' }] } },
        note_tweet: { note_tweet_results: { result: {
            text: 'Full long text & more',
            entity_set: {
                urls: [{ expanded_url: 'https://one.example' }, { expanded_url: 'https://two.example' }],
                hashtags: [{ text: 'long' }]
            }
        } } }
    }));
    assert.equal(long.text, 'Full long text & more');
    assert.equal(long.urls, 'https://one.example, https://two.example');
    assert.equal(long.hashtags, 'long');

    // Repost: reposter owns the row, the original supplies content and metrics.
    const original = tweet('400', {
        text: 'Original &amp; complete text',
        user: userResult('2', 'author'),
        views: { count: '9000' },
        legacy: {
            favorite_count: 70, retweet_count: 71, reply_count: 72, quote_count: 73, bookmark_count: 74,
            lang: 'de',
            entities: { urls: [{ expanded_url: 'https://orig.example' }], hashtags: [{ text: 'orig' }] },
            extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/o.jpg' }] }
        },
        quoted_status_result: { result: tweet('401', { user: userResult('3', 'quoted') }) }
    });
    const repost = parsers.parseTweetObject(tweet('410', {
        text: 'RT @author: Original &amp; comp…',
        user: userResult('1', 'owner'),
        views: {},
        legacy: {
            favorite_count: 0, retweet_count: 71, reply_count: 0, quote_count: 0, bookmark_count: 0,
            created_at: 'Thu Jul 02 12:00:00 +0000 2026',
            retweeted_status_result: { result: { __typename: 'TweetWithVisibilityResults', tweet: original } }
        }
    }));
    assert.equal(repost.id, '410');
    assert.equal(repost.type, 'retweet');
    assert.equal(repost.tweet_url, 'https://x.com/owner/status/410');
    assert.equal(repost.created_at, 'Thu Jul 02 12:00:00 +0000 2026');
    assert.equal(repost.author_username, 'owner');
    assert.equal(repost._author_id, '1', 'author filtering must still see the reposter');
    assert.equal(repost.text, 'RT @author: Original & complete text');
    assert.deepEqual(
        [repost.favorite_count, repost.retweet_count, repost.reply_count, repost.quote_count,
            repost.bookmark_count, repost.view_count],
        [70, 71, 72, 73, 74, 9000]
    );
    assert.equal(repost.urls, 'https://orig.example');
    assert.equal(repost.hashtags, 'orig');
    assert.equal(repost.media_urls, 'https://pbs.twimg.com/media/o.jpg');
    assert.equal(repost.language, 'de');
    assert.equal(repost.quoted_post?.id, '401');

    // Malformed media and instructions never crash a page.
    for (const media of [null, 'x', [null, { type: 'video', video_info: { variants: 'bad' } }]]) {
        assert.doesNotThrow(() => parsers.parseTweetObject(tweet('500', { legacy: { extended_entities: { media } } })));
    }
    const video = parsers.parseTweetObject(tweet('501', { legacy: { extended_entities: { media: [{
        type: 'video', media_url_https: 'https://pbs.twimg.com/thumb.jpg',
        video_info: { variants: [null, { content_type: 'video/mp4', bitrate: 1, url: 'https://video.twimg.com/a.mp4' }] }
    }] } } }));
    assert.equal(video.media_urls, 'https://video.twimg.com/a.mp4');
    context.__timeline = { data: { user: { result: { timeline_v2: { timeline: { instructions: [
        null, 'junk', { type: 'TimelineAddEntries', entries: [tweetEntry(tweet('600'))] }
    ] } } } } } };
    const parsedTimeline = vm.runInContext('XPorterApiParsers.parseTimelineResponse(__timeline)', context);
    assert.deepEqual(plain(parsedTimeline.tweets.map(item => item.id)), ['600']);

    // Each tweet_results object is parsed exactly once per page.
    let noteReads = 0;
    const counted = tweet('700');
    Object.defineProperty(counted, 'note_tweet', { enumerable: true, get() { noteReads += 1; return undefined; } });
    context.__counted = { data: { user: { result: { timeline_v2: { timeline: { instructions: [
        { type: 'TimelinePinEntry', entry: tweetEntry(counted) },
        { type: 'TimelineAddEntries', entries: [tweetEntry(tweet('701'))] }
    ] } } } } } };
    const countedPage = vm.runInContext('XPorterApiParsers.parseTimelineResponse(__counted)', context);
    assert.equal(noteReads, 1);
    assert.deepEqual(plain(countedPage.tweets.map(item => [item.id, item.is_pinned === true])),
        [['700', true], ['701', false]]);
}

async function main() {
    await testUserAbortDuringHydrationStartsNoNetwork();
    await testUserAbortDoesNotBecomeFallbackDiscovery();
    await testTotalTimeoutAbortsOutstandingBundleFetch();
    await testLateTimedOutGenerationCannotOverwriteNewerDiscovery();
    await testSuccessfulDiscoveryRemainsSingleFlightAndCached();
    await testGraphqlErrorsAreClassifiedWithoutTouchingCaches();
    await testNestedGraphqlFailuresCannotBecomeEmptySuccess();
    await testServerAndJsonFailuresHaveStableCodes();
    await testOperationMissingFromBundlesIsNegativelyCached();
    await testConcurrentRequiredOperationsShareOneCommittedScan();
    await testNativeTemplateKeepsArticleTextAndSkipsRedundantWrites();
    testParserContentNormalization();
    console.log('API discovery cancellation tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
