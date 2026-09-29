// XPorter — download module
// Owns export serialization and chrome.downloads handoff. The service worker
// only chooses which saved dataset to download.

(function () {
    let activeDownload = null;
    let activeDownloadPlan = null;
    let activeTransactionPromise = null;
    let activeTextRead = null;
    let downloadStarting = false;
    const MAX_EMBEDDED_PHOTO_BYTES = Math.max(
        1,
        Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_PREVIEW_MAX_BYTES) || (3 * 1024 * 1024)
    );
    const MAX_EMBEDDED_PHOTO_PART_BYTES = Math.max(
        1,
        Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_XLSX_PART_MAX_BYTES) || (40 * 1024 * 1024)
    );
    const MAX_EMBEDDED_PHOTO_TARGETS = Math.max(
        1,
        Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_XLSX_TARGET_LIMIT) || 1000
    );
    const EMBEDDED_PHOTO_CONCURRENCY = Math.max(
        1,
        Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_CONCURRENCY) || 8
    );
    const PHOTO_FETCH_TIMEOUT_MS = Math.max(
        1,
        Number(XPORTER_CONFIG?.API_FETCH_TIMEOUT) || 30000
    );
    const PHOTO_ASSET_CACHE_MAX_BYTES = Math.max(
        1,
        Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_CACHE_MAX_BYTES) || (64 * 1024 * 1024)
    );
    const PHOTO_ASSET_CACHE_MAX_ENTRIES = Math.max(
        1,
        Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_CACHE_MAX_ENTRIES) || 256
    );
    const PHOTO_HOST_ORIGIN = 'https://pbs.twimg.com/*';
    const diagnose = (type, data) => globalThis.XPorterDiagnostics?.record(type, data) || Promise.resolve(null);

    // Photo embedding is an optional capability: pbs.twimg.com lives in
    // optional_host_permissions and is granted from the popup toggle, so an
    // update can never disable existing installations (the 1.5.9 incident).
    // A missing grant must never block a download — the workbook silently
    // keeps plain media URLs instead. Environments without the permissions
    // API (test harnesses) keep the legacy direct-fetch behavior.
    async function hasPhotoHostAccess() {
        try {
            if (typeof chrome === 'undefined' || !chrome.permissions?.contains) {
                return true;
            }
            return await chrome.permissions.contains({ origins: [PHOTO_HOST_ORIGIN] });
        } catch (_) {
            return false;
        }
    }

    function keepWorkerAliveDuringDownload() {
        if (typeof chrome === 'undefined' || !chrome.runtime?.getPlatformInfo) {
            return () => {};
        }
        // startCurrentDownload acknowledges the popup immediately, so the
        // generation promise is no longer tied to the runtime-message event.
        // Touch a Chrome API before MV3's idle deadline while large parts are
        // being serialized or handed to chrome.downloads.
        const timer = setInterval(() => {
            try {
                chrome.runtime.getPlatformInfo(() => {});
            } catch (_) { /* keepalive is best-effort */ }
        }, 20000);
        return () => clearInterval(timer);
    }

    // Returns the embeddable targets plus how many valid photos were left out
    // by the per-part target cap (reported on the Media sheet).
    function collectPhotoTargets(items) {
        const targets = [];
        const seen = new Set();
        let overflow = 0;
        const add = (exportedPostId, post, relation) => {
            if (!post || typeof post !== 'object') return;
            for (const rawUrl of String(post.media_urls || '').split(/,\s*/)) {
                const sourceUrl = rawUrl.trim();
                if (!sourceUrl) continue;
                let parsed;
                try {
                    parsed = new URL(sourceUrl);
                } catch (_) {
                    continue;
                }
                if (parsed.protocol !== 'https:' || parsed.hostname !== 'pbs.twimg.com') continue;
                const key = `${exportedPostId}|${relation}|${sourceUrl}`;
                if (seen.has(key)) continue;
                seen.add(key);
                if (targets.length >= MAX_EMBEDDED_PHOTO_TARGETS) {
                    overflow++;
                    continue;
                }
                targets.push({
                    postId: String(exportedPostId || post.id || ''),
                    contextPostId: String(post.id || ''),
                    relation,
                    sourceUrl
                });
            }
        };

        for (const item of items || []) {
            const exportedPostId = item?.id || '';
            add(exportedPostId, item, 'post');
            add(exportedPostId, item?.quoted_post, 'quoted_post');
            add(exportedPostId, item?.reply_to_post, 'reply_to_post');
            add(
                exportedPostId,
                item?.reply_to_post?.quoted_post,
                'reply_to_post.quoted_post'
            );
        }
        return { targets, overflow };
    }

    function imageType(response, sourceUrl) {
        const header = String(response.headers?.get?.('content-type') || '')
            .split(';')[0].trim().toLowerCase();
        if (header === 'image/png') return { contentType: header, extension: 'png' };
        if (header === 'image/jpeg' || header === 'image/jpg') {
            return { contentType: 'image/jpeg', extension: 'jpg' };
        }
        if (header === 'image/gif') return { contentType: header, extension: 'gif' };
        if (header && header !== 'application/octet-stream') return null;

        const format = String(sourceUrl).match(/[?&]format=(png|jpe?g|gif)(?:&|$)/i)?.[1]
            || String(sourceUrl).match(/\.(png|jpe?g|gif)(?:\?|$)/i)?.[1]
            || '';
        if (/^png$/i.test(format)) return { contentType: 'image/png', extension: 'png' };
        if (/^gif$/i.test(format)) return { contentType: 'image/gif', extension: 'gif' };
        if (/^jpe?g$/i.test(format)) return { contentType: 'image/jpeg', extension: 'jpg' };
        return null;
    }

    function imageDimensions(bytes, extension) {
        if (extension === 'png' && bytes.length >= 24 &&
            bytes[0] === 0x89 && bytes[1] === 0x50) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            return { width: view.getUint32(16), height: view.getUint32(20) };
        }
        if (extension === 'gif' && bytes.length >= 10) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
        }
        if (extension === 'jpg' && bytes.length >= 4 &&
            bytes[0] === 0xFF && bytes[1] === 0xD8) {
            let offset = 2;
            while (offset + 8 < bytes.length) {
                if (bytes[offset] !== 0xFF) {
                    offset++;
                    continue;
                }
                const marker = bytes[offset + 1];
                const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
                if (length < 2 || offset + 2 + length > bytes.length) break;
                if ((marker >= 0xC0 && marker <= 0xC3) ||
                    (marker >= 0xC5 && marker <= 0xC7) ||
                    (marker >= 0xC9 && marker <= 0xCB) ||
                    (marker >= 0xCD && marker <= 0xCF)) {
                    return {
                        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
                        width: (bytes[offset + 7] << 8) | bytes[offset + 8]
                    };
                }
                offset += 2 + length;
            }
        }
        return { width: 160, height: 96 };
    }

    function previewPhotoUrl(sourceUrl) {
        try {
            const url = new URL(sourceUrl);
            if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com') return null;
            url.searchParams.set('name', 'small');
            return url.toString();
        } catch (_) {
            return null;
        }
    }

    async function readBoundedPhotoBytes(response) {
        const reader = response.body?.getReader?.();
        if (!reader) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            return bytes.length > 0 && bytes.length <= MAX_EMBEDDED_PHOTO_BYTES
                ? bytes
                : null;
        }

        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
                total += chunk.length;
                if (total > MAX_EMBEDDED_PHOTO_BYTES) {
                    await reader.cancel();
                    return null;
                }
                chunks.push(chunk);
            }
        } finally {
            reader.releaseLock?.();
        }
        if (total === 0) return null;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    }

    async function cancelPhotoResponse(response, controller) {
        try {
            if (typeof response?.body?.cancel === 'function') {
                await response.body.cancel();
            } else {
                const reader = response?.body?.getReader?.();
                if (reader) {
                    try {
                        await reader.cancel();
                    } finally {
                        reader.releaseLock?.();
                    }
                }
            }
        } catch (_) { /* cancellation is best-effort */ }
        try {
            controller?.abort();
        } catch (_) { /* already aborted */ }
    }

    async function fetchPhotoAsset(target) {
        const controller = typeof AbortController === 'function'
            ? new AbortController()
            : null;
        const timeout = controller && typeof setTimeout === 'function'
            ? setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS)
            : null;
        try {
            const fetchUrl = previewPhotoUrl(target.sourceUrl);
            if (!fetchUrl) return null;
            const response = await fetch(fetchUrl, {
                method: 'GET',
                credentials: 'omit',
                cache: 'force-cache',
                ...(controller ? { signal: controller.signal } : {})
            });
            if (!response.ok) {
                await cancelPhotoResponse(response, controller);
                return null;
            }
            const type = imageType(response, target.sourceUrl);
            if (!type) {
                await cancelPhotoResponse(response, controller);
                return null;
            }
            const declaredSize = Number(response.headers?.get?.('content-length')) || 0;
            if (declaredSize > MAX_EMBEDDED_PHOTO_BYTES) {
                await cancelPhotoResponse(response, controller);
                return null;
            }
            const bytes = await readBoundedPhotoBytes(response);
            if (!bytes) return null;
            return {
                ...target,
                ...type,
                bytes,
                ...imageDimensions(bytes, type.extension)
            };
        } catch (error) {
            XLog.warn?.(`Could not embed photo ${target.sourceUrl}:`, error.message);
            return null;
        } finally {
            if (timeout !== null && typeof clearTimeout === 'function') {
                clearTimeout(timeout);
            }
        }
    }

    function createPhotoAssetCache() {
        return {
            entries: new Map(),
            settledBytes: 0
        };
    }

    function removePhotoAssetCacheEntry(assetCache, sourceUrl, entry) {
        if (assetCache.entries.get(sourceUrl) !== entry) return;
        assetCache.entries.delete(sourceUrl);
        if (entry.settled) {
            assetCache.settledBytes = Math.max(
                0,
                assetCache.settledBytes - entry.byteLength
            );
        }
    }

    function evictSettledPhotoAssets(assetCache) {
        while (
            assetCache.settledBytes > PHOTO_ASSET_CACHE_MAX_BYTES ||
            assetCache.entries.size > PHOTO_ASSET_CACHE_MAX_ENTRIES
        ) {
            let candidate = null;
            for (const pair of assetCache.entries) {
                if (pair[1].settled) {
                    candidate = pair;
                    break;
                }
            }
            if (!candidate) return;
            removePhotoAssetCacheEntry(assetCache, candidate[0], candidate[1]);
        }
    }

    function clearPhotoAssetCache(assetCache) {
        assetCache?.entries?.clear();
        if (assetCache) assetCache.settledBytes = 0;
    }

    async function fetchPhotoAssets(
        items,
        assetCache = createPhotoAssetCache(),
        onProgress = null
    ) {
        const { targets, overflow } = collectPhotoTargets(items);
        if (targets.length === 0) return { assets: [], attempted: 0, skipped: overflow };
        const results = new Array(targets.length);
        let skippedByBytes = 0;
        let nextIndex = 0;
        let completed = 0;
        let retainedBytes = 0;
        onProgress?.({ current: completed, total: targets.length });
        const worker = async () => {
            while (nextIndex < targets.length) {
                const index = nextIndex++;
                const target = targets[index];
                let entry = assetCache.entries.get(target.sourceUrl);
                if (entry) {
                    // Map insertion order is the LRU order.
                    assetCache.entries.delete(target.sourceUrl);
                    assetCache.entries.set(target.sourceUrl, entry);
                } else {
                    entry = {
                        promise: null,
                        settled: false,
                        byteLength: 0
                    };
                    entry.promise = fetchPhotoAsset(target).then(
                        asset => {
                            if (!asset) {
                                removePhotoAssetCacheEntry(
                                    assetCache,
                                    target.sourceUrl,
                                    entry
                                );
                                return null;
                            }
                            entry.settled = true;
                            entry.byteLength = asset.bytes.byteLength;
                            assetCache.settledBytes += entry.byteLength;
                            evictSettledPhotoAssets(assetCache);
                            return asset;
                        },
                        error => {
                            removePhotoAssetCacheEntry(
                                assetCache,
                                target.sourceUrl,
                                entry
                            );
                            throw error;
                        }
                    );
                    assetCache.entries.set(target.sourceUrl, entry);
                }
                const asset = await entry.promise;
                if (asset &&
                    retainedBytes + asset.bytes.byteLength <= MAX_EMBEDDED_PHOTO_PART_BYTES) {
                    retainedBytes += asset.bytes.byteLength;
                    results[index] = { ...asset, ...target };
                } else {
                    if (asset) skippedByBytes++;
                    results[index] = null;
                }
                completed += 1;
                onProgress?.({ current: completed, total: targets.length });
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(EMBEDDED_PHOTO_CONCURRENCY, targets.length) },
                () => worker()
            )
        );
        return {
            assets: results.filter(Boolean),
            attempted: targets.length,
            skipped: overflow + skippedByBytes
        };
    }

    // Photo previews settle quickly; at most ~5 progress messages per second
    // reach the popup, and the first and final counts are always sent.
    function throttlePhotoProgress(report, intervalMs = 200) {
        let lastSentAt = 0;
        return ({ current, total }) => {
            const now = Date.now();
            if (current !== 0 && current < total && now - lastSentAt < intervalMs) return;
            lastSentAt = now;
            report({ current, total });
        };
    }

    // Only XLSX posts/bookmarks can embed photos, each behind its own setting.
    function embedsPhotos(format, mode, settings = {}) {
        return format === 'xlsx' && (
            (mode === 'posts' && settings.embedPostPhotos === true) ||
            (mode === 'bookmarks' && settings.embedBookmarkPhotos === true)
        );
    }

    function getPartLimit(format, mode, settings = {}) {
        const group = (mode === 'posts' || mode === 'bookmarks') ? 'posts' : 'users';
        const configured = XPORTER_CONFIG?.DOWNLOAD_PART_LIMITS?.[group]?.[format];
        const fallback = format === 'pdf' ? 250 : group === 'posts' ? 10000 : 50000;
        const ordinaryLimit = Number.isFinite(configured) && configured > 0
            ? configured
            : fallback;
        if (format === 'pdf') return Math.min(250, ordinaryLimit);
        if (!embedsPhotos(format, mode, settings)) return ordinaryLimit;
        const photoLimit = Number(XPORTER_CONFIG?.EMBEDDED_PHOTO_XLSX_PART_LIMIT) || 250;
        return Math.min(ordinaryLimit, photoLimit);
    }

    function buildPlan(state, requestedFormat) {
        const format = requestedFormat || state?.outputFormat || 'csv';
        if (format === 'pdf' && !['posts', 'bookmarks'].includes(state?.exportMode || 'posts')) {
            throw new Error('FORMAT_UNSUPPORTED');
        }
        const count = Math.max(0, Number(state?.tweetCount) || 0);
        const partSize = getPartLimit(
            format,
            state?.exportMode || 'posts',
            state?.settings || {}
        );
        const partCount = Math.max(1, Math.ceil(count / partSize));
        return {
            count,
            format,
            partSize,
            partCount,
            multipart: partCount > 1,
            active: downloadStarting || !!activeDownload
        };
    }

    async function getCurrentPlan(format) {
        const transactionPromise = activeTransactionPromise;
        if (transactionPromise) {
            try {
                const transaction = await transactionPromise;
                return { ...transaction.plan, active: true };
            } catch (_) {
                // The failed start clears its latch in `startCurrentDownload`;
                // fall through to the current saved state for a useful plan.
            }
        }
        if (activeDownloadPlan) {
            return { ...activeDownloadPlan, active: true };
        }
        const [state, settings] = await Promise.all([
            XPorterStorage.loadExportState(),
            XPorterStorage.loadSettings()
        ]);
        const plan = buildPlan({
            ...state,
            settings: {
                ...(state?.settings || {}),
                embedPostPhotos: settings.embedPostPhotos === true,
                embedBookmarkPhotos: settings.embedBookmarkPhotos === true
            }
        }, format);
        return refinePdfPlan(state, plan);
    }

    async function refinePdfPlan(state, plan) {
        if (plan.format !== 'pdf' || !state?.totalBatches || !plan.count) return plan;
        let parts = 0;
        for await (const _ of loadCurrentParts(state, plan.partSize, true)) parts++;
        return { ...plan, partCount: Math.max(1, parts), multipart: parts > 1 };
    }

    // Batch reads reject (STORAGE_READ_FAILED) instead of yielding an empty
    // batch, so a failed read can never become a short file reported as done.
    async function* loadCurrentBatches(state, readSizeOverride) {
        const readSize = readSizeOverride || Math.max(1, Number(XPORTER_CONFIG?.STORAGE_BATCH_READ_SIZE) || 100);
        for (let start = 0; start < (state.totalBatches || 0); start += readSize) {
            const count = Math.min(readSize, state.totalBatches - start);
            const batches = await XPorterStorage.loadTweetBatches(start, count);
            for (const batch of batches) yield batch;
        }
    }

    // Multipart CSV/XLSX parts share one column set: a column populated only in
    // a later part must still exist (empty) in earlier ones. This costs one
    // extra bounded pass over the saved batches before the first part.
    async function collectCurrentHeaders(state, isUsers, headerOpts) {
        const populated = new Set();
        for await (const batch of loadCurrentBatches(state)) {
            XPorterCSV.collectPopulatedHeaders(batch, isUsers, headerOpts, populated);
        }
        return [...populated];
    }

    async function* loadCurrentParts(state, partSize, printable = false) {
        let part = [];
        let chars = 0;

        for await (const batch of loadCurrentBatches(state, printable ? 1 : undefined)) {
            for (const item of batch) {
                const size = printable ? XPorterPDF.sourceSize(item) : 0;
                if (part.length && printable && chars + size > XPorterPDF.MAX_SOURCE_CHARS) {
                    yield part;
                    part = [];
                    chars = 0;
                }
                part.push(item);
                chars += size;
                if (part.length === partSize) {
                    yield part;
                    part = [];
                    chars = 0;
                }
            }
        }

        if (part.length > 0) yield part;
    }

    function reportDownload(message) {
        try {
            const result = chrome.runtime?.sendMessage?.(message);
            result?.catch?.(() => {});
        } catch (_) { /* popup may be closed */ }
    }

    async function recordSuccessfulDownload() {
        await XPorterStorage.recordDownload()
            .then(() => globalThis.XPorterFeedback?.refresh?.())
            .catch(() => {});
    }

    async function createCurrentDownloadTransaction(format) {
        const [state, downloadSettings] = await Promise.all([
            XPorterStorage.loadExportState(),
            XPorterStorage.loadSettings()
        ]);
        const plan = await refinePdfPlan(state, buildPlan({
            ...state,
            settings: {
                ...(state?.settings || {}),
                embedPostPhotos: downloadSettings.embedPostPhotos === true,
                embedBookmarkPhotos: downloadSettings.embedBookmarkPhotos === true
            }
        }, format));
        const mode = state?.exportMode || 'posts';
        const embedPhotos = embedsPhotos(plan.format, mode, downloadSettings);
        const photoHostAccess = embedPhotos ? await hasPhotoHostAccess() : false;
        const diagnosticId = await diagnose('download_begin', { mode, format: plan.format,
            rows: plan.count, parts: plan.partCount, source: 'current',
            photosEnabled: embedPhotos, photoPermission: photoHostAccess });
        return {
            diagnosticId,
            state,
            plan,
            downloadSettings: Object.freeze({ ...downloadSettings }),
            exportedAt: new Date(),
            photoHostAccess,
            photoAssetCache: createPhotoAssetCache()
        };
    }

    async function executeCurrentDownload(transaction) {
        try {
            const result = await executeCurrentDownloadInner(transaction);
            await diagnose(result?.success ? 'download_handoff' : 'download_failed', {
                id: transaction.diagnosticId, error: result?.error });
            return result;
        } catch (error) {
            await diagnose('download_failed', { id: transaction.diagnosticId, error: error.message });
            throw error;
        }
    }

    async function executeCurrentDownloadInner(transaction) {
        const {
            state,
            plan,
            downloadSettings,
            exportedAt,
            photoHostAccess,
            photoAssetCache
        } = transaction;
        if (!state || plan.count === 0 || !state.totalBatches) return { error: 'NO_DATA' };

        const mode = state.exportMode || 'posts';
        const populatedHeaders = plan.multipart && (plan.format === 'csv' || plan.format === 'xlsx')
            ? await collectCurrentHeaders(state, mode !== 'posts' && mode !== 'bookmarks', {
                includeAboutAccountDetails: state.settings?.includeAboutAccountDetails === true
            })
            : null;
        let partNumber = 0;
        let downloadedCount = 0;
        let lastResult = null;
        const filenames = [];
        for await (const items of loadCurrentParts(state, plan.partSize, plan.format === 'pdf')) {
            partNumber++;
            reportDownload({
                type: 'DOWNLOAD_PROGRESS',
                source: 'current',
                partNumber,
                partCount: plan.partCount,
                count: plan.count,
                format: plan.format
            });
            lastResult = await downloadItems(items, {
                source: 'current',
                username: state.username || 'unknown',
                mode,
                format: plan.format,
                profile: state.userInfo || null,
                postSelection: state.settings || null,
                includeAboutAccountDetails:
                    state.settings?.includeAboutAccountDetails === true,
                dateFrom: state.dateFromCalendar || state.dateFrom,
                dateTo: state.dateToCalendar || state.dateTo,
                exportedAt,
                partNumber,
                partCount: plan.partCount,
                startNumber: downloadedCount + 1,
                exportStatus: state.partialReason ? 'partial' : state.status,
                saveAs: !plan.multipart,
                downloadSettings,
                photoHostAccess,
                photoAssetCache,
                ...(populatedHeaders ? { populatedHeaders } : {}),
                diagnosticId: transaction.diagnosticId
            });
            if (lastResult?.success !== true) return lastResult;
            downloadedCount += items.length;
            filenames.push(lastResult.filename);
        }

        if (partNumber === 0) return { error: 'NO_DATA' };
        if (downloadedCount !== plan.count) {
            // Every saved batch was read successfully (a failed or missing
            // batch rejects above), so the files hold all persisted rows. Only
            // report what was written; never rewrite the saved export count
            // from a download.
            XLog.error(`Download row count mismatch: expected ${plan.count}, read ${downloadedCount}`);
        }
        await recordSuccessfulDownload();
        reportDownload({
            type: 'DOWNLOAD_COMPLETE',
            source: 'current',
            partCount: partNumber,
            count: downloadedCount,
            format: plan.format
        });
        if (!plan.multipart) return lastResult;
        return { success: true, count: downloadedCount, partCount: partNumber, filenames };
    }

    async function downloadCurrent(format) {
        const transaction = await createCurrentDownloadTransaction(format);
        try {
            return await executeCurrentDownload(transaction);
        } finally {
            clearPhotoAssetCache(transaction.photoAssetCache);
        }
    }

    async function startCurrentDownload(format) {
        if (isCurrentDataReadActive()) return { error: 'DOWNLOAD_IN_PROGRESS' };
        downloadStarting = true;
        let transactionPromise = null;
        try {
            transactionPromise = createCurrentDownloadTransaction(format);
            activeTransactionPromise = transactionPromise;
            const transaction = await transactionPromise;
            const { plan } = transaction;
            if (plan.count === 0) {
                await diagnose('download_failed', { id: transaction.diagnosticId, error: 'NO_DATA' });
                return { error: 'NO_DATA' };
            }
            activeDownloadPlan = Object.freeze({ ...plan });

            const stopKeepAlive = keepWorkerAliveDuringDownload();
            let run;
            run = executeCurrentDownload(transaction)
                .then(result => {
                    if (result?.success !== true) {
                        reportDownload({
                            type: 'DOWNLOAD_ERROR',
                            source: 'current',
                            error: result?.error || 'DOWNLOAD_FAILED'
                        });
                    }
                    return result;
                })
                .catch(error => {
                    XLog.error('Download failed:', error.message);
                    reportDownload({
                        type: 'DOWNLOAD_ERROR',
                        source: 'current',
                        error: error.message || 'DOWNLOAD_FAILED'
                    });
                    return { error: error.message || 'DOWNLOAD_FAILED' };
                })
                .finally(() => {
                    clearPhotoAssetCache(transaction.photoAssetCache);
                    stopKeepAlive();
                    if (activeDownload === run) {
                        activeDownload = null;
                        activeDownloadPlan = null;
                    }
                });
            activeDownload = run;
            return { success: true, started: true, ...plan, active: true };
        } finally {
            if (activeTransactionPromise === transactionPromise) {
                activeTransactionPromise = null;
            }
            downloadStarting = false;
        }
    }

    function isCurrentDownloadActive() {
        return downloadStarting || !!activeDownload;
    }

    function isCurrentDataReadActive() {
        return isCurrentDownloadActive() || !!activeTextRead;
    }

    async function readCurrentPostsText() {
        const state = await XPorterStorage.loadExportState();
        if (state?.exportMode !== 'posts' && state?.exportMode !== 'bookmarks') {
            return { error: 'NO_DATA' };
        }
        const plan = buildPlan(state, 'txt');
        if (plan.multipart) return { error: 'COPY_TOO_LARGE' };
        for await (const items of loadCurrentParts(state, plan.partSize)) {
            return {
                success: true,
                text: XPorterCSV.generatePostsText(items, state.userInfo || {}, {
                    mode: state.exportMode,
                    postSelection: state.settings || null
                }),
                count: items.length
            };
        }
        return { error: 'NO_DATA' };
    }

    function getCurrentPostsText() {
        if (isCurrentDataReadActive()) {
            return Promise.resolve({ error: 'DOWNLOAD_IN_PROGRESS' });
        }
        let run;
        run = readCurrentPostsText().finally(() => {
            if (activeTextRead === run) activeTextRead = null;
        });
        activeTextRead = run;
        return run;
    }

    async function downloadHistory(id, format) {
        const entry = await XPorterStorage.loadExportHistoryEntry(id);
        if (!entry) return { error: 'HISTORY_NOT_FOUND' };
        if (!Array.isArray(entry.items) || entry.items.length === 0) {
            return { error: 'HISTORY_DATA_GONE' };
        }

        const result = await downloadSingle(entry.items, {
            username: entry.username || 'unknown',
            mode: entry.exportMode || 'posts',
            format: format || entry.outputFormat || 'csv',
            profile: entry.userInfo || {
                name: entry.displayName || '',
                screenName: entry.username || ''
            },
            postSelection: entry.postSelection || null,
            includeAboutAccountDetails:
                entry.includeAboutAccountDetails === true,
            dateFrom: entry.dateFromCalendar || entry.dateFrom,
            dateTo: entry.dateToCalendar || entry.dateTo,
            exportedAt: entry.completedAt || new Date(),
            source: 'history',
            diagnosticSource: 'history',
            exportStatus: entry.partialReason ? 'partial' : entry.status || (entry.completedAt ? 'complete' : 'unknown')
        });
        if (result.success) await recordSuccessfulDownload();
        return result;
    }

    async function downloadSingle(items, options) {
        const settings = await XPorterStorage.loadSettings();
        const photosEnabled = embedsPhotos(options.format, options.mode, settings);
        const photoPermission = photosEnabled ? await hasPhotoHostAccess() : false;
        const parts = [];
        if (options.format === 'pdf') {
            if (!['posts', 'bookmarks'].includes(options.mode || 'posts')) return { error: 'FORMAT_UNSUPPORTED' };
            const rowLimit = getPartLimit('pdf', options.mode, settings);
            let part = [], chars = 0;
            for (const item of items) {
                const size = XPorterPDF.sourceSize(item);
                if (part.length && (part.length >= rowLimit || chars + size > XPorterPDF.MAX_SOURCE_CHARS)) {
                    parts.push(part); part = []; chars = 0;
                }
                part.push(item); chars += size;
            }
            if (part.length) parts.push(part);
        } else parts.push(items);
        const id = await diagnose('download_begin', { mode: options.mode, format: options.format,
            source: options.diagnosticSource, rows: items.length, parts: parts.length, photosEnabled, photoPermission });
        try {
            const filenames = [];
            let count = 0, result;
            for (let index = 0; index < parts.length; index++) {
                result = await downloadItems(parts[index], { ...options, diagnosticId: id,
                    downloadSettings: settings, photoHostAccess: photoPermission,
                    partNumber: index + 1, partCount: parts.length, startNumber: count + 1,
                    saveAs: parts.length === 1 });
                if (!result?.success) break;
                count += parts[index].length; filenames.push(result.filename);
            }
            if (result?.success && parts.length > 1) result = { success: true, count, partCount: parts.length, filenames };
            await diagnose(result?.success ? 'download_handoff' : 'download_failed', { id, error: result?.error });
            return result;
        } catch (error) {
            await diagnose('download_failed', { id, error: error.message });
            throw error;
        }
    }

    async function downloadItems(allItems, options) {
        const username = options.username || 'unknown';
        const mode = options.mode || 'posts';
        const format = options.format || 'csv';
        const isPostRows = mode === 'posts' || mode === 'bookmarks';
        const isUsers = !isPostRows;
        // Progress from a history re-download must not be mistaken for the
        // current export's download (the popup locks Home controls on it).
        const source = options.source === 'history' ? 'history' : 'current';
        let content;
        let mimeType;
        let extension;

        const settings = options.downloadSettings || await XPorterStorage.loadSettings();
        const headerOpts = {
            localize: settings.localizeExportHeaders === true,
            lang: settings.language || 'en',
            includeAboutAccountDetails:
                options.includeAboutAccountDetails === true,
            ...(options.populatedHeaders ? { populatedHeaders: options.populatedHeaders } : {})
        };

        if (format === 'pdf') {
            if (!isPostRows) return { error: 'FORMAT_UNSUPPORTED' };
            const translations = typeof loadTranslations === 'function'
                ? await loadTranslations(headerOpts.lang) : {};
            content = XPorterPDF.generate(allItems, options.profile || {}, {
                ...options, lang: headerOpts.lang, translations
            });
            mimeType = 'text/html;charset=utf-8;';
            extension = 'html';
        } else if (format === 'txt' && isPostRows) {
            content = XPorterCSV.generatePostsText(allItems, options.profile || {}, {
                mode,
                postSelection: options.postSelection || null
            });
            mimeType = 'text/plain;charset=utf-8;';
            extension = 'txt';
        } else if (format === 'json') {
            content = JSON.stringify(XPorterCSV.compactExportData(allItems), null, 2);
            mimeType = 'application/json;charset=utf-8;';
            extension = 'json';
        } else if (format === 'xlsx') {
            const embedPhotos = embedsPhotos(format, mode, settings);
            const progressBase = {
                type: 'DOWNLOAD_PROGRESS',
                source,
                partNumber: options.partNumber || 1,
                partCount: options.partCount || 1,
                count: allItems.length,
                format
            };
            const photoHostAccess = embedPhotos
                ? (options.photoHostAccess !== undefined
                    ? options.photoHostAccess
                    : await hasPhotoHostAccess())
                : false;
            const photos = (embedPhotos && photoHostAccess)
                ? await fetchPhotoAssets(
                    allItems,
                    options.photoAssetCache,
                    throttlePhotoProgress(({ current, total }) => {
                        reportDownload({
                            ...progressBase,
                            stage: 'photos',
                            photoCurrent: current,
                            photoTotal: total
                        });
                    })
                )
                : { assets: [], attempted: 0, skipped: 0 };
            const mediaAssets = photos.assets;
            if (options.diagnosticId) await diagnose('photos', { id: options.diagnosticId, attempted: photos.attempted,
                loaded: mediaAssets.length, failed: Math.max(0, photos.attempted - mediaAssets.length) });
            reportDownload({ ...progressBase, stage: 'building_xlsx' });
            content = await XPorterCSV.generateXLSXAsync(allItems, isUsers, {
                ...headerOpts,
                mode,
                postSelection: options.postSelection || null,
                ...(mediaAssets.length > 0 ? { mediaAssets, mediaSkippedCount: photos.skipped } : {}),
                ...(!isUsers ? { profile: options.profile || {} } : {})
            });
            mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            extension = 'xlsx';
        } else {
            content = XPorterCSV.generateCSV(allItems, isUsers, headerOpts);
            mimeType = 'text/csv;charset=utf-8;';
            extension = 'csv';
        }

        const filename = XPorterCSV.generateExportFilename(username, mode, extension, {
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
            exportedAt: options.exportedAt || new Date(),
            partNumber: options.partNumber,
            partCount: options.partCount
        });
        const result = await startDownload(content, mimeType, filename, options.saveAs !== false, options.diagnosticId);
        if (result.success) return { ...result, count: allItems.length, filename };
        return result;
    }

    const FEED_EXPORT_HEADERS = [
        'id', 'text', 'tweet_url', 'language', 'created_at',
        'author_id', 'author_name', 'author_username',
        'author_followers_count', 'first_author_followers_count', 'author_verified',
        'view_count', 'bookmark_count', 'favorite_count', 'retweet_count', 'reply_count', 'quote_count',
        'first_view_count', 'first_bookmark_count', 'first_favorite_count',
        'first_retweet_count', 'first_reply_count', 'first_quote_count',
        'first_seen_at', 'last_seen_at', 'seen_count', 'last_surface',
        'is_quote', 'is_retweet', 'media_count', 'media_types', 'media_alt_texts'
    ];

    async function downloadSeenPosts(outputFormat) {
        const format = outputFormat === 'json' ? 'json' : 'csv';
        const id = await diagnose('download_begin', { mode: 'seen_posts', source: 'seen_posts', format, parts: 1 });
        try {
            const result = await generateSeenPosts(format, id);
            await diagnose(result?.success ? 'download_handoff' : 'download_failed', { id, error: result?.error, rows: result?.count });
            return result;
        } catch (error) {
            await diagnose('download_failed', { id, error: error.message });
            throw error;
        }
    }

    async function generateSeenPosts(outputFormat, diagnosticId) {
        const posts = await XPorterPostDB.getAllPosts();
        if (posts.length === 0) return { error: 'NO_DATA' };

        const rows = posts.map(post => ({
            ...post,
            first_seen_at: post.first_seen_at ? new Date(post.first_seen_at).toISOString() : '',
            last_seen_at: post.last_seen_at ? new Date(post.last_seen_at).toISOString() : ''
        }));
        const format = outputFormat === 'json' ? 'json' : 'csv';
        let content;
        let mimeType;

        if (format === 'json') {
            content = JSON.stringify(
                XPorterCSV.compactExportData(
                    rows.map(({ created_at_ms, ...post }) => post)
                ),
                null,
                2
            );
            mimeType = 'application/json;charset=utf-8;';
        } else {
            // Plain row keys (the users path) with the feed column list.
            content = XPorterCSV.generateCSV(rows, true, { candidateHeaders: FEED_EXPORT_HEADERS });
            mimeType = 'text/csv;charset=utf-8;';
        }

        // Local wall-clock time, like the main export filenames.
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const stamp = [
            now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
            pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())
        ].join('-');
        const filename = `XPorter_seen_posts_${stamp}.${format}`;
        const result = await startDownload(content, mimeType, filename, true, diagnosticId);
        return result.success ? { ...result, count: rows.length, filename } : result;
    }

    function startDownload(content, mimeType, filename, saveAs = true, diagnosticId = null) {
        const blob = new Blob([content], { type: mimeType });
        const reader = new FileReader();
        return new Promise((resolve) => {
            reader.onerror = () => resolve({ error: 'DOWNLOAD_FAILED' });
            reader.onload = () => {
                // A synchronous throw here would otherwise leave this promise
                // pending forever and the current-download lock held.
                try {
                    chrome.downloads.download({
                        url: reader.result,
                        filename,
                        saveAs
                    }, (downloadId) => {
                        if (chrome.runtime.lastError || downloadId === undefined) {
                            XLog.error('Download failed:', chrome.runtime.lastError?.message);
                            resolve({ error: 'DOWNLOAD_FAILED' });
                            return;
                        }
                        Promise.resolve(globalThis.XPorterDownloadDiagnostics?.track(downloadId, diagnosticId, blob.size))
                            .catch(() => {}).finally(() => resolve({ success: true, downloadId }));
                    });
                } catch (error) {
                    XLog.error('Download failed:', error?.message);
                    resolve({ error: 'DOWNLOAD_FAILED' });
                }
            };
            reader.readAsDataURL(blob);
        });
    }

    globalThis.XPorterDownloads = {
        isCurrentDataReadActive,
        isCurrentDownloadActive,
        getCurrentPlan,
        startCurrentDownload,
        downloadCurrent,
        getCurrentPostsText,
        downloadHistory,
        downloadSeenPosts
    };
})();
