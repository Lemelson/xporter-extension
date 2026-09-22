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
    const generatedXlsxOptions = [];
    const savedStates = [];
    let settingsReads = 0;
    let stateReads = 0;
    let downloadId = 0;
    let photoFetches = 0;
    const photoFetchUrls = [];
    const progressEvents = [];
    let permissionChecks = 0;
    let keepAliveClears = 0;
    const pendingDownloadCallbacks = [];
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
        fetch: options.fetch || (async (url) => {
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
        }),
        XLog: { error() {}, warn() {} },
        XPORTER_CONFIG: {
            DOWNLOAD_PART_LIMITS: {
                posts: {
                    csv: 1,
                    json: 1,
                    xlsx: options.postXlsxPartLimit || 1,
                    txt: 1
                },
                users: { csv: 1, json: 1, xlsx: 1 }
            },
            STORAGE_BATCH_READ_SIZE: 2,
            API_FETCH_TIMEOUT: options.photoFetchTimeoutMs,
            EMBEDDED_PHOTO_CACHE_MAX_BYTES: options.photoCacheMaxBytes,
            EMBEDDED_PHOTO_PREVIEW_MAX_BYTES: options.photoMaxBytes,
            EMBEDDED_PHOTO_XLSX_PART_MAX_BYTES: options.photoPartMaxBytes,
            EMBEDDED_PHOTO_XLSX_TARGET_LIMIT: options.photoTargetLimit,
            EMBEDDED_PHOTO_XLSX_PART_LIMIT: options.photoPartLimit
        },
        XPorterStorage: {
            async loadExportState() {
                stateReads += 1;
                if (typeof options.loadExportState === 'function') {
                    return options.loadExportState({
                        readNumber: stateReads,
                        sourceBatches
                    });
                }
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
                if (typeof options.loadTweetBatches === 'function') {
                    return options.loadTweetBatches({ start, count, sourceBatches });
                }
                return sourceBatches.slice(start, start + count);
            },
            async loadSettings() {
                settingsReads += 1;
                if (typeof options.settingsForRead === 'function') {
                    return options.settingsForRead(settingsReads);
                }
                return { ...settings };
            },
            async saveExportState(state) {
                savedStates.push(state);
                return true;
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
            async generateXLSXAsync(_items, _isUsers, xlsxOptions) {
                generatedMediaAssets.push(xlsxOptions.mediaAssets || []);
                generatedXlsxOptions.push(xlsxOptions);
                return new Uint8Array([1]);
            },
            collectPopulatedHeaders(_items, _isUsers, _opts, into = new Set()) {
                into.add('id');
                return into;
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
                sendMessage(message) {
                    progressEvents.push(JSON.parse(JSON.stringify(message)));
                    return Promise.resolve({});
                },
                getPlatformInfo(callback) {
                    callback?.({ os: 'mac' });
                }
            },
            downloads: {
                download(_downloadOptions, callback) {
                    if (options.downloadThrows) throw new Error('downloads API unavailable');
                    downloadId += 1;
                    if (options.holdDownloads) {
                        pendingDownloadCallbacks.push(() => callback(downloadId));
                        return;
                    }
                    callback(downloadId);
                }
            }
        }
    });

    vm.runInContext(downloadSource, context, {
        filename: 'background/downloads.js'
    });

    return {
        context,
        downloads: context.XPorterDownloads,
        generatedLanguages,
        generatedMediaAssets,
        generatedXlsxOptions,
        savedStates,
        settingsReads: () => settingsReads,
        stateReads: () => stateReads,
        photoFetches: () => photoFetches,
        photoFetchUrls,
        progressEvents,
        permissionChecks: () => permissionChecks,
        keepAliveClears: () => keepAliveClears,
        releaseDownloads() {
            for (const callback of pendingDownloadCallbacks.splice(0)) callback();
        }
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
    assert.deepEqual(
        harness.photoFetchUrls,
        ['https://pbs.twimg.com/media/reused.png?name=small'],
        'XLSX must fetch a bounded preview instead of the original photo'
    );
    assert.equal(harness.permissionChecks(), 1,
        'photo permission must be frozen once for the whole download');
    assert.deepEqual(
        harness.generatedMediaAssets.map(assets => assets.length),
        [1, 1],
        'each part must retain its own media relationship'
    );
    assert(
        harness.progressEvents.some(event =>
            event.type === 'DOWNLOAD_PROGRESS' && event.stage === 'photos'
        ),
        'photo work must report its own progress stage'
    );
    assert(
        harness.progressEvents.some(event =>
            event.type === 'DOWNLOAD_PROGRESS' && event.stage === 'building_xlsx'
        ),
        'workbook assembly must be distinguishable from photo fetching'
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

async function testChunkedPhotoStopsAtByteLimit() {
    let readerCancelled = false;
    let readCount = 0;
    const harness = createHarness({
        sourceBatches: [[{
            id: '1',
            media_urls: 'https://pbs.twimg.com/media/chunked.png'
        }]],
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        },
        photoMaxBytes: 10,
        async fetch() {
            return {
                ok: true,
                headers: {
                    get(name) {
                        return name.toLowerCase() === 'content-type' ? 'image/png' : null;
                    }
                },
                body: {
                    getReader() {
                        return {
                            async read() {
                                readCount += 1;
                                if (readCount <= 2) {
                                    return { done: false, value: new Uint8Array(8) };
                                }
                                return { done: true };
                            },
                            async cancel() {
                                readerCancelled = true;
                            },
                            releaseLock() {}
                        };
                    }
                },
                async arrayBuffer() {
                    return new Uint8Array(16).buffer;
                }
            };
        }
    });

    const result = await harness.downloads.downloadCurrent('xlsx');

    assert.equal(result.success, true);
    assert.equal(readerCancelled, true,
        'a chunked response over the byte limit must be cancelled before full buffering');
    assert.deepEqual(harness.generatedMediaAssets.map(assets => assets.length), [0],
        'an oversized preview must fall back to its URL');
}

async function testPhotoPartBudgetDropsExcessAssets() {
    const harness = createHarness({
        sourceBatches: [[{
            id: '1',
            media_urls: [
                'https://pbs.twimg.com/media/one.png',
                'https://pbs.twimg.com/media/two.png'
            ].join(', ')
        }]],
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        },
        photoMaxBytes: 100,
        photoPartMaxBytes: 30
    });

    const result = await harness.downloads.downloadCurrent('xlsx');

    assert.equal(result.success, true);
    assert.deepEqual(harness.generatedMediaAssets.map(assets => assets.length), [1],
        'one workbook part must retain only photos that fit its aggregate byte budget');
}

