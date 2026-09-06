'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { source } = require('./support.js');

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
        // Inspect the worksheet entry, not incidental text elsewhere in the ZIP.
        const sheet = execFileSync('unzip', ['-p', workbookPath, 'xl/worksheets/sheet1.xml'], {encoding:'utf8'});
        const idCell = [...sheet.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
            .find(cell => /\br="A2"/.test(cell[1]));
        assert(idCell, 'the first data row must have an ID cell');
        assert.match(idCell[1], /\bt="inlineStr"/, 'long IDs must be text cells, not rounded spreadsheet numbers');
        assert.match(idCell[2], /<t\b[^>]*>2075277820528607704<\/t>/);
        assert(sheet.includes('Привет &amp; hello'), 'Unicode text must be in the worksheet itself');
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

async function testDownloadModulePreservesCurrentExportContract() {
    let downloadRecorded = 0;
    let feedbackRefreshes = 0;
    let txtProfile = null;
    let xlsxProfile = null;
    let xlsxMediaAssets = null;
    let photoFetches = 0;
    const photoFetchUrls = [];
    const progressEvents = [];
    let photoPermissionState = 'granted';
    let photoEmbeddingEnabled = true;
    let photoPermissionChecks = 0;
    let settingsLoads = 0;
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
            photoFetchUrls.push(String(url));
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
            EMBEDDED_PHOTO_PREVIEW_MAX_BYTES: 100,
            EMBEDDED_PHOTO_XLSX_PART_MAX_BYTES: 30,
            STORAGE_BATCH_READ_SIZE: 100
        },
        XPorterStorage: {
            async loadTweetBatches() {
                return [[{
                    id: '12345',
                    text: 'hello',
                    media_type: 'photo',
                    media_urls: [
                        'https://pbs.twimg.com/media/download-test.png',
                        'https://pbs.twimg.com/media/download-test-2.png'
                    ].join(', ')
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
                settingsLoads += 1;
                return {
                    localizeExportHeaders: false,
                    language: 'en',
                    embedPostPhotos: photoEmbeddingEnabled,
                    embedBookmarkPhotos: photoEmbeddingEnabled
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
                    photoPermissionChecks += 1;
                    if (photoPermissionState === 'error') {
                        throw new Error('permissions unavailable');
                    }
                    return photoPermissionState === 'granted';
                }
            },
            runtime: {
                lastError: null,
                sendMessage: async (message) => {
                    progressEvents.push(JSON.parse(JSON.stringify(message)));
                    return {};
                },
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
    assert.equal(photoFetches, 2, 'granted photo access must fetch each requested preview');
    assert.deepEqual(
        photoFetchUrls,
        [
            'https://pbs.twimg.com/media/download-test.png?name=small',
            'https://pbs.twimg.com/media/download-test-2.png?name=small'
        ],
        'embedded Excel previews must request bounded X thumbnails'
    );
    assert.equal(xlsxMediaAssets?.length, 1);
    assert(
        xlsxMediaAssets[0].bytes.length <= 30,
        'the retained preview package must stay within its aggregate byte budget'
    );
    assert.deepEqual(
        progressEvents
            .filter(event => event.type === 'DOWNLOAD_PROGRESS' && event.stage === 'photos')
            .map(event => [event.photoCurrent, event.photoTotal]),
        [[0, 2], [1, 2], [2, 2]],
        'photo progress must start at zero and advance for every settled preview'
    );
    assert(
        progressEvents.some(event =>
            event.type === 'DOWNLOAD_PROGRESS' && event.stage === 'building_xlsx'
        ),
        'the download protocol must report workbook assembly after photos'
    );

    photoEmbeddingEnabled = false;
    const permissionChecksBeforeLinks = photoPermissionChecks;
    await context.XPorterDownloads.downloadCurrent('xlsx');
    assert.equal(photoFetches, 2,
        'the links-only Excel mode must never fetch photo bytes');
    assert.equal(photoPermissionChecks, permissionChecksBeforeLinks,
        'the links-only Excel mode must not ask for optional photo access');
    assert.equal(xlsxMediaAssets, null);

    photoEmbeddingEnabled = true;
    photoPermissionState = 'denied';
    await context.XPorterDownloads.downloadCurrent('xlsx');
    assert.equal(photoFetches, 2,
        'revoked photo access must keep the URL-only workbook without fetching media');
    assert.equal(xlsxMediaAssets, null);

    photoPermissionState = 'error';
    await context.XPorterDownloads.downloadCurrent('xlsx');
    assert.equal(photoFetches, 2,
        'a permissions API failure must fail closed and keep the URL-only workbook');
    assert.equal(xlsxMediaAssets, null);

    const settingsLoadsBeforeDetached = settingsLoads;
    const detached = await context.XPorterDownloads.startCurrentDownload('csv');
    assert.equal(detached.started, true);
    assert.equal(typeof keepAliveCallback, 'function',
        'detached downloads must keep the MV3 worker alive');
    keepAliveCallback();
    assert.equal(keepAliveTouches, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        settingsLoads,
        settingsLoadsBeforeDetached + 1,
        'a detached download must use one settings snapshot for its plan and files'
    );
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

const tests = [
    { name: "real XLSX OOXML", run: testXlsxIsRealOoxmlZip, order: 14 },
    { name: "photo XLSX Media sheet", run: testXlsxEmbedsMultiplePhotosOnSeparateMediaSheet, order: 15 },
    { name: "post XLSX profile metadata", run: testPostsXlsxStartsWithProfileMetadata, order: 16 },
    { name: "detailed user-list columns opt-in", run: testDetailedUserListColumnsAreOptIn, order: 17 },
    { name: "AI-friendly posts TXT", run: testPostsTxtIsAiFriendly, order: 18 },
    { name: "sequential TXT reply chains", run: testPostsTxtUsesSequentialNumbersAndExplainsReplyChains, order: 19 },
    { name: "quoted post context in TXT", run: testPostsTxtIncludesQuotedPostContextFromTimelinePayload, order: 20 },
    { name: "quoted post unavailable metrics", run: testQuotedPostContextOmitsMetricsMissingFromTimelinePayload, order: 21 },
    { name: "post XLSX empty-column omission", run: testPostsXlsxOmitsColumnsWithoutValues, order: 22 },
    { name: "compact saved formats", run: testSavedFormatsOmitEmptyFieldsButKeepZerosAndFalse, order: 23 },
    { name: "reply context across formats", run: testReplyContextIsRenderedAcrossExportFormats, order: 24 },
    { name: "download module contract", run: testDownloadModulePreservesCurrentExportContract, order: 31 },
    { name: "large downloads split incrementally", run: testLargeDownloadsAreSplitAndReadIncrementally, order: 32 },
    { name: "seen-post download compaction", run: testSeenPostDownloadsOmitEmptyFields, order: 33 },
    { name: "anonymous uninstall module", run: testUninstallFeedbackModuleKeepsAnonymousContract, order: 34 },
    { name: "XLSX truncation stays valid", run: testXlsxCellTruncationKeepsXmlValid, order: 59 }
];

module.exports = {
    id: "serialization-download",
    tests
};
