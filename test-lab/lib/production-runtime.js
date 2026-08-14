#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

// These are runtime files loaded by the extension itself. The lab evaluates
// them directly on every run; it never keeps a test-lab copy of their logic.
const PRODUCTION_SOURCES = Object.freeze([
    'utils/config.js',
    'utils/api-features.js',
    'utils/api-parsers.js',
    'utils/native-request-template.js',
    'utils/api.js',
    'utils/columns-i18n.js',
    'utils/csv.js'
]);

const TEST_ENDPOINTS = Object.freeze({
    UserByScreenName: {
        queryId: 'labUserByScreenName01',
        operationName: 'UserByScreenName'
    },
    AboutAccountQuery: {
        queryId: 'labAboutAccountQuery01',
        operationName: 'AboutAccountQuery'
    },
    UserTweets: {
        queryId: 'labUserTweetsQuery001',
        operationName: 'UserTweets'
    },
    UserTweetsAndReplies: {
        queryId: 'labTweetsReplies001',
        operationName: 'UserTweetsAndReplies'
    },
    Bookmarks: {
        queryId: 'labBookmarksQuery01',
        operationName: 'Bookmarks'
    },
    SearchTimeline: {
        queryId: 'labSearchTimeline001',
        operationName: 'SearchTimeline'
    },
    Followers: {
        queryId: 'labFollowersQuery001',
        operationName: 'Followers'
    },
    Following: {
        queryId: 'labFollowingQuery001',
        operationName: 'Following'
    },
    BlueVerifiedFollowers: {
        queryId: 'labVerifiedQuery001',
        operationName: 'BlueVerifiedFollowers'
    }
});

function readProductionSource(relativePath) {
    return fs.readFileSync(path.join(EXTENSION_ROOT, relativePath), 'utf8');
}

function createProductionRuntime(fetchImpl) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('createProductionRuntime requires an offline fetch implementation');
    }

    const storage = {
        xporter_discovered_endpoints: {
            endpoints: TEST_ENDPOINTS,
            time: Date.now(),
            bearer: 'lab-bearer-token',
            discoveredOperations: Object.keys(TEST_ENDPOINTS)
        }
    };

    const context = vm.createContext({
        console,
        fetch: fetchImpl,
        Response,
        Headers,
        Request,
        URL,
        URLSearchParams,
        AbortController,
        AbortSignal,
        Blob,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        ArrayBuffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        navigator: { userAgent: 'XPorter offline test lab' },
        chrome: {
            cookies: {
                get({ name }, callback) {
                    callback({ value: name === 'ct0' ? 'lab-csrf-token' : 'present' });
                }
            },
            storage: {
                local: {
                    async get(key) {
                        if (typeof key === 'string') return { [key]: storage[key] };
                        if (Array.isArray(key)) {
                            return Object.fromEntries(key.map((item) => [item, storage[item]]));
                        }
                        return { ...storage };
                    },
                    async set(values) {
                        Object.assign(storage, values);
                    },
                    async remove(keys) {
                        for (const key of [].concat(keys)) delete storage[key];
                    }
                }
            }
        }
    });

    for (const relativePath of PRODUCTION_SOURCES) {
        vm.runInContext(readProductionSource(relativePath), context, {
            filename: relativePath
        });
    }

    return {
        api: context.XPorterAPI,
        csv: context.XPorterCSV,
        parsers: context.XPorterApiParsers,
        storage,
        context
    };
}

function productionSourceHashes() {
    return Object.fromEntries(PRODUCTION_SOURCES.map((relativePath) => [
        relativePath,
        crypto.createHash('sha256').update(readProductionSource(relativePath)).digest('hex')
    ]));
}

module.exports = {
    EXTENSION_ROOT,
    PRODUCTION_SOURCES,
    createProductionRuntime,
    productionSourceHashes
};
