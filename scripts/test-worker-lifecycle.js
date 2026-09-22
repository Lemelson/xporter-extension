#!/usr/bin/env node
'use strict';

// Worker lifecycle regressions from the 2026-09-22 review: Replies fallback
// eligibility, protected accounts, completion vs Stop, bookmark reply context
// outside the primary limiter, date-search 429 budget/stall/Stop/orphan tab,
// live pacing endpoint, and the runtime message sender policy.

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source } = require('./test-extension-core/support.js');
const { createWorkerHarness } = require('./test-extension-core/worker-harness.js');

const EXTENSION_ROOT = 'chrome-extension://test-extension/';

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function passThroughLimiter(extra = {}) {
    return {
        totalRequests: 0,
        batchSize: 20,
        executeWithRateLimit: (request) => request(),
        getState: () => ({}),
        resetCounters() {},
        reconfigure() {},
        restoreState() {},
        onStatusChange() {},
        abort() { this.aborted = true; },
        isAborted() { return this.aborted === true; },
        ...extra
    };
}

function explicitSelection(types) {
    return {
        quantityLimit: 500,
        postSelectionVersion: 1,
        includeOriginalPosts: false,
        includeQuotes: false,
        includeReplies: false,
        includeRetweets: false,
        includeArticles: false,
        ...types
    };
}

function searchPage(rows = [], cursor = null, url = cursor || 'last-page') {
    const entries = rows.map(row => ({ entryId: 'tweet-' + row.id, content: { itemContent: { tweet_results: { result: {
        legacy: { id_str: row.id, full_text: row.id, created_at: row.date || '2026-09-05T01:00:00Z' },
        core: { user_results: { result: { rest_id: row.authorId || '1', core: { screen_name: 'test' } } } }
    } } } } }));
    if (cursor) entries.push({ entryId: 'cursor-bottom-' + cursor, content: { value: cursor } });
    const instructions = [{ type: 'TimelineAddEntries', entries }];
    if (!cursor) instructions.push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' });
    return { url, status: 200, bodyText: JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } }) };
}

function createSearchHarness(pages, { mockTab = true } = {}) {
    const harness = createWorkerHarness();
    vm.runInContext(source('utils/api-parsers.js'), harness.context);
    harness.context.__pages = [...pages];
    harness.context.__sleeps = [];
    vm.runInContext(`
        currentExport = {
            username:'test',userId:'1',userInfo:{screenName:'test'},exportMode:'posts',outputFormat:'csv',
            schemaVersion:XPORTER_CONFIG.EXPORT_STATE_SCHEMA_VERSION,
            dateFrom:new Date('2026-09-05T00:00:00Z'),dateTo:new Date('2026-09-05T23:59:59.999Z'),
            dateSnapshotAt:Date.parse('2026-09-05T12:00:00Z'),startedAt:Date.parse('2026-09-05T12:00:00Z'),
            running:true,status:'fetching',settings:{quantityLimit:500},tweetBuffer:[],tweetCount:0,totalBatches:0,
            cursor:null,completionReason:null
        };
        rateLimiter={totalRequests:0,batchSize:20,getState:()=>({})};
        XPorterStorage.MAX_TWEETS_PER_BATCH=50;
        XPorterAPI.parseSearchTimelineResponse=XPorterApiParsers.parseSearchTimelineResponse;
        sendSearchCaptureStatus=async()=>true;
        waitForSearchCapturePayload=async()=>__pages.shift() || null;
        requestNextSearchCapturePayload=async()=>__pages.shift() || null;
        recoverStalledSearchCapture=async()=>null;
        swSleep=async(ms)=>{__sleeps.push(ms);};
    `, harness.context);
    if (mockTab) {
        vm.runInContext(`
            openSearchCaptureTab=async(rawQuery)=>{searchCapture={rawQuery,queue:[],seenUrls:new Set(),resumeScanned:0};};
            closeSearchCaptureTab=async()=>{searchCapture=null;};
        `, harness.context);
    }
    return harness;
}

// ---------------------------------------------------------------- item 1

async function testRepliesOnlySelectionNeverOffersPostsOnlyFallback() {
    const harness = createWorkerHarness();
    let launches = 0;
    harness.context.launchExportLoop = () => { launches += 1; };
    const failedState = (settings) => ({
        running: false, status: 'error', error: 'REPLIES_UNAVAILABLE', exportMode: 'posts',
        username: 'target', userId: '10', userInfo: { id: '10', screenName: 'target' },
        tweetCount: 0, totalBatches: 0, cursor: null, postFeedPlan: ['replies'], postFeedIndex: 0,
        startedAt: 1, settings
    });

    const repliesOnly = failedState(explicitSelection({ includeReplies: true }));
    harness.context.__state = repliesOnly;
    assert.equal(vm.runInContext('canFallbackWithoutReplies(__state)', harness.context), false,
        'a replies-only selection has nothing left to export without replies');
    harness.setSavedState(repliesOnly);
    assert.equal((await vm.runInContext('getExportStatus()', harness.context)).canFallbackWithoutReplies, false);
    const refused = await vm.runInContext('_resumeExportInner(undefined, { postsOnlyFallback: true })', harness.context);
    assert.deepEqual(plain(refused), { error: 'NO_POST_TYPES_SELECTED' });
    assert.equal(launches, 0, 'a refused fallback must not walk any feed');
    assert.equal(harness.getSavedState().status, 'error', 'the refused fallback leaves the saved state untouched');

    const mixed = failedState(explicitSelection({ includeReplies: true, includeOriginalPosts: true }));
    harness.context.__state = mixed;
    assert.equal(vm.runInContext('canFallbackWithoutReplies(__state)', harness.context), true);

    // Not a zero-row Replies failure at all: keep the historical error.
    harness.setSavedState({ ...mixed, error: 'RATE_LIMITED' });
    const notEligible = await vm.runInContext('_resumeExportInner(undefined, { postsOnlyFallback: true })', harness.context);
    assert.deepEqual(plain(notEligible), { error: 'REPLIES_UNAVAILABLE' });
}