async function testHeaderRejectedPhotoResponsesAreCancelled() {
    const cases = [
        {
            name: 'non-success status',
            response: {
                ok: false,
                headers: { get() { return null; } }
            }
        },
        {
            name: 'unsupported content type',
            response: {
                ok: true,
                headers: {
                    get(name) {
                        return name.toLowerCase() === 'content-type'
                            ? 'text/html'
                            : null;
                    }
                }
            }
        },
        {
            name: 'oversized declared body',
            response: {
                ok: true,
                headers: {
                    get(name) {
                        if (name.toLowerCase() === 'content-type') return 'image/png';
                        if (name.toLowerCase() === 'content-length') return '11';
                        return null;
                    }
                }
            }
        }
    ];

    for (const testCase of cases) {
        let cancelCalls = 0;
        const response = {
            ...testCase.response,
            body: {
                async cancel() {
                    cancelCalls += 1;
                }
            }
        };
        const harness = createHarness({
            sourceBatches: [[{
                id: '1',
                media_urls: 'https://pbs.twimg.com/media/rejected.png'
            }]],
            settings: {
                localizeExportHeaders: false,
                language: 'en',
                embedPostPhotos: true,
                embedBookmarkPhotos: false
            },
            photoMaxBytes: 10,
            async fetch() {
                return response;
            }
        });

        const result = await harness.downloads.downloadCurrent('xlsx');

        assert.equal(result.success, true, testCase.name);
        assert.equal(cancelCalls, 1,
            `${testCase.name} must cancel its response body immediately`);
        assert.deepEqual(harness.generatedMediaAssets.map(assets => assets.length), [0]);
    }
}

