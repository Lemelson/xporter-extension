#!/usr/bin/env node
'use strict';

// XLSX/CSV serializer contracts that need the real utils/csv.js and a strict
// look inside every package part. Run by test-download-transaction.js (and
// runnable on its own).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readZipEntries, assertXlsxPartsWellFormed } = require('./lib/xlsx-package.js');

const root = path.resolve(__dirname, '..');
const csvSource = fs.readFileSync(path.join(root, 'utils/csv.js'), 'utf8');

function loadCsv(extra = {}) {
    const context = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer, ...extra });
    vm.runInContext(csvSource, context, { filename: 'utils/csv.js' });
    return context.XPorterCSV;
}

const text = (entries, name) => entries.get(name)?.data.toString('utf8') || '';
const rowsOf = xml => [...xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];
const cellOf = (xml, ref) => xml.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`))?.[0] || '';

const HOSTILE = 'A￿B￾C\uD800D\uDC00EFGH 😀 end';

async function testXmlInvalidCharactersNeverReachThePackage() {
    const csv = loadCsv({ CompressionStream });
    assert.equal(csv.escapeXml('a\uD800b\uDC00c😀<&>"'), 'abc😀&lt;&amp;&gt;&quot;',
        'lone surrogates are removed; real pairs and escapes are kept');

    const items = Array.from({ length: 25 }, (_, index) => ({
        id: String(1000 + index),
        text: `${HOSTILE} #${index}`,
        author_name: 'Name￿',
        favorite_count: index
    }));
    const opts = {
        profile: { name: 'Profile￾', screenName: 'p', bio: `Bio ${HOSTILE}` },
        postSelection: { postSelectionVersion: 1, includeOriginalPosts: true }
    };
    for (const bytes of [csv.generateXLSX(items, false, opts), await csv.generateXLSXAsync(items, false, opts)]) {
        const entries = assertXlsxPartsWellFormed(bytes);
        const sheet = text(entries, 'xl/worksheets/sheet1.xml');
        assert.equal(rowsOf(sheet).length, items.length + 1, 'every data row must be present');
        assert(sheet.includes('ABCDEFGH 😀 end #24'), 'valid text around removed characters must remain');
        const profile = text(entries, 'xl/worksheets/sheet3.xml');
        assert(profile.includes('Bio ABCDEFGH 😀 end'));
        assert(profile.includes('Profile<'), 'profile values go through the same escaping');
    }
}

async function testDeflateIsUsedOnlyForXmlParts() {
    const assets = [{
        postId: '1', relation: 'post', sourceUrl: 'https://pbs.twimg.com/media/a.png',
        contentType: 'image/png', extension: 'png', width: 2, height: 3,
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9])
    }];
    const items = Array.from({ length: 200 }, (_, index) => ({
        id: String(index), text: 'repeated text '.repeat(10), media_urls: 'https://pbs.twimg.com/media/a.png'
    }));
    const compressedCsv = loadCsv({ CompressionStream });
    const stored = readZipEntries(compressedCsv.generateXLSX(items, false, { mediaAssets: assets }));
    const deflatedBytes = await compressedCsv.generateXLSXAsync(items, false, { mediaAssets: assets });
    const deflated = assertXlsxPartsWellFormed(deflatedBytes);

    assert.deepEqual([...deflated.keys()], [...stored.keys()]);
    for (const [name, entry] of deflated) {
        assert.deepEqual(entry.data, stored.get(name).data, `${name} must decompress to the stored bytes`);
        if (name.startsWith('xl/media/')) assert.equal(entry.method, 0, 'images must stay stored');
    }
    assert.equal(deflated.get('xl/worksheets/sheet1.xml').method, 8, 'worksheets must be deflated');
    const storedSize = compressedCsv.generateXLSX(items, false, { mediaAssets: assets }).length;
    assert(deflatedBytes.length * 5 < storedSize,
        `deflated workbook must be much smaller (${deflatedBytes.length} vs ${storedSize})`);

    const withoutCompression = loadCsv();
    const fallback = readZipEntries(await withoutCompression.generateXLSXAsync(items, false, {}));
    assert([...fallback.values()].every(entry => entry.method === 0),
        'without CompressionStream the workbook must fall back to STORE');
}

async function testCompressionFailureFallsBackWithoutUnhandledRejection() {
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
        const csv = loadCsv({
            CompressionStream: class {
                constructor() {
                    return new TransformStream({
                        transform() { throw new Error('simulated compressor failure'); }
                    });
                }
            }
        });
        const entries = assertXlsxPartsWellFormed(await csv.generateXLSXAsync([{ id: '1', text: 'keep me' }]));
        assert([...entries.values()].every(entry => entry.method === 0),
            'a failed compressor must produce the complete STORE fallback');
        assert(text(entries, 'xl/worksheets/sheet1.xml').includes('keep me'));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(unhandled, [], 'both halves of a failed compression stream must be observed');
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
}

