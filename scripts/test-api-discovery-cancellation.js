#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8');

function createHarness(fetchImpl, config = {}) {
    const storage = {};
    const context = vm.createContext({
        console,
        AbortController,
        Response,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'XPorter test' },
        fetch: fetchImpl,
        XPORTER_CONFIG: {
            API_FETCH_TIMEOUT: 1000,
            DISCOVERY_FETCH_TIMEOUT: 1000,
            DISCOVERY_TOTAL_TIMEOUT: 10,
            ENDPOINT_CACHE_TTL: 24 * 60 * 60 * 1000,
            FALLBACK_BEARER_TOKEN: 'fallback-bearer',
            ...config
        },
        XLog: { log() {}, warn() {}, error() {}, info() {} },
        XPorterApiParsers: {},
        chrome: {
            storage: {
                local: {
                    async get(key) {
                        return { [key]: storage[key] };
                    },
                    async set(values) {
                        Object.assign(storage, structuredClone(values));
                    },
                    async remove(key) {
                        delete storage[key];
                    }
                }
            },
            cookies: {
                get(_details, callback) {
                    callback(null);
                }
            }
        }
    });

    vm.runInContext(apiSource, context, { filename: 'utils/api.js' });
    return { api: context.XPorterAPI, storage };
}

async function testTotalTimeoutAbortsOutstandingBundleFetch() {
    let bundleSignal = null;
    const pageHtml = [
        '<html><head>',
        '<script src="https://abs.twimg.com/responsive-web/client-web-test.js"></script>',
        '</head></html>'
    ].join('');
    const harness = createHarness(async (url, options = {}) => {
        if (url === 'https://x.com') {
            return new Response(pageHtml, { status: 200 });
        }
        bundleSignal = options.signal || null;
        return new Promise((_resolve, reject) => {
            bundleSignal?.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    });

    try {
        const result = await harness.api.discoverEndpoints(true);

        assert.equal(
            result.UserByScreenName.queryId,
            'AWbeRIdkLtqTRN7yL_H8yw',
            'the timed-out caller must still receive fallback endpoints'
        );
        assert.equal(bundleSignal?.aborted, true,
            'the total timeout must abort the underlying bundle fetch');
    } finally {
        harness.api.abortActiveRequests();
    }
}

function discoveryPage(bundleName) {
    return [
        '<html><head>',
        `<script src="https://abs.twimg.com/responsive-web/${bundleName}.js"></script>`,
        '</head></html>'
    ].join('');
}

function discoveryBundle(userQueryId, tweetsQueryId, bearer) {
    return [
        `queryId:"${userQueryId}",operationName:"UserByScreenName"`,
        `queryId:"${tweetsQueryId}",operationName:"UserTweets"`,
        `"${bearer}"`
    ].join(';');
}

async function testLateTimedOutGenerationCannotOverwriteNewerDiscovery() {
    const lateBearer = 'A'.repeat(110) + 'LATE';
    const freshBearer = 'A'.repeat(110) + 'FRESH';
    let pageNumber = 0;
    let resolveLateBundle;
    const harness = createHarness(async (url) => {
        if (url === 'https://x.com') {
            pageNumber += 1;
            return new Response(
                discoveryPage(pageNumber === 1 ? 'client-web-late' : 'client-web-fresh'),
                { status: 200 }
            );
        }
        if (url.includes('client-web-late')) {
            return new Promise(resolve => {
                resolveLateBundle = () => resolve(new Response(
                    discoveryBundle('late-user-id', 'late-tweets-id', lateBearer),
                    { status: 200 }
                ));
            });
        }
        return new Response(
            discoveryBundle('fresh-user-id', 'fresh-tweets-id', freshBearer),
            { status: 200 }
        );
    });

    const timedOut = await harness.api.discoverEndpoints(true);
    assert.equal(timedOut.UserByScreenName.queryId, 'AWbeRIdkLtqTRN7yL_H8yw');

    const fresh = await harness.api.discoverEndpoints(true);
    assert.equal(fresh.UserByScreenName.queryId, 'fresh-user-id');
    assert.equal(harness.api.BEARER_TOKEN, freshBearer);

    resolveLateBundle();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    const cached = await harness.api.discoverEndpoints(false);
    assert.equal(cached.UserByScreenName.queryId, 'fresh-user-id',
        'a late timed-out generation must not replace the newer endpoint cache');
    assert.equal(harness.api.BEARER_TOKEN, freshBearer,
        'a late timed-out generation must not replace the newer bearer');
    assert.equal(
        harness.storage.xporter_discovered_endpoints.endpoints.UserByScreenName.queryId,
        'fresh-user-id',
        'a late timed-out generation must not persist stale endpoints'
    );
}

async function testSuccessfulDiscoveryRemainsSingleFlightAndCached() {
    const bearer = 'A'.repeat(110) + 'CURRENT';
    let fetchCount = 0;
    const harness = createHarness(async (url) => {
        fetchCount += 1;
        if (url === 'https://x.com') {
            return new Response(discoveryPage('client-web-current'), { status: 200 });
        }
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(
            discoveryBundle('current-user-id', 'current-tweets-id', bearer),
            { status: 200 }
        );
    }, {
        DISCOVERY_TOTAL_TIMEOUT: 100
    });

    const [first, second] = await Promise.all([
        harness.api.discoverEndpoints(true),
        harness.api.discoverEndpoints(true)
    ]);

    assert.equal(first.UserByScreenName.queryId, 'current-user-id');
    assert.equal(second.UserByScreenName.queryId, 'current-user-id');
    assert.equal(fetchCount, 2,
        'concurrent discovery callers must share one page and bundle scan');

    const cached = await harness.api.discoverEndpoints(false);
    assert.equal(cached.UserByScreenName.queryId, 'current-user-id');
    assert.equal(fetchCount, 2,
        'a successful discovery must retain the existing 24-hour memory cache');
}

async function main() {
    await testTotalTimeoutAbortsOutstandingBundleFetch();
    await testLateTimedOutGenerationCannotOverwriteNewerDiscovery();
    await testSuccessfulDiscoveryRemainsSingleFlightAndCached();
    console.log('API discovery cancellation tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
