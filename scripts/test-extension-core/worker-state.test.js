'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source } = require('./support.js');

const { createWorkerHarness } = require('./worker-harness.js');

async function testExportDataMutationsRespectDownloadLease() {
    const harness = createWorkerHarness();
    harness.setSavedState({
        running: false,
        status: 'complete',
        updatedAt: 1,
        exportMode: 'posts',
        tweetCount: 1,
        totalBatches: 1
    });
    harness.setDownloadActive(true);

    for (const message of [
        { type: 'CLEAR_EXPORT' },
        {
            type: 'START_EXPORT',
            username: 'target',
            exportMode: 'posts',
            outputFormat: 'csv'
        },
        { type: 'RESUME_EXPORT', extraItems: 1 },
        { type: 'RESUME_POSTS_ONLY' }
    ]) {
        const result = await harness.context.handleMessage(message, {});
        assert.deepEqual(
            JSON.parse(JSON.stringify(result)),
            { error: 'DOWNLOAD_IN_PROGRESS' },
            `${message.type} must not mutate batches while a download owns them`
        );
    }
    assert.equal(harness.wasCleared(), false,
        'a live download lease must protect every saved batch');

    await vm.runInContext('applyAutoExpiration()', harness.context);
    assert.equal(harness.wasCleared(), false,
        'automatic expiration must defer while a download owns the dataset');

    harness.setDownloadActive(false);
    vm.runInContext('exportStarting = true', harness.context);
    const blockedDownload = await harness.context.handleMessage({
        type: 'DOWNLOAD_EXPORT',
        outputFormat: 'csv'
    }, {});
    assert.deepEqual(
        JSON.parse(JSON.stringify(blockedDownload)),
        { error: 'ALREADY_RUNNING' },
        'a download must not start while an export mutation owns the dataset'
    );
    assert.equal(harness.downloadStarts(), 0);

    const blockedCopy = await harness.context.handleMessage({
        type: 'GET_EXPORT_TEXT'
    }, {});
    assert.deepEqual(
        JSON.parse(JSON.stringify(blockedCopy)),
        { error: 'ALREADY_RUNNING' },
        'Copy must not start while an export mutation owns the dataset'
    );
    assert.equal(harness.textReads(), 0);
}

