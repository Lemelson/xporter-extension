// XPorter — Export Format Generator
// Single source of truth for CSV, XLSX, and AI-friendly posts TXT generation.
// (JSON export is generated directly in background/downloads.js.)
// Used by service-worker.js via importScripts.

// ==================== Header Definitions ====================

const POSTS_HEADERS = [
    'id', 'text', 'tweet_url', 'language', 'type',
    'author_name', 'author_username', 'view_count',
    'bookmark_count', 'favorite_count', 'retweet_count',
    'reply_count', 'quote_count', 'created_at', 'source',
    'hashtags', 'urls', 'media_type', 'media_urls', 'media_alt_texts',
    'article_title', 'article_url', 'article_text'
];

const USERS_HEADERS = [
    'id', 'name', 'username', 'bio', 'location', 'url',
    'followers_count', 'following_count', 'tweet_count', 'listed_count',
    'verified', 'protected', 'created_at', 'profile_image_url', 'profile_url'
];

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
    const keys = isUsers ? USERS_HEADERS : POSTS_HEADERS;
    const labels = headerLabels(keys, opts);
    const rows = [labels.map(escapeCSVValue).join(',')];

    for (const item of items) {
        rows.push(keys.map(h => escapeCSVValue(item[h])).join(','));
    }

    return '\uFEFF' + rows.join('\n') + '\n'; // BOM for correct Unicode in Excel
}

// ==================== Posts TXT ====================

/**
 * Generate a compact, AI-friendly plain-text document for a single profile's
 * posts. Optional profile fields are omitted when X did not return them.
 */