// ---------------------------------------------------------------- item 3

async function testBookmarkReplyContextRunsOutsidePrimaryLimiter() {
    const harness = createWorkerHarness();
    let primaryDepth = 0;
    const contextCalls = [];
    harness.context.__primary = passThroughLimiter({
        async executeWithRateLimit(request) {
            primaryDepth += 1;
            try { return await request(); } finally { primaryDepth -= 1; }
        }
    });
    harness.context.__contextLimiter = passThroughLimiter({
        async executeWithRateLimit(request) {
            contextCalls.push(primaryDepth);
            return request();
        }
    });
    let bookmarkFetches = 0;
    harness.context.XPorterAPI.fetchBookmarks = async () => {
        bookmarkFetches += 1;
        return { tweets: [{ id: '1', reply_to_id: '99', reply_to_post: null }, { id: '2' }], nextCursor: null };
    };
    harness.context.XPorterAPI.fetchTweetsByIds = async () => {
        const error = new Error('STALE_QUERY_ID');
        error.staleCandidatesExhausted = true;
        throw error;
    };
    vm.runInContext(`
        rateLimiter = __primary;
        createRateLimiter = () => __contextLimiter;
        XPorterStorage.MAX_TWEETS_PER_BATCH = 50;
        currentExport = {
            running:true, status:'fetching', exportMode:'bookmarks', username:'', userId:'current-account',
            userInfo:{ name:'', screenName:'' }, settings:{ quantityLimit:500 },
            tweetBuffer:[], tweetCount:0, totalBatches:0, cursor:null, completionReason:null
        };
    `, harness.context);

    await vm.runInContext('_fetchBookmarksLoop()', harness.context);
    assert.deepEqual(contextCalls, [0], 'reply context must never run inside the Bookmarks request');
    assert.equal(bookmarkFetches, 1, 'a context failure must not refetch the Bookmarks page');
    assert.deepEqual(harness.getSavedBatches().flat().map(row => row.id), ['1', '2']);
    assert.equal(harness.getSavedBatches().flat()[0].reply_to_post, null,
        'rows are saved without reply_to_post when context is unavailable');
    assert.equal(harness.getSavedState().completionReason, 'source_exhausted');

    // Stop during the context lookup still ends the run as an abort.
    harness.context.XPorterAPI.fetchTweetsByIds = async () => { throw new Error('ABORTED'); };
    vm.runInContext(`
        currentExport = {
            running:true, status:'fetching', exportMode:'bookmarks', username:'', userId:'current-account',
            userInfo:{ name:'', screenName:'' }, settings:{ quantityLimit:500 },
            tweetBuffer:[], tweetCount:0, totalBatches:0, cursor:'kept', completionReason:null
        };
        bookmarkContextRateLimiter = null;
    `, harness.context);
    await assert.rejects(vm.runInContext('_fetchBookmarksLoop()', harness.context), /ABORTED/);
    assert.equal(vm.runInContext('currentExport.cursor', harness.context), 'kept',
        'an aborted page must not advance the cursor');
}

// ---------------------------------------------------------------- item 5

