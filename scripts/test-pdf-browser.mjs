#!/usr/bin/env node
// Disposable Helium, generated fixtures only. No authenticated X requests.
// Writes real browser PDFs for four scripts; inspect the rendered PDF pages too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import toolingPolicy from './tooling-policy.js';
toolingPolicy.assertBrowserSmokeCanLaunch();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const out = process.env.XPORTER_PDF_QA_OUT || path.resolve(root, '../outputs/xporter-followup-20260930/pdf');
fs.mkdirSync(out, { recursive:true });
const serializer = vm.createContext({ URL });
for (const file of ['utils/columns-i18n.js', 'utils/pdf.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), serializer);
}
const base = {
    id:'1234567890123456789', type:'tweet', author_name:'Ada', author_username:'ada',
    created_at:'2026-09-30T12:34:00Z', tweet_url:'https://x.com/ada/status/1234567890123456789',
    favorite_count:123, view_count:10240, reply_count:0, bookmark_count:8
};
const fixtures = [
    {
        name:'en-short-archive', lang:'en', status:'complete',
        rows:[
            { ...base, text:'The best archive is the one you can still read years later.\n\nKeep the author, date, links and the original words together.' },
            { ...base, id:'2', author_name:'Grace Hopper', author_username:'grace', type:'quote', text:'A useful observation, saved with its context.', quoted_post:{ author_name:'Alan Turing',author_username:'alan',created_at:'2026-09-28T09:00:00Z',text:'We can only see a short distance ahead, but we can see plenty there that needs to be done.', media_alt_texts:'A notebook on a wooden desk.', tweet_url:'https://example.org/notes?a=1&b=2' } },
            { ...base,id:'3',author_name:'Lin',author_username:'lin',text:'A quiet lake at sunrise.',media_type:'photo',media_urls:'https://pbs.twimg.com/media/sample.jpg',media_alt_texts:'A mountain and its reflection in a still lake, with a thin band of morning mist.' }
        ]
    },
    {
        name:'ru-long-article-partial',lang:'ru',status:'partial',
        rows:[{ ...base,type:'article',author_name:'Елена Петрова',author_username:'elena',text:'Сохранённая статья: текст и контекст остаются вместе.',article_title:'Архив, который удобно читать',article_text:Array.from({length:14},(_,i)=>`${i+1}. Хороший архив помогает вернуться к мысли, а не только найти ссылку. В нём видны автор, дата публикации и исходный контекст. Длинный текст спокойно переносится на следующие страницы, сохраняя абзацы и порядок чтения.\n\nСсылки и описания изображений дополняют текст. Даже без подключения к интернету понятно, что было сохранено и почему это могло быть полезно.`).join('\n\n'),article_url:'https://example.org/article/reading-archive',reply_to_post:{author_name:'Артём',author_username:'artem',text:'Можно ли сохранить закладки так, чтобы их было приятно перечитывать?',quoted_post:{author_name:'Саша',author_username:'sasha',text:'Контекст важен не меньше самого сообщения.',media_alt_texts:'Заметки на полях книги.'}}}]
    },
    {
        name:'zh-long-alt-and-url',lang:'zh',status:'complete',
        rows:[{ ...base,author_name:'林晓',author_username:'linxiao',text:'保留每条帖子原本的文字、作者和日期。\n\n图片的替代文本也属于内容。它让没有图片的档案仍然可以理解。',media_type:'photo',media_alt_texts:Array.from({length:36},(_,i)=>`${i+1}. 画面中是一座山和一个湖。清晨的雾在水面上飘动，树木的倒影清晰可见。这个描述用于验证很长的替代文本能在多页中保持完整。`).join('\n\n'),media_urls:'https://example.org/'+('very-long-segment-without-truncation/'.repeat(40))+'END_OF_LONG_URL',tweet_url:base.tweet_url},{...base,id:'2',author_name:'美雪',author_username:'miyuki',text:'日本語もそのまま保存されます。読みやすさと正確さの両方を大切にします。',media_alt_texts:'日本語の説明文も保持します。'}]
    },
    {
        name:'ar-rtl-article-context',lang:'ar',status:'partial',
        rows:[{ ...base,type:'reply',author_name:'ليلى أحمد',author_username:'layla',text:'هذا أرشيف للقراءة، يحفظ النص والسياق والتاريخ.\n\nتبقى أسماء المستخدمين والروابط واضحة حتى عندما تكون الصفحة من اليمين إلى اليسار.',article_title:'العودة إلى الأفكار المحفوظة',article_text:Array.from({length:10},(_,i)=>`${i+1}. يمكننا العودة إلى المنشورات المحفوظة بعد وقت طويل. يساعدنا وجود اسم الكاتب وتاريخ النشر والسياق على فهم الفكرة كما ظهرت أول مرة. يظل النص واضحًا عندما ينتقل إلى الصفحة التالية.\n\nتُحفظ أوصاف الصور والروابط مع النص، ولا يحتاج هذا المستند إلى الاتصال بالإنترنت لعرض محتواه. تبقى الكلمات العربية متصلة وقابلة للقراءة.`).join('\n\n'),media_alt_texts:'جبل ينعكس في بحيرة هادئة، مع ضباب خفيف فوق الماء عند شروق الشمس.',urls:'https://example.org/search?q=Arabic&lang=ar',reply_to_post:{author_name:'عمر',author_username:'omar',text:'كيف نحافظ على سياق الرد مع النص الأصلي؟',media_alt_texts:'صفحة من دفتر ملاحظات.',quoted_post:{author_name:'نور',author_username:'noor',text:'هذا اقتباس داخل المنشور الذي تم الرد عليه.',media_alt_texts:'وصف الصورة في الاقتباس المتداخل.'}}}]
    }
];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xporter-pdf-qa-'));
const browser = await chromium.launchPersistentContext(profile, {
    headless:true,executablePath:process.env.XPORTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    viewport:{width:1000,height:900},args:['--no-first-run']
});
try {
    for (const fixture of fixtures) {
        const copy = JSON.parse(fs.readFileSync(path.join(root,`popup/locales/${fixture.lang}.json`),'utf8'));
        const html = serializer.XPorterPDF.generate(fixture.rows,{}, {
            mode:'bookmarks',lang:fixture.lang,translations:copy,exportedAt:'2026-09-30T12:00:00Z',exportStatus:fixture.status
        });
        const htmlPath = path.join(out,fixture.name+'.html');
        fs.writeFileSync(htmlPath,html);
        const page = await browser.newPage();
        const requests = [], errors = [];
        page.on('request',r=>{if(!r.url().startsWith('file:'))requests.push(r.url());});
        page.on('pageerror',e=>errors.push(e.message));
        await page.addInitScript(()=>{window.__printCalls=0;window.print=()=>window.__printCalls++;});
        await page.goto('file://'+htmlPath);
        assert.equal(await page.evaluate(()=>window.__printCalls),0,'no print dialog before click');
        await page.getByRole('button',{name:copy.pdfPrint,exact:true}).click();
        assert.equal(await page.evaluate(()=>window.__printCalls),1,'CSP allows the explicit print button');
        assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'the document stays offline');
        assert.equal(await page.locator('article').count(),fixture.rows.length);
        assert.equal(await page.locator('.partial').count(),fixture.status==='partial'?1:0);
        const overflow = await page.evaluate(()=>Array.from(document.querySelectorAll('.post-text p,.article-text p,.detail-text p,.source-links p')).filter(n=>n.scrollWidth>n.clientWidth+1).length);
        assert.equal(overflow,0);
        if(fixture.lang==='ar') {
            assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
            assert.equal(await page.locator('.author-handle').first().evaluate(n=>getComputedStyle(n).unicodeBidi),'isolate');
        }
        await page.screenshot({path:path.join(out,fixture.name+'-browser.png'),fullPage:true});
        await page.pdf({path:path.join(out,fixture.name+'.pdf'),printBackground:true,preferCSSPageSize:true,tagged:true});
        console.log(JSON.stringify({fixture:fixture.name,pdf:path.join(out,fixture.name+'.pdf'),printButtonCalls:1,externalRequests:requests.length,overflow,errors}));
        await page.close();
    }
} finally {
    await browser.close();fs.rmSync(profile,{recursive:true,force:true});
}
