const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9314,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:9314/'); await page.waitForTimeout(500);
 const pen=(pts,type='pen')=>page.evaluate(({pts,type})=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:type,clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',pts[0][0],pts[0][1],1));
   for(let i=1;i<pts.length;i++) stage.dispatchEvent(ev('pointermove',pts[i][0],pts[i][1],1));
   const l=pts[pts.length-1]; stage.dispatchEvent(ev('pointerup',l[0],l[1],0));
 },{pts,type});
 const count=()=>page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     res(this.result.sort((a,b)=>a.index-b.index).map(p=>p.strokes.length));
   };};
 }));
 // tratto + lazo + copia
 await pen([[300,300],[400,320],[500,300]]);
 await page.click('[data-tool="lasso"]');
 await pen([[260,250],[540,250],[540,360],[260,360]]);
 await page.waitForTimeout(200);
 await page.click('#sel-copy');
 // nuova pagina + incolla con Ctrl+V
 await page.click('#btn-addpage'); await page.waitForTimeout(300);
 await page.keyboard.press('Control+v'); await page.waitForTimeout(800);
 const counts = await count();
 console.log('tratti per pagina dopo incolla:', JSON.stringify(counts));
 const selVisible = await page.evaluate(()=>!document.getElementById('selbar').hidden);
 // spostamento col DITO della selezione incollata
 await pen([[700,450],[750,470],[800,500]],'touch'); // dal centro selezione (incollata al centro vista)
 await page.waitForTimeout(800);
 const moved = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pgs=this.result.sort((a,b)=>a.index-b.index);
     const s=pgs[1].strokes[0];
     res(s.points[0]);
   };};
 }));
 console.log('selezione visibile:', selVisible, '| primo punto dopo drag col dito:', JSON.stringify(moved));
 // presentazione: toolbar sparisce, Esc la ripristina
 await page.click('#btn-settings'); await page.click('#btn-present'); await page.waitForTimeout(300);
 const tbHidden = await page.evaluate(()=>getComputedStyle(document.getElementById('toolbar')).display==='none');
 await page.keyboard.press('Escape'); await page.waitForTimeout(300);
 const tbBack = await page.evaluate(()=>getComputedStyle(document.getElementById('toolbar')).display!=='none');
 console.log('presentazione: toolbar nascosta', tbHidden, '| Esc ripristina', tbBack);
 const ok = counts.length===2 && counts[0]===1 && counts[1]===1 && selVisible
   && Array.isArray(moved) && tbHidden && tbBack && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS clipboard':'FAIL clipboard');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