async function testDateSearch429UsesUserWaitBudget() {
    const limited = (extra = {}) => ({ url: 'page-1', status: 429, bodyText: '', ...extra });
    const harness = createSearchHarness([
        limited(), limited(), limited(), limited(),
        searchPage([{ id: '1' }], null, 'page-1')
    ]);
    // Fake clock: each wait advances time so the budget is measured exactly.
    vm.runInContext(`
        (() => {
            let offset = 0;
            const realNow = Date.now;
            Date.now = () => realNow() + offset;
            swSleep = async (ms) => { __sleeps.push(ms); offset += ms; };
        })();
        currentExport.settings.aboutAccountMaxRetries = 60;
    `, harness.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context);
    assert.deepEqual(harness.context.__sleeps, [60000, 120000, 240000, 480000],
        'unknown reset: start at 60 s and double; four 429s no longer exhaust a 3-strike budget');
    assert.equal(harness.getSavedState().completionReason, 'source_exhausted');

    // Relayed x-rate-limit-reset wins over the default backoff.
    const withReset = createSearchHarness([searchPage([{ id: '1' }], null, 'page-1')]);
    withReset.context.__resetPayload = limited();
    vm.runInContext(`
        __resetPayload.rateLimitReset = Math.floor(Date.now() / 1000) + 90;
        __pages.unshift(__resetPayload);
    `, withReset.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', withReset.context);
    assert.equal(withReset.context.__sleeps.length, 1);
    assert(withReset.context.__sleeps[0] > 85000 && withReset.context.__sleeps[0] <= 92000,
        `wait must follow the advertised reset, got ${withReset.context.__sleeps[0]}`);

    const laterReset = createSearchHarness([searchPage([{ id: '1' }], null, 'page-1')]);
    laterReset.context.__resetPayload = limited();
    vm.runInContext(`
        currentExport.settings.aboutAccountMaxRetries=60;
        __resetPayload.rateLimitReset=Math.floor(Date.now()/1000)+1800;
        __pages.unshift(__resetPayload);
    `, laterReset.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', laterReset.context);
    assert(laterReset.context.__sleeps[0] >= 1800000 && laterReset.context.__sleeps[0] <= 1801000,
        'a valid advertised reset must not be shortened to the fallback window');

    // The total wait is bounded by the user's setting (minimum one window).
    const exhausted = createSearchHarness(Array.from({ length: 10 }, () => limited()));
    vm.runInContext(`
        (() => {
            let offset = 0;
            const realNow = Date.now;
            Date.now = () => realNow() + offset;
            swSleep = async (ms) => { __sleeps.push(ms); offset += ms; };
        })();
        currentExport.settings.aboutAccountMaxRetries = 15;
    `, exhausted.context);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', exhausted.context), /RATE_LIMITED/);
    const total = exhausted.context.__sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.equal(total, 15 * 60000, `all waits must fit the 15-minute budget, got ${total}`);
}

async function testDateSearchGraphqlLimitsUseUserWaitBudget() {
    const limited = { url: 'page-1', status: 200,
        bodyText: JSON.stringify({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }) };
    const harness = createSearchHarness([
        limited, limited, limited, limited, searchPage([{ id: '1' }], null, 'page-1')
    ]);
    // Load the real API classifier so this checks the worker/API contract.
    vm.runInContext(source('utils/api.js'), harness.context);
    vm.runInContext(`
        (() => {
            let offset=0;
            const realNow=Date.now;
            Date.now=()=>realNow()+offset;
            swSleep=async(ms)=>{__sleeps.push(ms);offset+=ms;};
        })();
        currentExport.settings.aboutAccountMaxRetries=60;
    `, harness.context);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context);
    assert.deepEqual(harness.context.__sleeps, [60000,120000,240000,480000],
        'GraphQL code 88 in HTTP 200 must receive the same budget as HTTP 429');
    assert.equal(harness.getSavedState().completionReason, 'source_exhausted');
}

async function testSwSleepStopsPromptlyForStop() {
    const harness = createWorkerHarness();
    vm.runInContext('currentExport = { running: true }', harness.context);
    const started = Date.now();
    const sleeping = vm.runInContext('swSleep(60000)', harness.context);
    setTimeout(() => vm.runInContext('currentExport.running = false', harness.context), 50);
    await sleeping;
    assert(Date.now() - started < 2000, 'Stop must interrupt a date-search 429 wait');
}

// ---------------------------------------------------------------- item 6

function createProtectedHarness({ fetchUserTweets }) {
    const harness = createWorkerHarness();
    harness.context.__limiter = passThroughLimiter();
    harness.context.XPorterAPI.getUserByScreenName = async () => ({
        id: '1', screenName: 'locked', name: 'Locked', isProtected: true, tweetCount: 3
    });
    harness.context.XPorterAPI.getAccountAbout = async () => { throw new Error('unavailable'); };
    harness.context.XPorterAPI.fetchUserTweets = fetchUserTweets;
    vm.runInContext(`
        rateLimiter = __limiter;
        XPorterStorage.MAX_TWEETS_PER_BATCH = 50;
        currentExport = {
            running:true, status:'resolving_user', exportMode:'posts', outputFormat:'csv', username:'locked',
            userId:null, userInfo:null, settings:${JSON.stringify(explicitSelection({ includeOriginalPosts: true }))},
            tweetBuffer:[], tweetCount:0, totalBatches:0, cursor:null, postFeedPlan:['posts'], postFeedIndex:0,
            startedAt:1, completionReason:null
        };
        rateLimiter = __limiter;
    `, harness.context);
    return harness;
}

async function testProtectedAccountIsOnlyPrivateWhenRefusedOrEmpty() {
    const readable = createProtectedHarness({
        fetchUserTweets: async () => ({
            tweets: [{ id: '11', type: 'tweet', author_username: 'locked', _author_id: '1' }],
            nextCursor: null
        })
    });
    await vm.runInContext('launchExportLoop("test:"); exportLoopPromise', readable.context);
    assert.equal(readable.getSavedState().status, 'complete',
        'the owner or an approved follower can export a protected account');
    assert.deepEqual(readable.getSavedBatches().flat().map(row => row.id), ['11']);

    for (const [label, fetchUserTweets] of [
        ['empty first page', async () => ({ tweets: [], nextCursor: null })],
        ['refused first page', async () => { throw new Error('AUTH_ERROR'); }],
        ['unavailable first page', async () => { throw new Error('USER_UNAVAILABLE'); }]
    ]) {
        const harness = createProtectedHarness({ fetchUserTweets });
        await vm.runInContext('launchExportLoop("test:"); exportLoopPromise', harness.context);
        assert.equal(harness.getSavedState().status, 'error', label);
        assert.equal(harness.getSavedState().error, 'ACCOUNT_PRIVATE', label);
    }

    // A public account with an empty first page keeps its ordinary outcome.
    const publicEmpty = createProtectedHarness({ fetchUserTweets: async () => ({ tweets: [], nextCursor: null }) });
    publicEmpty.context.XPorterAPI.getUserByScreenName = async () => ({ id: '1', screenName: 'open', isProtected: false });
    await vm.runInContext('launchExportLoop("test:"); exportLoopPromise', publicEmpty.context);
    assert.equal(publicEmpty.getSavedState().status, 'complete');
}

// ---------------------------------------------------------------- item 7

function finishedStoppedState(overrides = {}) {
    return {
        running: false, status: 'stopped', exportMode: 'posts', outputFormat: 'csv',
        username: 'target', userId: '10', userInfo: { id: '10', screenName: 'target' },
        tweetCount: 2, totalBatches: 1, cursor: null, completionReason: 'source_exhausted',
        postFeedPlan: ['posts'], postFeedIndex: 0, startedAt: 1,
        settings: explicitSelection({ includeOriginalPosts: true }),
        ...overrides
    };
}

async function testStopAfterSourceExhaustedCompletesAndResumeRefuses() {
    // (a) Stop lands after the last page was committed.
    const harness = createWorkerHarness();
    harness.context.__limiter = passThroughLimiter();
    harness.context.XPorterAPI.fetchUserTweets = async () => ({
        tweets: [{ id: '5', type: 'tweet', author_username: 'target', _author_id: '10' }], nextCursor: null
    });
    const saveState = harness.context.XPorterStorage.saveExportState;
    harness.context.XPorterStorage.saveExportState = async (state) => {
        if (state.running && state.completionReason === 'source_exhausted') {
            vm.runInContext('currentExport.running = false', harness.context);
        }
        return saveState(state);
    };
    vm.runInContext(`
        rateLimiter = __limiter;
        XPorterStorage.MAX_TWEETS_PER_BATCH = 50;
        currentExport = {
            running:true, status:'fetching', exportMode:'posts', outputFormat:'csv', username:'target',
            userId:'10', userInfo:{ id:'10', screenName:'target' },
            settings:${JSON.stringify(explicitSelection({ includeOriginalPosts: true }))},
            tweetBuffer:[], tweetCount:0, totalBatches:0, cursor:null, postFeedPlan:['posts'], postFeedIndex:0,
            startedAt:1, completionReason:null
        };
    `, harness.context);
    await vm.runInContext('launchExportLoop("test:"); exportLoopPromise', harness.context);
    assert.equal(harness.getSavedState().status, 'complete',
        'a Stop after the source was proven exhausted must not leave a resumable stopped state');

    // (b) An old stopped state with an exhausted source becomes complete on Resume.
    const resume = createWorkerHarness();
    let launches = 0;
    resume.context.launchExportLoop = () => { launches += 1; };
    resume.setSavedState(finishedStoppedState());
    assert.equal((await vm.runInContext('getExportStatus()', resume.context)).canResume, false);
    const refused = await vm.runInContext('_resumeExportInner(100)', resume.context);
    assert.equal(refused.success, true);
    assert.equal(refused.status, 'complete');
    assert.equal(launches, 0, 'Resume must not restart an exhausted feed from a null cursor');
    assert.equal(resume.getSavedState().status, 'complete');
    assert.equal(resume.getSavedState().tweetCount, 2);
    assert.equal(resume.getSavedHistory()?.itemCount, 2, 'the finished run gets its history entry');

    // (c) Stopped between two planned feeds: Resume continues with the next feed.
    const midPlan = createWorkerHarness();
    midPlan.context.launchExportLoop = () => {};
    midPlan.context.createRateLimiter = () => passThroughLimiter();
    midPlan.setSavedState(finishedStoppedState({
        postFeedPlan: ['posts', 'replies'], postFeedIndex: 0, cursor: null,
        settings: explicitSelection({ includeOriginalPosts: true, includeReplies: true })
    }));
    assert.equal((await vm.runInContext('getExportStatus()', midPlan.context)).canResume, true);
    const resumed = await vm.runInContext('_resumeExportInner()', midPlan.context);
    assert.equal(resumed.success, true);
    assert.equal(midPlan.getSavedState().postFeedIndex, 1);
    assert.equal(midPlan.getSavedState().cursor, null);
    assert.equal(midPlan.getSavedState().running, true);
}

async function testHistoryFailureNeverTurnsCompleteIntoError() {
    const harness = createWorkerHarness();
    harness.context.__limiter = passThroughLimiter();
    harness.context.XPorterAPI.fetchUserTweets = async () => ({
        tweets: [{ id: '5', type: 'tweet', author_username: 'target', _author_id: '10' }], nextCursor: null
    });
    harness.context.XPorterStorage.saveExportHistory = async () => { throw new Error('QUOTA_BYTES'); };
    vm.runInContext(`
        rateLimiter = __limiter;
        XPorterStorage.MAX_TWEETS_PER_BATCH = 50;
        currentExport = {
            running:true, status:'fetching', exportMode:'posts', outputFormat:'csv', username:'target',
            userId:'10', userInfo:{ id:'10', screenName:'target' },
            settings:${JSON.stringify(explicitSelection({ includeOriginalPosts: true }))},
            tweetBuffer:[], tweetCount:0, totalBatches:0, cursor:null, postFeedPlan:['posts'], postFeedIndex:0,
            startedAt:1, completionReason:null
        };
    `, harness.context);
    await vm.runInContext('launchExportLoop("test:"); exportLoopPromise', harness.context);
    const saved = harness.getSavedState();
    assert.equal(saved.status, 'complete');
    assert.equal(saved.error ?? null, null);

    // A failed batch read keeps the history entry, only without row payload.
    const history = createWorkerHarness();
    history.context.XPorterStorage.loadAllTweets = async () => { throw new Error('STORAGE_READ_FAILED'); };
    vm.runInContext(`currentExport = { exportMode:'posts', username:'target', userInfo:{ screenName:'target' },
        tweetCount:2, settings:{}, outputFormat:'csv', completedAt:1 }`, history.context);
    await vm.runInContext('saveCompletedExportHistory()', history.context);
    assert.equal(history.getSavedHistory().itemCount, 2);
    assert.equal(history.getSavedHistory().items, undefined);

    // Date-range Resume must not silently skip de-duplication on a read failure.
    const dateResume = createSearchHarness([searchPage([{ id: 'saved' }])]);
    dateResume.context.XPorterStorage.loadAllTweets = async () => { throw new Error('STORAGE_READ_FAILED'); };
    vm.runInContext('currentExport.tweetCount=1;currentExport.totalBatches=1;currentExport.dateResume=true;',
        dateResume.context);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', dateResume.context), /STORAGE_READ_FAILED/);
    assert.deepEqual(dateResume.getSavedBatches().flat(), []);
}

// ---------------------------------------------------------------- item 8

async function testLivePacingKeepsActiveFeedEndpoint() {
    const harness = createWorkerHarness();
    const keys = [];
    harness.context.XPorterAPI.getRateLimit = (key) => { keys.push(key); return null; };
    const reconfigured = [];
    harness.context.__limiter = passThroughLimiter({ reconfigure(options) { reconfigured.push(options); } });
    harness.context.XPorterAPI.fetchUserTweets = async () => {
        // A settings change arrives while the replies feed is running.
        vm.runInContext('applyLivePacingSettings({ requestDelay: 2500 })', harness.context);
        return { tweets: [], nextCursor: null };
    };
    vm.runInContext(`
        rateLimiter = __limiter;
        currentExport = {
            running:true, status:'fetching', exportMode:'posts', username:'target', userId:'10',
            userInfo:{ id:'10', screenName:'target' },
            settings:${JSON.stringify(explicitSelection({ includeReplies: true }))},
            tweetBuffer:[], tweetCount:1, totalBatches:1, cursor:null, postFeedPlan:['replies'], postFeedIndex:0,
            completionReason:null
        };
    `, harness.context);
    await vm.runInContext('_fetchPostsLoop()', harness.context);
    assert.equal(vm.runInContext('currentExport.activeProfileFeed', harness.context), 'replies');
    assert.equal(reconfigured.length, 2, 'feed start and the live change both reconfigure');
    for (const options of reconfigured) options.rateLimitProvider();
    assert.deepEqual(keys, ['UserRepliesTimeline', 'UserRepliesTimeline'],
        'a live pacing change must keep the active feed endpoint budget');
}

// ---------------------------------------------------------------- item 9

async function testStopDuringSearchTabOpeningReturnsPromptly() {
    // Real tab/payload helpers: a regression would sit out the 20 s initial
    // response timeout here.
    const harness = createWorkerHarness();
    vm.runInContext(source('utils/api-parsers.js'), harness.context);
    vm.runInContext(`
        currentExport = {
            username:'test',userId:'1',userInfo:{screenName:'test'},exportMode:'posts',outputFormat:'csv',
            dateFrom:new Date('2026-09-05T00:00:00Z'),dateTo:new Date('2026-09-05T23:59:59.999Z'),
            dateSnapshotAt:Date.parse('2026-09-05T12:00:00Z'),startedAt:Date.parse('2026-09-05T12:00:00Z'),
            running:true,status:'fetching',settings:{quantityLimit:500},tweetBuffer:[],tweetCount:0,totalBatches:0,
            cursor:null,completionReason:null
        };
        rateLimiter={totalRequests:0,batchSize:20,getState:()=>({}),abort(){}};
        sendSearchCaptureStatus=async()=>true;
    `, harness.context);
    const removed = [];
    harness.context.chrome.tabs.create = async () => {
        // Stop arrives while Chrome is still creating the tab.
        harness.context.__stopping = vm.runInContext('stopExport()', harness.context);
        return { id: 7 };
    };
    harness.context.chrome.tabs.remove = async (tabId) => { removed.push(tabId); };
    const started = Date.now();
    await vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context);
    assert(Date.now() - started < 2000, 'Stop during tab creation must not wait for X');
    assert.deepEqual(removed, [7], 'the just-created search tab must be closed');
    assert.equal((await harness.context.__stopping).success, true);
    assert.equal(vm.runInContext('searchCapture', harness.context), null);

    // A wait that starts after Stop resolves immediately.
    const idle = createWorkerHarness();
    vm.runInContext(`currentExport = { running: false };
        searchCapture = { tabId: 1, queue: [], resolver: null, seenUrls: new Set() };`, idle.context);
    const waitStarted = Date.now();
    assert.equal(await vm.runInContext('waitForSearchCapturePayload(20000)', idle.context), null);
    assert(Date.now() - waitStarted < 500);
    assert(vm.runInContext('STOP_UNWIND_WAIT_MS', idle.context) < 5000,
        'STOP_EXPORT must answer inside the popup message timeout');
}

