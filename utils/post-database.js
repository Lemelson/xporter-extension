// XPorter — local database for posts passively seen in X timelines.
// One IndexedDB row per post ID; repeat sightings update the existing row.
(function () {
    const DB_NAME = 'xporter_feed_stats';
    const DB_VERSION = 1;
    const STORE_POSTS = 'posts';
    const MAX_POSTS = 50000;
    const METRICS = [
        'view_count',
        'bookmark_count',
        'favorite_count',
        'retweet_count',
        'reply_count',
        'quote_count'
    ];

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
        });
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                const store = database.createObjectStore(STORE_POSTS, { keyPath: 'id' });
                store.createIndex('last_seen_at', 'last_seen_at');
                store.createIndex('created_at_ms', 'created_at_ms');
                store.createIndex('author_username', 'author_username');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function finiteCount(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
    }

    function cleanText(value, maxLength) {
        return typeof value === 'string' ? value.slice(0, maxLength) : '';
    }

    function normalizePost(post, context, seenAt) {
        const createdAtMs = Date.parse(post.created_at || '');
        const normalized = {
            id: String(post.id),
            text: cleanText(post.text, 25000),
            tweet_url: cleanText(post.tweet_url, 300),
            language: cleanText(post.language, 16),
            created_at: cleanText(post.created_at, 80),
            created_at_ms: Number.isFinite(createdAtMs) ? createdAtMs : 0,
            author_id: cleanText(post.author_id, 32),
            author_name: cleanText(post.author_name, 200),
            author_username: cleanText(post.author_username, 40),
            author_followers_count: finiteCount(post.author_followers_count),
            first_author_followers_count: finiteCount(post.author_followers_count),
            author_verified: Boolean(post.author_verified),
            is_quote: Boolean(post.is_quote),
            is_retweet: Boolean(post.is_retweet),
            media_count: finiteCount(post.media_count) || 0,
            media_types: cleanText(post.media_types, 80),
            first_seen_at: seenAt,
            last_seen_at: seenAt,
            seen_count: 1,
            last_surface: cleanText(context?.operationName, 80)
        };

        for (const metric of METRICS) {
            const value = finiteCount(post[metric]);
            normalized[metric] = value;
            normalized[`first_${metric}`] = value;
        }
        return normalized;
    }

    function mergePost(existing, incoming, context, seenAt) {
        const next = { ...existing, ...incoming };
        for (const field of [
            'text', 'tweet_url', 'language', 'created_at',
            'author_id', 'author_name', 'author_username', 'media_types'
        ]) {
            if (!incoming[field]) next[field] = existing[field] || incoming[field];
        }
        if (!incoming.created_at_ms) next.created_at_ms = existing.created_at_ms || 0;
        next.first_seen_at = existing.first_seen_at || seenAt;
        next.last_seen_at = seenAt;
        next.seen_count = (Number(existing.seen_count) || 1) + 1;
        next.last_surface = cleanText(context?.operationName, 80) || existing.last_surface || '';
        next.author_verified = Boolean(existing.author_verified || incoming.author_verified);

        for (const metric of METRICS) {
            next[`first_${metric}`] = existing[`first_${metric}`] ?? existing[metric] ?? incoming[metric];
            if (incoming[metric] === null) next[metric] = existing[metric] ?? null;
        }
        if (incoming.author_followers_count === null) {
            next.author_followers_count = existing.author_followers_count ?? null;
        }
        next.first_author_followers_count = existing.first_author_followers_count
            ?? existing.author_followers_count
            ?? incoming.author_followers_count;
        return next;
    }

    async function upsertPosts(posts, context = {}) {
        if (!Array.isArray(posts) || posts.length === 0) return { inserted: 0, updated: 0 };

        const database = await openDatabase();
        const transaction = database.transaction(STORE_POSTS, 'readwrite');
        const done = transactionDone(transaction);
        const store = transaction.objectStore(STORE_POSTS);
        const seenAt = Date.now();
        let inserted = 0;
        let updated = 0;

        for (const post of posts) {
            if (!post?.id || !/^\d{5,30}$/.test(String(post.id))) continue;
            const normalized = normalizePost(post, context, seenAt);
            const existing = await requestResult(store.get(normalized.id));
            if (existing) {
                store.put(mergePost(existing, normalized, context, seenAt));
                updated += 1;
            } else {
                store.add(normalized);
                inserted += 1;
            }
        }

        await done;
        database.close();

        if (inserted > 0) await trimToLimit();
        return { inserted, updated };
    }

    async function trimToLimit() {
        const database = await openDatabase();
        const countTransaction = database.transaction(STORE_POSTS, 'readonly');
        const countDone = transactionDone(countTransaction);
        const count = await requestResult(countTransaction.objectStore(STORE_POSTS).count());
        await countDone;
        if (count <= MAX_POSTS) {
            database.close();
            return 0;
        }

        const removeCount = count - MAX_POSTS;
        const transaction = database.transaction(STORE_POSTS, 'readwrite');
        const done = transactionDone(transaction);
        const index = transaction.objectStore(STORE_POSTS).index('last_seen_at');
        let removed = 0;
        await new Promise((resolve, reject) => {
            const request = index.openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || removed >= removeCount) {
                    resolve();
                    return;
                }
                cursor.delete();
                removed += 1;
                cursor.continue();
            };
        });
        await done;
        database.close();
        return removed;
    }

    async function getSummary() {
        const database = await openDatabase();
        const transaction = database.transaction(STORE_POSTS, 'readonly');
        const done = transactionDone(transaction);
        const store = transaction.objectStore(STORE_POSTS);
        const count = await requestResult(store.count());
        let lastSeenAt = 0;

        if (count > 0) {
            lastSeenAt = await new Promise((resolve, reject) => {
                const request = store.index('last_seen_at').openCursor(null, 'prev');
                request.onsuccess = () => resolve(request.result?.value?.last_seen_at || 0);
                request.onerror = () => reject(request.error);
            });
        }
        await done;
        database.close();
        return { count, lastSeenAt, maxPosts: MAX_POSTS };
    }

    async function getAllPosts() {
        const database = await openDatabase();
        const transaction = database.transaction(STORE_POSTS, 'readonly');
        const done = transactionDone(transaction);
        const posts = await requestResult(transaction.objectStore(STORE_POSTS).getAll());
        await done;
        database.close();
        posts.sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
        return posts;
    }

    async function clear() {
        const database = await openDatabase();
        const transaction = database.transaction(STORE_POSTS, 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_POSTS).clear();
        await done;
        database.close();
    }

    globalThis.XPorterPostDB = {
        upsertPosts,
        getSummary,
        getAllPosts,
        clear,
        mergePost,
        MAX_POSTS,
        METRICS
    };
})();
