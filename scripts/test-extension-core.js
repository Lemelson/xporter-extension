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
    vm.runInContext(source('utils/api.js'), context, { filename: 'utils/api.js' });

    await context.XPorterAPI.discoverEndpoints();
    const user = await context.XPorterAPI.getUserByScreenName('test');
    assert.equal(user.id, '1');
    assert.deepEqual(authHeaders, [
        'Bearer STALE_DYNAMIC_BEARER',
        `Bearer ${fallbackBearer}`
    ], 'the same request must retry once with the built-in bearer');
}

function createWorkerHarness() {
    let savedState = null;
    let cleared = false;
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
        XPorterPostDB: {
            upsertPosts: async () => ({}),
            getSummary: async () => ({ count: 0 }),
            getAllPosts: async () => [],
            clear: async () => {}
        },
        XPorterStorage: {
            async saveExportState(state) { savedState = { ...state, updatedAt: Date.now() }; return true; },
            async loadExportState() { return savedState; },
            async loadSettings() { return { ...settings }; },
            async clearExportState() { cleared = true; savedState = null; return true; },
            async pruneExpiredExportHistory() { return { changed: false, expired: 0 }; },
            async loadDetectedUsername() { return ''; },
            async loadUsage() { return {}; },
            async markInstalled() {},
            async backfillInstalledAt() {},
            async saveSettings() { return true; }
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
                getManifest: () => ({ version: '1.4.6' }),
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
        wasCleared() { return cleared; }
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

const tests = [
    ['SearchTimeline error relay', testSearchErrorsAreRelayed],
    ['real XLSX OOXML', testXlsxIsRealOoxmlZip],
    ['stale bearer retry', testStaleBearerRetriesImmediately],
    ['export settings snapshot', testExportSnapshotSurvivesWorkerRestart],
    ['persisted limit override', testPersistedLimitOverrideIsReported],
    ['terminal auto-expiration', testTerminalExportActuallyExpires]
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
