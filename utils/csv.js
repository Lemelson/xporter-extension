// XPorter — CSV Generator
// Generates properly escaped CSV with BOM for Excel Unicode support

/**
 * Generate CSV string from array of tweet objects
 */
function generateCSV(tweets) {
    const headers = [
        'id', 'text', 'tweet_url', 'language', 'type',
        'author_name', 'author_username', 'view_count',
        'bookmark_count', 'favorite_count', 'retweet_count',
        'reply_count', 'quote_count', 'created_at', 'source',
        'hashtags', 'urls', 'media_type', 'media_urls'
    ];

    let csv = headers.join(',') + '\n';

    for (const tweet of tweets) {
        const row = headers.map(h => {
            let val = tweet[h] ?? '';
            val = String(val);
            // Escape: if value contains comma, quote, or newline — wrap in quotes
            if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
                val = '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        });
        csv += row.join(',') + '\n';
    }

    // BOM for correct Unicode display in Excel
    return '\uFEFF' + csv;
}

/**
 * Generate filename for the CSV export
 */
function generateFilename(username) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '_',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds())
    ].join('');

    return `XPorter_${username}_${timestamp}.csv`;
}

/**
 * Create a downloadable blob URL from CSV string
 */
function createCSVBlobUrl(csvString) {
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    return URL.createObjectURL(blob);
}

if (typeof globalThis !== 'undefined') {
    globalThis.XPorterCSV = { generateCSV, generateFilename, createCSVBlobUrl };
}
