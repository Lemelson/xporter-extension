#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createProductionRuntime, PRODUCTION_SOURCES } = require('../lib/production-runtime');
const { createScenarioTransport } = require('../lib/scenario-transport');
const { runProfile } = require('../lib/run-profile');

const LAB_ROOT = path.resolve(__dirname, '..');
const EXTENSION_ROOT = path.resolve(LAB_ROOT, '..');
const scenarios = JSON.parse(
    fs.readFileSync(path.join(LAB_ROOT, 'fixtures', 'profiles.json'), 'utf8')
);

function worksheetXml(workbook) {
    const archiveText = Buffer.from(workbook).toString('utf8');
    const start = archiveText.indexOf('<worksheet');
    const end = archiveText.indexOf('</worksheet>');
    assert.notEqual(start, -1, 'XLSX must contain worksheet XML');
    assert.notEqual(end, -1, 'XLSX worksheet XML must be complete');
    return archiveText.slice(start, end + '</worksheet>'.length);
}

function assertUniqueRows(rows, expectedCount, label) {
    assert.equal(rows.length, expectedCount, `${label}: expected row count`);
    assert.equal(
        new Set(rows.map((row) => row.id)).size,
        expectedCount,
        `${label}: every exported ID must be unique`
    );
}

test('loads the parser, API client, and export formatters from production source files', () => {
    const runtime = createProductionRuntime(async () => {
        throw new Error('network should not be used while loading production sources');
    });

    assert.equal(typeof runtime.api.fetchUserTweets, 'function');
    assert.equal(typeof runtime.api.fetchBookmarks, 'function');
    assert.equal(typeof runtime.api.fetchFollowers, 'function');
    assert.equal(typeof runtime.csv.generateCSV, 'function');
    assert.equal(typeof runtime.csv.generatePostsText, 'function');
    assert.equal(typeof runtime.csv.generateXLSX, 'function');
    assert.equal(typeof runtime.csv.compactExportData, 'function');
    assert.equal(typeof runtime.csv.selectPopulatedHeaders, 'function');

    for (const relativePath of PRODUCTION_SOURCES) {
        assert.equal(
            fs.existsSync(path.join(EXTENSION_ROOT, relativePath)),
            true,
            `${relativePath} must resolve to a real production file`
        );
        assert.equal(
            relativePath.startsWith('test-lab/'),
            false,
            'the lab must not maintain a copied implementation'
        );
    }
});

