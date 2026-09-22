// Compare painted bounds at a common text baseline, not just DOM boxes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
require('./tooling-policy.js').assertBrowserSmokeCanLaunch();
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
 try{
 const page=await browser.newPage();
 const font=fs.readFileSync(path.join(root,'popup/emoji/ui-emoji.woff2')).toString('base64');
 const css=fs.readFileSync(path.join(root,'popup/emoji.css'),'utf8');
 const adjust=css.match(/size-adjust:\s*([\d.]+)%/)[1]+'%';
 const entries=JSON.parse(fs.readFileSync(path.join(root,'popup/emoji/manifest.json'))).emoji;
 const results=await page.evaluate(async({font,adjust,entries})=>{
 const face=new FontFace('Probe',`url(data:font/woff2;base64,${font})`,{sizeAdjust:adjust});await face.load();document.fonts.add(face);
 const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');
 function measure(emoji,family,size){
 ctx.clearRect(0,0,256,256);ctx.font=`${size}px ${family}`;ctx.fillText(emoji,40,140);
 const data=ctx.getImageData(0,0,256,256).data;let minX=256,minY=256,maxX=-1,maxY=-1;
 for(let y=0;y<256;y++)for(let x=0;x<256;x++)if(data[(y*256+x)*4+3]>128){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
 return {width:maxX-minX+1,height:maxY-minY+1,centerX:(maxX+minX)/2,centerY:(maxY+minY)/2,advance:ctx.measureText(emoji).width};
 }
 return [12,16,20,30,39].flatMap(size=>entries.map(({emoji})=>({emoji,size,native:measure(emoji,'-apple-system, BlinkMacSystemFont, Arial, sans-serif',size),bundled:measure(emoji,'Probe',size)})));
 },{font,adjust,entries});
 console.log(JSON.stringify(results,null,2));
 for(const r of results){
 assert(Math.abs(r.native.centerY-r.bundled.centerY)<=Math.max(1.5,r.size*.06),`${r.emoji} at ${r.size}px: vertical center differs by ${r.bundled.centerY-r.native.centerY}px`);
 assert(Math.abs(r.native.width-r.bundled.width)<=Math.max(5,r.size*.4),`${r.emoji} at ${r.size}px: artwork width differs`);
 assert(Math.abs((r.bundled.centerX-40)-r.bundled.advance/2)<=1.5,`${r.emoji}: center within its advance`);
 }
 console.log(`PASS ${results.length} emoji alignment/size cases against native Apple`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