// ---------------------------------------------------------------- item 10

async function testSearchStallCountsPagesWithoutNewIds() {
    // Advancing cursors with the same rows used to reset the stall counter
    // forever; only new unique IDs are progress now.
    const repeated = Array.from({ length: 10 }, (_, index) =>
        searchPage([{ id: 'same' }], `cursor-${index + 1}`));
    const harness = createSearchHarness(repeated);
    await assert.rejects(vm.runInContext('_fetchPostsByDateRangeLoop()', harness.context), /SEARCH_STALLED/);
    assert.equal(harness.context.__pages.length, 6,
        'the first page plus three pages without new IDs, then SEARCH_STALLED');
    assert.equal(harness.getSavedState().tweetCount, 1);

    // New IDs — even ones filtered out as another author's — are progress.
    const progressing = createSearchHarness([
        searchPage([{ id: 'a' }], 'c1'),
        searchPage([{ id: 'foreign-1', authorId: '2' }], 'c2'),
        searchPage([{ id: 'foreign-2', authorId: '2' }], 'c3'),
        searchPage([{ id: 'foreign-3', authorId: '2' }], 'c4'),
        searchPage([{ id: 'b' }])
    ]);
    await vm.runInContext('_fetchPostsByDateRangeLoop()', progressing.context);
    assert.deepEqual(progressing.getSavedBatches().flat().map(row => row.id), ['a', 'b']);
    assert.equal(progressing.getSavedState().completionReason, 'source_exhausted');
}

