const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9307,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 await page.goto('http://localhost:9307/'); await page.waitForTimeout(500);
 const pen = (pts) => page.evaluate(pts=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',pts[0][0],pts[0][1],1));
   for(let i=1;i<pts.length;i++) stage.dispatchEvent(ev('pointermove',pts[i][0],pts[i][1],1));
   const l=pts[pts.length-1];
   stage.dispatchEvent(ev('pointerup',l[0],l[1],0));
 },pts);
 // tratto orizzontale 300->500 a y=400, size 4
 await pen([[300,400],[350,400],[400,400],[450,400],[500,400]]);
 await page.waitForTimeout(100);
 // lazo attorno
 await page.click('[data-tool="lasso"]');
 await pen([[260,340],[540,340],[540,460],[260,460]]);
 await page.waitForTimeout(200);
 const bbox0 = await page.evaluate(()=>{
   const b=document.getElementById('selbar'); return !b.hidden;
 });
 // maniglia: angolo basso-destro del bbox ~ (502,402)+pad… trasciniamo da lì a +250,+250 (raddoppio circa)
 // bbox: x0~298,y0~398,x1~502,y1~402 → diag0~204; drag della maniglia a (700,600): d=hypot(402,202)=~450 → f≈2.2
 await pen([[502,402],[600,500],[700,600]]);
 await page.waitForTimeout(800);
 const after = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length);
     const s=pg.strokes[0];
     res({size:s.size, first:s.points[0], last:s.points[s.points.length-1]});
   };};
 }));
 console.log('dopo scala:', JSON.stringify(after));
 const width0 = 500-300;
 const width1 = after.last[0]-after.first[0];
 const f = width1/width0;
 const sizeOK = Math.abs(after.size/4 - f) < 0.05; // lo spessore scala con f
 console.log('fattore:', f.toFixed(2), 'spessore scala pure:', sizeOK);
 // undo riporta alle dimensioni originali
 await page.keyboard.press('Control+z');
 await page.waitForTimeout(700);
 const undone = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length);
     const s=pg.strokes[0];
     res({size:s.size, w:s.points[s.points.length-1][0]-s.points[0][0]});
   };};
 }));
 console.log('dopo undo:', JSON.stringify(undone));
 const ok = bbox0 && f>1.5 && f<3 && sizeOK && Math.abs(undone.w-200)<1 && Math.abs(undone.size-4)<0.01 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS scala':'FAIL scala');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
