#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const script = p => fs.readFileSync(path.join(root, p), 'utf8');
const locale = JSON.parse(script('popup/locales/en.json'));
function serializer() {
    const context = vm.createContext({ URL, TextEncoder, Uint8Array, DataView, ArrayBuffer });
    for (const p of ['utils/columns-i18n.js', 'utils/csv.js', 'utils/pdf.js']) vm.runInContext(script(p), context, { filename:p });
    return context;
}
const fixture = {
    id:'1234567890123456789', type:'reply', text:'Hello · Привет · 中文 · مرحبا بالعالم\n<script>globalThis.pwned=true</script>',
    author_name:'Лена <Ada>', author_username:'ada', favorite_count:0, created_at:'2026-09-30',
    tweet_url:'https://x.com/ada/status/1234567890123456789?x="&y=<a>',
    media_type:'photo', media_urls:'https://pbs.twimg.com/media/image.jpg | javascript:alert(1)',
    media_alt_texts:'A mountain & lake · Гора и озеро · 山和湖 · جبل وبحيرة',
    article_title:'Article preview', article_text:'Text X made available',
    reply_to_post:{ text:'Parent context', media_alt_texts:'Parent ALT', quoted_post:{text:'Parent quote',media_alt_texts:'Nested ALT'} },
    quoted_post:{text:'Quoted context',media_alt_texts:'Quoted ALT',tweet_url:'data:text/html,<script>alert(1)</script>'}
};
test('printable HTML retains multilingual post/context/ALT and prevents active third-party content', () => {
    const c = serializer();
    const html = c.XPorterPDF.generate([fixture], {}, { mode:'bookmarks',lang:'ar',translations:locale,exportStatus:'stopped' });
    for (const text of ['Привет','中文','مرحبا بالعالم','Гора и озеро','山和湖','جبل وبحيرة','Parent ALT','Nested ALT','Quoted ALT','Parent context','Quoted context','Article preview','Text X made available']) assert(html.includes(text),text);
    assert(html.includes('lang="ar" dir="rtl"'));
    assert(html.includes('rows collected so far'));
    assert(!html.includes('<script>globalThis.pwned'));
    assert(html.includes('&lt;script&gt;globalThis.pwned=true&lt;/script&gt;'));
    assert(!/<a href="(?:javascript:|data:)/.test(html));
    assert(!/<img\b/.test(html), 'offline export has no remote image fetches');
    assert(!/on(?:click|load|error)\s*=/.test(html));
    const executable = html.match(/<script>([^]*?)<\/script>/g);
    assert.equal(executable.length,1);
    const source = executable[0].slice(8,-9);
    const hash = crypto.createHash('sha256').update(source).digest('base64');
    assert(html.includes(`script-src 'sha256-${hash}'`));
    assert.equal((source.match(/window.print\(/g)||[]).length,1);
    assert(source.includes("addEventListener('click'"), 'printing requires an explicit button click');
    assert(c.XPorterPDF.safeUrl('https://example.com/?a="&b=2').startsWith('https://'));
    assert.equal(c.XPorterPDF.safeUrl('javascript:alert(1)'), '');
    assert.equal(c.XPorterPDF.safeUrl('file:///etc/passwd'), '');
});
test('ALT survives existing JSON, CSV, XLSX and repaired TXT for primary/reply/quote contexts', () => {
    const c=serializer();
    const csv=c.XPorterCSV.generateCSV([fixture]);
    const txt=c.XPorterCSV.generatePostsText([{...fixture,reply_to_id:'999',reply_to_username:'parent'}],{}, { mode:'bookmarks' });
    const xlsx=new TextDecoder().decode(c.XPorterCSV.generateXLSX([fixture]));
    const json=JSON.stringify(c.XPorterCSV.compactExportData([fixture]));
    for (const output of [csv,txt,xlsx,json]) {
        for (const alt of ['Гора и озеро','Parent ALT','Nested ALT','Quoted ALT']) assert(output.includes(alt),alt);
    }
    assert(txt.includes('https://pbs.twimg.com/media/image.jpg'));
});
test('GraphQL media ALT survives timeline parsing, reply attachment and every post export format', () => {
    const c = serializer();
    c.XLog = { log() {} };
    vm.runInContext(script('utils/api-parsers.js'), c, { filename:'utils/api-parsers.js' });
    const alts = ['Primary гора 中文 جبل', 'Parent montagne 山', 'Parent quote وصف', 'Quoted озеро 湖'];
    const tweet = (id, alt, extra = {}) => ({
        __typename:'Tweet', rest_id:id,
        core:{ user_results:{ result:{ rest_id:'42', core:{ name:'Ada', screen_name:'ada' } } } },
        legacy:{
            id_str:id, full_text:'Post '+id, created_at:'Wed Sep 30 12:00:00 +0000 2026',
            extended_entities:{ media:[
                { type:'photo', media_url_https:'https://pbs.twimg.com/media/'+id+'-1.jpg', ext_alt_text:alt },
                { type:'photo', media_url_https:'https://pbs.twimg.com/media/'+id+'-2.jpg' }
            ] }
        }, ...extra
    });
    const parent = tweet('100', alts[1], { quoted_status_result:{ result:tweet('101', alts[2]) } });
    const reply = tweet('200', alts[0], { quoted_status_result:{ result:tweet('201', alts[3]) } });
    reply.legacy.in_reply_to_status_id_str = '100';
    reply.legacy.in_reply_to_screen_name = 'ada';
    const response = { data:{ bookmark_timeline_v2:{ timeline:{ instructions:[{
        type:'TimelineAddEntries', entries:[parent, reply].map(result => ({
            entryId:'tweet-'+result.rest_id,
            content:{ itemContent:{ tweet_results:{ result } } }
        }))
    }] } } } };
    const parsed = c.XPorterApiParsers.parseBookmarksResponse(response);
    const row = parsed.tweets.find(item => item.id === '200');
    assert(row, 'the reply is parsed from the timeline payload');
    assert.equal(row.media_alt_texts, alts[0]+' | ', 'a missing second description keeps its position');
    assert.equal(row.reply_to_post.media_alt_texts, alts[1]+' | ');
    assert.equal(row.reply_to_post.quoted_post.media_alt_texts, alts[2]+' | ');
    assert.equal(row.quoted_post.media_alt_texts, alts[3]+' | ');
    const outputs = {
        json:JSON.stringify(c.XPorterCSV.compactExportData([row])),
        csv:c.XPorterCSV.generateCSV([row]),
        xlsx:new TextDecoder().decode(c.XPorterCSV.generateXLSX([row])),
        txt:c.XPorterCSV.generatePostsText([row], {}, { mode:'bookmarks' }),
        pdf:c.XPorterPDF.generate([row], {}, { mode:'bookmarks', lang:'en', translations:locale })
    };
    for (const [format, output] of Object.entries(outputs)) {
        for (const alt of alts) assert(output.includes(alt), format+' retains '+alt);
    }
});
function downloadHarness(batches, options={}) {
    const generated=[];
    const events=[];
    const context=serializer();
    let settingsReads=0, permissions=0;
    class Reader {
        readAsDataURL(blob) {
            blob.text().then(content => {
                this.result='data:text/html;base64,'+Buffer.from(content).toString('base64');this.onload();
            }).catch(error=>{this.error=error;this.onerror();});
        }
    }
    Object.assign(context, {
        Blob, FileReader:Reader, setInterval,clearInterval,setTimeout,clearTimeout,
        XLog:{warn(){},error(){}},
        loadTranslations:async()=>locale,
        XPORTER_CONFIG:{DOWNLOAD_PART_LIMITS:{posts:{pdf:options.limit||250}},STORAGE_BATCH_READ_SIZE:2},
        XPorterStorage:{
            loadExportState:async()=>({username:'ada',exportMode:options.mode||'bookmarks',outputFormat:'pdf',tweetCount:batches.flat().length,totalBatches:batches.length,status:options.status||'stopped',partialReason:options.partialReason||null}),
            loadSettings:async()=>{settingsReads++;return{language:'en'};},
            loadTweetBatches:async(start,count)=>batches.slice(start,start+count),
            loadAllTweets:()=>{throw new Error('unbounded load forbidden');},
            loadExportHistoryEntry:async()=>({username:'ada',exportMode:'bookmarks',outputFormat:'pdf',items:batches.flat(),completedAt:'2026-09-30'}),
            recordDownload:async()=>{}
        },
        chrome:{
            runtime:{lastError:null,sendMessage:m=>{events.push(m);return Promise.resolve();}},
            permissions:{contains:async()=>{permissions++;return false;}},
            downloads:{download:(request,callback)=>{generated.push({...request,content:Buffer.from(request.url.split(',')[1],'base64').toString()});callback(generated.length);}}
        }
    });
    vm.runInContext(script('background/downloads.js'),context,{filename:'background/downloads.js'});
    return{context,generated,events,get permissions(){return permissions;},get settingsReads(){return settingsReads;}};
}
test('current printable downloads split by source size, preserve full long Unicode text and sequence', async()=>{
    const text='Привет 中文 مرحبا '.repeat(18000);
    const rows=[1,2,3].map(id=>({id:String(id),text,media_alt_texts:'ALT '+id}));
    const h=downloadHarness([rows]);
    const plan=await h.context.XPorterDownloads.getCurrentPlan('pdf');
    assert.equal(plan.partCount,3);
    const result=await h.context.XPorterDownloads.downloadCurrent('pdf');
    assert.equal(result.count,3);assert.equal(result.partCount,3);
    assert.equal(h.generated.length,3);assert.equal(h.permissions,0);
    h.generated.forEach((file,index)=>{
        assert(file.filename.endsWith('.html'));
        assert(file.filename.includes(`part-00${index+1}-of-003`));
        assert(file.content.includes(text));
        assert(file.content.includes(`<div class="post-number">${index+1}</div>`));
        assert(file.content.includes('rows collected so far'));
        assert.equal(file.saveAs,false);
    });
});
test('history printable download obeys the same row ceiling and continuous numbering',async()=>{
    const h=downloadHarness([[1,2,3,4,5].map(id=>({id:String(id),text:'History '+id}))],{limit:2});
    const result=await h.context.XPorterDownloads.downloadHistory('saved');
    assert.equal(result.partCount,3);assert.equal(result.count,5);assert.equal(h.generated.length,3);
    assert(h.generated[2].content.includes('<div class="post-number">5</div>'));
    assert(h.generated.every(f=>!f.content.includes('rows collected so far')));
});
test('a source marked complete with a partial reason remains visibly unfinished in the printable file', async()=>{
    const h=downloadHarness([[{id:'1',text:'Accepted rows'}]],{status:'complete',partialReason:'safety_break'});
    const result=await h.context.XPorterDownloads.downloadCurrent('pdf');
    assert.equal(result.success,true);
    assert(h.generated[0].content.includes('rows collected so far'));
});
test('oversize single rows fail explicitly without truncation or partial files; user-list PDF is rejected',async()=>{
    const h=downloadHarness([[{id:'1',text:'X'.repeat(500001)}]]);
    await assert.rejects(h.context.XPorterDownloads.downloadCurrent('pdf'), /PDF_POST_TOO_LARGE/);
    assert.equal(h.generated.length,0);
    const users=downloadHarness([[{id:'1',name:'Ada'}]],{mode:'followers'});
    await assert.rejects(users.context.XPorterDownloads.downloadCurrent('pdf'),/FORMAT_UNSUPPORTED/);
    assert.equal(users.generated.length,0);
});

test('archive presentation puts identity before content and preserves localized dates, zero metrics and paragraphs',()=>{
    const c=serializer();
    const html=c.XPorterPDF.generate([{...fixture,text:'First paragraph.\n\nSecond paragraph.',created_at:'2026-09-30T12:34:56Z',favorite_count:0}],{}, {mode:'bookmarks',lang:'ru',translations:locale});
    assert(html.indexOf('class="author"')<html.indexOf('First paragraph.'));
    assert(html.includes('datetime="2026-09-30T12:34:56.000Z"'));
    assert(html.includes('<bdi>UTC</bdi>'));
    assert(html.includes('Посты: 1'), 'the localized label plus count must not reuse an uninflected status suffix');
    assert(html.includes('<div class="metrics">') || html.includes('<dl class="metrics">'));
    assert(html.includes('<dd dir="auto">0</dd>'));
    assert(html.includes('<p dir="auto">First paragraph.</p><p dir="auto">Second paragraph.</p>'));
    assert(html.includes('counter(page)'));
    assert(html.includes('@bottom-right{direction:ltr;unicode-bidi:isolate;'), 'page numbering must not reverse in an RTL archive');
    assert(!html.includes('grid-template-columns'), 'long ALT must be fragmentable, not an unsplittable metadata grid');
});
test('a normal post with four media links stays together and profile handles are recognizable',()=>{
    const c=serializer();
    const post={id:'2103636549359526064',text:'Congratulations to the award recipients.',author_name:'NASA',author_username:'NASA',tweet_url:'https://x.com/NASA/status/2103636549359526064',conversation_id:'2103636549359526064',language:'en',media_type:'photo',media_urls:Array.from({length:4},(_,i)=>`https://pbs.twimg.com/media/${'image'.repeat(40)}${i}.jpg`).join(', ')};
    const html=c.XPorterPDF.generate([post],{name:'NASA',screenName:'@NASA'}, {mode:'posts'});
    assert(html.includes('class="post short-post"'), 'ordinary media metadata must not leave a references-only page');
    assert(html.includes('<bdi class="author-handle">@NASA</bdi></h2>'), 'profile handles need a single @ and the same treatment as post handles');
    const withQuote=c.XPorterPDF.generate([{...post,quoted_post:{text:'A short quoted post',tweet_url:'https://x.com/NASA/status/1',media_type:'photo'}}],{}, {mode:'posts'});
    assert(withQuote.includes('class="context short-post"'), 'short quote context should not leave its source URL alone on another page');
});
test('long ALT, URL and article paragraphs are complete, isolated and allowed to flow across pages',()=>{
    const c=serializer();
    const alt=('وصف الصورة 中文 описание '.repeat(900))+'ALT_END';
    const url='https://example.org/'+('segment'.repeat(500))+'URL_END';
    const html=c.XPorterPDF.generate([{id:'1',text:'نص عربي',author_name:'ليلى',author_username:'layla',media_alt_texts:alt,media_urls:url,article_text:'Article one.\n\nArticle two.'}],{}, {mode:'bookmarks',lang:'ar',translations:locale});
    assert(html.includes(alt));assert(html.includes(url));
    assert(html.includes('ALT_END'));assert(html.includes('URL_END'));
    assert(html.includes('class="post"'));
    assert(html.includes('<bdi class="author-handle">@layla</bdi>'));
    assert(html.includes('class="detail-block"'));
    assert(html.includes('.detail-block{break-inside:auto}'));
    assert(html.includes('<p dir="auto">Article one.</p><p dir="auto">Article two.</p>'));
});

test('real API tweet types and comma-separated link fields become localized, separately clickable links',()=>{
    const c=serializer();
    const ru=JSON.parse(script('popup/locales/ru.json'));
    const html=c.XPorterPDF.generate([{type:'tweet',text:'Links',urls:'https://example.org/a,b, https://example.org/second?q=x,y',media_urls:'https://pbs.twimg.com/media/a.jpg, https://pbs.twimg.com/media/b.jpg'}],{}, {mode:'bookmarks',lang:'ru',translations:ru});
    assert(html.includes(ru.postTypeOriginals));
    for(const url of ['https://example.org/a,b','https://example.org/second?q=x,y','https://pbs.twimg.com/media/a.jpg','https://pbs.twimg.com/media/b.jpg']) {
        assert(html.includes(`href="${url}"`),url);
    }
});