// ---------------------------------------------------------------- item 11

async function testOrphanedSearchTabIsClosedOnRepair() {
    const opened = createWorkerHarness();
    opened.context.chrome.tabs.create = async () => ({ id: 55 });
    vm.runInContext(`
        currentExport = { running:true, status:'fetching', exportMode:'posts', username:'test', settings:{},
            tweetBuffer:[], tweetCount:0, totalBatches:0 };
        rateLimiter = { getState: () => ({}) };
    `, opened.context);
    await vm.runInContext("openSearchCaptureTab('(from:test)')", opened.context);
    assert.equal(opened.getSavedState().searchTabId, 55, 'the search tab must be persisted for SW-death repair');
    await vm.runInContext('closeSearchCaptureTab()', opened.context);
    await vm.runInContext('saveCurrentState()', opened.context);
    assert.equal(opened.getSavedState().searchTabId, null);

    const searchUrl = 'https://x.com/search?q=%28from%3Atest%29&src=typed_query&f=live';
    for (const [url, expectedRemoved] of [[searchUrl, [55]], ['https://x.com/home', []]]) {
        const harness = createWorkerHarness();
        const removed = [];
        harness.context.chrome.tabs.get = async (tabId) => ({ id: tabId, url });
        harness.context.chrome.tabs.remove = async (tabId) => { removed.push(tabId); };
        harness.setSavedState({ running: true, status: 'fetching', exportMode: 'posts', userId: '1',
            tweetCount: 0, totalBatches: 0, searchTabId: 55, settings: {} });
        vm.runInContext('currentExport = null', harness.context);
        const status = await vm.runInContext('getExportStatus()', harness.context);
        assert.equal(status.status, 'stopped');
        assert.deepEqual(removed, expectedRemoved, `repair must close only an X search tab (${url})`);
        assert.equal(harness.getSavedState().searchTabId, null);
    }

    // The same repair runs as soon as a worker wakes, and marks the badge.
    const woke = createWorkerHarness();
    const removed = [];
    const badges = [];
    woke.context.chrome.tabs.get = async (tabId) => ({ id: tabId, url: searchUrl });
    woke.context.chrome.tabs.remove = async (tabId) => { removed.push(tabId); };
    woke.context.chrome.action.setBadgeText = ({ text }) => badges.push(text);
    woke.setSavedState({ running: true, status: 'fetching', exportMode: 'posts', searchTabId: 55, settings: {} });
    await vm.runInContext('repairInterruptedExportOnWake()', woke.context);
    assert.deepEqual(removed, [55]);
    assert.equal(woke.getSavedState().status, 'stopped');
    assert.equal(woke.getSavedState().running, false);
    assert.deepEqual(badges, ['II']);
}

