#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function source(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

async function testSearchErrorsAreRelayed() {
    const posted = [];
    const window = {
        location: { origin: 'https://x.com' },
        postMessage(message) { posted.push(message); },
        fetch: async () => new Response('{"errors":[{"code":88}]}', { status: 429 })
    };
    window.window = window;

    class FakeXHR {
        addEventListener(type, listener) {
            if (type === 'load') this.loadListener = listener;
        }
        open() {}
    }

    const context = vm.createContext({
        window,
        XMLHttpRequest: FakeXHR,
        Request,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source('content/interceptor.js'), context, { filename: 'content/interceptor.js' });

    await window.fetch('https://x.com/i/api/graphql/query-id/SearchTimeline?variables=%7B%7D');
    await new Promise(resolve => setImmediate(resolve));

    const capture = posted.find(message => message.type === '__XPORTER_GRAPHQL_RESPONSE__');
    assert.equal(capture?.status, 429, 'SearchTimeline HTTP errors must reach the worker');
    assert.match(capture?.bodyText || '', /"code":88/);

    const xhr = new FakeXHR();
    const xhrUrl = 'https://x.com/i/api/graphql/query-id/SearchTimeline?cursor=next';
    xhr.open('GET', xhrUrl);
    xhr.status = 429;
    xhr.responseType = '';
    xhr.responseText = '';
    xhr.responseURL = xhrUrl;
    xhr.loadListener();
    const xhrCapture = posted.filter(message => message.type === '__XPORTER_GRAPHQL_RESPONSE__').at(-1);
    assert.equal(xhrCapture?.status, 429, 'empty XHR error responses must also reach the worker');
}

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
        const soffice = ['/opt/homebrew/bin/soffice', '/usr/local/bin/soffice']
            .find(candidate => fs.existsSync(candidate));
        if (soffice) {
            const profileUrl = `file://${path.join(tempDir, 'libreoffice-profile')}`;
            execFileSync(soffice, [
                `-env:UserInstallation=${profileUrl}`,
                '--headless', '--convert-to', 'csv', '--outdir', tempDir, workbookPath
            ], { stdio: 'pipe', timeout: 30_000 });
            const converted = fs.readFileSync(path.join(tempDir, 'export.csv'), 'utf8');
            assert(converted.includes('2075277820528607704'), 'LibreOffice must preserve long IDs');
            assert(converted.includes('Привет & hello'), 'LibreOffice must open Unicode cell text');
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testPostsTxtIsAiFriendly() {
    const context = vm.createContext({ Date, Number });
    vm.runInContext(source('utils/csv.js'), context, { filename: 'utils/csv.js' });

    const text = context.XPorterCSV.generatePostsText([{
        text: 'First line\nSecond line',
        created_at: 'Tue Jul 07 12:00:00 +0000 2026',
        view_count: '1200',
        favorite_count: 47,
        retweet_count: 3,
        reply_count: 2,
        quote_count: 1,
        bookmark_count: 9,
        tweet_url: 'https://x.com/MediaKing/status/1'
    }], {
        name: 'Matt Paulson',
        screenName: 'MediaKing',
        bio: 'Founder and CEO',
        location: 'Sioux Falls, South Dakota',
        url: 'https://mattpaulson.com',
        followersCount: 76000,
        followingCount: 3252,
        subscriptionsCount: 2,
        createdAt: 'Sat Mar 01 00:00:00 +0000 2008'
    });

    assert.match(text, /^PROFILE\nName: Matt Paulson\nUsername: @MediaKing/m);
    assert.match(text, /Profile: https:\/\/x\.com\/MediaKing/);
    assert.match(text, /Followers: 76000/);
    assert.match(text, /Subscriptions: 2/);
    assert.match(text, /POSTS \(1\)/);
    assert.match(text, /1\. 2026-07-07T12:00:00\.000Z, 1200 views, 47 likes, 3 reposts, 2 replies, 1 quotes, 9 bookmarks/);
    assert.match(text, /Post: \(First line\nSecond line\)/);
    assert.match(text, /URL: https:\/\/x\.com\/MediaKing\/status\/1/);
    assert.doesNotMatch(text, /undefined|null/);
}

async function testStaleBearerRetriesImmediately() {
    const fallbackBearer = 'FALLBACK_BEARER';
    const cachedEndpoints = {
        UserByScreenName: { queryId: 'cached-query-id', operationName: 'UserByScreenName' }
    };
    const stored = {
        xporter_discovered_endpoints: {
            endpoints: cachedEndpoints,
            time: Date.now(),
            bearer: 'STALE_DYNAMIC_BEARER'
        }
    };
    const authHeaders = [];
    const responses = [
        new Response('{}', { status: 401 }),
        new Response(JSON.stringify({
            data: {
                user: {
                    result: {
                        rest_id: '1',
                        core: { name: 'Test', screen_name: 'test' },
                        is_blue_verified: true,
                        professional: { category: [{ name: 'Entrepreneur' }] },
                        creator_subscriptions_count: 2,
                        legacy: {
                            description: 'Founder',
                            location: 'Sioux Falls',
                            followers_count: 76000,
                            friends_count: 3252,
                            listed_count: 900,
                            favourites_count: 12,
                            created_at: 'Sat Mar 01 00:00:00 +0000 2008',
                            entities: { url: { urls: [{ expanded_url: 'https://example.com' }] } }
                        }
                    }
                }
            }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
    ];

    const context = vm.createContext({
        console,
        Response,
        AbortController,
        AbortSignal,
        navigator: { userAgent: 'XPorter test' },
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: {
            FALLBACK_BEARER_TOKEN: fallbackBearer,
            API_FETCH_TIMEOUT: 1000,
            ENDPOINT_CACHE_TTL: 60_000
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
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
                    async set(values) { Object.assign(stored, values); }
                }
            }
        },
        fetch: async (_url, options) => {
            authHeaders.push(options.headers.authorization);
            return responses.shift();
        }
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });

    await context.XPorterAPI.discoverEndpoints();
    const user = await context.XPorterAPI.getUserByScreenName('test');
    assert.equal(user.id, '1');
    assert.equal(user.bio, 'Founder');
    assert.equal(user.location, 'Sioux Falls');
    assert.equal(user.url, 'https://example.com');
    assert.equal(user.followersCount, 76000);
    assert.equal(user.subscriptionsCount, 2);
    assert.equal(user.professionalCategory, 'Entrepreneur');
    assert.equal(user.isVerified, true);
    assert.deepEqual(authHeaders, [
        'Bearer STALE_DYNAMIC_BEARER',
        `Bearer ${fallbackBearer}`
    ], 'the same request must retry once with the built-in bearer');
}

async function testActiveApiRequestCanBeAborted() {
    const context = vm.createContext({
        console,
        AbortController,
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: { API_FETCH_TIMEOUT: 60_000 },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        })
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    context.XPorterAPI.setLiveQueryId('UserByScreenName', 'test-query-id');
    const request = context.XPorterAPI.getUserByScreenName('test');
    await new Promise(resolve => setImmediate(resolve));
    context.XPorterAPI.abortActiveRequests();
    await assert.rejects(request, /ABORTED/, 'Stop must cancel an in-flight API request immediately');
}

async function testActiveResponseBodyCanBeAborted() {
    const context = vm.createContext({
        console,
        AbortController,
        Headers,
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: { API_FETCH_TIMEOUT: 60_000 },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {},
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'csrf' : 'present' });
                }
            }
        },
        fetch: async (_url, options) => ({
            status: 200,
            ok: true,
            headers: new Headers(),
            json: () => new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('aborted body');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            })
        })
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });
    context.XPorterAPI.setLiveQueryId('UserByScreenName', 'test-query-id');
    const request = context.XPorterAPI.getUserByScreenName('test');
    await new Promise(resolve => setImmediate(resolve));
    context.XPorterAPI.abortActiveRequests();
    await assert.rejects(request, /ABORTED/, 'Stop must also cancel a response body read without a timeout retry');
}

