// XPorter — Export Format Generator
// Single source of truth for CSV, XLSX, and AI-friendly posts TXT generation.
// (JSON export is generated directly in background/downloads.js.)
// Used by service-worker.js via importScripts.

// ==================== Header Definitions ====================

const POST_CONTEXT_FIELDS = [
    'id', 'type', 'text', 'url', 'author_name', 'author_username',
    'view_count', 'bookmark_count', 'favorite_count', 'retweet_count',
    'reply_count', 'quote_count', 'created_at',
    'media_type', 'media_urls', 'media_alt_texts',
    'article_title', 'article_url', 'article_text'
];

const POSTS_HEADERS = [
    'id', 'text', 'tweet_url', 'language', 'type',
    'author_name', 'author_username', 'view_count',
    'bookmark_count', 'favorite_count', 'retweet_count',
    'reply_count', 'quote_count', 'created_at', 'source',
    'hashtags', 'urls', 'media_type', 'media_urls', 'media_alt_texts',
    'article_title', 'article_url', 'article_text',
    'reply_to_id', 'reply_to_username', 'conversation_id',
    ...POST_CONTEXT_FIELDS.map(field => `reply_to_post_${field}`),
    ...POST_CONTEXT_FIELDS.map(field => `reply_to_quoted_post_${field}`),
    ...POST_CONTEXT_FIELDS.map(field => `quoted_post_${field}`)
];

const USERS_HEADERS = [
    'id', 'name', 'username', 'bio', 'location', 'url',
    'followers_count', 'following_count', 'tweet_count', 'listed_count',
    'verified', 'protected', 'created_at', 'profile_image_url', 'profile_url'
];

const USER_ABOUT_HEADERS = [
    'account_based_in', 'account_location_accurate', 'premium_since',
    'account_source', 'affiliate_username', 'username_change_count',
    'username_last_changed_at'
];

function exportHeaders(isUsers, opts = {}) {
    if (!isUsers) return POSTS_HEADERS;
    return opts.includeAboutAccountDetails
        ? [...USERS_HEADERS, ...USER_ABOUT_HEADERS]
        : USERS_HEADERS;
}

// Spreadsheet number typing is limited to engagement/profile counters. Any
// other column (text, names, IDs) stays a string even when it looks numeric,
// so a post whose text is "1.50" is not rewritten as 1.5.
const XLSX_NUMERIC_KEYS = new Set(
    [...POSTS_HEADERS, ...USERS_HEADERS, ...USER_ABOUT_HEADERS]
        .filter(key => key.endsWith('_count'))
);

function xlsxHeaders(items, isUsers, opts = {}) {
    const candidates = Array.isArray(opts.candidateHeaders)
        ? opts.candidateHeaders
        : exportHeaders(isUsers, opts);
    if (opts.populatedHeaders) {
        // Multipart downloads decide columns once for the whole export so
        // every part has the same layout, even when a column only has values
        // in a later part.
        const populated = new Set(opts.populatedHeaders);
        const keys = candidates.filter(key => populated.has(key));
        return keys.length > 0 ? keys : [candidates[0] || 'id'];
    }
    return selectPopulatedHeaders(
        items,
        candidates,
        (item, key) => exportValue(item, key, isUsers)
    );
}

/**
 * Add every CSV/XLSX column that has a value in `items` to `into`. Calling it
 * once per batch builds the union used by `opts.populatedHeaders`.
 */
function collectPopulatedHeaders(items, isUsers = false, opts = {}, into = new Set()) {
    for (const key of exportHeaders(isUsers, opts)) {
        if (into.has(key)) continue;
        if ((items || []).some(item => hasExportValue(exportValue(item, key, isUsers)))) {
            into.add(key);
        }
    }
    return into;
}

function hasExportValue(value) {
    if (value === undefined || value === null) return false;
    return typeof value !== 'string' || value.trim() !== '';
}

function selectPopulatedHeaders(items, candidates, valueFor = (item, key) => item?.[key]) {
    const populated = candidates.filter(key =>
        items.some(item => hasExportValue(valueFor(item, key)))
    );
    // Downloads normally require at least one row. Keep an empty dataset
    // structurally valid if a serializer is ever called without rows.
    return populated.length > 0 ? populated : [candidates[0] || 'id'];
}

function compactExportData(items) {
    if (!Array.isArray(items)) return [];
    return items.map(item => compactExportValue(item) || {});
}

function compactExportValue(value) {
    if (!hasExportValue(value)) return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    if (Array.isArray(value)) {
        const values = value
            .map(compactExportValue)
            .filter(item => item !== undefined);
        return values.length > 0 ? values : undefined;
    }
    if (typeof value === 'object') {
        const result = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const compacted = compactExportValue(nestedValue);
            if (compacted !== undefined) result[key] = compacted;
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }
    return value;
}

// ==================== CSV ====================

/**
 * Escape a single CSV value according to RFC 4180.
 */
function escapeCSVValue(val) {
    val = String(val ?? '');
    // CSV/formula-injection guard: spreadsheet apps may treat a cell starting
    // with = + - @ as a formula, sometimes after trimming leading whitespace.
    // Export data is third-party controlled (tweet text, bios, names), so force
    // those values to plain text before the RFC-4180 quoting below.
    if (/^\s*[=+\-@]/.test(val)) {
        val = "'" + val;
    }
    if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
}