// ---------------------------------------------------------------- item 12

async function testRuntimeMessagesEnforceSenderPolicy() {
    const harness = createWorkerHarness();
    harness.context.chrome.runtime.getURL = (path = '') => EXTENSION_ROOT + path;
    const usernames = [];
    let activeMs = 0;
    harness.context.XPorterStorage.saveDetectedUsername = async (name) => { usernames.push(name); };
    harness.context.XPorterStorage.addActiveMs = async (ms) => { activeMs += ms; };
    harness.setSavedState({ running: false, status: 'complete', exportMode: 'posts', tweetCount: 1, totalBatches: 1 });

    const popup = { id: 'test-extension', url: EXTENSION_ROOT + 'popup/popup.html', origin: EXTENSION_ROOT.slice(0, -1) };
    const popupTab = { ...popup, tab: { id: 3, url: EXTENSION_ROOT + 'popup/popup.html' } };
    const xPage = { id: 'test-extension', url: 'https://x.com/home', origin: 'https://x.com',
        tab: { id: 9, url: 'https://x.com/home' } };
    const spoofedTab = { ...xPage, url: 'https://evil.example/', origin: 'https://evil.example' };
    const evilPage = { id: 'test-extension', url: 'https://evil.example/', origin: 'https://evil.example',
        tab: { id: 10, url: 'https://evil.example/' } };
    const otherExtension = { id: 'other', url: 'chrome-extension://other/popup.html' };
    const fakePopupFromTab = { id: 'test-extension', url: EXTENSION_ROOT + 'popup/popup.html',
        tab: { id: 11, url: 'https://x.com/home' } };

    for (const [sender, message] of [
        [xPage, { type: 'CLEAR_EXPORT' }],
        [xPage, { type: 'START_EXPORT', username: 'x', exportMode: 'posts' }],
        [xPage, { type: 'SAVE_SETTINGS', settings: { quantityLimit: 1 } }],
        [xPage, { type: 'GET_EXPORT_HISTORY' }],
        [xPage, { type: 'XP_ACTIVE_TICK', ms: 1000 }],
        [evilPage, { type: 'SET_USERNAME', username: 'evil' }],
        [spoofedTab, { type: 'SET_USERNAME', username: 'spoofed' }],
        [otherExtension, { type: 'GET_SETTINGS' }],
        [fakePopupFromTab, { type: 'CLEAR_EXPORT' }],
        [{}, { type: 'GET_STATUS' }]
    ]) {
        assert.deepEqual(plain(await harness.dispatchRuntime(message, sender)), { error: 'FORBIDDEN' },
            `${message.type} from ${sender.url || 'unknown'} must be rejected`);
    }
    assert.equal(harness.wasCleared(), false, 'a forbidden message has no side effects');
    assert.deepEqual(usernames, []);
    assert.equal(activeMs, 0);

    assert.deepEqual(plain(await harness.dispatchRuntime({ type: 'SET_USERNAME', username: 'ada' }, xPage)),
        { success: true });
    assert.deepEqual(usernames, ['ada']);
    assert.equal((await harness.dispatchRuntime({ type: 'GET_SETTINGS' }, popup)).settings.quantityLimit, 500);
    assert.deepEqual(plain(await harness.dispatchRuntime({ type: 'XP_ACTIVE_TICK', ms: 1000 }, popup)),
        { success: true }, 'usage-tracker ticks from the popup still pass');
    assert.equal(activeMs, 1000);
    assert.equal((await harness.dispatchRuntime({ type: 'GET_STATUS' }, popupTab)).status, 'complete',
        'an extension page opened as a tab is still an extension page');
    assert.deepEqual(plain(await harness.dispatchRuntime({ type: 'STOP_EXPORT' }, xPage)), { success: true },
        'the in-page overlay Stop button remains allowed');

    // Relay payloads are re-validated here, not only in the content world.
    const oversizedText = { id: '1234567890', text: 'x'.repeat(25001) };
    assert.deepEqual(plain(await harness.dispatchRuntime({ type: 'CAPTURE_FEED_POSTS', operationName: 'HomeTimeline',
        posts: [oversizedText] }, xPage)), { error: 'INVALID_POSTS' });
    assert.deepEqual(plain(await harness.dispatchRuntime({ type: 'CAPTURE_FEED_POSTS', operationName: 'HomeTimeline',
        posts: [{ id: 'not-a-post', text: 'x' }] }, xPage)), { error: 'INVALID_POSTS' });
    vm.runInContext("currentExport={running:true};searchCapture={tabId:9,rawQuery:'(from:test)',queue:[],resolver:null,seenUrls:new Set()};",
        harness.context);
    const url = 'https://x.com/i/api/graphql/q/SearchTimeline?variables=' +
        encodeURIComponent(JSON.stringify({ rawQuery: '(from:test)', product: 'Latest' }));
    for (const message of [
        { status: 0, bodyText: '{}' },
        { bodyText: '{}' },
        { status: 200, bodyText: 'x'.repeat(8 * 1024 * 1024 + 1) }
    ]) {
        const result = await harness.dispatchRuntime({ type: 'PAGE_GRAPHQL_RESPONSE', operationName: 'SearchTimeline',
            url, ...message }, xPage);
        assert.deepEqual(plain(result), { ignored: true });
    }
    assert.equal(vm.runInContext('searchCapture.queue.length', harness.context), 0);
}

