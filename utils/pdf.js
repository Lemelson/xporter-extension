// XPorter — dependency-free, Unicode printable export.
// Produces HTML, never a PDF binary: the user explicitly chooses the browser's
// Print → Save as PDF. No network resources, fonts, media fetches or auto-print.
(function (root) {
    'use strict';
    const MAX_SOURCE_CHARS = 500000;
    const PRINT_SCRIPT = "document.getElementById('print-export').addEventListener('click',function(){window.print();});";
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
        // Conservative bound for HTML escaping (at most 6×) and UTF-8.
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
        const present = value => value !== undefined && value !== null && value !== '';
        const link = value => {
            const href = safeUrl(value);
            return href ? `<a dir="auto" href="${escape(href)}" rel="noreferrer noopener">${escape(value)}</a>` : escape(value);
        };
        const paragraphs = (value, className) => !present(value) ? ''
            : `<div class="${className}">${String(value).replace(/\r\n?/g, '\n').split(/\n[\t ]*\n/).map(p => `<p dir="auto">${escape(p)}</p>`).join('')}</div>`;
        const block = (key, value, asLinks = false) => !present(value) ? ''
            : `<section class="detail-block"><h4>${escape(label(key))}</h4>${asLinks
                ? `<div class="source-links">${String(value).split(/ \| |,\s+(?=https?:\/\/)/i).map(v => `<p dir="auto">${link(v)}</p>`).join('')}</div>`
                : paragraphs(value, 'detail-text')}</section>`;
        const date = value => {
            if (!present(value)) return '';
            const parsed = new Date(value);
            if (!Number.isFinite(parsed.getTime())) return `<span dir="auto">${escape(value)}</span>`;
            const formatted = new Intl.DateTimeFormat(lang, {
                year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'
            }).format(parsed);
            return `<time dir="auto" datetime="${escape(parsed.toISOString())}" title="${escape(String(value))}">${escape(formatted)} <bdi>UTC</bdi></time>`;
        };
        const typeLabel = type => ({
            tweet:t('postTypeOriginals','Original posts'),original:t('postTypeOriginals','Original posts'),quote:t('postTypeQuotes','Quotes'),
            reply:t('postTypeReplies','Replies'),retweet:t('postTypeReposts','Reposts'),article:t('postTypeArticles','Articles')
        })[type] || (present(type) ? String(type) : '');
        const authorHeader = (post, number) => {
            const username = String(post.author_username || '').replace(/^@/, '');
            const name = post.author_name || '';
            const author = [name ? `<bdi class="author-name">${escape(name)}</bdi>` : '', username ? `<bdi class="author-handle">@${escape(username)}</bdi>` : ''].filter(Boolean).join(' ');
            return `<div class="post-heading">${number ? `<div class="post-number">${number}</div>` : ''}<div class="identity">${author ? `<div class="author">${author}</div>` : ''}<div class="post-meta">${date(post.created_at)}${present(post.type) ? `<span class="type">${escape(typeLabel(post.type))}</span>` : ''}</div></div></div>`;
        };
        const metrics = post => {
            const keys = ['view_count','favorite_count','retweet_count','reply_count','quote_count','bookmark_count'];
            const values = keys.filter(k => present(post[k]));
            return values.length ? `<dl class="metrics">${values.map(k => `<div><dt>${escape(label(k))}</dt><dd dir="auto">${escape(typeof post[k] === 'number' && Number.isFinite(post[k]) ? new Intl.NumberFormat(lang).format(post[k]) : post[k])}</dd></div>`).join('')}</dl>` : '';
        };
        const references = post => {
            const keys = ['reply_to_id','reply_to_username','conversation_id','language','hashtags','media_type'];
            const values = keys.filter(k => present(post[k]));
            return values.length ? `<dl class="references">${values.map(k => `<div><dt>${escape(label(k))}</dt><dd dir="auto">${escape(post[k])}</dd></div>`).join('')}</dl>` : '';
        };
        const details = post => metrics(post) + block('media_alt_texts',post.media_alt_texts)
            + block('media_urls',post.media_urls,true) + block('urls',post.urls,true)
            + block('tweet_url',post.tweet_url,true) + references(post);
        const body = post => paragraphs(post.text,'post-text')
            + (post.article_title ? `<h3 class="article-title" dir="auto">${escape(post.article_title)}</h3>` : '')
            + paragraphs(post.article_text,'article-text') + block('article_url',post.article_url,true);
        const context = (post,key,depth=0) => !post ? ''
            : `<aside class="context${JSON.stringify(post).length <= 3000 ? ' short-post' : ''}"><div class="context-heading"><h3>${escape(label(key))}</h3>${authorHeader(post)}</div>${body(post)}${details(post)}`
                + (depth < 1 ? context(post.quoted_post,'quoted_post',depth+1) : '') + '</aside>';
        const title = options.mode === 'bookmarks' ? t('bookmarksSettingsHeading','Bookmarks') : label('tweet_count');
        const part = options.partCount > 1 ? ` · ${options.partNumber} / ${options.partCount}` : '';
        const count = `${label('tweet_count')}: ${new Intl.NumberFormat(lang).format(items.length)}`;
        const start = Number(options.startNumber) || 1;
        const rows = items.map((post,index) => {
            sourceSize(post);
            // Short records stay together. Long records must remain fragmentable,
            // especially ALT and source links that can be longer than a page.
            // API metadata and several media URLs easily exceed 900 characters
            // even for an ordinary short post. Keep these records together too;
            // larger articles/ALT remain free to span pages.
            const className = JSON.stringify(post).length <= 3000 ? 'post short-post' : 'post';
            return `<article class="${className}">${authorHeader(post,start+index)}${body(post)}${details(post)}`
                + context(post.reply_to_post,'reply_to_post') + context(post.quoted_post,'quoted_post') + '</article>';
        }).join('\n');
        const profileUsername = String(profile.screenName || profile.username || '').replace(/^@+/, '');
        const profileBlock = options.mode === 'bookmarks' || !(profile.name || profileUsername || profile.bio) ? ''
            : `<section class="profile"><h2 dir="auto">${escape(profile.name || '')}${profileUsername ? ` <bdi class="author-handle">@${escape(profileUsername)}</bdi>` : ''}</h2>${paragraphs(profile.bio,'profile-bio')}</section>`;
        const status = options.exportStatus && options.exportStatus !== 'complete'
            ? `<p class="partial">${escape(t('pdfPartial','These are the rows collected so far. The source export is unfinished.'))}</p>` : '';
        return `<!doctype html><html lang="${escape(lang)}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'sha256-${PRINT_SCRIPT_HASH}'"><title>XPorter · ${escape(title+part)}</title><style>
@page{size:A4;margin:17mm 18mm 20mm;@bottom-left{content:"XPORTER";font:8pt Arial,sans-serif;letter-spacing:.08em;color:#69746c}@bottom-right{direction:ltr;unicode-bidi:isolate;content:counter(page) " / " counter(pages);font:8pt Arial,sans-serif;color:#69746c}}
*{box-sizing:border-box}body{margin:0;background:#f2f3ee;color:#233028;font:15px/1.6 Arial,"Noto Sans",sans-serif;overflow-wrap:anywhere}main{max-width:820px;margin:32px auto 48px;background:#fff;padding:48px 54px;box-shadow:0 6px 28px #172a2010}.toolbar{max-width:820px;margin:24px auto;padding:0 16px}button{background:#235b43;color:#fff;border:0;border-radius:8px;padding:12px 20px;font:600 15px Arial,sans-serif;cursor:pointer}button:focus-visible{outline:3px solid #276ad2;outline-offset:3px}.toolbar p{font-size:13px;color:#5f6b63;max-width:65ch}.brand{font-size:11px;letter-spacing:.16em;color:#5f6f64}h1{font-size:34px;line-height:1.18;font-weight:700;margin:12px 0}h2,h3,h4{line-height:1.35}.archive-heading{border-bottom:2px solid #285f47;padding-bottom:24px;margin-bottom:4px}.archive-meta{display:flex;flex-wrap:wrap;gap:8px 24px;color:#5b685f;font-size:12px}.post{padding:26px 0;border-bottom:1px solid #dce2da}.post:last-child{border-bottom:0}.post-heading{display:flex;align-items:baseline;gap:14px;margin-bottom:15px}.post-number{color:#7a887e;font:11px/1.4 Arial,sans-serif;min-width:16px;font-variant-numeric:tabular-nums}.identity{min-width:0}.author{display:flex;flex-wrap:wrap;gap:4px 9px;align-items:baseline}.author-name{font-weight:700;font-size:15px}.author-handle{color:#6b766e;font-size:12px}.post-meta{display:flex;flex-wrap:wrap;gap:5px 12px;margin-top:3px;color:#69746c;font-size:11px}.type{color:#466553}.post-text p,.article-text p,.detail-text p,.source-links p,.profile-bio p{white-space:pre-wrap;margin:0 0 10px;overflow-wrap:anywhere}.post-text p{font-size:16px;line-height:1.65}.article-title{font-size:23px;line-height:1.3;margin:20px 0 14px}.article-text{margin-top:14px}.article-text p{font-size:14px;line-height:1.7;margin-bottom:16px}.metrics{display:flex;flex-wrap:wrap;gap:9px 22px;padding:12px 0;margin:14px 0;border-top:1px solid #e5e9e3;border-bottom:1px solid #e5e9e3}.metrics>div{display:flex;gap:6px;align-items:baseline}.metrics dt{color:#67756b;font-size:10px}.metrics dd{font-size:12px;font-weight:700;margin:0;font-variant-numeric:tabular-nums}.detail-block{margin:15px 0}.detail-block h4{font-size:10px;color:#617367;margin:0 0 5px;font-weight:600}.detail-text p,.source-links p{font-size:12px;line-height:1.6;margin-bottom:6px}a{color:#295d45;text-underline-offset:2px;overflow-wrap:anywhere}.references{margin:13px 0 0;font-size:10px;color:#778177}.references>div{display:flex;gap:8px;align-items:baseline;margin:2px 0}.references dt{flex:0 0 auto}.references dd{margin:0;min-width:0;overflow-wrap:anywhere}.context{margin-top:20px;padding:12px 0 2px 18px;padding-inline-start:18px;padding-inline-end:0;border-inline-start:2px solid #b0c3b4}.context-heading h3{margin:0 0 8px;font-size:11px;font-weight:600;color:#587060}.context .author-name{font-size:13px}.context .post-heading{margin-bottom:10px}.context .post-text p{font-size:13px}.context .article-title{font-size:18px}.context .article-text p{font-size:12px}.context .metrics{gap:6px 14px}.context .context{border-color:#d0dccf}.partial{font-size:12px;color:#635524;border-inline-start:3px solid #b08a34;padding-inline-start:12px;margin:18px 0 0}.profile{padding:16px 0;border-bottom:1px solid #dce2da}.profile h2{font-size:20px;margin:0 0 8px}.profile-bio p{font-size:13px;color:#637067}bdi,time{unicode-bidi:isolate}html[dir=rtl] .brand{letter-spacing:.05em}html[dir=rtl] .context{padding-left:0}html[dir=rtl] .post-number{direction:ltr}
@media(max-width:600px){main{margin:16px;padding:24px}.archive-meta{gap:5px 14px}.metrics{gap:8px 14px}}
@media print{body{background:#fff;font-size:10pt;line-height:1.55}main{margin:0;padding:0;max-width:none;box-shadow:none}.toolbar{display:none}.archive-heading{padding-bottom:20px}.post{padding:20px 0}.short-post{break-inside:avoid}.post-heading,.context-heading{break-inside:avoid;break-after:avoid}.article-title,.detail-block h4{break-after:avoid}.post-text p{font-size:11pt;line-height:1.6}.article-text p{font-size:10pt;line-height:1.65;margin-bottom:11pt}.context .post-text p{font-size:10pt}.context .article-text p{font-size:9.5pt}.metrics{break-inside:avoid;padding:8px 0}.detail-block{break-inside:auto}.detail-text p,.source-links p{font-size:9pt;line-height:1.6}.context{box-decoration-break:clone;-webkit-box-decoration-break:clone}.partial{break-inside:avoid}p{orphans:3;widows:3}.references{break-inside:avoid}a{color:inherit}}
</style></head><body><div class="toolbar"><button id="print-export" type="button">${escape(t('pdfPrint','Print / Save as PDF'))}</button><p>${escape(t('pdfPrintHelp','Choose Save as PDF in your browser’s Print dialog. Save each part separately.'))}</p></div><main><header class="archive-heading"><div class="brand" dir="ltr">XPORTER</div><h1>${escape(title+part)}</h1><div class="archive-meta"><span>${escape(count)}</span>${options.exportedAt ? date(options.exportedAt) : ''}</div>${status}</header>${profileBlock}${rows}</main><script>${PRINT_SCRIPT}</script></body></html>`;
    }
    root.XPorterPDF = { generate, sourceSize, MAX_SOURCE_CHARS, safeUrl };
})(globalThis);
