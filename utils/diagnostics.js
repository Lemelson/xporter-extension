// Versioned, bounded diagnostics. Worker-owned; never stores X identifiers,
// request URLs, response bodies, file names, cookies, or arbitrary error text.
(function () {
    'use strict';
    const KEY = 'xporter_diagnostics_v2';
    const MODES = ['posts', 'bookmarks', 'followers', 'following', 'verified_followers', 'seen_posts'];
    const FORMATS = ['csv', 'json', 'xlsx', 'txt', 'clipboard'];
    const RESULTS = ['complete', 'stopped', 'error', 'rejected', 'interrupted'];
    const PHASES = ['requested', 'resolving_user', 'fetching', 'rate_limit', 'generating', 'download'];
    const COMPLETIONS = ['limit_reached', 'source_exhausted', 'no_matches'];
    const SPEEDS = ['ultra', 'turbo', 'fast', 'standard', 'careful', 'turtle', 'custom'];
    const BOOL_SETTINGS = ['includeOriginalPosts', 'includeQuotes', 'includeReplies', 'includeRetweets',
        'includeArticles', 'includeBookmarkReplyContext', 'includeBookmarkArticles', 'embedPostPhotos',
        'embedBookmarkPhotos', 'includeAboutAccountDetails', 'adaptivePacing', 'localizeExportHeaders',
        'postSafetyBreakEnabled', 'userSafetyBreakEnabled'];
    const NUM_SETTINGS = ['quantityLimit', 'customDelaySec', 'userCustomDelaySec', 'postSafetyBreakEvery',
        'postSafetyBreakMin', 'userSafetyBreakEvery', 'userSafetyBreakMin', 'aboutAccountCustomBatchSize',
        'aboutAccountMaxRetries'];
    const EXTRA_ERRORS = new Set(['ALREADY_RUNNING', 'DOWNLOAD_IN_PROGRESS', 'INVALID_DATE_RANGE', 'INVALID_USERNAME',
        'NO_EXPORT_TO_RESUME',
        'NO_POST_TYPES_SELECTED', 'NO_DATA', 'STORAGE_FULL', 'HISTORY_NOT_FOUND', 'HISTORY_DATA_GONE',
        'COPY_TOO_LARGE', 'DOWNLOAD_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED',
        'USER_CANCELED', 'USER_SHUTDOWN', 'CRASH', 'FILE_FAILED', 'FILE_ACCESS_DENIED', 'FILE_NO_SPACE',
        'FILE_NAME_TOO_LONG', 'FILE_TOO_LARGE', 'FILE_VIRUS_INFECTED', 'FILE_TRANSIENT_ERROR',
        'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED', 'FILE_TOO_SHORT', 'FILE_HASH_MISMATCH',
        'NETWORK_FAILED', 'NETWORK_INVALID_REQUEST', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN',
        'SERVER_FAILED', 'SERVER_NO_RANGE', 'SERVER_BAD_CONTENT', 'SERVER_UNAUTHORIZED',
        'SERVER_CERT_PROBLEM', 'SERVER_FORBIDDEN', 'SERVER_UNREACHABLE', 'SERVER_CONTENT_LENGTH_MISMATCH',
        'SERVER_CROSS_ORIGIN_REDIRECT', 'TRACKING_LOST', 'WORKER_RESTART']);
    let queue = Promise.resolve();
    let activeId = null;
    const num = value => Math.min(1e12, Math.max(0, Number(value) || 0));
    const choose = (value, choices, fallback = 'unknown') => choices.includes(value) ? value : fallback;
    function errorCode(value) {
        const code = String(value || '');
        if (!code) return '';
        return EXTRA_ERRORS.has(code) || (typeof KNOWN_ERROR_CODES !== 'undefined' && KNOWN_ERROR_CODES.has(code))
            || /^API_ERROR_\d{3}$/.test(code) ? code : 'UNKNOWN';
    }
    function settingsSnapshot(settings = {}) {
        const result = {};
        for (const key of BOOL_SETTINGS) if (typeof settings[key] === 'boolean') result[key] = settings[key];
        for (const key of NUM_SETTINGS) if (Number.isFinite(settings[key])) result[key] = num(settings[key]);
        for (const key of ['exportSpeed', 'userExportSpeed', 'aboutAccountSpeed']) {
            if (SPEEDS.includes(settings[key])) result[key] = settings[key];
        }
        return result;
    }
    function version() {
        const value = chrome.runtime.getManifest().version;
        return /^\d+(\.\d+){1,3}$/.test(value) ? value : '';
    }
    async function read() {
        const stored = (await chrome.storage.local.get(KEY))[KEY];
        if (stored?.schema === 2) return stored;
        const usage = await XPorterStorage.loadUsage();
        return { schema: 2, since: Date.now(), installId: crypto.randomUUID(),
            installAt: usage.installedAt || null, installApprox: !!usage.installedAtApprox,
            installVersion: usage.installVersion || '', historical: num(usage.exportsStarted) > 0,
            sequence: 0, revision: 0, activeDays: 0, lastActiveDay: '',
            firstAttemptMs: null, firstStartMs: null, firstItemMs: null, firstDownloadMs: null,
            totals: { attempts: 0, started: 0, complete: 0, stopped: 0, error: 0, rejected: 0,
                interrupted: 0, downloadStarted: 0, downloadComplete: 0, downloadInterrupted: 0,
                downloadFailed: 0, downloadUnknown: 0, clipboard: 0, requests: 0, rateLimits: 0, retries: 0,
                timeouts: 0, networkErrors: 0, pauses: 0, pauseMs: 0 },
            attempts: [], downloads: [], pendingDownloads: {}, currentAttempt: null };
    }
    function milestone(state, key, at) {
        // These are first observed events since schema_since, NOT reconstructed
        // all-time firsts for installations upgrading from legacy tracking.
        if (state[key] === null) state[key] = Math.max(0, at - state.since);
    }
    function attempt(state, data, at, rejected = false) {
        const entry = { id: ++state.sequence, at, version: version(),
            mode: choose(data.mode, MODES), format: choose(data.format, FORMATS),
            resume: !!data.resume, dateRange: !!data.dateRange,
            settings: settingsSnapshot(data.settings), phase: 'requested', result: 'pending',
            startedAt: null, firstItemMs: null, durationMs: null, rows: 0,
            error: '', completion: '', requests: 0, rateLimits: 0, retries: 0,
            timeouts: 0, networkErrors: 0, pauses: 0, pauseMs: 0 };
        state.attempts.push(entry);
        // Keep an ongoing run even when repeated rejected Start clicks occur.
        while (state.attempts.length > 5) {
            const index = state.attempts.findIndex(item => item.id !== state.currentAttempt);
            state.attempts.splice(index < 0 ? 0 : index, 1);
        }
        state.totals.attempts++;
        milestone(state, 'firstAttemptMs', at);
        if (rejected) {
            entry.result = 'rejected'; entry.error = errorCode(data.error); entry.durationMs = 0;
            state.totals.rejected++;
        } else state.currentAttempt = entry.id;
        return entry.id;
    }
    function downloadResult(state, entry, result, error = '') {
        if (!entry || ['complete', 'interrupted', 'error', 'unknown'].includes(entry.result)) return;
        entry.result = result; entry.error = errorCode(error);
        if (result === 'complete') state.totals.downloadComplete++;
        if (result === 'interrupted') state.totals.downloadInterrupted++;
        if (result === 'error') state.totals.downloadFailed++;
        if (result === 'unknown') state.totals.downloadUnknown = (state.totals.downloadUnknown || 0) + 1;
    }
    function reduce(state, type, data, at) {
        const current = state.attempts.find(item => item.id === (data.attemptId ?? state.currentAttempt));
        if (type === 'open') {
            const day = new Date(at).toISOString().slice(0, 10);
            if (day > state.lastActiveDay) { state.activeDays++; state.lastActiveDay = day; }
        } else if (type === 'attempt' || type === 'rejected') {
            return attempt(state, data, at, type === 'rejected');
        } else if (type === 'started' && current && current.startedAt === null) {
            if (data.settings) current.settings = settingsSnapshot(data.settings);
            current.startedAt = at; current.phase = 'resolving_user'; state.totals.started++;
            milestone(state, 'firstStartMs', at);
        } else if (type === 'phase' && current && PHASES.includes(data.phase)) {
            current.phase = data.phase;
        } else if (type === 'progress' && current) {
            current.rows = Math.max(current.rows, num(data.rows));
            if (data.newItem !== false && current.rows > 0 && current.firstItemMs === null && current.startedAt !== null) {
                current.firstItemMs = Math.max(0, at - current.startedAt);
                milestone(state, 'firstItemMs', at);
            }
        } else if (type === 'terminal' && current && current.result === 'pending') {
            current.result = choose(data.result, RESULTS, 'error');
            current.rows = Math.max(current.rows, num(data.rows));
            current.durationMs = Math.max(0, at - current.at);
            current.error = errorCode(data.error);
            current.completion = choose(data.completion, COMPLETIONS, '');
            state.totals[current.result]++;
            state.currentAttempt = null;
        } else if (type === 'metric' && current) {
            const key = data.key;
            if (['requests', 'rateLimits', 'retries', 'timeouts', 'networkErrors', 'pauses', 'pauseMs'].includes(key)) {
                const count = data.value === undefined ? 1 : num(data.value);
                current[key] += count; state.totals[key] += count;
            }
        } else if (type === 'download_begin') {
            const entry = { id: ++state.sequence, at, mode: choose(data.mode, MODES),
                format: choose(data.format, FORMATS), source: choose(data.source, ['current', 'history', 'seen_posts']),
                rows: num(data.rows), parts: Math.max(1, num(data.parts)), handedOff: false,
                completedParts: 0, bytes: 0, generationMs: null, result: 'generating', error: '',
                photosEnabled: !!data.photosEnabled, photoPermission: data.photoPermission === true,
                photosAttempted: 0, photosLoaded: 0, photosFailed: 0 };
            state.downloads.push(entry); state.totals.downloadStarted++;
            while (state.downloads.length > 5) {
                const removed = state.downloads.shift();
                for (const [id, item] of Object.entries(state.pendingDownloads)) {
                    if (item.transaction === removed.id) delete state.pendingDownloads[id];
                }
                if (['generating', 'handed_off'].includes(removed.result)) state.totals.downloadUnknown = (state.totals.downloadUnknown || 0) + 1;
            }
            return entry.id;
        } else if (type.startsWith('download_') || type === 'photos') {
            const binding = state.pendingDownloads[String(data.downloadId)];
            const entry = state.downloads.find(item => item.id === (binding?.transaction ?? data.id));
            if (!entry) return;
            if (type === 'download_file' && Number.isInteger(data.downloadId)) {
                if (Object.keys(state.pendingDownloads).length >= 256) {
                    downloadResult(state, entry, 'unknown', 'TRACKING_LOST'); return;
                }
                state.pendingDownloads[String(data.downloadId)] = { transaction: entry.id };
                entry.bytes += num(data.bytes);
            } else if (type === 'download_handoff') {
                if (data.rows !== undefined) entry.rows = num(data.rows);
                entry.handedOff = true; entry.generationMs = Math.max(0, at - entry.at);
                if (entry.result === 'generating') entry.result = 'handed_off';
                if (entry.completedParts === entry.parts) {
                    downloadResult(state, entry, 'complete');
                    if (entry.result === 'complete') milestone(state, 'firstDownloadMs', at);
                }
            } else if (type === 'download_state' && binding) {
                if (!['complete', 'interrupted'].includes(data.state)) return;
                delete state.pendingDownloads[String(data.downloadId)];
                if (data.state === 'interrupted') downloadResult(state, entry, 'interrupted', data.error);
                else {
                    entry.completedParts++;
                    if (entry.handedOff && entry.completedParts === entry.parts) {
                        downloadResult(state, entry, 'complete');
                    if (entry.result === 'complete') milestone(state, 'firstDownloadMs', at);
                    }
                }
            } else if (type === 'download_failed') {
                entry.generationMs = Math.max(0, at - entry.at);
                downloadResult(state, entry, 'error', data.error);
            } else if (type === 'photos') {
                entry.photosAttempted += num(data.attempted);
                entry.photosLoaded += num(data.loaded);
                entry.photosFailed += num(data.failed);
            }
        } else if (type === 'clipboard') state.totals.clipboard++;
        else if (type === 'recover' && current) {
            current.result = 'interrupted'; current.error = 'WORKER_RESTART';
            // The exact interruption time is unknowable after worker death.
            current.durationMs = null; state.totals.interrupted++; state.currentAttempt = null;
        }
    }
    function record(type, data = {}) {
        const at = Date.now();
        const pending = queue.then(async () => {
            const state = await read();
            const result = reduce(state, type, data, at);
            activeId = state.currentAttempt;
            state.revision++; state.snapshotAt = at;
            await chrome.storage.local.set({ [KEY]: state });
            return result;
        });
        // Telemetry failure never breaks export or resets existing diagnostics.
        queue = pending.catch(() => {});
        const safe = pending.catch(() => null);
        if (['terminal', 'rejected', 'download_state', 'download_failed', 'open'].includes(type)) {
            safe.then(() => {
                globalThis.XPorterFeedback?.maybeRefresh?.(true);
            }).catch(() => {});
        }
        return safe;
    }
    function load() {
        const pending = queue.then(async () => {
            const state = await read();
            // Persist first initialization, so snapshots share one install ID.
            if (!(await chrome.storage.local.get(KEY))[KEY]) await chrome.storage.local.set({ [KEY]: state });
            activeId = state.currentAttempt;
            return state;
        });
        queue = pending.catch(() => {});
        return pending;
    }
    globalThis.XPorterDiagnostics = { record, load, errorCode, settingsSnapshot, KEY,
        get currentId() { return activeId; } };
})();
