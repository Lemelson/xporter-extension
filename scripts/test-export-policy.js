#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const POLICY_FILE = 'background/export-policy.js';

function loadPolicy() {
    assert(
        fs.existsSync(path.join(ROOT, POLICY_FILE)),
        'export selection, pacing, and resume policy must live behind one classic-script facade'
    );
    const rateLimitKeys = [];
    const context = vm.createContext({
        globalThis: {},
        XPORTER_CONFIG: {
            SPEED_PRESETS: {
                standard: {
                    adaptiveFloor: 3000,
                    adaptivePad: 1000,
                    budgetFraction: 1,
                    raceReserve: 2,
                    fallbackScale: 2
                },
                fast: {
                    adaptiveFloor: 2000,
                    adaptivePad: 500,
                    budgetFraction: 1,
                    raceReserve: 2,
                    fallbackScale: 1
                }
            },
            CUSTOM_SPEED_LIMITS: {
                delaySec: [1, 15, 5],
                batch: [1, 100, 20],
                cooldownMin: [1, 60, 3]
            },
            FALLBACK_REQUEST_DELAYS: {
                posts: [4000, 5000],
                bookmarks: [6000, 7000],
                bookmark_context: [8000, 9000],
                following: [10_000, 11_000],
                about_account: [12_000, 13_000]
            },
            ABOUT_ACCOUNT_RETRY_RANGE: [1, 20, 5],
            ABOUT_ACCOUNT_BATCH_SIZES: {
                turtle: 1,
                careful: 3,
                standard: 5,
                fast: 10,
                turbo: 20
            },
            ABOUT_ACCOUNT_CUSTOM_BATCH_RANGE: [1, 50, 5]
        },
        parseLocalizedDecimal(value, fallback) {
            const parsed = Number(String(value ?? '').replace(',', '.'));
            return Number.isFinite(parsed) ? parsed : fallback;
        },
        XPorterAPI: {
            getRateLimit(key) {
                rateLimitKeys.push(key);
                return { key };
            }
        }
    });
    const source = fs.readFileSync(path.join(ROOT, POLICY_FILE), 'utf8');
    vm.runInContext(source, context, { filename: POLICY_FILE });
    return {
        policy: context.globalThis.XPorterExportPolicy,
        rateLimitKeys
    };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function testSelectionPolicy(policy) {
    assert.equal(policy.profileFeedForSettings({}), 'all');
    assert.equal(
        policy.profileFeedForSettings({ includeReplies: true }),
        'legacy_with_replies'
    );
    assert.equal(
        policy.profileFeedForSettings({ includeReplies: false }),
        'legacy_posts'
    );
    assert.equal(
        policy.profileFeedForSettings({ profileFeed: 'replies' }),
        'replies'
    );

    assert.deepEqual(
        plain(policy.postFeedPlanForSettings({ includeReplies: false })),
        ['legacy_posts']
    );
    assert.deepEqual(
        plain(policy.postFeedPlanForSettings({
            postSelectionVersion: 1,
            includeOriginalPosts: true,
            includeQuotes: false,
            includeReplies: true,
            includeRetweets: false,
            includeArticles: false
        })),
        ['posts', 'replies']
    );
    assert.deepEqual(
        plain(policy.postFeedPlanForSettings({
            postSelectionVersion: 1,
            includeOriginalPosts: false,
            includeQuotes: false,
            includeReplies: false,
            includeRetweets: true,
            includeArticles: false
        })),
        ['all']
    );
    assert.deepEqual(
        plain(policy.postFeedPlanForSettings({
            postSelectionVersion: 1,
            includeOriginalPosts: false,
            includeQuotes: false,
            includeReplies: false,
            includeRetweets: false,
            includeArticles: false
        })),
        []
    );

    const explicit = {
        postSelectionVersion: 1,
        includeOriginalPosts: true,
        includeQuotes: false,
        includeReplies: true,
        includeRetweets: false,
        includeArticles: true
    };
    assert.equal(policy.postSelectionAllowsTweet(explicit, { type: 'tweet' }), true);
    assert.equal(policy.postSelectionAllowsTweet(explicit, { type: 'reply' }), true);
    assert.equal(policy.postSelectionAllowsTweet(explicit, { type: 'article' }), true);
    assert.equal(policy.postSelectionAllowsTweet(explicit, { type: 'quote' }), false);
    assert.equal(policy.postSelectionAllowsTweet(explicit, { type: 'retweet' }), false);
    assert.equal(
        policy.postSelectionAllowsTweet(
            { includeReplies: false, includeRetweets: false, includeArticles: false },
            { type: 'reply' }
        ),
        false
    );
}

function testRateLimitKeys(policy) {
    assert.equal(policy.rateLimitKeyForMode('posts', {}), 'UserTweets');
    assert.equal(
        policy.rateLimitKeyForMode('posts', { profileFeed: 'posts' }),
        'UserOriginalsTimeline'
    );
    assert.equal(
        policy.rateLimitKeyForMode('posts', { profileFeed: 'replies' }),
        'UserRepliesTimeline'
    );
    assert.equal(
        policy.rateLimitKeyForMode('posts', { includeReplies: true }),
        'UserTweetsAndReplies'
    );
    assert.equal(policy.rateLimitKeyForMode('bookmarks', {}), 'Bookmarks');
    assert.equal(
        policy.rateLimitKeyForMode('bookmark_context', {}),
        'TweetResultsByRestIds'
    );
    assert.equal(policy.rateLimitKeyForMode('following', {}), 'Following');
    assert.equal(
        policy.rateLimitKeyForMode('about_account', {}),
        'AboutAccountQuery'
    );
}

function testPacingAndClamps(policy, rateLimitKeys) {
    const base = {
        requestDelay: 1500,
        batchSize: 20,
        cooldownDuration: 180000,
        adaptivePacing: true,
        exportSpeed: 'standard',
        userExportSpeed: 'fast'
    };
    const posts = policy.buildRateLimiterOptions(base, 'posts');
    assert.equal(posts.adaptiveFloor, 3000);
    assert.equal(posts.fallbackMinDelay, 8000);
    assert.equal(posts.fallbackMaxDelay, 10_000);
    assert.deepEqual(plain(posts.rateLimitProvider()), { key: 'UserTweets' });

    const bookmarks = policy.buildRateLimiterOptions({
        ...base,
        exportSpeed: 'custom',
        customDelaySec: '0,5',
        postSafetyBreakEnabled: true,
        postSafetyBreakEvery: 999,
        postSafetyBreakMin: 90
    }, 'bookmarks');
    assert.equal(bookmarks.adaptiveFloor, 1000);
    assert.equal(bookmarks.fallbackMinDelay, 1000);
    assert.equal(bookmarks.fallbackMaxDelay, 1000);
    assert.equal(bookmarks.batchSize, 100);
    assert.equal(bookmarks.cooldownDuration, 60 * 60_000);
    assert.equal(bookmarks.alwaysBatchCooldown, true);

    const users = policy.buildRateLimiterOptions({
        ...base,
        userExportSpeed: 'custom',
        userCustomDelaySec: 20,
        userSafetyBreakEnabled: true,
        userSafetyBreakEvery: 0,
        userSafetyBreakMin: 0
    }, 'following');
    assert.equal(users.adaptiveFloor, 15_000);
    assert.equal(users.fallbackMinDelay, 15_000);
    assert.equal(users.batchSize, 1);
    assert.equal(users.cooldownDuration, 60_000);
    assert.deepEqual(plain(users.rateLimitProvider()), { key: 'Following' });

    const about = policy.buildRateLimiterOptions({
        ...base,
        userExportSpeed: 'fast',
        aboutAccountMaxRetries: 999
    }, 'about_account');
    assert.equal(about.maxRetries, 20);
    assert.equal(policy.resolveAboutAccountMaxRetries({ aboutAccountMaxRetries: 0 }), 1);
    assert.equal(policy.resolveAboutAccountMaxRetries({}), 5);
    assert.deepEqual(
        rateLimitKeys,
        ['UserTweets', 'Following']
    );
}

function testAboutBatchSize(policy) {
    assert.equal(policy.resolveAboutAccountBatchSize({}), 5);
    assert.equal(
        policy.resolveAboutAccountBatchSize({ aboutAccountSpeed: 'turbo' }),
        20
    );
    assert.equal(
        policy.resolveAboutAccountBatchSize({
            aboutAccountSpeed: 'custom',
            aboutAccountCustomBatchSize: 999
        }),
        50
    );
    assert.equal(
        policy.resolveAboutAccountBatchSize({
            aboutAccountSpeed: 'custom',
            aboutAccountCustomBatchSize: 0
        }),
        1
    );
}

function testResumePolicy(policy) {
    const stored = {
        exportSpeed: 'careful',
        customDelaySec: 7,
        requestDelay: 777,
        includeRetweets: true,
        language: 'ru'
    };
    const snapshot = {
        postSelectionVersion: 1,
        includeOriginalPosts: true,
        includeReplies: false,
        includeRetweets: false,
        exportSpeed: 'turbo',
        customDelaySec: 1,
        snapshotOnly: 'kept'
    };
    const resumed = policy.buildResumeSettings(stored, snapshot);
    assert.equal(resumed.includeRetweets, false);
    assert.equal(resumed.snapshotOnly, 'kept');
    assert.equal(resumed.language, 'ru');
    assert.equal(resumed.exportSpeed, 'careful');
    assert.equal(resumed.customDelaySec, 7);
    assert.equal(resumed.requestDelay, 777);

    const legacy = policy.buildResumeSettings(
        { exportSpeed: 'standard' },
        {
            includeReplies: true,
            includeRetweets: false,
            legacyOnly: 'kept'
        }
    );
    assert.equal(legacy.profileFeed, 'legacy_with_replies');
    assert.equal(legacy.includeReplies, undefined);
    assert.equal(legacy.includeRetweets, false);
    assert.equal(legacy.legacyOnly, 'kept');
}

function testFacadeIsImmutable(policy) {
    assert(policy);
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.PACING_SETTING_KEYS), true);
    assert.throws(
        () => policy.PACING_SETTING_KEYS.push('drift'),
        error => error?.name === 'TypeError'
    );
    for (const name of [
        'profileFeedForSettings',
        'profileFeedAllowsTweet',
        'hasExplicitPostSelection',
        'postFeedPlanForSettings',
        'postSelectionAllowsTweet',
        'rateLimitKeyForMode',
        'clampCustomSpeed',
        'resolveAboutAccountMaxRetries',
        'resolveSpeedPreset',
        'resolveSafetyBreak',
        'buildRateLimiterOptions',
        'resolveAboutAccountBatchSize',
        'buildResumeSettings'
    ]) {
        assert.equal(typeof policy[name], 'function', `${name} must be public`);
    }
}

const tests = [
    ['selection and filtering', ({ policy }) => testSelectionPolicy(policy)],
    ['rate-limit keys', ({ policy }) => testRateLimitKeys(policy)],
    ['pacing and clamps', ({ policy, rateLimitKeys }) =>
        testPacingAndClamps(policy, rateLimitKeys)],
    ['About batch sizes', ({ policy }) => testAboutBatchSize(policy)],
    ['resume merge and migration', ({ policy }) => testResumePolicy(policy)],
    ['immutable facade', ({ policy }) => testFacadeIsImmutable(policy)]
];

(() => {
    const failures = [];
    for (const [name, test] of tests) {
        try {
            const harness = loadPolicy();
            test(harness);
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    if (failures.length > 0) process.exitCode = 1;
    else console.log('Export policy tests passed');
})();