async function testActiveDownloadKeepsItsFrozenPlan() {
    const sourceBatches = [[{ id: '1' }]];
    const harness = createHarness({
        sourceBatches,
        holdDownloads: true,
        fakeKeepAlive: true,
        postXlsxPartLimit: 1000,
        photoPartLimit: 250,
        async loadExportState() {
            return {
                username: 'snapshot',
                exportMode: 'posts',
                outputFormat: 'xlsx',
                tweetCount: 500,
                totalBatches: sourceBatches.length,
                settings: {}
            };
        },
        settingsForRead(readNumber) {
            return {
                localizeExportHeaders: false,
                language: 'en',
                embedPostPhotos: readNumber > 1,
                embedBookmarkPhotos: false
            };
        }
    });

    const started = await harness.downloads.startCurrentDownload('xlsx');
    assert.deepEqual(
        {
            partSize: started.partSize,
            partCount: started.partCount,
            active: started.active
        },
        { partSize: 1000, partCount: 1, active: true }
    );
    assert.equal(harness.downloads.isCurrentDownloadActive(), true);

    const visiblePlan = await harness.downloads.getCurrentPlan('xlsx');
    assert.deepEqual(
        {
            partSize: visiblePlan.partSize,
            partCount: visiblePlan.partCount,
            active: visiblePlan.active
        },
        { partSize: 1000, partCount: 1, active: true },
        'mutable settings must not replace the plan frozen for the active download'
    );
    assert.equal(harness.settingsReads(), 1,
        'reading the active plan must not reload mutable settings');

    // Let workbook generation (asynchronous DEFLATE) reach the held handoff.
    await new Promise(resolve => setImmediate(resolve));
    harness.releaseDownloads();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.downloads.isCurrentDownloadActive(), false);
}

async function testTextCopyUsesTheCurrentDataReadLease() {
    let releaseBatches;
    const batchGate = new Promise(resolve => {
        releaseBatches = resolve;
    });
    const harness = createHarness({
        sourceBatches: [[{ id: '1' }]],
        async loadTweetBatches({ start, count, sourceBatches }) {
            await batchGate;
            return sourceBatches.slice(start, start + count);
        }
    });

    const textRead = harness.downloads.getCurrentPostsText();
    assert.equal(harness.downloads.isCurrentDataReadActive(), true,
        'Copy must reserve the dataset before its first asynchronous read');

    const competingDownload = await harness.downloads.startCurrentDownload('csv');
    assert.deepEqual(
        competingDownload,
        { error: 'DOWNLOAD_IN_PROGRESS' },
        'a file download must not read the same mutable batches beside Copy'
    );

    releaseBatches();
    const result = await textRead;
    assert.equal(result.success, true);
    assert.equal(harness.downloads.isCurrentDataReadActive(), false,
        'Copy must release the dataset after producing its text');
}

async function testConcurrentStartsReserveDownloadBeforeSnapshotRead() {
    let releaseState;
    const stateGate = new Promise(resolve => {
        releaseState = resolve;
    });
    const harness = createHarness({
        fakeKeepAlive: true,
        async loadExportState({ sourceBatches }) {
            await stateGate;
            return {
                username: 'snapshot',
                exportMode: 'posts',
                outputFormat: 'csv',
                tweetCount: sourceBatches.flat().length,
                totalBatches: sourceBatches.length,
                settings: {
                    localizeExportHeaders: false,
                    language: 'en',
                    embedPostPhotos: false,
                    embedBookmarkPhotos: false
                }
            };
        }
    });

    const firstStart = harness.downloads.startCurrentDownload('csv');
    const secondStart = harness.downloads.startCurrentDownload('csv');
    await new Promise(resolve => setImmediate(resolve));
    releaseState();

    const [first, second] = await Promise.all([firstStart, secondStart]);
    assert.equal(first.success, true);
    assert.deepEqual(second, { error: 'DOWNLOAD_IN_PROGRESS' },
        'the second caller must be rejected before it can build a competing snapshot');
    assert.equal(harness.stateReads(), 1,
        'only the lock owner may read export state for a detached download');

    await new Promise(resolve => setImmediate(resolve));
}