async function testStopDuringPageCommitKeepsUnprocessedRowsResumable() {
    for (const nextCursor of [null, 'next-page']) {
        for (const mode of ['date', 'followers']) {
            const rows = [{ id: '1' }, { id: '2' }];
            const harness = mode === 'date'
                ? createSearchHarness([searchPage(rows, nextCursor)])
                : createWorkerHarness();
            harness.context.__limiter = passThroughLimiter();
            if (mode === 'followers') {
                harness.context.XPorterAPI.fetchFollowers = async () => ({ users: rows, nextCursor });
                vm.runInContext(`
                    rateLimiter=__limiter;
                    currentExport={running:true,status:'fetching',exportMode:'followers',username:'test',
                        userId:'1',userInfo:{id:'1',screenName:'test'},settings:{quantityLimit:500},
                        tweetBuffer:[],tweetCount:0,totalBatches:0,cursor:'current-page',completionReason:null};
                `, harness.context);
            }
            vm.runInContext('XPorterStorage.MAX_TWEETS_PER_BATCH=1', harness.context);
            const saveBatch = harness.context.XPorterStorage.saveTweetBatch;
            harness.context.XPorterStorage.saveTweetBatch = async (...args) => {
                const result = await saveBatch(...args);
                vm.runInContext('currentExport.running=false', harness.context);
                return result;
            };
            await vm.runInContext('launchExportLoop("test:");exportLoopPromise', harness.context);
            const state = harness.getSavedState();
            assert.equal(state.tweetCount, 1, `${mode}: Stop interrupts after the first committed row`);
            assert.equal(state.status, 'stopped', `${mode}: an incomplete page must remain resumable`);
            assert.equal(state.completionReason, null, `${mode}: the unread remainder is not source exhaustion`);
            assert.equal(state.cursor, mode === 'date' ? null : 'current-page',
                `${mode}: Resume must refetch this page instead of skipping its remainder`);
            assert.equal((await vm.runInContext('getExportStatus()', harness.context)).canResume, true);

            harness.context.XPorterStorage.saveTweetBatch = saveBatch;
            harness.context.createRateLimiter = () => passThroughLimiter();
            if (mode === 'date') harness.context.__pages = [searchPage(rows)];
            else harness.context.XPorterAPI.fetchFollowers = async () => ({ users: rows, nextCursor: null });
            await vm.runInContext('_resumeExportInner().then(() => exportLoopPromise)', harness.context);
            assert.equal(harness.getSavedState().status, 'complete', `${mode}: replay completes normally`);
            assert.deepEqual(harness.getSavedBatches().flat().map(row => row.id), ['1', '2'],
                `${mode}: Resume saves the unread row without duplicating the committed row`);
        }
    }
}