function generatePostsText(items, profile = {}) {
    const lines = ['PROFILE'];
    const addProfileLine = (label, value, options = {}) => {
        if (value === undefined || value === null || value === '') return;
        if (options.at) value = '@' + String(value).replace(/^@/, '');
        lines.push(`${label}: ${value}`);
    };

    const username = profile.screenName || profile.username || '';
    addProfileLine('Name', profile.name);
    addProfileLine('Username', username, { at: true });
    addProfileLine('Profile', profile.profileUrl || profile.profile_url || (username ? `https://x.com/${username}` : ''));
    addProfileLine('Bio', cleanTxtValue(profile.bio));
    addProfileLine('Category', profile.professionalCategory || profile.professional_category);
    addProfileLine('Location', profile.location);
    addProfileLine('Website', profile.url);
    addProfileLine('Joined', formatTxtDate(profile.createdAt || profile.created_at));
    addProfileLine('Followers', profile.followersCount ?? profile.followers_count);
    addProfileLine('Following', profile.followingCount ?? profile.following_count);
    addProfileLine('Subscriptions', profile.subscriptionsCount ?? profile.subscriptions_count);
    addProfileLine('Posts', profile.tweetCount ?? profile.tweet_count);
    addProfileLine('Likes', profile.likesCount ?? profile.likes_count);
    addProfileLine('Listed', profile.listedCount ?? profile.listed_count);
    addProfileLine('Media', profile.mediaCount ?? profile.media_count);
    if (profile.isVerified || profile.verified) lines.push('Verified: yes');
    addProfileLine('Profile image', profile.profileImageUrl || profile.profile_image_url);

    lines.push('', `POSTS (${items.length})`, '');
    items.forEach((item, index) => {
        const meta = [];
        const createdAt = formatTxtDate(item.created_at);
        if (createdAt) meta.push(createdAt);
        addMetric(meta, item.view_count, 'views');
        addMetric(meta, item.favorite_count, 'likes');
        addMetric(meta, item.retweet_count, 'reposts');
        addMetric(meta, item.reply_count, 'replies');
        addMetric(meta, item.quote_count, 'quotes');
        addMetric(meta, item.bookmark_count, 'bookmarks');
        if (item.type && item.type !== 'tweet') meta.push(item.type);

        lines.push(`${index + 1}. ${meta.join(', ') || 'Post'}`);
        lines.push(`Post: (${cleanTxtValue(item.text)})`);
        if (item.article_text) {
            const articleHeading = item.article_title ? `${cleanTxtValue(item.article_title)}\n` : '';
            lines.push(`Article: (${articleHeading}${cleanTxtValue(item.article_text)})`);
        }
        if (item.tweet_url) lines.push(`URL: ${item.tweet_url}`);
        lines.push('');
    });

    return lines.join('\n').trimEnd() + '\n';
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
    target.push(`${value} ${label}`);
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

/**
 * Escape XML special characters.
 * Also strips control characters that are invalid in XML 1.0 — a single one
 * (e.g. in tweet text) would make the whole XLSX unopenable.
 */
function escapeXml(str) {
    return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Generate a real XLSX workbook (OOXML ZIP) without external dependencies.
 * The ZIP entries use the uncompressed "store" method; spreadsheet data is
 * already text-heavy, and avoiding a bundled compression library keeps the
 * extension dependency-free while producing a standards-compliant workbook.
 * @param {Array} items - Array of data objects
 * @param {boolean} isUsers - true for followers/following, false for posts
 * @returns {Uint8Array} XLSX bytes
 */
function generateXLSX(items, isUsers = false, opts = {}) {
    const keys = isUsers ? USERS_HEADERS : POSTS_HEADERS;
    const labels = headerLabels(keys, opts);

    const worksheetRows = [];
    const appendRow = (values, rowNumber, dataKeys = null) => {
        const cells = values.map((value, index) => {
            // Excel's hard per-cell limit is 32,767 characters. CSV/JSON keep
            // the full value; XLSX must stay within the format contract so one
            // unusually long article cannot make the workbook unreadable.
            let val = String(value ?? '').slice(0, 32767);
            // The cut can land mid-emoji; a dangling high surrogate would be
            // encoded as U+FFFD, so drop it.
            if (/[\uD800-\uDBFF]$/.test(val)) val = val.slice(0, -1);
            const key = dataKeys?.[index] || '';
            // Keep identifiers and very long digit strings as text — Excel
            // stores numbers as IEEE-754 doubles and would corrupt post IDs.
            const isIdField = key === 'id' || key.endsWith('_id') || key.endsWith('_str');
            const isNumber = !isIdField && val !== '' && !val.includes(' ') &&
                /^-?(0|[1-9]\d*)(\.\d+)?$/.test(val) && val.length <= 15;
            const ref = `${columnName(index + 1)}${rowNumber}`;
            if (isNumber) return `<c r="${ref}"><v>${escapeXml(val)}</v></c>`;
            const preserve = /^\s|\s$|[\n\r\t]/.test(val) ? ' xml:space="preserve"' : '';
            return `<c r="${ref}" t="inlineStr"><is><t${preserve}>${escapeXml(val)}</t></is></c>`;
        });
        worksheetRows.push(`<row r="${rowNumber}">${cells.join('')}</row>`);
    };

    appendRow(labels, 1);
    items.forEach((item, index) => appendRow(keys.map(key => item[key]), index + 2, keys));

    const lastCell = `${columnName(keys.length)}${Math.max(1, items.length + 1)}`;
    const worksheet = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        `<dimension ref="A1:${lastCell}"/>`,
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>',
        '<sheetFormatPr defaultRowHeight="15"/>',
        `<sheetData>${worksheetRows.join('')}</sheetData>`,
        '</worksheet>'
    ].join('');

    return createZip([
        {
            name: '[Content_Types].xml',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                '<Default Extension="xml" ContentType="application/xml"/>' +
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
                '</Types>'
        },
        {
            name: '_rels/.rels',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
                '</Relationships>'
        },
        {
            name: 'xl/workbook.xml',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
                '<sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>'
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
                '</Relationships>'
        },
        { name: 'xl/worksheets/sheet1.xml', content: worksheet }
    ]);
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

function createZip(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const content = encoder.encode(entry.content);
        const checksum = crc32(content);
        const local = new Uint8Array(30);
        write32(local, 0, 0x04034B50);
        write16(local, 4, 20);
        write16(local, 6, 0x0800); // UTF-8 names
        write16(local, 8, 0);      // stored, no compression
        write32(local, 14, checksum);
        write32(local, 18, content.length);
        write32(local, 22, content.length);
        write16(local, 26, name.length);
        localParts.push(local, name, content);

        const central = new Uint8Array(46);
        write32(central, 0, 0x02014B50);
        write16(central, 4, 20);
        write16(central, 6, 20);
        write16(central, 8, 0x0800);
        write16(central, 10, 0);
        write32(central, 16, checksum);
        write32(central, 20, content.length);
        write32(central, 24, content.length);
        write16(central, 28, name.length);
        write32(central, 42, localOffset);
        centralParts.push(central, name);

        localOffset += local.length + name.length + content.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const end = new Uint8Array(22);
    write32(end, 0, 0x06054B50);
    write16(end, 8, entries.length);
    write16(end, 10, entries.length);
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

    const parts = [
        'XPorter',
        cleanPart(mode, 'posts'),
        cleanPart(username)
    ];

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
        generateExportFilename,
        escapeCSVValue,
        escapeXml,
        POSTS_HEADERS,
        USERS_HEADERS
    };
}