function testDataSheetLayoutAndCells() {
    const csv = loadCsv();
    const entries = assertXlsxPartsWellFormed(csv.generateXLSX([
        { id: '2075277820528607704', text: '1.50', favorite_count: '12', view_count: 7, source: '' },
        { id: '2', text: 'second', source: 'Web' }
    ], false, { profile: { name: 'P', followersCount: 123 } }));
    const sheet = text(entries, 'xl/worksheets/sheet1.xml');

    assert.match(sheet, /<pane ySplit="1" topLeftCell="A2"/);
    assert.match(cellOf(sheet, 'A2'), /t="inlineStr"[\s\S]*2075277820528607704/, 'IDs stay text');
    assert.match(cellOf(sheet, 'B2'), /t="inlineStr"><is><t>1\.50<\/t>/,
        'numeric-looking post text must stay text');
    const favorite = rowsOf(sheet)[1][2].match(/<c r="([A-Z]+)2"><v>12<\/v><\/c>/);
    assert(favorite, 'known count columns must be numeric cells');
    assert(rowsOf(sheet)[1][2].includes('<v>7</v>'));
    assert(!/<c r="[A-Z]+2"[^>]*><is><t><\/t><\/is><\/c>/.test(sheet),
        'empty values must not produce empty string cells');
    const cellsInRow2 = rowsOf(sheet)[1][2].match(/<c /g).length;
    assert.equal(cellsInRow2, 4, 'row 2 has id, text, view_count and favorite_count only');

    const profile = text(entries, 'xl/worksheets/sheet3.xml');
    assert.match(profile, /<c r="B\d+" s="4"><v>123<\/v><\/c>/, 'profile counts remain numbers');
}

function testBookmarksAndUsersStartWithTheirHeader() {
    const csv = loadCsv();
    const bookmarks = readZipEntries(csv.generateXLSX([{ id: '1', text: 'x' }], false, { mode: 'bookmarks' }));
    assert(!bookmarks.has('xl/worksheets/sheet3.xml'), 'bookmarks have no profile sheet');
    assert.match(text(bookmarks, 'xl/worksheets/sheet1.xml'), /<row r="1"><c r="A1" s="3"/);

    const users = readZipEntries(csv.generateXLSX([{
        id: '1', name: 'N', bio: 'B', followers_count: 5, verified: false, profile_image_url: 'https://x'
    }], true, {}));
    const widths = [...text(users, 'xl/worksheets/sheet1.xml').matchAll(/<col min="(\d+)" max="\d+" width="(\d+)"/g)]
        .map(match => Number(match[2]));
    // id, name, bio, followers_count, verified, profile_image_url
    assert.deepEqual(widths, [22, 24, 44, 14, 14, 36], 'user-list widths must follow the column keys');
}

function testLongCellsAreVisiblyTruncated() {
    const csv = loadCsv();
    for (const value of ['a'.repeat(40000), 'a'.repeat(32754) + '😀'.repeat(10)]) {
        const sheet = text(readZipEntries(csv.generateXLSX([{ id: '1', text: value }])), 'xl/worksheets/sheet1.xml');
        const cell = cellOf(sheet, 'B2').match(/<t>([\s\S]*)<\/t>/)[1];
        assert(cell.endsWith('…[truncated]'), 'a cut cell must say so');
        assert(cell.length <= 32767, 'the marker must fit inside the Excel cell limit');
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cell), 'no half emoji before the marker');
    }
}

function testMediaSheetExplainsSkippedPhotos() {
    const csv = loadCsv();
    const asset = {
        postId: '1', relation: 'post', sourceUrl: 'https://pbs.twimg.com/media/a.png',
        contentType: 'image/png', extension: 'png', width: 2, height: 3,
        bytes: new Uint8Array([137, 80, 78, 71])
    };
    const entries = assertXlsxPartsWellFormed(csv.generateXLSX([{ id: '1' }], false, {
        mediaAssets: [asset], mediaSkippedCount: 3
    }));
    const media = text(entries, 'xl/worksheets/sheet2.xml');
    assert.match(media, /<row r="4"><c r="A4"[^>]*><is><t>3 more photos were not embedded/);
    assert.match(media, /<dimension ref="A1:E4"\/>/);
    assert.match(media, /<autoFilter ref="A1:D2"\/>/, 'the note must stay outside the filter range');
    const workbook = text(entries, 'xl/workbook.xml');
    assert.match(workbook, /name="Export"[^>]*r:id="rId1"\/><sheet name="Media" sheetId="2" r:id="rId2"/);
    assert.match(text(entries, 'xl/_rels/workbook.xml.rels'), /Id="rId3"[^>]*Target="styles.xml"/);

    const withoutNote = text(readZipEntries(csv.generateXLSX([{ id: '1' }], false, { mediaAssets: [asset] })),
        'xl/worksheets/sheet2.xml');
    assert(!withoutNote.includes('not embedded'));
}