/**
 * Generate CSV string from an array of objects.
 * @param {Array} items - Array of data objects
 * @param {boolean} isUsers - true for followers/following, false for posts
 * @returns {string} CSV with BOM prefix for Excel compatibility
 */
function generateCSV(items, isUsers = false, opts = {}) {
    const keys = xlsxHeaders(items, isUsers, opts);
    const labels = headerLabels(keys, opts);
    const rows = [labels.map(escapeCSVValue).join(',')];

    for (const item of items) {
        rows.push(keys.map(h => escapeCSVValue(exportValue(item, h, isUsers))).join(','));
    }

    return '\uFEFF' + rows.join('\n') + '\n'; // BOM for correct Unicode in Excel
}

// ==================== Posts TXT ====================

/**
 * Generate a compact, AI-friendly plain-text document for a single profile's
 * posts. Optional profile fields are omitted when X did not return them.
 */
function generatePostsText(items, profile = {}, opts = {}) {
    const isBookmarks = opts.mode === 'bookmarks';
    const lines = [];
    if (!isBookmarks) {
        lines.push('PROFILE');
        for (const [label, value] of profileMetadataRows(profile)) {
            lines.push(`${label}: ${value}`);
        }
        lines.push('');
    }
    lines.push(`${isBookmarks ? 'BOOKMARKS' : 'POSTS'} (${items.length})`);
    if (!isBookmarks) {
        const includedTypes = selectedPostTypeLabels(opts.postSelection);
        if (includedTypes.length > 0) {
            lines.push(`Included types: ${includedTypes.join(', ')}`);
        }
    }
    lines.push('');

    // Use one visible sequence so the final number always matches POSTS (N).
    // Reply relationships stay explicit through a direct parent reference and
    // a complete in-export chain, rather than hiding rows under numbers such
    // as 97.1 or 97.1.1.
    const itemById = new Map();
    const numberById = new Map();
    items.forEach((item, index) => {
        if (item?.id) {
            const id = String(item.id);
            if (!itemById.has(id)) {
                itemById.set(id, item);
                numberById.set(id, index + 1);
            }
        }
    });

    const emitItem = (item, number) => {
        if (!item) return;

        const meta = [];
        addMetric(meta, item.view_count, 'views');
        addMetric(meta, item.favorite_count, 'likes');
        addMetric(meta, item.retweet_count, 'reposts');
        addMetric(meta, item.reply_count, 'replies');
        addMetric(meta, item.quote_count, 'quotes');
        addMetric(meta, item.bookmark_count, 'bookmarks');

        lines.push(`${number}. ${txtEntryType(item)}`);
        if (shouldShowTxtAuthor(item, profile)) {
            const author = formatTxtAuthor(item, profile);
            if (author) lines.push(`Author: ${author}`);
        }
        if (cleanTxtValue(item.text)) lines.push(`Post: "${cleanTxtValue(item.text)}"`);
        if (meta.length) lines.push(`Post metrics: ${meta.join(', ')}`);
        if (item.reply_to_id) {
            const parentId = String(item.reply_to_id);
            const parent = itemById.get(parentId);
            const parentNumber = numberById.get(parentId);
            const replyToUrl = parent?.tweet_url || formatReplyToUrl(item);
            if (parent && parentNumber) {
                const suffix = replyToUrl ? ` — ${replyToUrl}` : '';
                lines.push(`Reply to: post #${parentNumber}${suffix}`);
                const chain = buildTxtReplyChain(item, number, itemById, numberById);
                if (chain.length > 1) {
                    lines.push(`Reply chain: ${chain.map(value => `#${value}`).join(' → ')}`);
                }
            } else if (replyToUrl) {
                if (item.reply_to_post) {
                    appendContextPost(lines, 'Reply to post', item.reply_to_post);
                } else {
                    lines.push(`Reply to: ${replyToUrl}`);
                }
            }
        }
        appendQuotedPost(lines, item.quoted_post);
        if (cleanTxtValue(item.article_title)) {
            lines.push(`Article title: ${cleanTxtValue(item.article_title)}`);
        }
        if (cleanTxtValue(item.article_text)) {
            lines.push(`Article text: ${cleanTxtValue(item.article_text)}`);
        }
        if (item.article_url) lines.push(`Article URL: ${item.article_url}`);
        const createdAt = formatTxtDate(item.created_at);
        if (createdAt) lines.push(`Date: ${createdAt}`);
        if (item.tweet_url) lines.push(`Post URL: ${item.tweet_url}`);
        lines.push('');
    };

    items.forEach((item, index) => emitItem(item, index + 1));

    return lines.join('\n').trimEnd() + '\n';
}

function selectedPostTypeLabels(settings = {}) {
    if (settings?.postSelectionVersion !== 1) return [];
    const labels = [];
    if (settings.includeOriginalPosts === true) labels.push('Original posts');
    if (settings.includeQuotes === true) labels.push('Quotes');
    if (settings.includeReplies === true) labels.push('Replies');
    if (settings.includeRetweets === true) labels.push('Reposts');
    if (settings.includeArticles === true) labels.push('Articles');
    return labels;
}

function profileMetadataRows(profile = {}) {
    const rows = [];
    const add = (label, value) => {
        if (value === undefined || value === null || value === '') return;
        rows.push([label, value]);
    };
    const username = profile.screenName || profile.username || '';

    add('Name', profile.name);
    add('Username', username ? '@' + String(username).replace(/^@/, '') : '');
    add('Profile', profile.profileUrl || profile.profile_url || (username ? `https://x.com/${username}` : ''));
    add('Bio', cleanTxtValue(profile.bio));
    add('Category', profile.professionalCategory || profile.professional_category);
    add('Location', profile.location);
    add('Website', profile.url);
    add('Joined', formatTxtDate(profile.createdAt || profile.created_at));
    add('Account based in', profile.accountBasedIn || profile.account_based_in);
    const locationAccurate = profile.locationAccurate ?? profile.location_accurate;
    if (typeof locationAccurate === 'boolean') {
        add('Account location accurate', locationAccurate ? 'yes' : 'no');
    }
    const premiumSince = profile.premiumSince || profile.premium_since;
    const premiumKnown = typeof profile.isVerified === 'boolean'
        || typeof profile.verified === 'boolean'
        || Boolean(premiumSince);
    if (premiumKnown) {
        add('Premium', profile.isVerified || profile.verified || premiumSince ? 'yes' : 'no');
    }
    add('Premium since', formatTxtDate(premiumSince));
    add('Connected via', profile.accountSource || profile.account_source);
    const affiliateUsername = profile.affiliateUsername || profile.affiliate_username || '';
    add(
        'Affiliate account',
        affiliateUsername ? '@' + String(affiliateUsername).replace(/^@/, '') : ''
    );
    add('Username changes', profile.usernameChangeCount ?? profile.username_change_count);
    add(
        'Username last changed',
        formatTxtDate(profile.usernameLastChangedAt || profile.username_last_changed_at)
    );
    add('Followers', profile.followersCount ?? profile.followers_count);
    add('Following', profile.followingCount ?? profile.following_count);
    add('Subscriptions', profile.subscriptionsCount ?? profile.subscriptions_count);
    add('Posts', profile.tweetCount ?? profile.tweet_count);
    add('Likes', profile.likesCount ?? profile.likes_count);
    add('Listed', profile.listedCount ?? profile.listed_count);
    add('Media', profile.mediaCount ?? profile.media_count);
    add('Profile image', profile.profileImageUrl || profile.profile_image_url);
    return rows;
}

function buildTxtReplyChain(item, itemNumber, itemById, numberById) {
    const chain = [itemNumber];
    const seenIds = new Set();
    if (item?.id) seenIds.add(String(item.id));
    let parentId = item?.reply_to_id ? String(item.reply_to_id) : '';

    while (parentId && itemById.has(parentId) && !seenIds.has(parentId)) {
        seenIds.add(parentId);
        const parentNumber = numberById.get(parentId);
        if (!parentNumber) break;
        chain.push(parentNumber);
        const parent = itemById.get(parentId);
        parentId = parent?.reply_to_id ? String(parent.reply_to_id) : '';
    }

    return chain.reverse();
}

function txtEntryType(item) {
    if (item.article_title || item.article_text || item.type === 'article') return 'ARTICLE';
    if (item.type === 'reply') return 'REPLY';
    if (item.type === 'retweet') return 'REPOST';
    if (item.type === 'quote') return 'QUOTE';
    return 'POST';
}

function formatTxtAuthor(item, profile) {
    const name = item.author_name || profile.name || '';
    const username = String(item.author_username || profile.screenName || profile.username || '').replace(/^@/, '');
    if (name && username) return `${cleanTxtValue(name)} (@${username})`;
    if (username) return `@${username}`;
    return cleanTxtValue(name);
}

function shouldShowTxtAuthor(item, profile) {
    if (item?.type === 'retweet') return true;

    const itemUsername = String(item?.author_username || '').replace(/^@/, '').toLowerCase();
    const profileUsername = String(profile?.screenName || profile?.username || '').replace(/^@/, '').toLowerCase();
    if (itemUsername && profileUsername) return itemUsername !== profileUsername;
    if (itemUsername) return true;

    const itemName = cleanTxtValue(item?.author_name).toLowerCase();
    const profileName = cleanTxtValue(profile?.name).toLowerCase();
    return Boolean(itemName && profileName && itemName !== profileName);
}

function appendQuotedPost(lines, quotedPost) {
    if (!quotedPost) return;
    appendContextPost(lines, 'Quoted post', quotedPost);
}

function appendContextPost(lines, label, post, indent = '') {
    if (!post) return;

    lines.push(`${indent}${label}:`);
    const detailIndent = `${indent}  `;
    const author = formatTxtAuthor(post, {});
    if (author) lines.push(`${detailIndent}Author: ${author}`);
    const text = cleanTxtValue(post.text);
    if (text) lines.push(`${detailIndent}Post: "${text}"`);
    const metrics = [];
    addMetric(metrics, post.view_count, 'views');
    addMetric(metrics, post.favorite_count, 'likes');
    addMetric(metrics, post.retweet_count, 'reposts');
    addMetric(metrics, post.reply_count, 'replies');
    addMetric(metrics, post.quote_count, 'quotes');
    addMetric(metrics, post.bookmark_count, 'bookmarks');
    if (metrics.length) {
        lines.push(`${detailIndent}${label} metrics: ${metrics.join(', ')}`);
    }
    if (post.quoted_post) {
        appendContextPost(lines, 'Quoted post', post.quoted_post, detailIndent);
    }
    const media = formatContextMedia(post);
    if (media) lines.push(`${detailIndent}Media: ${media}`);
    const articleTitle = cleanTxtValue(post.article_title);
    const articleText = cleanTxtValue(post.article_text);
    if (articleTitle) lines.push(`${detailIndent}Article title: ${articleTitle}`);
    if (articleText) lines.push(`${detailIndent}Article text: ${articleText}`);
    if (post.article_url) lines.push(`${detailIndent}Article URL: ${post.article_url}`);
    const createdAt = formatTxtDate(post.created_at);
    if (createdAt) lines.push(`${detailIndent}Date: ${createdAt}`);
    if (post.tweet_url) lines.push(`${detailIndent}Post URL: ${post.tweet_url}`);
}

function formatContextMedia(post) {
    const mediaType = cleanTxtValue(post?.media_type);
    const mediaUrls = cleanTxtValue(post?.media_urls);
    if (mediaType && mediaUrls) return `${mediaType} — ${mediaUrls}`;
    return mediaType || mediaUrls;
}

function formatReplyToUrl(item) {
    if (!item.reply_to_id) return '';
    const username = String(item.reply_to_username || '').replace(/^@/, '');
    return username
        ? `https://x.com/${username}/status/${item.reply_to_id}`
        : `https://x.com/i/web/status/${item.reply_to_id}`;
}

function cleanTxtValue(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function formatTxtDate(value) {
    if (!value) return '';
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : cleanTxtValue(value);
}

function addMetric(target, value, label) {
    if (value === undefined || value === null || value === '') return;
    const singular = { views: 'view', likes: 'like', reposts: 'repost', replies: 'reply', quotes: 'quote', bookmarks: 'bookmark' };
    target.push(`${value} ${Number(value) === 1 ? (singular[label] || label) : label}`);
}

function exportValue(item, key, isUsers = false) {
    if (isUsers) return item?.[key];
    if (key.startsWith('reply_to_quoted_post_')) {
        return contextValue(item?.reply_to_post?.quoted_post, key.slice('reply_to_quoted_post_'.length));
    }
    if (key.startsWith('reply_to_post_')) {
        return contextValue(item?.reply_to_post, key.slice('reply_to_post_'.length));
    }
    if (key.startsWith('quoted_post_')) {
        return contextValue(item?.quoted_post, key.slice('quoted_post_'.length));
    }
    return item?.[key];
}

function contextValue(context, field) {
    if (!context) return '';
    return context[field === 'url' ? 'tweet_url' : field];
}

/**
 * Resolve the header-row labels. Data keys (`item[key]`) never change; only the
 * displayed header text is localized, and only when `opts.localize` is set.
 * @param {string[]} keys
 * @param {Object} [opts] - { localize?: boolean, lang?: string }
 * @returns {string[]} labels aligned with `keys`
 */
function headerLabels(keys, opts = {}) {
    if (!opts.localize || typeof XPorterColumns === 'undefined') return keys;
    return keys.map(k => XPorterColumns.columnLabel(k, opts.lang || 'en'));
}

// ==================== XLSX (OOXML ZIP) ====================

// Characters that XML 1.0 forbids (C0 controls other than tab/LF/CR, the
// U+FFFE/U+FFFF noncharacters) and UTF-16 code units that are not part of a
// surrogate pair. A single one in tweet text makes Excel show a repair dialog
// and LibreOffice silently drop the rest of the sheet, so they are removed.
const XML_INVALID_TEXT = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escape XML special characters and remove code units that are invalid in
 * XML 1.0. Every text value written into an XLSX part goes through here.
 */
function escapeXml(str) {
    return String(str ?? '').replace(XML_INVALID_TEXT, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Excel's hard per-cell limit is 32,767 characters. CSV/JSON keep the full
// value; XLSX must stay within the format contract so one unusually long
// article cannot make the workbook unreadable. The cut is marked visibly.
const XLSX_CELL_MAX_CHARS = 32767;
const XLSX_TRUNCATION_MARKER = '…[truncated]';

function xlsxCellText(value) {
    let text = String(value ?? '');
    if (text.length <= XLSX_CELL_MAX_CHARS) return text;
    text = text.slice(0, XLSX_CELL_MAX_CHARS - XLSX_TRUNCATION_MARKER.length);
    // The cut can land mid-emoji; never keep half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return text + XLSX_TRUNCATION_MARKER;
}

function xlsxInlineStringCell(ref, text, styleAttr = '') {
    const preserve = /^\s|\s$|[\n\r\t]/.test(text) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`;
}

/**
 * Build the worksheet rows for one sheet. Empty values produce no cell.
 * @param {Array<Object>} rows - [{ values, dataKeys?, styles? }]
 */
function buildWorksheetRows(rows) {
    return rows.map(({ values = [], dataKeys = null, styles = null }, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cells = [];
        values.forEach((value, index) => {
            if (value === undefined || value === null || value === '') return;
            const val = xlsxCellText(value);
            const key = dataKeys?.[index] || '';
            // Keep identifiers and very long digit strings as text — Excel
            // stores numbers as IEEE-754 doubles and would corrupt post IDs.
            const numericColumn = dataKeys ? XLSX_NUMERIC_KEYS.has(key) : typeof value === 'number';
            const isNumber = numericColumn &&
                /^-?(0|[1-9]\d*)(\.\d+)?$/.test(val) && val.length <= 15;
            const ref = `${columnName(index + 1)}${rowNumber}`;
            const style = Array.isArray(styles) ? styles[index] : styles;
            const styleAttr = Number.isInteger(style) && style > 0 ? ` s="${style}"` : '';
            cells.push(isNumber
                ? `<c r="${ref}"${styleAttr}><v>${val}</v></c>`
                : xlsxInlineStringCell(ref, val, styleAttr));
        });
        return `<row r="${rowNumber}">${cells.join('')}</row>`;
    }).join('');
}

const XLSX_XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const XLSX_MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XLSX_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XLSX_PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XLSX_WORKSHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

/**
 * Generate a real XLSX workbook (OOXML ZIP) without external dependencies.
 * `generateXLSX` stores entries uncompressed; `generateXLSXAsync` deflates the
 * XML parts when the platform provides CompressionStream.
 * @param {Array} items - Array of data objects
 * @param {boolean} isUsers - true for followers/following, false for posts
 * @returns {Uint8Array} XLSX bytes
 */
function generateXLSX(items, isUsers = false, opts = {}) {
    return createZip(buildXlsxEntries(items, isUsers, opts));
}

/**
 * Same workbook as `generateXLSX`, with DEFLATE-compressed XML parts when
 * CompressionStream('deflate-raw') is available (STORE otherwise).
 * @returns {Promise<Uint8Array>}
 */
function generateXLSXAsync(items, isUsers = false, opts = {}) {
    return createZipAsync(buildXlsxEntries(items, isUsers, opts));
}

function buildXlsxEntries(items, isUsers = false, opts = {}) {
    const keys = xlsxHeaders(items, isUsers, opts);
    const labels = headerLabels(keys, opts);
    const mediaAssets = Array.isArray(opts.mediaAssets)
        ? opts.mediaAssets.filter((asset) =>
            asset?.bytes instanceof Uint8Array &&
            asset.bytes.length > 0 &&
            /^(png|jpe?g|gif)$/i.test(String(asset.extension || ''))
        )
        : [];

    // The data sheet always starts with its header row so the frozen pane
    // and filter cover exactly one row. Profile metadata lives on its own
    // sheet instead of pushing the table (and the frozen area) down.
    const dataRows = [{ values: labels, styles: 3 }];
    for (const item of items) {
        dataRows.push({ values: keys.map(key => exportValue(item, key, isUsers)), dataKeys: keys });
    }

    const isBookmarks = opts.mode === 'bookmarks';
    const profileRows = (isUsers || isBookmarks) ? [] : profileMetadataRows(opts.profile || {});
    let profileSheet = null;
    if (profileRows.length > 0) {
        const rows = [{ values: ['PROFILE'], styles: 1 }];
        for (const row of profileRows) rows.push({ values: row, styles: [2, 4] });
        const includedTypes = selectedPostTypeLabels(opts.postSelection);
        if (includedTypes.length > 0) {
            rows.push({ values: ['Included post types', includedTypes.join(', ')], styles: [2, 4] });
        }
        rows.push({ values: [] });
        rows.push({ values: [`POSTS (${items.length})`], styles: 1 });
        profileSheet = [
            XLSX_XML_DECLARATION,
            `<worksheet xmlns="${XLSX_MAIN_NS}">`,
            `<dimension ref="A1:B${rows.length}"/>`,
            '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>',
            '<sheetFormatPr defaultRowHeight="15"/>',
            '<cols><col min="1" max="1" width="28" customWidth="1"/>',
            '<col min="2" max="2" width="80" customWidth="1"/></cols>',
            `<sheetData>${buildWorksheetRows(rows)}</sheetData>`,
            '</worksheet>'
        ].join('');
    }

    const lastRow = dataRows.length;
    const lastColumn = columnName(keys.length);
    const columnWidths = keys.map((key, index) => {
        const width = isUsers ? userColumnWidth(key) : postColumnWidth(key);
        return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    }).join('');
    const worksheet = [
        XLSX_XML_DECLARATION,
        `<worksheet xmlns="${XLSX_MAIN_NS}">`,
        `<dimension ref="A1:${lastColumn}${lastRow}"/>`,
        '<sheetViews><sheetView showGridLines="0" workbookViewId="0">' +
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
            '</sheetView></sheetViews>',
        '<sheetFormatPr defaultRowHeight="15"/>',
        `<cols>${columnWidths}</cols>`,
        `<sheetData>${buildWorksheetRows(dataRows)}</sheetData>`,
        `<autoFilter ref="A1:${lastColumn}${lastRow}"/>`,
        '</worksheet>'
    ].join('');
    const styles = [
        XLSX_XML_DECLARATION,
        `<styleSheet xmlns="${XLSX_MAIN_NS}">`,
        '<fonts count="2">',
        '<font><sz val="11"/><name val="Aptos"/></font>',
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font>',
        '</fonts>',
        '<fills count="5">',
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FF16324F"/><bgColor indexed="64"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F0F7"/><bgColor indexed="64"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FF245A7A"/><bgColor indexed="64"/></patternFill></fill>',
        '</fills>',
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
        '<cellXfs count="5">',
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
        '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"><alignment vertical="top"/></xf>',
        '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="center"/></xf>',
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf>',
        '</cellXfs>',
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
        '</styleSheet>'
    ].join('');

    const hasMediaSheet = !isUsers && mediaAssets.length > 0;
    const mediaPackage = hasMediaSheet
        ? buildXlsxMediaPackage(mediaAssets, opts.mediaSkippedCount)
        : null;
    const imageContentTypes = hasMediaSheet
        ? [...new Map(mediaAssets.map((asset) => [
            String(asset.extension).toLowerCase().replace('jpeg', 'jpg'),
            String(asset.contentType || '').toLowerCase() || 'image/jpeg'
        ])).entries()].map(([extension, contentType]) =>
            `<Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(contentType)}"/>`
        ).join('')
        : '';

    // Workbook order: data first, then the profile, then photos. Part names
    // stay stable (sheet2 has always been Media) independent of that order.
    const sheets = [{ name: 'Export', part: 'worksheets/sheet1.xml' }];
    if (profileSheet) sheets.push({ name: 'Profile', part: 'worksheets/sheet3.xml' });
    if (hasMediaSheet) sheets.push({ name: 'Media', part: 'worksheets/sheet2.xml' });
    const stylesRelationshipId = `rId${sheets.length + 1}`;

    const entries = [
        {
            name: '[Content_Types].xml',
            content: XLSX_XML_DECLARATION +
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                '<Default Extension="xml" ContentType="application/xml"/>' +
                imageContentTypes +
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                sheets.map(sheet =>
                    `<Override PartName="/xl/${sheet.part}" ContentType="${XLSX_WORKSHEET_TYPE}"/>`
                ).join('') +
                (hasMediaSheet
                    ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
                    : '') +
                '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
                '</Types>'
        },
        {
            name: '_rels/.rels',
            content: XLSX_XML_DECLARATION +
                `<Relationships xmlns="${XLSX_PACKAGE_REL_NS}">` +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
                '</Relationships>'
        },
        {
            name: 'xl/workbook.xml',
            content: XLSX_XML_DECLARATION +
                `<workbook xmlns="${XLSX_MAIN_NS}" xmlns:r="${XLSX_REL_NS}"><sheets>` +
                sheets.map((sheet, index) =>
                    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
                ).join('') +
                '</sheets></workbook>'
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            content: XLSX_XML_DECLARATION +
                `<Relationships xmlns="${XLSX_PACKAGE_REL_NS}">` +
                sheets.map((sheet, index) =>
                    `<Relationship Id="rId${index + 1}" Type="${XLSX_REL_NS}/worksheet" Target="${sheet.part}"/>`
                ).join('') +
                `<Relationship Id="${stylesRelationshipId}" Type="${XLSX_REL_NS}/styles" Target="styles.xml"/>` +
                '</Relationships>'
        },
        { name: 'xl/styles.xml', content: styles },
        { name: 'xl/worksheets/sheet1.xml', content: worksheet }
    ];
    if (profileSheet) entries.push({ name: 'xl/worksheets/sheet3.xml', content: profileSheet });
    if (mediaPackage) entries.push(...mediaPackage);
    return entries;
}

function buildXlsxMediaPackage(mediaAssets, skippedCount = 0) {
    const cell = (ref, value, style = 4) =>
        xlsxInlineStringCell(ref, xlsxCellText(value), ` s="${style}"`);
    const rows = [
        `<row r="1">${[
            cell('A1', 'Export row ID', 3),
            cell('B1', 'Media post ID', 3),
            cell('C1', 'Relationship', 3),
            cell('D1', 'Media URL', 3),
            cell('E1', 'Photo', 3)
        ].join('')}</row>`
    ];
    const anchors = [];
    const relationships = [];
    const imageEntries = [];
    const maxWidthPx = 160;
    const maxHeightPx = 96;
    const emuPerPixel = 9525;

    mediaAssets.forEach((asset, index) => {
        const rowNumber = index + 2;
        rows.push(
            `<row r="${rowNumber}" ht="78" customHeight="1">` +
            cell(`A${rowNumber}`, asset.postId) +
            cell(`B${rowNumber}`, asset.contextPostId || asset.postId) +
            cell(`C${rowNumber}`, asset.relation) +
            cell(`D${rowNumber}`, asset.sourceUrl) +
            cell(`E${rowNumber}`, '') +
            '</row>'
        );

        const sourceWidth = Math.max(1, Number(asset.width) || maxWidthPx);
        const sourceHeight = Math.max(1, Number(asset.height) || maxHeightPx);
        const scale = Math.min(maxWidthPx / sourceWidth, maxHeightPx / sourceHeight);
        const widthPx = Math.max(1, Math.round(sourceWidth * scale));
        const heightPx = Math.max(1, Math.round(sourceHeight * scale));
        const colOffset = Math.round((maxWidthPx - widthPx) / 2) * emuPerPixel;
        const rowOffset = Math.round((maxHeightPx - heightPx) / 2) * emuPerPixel;
        const relationshipId = `rId${index + 1}`;
        anchors.push(
            '<xdr:oneCellAnchor>' +
            `<xdr:from><xdr:col>4</xdr:col><xdr:colOff>${colOffset}</xdr:colOff>` +
            `<xdr:row>${rowNumber - 1}</xdr:row><xdr:rowOff>${rowOffset}</xdr:rowOff></xdr:from>` +
            `<xdr:ext cx="${widthPx * emuPerPixel}" cy="${heightPx * emuPerPixel}"/>` +
            '<xdr:pic>' +
            `<xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Photo ${index + 1}"/>` +
            '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
            `<xdr:blipFill><a:blip r:embed="${relationshipId}"/>` +
            '<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
            '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>' +
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
            '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
        );
        const extension = String(asset.extension).toLowerCase().replace('jpeg', 'jpg');
        relationships.push(
            `<Relationship Id="${relationshipId}" ` +
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
            `Target="../media/image${index + 1}.${escapeXml(extension)}"/>`
        );
        imageEntries.push({
            name: `xl/media/image${index + 1}.${extension}`,
            content: asset.bytes
        });
    });

    const lastRow = mediaAssets.length + 1;
    const skipped = Math.max(0, Math.floor(Number(skippedCount) || 0));
    let lastUsedRow = lastRow;
    if (skipped > 0) {
        // Per-part caps (photo count / bytes) are silent otherwise; say how
        // many photos stayed as plain URLs on the Export sheet.
        lastUsedRow = lastRow + 2;
        rows.push(
            `<row r="${lastUsedRow}">` +
            cell(`A${lastUsedRow}`,
                `${skipped} more ${skipped === 1 ? 'photo was' : 'photos were'} not embedded ` +
                'because this file reached its photo limit. Their links remain on the Export sheet.', 2) +
            '</row>'
        );
    }
    const worksheet = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        `<dimension ref="A1:E${lastUsedRow}"/>`,
        '<sheetViews><sheetView showGridLines="0" workbookViewId="0">',
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
        '</sheetView></sheetViews>',
        '<sheetFormatPr defaultRowHeight="15"/>',
        '<cols><col min="1" max="1" width="22" customWidth="1"/>',
        '<col min="2" max="2" width="22" customWidth="1"/>',
        '<col min="3" max="3" width="22" customWidth="1"/>',
        '<col min="4" max="4" width="52" customWidth="1"/>',
        '<col min="5" max="5" width="24" customWidth="1"/></cols>',
        `<sheetData>${rows.join('')}</sheetData>`,
        `<autoFilter ref="A1:D${lastRow}"/>`,
        '<drawing r:id="rId1"/>',
        '</worksheet>'
    ].join('');
    const drawing = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ',
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        anchors.join(''),
        '</xdr:wsDr>'
    ].join('');

    return [
        { name: 'xl/worksheets/sheet2.xml', content: worksheet },
        {
            name: 'xl/worksheets/_rels/sheet2.xml.rels',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
                '</Relationships>'
        },
        { name: 'xl/drawings/drawing1.xml', content: drawing },
        {
            name: 'xl/drawings/_rels/drawing1.xml.rels',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                relationships.join('') +
                '</Relationships>'
        },
        ...imageEntries
    ];
}

