// Transport schema 2. Positional fields and dictionary-coded records, then
// DEFLATE + base64url. This is encoding, not encryption. Never reorder fields.
// Mirrored byte-for-byte to docs/assets/diagnostics-codec.js by the build check.
(function () {
    'use strict';
    const fields = [
        'schema_version', 'v', 'os', 'days', 'installed_at', 'ui_lang', 'theme', 'opens', 'active_s',
        'exp_started', 'exp_ok', 'exp_err', 'exp_stopped', 'm_posts', 'm_followers', 'm_following',
        'm_verified', 'm_dates', 'resumes', 'dl', 'f_csv', 'f_json', 'f_xlsx', 'items', 'last_days',
        'last_err', 'last_phase', 'first_item_ms', 's_retweets', 's_replies', 's_articles', 's_limit',
        's_localize', 's_speed', 's_adaptive', 'inst_approx', 's_safety', 'm_bookmarks', 'install_v',
        'schema_since', 'snapshot_at', 'install_id', 'browser_family', 'browser_major',
        's_user_speed', 's_user_safety', 'diag_historical', 'diag_active_days', 'diag_first_attempt_ms',
        'diag_first_start_ms', 'diag_first_item_ms', 'diag_first_download_ms', 'diag_attempts',
        'diag_downloads', 'diag_totals', 'transport_omitted_attempts', 'transport_omitted_downloads',
        'diag_revision', 'consent_version', 'transport_summary_only',
        's_colorful', 's_ladybug', 's_window_width', 's_window_height', 's_element_size', 's_text_size', 's_auto_expire', 's_auto_expire_hours', 's_mode', 's_format', 's_originals', 's_quotes', 's_bookmark_context', 's_bookmark_articles', 's_post_photos', 's_bookmark_photos', 's_about', 's_about_speed', 's_about_batch', 's_about_retries', 'f_txt'
    ];
    const settingFields = ['includeOriginalPosts', 'includeQuotes', 'includeReplies', 'includeRetweets',
        'includeArticles', 'includeBookmarkReplyContext', 'includeBookmarkArticles', 'embedPostPhotos',
        'embedBookmarkPhotos', 'includeAboutAccountDetails', 'adaptivePacing', 'localizeExportHeaders',
        'postSafetyBreakEnabled', 'userSafetyBreakEnabled', 'quantityLimit', 'customDelaySec',
        'userCustomDelaySec', 'postSafetyBreakEvery', 'postSafetyBreakMin', 'userSafetyBreakEvery',
        'userSafetyBreakMin', 'aboutAccountCustomBatchSize', 'aboutAccountMaxRetries', 'exportSpeed',
        'userExportSpeed', 'aboutAccountSpeed'];
    const attemptFields = ['id', 'at', 'version', 'mode', 'format', 'resume', 'dateRange', 'settings',
        'phase', 'result', 'startedAt', 'firstItemMs', 'durationMs', 'rows', 'error', 'completion',
        'requests', 'rateLimits', 'retries', 'timeouts', 'networkErrors', 'pauses', 'pauseMs'];
    const downloadFields = ['id', 'at', 'mode', 'format', 'source', 'rows', 'parts', 'handedOff',
        'completedParts', 'bytes', 'generationMs', 'result', 'error', 'photosEnabled', 'photoPermission',
        'photosAttempted', 'photosLoaded', 'photosFailed'];
    const totalFields = ['attempts', 'started', 'complete', 'stopped', 'error', 'rejected', 'interrupted',
        'downloadStarted', 'downloadComplete', 'downloadInterrupted', 'downloadFailed', 'clipboard',
        'requests', 'rateLimits', 'retries', 'timeouts', 'networkErrors', 'pauses', 'pauseMs', 'downloadUnknown'];
    const dictionary = ['', 'unknown', 'posts', 'bookmarks', 'followers', 'following', 'verified_followers',
        'seen_posts', 'csv', 'json', 'xlsx', 'txt', 'clipboard', 'requested', 'resolving_user', 'fetching',
        'rate_limit', 'generating', 'download', 'pending', 'complete', 'stopped', 'error', 'rejected',
        'interrupted', 'handed_off', 'limit_reached', 'source_exhausted', 'no_matches', 'current', 'history',
        'ultra', 'turbo', 'fast', 'standard', 'careful', 'turtle', 'custom', 'NETWORK_TIMEOUT', 'RATE_LIMITED',
        'UNKNOWN', 'WORKER_RESTART', 'DOWNLOAD_FAILED', 'USER_CANCELED'];
    // Strings use a tagged [dictionaryIndex] to keep numeric measurements unambiguous.
    const encodeValue = value => typeof value === 'string' && dictionary.includes(value)
        ? [dictionary.indexOf(value)] : value;
    const decodeValue = value => Array.isArray(value) && value.length === 1 && Number.isInteger(value[0])
        && value[0] >= 0 && value[0] < dictionary.length ? dictionary[value[0]] : value;
    function packRecord(record, keys) {
        if (!record || typeof record !== 'object') return [];
        return keys.map(key => key === 'settings' ? packRecord(record.settings, settingFields)
            : encodeValue(record[key] ?? null));
    }
    function unpackRecord(values, keys) {
        if (!Array.isArray(values) || values.length > keys.length) throw new Error('Invalid diagnostic record');
        return Object.fromEntries(keys.map((key, i) => [key, key === 'settings'
            ? unpackRecord(values[i] || [], settingFields) : decodeValue(values[i] ?? null)]));
    }
    function pack(stats) {
        return fields.map(key => {
            if (key === 'diag_attempts') return (Array.isArray(stats[key]) ? stats[key] : []).slice(-5).map(row => packRecord(row, attemptFields));
            if (key === 'diag_downloads') return (Array.isArray(stats[key]) ? stats[key] : []).slice(-5).map(row => packRecord(row, downloadFields));
            if (key === 'diag_totals') return packRecord(stats[key], totalFields);
            return stats[key] ?? null;
        });
    }
    function unpack(values) {
        if (!Array.isArray(values) || values.length > fields.length || values[0] !== 2) throw new Error('Unsupported diagnostics schema');
        const stats = {};
        fields.forEach((key, i) => {
            if (values[i] === null || values[i] === undefined) return;
            if (key === 'diag_attempts' || key === 'diag_downloads') {
                if (!Array.isArray(values[i]) || values[i].length > 5) throw new Error('Too many diagnostic records');
                stats[key] = values[i].map(row => unpackRecord(row, key === 'diag_attempts' ? attemptFields : downloadFields));
            } else if (key === 'diag_totals') stats[key] = unpackRecord(values[i], totalFields);
            else if (['number', 'string', 'boolean'].includes(typeof values[i])) stats[key] = values[i];
            else throw new Error('Invalid diagnostic value');
        });
        return stats;
    }
    async function encode(stats) {
        const stream = new Blob([JSON.stringify(pack(stats))]).stream().pipeThrough(new CompressionStream('deflate'));
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async function decode(encoded) {
        if (typeof encoded !== 'string' || encoded.length > 2000 || !/^[\w-]+$/.test(encoded)) throw new Error('Invalid diagnostics payload');
        const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
        const stream = new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))]).stream()
            .pipeThrough(new DecompressionStream('deflate'));
        const reader = stream.getReader();
        const chunks = []; let size = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 40000) { await reader.cancel(); throw new Error('Diagnostics payload too large'); }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return unpack(JSON.parse(new TextDecoder().decode(bytes)));
    }
    async function buildURL(base, stats) {
        const snapshot = { ...stats, schema_version: 2,
            diag_attempts: Array.isArray(stats.diag_attempts) ? stats.diag_attempts.slice(-5) : [],
            diag_downloads: Array.isArray(stats.diag_downloads) ? stats.diag_downloads.slice(-5) : [],
            transport_omitted_attempts: 0, transport_omitted_downloads: 0, transport_summary_only: 0 };
        const language = /^[a-z]{2}(?:[_-][A-Za-z]{2})?$/.test(stats.ui_lang || '') ? stats.ui_lang : 'en';
        for (;;) {
            const url = `${base}?src=uninstall&ui_lang=${encodeURIComponent(language)}&d2=${await encode(snapshot)}`;
            if (url.length <= 1023) return url;
            // Keep latest attempts ahead of older downloads; explicitly count omissions.
            if (snapshot.diag_downloads.length > 1) { snapshot.diag_downloads.shift(); snapshot.transport_omitted_downloads++; }
            else if (snapshot.diag_attempts.length > 1) { snapshot.diag_attempts.shift(); snapshot.transport_omitted_attempts++; }
            else if (snapshot.diag_downloads.length) { snapshot.diag_downloads.shift(); snapshot.transport_omitted_downloads++; }
            else if (snapshot.diag_attempts.length) { snapshot.diag_attempts.shift(); snapshot.transport_omitted_attempts++; }
            else if (!snapshot.transport_summary_only) {
                snapshot.transport_summary_only = 1;
                snapshot.diag_totals = {};
            } else throw new Error('Diagnostics summary exceeds URL limit');
        }
    }
    globalThis.XPorterDiagnosticsCodec = { fields, settingFields, attemptFields, downloadFields, totalFields,
        pack, unpack, encode, decode, buildURL };
})();