function testSeenPostCsvMatchesTheLegacySerializer() {
    const csv = loadCsv();
    const headers = ['id', 'text', 'author_followers_count', 'author_verified', 'last_surface'];
    const rows = [
        { id: '1', text: '=cmd, "quoted"', author_followers_count: 0, author_verified: false, last_surface: '' },
        { id: '2', text: 'line\nbreak', author_followers_count: 12 }
    ];
    const selected = csv.selectPopulatedHeaders(rows, headers);
    const legacy = '﻿' + [
        selected.map(csv.escapeCSVValue).join(','),
        ...rows.map(row => selected.map(header => csv.escapeCSVValue(row[header])).join(','))
    ].join('\n') + '\n';
    assert.equal(csv.generateCSV(rows, true, { candidateHeaders: headers }), legacy);
}

async function testSeenPostFilenameUsesLocalTime() {
    const fixed = new Date(2026, 0, 2, 3, 4, 5).getTime();
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [fixed])); }
        static now() { return fixed; }
    }
    const filenames = [];
    class FakeFileReader {
        readAsDataURL() { this.result = 'data:,x'; this.onload(); }
    }
    const context = vm.createContext({
        Blob, Date: FixedDate, FileReader: FakeFileReader, TextEncoder, Uint8Array, DataView, ArrayBuffer,
        XLog: { error() {} }, XPORTER_CONFIG: {}, XPorterStorage: {},
        XPorterPostDB: { async getAllPosts() { return [{ id: '1', text: 'seen' }]; } },
        chrome: {
            runtime: { lastError: null },
            downloads: { download(options, callback) { filenames.push(options.filename); callback(1); } }
        }
    });
    vm.runInContext(csvSource, context, { filename: 'utils/csv.js' });
    vm.runInContext(fs.readFileSync(path.join(root, 'background/downloads.js'), 'utf8'), context,
        { filename: 'background/downloads.js' });
    assert.equal((await context.XPorterDownloads.downloadSeenPosts('csv')).success, true);
    assert.deepEqual(filenames, ['XPorter_seen_posts_2026-01-02-03-04-05.csv']);
}

async function testLegacyHistoryWithoutPostSelectionStillDownloads() {
    const filenames = [];
    const context = vm.createContext({
        Blob, TextEncoder, Uint8Array, DataView, ArrayBuffer,
        FileReader: class { readAsDataURL() { this.result = 'data:,x'; this.onload(); } },
        XLog: { error() {} }, XPORTER_CONFIG: {},
        XPorterStorage: {
            async loadExportHistoryEntry() {
                return { username: 'legacy', exportMode: 'posts', displayName: 'Legacy profile',
                    items: [{ id: '12345', text: 'Saved legacy text' }] };
            },
            async loadSettings() { return {}; },
            async recordDownload() {}
        },
        chrome: {
            runtime: { lastError: null },
            downloads: { download(options, callback) { filenames.push(options.filename); callback(1); } }
        }
    });
    vm.runInContext(csvSource, context);
    const legacyItems = [{ id: '12345', text: 'Saved legacy text' }];
    const legacyProfile = { name: 'Legacy profile' };
    const legacyOptions = { profile: legacyProfile, postSelection: null };
    const txt = context.XPorterCSV.generatePostsText(legacyItems, legacyProfile, legacyOptions);
    assert.ok(txt.includes('Saved legacy text'));
    assert.ok(!txt.includes('Included types:'), 'missing selection metadata must not invent selected types');
    const workbook = assertXlsxPartsWellFormed(context.XPorterCSV.generateXLSX(legacyItems, false, legacyOptions));
    assert.ok(text(workbook, 'xl/worksheets/sheet3.xml').includes('Legacy profile'));
    assert.ok(!text(workbook, 'xl/worksheets/sheet3.xml').includes('Included post types'));
    vm.runInContext(fs.readFileSync(path.join(root, 'background/downloads.js'), 'utf8'), context);
    for (const format of ['txt', 'xlsx']) {
        assert.equal((await context.XPorterDownloads.downloadHistory('legacy', format)).success, true,
            `${format} must remain downloadable for history saved before postSelection existed`);
    }
    assert.equal(filenames.length, 2);
    assert.ok(filenames[0].endsWith('.txt'));
    assert.ok(filenames[1].endsWith('.xlsx'));
}

const tests = [
    testLegacyHistoryWithoutPostSelectionStillDownloads,
    testXmlInvalidCharactersNeverReachThePackage,
    testDeflateIsUsedOnlyForXmlParts,
    testCompressionFailureFallsBackWithoutUnhandledRejection,
    testDataSheetLayoutAndCells,
    testBookmarksAndUsersStartWithTheirHeader,
    testLongCellsAreVisiblyTruncated,
    testMediaSheetExplainsSkippedPhotos,
    testSeenPostCsvMatchesTheLegacySerializer,
    testSeenPostFilenameUsesLocalTime
];

async function run() {
    for (const test of tests) await test();
    console.log(`XLSX export tests passed (${tests.length}).`);
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