function userColumnWidth(key) {
    if (key === 'bio') return 44;
    if (key === 'profile_image_url' || key === 'profile_url' || key === 'url') return 36;
    if (key === 'created_at' || key.endsWith('_at') || key === 'premium_since') return 28;
    if (key.endsWith('_count')) return 14;
    if (key === 'verified' || key === 'protected' || key === 'account_location_accurate') return 14;
    if (key === 'name' || key.endsWith('username') || key === 'account_source') return 24;
    return 22;
}

function postColumnWidth(key) {
    if (key === 'text' || key.endsWith('_text')) return 44;
    if (key === 'tweet_url' || key.endsWith('_url')) return 44;
    if (key === 'media_urls' || key.endsWith('_media_urls') || key === 'urls') return 32;
    if (key === 'media_alt_texts' || key.endsWith('_media_alt_texts')) return 36;
    if (key === 'created_at' || key.endsWith('_created_at')) return 28;
    if (key.endsWith('_count')) return 14;
    if (key.endsWith('_username') || key.endsWith('_name')) return 24;
    if (key === 'language' || key === 'type' || key.endsWith('_type')) return 14;
    return 22;
}

function columnName(index) {
    let result = '';
    while (index > 0) {
        index--;
        result = String.fromCharCode(65 + (index % 26)) + result;
        index = Math.floor(index / 26);
    }
    return result;
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function write16(bytes, offset, value) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function write32(bytes, offset, value) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function zipEntryBytes(entry, encoder) {
    return typeof entry.content === 'string'
        ? encoder.encode(entry.content)
        : (entry.content instanceof Uint8Array
            ? entry.content
            : new Uint8Array(entry.content));
}

/**
 * Store every entry uncompressed (ZIP method 0).
 */
function createZip(entries) {
    const encoder = new TextEncoder();
    return assembleZip(entries.map(entry => {
        const content = zipEntryBytes(entry, encoder);
        return { name: entry.name, content, data: content, method: 0 };
    }));
}

function supportsDeflateRaw() {
    if (typeof CompressionStream !== 'function') return false;
    try {
        new CompressionStream('deflate-raw');
        return true;
    } catch (_) {
        return false;
    }
}

async function deflateRaw(bytes) {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    // Write and read concurrently: awaiting the write first can deadlock on
    // stream backpressure for large worksheets.
    const writing = writer.write(bytes).then(() => writer.close());
    const reader = stream.readable.getReader();
    const reading = (async () => {
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
        return concatBytes(chunks);
    })();
    // A stream error rejects both sides. Observe them together so a read
    // failure can fall back to STORE without leaving an unhandled write error.
    const [, compressed] = await Promise.all([writing, reading]);
    return compressed;
}

/**
 * DEFLATE (method 8) the XML parts when CompressionStream('deflate-raw') is
 * available; images are already compressed and stay stored. Any compression
 * failure falls back to the uncompressed archive.
 */
async function createZipAsync(entries) {
    if (!supportsDeflateRaw()) return createZip(entries);
    const encoder = new TextEncoder();
    try {
        const records = [];
        for (const entry of entries) {
            const content = zipEntryBytes(entry, encoder);
            if (typeof entry.content !== 'string' || content.length === 0) {
                records.push({ name: entry.name, content, data: content, method: 0 });
                continue;
            }
            const compressed = await deflateRaw(content);
            records.push(compressed.length < content.length
                ? { name: entry.name, content, data: compressed, method: 8 }
                : { name: entry.name, content, data: content, method: 0 });
        }
        return assembleZip(records);
    } catch (_) {
        return createZip(entries);
    }
}

// `content` is the uncompressed entry (CRC and uncompressed size); `data` is
// what is written to the archive with `method` (0 = store, 8 = deflate).
function assembleZip(records) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const record of records) {
        const name = encoder.encode(record.name);
        const { content, data, method } = record;
        const checksum = crc32(content);
        const local = new Uint8Array(30);
        write32(local, 0, 0x04034B50);
        write16(local, 4, 20);
        write16(local, 6, 0x0800); // UTF-8 names
        write16(local, 8, method);
        write32(local, 14, checksum);
        write32(local, 18, data.length);
        write32(local, 22, content.length);
        write16(local, 26, name.length);
        localParts.push(local, name, data);

        const central = new Uint8Array(46);
        write32(central, 0, 0x02014B50);
        write16(central, 4, 20);
        write16(central, 6, 20);
        write16(central, 8, 0x0800);
        write16(central, 10, method);
        write32(central, 16, checksum);
        write32(central, 20, data.length);
        write32(central, 24, content.length);
        write16(central, 28, name.length);
        write32(central, 42, localOffset);
        centralParts.push(central, name);

        localOffset += local.length + name.length + data.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const end = new Uint8Array(22);
    write32(end, 0, 0x06054B50);
    write16(end, 8, records.length);
    write16(end, 10, records.length);
    write32(end, 12, centralDirectory.length);
    write32(end, 16, localOffset);
    return concatBytes([...localParts, centralDirectory, end]);
}

