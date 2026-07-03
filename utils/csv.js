// XPorter — Export Format Generator
// Single source of truth for CSV and XLSX export generation.
// (JSON export is generated directly in background/service-worker.js.)
// Used by service-worker.js via importScripts.

// ==================== Header Definitions ====================

const POSTS_HEADERS = [
    'id', 'text', 'tweet_url', 'language', 'type',
    'author_name', 'author_username', 'view_count',
    'bookmark_count', 'favorite_count', 'retweet_count',
    'reply_count', 'quote_count', 'created_at', 'source',
    'hashtags', 'urls', 'media_type', 'media_urls'
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

// ==================== XLSX (XML SpreadsheetML) ====================

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
 * Generate a simple XLSX file (XML-based SpreadsheetML) — no external deps.
 * Compatible with Excel, LibreOffice, and Google Sheets.
 * @param {Array} items - Array of data objects
 * @param {boolean} isUsers - true for followers/following, false for posts
 * @returns {string} XML SpreadsheetML string
 */
function generateSimpleXLSX(items, isUsers = false, opts = {}) {
    const keys = isUsers ? USERS_HEADERS : POSTS_HEADERS;
    const labels = headerLabels(keys, opts);

    const rows = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?mso-application progid="Excel.Sheet"?>',
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
        ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
        '<Worksheet ss:Name="Export">',
        '<Table>'
    ];

    // Header row
    let headerRow = '<Row>';
    for (const label of labels) {
        headerRow += `<Cell><Data ss:Type="String">${escapeXml(label)}</Data></Cell>`;
    }
    rows.push(headerRow + '</Row>');

    // Data rows
    for (const item of items) {
        let row = '<Row>';
        for (const h of keys) {
            const val = String(item[h] ?? '');
            // Keep identifiers and very long digit strings as text — Excel stores
            // numbers as IEEE-754 doubles and would corrupt 17–19 digit tweet/user
            // IDs (losing the last digits). Only treat short, space-free, plain
            // decimal values as real numbers — the strict regex rejects things
            // JS Number() would accept ('Infinity', '0xBEEF', '1e999') and
            // leading-zero strings like '007' that Excel would mangle.
            const isIdField = h === 'id' || h.endsWith('_id') || h.endsWith('_str');
            const isNum = !isIdField && val !== '' && !val.includes(' ') &&
                /^-?(0|[1-9]\d*)(\.\d+)?$/.test(val) && val.length <= 15;
            row += `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(val)}</Data></Cell>`;
        }
        rows.push(row + '</Row>');
    }

    rows.push('</Table>', '</Worksheet>', '</Workbook>');
    return rows.join('\n');
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

    parts.push('exported', timestamp);
    return `${parts.join('_')}.${cleanPart(ext, 'csv').toLowerCase()}`;
}

// ==================== Global Export ====================

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterCSV = {
        generateCSV,
        generateSimpleXLSX,
        generateExportFilename,
        escapeCSVValue,
        escapeXml,
        POSTS_HEADERS,
        USERS_HEADERS
    };
}
