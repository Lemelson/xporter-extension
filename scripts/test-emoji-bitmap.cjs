// Compare the actual painted glyph against its source PNG, not merely font selection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
 try{
 const page=await browser.newPage();
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'popup/emoji/manifest.json')));
 const fontFile=fs.existsSync(path.join(root,'popup/emoji/ui-emoji.woff2'))?'ui-emoji.woff2':'twemoji.woff2';
 const font=fs.readFileSync(path.join(root,'popup/emoji',fontFile)).toString('base64');
 const cases=manifest.emoji.map(e=>({...e,image:fs.readFileSync(path.join(root,'popup/emoji',e.file)).toString('base64')}));
 const result=await page.evaluate(async({font,cases})=>{
  const face=new FontFace('BitmapProbe',`url(data:font/woff2;base64,${font})`);
  await face.load();document.fonts.add(face);
  const results=[];
  function bounds(ctx){
   const {data,width,height}=ctx.getImageData(0,0,256,256);
   let count=0,minX=width,minY=height,maxX=-1,maxY=-1;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]>128){count++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
   return {count,width:maxX-minX+1,height:maxY-minY+1};
  }
  for(const entry of cases){
   const image=new Image();image.src=`data:image/png;base64,${entry.image}`;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');
   ctx.drawImage(image,40,40,72,72);const source=bounds(ctx);
   ctx.clearRect(0,0,256,256);ctx.font='72px BitmapProbe';ctx.fillText(entry.emoji,40,140);const glyph=bounds(ctx);
   results.push({emoji:entry.emoji,source,glyph,areaRatio:glyph.count/source.count});
  }
  return results;
 },{font,cases});
 console.log(JSON.stringify(result,null,2));
 for(const r of result){assert(Math.abs(r.areaRatio-1)<0.025,`${r.emoji}: bitmap lost or gained pixels (${r.areaRatio.toFixed(3)} of source)`);assert(Math.abs(r.source.height-r.glyph.height)<=1,`${r.emoji}: full source height must paint`);}
 console.log('PASS complete source bitmaps painted for every emoji');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
