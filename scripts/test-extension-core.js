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
                        legacy: {}
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
        XPorterStorage: {
            async loadAllTweets() { return [{ id: '12345', text: 'hello' }]; },
            async loadExportState() {
                return { username: 'test', exportMode: 'posts', outputFormat: 'csv' };
            },
            async loadSettings() { return { localizeExportHeaders: false, language: 'en' }; },
            async recordDownload() { downloadRecorded += 1; }
        },
        XPorterPostDB: { async getAllPosts() { return []; } },
        XPorterCSV: {
            generateCSV() { return 'id,text\n12345,hello\n'; },
            generateXLSX() { return new Uint8Array([1]); },
            generateExportFilename() { return 'XPorter_posts_test.csv'; },
            escapeCSVValue(value) { return String(value ?? ''); }
        },
        XPorterFeedback: { refresh() { feedbackRefreshes += 1; } },
        chrome: {
            runtime: { lastError: null },
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
            async recordFirstItem() { firstItemRecords += 1; }
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
        setSaveStateSucceeds(value) { saveStateSucceeds = value; }
    };
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
}

const tests = [
    ['SearchTimeline error relay', testSearchErrorsAreRelayed],
    ['real XLSX OOXML', testXlsxIsRealOoxmlZip],
    ['stale bearer retry', testStaleBearerRetriesImmediately],
    ['active request cancellation', testActiveApiRequestCanBeAborted],
    ['active response-body cancellation', testActiveResponseBodyCanBeAborted],
    ['download module contract', testDownloadModulePreservesCurrentExportContract],
    ['anonymous uninstall module', testUninstallFeedbackModuleKeepsAnonymousContract],
    ['export settings snapshot', testExportSnapshotSurvivesWorkerRestart],
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
