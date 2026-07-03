#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadScript(relativePath, context) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    vm.runInContext(source, context, { filename: relativePath });
}

const parserContext = vm.createContext({ window: {} });
loadScript('content/feed-parser.js', parserContext);
const parser = parserContext.window.XPorterFeedParser;

function tweetResult(id, options = {}) {
    return {
        __typename: 'Tweet',
        rest_id: id,
        core: {
            user_results: {
                result: {
                    rest_id: options.authorId || '42',
                    is_blue_verified: true,
                    core: { name: 'Ada', screen_name: 'ada' },
                    legacy: { followers_count: 1234 }
                }
            }
        },
        views: { count: options.views ?? '100' },
        legacy: {
            id_str: id,
            full_text: options.text || `Post ${id}`,
            created_at: 'Wed Jul 01 12:00:00 +0000 2026',
            lang: 'en',
            favorite_count: 10,
            retweet_count: 2,
            reply_count: 3,
            quote_count: 1,
            bookmark_count: 4,
            in_reply_to_status_id_str: options.replyTo || null
        },
        quoted_status_result: options.quoted
            ? { result: tweetResult('9999999999999999999') }
            : undefined
    };
}

const original = tweetResult('1111111111111111111', { quoted: true });
const reply = tweetResult('2222222222222222222', { replyTo: '1111111111111111111' });
const response = {
    data: {
        home: {
            instructions: [{
                entries: [
                    { content: { itemContent: { tweet_results: { result: original } } } },
                    { content: { itemContent: { tweet_results: { result: original } } } },
                    { content: { itemContent: { tweet_results: { result: reply } } } }
                ]
            }]
        }
    }
};

assert.strictEqual(parser.supportsOperation('HomeTimeline'), true);
assert.strictEqual(parser.supportsOperation('Followers'), false);
const posts = parser.extractPosts(JSON.stringify(response));
assert.strictEqual(posts.length, 2, 'deduplicates a response, includes visible quotes, and excludes replies');
assert.strictEqual(posts[0].id, '1111111111111111111');
assert.strictEqual(posts[1].id, '9999999999999999999');
assert.strictEqual(posts[0].author_followers_count, 1234);
assert.strictEqual(posts[0].reply_count, 3);
assert.strictEqual(posts[0].view_count, 100);
assert.strictEqual(parser.extractPosts('{invalid').length, 0);

const repostWrapper = tweetResult('3333333333333333333');
repostWrapper.legacy.retweeted_status_result = {
    result: tweetResult('4444444444444444444', { text: 'Canonical original' })
};
const repost = parser.parseTweet(repostWrapper);
assert.strictEqual(repost.id, '4444444444444444444', 'reposts use the visible original post ID');
assert.strictEqual(repost.text, 'Canonical original');
assert.strictEqual(repost.is_retweet, true);

const databaseContext = vm.createContext({ globalThis: {} });
loadScript('utils/post-database.js', databaseContext);
const database = databaseContext.globalThis.XPorterPostDB;
const existing = {
    id: posts[0].id,
    text: posts[0].text,
    author_username: 'ada',
    author_followers_count: 1234,
    first_author_followers_count: 1234,
    view_count: 100,
    first_view_count: 100,
    first_seen_at: 1000,
    last_seen_at: 1000,
    seen_count: 1
};
const merged = database.mergePost(existing, {
    ...existing,
    text: '',
    author_username: '',
    author_followers_count: 1300,
    view_count: 150,
    first_seen_at: 2000,
    last_seen_at: 2000,
    seen_count: 1
}, { operationName: 'HomeTimeline' }, 2000);

assert.strictEqual(merged.text, posts[0].text, 'missing later text does not erase stored text');
assert.strictEqual(merged.author_username, 'ada');
assert.strictEqual(merged.view_count, 150);
assert.strictEqual(merged.first_view_count, 100);
assert.strictEqual(merged.author_followers_count, 1300);
assert.strictEqual(merged.first_author_followers_count, 1234);
assert.strictEqual(merged.first_seen_at, 1000);
assert.strictEqual(merged.last_seen_at, 2000);
assert.strictEqual(merged.seen_count, 2);

console.log('Feed capture parser and deduplication tests passed.');