async function testCalendarLabelsSurviveDownloadAndHistory() {
    const state={username:'test',exportMode:'posts',tweetCount:2,totalBatches:2,settings:{},
        dateFrom:'2026-09-03T21:00:00.000Z',dateTo:'2026-09-04T20:59:59.999Z',
        dateFromCalendar:'2026-09-04',dateToCalendar:'2026-09-04'};
    const harness=createHarness({loadExportState:async()=>state});
    // Real filename formatter, including multipart and history call sites.
    const formatter=vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(root,'utils/csv.js'),'utf8'),formatter);
    harness.context.XPorterCSV.generateExportFilename=formatter.XPorterCSV.generateExportFilename;
    const current=await harness.downloads.downloadCurrent('csv');
    assert.equal(current.success,true);
    for(const filename of current.filenames) assert.match(filename,/_from_2026-09-04_to_2026-09-04_/);
    harness.context.XPorterStorage.loadExportHistoryEntry=async()=>({...state,items:[{id:'1'}]});
    const history=await harness.downloads.downloadHistory('test','csv');
    assert.equal(history.success,true);
    assert.match(history.filename,/_from_2026-09-04_to_2026-09-04_/);
}

async function waitForIdle(harness) {
    for (let attempt = 0; attempt < 200 && harness.downloads.isCurrentDownloadActive(); attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(harness.downloads.isCurrentDownloadActive(), false,
        'the detached download must settle and release its lock');
}

async function testFailedBatchReadIsNeverReportedAsComplete() {
    const harness = createHarness({
        fakeKeepAlive: true,
        async loadTweetBatches({ start }) {
            if (start > 0) throw new Error('STORAGE_READ_FAILED');
            return [[{ id: '1' }], [{ id: '2' }]];
        },
        sourceBatches: [[{ id: '1' }], [{ id: '2' }], [{ id: '3' }]]
    });

    const started = await harness.downloads.startCurrentDownload('csv');
    assert.equal(started.success, true);
    await waitForIdle(harness);

    const types = harness.progressEvents.map(event => event.type);
    assert(!types.includes('DOWNLOAD_COMPLETE'),
        'a failed batch read must not end as a completed download');
    const failure = harness.progressEvents.find(event => event.type === 'DOWNLOAD_ERROR');
    assert.deepEqual(failure, { type: 'DOWNLOAD_ERROR', source: 'current', error: 'STORAGE_READ_FAILED' });
    assert.deepEqual(harness.savedStates, [],
        'a failed download must never rewrite the saved export state');
}

async function testFailedStateReadReleasesDownloadReservation() {
    const harness = createHarness({
        fakeKeepAlive: true,
        async loadExportState({ readNumber, sourceBatches }) {
            if (readNumber === 1) throw new Error('STORAGE_READ_FAILED');
            return {
                username: 'snapshot', exportMode: 'posts', outputFormat: 'csv',
                tweetCount: sourceBatches.flat().length, totalBatches: sourceBatches.length,
                settings: {}
            };
        }
    });
    await assert.rejects(harness.downloads.startCurrentDownload('csv'), /STORAGE_READ_FAILED/);
    assert.equal(harness.downloads.isCurrentDataReadActive(), false,
        'an initial state-read failure must release the download reservation');
    assert.equal(harness.progressEvents.length, 0, 'a failed snapshot must not announce a completed download');
    assert.equal((await harness.downloads.startCurrentDownload('csv')).success, true,
        'a recovered storage read must permit retry');
    await waitForIdle(harness);
}

async function testShortSavedDataNeverLowersTheSavedCount() {
    const sourceBatches = [[{ id: '1' }], [{ id: '2' }]];
    const harness = createHarness({
        sourceBatches,
        async loadExportState() {
            return {
                username: 'snapshot', exportMode: 'posts', outputFormat: 'csv',
                tweetCount: 3, totalBatches: sourceBatches.length, settings: {}
            };
        }
    });

    const result = await harness.downloads.downloadCurrent('csv');
    assert.equal(result.success, true);
    assert.equal(result.count, 2, 'the result must report the rows actually written');
    assert.deepEqual(harness.savedStates, [],
        'a download must never lower the persisted export count');
    const complete = harness.progressEvents.find(event => event.type === 'DOWNLOAD_COMPLETE');
    assert.equal(complete.count, 2);
    assert.equal(complete.source, 'current');
}

async function testMultipartPartsShareOneColumnSet() {
    const harness = createHarness({
        sourceBatches: [
            [{ id: '1', text: 'first' }],
            [{ id: '2', text: 'second', hashtags: '#late' }]
        ],
        settings: { localizeExportHeaders: false, language: 'en' }
    });
    const real = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer });
    vm.runInContext(fs.readFileSync(path.join(root, 'utils/csv.js'), 'utf8'), real);
    const csvParts = [];
    harness.context.XPorterCSV.collectPopulatedHeaders = real.XPorterCSV.collectPopulatedHeaders;
    harness.context.XPorterCSV.generateCSV = (items, isUsers, opts) => {
        const csv = real.XPorterCSV.generateCSV(items, isUsers, opts);
        csvParts.push(csv);
        return csv;
    };

    const result = await harness.downloads.downloadCurrent('csv');
    assert.equal(result.success, true);
    assert.equal(result.partCount, 2);
    const headerRows = csvParts.map(csv => csv.slice(1).split('\n')[0]);
    assert.deepEqual(headerRows, ['id,text,hashtags', 'id,text,hashtags'],
        'a column populated only in part 2 must also exist in part 1');
    assert.equal(csvParts[0].split('\n')[1], '1,first,');

    // A single-part download keeps choosing columns from its own rows.
    const single = real.XPorterCSV.generateCSV([{ id: '1', text: 'only' }], false, {});
    assert.equal(single.slice(1).split('\n')[0], 'id,text');
}