async function testDownloadModulePreservesCurrentExportContract() {
    let downloadRecorded = 0;
    let feedbackRefreshes = 0;
    let txtProfile = null;
    let keepAliveCallback = null;
    let keepAliveCleared = 0;
    let keepAliveTouches = 0;
    class FakeFileReader {
        readAsDataURL() {
            this.result = 'data:text/csv;base64,ZmFrZQ==';
            this.onload();
        }
    }
    const context = vm.createContext({
        Blob,
        FileReader: FakeFileReader,
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
            STORAGE_BATCH_READ_SIZE: 100
        },
        XPorterStorage: {
            async loadTweetBatches() { return [[{ id: '12345', text: 'hello' }]]; },
            async loadAllTweets() { throw new Error('current downloads must not load the whole export'); },
            async loadExportState() {
                return {
                    username: 'test', exportMode: 'posts', outputFormat: 'csv',
                    tweetCount: 1, totalBatches: 1,
                    userInfo: { name: 'Test User', screenName: 'test' }
                };
            },
            async loadSettings() { return { localizeExportHeaders: false, language: 'en' }; },
            async recordDownload() { downloadRecorded += 1; }
        },
        XPorterPostDB: { async getAllPosts() { return []; } },
        XPorterCSV: {
            generateCSV() { return 'id,text\n12345,hello\n'; },
            generatePostsText(_items, profile) { txtProfile = profile; return 'PROFILE\n'; },
            generateXLSX() { return new Uint8Array([1]); },
            generateExportFilename(_username, _mode, extension) { return `XPorter_posts_test.${extension}`; },
            escapeCSVValue(value) { return String(value ?? ''); }
        },
        XPorterFeedback: { refresh() { feedbackRefreshes += 1; } },
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: async () => ({}),
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

    const txtResult = await context.XPorterDownloads.downloadCurrent('txt');
    assert.equal(txtResult.filename, 'XPorter_posts_test.txt');
    assert.deepEqual(JSON.parse(JSON.stringify(txtProfile)), { name: 'Test User', screenName: 'test' });

    const clipboardResult = await context.XPorterDownloads.getCurrentPostsText();
    assert.equal(clipboardResult.success, true);
    assert.equal(clipboardResult.text, 'PROFILE\n');
    assert.equal(clipboardResult.count, 1);

    const detached = await context.XPorterDownloads.startCurrentDownload('csv');
    assert.equal(detached.started, true);
    assert.equal(typeof keepAliveCallback, 'function',
        'detached downloads must keep the MV3 worker alive');
    keepAliveCallback();
    assert.equal(keepAliveTouches, 1);
    await new Promise(resolve => setImmediate(resolve));
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

function createWorkerHarness() {
    let savedState = null;
    let cleared = false;
    let firstItemRecords = 0;
    let saveStateSucceeds = true;
    let loadAllCalls = 0;
    let savedHistory = null;
    const settings = {
        quantityLimit: 500,
        autoExpireEnabled: true,
        autoExpireHours: 4
    };

    const context = vm.createContext({
        console,
        URL,
        Blob,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        importScripts() {},
        XPORTER_CONFIG: { SPEED_PRESETS: { standard: {} } },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        XPorterAPI: {
            discoverEndpoints: async () => ({}),
            getRateLimit: () => null,
            setLiveQueryId() {}
        },
        XPorterCSV: {},
        XPorterColumns: {},
        XPorterFeedback: { refresh() {}, maybeRefresh() {} },
        XPorterDownloads: {
            async downloadCurrent() { return { success: true }; },
            async downloadHistory() { return { success: true }; },
            async downloadSeenPosts() { return { success: true }; }
        },
        XPorterPostDB: {
            upsertPosts: async () => ({}),
            getSummary: async () => ({ count: 0 }),
            getAllPosts: async () => [],
            clear: async () => {}
        },
        XPorterStorage: {
            async saveExportState(state) {
                if (!saveStateSucceeds) return false;
                savedState = { ...state, updatedAt: Date.now() };
                return true;
            },
            async loadExportState() { return savedState; },
            async loadSettings() { return { ...settings }; },
            async clearExportState() { cleared = true; savedState = null; return true; },
            async pruneExpiredExportHistory() { return { changed: false, expired: 0 }; },
            async loadDetectedUsername() { return ''; },
            async loadUsage() { return {}; },
            async markInstalled() {},
            async backfillInstalledAt() {},
            async saveSettings() { return true; },
            async recordExportPhase() {},
            async recordFirstItem() { firstItemRecords += 1; },
            async loadAllTweets() { loadAllCalls += 1; return [{ id: '1' }]; },
            async saveExportHistory(entry) { savedHistory = entry; return true; }
        },
        RateLimitManager: class {},
        detectBrowserLanguage: () => 'en',
        loadTranslations: async () => ({}),
        chrome: {
            storage: { local: { setAccessLevel: async () => {} } },
            runtime: {
                id: 'test-extension',
                onInstalled: { addListener() {} },
                onStartup: { addListener() {} },
                onMessage: { addListener() {} },
                getManifest: () => ({ version: '1.4.8' }),
                setUninstallURL() {},
                getPlatformInfo: async () => ({ os: 'mac' }),
                sendMessage: async () => ({})
            },
            tabs: {
                query: async () => [],
                create: async () => ({ id: 1 }),
                remove: async () => {},
                update: async () => {},
                sendMessage: async () => ({})
            },
            action: {
                setBadgeText() {},
                setBadgeBackgroundColor() {}
            }
        }
    });
    vm.runInContext(source('background/service-worker.js'), context, { filename: 'background/service-worker.js' });
    return {
        context,
        setSavedState(state) { savedState = state; },
        getSavedState() { return savedState; },
        wasCleared() { return cleared; },
        firstItemRecords() { return firstItemRecords; },
        setSaveStateSucceeds(value) { saveStateSucceeds = value; },
        loadAllCalls() { return loadAllCalls; },
        getSavedHistory() { return savedHistory; }
    };
}

async function testSearchCaptureIsArmedBeforeNavigation() {
    const harness = createWorkerHarness();
    let createOptions = null;
    let updateOptions = null;
    let armedBeforeNavigation = false;
    let relayResult = null;

    harness.context.__searchRelayMessage = {
        operationName: 'SearchTimeline',
        url: 'https://x.com/i/api/graphql/test/SearchTimeline?variables=%7B%7D',
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
    harness.context.XPorterAPI.fetchFollowers = async () => {
        fetchCalls += 1;
        return { users: [], nextCursor: null };
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
        currentExport.userInfo.followersCount = 0;
        currentExport.cursor = null;
        rateLimiter = __makeRateLimiter();
    `, harness.context);
    await vm.runInContext('_fetchUsersLoop()', harness.context);
    assert.equal(fetchCalls, 1, 'a genuinely empty profile should still finish normally');
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

async function testResumeKeepsFiltersButFollowsCurrentPacing() {
    const harness = createWorkerHarness();
    const merged = vm.runInContext(`buildResumeSettings(
        { exportSpeed: 'turtle', customDelaySec: 9, includeRetweets: true, quantityLimit: 100 },
        { exportSpeed: 'turbo', includeRetweets: false, quantityLimit: 500 }
    )`, harness.context);
    assert.equal(merged.exportSpeed, 'turtle',
        'pacing must follow the user\'s current settings — slowing down is the rate-limit escape hatch');
    assert.equal(merged.customDelaySec, 9);
    assert.equal(merged.includeRetweets, false,
        'data filters must keep the export snapshot so resumed rows match collected rows');
    assert.equal(merged.quantityLimit, 500,
        'the snapshot limit stays; raises go through limitOverride');
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

function testTimelineV2UserListsAreParsed() {
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        XPORTER_CONFIG: {},
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        USER_FEATURES: {},
        USER_FIELD_TOGGLES: {},
        TWEETS_FEATURES: {},
        FOLLOWERS_FEATURES: {},
        FOLLOWERS_FIELD_TOGGLES: {}
    });
    vm.runInContext(source('utils/api-parsers.js'), context, { filename: 'utils/api-parsers.js' });
    context.__payload = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [{
                                type: 'TimelineAddEntries',
                                entries: [{
                                    entryId: 'user-1',
                                    content: {
                                        itemContent: {
                                            user_results: {
                                                result: {
                                                    rest_id: '1',
                                                    core: { name: 'Test', screen_name: 'test' },
                                                    legacy: {}
                                                }
                                            }
                                        }
                                    }
                                }, {
                                    entryId: 'cursor-bottom-1',
                                    content: { value: 'next' }
                                }]
                            }]
                        }
                    }
                }
            }
        }
    };
    const result = vm.runInContext('XPorterApiParsers.parseFollowersResponse(__payload)', context);
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].username, 'test');
    assert.equal(result.nextCursor, 'next');

    const malformed = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: { full_text: 'missing id' }
    })`, context);
    assert.equal(malformed, null, 'malformed tweet rows without an id must be discarded');

    const authorless = vm.runInContext(`XPorterApiParsers.parseTweetObject({
        legacy: { id_str: '12345', full_text: 'hello' }
    })`, context);
    assert.equal(
        authorless.tweet_url,
        'https://x.com/i/web/status/12345',
        'authorless payloads must still receive a valid canonical status URL'
    );
}

function testThemeInitializationCanRevertToDark() {
    const classes = new Set(['light']);
    const context = vm.createContext({
        document: {
            body: {
                classList: {
                    toggle(name, enabled) {
                        if (enabled) classes.add(name);
                        else classes.delete(name);
                    }
                }
            }
        }
    });
    vm.runInContext(source('popup/theme.js'), context, { filename: 'popup/theme.js' });
    context.__icon = { innerHTML: '' };
    const mode = vm.runInContext('initTheme("dark", __icon)', context);
    assert.equal(mode, 'dark');
    assert.equal(classes.has('light'), false, 'restoring dark must remove a previously applied light class');

    classes.add('light');
    const defaultMode = vm.runInContext('initTheme(undefined, __icon)', context);
    assert.equal(defaultMode, 'dark');
    assert.equal(classes.has('light'), false, 'missing saved theme must default to dark');
}

const tests = [
    ['SearchTimeline error relay', testSearchErrorsAreRelayed],
    ['real XLSX OOXML', testXlsxIsRealOoxmlZip],
    ['AI-friendly posts TXT', testPostsTxtIsAiFriendly],
    ['stale bearer retry', testStaleBearerRetriesImmediately],
    ['active request cancellation', testActiveApiRequestCanBeAborted],
    ['active response-body cancellation', testActiveResponseBodyCanBeAborted],
    ['download module contract', testDownloadModulePreservesCurrentExportContract],
    ['large downloads split incrementally', testLargeDownloadsAreSplitAndReadIncrementally],
    ['anonymous uninstall module', testUninstallFeedbackModuleKeepsAnonymousContract],
    ['search capture arms before navigation', testSearchCaptureIsArmedBeforeNavigation],
    ['unexpected empty user list is not success', testUnexpectedEmptyUserListDoesNotComplete],
    ['export settings snapshot', testExportSnapshotSurvivesWorkerRestart],
    ['large completion skips history payload copy', testLargeCompletionSkipsHistoryPayloadCopy],
    ['cursor dedup memory is bounded', testCursorDedupMemoryIsBounded],
    ['resume pacing vs filters', testResumeKeepsFiltersButFollowsCurrentPacing],
    ['XLSX truncation stays valid', testXlsxCellTruncationKeepsXmlValid],
    ['persisted limit override', testPersistedLimitOverrideIsReported],
    ['terminal auto-expiration', testTerminalExportActuallyExpires],
    ['resume first-item telemetry', testResumeRecordsFirstNewItem],
    ['state write failure', testStateWriteFailureIsTerminal],
    ['timeline_v2 user-list parser', testTimelineV2UserListsAreParsed],
    ['theme restore', testThemeInitializationCanRevertToDark]
];

(async () => {
    const failures = [];
    for (const [name, test] of tests) {
        try {
            await test();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`FAIL ${name}: ${error.message}`);
        }
    }
    if (failures.length > 0) {
        process.exitCode = 1;
    } else {
        console.log('Extension core tests passed');
    }
})();
