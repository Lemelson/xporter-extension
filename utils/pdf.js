// XPorter — dependency-free, Unicode printable export.
// Produces HTML, never a PDF binary: the user explicitly chooses the browser's
// Print → Save as PDF. No network resources, fonts, media fetches or auto-print.
(function (root) {
    'use strict';
    const MAX_SOURCE_CHARS = 500000;
    const PRINT_SCRIPT = "document.getElementById('print-export').addEventListener('click',function(){window.print();});";
    // SHA-256 of exactly PRINT_SCRIPT. Only this fixed handler can execute.
    const PRINT_SCRIPT_HASH = 'tq0GGDWhtF93j/6aWN4epa6/mZH/tbvSXqEhfh+jtQI=';
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);

    function safeUrl(value) {
        try {
            const url = new URL(String(value || ''));
            return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
        } catch (_) { return ''; }
    }

    function sourceSize(item) {
        // A conservative bound for HTML escaping (at most 6×) and UTF-8.
        // A single pathological post fails clearly; no text is truncated.
        const size = JSON.stringify(item || {}).length;
        if (size > MAX_SOURCE_CHARS) throw new Error('PDF_POST_TOO_LARGE');
        return size;
    }

    function generate(items, profile = {}, options = {}) {
        const lang = /^[a-z]{2}$/.test(options.lang || '') ? options.lang : 'en';
        const copy = options.translations || {};
        const t = (key, fallback) => copy[key] || fallback;
        const label = key => root.XPorterColumns?.columnLabel(key, lang) || key;
        const link = value => {
            const href = safeUrl(value);
            return href ? `<a href="${escape(href)}" rel="noreferrer noopener">${escape(value)}</a>` : escape(value);
        };
        const field = (key, value, asLink = false) => value === undefined || value === null || value === ''
            ? '' : `<div class="field"><dt>${escape(label(key))}</dt><dd dir="auto">${asLink ? link(value) : escape(value)}</dd></div>`;
        const media = post => {
            const urls = String(post.media_urls || '').split(' | ').filter(Boolean);
            return field('media_type', post.media_type)
                + (urls.length ? `<div class="field"><dt>${escape(label('media_urls'))}</dt><dd dir="auto">${urls.map(link).join('<br>')}</dd></div>` : '')
                + field('media_alt_texts', post.media_alt_texts);
        };
        const details = post => {
            const username = String(post.author_username || '').replace(/^@/, '');
            const author = [post.author_name, username ? `@${username}` : ''].filter(Boolean).join(' · ');
            return `<dl>${field('author_name', author)}${field('created_at', post.created_at)}${field('type', post.type)}`
                + ['view_count', 'favorite_count', 'retweet_count', 'reply_count', 'quote_count', 'bookmark_count'].map(k => field(k, post[k])).join('')
                + media(post) + field('language', post.language) + field('hashtags', post.hashtags)
                + (post.urls ? `<div class="field"><dt>${escape(label('urls'))}</dt><dd dir="auto">${String(post.urls).split(' | ').map(link).join('<br>')}</dd></div>` : '')
                + field('reply_to_id', post.reply_to_id) + field('reply_to_username', post.reply_to_username)
                + field('conversation_id', post.conversation_id) + field('tweet_url', post.tweet_url, true) + '</dl>';
        };
        const body = post => `<div class="post-text" dir="auto">${escape(post.text)}</div>`
            + (post.article_title ? `<h3 dir="auto">${escape(post.article_title)}</h3>` : '')
            + (post.article_text ? `<div class="article-text" dir="auto">${escape(post.article_text)}</div>` : '')
            + (post.article_url ? `<p dir="auto">${link(post.article_url)}</p>` : '');
        const context = (post, key, depth = 0) => !post ? '' : `<aside class="context"><h3>${escape(label(key))}</h3>${body(post)}${details(post)}`
            + (depth < 1 ? context(post.quoted_post, 'quoted_post', depth + 1) : '') + '</aside>';
        const title = options.mode === 'bookmarks' ? t('bookmarksSettingsHeading', 'Bookmarks') : label('tweet_count');
        const part = options.partCount > 1 ? ` · ${options.partNumber} / ${options.partCount}` : '';
        const count = `${items.length} ${t('postsCollected', 'posts collected')}`;
        const start = Number(options.startNumber) || 1;
        const rows = items.map((post, index) => {
            sourceSize(post);
            return `<article><div class="post-number">${start + index}</div>${body(post)}${details(post)}`
                + context(post.reply_to_post, 'reply_to_post') + context(post.quoted_post, 'quoted_post') + '</article>';
        }).join('\n');
        const profileBlock = options.mode === 'bookmarks' ? '' : `<section class="profile"><h2 dir="auto">${escape(profile.name || '')} ${escape(profile.screenName || profile.username || '')}</h2>`
            + `<p dir="auto">${escape(profile.bio || '')}</p></section>`;
        const status = options.exportStatus && options.exportStatus !== 'complete'
            ? `<p class="partial">${escape(t('pdfPartial', 'These are the rows collected so far. The source export is unfinished.'))}</p>` : '';
        return `<!doctype html><html lang="${escape(lang)}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'sha256-${PRINT_SCRIPT_HASH}'"><title>XPorter · ${escape(title + part)}</title><style>
@page{size:A4;margin:18mm 16mm}*{box-sizing:border-box}body{margin:0;background:#f3f3ef;color:#202723;font:15px/1.65 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;overflow-wrap:anywhere}main{max-width:850px;margin:40px auto;background:white;padding:48px 56px;box-shadow:0 8px 36px #182b2010}.toolbar{max-width:850px;margin:24px auto;padding:0 16px}button{background:#235e46;color:#fff;border:0;border-radius:8px;padding:12px 20px;font:600 15px system-ui;cursor:pointer}button:focus-visible{outline:3px solid #276ad2;outline-offset:3px}.toolbar p{font-size:13px;color:#535c56}.brand{font-size:12px;letter-spacing:.1em;color:#53665b}h1{font-size:32px;line-height:1.2;margin:12px 0}h2,h3{line-height:1.4}header{border-bottom:2px solid #235e46;padding-bottom:24px}.subtitle,.field dt,.post-number{color:#53665b;font-size:12px}article{padding:28px 0;border-bottom:1px solid #d8dfd9}.post-number{font-weight:700;margin-bottom:12px}.post-text,.article-text{white-space:pre-wrap;overflow-wrap:anywhere}.post-text{font-size:17px}.article-text{margin-top:14px}dl{margin-top:18px}.field{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;margin:5px 0;break-inside:avoid}.field dd{margin:0;font-size:12px;white-space:pre-wrap}a{color:#235e46;text-decoration:underline;overflow-wrap:anywhere}.context{margin-top:18px;padding:16px 20px;border-inline-start:3px solid #a9c0b3;background:#f7f9f6}.context h3{font-size:12px;color:#53665b;margin:0 0 10px}.context .post-text{font-size:14px}.partial{border-inline-start:3px solid #b08520;padding-inline-start:12px}.profile{border-bottom:1px solid #d8dfd9;padding:12px 0}.profile p{white-space:pre-wrap}.meta{font-size:12px;color:#53665b}@media(max-width:600px){main{margin:16px;padding:24px}.field{grid-template-columns:1fr;gap:0}}@media print{body{background:white;font-size:11pt}main{margin:0;padding:0;max-width:none;box-shadow:none}.toolbar{display:none}h1,h2,h3{break-after:avoid}article{padding:18px 0}.post-text{font-size:12pt}.context{background:white}a{color:inherit}p,dd{orphans:3;widows:3}}
</style></head><body><div class="toolbar"><button id="print-export" type="button">${escape(t('pdfPrint', 'Print / Save as PDF'))}</button><p>${escape(t('pdfPrintHelp', 'Choose Save as PDF in your browser’s Print dialog. Save each part separately.'))}</p></div><main><header><div class="brand">XPORTER</div><h1>${escape(title + part)}</h1><div class="subtitle">${escape(count)}</div><p class="meta">${escape(options.exportedAt instanceof Date ? options.exportedAt.toISOString() : options.exportedAt || '')}</p>${status}</header>${profileBlock}${rows}</main><script>${PRINT_SCRIPT}</script></body></html>`;
    }
    root.XPorterPDF = { generate, sourceSize, MAX_SOURCE_CHARS, safeUrl };
})(globalThis);