test('runs the current production API and serializers through every export mode offline', async () => {
    const scenario = scenarios[0];
    const transport = createScenarioTransport(scenario);
    const runtime = createProductionRuntime(transport.fetch);
    const result = await runProfile({ scenario, runtime });

    assert.equal(result.profile.screenName, scenario.username);
    assert.equal(result.posts.rows.length, 50);
    assert.equal(result.postsWithReplies.rows.length, 60);
    assert.equal(result.bookmarks.rows.length, 50);
    assert.equal(result.followers.rows.length, 50);
    assert.equal(result.following.rows.length, 50);
    assert.equal(result.verifiedFollowers.rows.length, 50);
    assert.equal(result.verifiedFollowers.rows.every((user) => user.verified), true);
    assertUniqueRows(result.posts.rows, 50, 'posts');
    assertUniqueRows(result.bookmarks.rows, 50, 'bookmarks');
    assertUniqueRows(result.followers.rows, 50, 'followers');
    assertUniqueRows(result.following.rows, 50, 'following');
    assertUniqueRows(result.verifiedFollowers.rows, 50, 'verified followers');

    const replies = result.postsWithReplies.rows.filter((post) => post.type === 'reply');
    assert.equal(replies.length, 10, 'Replies mode must add ten actual replies');
    const postIds = new Set(result.posts.rows.map((post) => post.id));
    assert.equal(
        replies.every((reply) => postIds.has(reply.reply_to_id)),
        true,
        'every synthetic reply must point to one of the 50 exported posts'
    );
    assert.equal(
        result.posts.rows.every((post) => Number.isFinite(Date.parse(post.created_at))),
        true,
        'all 50 post timestamps must be valid'
    );

    for (const mode of [
        result.posts,
        result.bookmarks,
        result.followers,
        result.following,
        result.verifiedFollowers
    ]) {
        assert.equal(mode.csv.charCodeAt(0), 0xFEFF, `${mode.mode}: CSV keeps the Excel BOM`);
        assert.deepEqual(
            JSON.parse(mode.json),
            JSON.parse(JSON.stringify(runtime.csv.compactExportData(mode.rows))),
            `${mode.mode}: JSON omits empty fields without changing rows`
        );
        assert.deepEqual(
            Array.from(mode.xlsx.subarray(0, 4)),
            [0x50, 0x4B, 0x03, 0x04],
            `${mode.mode}: XLSX is an OOXML ZIP`
        );
        for (const row of mode.rows) {
            assert.match(mode.csv, new RegExp(row.id), `${mode.mode}: CSV contains ${row.id}`);
            assert.match(
                worksheetXml(mode.xlsx),
                new RegExp(row.id),
                `${mode.mode}: XLSX contains ${row.id}`
            );
        }
        assert.match(worksheetXml(mode.xlsx), /<autoFilter /, `${mode.mode}: XLSX has filters`);
    }

    assert.match(result.posts.txt, new RegExp(`Username: @${scenario.username}`));
    assert.match(result.posts.txt, new RegExp(`POSTS \\(${result.posts.rows.length}\\)`));
    assert.match(result.posts.txt, new RegExp(`Account based in: ${scenario.accountBasedIn}`));
    assert.match(worksheetXml(result.posts.xlsx), new RegExp(scenario.accountBasedIn));
    assert.match(result.bookmarks.txt, /BOOKMARKS \(50\)/);
    assert.doesNotMatch(result.bookmarks.txt, /^PROFILE$/m);
    assert.equal(
        new Set(result.bookmarks.rows.map((post) => post.author_username)).size,
        50,
        'Bookmarks must keep posts from every saved author'
    );
    assert.match(
        transport.requests.find((url) => url.includes('/UserTweets?')),
        /%22count%22%3A50/,
        'Posts request must ask production API for 50 rows'
    );
    assert.match(
        transport.requests.find((url) => url.includes('/BlueVerifiedFollowers?')),
        /%22count%22%3A50/,
        'Verified Followers request must ask production API for 50 rows'
    );
    assert.match(
        transport.requests.find((url) => url.includes('/Bookmarks?')),
        /%22count%22%3A50/,
        'Bookmarks request must ask production API for 50 viewer-owned rows'
    );
    assert.equal(transport.unexpectedRequests.length, 0);
});

test('preserves every prepared post edge case through production parsing and export', async () => {
    const representativeScenarios = new Map();
    for (const scenario of scenarios) {
        if (!representativeScenarios.has(scenario.variant)) {
            representativeScenarios.set(scenario.variant, scenario);
        }
    }

    for (const [variant, scenario] of representativeScenarios) {
        const transport = createScenarioTransport(scenario);
        const runtime = createProductionRuntime(transport.fetch);
        const result = await runProfile({ scenario, runtime });
        const firstPost = result.posts.rows[0];

        if (variant === 'quote') {
            assert.equal(firstPost.type, 'quote');
            assert.equal(firstPost.quoted_post.author_username, 'quoted_author');
            assert.match(result.posts.txt, /Quoted post:/);
        } else if (variant === 'long-text') {
            assert.match(firstPost.text, /full long-form note/);
        } else if (variant === 'media') {
            assert.equal(firstPost.media_type, 'photo');
            assert.match(firstPost.media_alt_texts, /accessibility description/);
        } else if (variant === 'article') {
            assert.equal(firstPost.type, 'article');
            assert.match(firstPost.article_text, /full article body/);
        } else if (variant === 'formula') {
            assert.match(firstPost.text, /^=HYPERLINK/);
            assert.match(
                result.posts.csv,
                /'=HYPERLINK/,
                'CSV must neutralize spreadsheet formulas without altering JSON/TXT source text'
            );
        }
        assert.equal(transport.unexpectedRequests.length, 0, `${variant}: no live network fallback`);
    }
});