// ==================== Filename ====================

/**
 * Generate export filename with mode, handle, optional date range, and export time.
 * @param {string} username
 * @param {string} mode - 'posts', 'followers', 'following', 'verified_followers'
 * @param {string} ext - file extension
 * @param {Object} [options]
 * @returns {string}
 */
function generateExportFilename(username, mode, ext, options = {}) {
    const now = options.exportedAt ? new Date(options.exportedAt) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        'at',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds())
    ].join('-');

    const cleanPart = (value, fallback = 'unknown') => {
        const safe = String(value || fallback)
            .replace(/^@/, '')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return safe || fallback;
    };
    const formatDatePart = (value) => {
        if (!value) return null;
        const date = new Date(value);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().slice(0, 10);
    };

    const parts = ['XPorter', cleanPart(mode, 'posts')];
    if (mode !== 'bookmarks') {
        parts.push(cleanPart(username));
    }

    const from = formatDatePart(options.dateFrom);
    const to = formatDatePart(options.dateTo);
    if (from || to) {
        parts.push('from', from || 'start', 'to', to || 'latest');
    }

    const partNumber = Number(options.partNumber);
    const partCount = Number(options.partCount);
    if (partCount > 1 && partNumber > 0) {
        const width = Math.max(3, String(partCount).length);
        parts.push(
            `part-${String(partNumber).padStart(width, '0')}-of-${String(partCount).padStart(width, '0')}`
        );
    }

    parts.push('exported', timestamp);
    return `${parts.join('_')}.${cleanPart(ext, 'csv').toLowerCase()}`;
}

// ==================== Global Export ====================

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterCSV = {
        generateCSV,
        generatePostsText,
        generateXLSX,
        generateXLSXAsync,
        generateExportFilename,
        compactExportData,
        selectPopulatedHeaders,
        collectPopulatedHeaders,
        escapeCSVValue,
        escapeXml,
        POSTS_HEADERS,
        USERS_HEADERS,
        USER_ABOUT_HEADERS
    };
}
