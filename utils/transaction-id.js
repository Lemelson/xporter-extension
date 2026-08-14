// XPorter — x-client-transaction-id compatibility
//
// Browser-safe adaptation of the transaction algorithm from
// https://github.com/Lqm1/x-client-transaction-id (JSR 0.3.1, MIT).
// The original license is bundled at
// docs/vendor/x-client-transaction-id.LICENSE.
(function (root) {
    'use strict';

    const X_HOME_URL = 'https://x.com/home';
    const ON_DEMAND_CHUNK_NAME = 'ondemand.s';
    const INDICES_REGEX = /\(\w\[(\d{1,2})\],\s*16\)/g;
    const ON_DEMAND_FILE_HASH_REGEX =
        /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/;
    const CONTEXT_TTL = 30 * 60 * 1000;
    const FAILURE_TTL = 30 * 1000;
    const FETCH_TIMEOUT = 15000;
    const TWITTER_EPOCH_SECONDS = 1682924400;
    const DEFAULT_KEYWORD = 'obfiowerehiring';
    const ADDITIONAL_RANDOM_NUMBER = 3;

    let cachedContext = null;
    let cachedAt = 0;
    let contextInFlight = null;
    let contextEpoch = 0;
    let cachedFailure = null;
    let cachedFailureAt = 0;
    const activeFetches = new Map();

    function decodeBase64(value) {
        const binary = atob(value);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    function encodeBase64(bytes) {
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/=/g, '');
    }

    function getAttribute(tag, name) {
        const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
        return pattern.exec(tag)?.[2] || '';
    }

    function extractVerificationKey(html) {
        for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
            if (getAttribute(match[0], 'name') === 'twitter-site-verification') {
                const content = getAttribute(match[0], 'content');
                if (content) return content;
            }
        }
        throw new Error('TRANSACTION_VERIFICATION_KEY_MISSING');
    }

    function extractFramePaths(html) {
        const frames = [];
        for (let index = 0; index < 4; index++) {
            const svg = new RegExp(
                `<svg\\b[^>]*\\bid=(["'])loading-x-anim-${index}\\1[^>]*>([\\s\\S]*?)<\\/svg>`,
                'i'
            ).exec(html);
            if (!svg) throw new Error('TRANSACTION_FRAME_MISSING');
            const paths = [...svg[2].matchAll(/<path\b[^>]*>/gi)]
                .map(match => getAttribute(match[0], 'd'))
                .filter(Boolean);
            if (paths.length < 2) throw new Error('TRANSACTION_FRAME_DATA_MISSING');
            frames.push(paths[1]);
        }
        return frames;
    }

    function resolveOnDemandFileUrl(html) {
        const match = ON_DEMAND_FILE_HASH_REGEX.exec(html);
        if (!match) throw new Error('TRANSACTION_ONDEMAND_URL_MISSING');
        return `https://abs.twimg.com/responsive-web/client-web/${ON_DEMAND_CHUNK_NAME}.${match[2]}a.js`;
    }

    function extractIndices(source) {
        const indices = [];
        INDICES_REGEX.lastIndex = 0;
        let match;
        while ((match = INDICES_REGEX.exec(source)) !== null) {
            indices.push(Number.parseInt(match[1], 10));
        }
        if (indices.length < 2 || indices.some(index => !Number.isInteger(index))) {
            throw new Error('TRANSACTION_INDICES_MISSING');
        }
        return {
            rowIndex: indices[0],
            keyByteIndices: indices.slice(1)
        };
    }

    function frameRows(path) {
        return path.substring(9).split('C').map(item => {
            const cleaned = item.replace(/[^\d]+/g, ' ').trim();
            return cleaned ? cleaned.split(/\s+/).map(value => Number.parseInt(value, 10)) : [];
        });
    }

    function solve(value, minValue, maxValue, rounding) {
        const result = (value * (maxValue - minValue)) / 255 + minValue;
        return rounding ? Math.floor(result) : Math.round(result * 100) / 100;
    }

    function isOdd(number) {
        return number % 2 ? -1 : 0;
    }

    function interpolate(from, to, amount) {
        return from.map((value, index) => value * (1 - amount) + to[index] * amount);
    }

    function cubicValue(curves, time) {
        const calculate = (a, b, m) =>
            3 * a * (1 - m) * (1 - m) * m +
            3 * b * (1 - m) * m * m +
            m * m * m;

        if (time <= 0) {
            if (curves[0] > 0) return (curves[1] / curves[0]) * time;
            if (curves[1] === 0 && curves[2] > 0) return (curves[3] / curves[2]) * time;
            return 0;
        }
        if (time >= 1) {
            if (curves[2] < 1) return 1 + ((curves[3] - 1) / (curves[2] - 1)) * (time - 1);
            if (curves[2] === 1 && curves[0] < 1) {
                return 1 + ((curves[1] - 1) / (curves[0] - 1)) * (time - 1);
            }
            return 1;
        }

        let start = 0;
        let end = 1;
        let middle = 0;
        while (start < end) {
            middle = (start + end) / 2;
            const estimate = calculate(curves[0], curves[2], middle);
            if (Math.abs(time - estimate) < 0.00001) {
                return calculate(curves[1], curves[3], middle);
            }
            if (estimate < time) start = middle;
            else end = middle;
        }
        return calculate(curves[1], curves[3], middle);
    }

    function rotationMatrix(degrees) {
        const radians = (degrees * Math.PI) / 180;
        return [
            Math.cos(radians),
            -Math.sin(radians),
            Math.sin(radians),
            Math.cos(radians)
        ];
    }

    function floatToHex(number) {
        const result = [];
        let quotient = Math.floor(number);
        let fraction = number - quotient;
        while (quotient > 0) {
            quotient = Math.floor(number / 16);
            const remainder = Math.floor(number - quotient * 16);
            result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
            number = quotient;
        }
        if (fraction === 0) return result.join('');
        result.push('.');
        while (fraction > 0) {
            fraction *= 16;
            const integer = Math.floor(fraction);
            fraction -= integer;
            result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
        }
        return result.join('');
    }

    function animate(values, targetTime) {
        if (!Array.isArray(values) || values.length < 11) {
            throw new Error('TRANSACTION_FRAME_ROW_INVALID');
        }
        const fromColor = values.slice(0, 3).concat(1);
        const toColor = values.slice(3, 6).concat(1);
        const toRotation = solve(values[6], 60, 360, true);
        const curves = values.slice(7).map((value, index) => solve(value, isOdd(index), 1, false));
        if (curves.length < 4) throw new Error('TRANSACTION_CURVE_INVALID');

        const amount = cubicValue(curves, targetTime);
        const color = interpolate(fromColor, toColor, amount).map(value => Math.max(0, value));
        const rotation = interpolate([0], [toRotation], amount)[0];
        const parts = color.slice(0, -1).map(value => Math.round(value).toString(16));
        for (const value of rotationMatrix(rotation)) {
            const rounded = Math.abs(Math.round(value * 100) / 100);
            const hex = floatToHex(rounded);
            parts.push(hex.startsWith('.') ? `0${hex}`.toLowerCase() : (hex || '0'));
        }
        parts.push('0', '0');
        return parts.join('').replace(/[.-]/g, '');
    }

    function createContextFromSources(html, onDemandSource) {
        if (typeof html !== 'string' || typeof onDemandSource !== 'string') {
            throw new Error('TRANSACTION_SOURCE_INVALID');
        }
        const verificationKey = extractVerificationKey(html);
        const keyBytes = decodeBase64(verificationKey);
        const frames = extractFramePaths(html);
        const { rowIndex, keyByteIndices } = extractIndices(onDemandSource);
        if (keyBytes.length <= Math.max(5, rowIndex, ...keyByteIndices)) {
            throw new Error('TRANSACTION_KEY_TOO_SHORT');
        }

        const selectedFrame = frames[keyBytes[5] % 4];
        const rows = frameRows(selectedFrame);
        const selectedRow = rows[keyBytes[rowIndex] % 16];
        if (!selectedRow) throw new Error('TRANSACTION_FRAME_ROW_MISSING');

        let frameTime = keyByteIndices.reduce(
            (product, index) => product * (keyBytes[index] % 16),
            1
        );
        frameTime = Math.round(frameTime / 10) * 10;
        const animationKey = animate(selectedRow, frameTime / 4096);

        return Object.freeze({
            async generate(method, path, options = {}) {
                const normalizedMethod = String(method || '').toUpperCase();
                if (!normalizedMethod || typeof path !== 'string' || !path.startsWith('/')) {
                    throw new Error('TRANSACTION_REQUEST_INVALID');
                }
                const timeNow = Number.isFinite(options.timeNow)
                    ? Math.floor(options.timeNow)
                    : Math.floor(Date.now() / 1000) - TWITTER_EPOCH_SECONDS;
                const randomByte = Number.isInteger(options.randomByte)
                    ? Math.max(0, Math.min(255, options.randomByte))
                    : Math.floor(Math.random() * 256);
                const timeBytes = [
                    timeNow & 0xff,
                    (timeNow >> 8) & 0xff,
                    (timeNow >> 16) & 0xff,
                    (timeNow >> 24) & 0xff
                ];
                const data = `${normalizedMethod}!${path}!${timeNow}${DEFAULT_KEYWORD}${animationKey}`;
                const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
                const hashBytes = new Uint8Array(digest).slice(0, 16);
                const payload = [
                    ...keyBytes,
                    ...timeBytes,
                    ...hashBytes,
                    ADDITIONAL_RANDOM_NUMBER
                ];
                return encodeBase64(Uint8Array.from([
                    randomByte,
                    ...payload.map(byte => byte ^ randomByte)
                ]));
            }
        });
    }

    async function fetchText(url, options = {}) {
        const controller = new AbortController();
        const state = { userAborted: false, timedOut: false };
        const timer = setTimeout(() => {
            state.timedOut = true;
            controller.abort();
        }, FETCH_TIMEOUT);
        activeFetches.set(controller, state);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const text = await response.text();
            if (!response.ok) throw new Error(`TRANSACTION_HTTP_${response.status}`);
            return text;
        } catch (error) {
            if (state.userAborted) throw new Error('ABORTED');
            if (state.timedOut) throw new Error('TRANSACTION_TIMEOUT');
            throw error;
        } finally {
            clearTimeout(timer);
            activeFetches.delete(controller);
        }
    }

    async function initialize(forceRefresh = false) {
        if (forceRefresh) {
            cachedFailure = null;
            cachedFailureAt = 0;
        }
        if (!forceRefresh && cachedContext && Date.now() - cachedAt < CONTEXT_TTL) {
            return cachedContext;
        }
        if (!forceRefresh && cachedFailure && Date.now() - cachedFailureAt < FAILURE_TTL) {
            throw cachedFailure;
        }
        if (!forceRefresh && contextInFlight) return contextInFlight;

        const epoch = contextEpoch;
        const build = (async () => {
            const html = await fetchText(X_HOME_URL, {
                credentials: 'include',
                headers: {
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });
            const onDemandUrl = resolveOnDemandFileUrl(html);
            const onDemandSource = await fetchText(onDemandUrl);
            const context = createContextFromSources(html, onDemandSource);
            if (epoch === contextEpoch) {
                cachedContext = context;
                cachedAt = Date.now();
                cachedFailure = null;
                cachedFailureAt = 0;
            }
            return context;
        })().catch(error => {
            if (epoch === contextEpoch && error?.message !== 'ABORTED') {
                cachedFailure = error;
                cachedFailureAt = Date.now();
            }
            throw error;
        });
        const tracked = build.finally(() => {
            if (contextInFlight === tracked) contextInFlight = null;
        });
        contextInFlight = tracked;
        return contextInFlight;
    }

    async function generate(method, path, options = {}) {
        const context = await initialize(options.forceRefresh === true);
        return context.generate(method, path, options);
    }

    function invalidate() {
        contextEpoch += 1;
        cachedContext = null;
        cachedAt = 0;
        cachedFailure = null;
        cachedFailureAt = 0;
    }

    function abortActiveRequests() {
        contextEpoch += 1;
        cachedContext = null;
        cachedAt = 0;
        cachedFailure = null;
        cachedFailureAt = 0;
        for (const [controller, state] of activeFetches) {
            state.userAborted = true;
            controller.abort();
        }
    }

    root.XPorterTransactionId = Object.freeze({
        createContextFromSources,
        generate,
        invalidate,
        abortActiveRequests
    });
})(globalThis);
