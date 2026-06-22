// XPorter — Export Format Generator
// Single source of truth for CSV, XLSX, and JSON export generation.
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
    let csv = labels.map(escapeCSVValue).join(',') + '\n';

    for (const item of items) {
        const row = keys.map(h => escapeCSVValue(item[h]));
        csv += row.join(',') + '\n';
    }

    return '\uFEFF' + csv; // BOM for correct Unicode in Excel
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
 */
function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<?mso-application progid="Excel.Sheet"?>\n';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
    xml += ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
    xml += '<Worksheet ss:Name="Export">\n<Table>\n';

    // Header row
    xml += '<Row>';
    for (const label of labels) {
        xml += `<Cell><Data ss:Type="String">${escapeXml(label)}</Data></Cell>`;
    }
    xml += '</Row>\n';

    // Data rows
    for (const item of items) {
        xml += '<Row>';
        for (const h of keys) {
            const val = String(item[h] ?? '');
            // Keep identifiers and very long digit strings as text — Excel stores
            // numbers as IEEE-754 doubles and would corrupt 17–19 digit tweet/user
            // IDs (losing the last digits). Only treat short, space-free, purely
            // numeric values as real numbers.
            const isIdField = h === 'id' || h.endsWith('_id') || h.endsWith('_str');
            const isNum = !isIdField && val !== '' && !val.includes(' ') &&
                !isNaN(val) && val.length <= 15;
            xml += `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(val)}</Data></Cell>`;
        }
        xml += '</Row>\n';
    }

    xml += '</Table>\n</Worksheet>\n</Workbook>';
    return xml;
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
        escapeXml,
        POSTS_HEADERS,
        USERS_HEADERS
    };
}