async function testMultipartXlsxSharesNestedAndAccountColumns() {
    const { readZipEntries } = require('./lib/xlsx-package.js');
    const real = vm.createContext({ TextEncoder, Uint8Array, DataView, ArrayBuffer });
    vm.runInContext(fs.readFileSync(path.join(root, 'utils/csv.js'), 'utf8'), real);
    const scenarios = [
        {
            mode: 'posts', rows: [{ id: '1' }, { id: '2', quoted_post: { text: 'late quote', view_count: 0 } }],
            expected: ['id', 'quoted_post_text', 'quoted_post_view_count']
        },
        {
            mode: 'followers', rows: [{ id: '1', username: 'early' }, {
                id: '2', account_based_in: 'France', account_location_accurate: false
            }],
            expected: ['id', 'username', 'account_based_in', 'account_location_accurate']
        }
    ];
    for (const { mode, rows, expected } of scenarios) {
        const sheets = [];
        const harness = createHarness({
            sourceBatches: rows.map(row => [row]),
            settings: { localizeExportHeaders: false, language: 'en' },
            loadExportState: async () => ({
                username: 'snapshot', exportMode: mode, tweetCount: rows.length,
                totalBatches: rows.length, settings: { includeAboutAccountDetails: true }
            })
        });
        harness.context.XPorterCSV.collectPopulatedHeaders = real.XPorterCSV.collectPopulatedHeaders;
        harness.context.XPorterCSV.generateXLSXAsync = async (items, isUsers, opts) => {
            const bytes = await real.XPorterCSV.generateXLSXAsync(items, isUsers, opts);
            sheets.push(readZipEntries(bytes).get('xl/worksheets/sheet1.xml').data.toString('utf8'));
            return bytes;
        };
        assert.equal((await harness.downloads.downloadCurrent('xlsx')).success, true);
        assert.equal(sheets.length, 2);
        for (const sheet of sheets) {
            const header = sheet.match(/<row r="1">([\s\S]*?)<\/row>/)[1];
            const labels = [...header.matchAll(/<t>([^<]*)<\/t>/g)].map(match => match[1]);
            assert.deepEqual(labels, expected, `${mode}: every XLSX part must retain later populated columns`);
        }
    }
}

async function testSynchronousDownloadFailureReleasesTheLock() {
    const harness = createHarness({
        sourceBatches: [[{ id: '1' }]],
        fakeKeepAlive: true,
        downloadThrows: true
    });

    const started = await harness.downloads.startCurrentDownload('csv');
    assert.equal(started.success, true);
    await waitForIdle(harness);
    assert.deepEqual(
        harness.progressEvents.find(event => event.type === 'DOWNLOAD_ERROR'),
        { type: 'DOWNLOAD_ERROR', source: 'current', error: 'DOWNLOAD_FAILED' }
    );
    const retry = await harness.downloads.startCurrentDownload('csv');
    assert.notDeepEqual(retry, { error: 'DOWNLOAD_IN_PROGRESS' },
        'a thrown downloads API call must not keep the download lock');
    await waitForIdle(harness);
}

