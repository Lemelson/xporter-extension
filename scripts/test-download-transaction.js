#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const downloadSource = fs.readFileSync(
    path.join(root, 'background/downloads.js'),
    'utf8'
);

class FakeFileReader {
    readAsDataURL() {
        this.result = 'data:text/csv;base64,eA==';
        this.onload();
    }
}

function createHarness(options = {}) {
    const generatedLanguages = [];
    const generatedMediaAssets = [];
    let settingsReads = 0;
    let downloadId = 0;
    let photoFetches = 0;
    let permissionChecks = 0;
    let keepAliveClears = 0;
    const sourceBatches = options.sourceBatches || [
        [{ id: '1' }],
        [{ id: '2' }]
    ];
    const settings = options.settings || {
        localizeExportHeaders: true,
        language: settingsReads === 1 ? 'en' : 'ru',
        embedPostPhotos: false,
        embedBookmarkPhotos: false
    };

    const context = vm.createContext({
        console,
        Blob,
        FileReader: FakeFileReader,
        URL,
        DataView,
        Uint8Array,
        AbortController,
        Response,
        setTimeout,
        clearTimeout,
        setInterval: options.fakeKeepAlive
            ? (() => 17)
            : setInterval,
        clearInterval: options.fakeKeepAlive
            ? ((timer) => {
                assert.equal(timer, 17);
                keepAliveClears += 1;
            })
            : clearInterval,
        fetch: options.fetch || (async () => {
            photoFetches += 1;
            return new Response(new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10,
                0, 0, 0, 13, 73, 72, 68, 82,
                0, 0, 0, 2, 0, 0, 0, 3
            ]), {
                status: 200,
                headers: { 'content-type': 'image/png' }
            });
        }),
        XLog: { error() {}, warn() {} },
        XPORTER_CONFIG: {
            DOWNLOAD_PART_LIMITS: {
                posts: { csv: 1, json: 1, xlsx: 1, txt: 1 },
                users: { csv: 1, json: 1, xlsx: 1 }
            },
            STORAGE_BATCH_READ_SIZE: 2,
            API_FETCH_TIMEOUT: options.photoFetchTimeoutMs,
            EMBEDDED_PHOTO_CACHE_MAX_BYTES: options.photoCacheMaxBytes
        },
        XPorterStorage: {
            async loadExportState() {
                return {
                    username: 'snapshot',
                    exportMode: 'posts',
                    outputFormat: 'csv',
                    tweetCount: sourceBatches.flat().length,
                    totalBatches: sourceBatches.length,
                    settings
                };
            },
            async loadTweetBatches(start, count) {
                return sourceBatches.slice(start, start + count);
            },
            async loadSettings() {
                settingsReads += 1;
                if (typeof options.settingsForRead === 'function') {
                    return options.settingsForRead(settingsReads);
                }
                return { ...settings };
            },
            async recordDownload() {}
        },
        XPorterPostDB: {
            async getAllPosts() {
                return [];
            }
        },
        XPorterCSV: {
            generateCSV(_items, _isUsers, headerOptions) {
                generatedLanguages.push(headerOptions.lang);
                return 'csv';
            },
            generatePostsText() {
                return 'txt';
            },
            generateXLSX(_items, _isUsers, xlsxOptions) {
                generatedMediaAssets.push(xlsxOptions.mediaAssets || []);
                return new Uint8Array([1]);
            },
            compactExportData(items) {
                return items;
            },
            generateExportFilename(_username, _mode, extension, filenameOptions) {
                return `part-${filenameOptions.partNumber || 1}.${extension}`;
            },
            selectPopulatedHeaders() {
                return ['id'];
            },
            escapeCSVValue(value) {
                return String(value ?? '');
            }
        },
        chrome: {
            permissions: {
                async contains() {
                    permissionChecks += 1;
                    return options.photoPermission !== false;
                }
            },
            runtime: {
                lastError: null,
                sendMessage() {
                    return Promise.resolve({});
                },
                getPlatformInfo(callback) {
                    callback?.({ os: 'mac' });
                }
            },
            downloads: {
                download(_downloadOptions, callback) {
                    downloadId += 1;
                    callback(downloadId);
                }
            }
        }
    });

    vm.runInContext(downloadSource, context, {
        filename: 'background/downloads.js'
    });

    return {
        downloads: context.XPorterDownloads,
        generatedLanguages,
        generatedMediaAssets,
        settingsReads: () => settingsReads,
        photoFetches: () => photoFetches,
        permissionChecks: () => permissionChecks,
        keepAliveClears: () => keepAliveClears
    };
}

