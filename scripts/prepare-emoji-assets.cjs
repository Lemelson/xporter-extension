// Build-time asset acquisition/rasterization only; no CDN calls in the extension.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const {chromium} = require('playwright');
const root=path.join(__dirname,'..'), dir=path.join(root,'popup/emoji');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function get(url){const r=await fetch(url);if(!r.ok)throw new Error(`${r.status} ${url}`);return Buffer.from(await r.arrayBuffer());}
async function commit(repo,branch){return JSON.parse((await get(`https://api.github.com/repos/${repo}/commits/${branch}`)).toString()).sha;}
(async()=>{
 const download=process.argv.includes('--download');
 let entries;
 if(download){
  const [emojitwo,fluent]=await Promise.all([commit('EmojiTwo/emojitwo','master'),commit('microsoft/fluentui-emoji','main')]);
  const flags=['🇺🇸','🇨🇳','🇯🇵','🇪🇸','🇰🇷','🇷🇺','🇮🇹','🇧🇷','🇹🇷','🇩🇪','🇸🇦','🇫🇷','🇮🇳','🇮🇩'];
  entries=[...flags,'⚠️','📝','🔖','👥','➡️','🌐'].map(emoji=>{
   const code=[...emoji].filter(c=>c.codePointAt(0)!==0xfe0f).map(c=>c.codePointAt(0).toString(16)).join('-');
   let vendor='Google Noto',license='Apache-2.0 / region flag exceptions',source=`https://fonts.gstatic.com/s/e/notoemoji/latest/${code.replaceAll('-','_')}/512.png`;
   if(['⚠️','👥'].includes(emoji)){vendor='Twemoji';license='CC-BY-4.0';source=`https://raw.githubusercontent.com/jdecked/twemoji/v17.0.3/assets/72x72/${code}.png`;}
   if(emoji==='🔖'){vendor='Emojitwo';license='CC-BY-4.0';source=`https://raw.githubusercontent.com/EmojiTwo/emojitwo/${emojitwo}/svg/${code}.svg`;}
   if(emoji==='🌐'){vendor='Microsoft Fluent Color';license='MIT';source=`https://raw.githubusercontent.com/microsoft/fluentui-emoji/${fluent}/assets/Globe%20with%20meridians/Color/globe_with_meridians_color.svg`;}
   return {emoji,vendor,license,source,sourceFile:`sources/${code}${source.endsWith('.svg')?'.svg':'.png'}`,file:`${code}.png`};
  });
  fs.mkdirSync(path.join(dir,'sources'),{recursive:true});
  for(const entry of entries){const bytes=await get(entry.source);entry.sourceSha256=hash(bytes);fs.writeFileSync(path.join(dir,entry.sourceFile),bytes);}
 }else entries=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))).emoji;
 const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
 try{
  const page=await browser.newPage();
  for(const entry of entries){
   const source=fs.readFileSync(path.join(dir,entry.sourceFile));
   if(hash(source)!==entry.sourceSha256)throw new Error(`Source hash changed: ${entry.emoji}`);
   const mime=entry.sourceFile.endsWith('.svg')?'image/svg+xml':'image/png';
   const png=await page.evaluate(async({base64,mime})=>{
    const img=new Image();img.src=`data:${mime};base64,${base64}`;await img.decode();
    const c=document.createElement('canvas');c.width=c.height=72;
    const ctx=c.getContext('2d');ctx.imageSmoothingQuality='high';
    const scale=Math.min(72/img.naturalWidth,72/img.naturalHeight);
    const w=img.naturalWidth*scale,h=img.naturalHeight*scale;
    ctx.drawImage(img,(72-w)/2,(72-h)/2,w,h);
    return c.toDataURL('image/png').split(',')[1];
   },{base64:source.toString('base64'),mime});
   const bytes=Buffer.from(png,'base64');fs.writeFileSync(path.join(dir,entry.file),bytes);entry.sha256=hash(bytes);
  }
 }finally{await browser.close();}
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({description:'User-selected UI artwork; native Apple emoji remain on Apple platforms.',emoji:entries},null,2)+'\n');
 console.log(`Prepared ${entries.length} selected emoji from verified source files`);
})().catch(e=>{console.error(e);process.exitCode=1});
