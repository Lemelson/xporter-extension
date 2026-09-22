'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(reduced = false, random = 0.3) {
    let now=0,id=0,observer,active=true,hidden=false,motionChange;
    const timers=new Map(),frames=new Map(),messages=[],docEvents={};
    let writes=0;
    const element=()=>({style:{setProperty(){},set transform(value){this.value=value;writes++;},get transform(){return this.value||'';}},
        classList:{add(){},remove(){},contains(){return active;}},addEventListener(type,fn){this[type]=fn;}});
    const body=element(),rotator=element(),bug=element(),tab=element();
    const legs=Array.from({length:6},()=>{const leg=element();leg.lower=element();leg.querySelector=()=>leg.lower;return leg;});
    bug.querySelector=s=>s==='.lb-heading'?rotator:body;
    bug.querySelectorAll=()=>legs;
    const card={...element(),clientWidth:300,clientHeight:300,
        getBoundingClientRect:()=>({left:30,top:100,width:302}),
        querySelector:()=>({getBoundingClientRect:()=>({top:210})}),
        appendChild(s){s.parentNode=this;},removeChild(s){s.parentNode=null;}};
    const media={matches:reduced,addEventListener(_,fn){motionChange=fn;}};
    const ctx=vm.createContext({document:{documentElement:{clientWidth:360},get hidden(){return hidden;},
        querySelector:s=>s==='.about-contact'?card:s==='.ladybug'?bug:null,
        getElementById:id=>id==='tab-about'?tab:null,createElement:element,addEventListener:(type,fn)=>docEvents[type]=fn},
        window:{matchMedia:()=>media,addEventListener(){}},
        Math:Object.assign(Object.create(Math),{random:()=>random}),getComputedStyle:()=>({borderTopWidth:'1'}),
        chrome:{runtime:{sendMessage(m,cb){messages.push(m);cb();}}},
        MutationObserver:class{constructor(fn){observer=fn;}observe(){}},
        setTimeout(fn,ms){timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:i=>timers.delete(i),
        requestAnimationFrame(fn){frames.set(++id,fn);return id;},cancelAnimationFrame:i=>frames.delete(i)});
    for(const file of ['ladybug-motion.js','ladybug.js']) {
        const source=path.join(__dirname,'../popup',file);
        if(fs.existsSync(source))vm.runInContext(fs.readFileSync(source,'utf8'),ctx);
    }
    function advance(ms){for(let end=now+ms;now<end;){now=Math.min(end,now+1000/120);for(const [i,t] of [...timers])if(t.at<=now){timers.delete(i);t.fn();}const pending=[...frames];frames.clear();pending.forEach(([,fn])=>fn(now));}}
    return {bug,legs,body,messages,advance,frames,timers,ctx,
        click:()=>bug.pointerdown({preventDefault(){}}),
        disable:()=>ctx.window.XPorterLadybug.setEnabled(false),
        leave(){active=false;observer();},enter(){active=true;observer();},
        hide(){hidden=true;docEvents.visibilitychange?.();},show(){hidden=false;docEvents.visibilitychange?.();},
        reduce(){media.matches=true;motionChange?.();},get writes(){return writes;}};
}
const xy=bug=>{const m=/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(bug.style.transform);assert(m,'movement must use transform');return {x:+m[1],y:+m[2]};};
for(const random of [.3,.8]){
    const h=harness(false,random);h.advance(40);xy(h.bug);h.click();h.click();assert.equal(h.messages.length,1);
    h.advance(2200);assert.equal(h.bug.style.display,'none');h.advance(120);assert.equal(h.bug.style.display,'block');
    assert(random<.5?xy(h.bug).x<-22:xy(h.bug).x>300,'replacement starts offscreen');
    h.advance(12000);assert(xy(h.bug).x>=4&&xy(h.bug).x<=274);h.click();assert.equal(h.messages.length,2);
    h.disable();h.advance(10000);assert.equal(h.bug.style.display,'none');assert.equal(h.frames.size+h.timers.size,0);
}
const h=harness();h.advance(100);const start=h.writes;h.advance(1000);assert(h.writes-start<=32*14,'position, heading and 12 joints update at most 30 Hz');
const pose=h.legs.map(l=>[l.style.transform,l.lower.style.transform]);h.advance(1000);assert.notDeepEqual(h.legs.map(l=>[l.style.transform,l.lower.style.transform]),pose,'joints follow travelled distance');
h.hide();assert.equal(h.frames.size+h.timers.size,0,'hidden UI does not keep callbacks');const hiddenWrites=h.writes;h.advance(10000);assert.equal(h.writes,hiddenWrites);
h.show();h.advance(100);assert.equal(h.bug.style.display,'block');h.leave();assert.equal(h.frames.size+h.timers.size,0);h.enter();h.advance(100);h.reduce();assert.equal(h.frames.size,0);const still=h.writes;h.advance(5000);assert.equal(h.writes,still,'reduced motion stays still');h.click();assert.equal(h.messages.length,1);h.advance(2400);assert.equal(h.bug.style.display,'block');h.click();assert.equal(h.messages.length,2);
// Tangent continuity, boundaries and alternating tripods use the production helper.
const motion=h.ctx.XPorterLadybugMotion;let seed=42;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
for(const zone of [{l:4,r:270,t:4,b:80},{l:4,r:12,t:4,b:9}]){
 let pos={x:(zone.l+zone.r)/2,y:(zone.t+zone.b)/2},heading=1;
 for(let n=0;n<400;n++){const p=motion.createPath(pos,heading,zone,random);for(let i=0;i<=50;i++){const q=motion.bezier(p,i/50);assert(q.x>=zone.l-1e-8&&q.x<=zone.r+1e-8);assert(q.y>=zone.t-1e-8&&q.y<=zone.b+1e-8);}pos=p[3];heading=motion.direction(p,.999);}
}
assert.equal(motion.legPose(7,0).bend,motion.legPose(7,2).bend,'left front and rear share a phase');
assert.equal(motion.legPose(7,0).bend,-motion.legPose(7,4).bend,'right middle joins the opposite-side tripod');
console.log('Ladybug: articulated gait, bounded paths, 30 Hz, squash/respawn, visibility, settings and reduced motion passed.');