async function testHistoryDownloadProgressIsTaggedAsHistory() {
    const harness = createHarness({
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        }
    });
    harness.context.XPorterStorage.loadExportHistoryEntry = async () => ({
        username: 'old', exportMode: 'posts',
        items: [{ id: '1', media_urls: 'https://pbs.twimg.com/media/history.png' }]
    });

    const result = await harness.downloads.downloadHistory('entry', 'xlsx');
    assert.equal(result.success, true);
    const progress = harness.progressEvents.filter(event => event.type === 'DOWNLOAD_PROGRESS');
    assert(progress.length >= 2, 'history photo download must report progress');
    assert(progress.every(event => event.source === 'history'),
        'history download progress must not look like the current export download');
}

async function testPhotoProgressIsThrottled() {
    const urls = Array.from({ length: 40 }, (_, index) => `https://pbs.twimg.com/media/p${index}.png`);
    const harness = createHarness({
        sourceBatches: [[{ id: '1', media_urls: urls.join(', ') }]],
        postXlsxPartLimit: 10,
        settings: {
            localizeExportHeaders: false,
            language: 'en',
            embedPostPhotos: true,
            embedBookmarkPhotos: false
        }
    });

    const result = await harness.downloads.downloadCurrent('xlsx');
    assert.equal(result.success, true);
    const photoEvents = harness.progressEvents
        .filter(event => event.stage === 'photos')
        .map(event => [event.photoCurrent, event.photoTotal]);
    assert.deepEqual(photoEvents[0], [0, 40]);
    assert.deepEqual(photoEvents.at(-1), [40, 40], 'the final photo count must always be sent');
    assert(photoEvents.length <= 5,
        `40 instant previews must not flood the popup (${photoEvents.length} messages)`);
}

async function testPhotosSkippedByPartCapsAreCounted() {
    const urls = ['one', 'two', 'three'].map(name => `https://pbs.twimg.com/media/${name}.png`);
    const byCount = createHarness({
        sourceBatches: [[{ id: '1', media_urls: urls.join(', ') }]],
        photoTargetLimit: 1,
        settings: { localizeExportHeaders: false, language: 'en', embedPostPhotos: true }
    });
    assert.equal((await byCount.downloads.downloadCurrent('xlsx')).success, true);
    assert.equal(byCount.photoFetches(), 1);
    assert.equal(byCount.generatedXlsxOptions[0].mediaSkippedCount, 2,
        'photos beyond the per-part photo cap must be counted for the Media note');

    const byBytes = createHarness({
        sourceBatches: [[{ id: '1', media_urls: urls.slice(0, 2).join(', ') }]],
        photoMaxBytes: 100,
        photoPartMaxBytes: 30,
        settings: { localizeExportHeaders: false, language: 'en', embedPostPhotos: true }
    });
    assert.equal((await byBytes.downloads.downloadCurrent('xlsx')).success, true);
    assert.equal(byBytes.generatedXlsxOptions[0].mediaAssets.length, 1);
    assert.equal(byBytes.generatedXlsxOptions[0].mediaSkippedCount, 1,
        'photos dropped by the per-part byte budget must be counted');
}

async function main() {
    await testCalendarLabelsSurviveDownloadAndHistory();
    await testMultipartDownloadUsesOneSettingsSnapshot();
    await testDuplicatePhotoUrlIsFetchedOncePerDownload();
    await testSettledPhotoCacheIsBoundedAcrossParts();
    await testFailedPhotoFetchIsNotCached();
    await testHungPhotoFetchTimesOutAndReleasesDownload();
    await testChunkedPhotoStopsAtByteLimit();
    await testPhotoPartBudgetDropsExcessAssets();
    await testHeaderRejectedPhotoResponsesAreCancelled();
    await testActiveDownloadKeepsItsFrozenPlan();
    await testTextCopyUsesTheCurrentDataReadLease();
    await testConcurrentStartsReserveDownloadBeforeSnapshotRead();
    await testFailedBatchReadIsNeverReportedAsComplete();
    await testFailedStateReadReleasesDownloadReservation();
    await testShortSavedDataNeverLowersTheSavedCount();
    await testMultipartPartsShareOneColumnSet();
    await testMultipartXlsxSharesNestedAndAccountColumns();
    await testSynchronousDownloadFailureReleasesTheLock();
    await testHistoryDownloadProgressIsTaggedAsHistory();
    await testPhotoProgressIsThrottled();
    await testPhotosSkippedByPartCapsAreCounted();
    await require('./test-xlsx-export.js').run();
    console.log('Download transaction tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
