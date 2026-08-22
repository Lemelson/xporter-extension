// XPorter — sanitized native GraphQL request templates
//
// This helper runs in three contexts (X MAIN world, isolated content script,
// and the service worker). It deliberately accepts only the low-authority
// request shape XPorter needs to keep a query ID paired with the feature flags
// that X used successfully. It never accepts variables, URLs, headers,
// cookies, usernames, user IDs, or cursors.
(function (root) {
    'use strict';

    const OPERATIONS = new Set([
        'UserByScreenName',
        'AboutAccountQuery',
        'UserTweets',
        'UserOriginalsTimeline',
        'UserRepliesTimeline',
        'UserTweetsAndReplies',
        'Bookmarks',
        'TweetResultsByRestIds',
        'Following',
        'BlueVerifiedFollowers'
    ]);
    const QUERY_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
    const FLAG_KEY_PATTERN = /^[A-Za-z0-9_]{1,100}$/;
    const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
    const MAX_FLAG_KEYS = 128;
    const MAX_TEMPLATE_CHARS = 16 * 1024;
    const WIRE_KEYS = ['operationName', 'queryId', 'features', 'fieldToggles'];
    const STORED_KEYS = [...WIRE_KEYS, 'capturedAt'];

    function hasExactKeys(value, allowed) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = Object.keys(value).sort();
        const expected = [...allowed].sort();
        return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
    }

    function sanitizeFlagMap(value) {
        if (value === null) return null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const entries = Object.entries(value);
        if (entries.length > MAX_FLAG_KEYS) return undefined;

        const clean = {};
        for (const [key, flag] of entries) {
            if (!FLAG_KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key) || typeof flag !== 'boolean') {
                return undefined;
            }
            clean[key] = flag;
        }
        return clean;
    }

    function sanitizeWireTemplate(value) {
        if (!hasExactKeys(value, WIRE_KEYS)) return null;
        if (!OPERATIONS.has(value.operationName)) return null;
        if (typeof value.queryId !== 'string' || !QUERY_ID_PATTERN.test(value.queryId)) return null;

        const features = sanitizeFlagMap(value.features);
        const fieldToggles = sanitizeFlagMap(value.fieldToggles);
        if (features === undefined || fieldToggles === undefined) return null;

        const clean = {
            operationName: value.operationName,
            queryId: value.queryId,
            features,
            fieldToggles
        };
        if (JSON.stringify(clean).length > MAX_TEMPLATE_CHARS) return null;
        return clean;
    }

    function sanitizeStoredTemplate(value) {
        if (!hasExactKeys(value, STORED_KEYS)) return null;
        const wire = sanitizeWireTemplate({
            operationName: value.operationName,
            queryId: value.queryId,
            features: value.features,
            fieldToggles: value.fieldToggles
        });
        if (!wire || !Number.isFinite(value.capturedAt)) return null;
        return { ...wire, capturedAt: value.capturedAt };
    }

    function parseFlagParameter(url, name) {
        const values = url.searchParams.getAll(name);
        if (values.length === 0) return null;
        if (values.length !== 1) return undefined;
        try {
            return sanitizeFlagMap(JSON.parse(values[0]));
        } catch (_) {
            return undefined;
        }
    }

    function parseRequestUrl(rawUrl, method = 'GET') {
        if (String(method || 'GET').toUpperCase() !== 'GET') return null;

        let url;
        try {
            url = new URL(String(rawUrl));
        } catch (_) {
            return null;
        }
        if (url.protocol !== 'https:' || (url.hostname !== 'x.com' && url.hostname !== 'twitter.com')) {
            return null;
        }

        const path = url.pathname.match(/^\/i\/api\/graphql\/([^/]+)\/([^/]+)$/);
        if (!path) return null;
        const queryId = path[1];
        const operationName = path[2];
        const features = parseFlagParameter(url, 'features');
        const fieldToggles = parseFlagParameter(url, 'fieldToggles');
        if (features === undefined || fieldToggles === undefined) return null;

        return sanitizeWireTemplate({
            operationName,
            queryId,
            features,
            fieldToggles
        });
    }

    root.XPorterNativeTemplate = Object.freeze({
        parseRequestUrl,
        sanitizeWireTemplate,
        sanitizeStoredTemplate,
        OPERATIONS: Object.freeze([...OPERATIONS]),
        MAX_TEMPLATE_CHARS
    });
})(globalThis);