const tests = [
    ['startup survives a storage read failure', async () => {
        const harness = createWorkerHarness();
        const badges = [];
        const warnings = [];
        let discovered = false;
        harness.context.chrome.action.setBadgeText = ({ text }) => badges.push(text);
        harness.context.XLog.warn = (...args) => warnings.push(args.join(' '));
        harness.context.XPorterStorage.loadExportState = async () => { throw new Error('STORAGE_READ_FAILED'); };
        harness.context.XPorterAPI.discoverEndpoints = async () => { discovered = true; };
        await harness.dispatchStartup();
        assert.equal(discovered, true, 'an unavailable export state must not block independent startup work');
        assert.equal(harness.wasCleared(), false);
        assert.deepEqual(badges, [], 'unreadable state is not an empty state');
        assert(warnings.some(line => line.includes('STORAGE_READ_FAILED')));
    }],
    ['Stop during page commit preserves unread rows', testStopDuringPageCommitKeepsUnprocessedRowsResumable],
    ['replies-only selection never offers posts-only fallback', testRepliesOnlySelectionNeverOffersPostsOnlyFallback],
    ['bookmark reply context runs outside the primary limiter', testBookmarkReplyContextRunsOutsidePrimaryLimiter],
    ['date search 429 uses the user wait budget', testDateSearch429UsesUserWaitBudget],
    ['date search GraphQL rate limits use the user wait budget', testDateSearchGraphqlLimitsUseUserWaitBudget],
    ['date search waits stop promptly', testSwSleepStopsPromptlyForStop],
    ['protected account is private only when refused or empty', testProtectedAccountIsOnlyPrivateWhenRefusedOrEmpty],
    ['Stop after source exhaustion completes; Resume refuses', testStopAfterSourceExhaustedCompletesAndResumeRefuses],
    ['history failure keeps a complete export complete', testHistoryFailureNeverTurnsCompleteIntoError],
    ['live pacing keeps the active feed endpoint', testLivePacingKeepsActiveFeedEndpoint],
    ['Stop during search tab opening returns promptly', testStopDuringSearchTabOpeningReturnsPromptly],
    ['search stall counts pages without new IDs', testSearchStallCountsPagesWithoutNewIds],
    ['orphaned search tab is closed on repair', testOrphanedSearchTabIsClosedOnRepair],
    ['runtime messages enforce the sender policy', testRuntimeMessagesEnforceSenderPolicy]
];

(async () => {
    const failures = [];
    for (const [name, test] of tests) {
        try {
            await test();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL ${name}: ${error.stack || error.message}`);
        }
    }
    if (failures.length > 0) process.exitCode = 1;
    else console.log(`Worker lifecycle tests passed (${tests.length} tests)`);
})();