async function testMultipartDownloadUsesOneSettingsSnapshot() {
    const harness = createHarness({
        settingsForRead(readNumber) {
            return {
                localizeExportHeaders: true,
                language: readNumber === 1 ? 'en' : 'ru',
                embedPostPhotos: false,
                embedBookmarkPhotos: false
            };
        }
    });

    const result = await harness.downloads.downloadCurrent('csv');

    assert.equal(result.success, true);
    assert.equal(harness.settingsReads(), 1,
        'one multipart download must read settings exactly once');
    assert.deepEqual(harness.generatedLanguages, ['en', 'en'],
        'all parts must use the same language snapshot');
}

async function testDuplicatePhotoUrlIsFetchedOncePerDownload() {
    const photoUrl = 'https://pbs.twimg.com/media/reused.png';
    const harness = createHarness({
        sourceBatches: [
            [{ id: '1', media_urls: photoUrl }],
            [{ id: '2', media_urls: photoUrl }]
        ],
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        }
    });

    const result = await harness.downloads.downloadCurrent('xlsx');

    assert.equal(result.success, true);
    assert.equal(harness.photoFetches(), 1,
        'the same photo URL must be fetched once for the whole download');
    assert.equal(harness.permissionChecks(), 1,
        'photo permission must be frozen once for the whole download');
    assert.deepEqual(
        harness.generatedMediaAssets.map(assets => assets.length),
        [1, 1],
        'each part must retain its own media relationship'
    );
}

async function testSettledPhotoCacheIsBoundedAcrossParts() {
    const firstPhotoUrl = 'https://pbs.twimg.com/media/first.png';
    const secondPhotoUrl = 'https://pbs.twimg.com/media/second.png';
    const harness = createHarness({
        sourceBatches: [
            [{ id: '1', media_urls: firstPhotoUrl }],
            [{ id: '2', media_urls: secondPhotoUrl }],
            [{ id: '3', media_urls: firstPhotoUrl }]
        ],
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        },
        // The deterministic PNG fixture is 24 bytes. One settled asset fits;
        // adding the second must evict the least-recently-used first asset.
        photoCacheMaxBytes: 24
    });

    const result = await harness.downloads.downloadCurrent('xlsx');

    assert.equal(result.success, true);
    assert.equal(harness.photoFetches(), 3,
        'an asset evicted from the byte-bounded cache must be fetched again');
}

async function testFailedPhotoFetchIsNotCached() {
    const photoUrl = 'https://pbs.twimg.com/media/retry.png';
    let fetchCalls = 0;
    const harness = createHarness({
        sourceBatches: [
            [{ id: '1', media_urls: photoUrl }],
            [{ id: '2', media_urls: photoUrl }]
        ],
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        },
        async fetch() {
            fetchCalls++;
            if (fetchCalls === 1) return new Response('', { status: 503 });
            return new Response(new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10,
                0, 0, 0, 13, 73, 72, 68, 82,
                0, 0, 0, 2, 0, 0, 0, 3
            ]), {
                status: 200,
                headers: { 'content-type': 'image/png' }
            });
        }
    });

    const result = await harness.downloads.downloadCurrent('xlsx');

    assert.equal(result.success, true);
    assert.equal(fetchCalls, 2,
        'a failed fetch must be removed so a later part can retry the URL');
    assert.deepEqual(
        harness.generatedMediaAssets.map(assets => assets.length),
        [0, 1]
    );
}

async function testHungPhotoFetchTimesOutAndReleasesDownload() {
    const harness = createHarness({
        sourceBatches: [[{
            id: '1',
            media_urls: 'https://pbs.twimg.com/media/hung.png'
        }]],
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        },
        photoFetchTimeoutMs: 5,
        fakeKeepAlive: true,
        fetch(_url, fetchOptions = {}) {
            return new Promise((_resolve, reject) => {
                fetchOptions.signal?.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        }
    });

    const started = await harness.downloads.startCurrentDownload('xlsx');
    assert.equal(started.success, true);

    await new Promise(resolve => setTimeout(resolve, 30));

    const plan = await harness.downloads.getCurrentPlan('xlsx');
    assert.equal(plan.active, false,
        'a timed-out photo must not leave the detached download active');
    assert.equal(harness.keepAliveClears(), 1,
        'detached download cleanup must clear its keepalive after a photo timeout');
}

async function main() {
    await testMultipartDownloadUsesOneSettingsSnapshot();
    await testDuplicatePhotoUrlIsFetchedOncePerDownload();
    await testSettledPhotoCacheIsBoundedAcrossParts();
    await testFailedPhotoFetchIsNotCached();
    await testHungPhotoFetchTimesOutAndReleasesDownload();
    console.log('Download transaction tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