async function testClearCannotRaceStartingOrResumingExport() {
    for (const message of [
        {
            type: 'START_EXPORT',
            username: 'target',
            exportMode: 'posts',
            outputFormat: 'csv'
        },
        { type: 'RESUME_EXPORT', extraItems: 1 },
        { type: 'RESUME_POSTS_ONLY' }
    ]) {
        const harness = createWorkerHarness();
        let releaseOperation;
        harness.context.__operationGate = new Promise(resolve => {
            releaseOperation = resolve;
        });
        const innerFunction = message.type === 'START_EXPORT'
            ? '_startExportInner'
            : '_resumeExportInner';
        vm.runInContext(`
            ${innerFunction} = async function () {
                await __operationGate;
                return { success: true };
            };
        `, harness.context);

        const operation = harness.context.handleMessage(message, {});
        await new Promise(resolve => setImmediate(resolve));
        const clearResult = await harness.context.handleMessage({
            type: 'CLEAR_EXPORT'
        }, {});

        assert.deepEqual(
            JSON.parse(JSON.stringify(clearResult)),
            { error: 'ALREADY_RUNNING' },
            `Clear must not overtake ${message.type}'s synchronous latch`
        );
        assert.equal(harness.wasCleared(), false);

        releaseOperation();
        assert.equal((await operation).success, true);
    }
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

async function testExplicitPostTypeSelectionUsesCombinedFeed() {
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
    }), ['legacy_with_replies'],
    'a mixed reply selection must use the one-pass combined timeline');
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
        if (hasNonReplies && settings.includeReplies) {
            expected.push('legacy_with_replies');
        } else if (hasNonReplies) {
            expected.push(settings.includeRetweets ? 'all' : 'posts');
        } else if (settings.includeReplies) {
            expected.push('replies');
        }
        assert.deepEqual(
            plan(settings),
            expected,
            `post selection combination ${mask.toString(2).padStart(selectionKeys.length, '0')} must use the exact feed plan`
        );
    }

    const harness = createWorkerHarness();
    const requestedFeeds = [];
    const rowsByFeed = {
        legacy_with_replies: [{
            id: 'original',
            type: 'tweet',
            author_username: 'TargetUser'
        }, {
            id: 'quote',
            type: 'quote',
            author_username: 'TargetUser'
        }, {
            id: 'reply',
            type: 'reply',
            author_username: 'TargetUser',
            reply_to_id: 'foreign-parent'
        }, {
            id: 'foreign-parent',
            type: 'tweet',
            author_username: 'OtherUser'
        }, {
            id: 'retweet',
            type: 'retweet',
            author_username: 'TargetUser'
        }, {
            id: 'article',
            type: 'article',
            author_username: 'TargetUser'
        }, {
            id: 'target-id-only',
            type: 'tweet',
            author_username: '',
            _author_id: '10'
        }, {
            id: 'foreign-id-only',
            type: 'tweet',
            author_username: '',
            _author_id: '999'
        }, {
            id: 'unknown-author',
            type: 'tweet',
            author_username: ''
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
                quantityLimit: 0
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

    assert.deepEqual(requestedFeeds, ['legacy_with_replies'],
        'a mixed selection must paginate one combined feed instead of two feeds');
    assert.deepEqual(
        harness.getSavedBatches().flat().map(item => item.id),
        ['original', 'quote', 'reply', 'target-id-only'],
        'the combined feed must keep exact selected target rows and remove foreign or unidentified primary rows'
    );
    assert.equal(
        harness.getSavedBatches().flat().at(-1).author_username,
        'TargetUser',
        'a target row identified only by stable author id may receive the profile display fields'
    );
    const saved = harness.getSavedState();
    assert.equal(saved.postFeedIndex, 0,
        'a one-pass combined export must persist the only feed index');

    const fallbackHarness = createWorkerHarness();
    const fallbackFeeds = [];
    const fallbackRows = {
        posts: [{
            id: 'fallback-original',
            type: 'tweet',
            author_username: 'TargetUser'
        }],
        replies: [{
            id: 'fallback-reply',
            type: 'reply',
            author_username: 'TargetUser'
        }]
    };
    fallbackHarness.context.XPorterAPI.fetchUserTweets =
        async (_userId, _cursor, _count, feed) => {
            fallbackFeeds.push(feed);
            if (feed === 'legacy_with_replies') {
                throw new Error('REPLIES_UNAVAILABLE');
            }
            return { tweets: fallbackRows[feed], nextCursor: null };
        };
    fallbackHarness.context.__makeRateLimiter = harness.context.__makeRateLimiter;

    await vm.runInContext(`
        currentExport = {
            running: true,
            username: 'targetuser',
            userId: '10',
            exportMode: 'posts',
            outputFormat: 'txt',
            userInfo: { screenName: 'TargetUser', tweetCount: 2 },
            settings: {
                postSelectionVersion: 1,
                includeOriginalPosts: true,
                includeQuotes: false,
                includeReplies: true,
                includeRetweets: false,
                includeArticles: false,
                quantityLimit: 0
            },
            tweetCount: 0,
            totalBatches: 0,
            tweetBuffer: [],
            cursor: null,
            postFeedPlan: ['legacy_with_replies'],
            postFeedIndex: 0
        };
        rateLimiter = __makeRateLimiter();
    `, fallbackHarness.context);
    await assert.rejects(
        vm.runInContext('_fetchPostsLoop()', fallbackHarness.context),
        /REPLIES_UNAVAILABLE/,
        'an unavailable combined endpoint must fail closed instead of silently starting two traversals'
    );
    assert.deepEqual(
        fallbackFeeds,
        ['legacy_with_replies'],
        'combined-feed failure must never expand into hidden Posts and Replies requests'
    );
    assert.deepEqual(
        fallbackHarness.getSavedBatches().flat(),
        [],
        'a failed combined request must not invent partial fallback rows'
    );
}

async function testLiveQuantityChangeUpdatesCombinedFeedLimit() {
    const harness = createWorkerHarness();
    const rowsByFeed = {
        legacy_with_replies: [
            ...['p1', 'p2', 'p3', 'p4'].map(id => ({
                id,
                type: 'tweet',
                author_username: 'TargetUser'
            })),
            ...['r1', 'r2', 'r3', 'r4'].map(id => ({
                id,
                type: 'reply',
                author_username: 'TargetUser'
            }))
        ]
    };
    let raised = false;
    harness.context.XPorterAPI.fetchUserTweets = async (_userId, _cursor, _count, feed) => {
        if (feed === 'legacy_with_replies' && !raised) {
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
        url: 'https://x.com/i/api/graphql/test/SearchTimeline?variables=' + encodeURIComponent(JSON.stringify({rawQuery:'(from:test) since:2026-01-01',product:'Latest'})),
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


async function testPageWriteFailureNeverAdvancesCursor() {
    for (const mode of ['posts', 'followers']) {
        const harness = createWorkerHarness();
        const broadcasts = [];
        const requestedCursors = [];
        harness.getSavedBatches()[0] = [{id:'already-saved'}];
        harness.context.chrome.runtime.sendMessage = async message => {
            if (message.type === 'EXPORT_STATUS_UPDATE') broadcasts.push({...message});
        };
        const originalSaveBatch = harness.context.XPorterStorage.saveTweetBatch;
        harness.context.XPorterStorage.saveTweetBatch = async () => false;
        const page = async (_userId, cursor) => {
            requestedCursors.push(cursor);
            const row = {id:'recoverable', author_username:'test', type:'tweet'};
            return {tweets:[row], users:[row], nextCursor:requestedCursors.length === 1 ? 'page-B' : null};
        };
        harness.context.XPorterAPI.fetchUserTweets = page;
        harness.context.XPorterAPI.fetchFollowers = page;
        harness.context.__mode = mode;
        await vm.runInContext(`
            createRateLimiter = () => ({
                executeWithRateLimit:fn=>fn(), totalRequests:0, batchSize:20,
                getState:()=>({}), restoreState(){}, onStatusChange(){}
            });
            currentExport={
                username:'test', userId:'1', userInfo:{id:'1',screenName:'test',tweetCount:10,followersCount:10},
                exportMode:__mode, outputFormat:'csv',
                settings:{quantityLimit:500,includeRetweets:true,includeReplies:false},
                tweetBuffer:[],tweetCount:1,totalBatches:1,cursor:'page-A',running:true,status:'fetching'
            };
            rateLimiter=createRateLimiter();
            XPorterStorage.MAX_TWEETS_PER_BATCH=50;
            launchExportLoop('test write failure');
            exportLoopPromise;
        `, harness.context);
        const failed = harness.getSavedState();
        assert.equal(failed.error, 'STORAGE_FULL');
        assert.equal(failed.status, 'error');
        assert.equal(failed.running, false);
        assert.equal(failed.cursor, 'page-A');
        assert.equal(failed.tweetCount, 1);
        assert.deepEqual(harness.getSavedBatches(), [[{id:'already-saved'}]]);
        assert.equal(broadcasts.at(-1).status, 'error');
        assert.equal(broadcasts.at(-1).canResume, true);
        assert(!broadcasts.some(event => event.status === 'complete'));

        // Restart the worker's in-memory state and drive its real Resume path.
        harness.context.XPorterStorage.saveTweetBatch = originalSaveBatch;
        vm.runInContext('currentExport=null', harness.context);
        const result = await vm.runInContext('_resumeExportInner()', harness.context);
        assert.equal(result.success, true);
        await vm.runInContext('exportLoopPromise', harness.context);
        assert.deepEqual(requestedCursors, ['page-A', 'page-A'], 'Resume must re-fetch the failed page');
        assert.deepEqual(harness.getSavedBatches().flat().map(row => row.id), ['already-saved','recoverable']);
        assert.equal(harness.getSavedState().status, 'complete');
        assert.equal(harness.getSavedState().tweetCount, 2);
    }
}


const tests = [
    { name: "page write failure preserves cursor", run: testPageWriteFailureNeverAdvancesCursor, order: 83 },
    { name: "download lease protects export batches", run: testExportDataMutationsRespectDownloadLease, order: 75 },
    { name: "Clear cannot race Start or Resume", run: testClearCannotRaceStartingOrResumingExport, order: 76 },
    { name: "explicit zero-row Replies fallback", run: testRepliesFallbackRequiresZeroRowsAndPreservesSnapshot, order: 35 },
    { name: "All feed profile filtering and context", run: testAllFeedKeepsOnlyProfilePostsAndContext, order: 36 },
    { name: "explicit post-type combined feed", run: testExplicitPostTypeSelectionUsesCombinedFeed, order: 37 },
    { name: "live combined-feed quantity retargeting", run: testLiveQuantityChangeUpdatesCombinedFeedLimit, order: 38 },
    { name: "Bookmarks mode and reply context", run: testBookmarksModeSkipsUsernameResolutionAndKeepsEverySavedAuthor, order: 39 },
    { name: "Bookmarks Article payload setting", run: testBookmarkArticleSettingRemovesOnlyArticlePayload, order: 40 },
    { name: "search capture arms before navigation", run: testSearchCaptureIsArmedBeforeNavigation, order: 41 },
    { name: "unexpected empty user list is not success", run: testUnexpectedEmptyUserListDoesNotComplete, order: 42 },
    { name: "user-list About details opt-in and cache", run: testUserListAboutDetailsAreOptInAndCached, order: 43 },
    { name: "About details selected batch concurrency", run: testAboutAccountDetailsUseSelectedBatchConcurrency, order: 44 },
    { name: "About details commit each finished batch", run: testAboutAccountDetailsCommitEachFinishedBatchImmediately, order: 45 },
    { name: "About details live batch speed change", run: testAboutAccountSpeedChangesApplyToTheNextBatch, order: 46 },
    { name: "About details cache expiry and bound", run: testAboutAccountCacheExpiresAndStaysBounded, order: 47 },
    { name: "unknown Following count never completes with zero rows", run: testUnknownFollowingCountCannotBecomeZeroRowSuccess, order: 48 },
    { name: "resume run loop preserves pacing and count", run: testResumeRunLoopPreservesLimiterAndCount, order: 49 },
    { name: "fresh export Account Based In", run: testFreshExportEnrichesProfileWithAccountRegion, order: 50 },
    { name: "About rate-limit wait survives popup reopen", run: testAboutRateLimitWaitSurvivesPopupReopen, order: 51 },
    { name: "export settings snapshot", run: testExportSnapshotSurvivesWorkerRestart, order: 52 },
    { name: "large completion skips history payload copy", run: testLargeCompletionSkipsHistoryPayloadCopy, order: 53 },
    { name: "cursor dedup memory is bounded", run: testCursorDedupMemoryIsBounded, order: 54 },
    { name: "resume pacing vs filters", run: testResumeKeepsFiltersButFollowsCurrentPacing, order: 55 },
    { name: "saved pacing applies live without changing filters", run: testSavedPacingChangesApplyToARunningExportOnly, order: 56 },
    { name: "independent post and user-list speeds", run: testPostsAndUserListsUseIndependentSpeedSettings, order: 57 },
    { name: "configurable About rate-limit retries", run: testAboutAccountRetriesAreConfigurable, order: 58 },
    { name: "persisted limit override", run: testPersistedLimitOverrideIsReported, order: 60 },
    { name: "stopped Resume ignores extra quantity", run: testStoppedResumeRejectsExtraQuantityOverride, order: 61 },
    { name: "terminal auto-expiration", run: testTerminalExportActuallyExpires, order: 62 },
    { name: "resume first-item telemetry", run: testResumeRecordsFirstNewItem, order: 63 },
    { name: "state write failure", run: testStateWriteFailureIsTerminal, order: 64 },
    { name: "date Resume rebuilds coverage from saved rows", run: testSavedDateRangeRowsAdvanceResumeCoverage, order: 65 },
    { name: "repeated post cursor terminates", run: testRepeatedPostCursorTerminatesWithoutHanging, order: 66 },
    { name: "repeated user-list cursor terminates", run: testRepeatedUserListCursorTerminatesWithoutHanging, order: 67 },
    { name: "profile feed defaults and migration", run: testProfileFeedDefaultsAndMigratesLegacyReplySetting, order: 73 }
];

module.exports = {
    id: "worker-state",
    tests
};
