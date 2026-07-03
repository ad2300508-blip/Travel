const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9308,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:9308/'); await page.waitForTimeout(500);
 const pen = (pts) => page.evaluate(pts=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',pts[0][0],pts[0][1],1));
   for(let i=1;i<pts.length;i++) stage.dispatchEvent(ev('pointermove',pts[i][0],pts[i][1],1));
   const l=pts[pts.length-1]; stage.dispatchEvent(ev('pointerup',l[0],l[1],0));
 },pts);

 // pagina 1: tratto. pagina 2: vuota. pagina 3: vuota
 await pen([[300,300],[400,300],[500,300]]);
 await page.click('#btn-addpage'); await page.waitForTimeout(200);
 await page.click('#btn-addpage'); await page.waitForTimeout(600);
 // sidebar: sposta pagina 1 dopo (→ posizione 2)
 await page.click('#btn-menu'); await page.waitForTimeout(300);
 await page.click('#page-list li:first-child .pg-move.right'); await page.waitForTimeout(400);
 // ora la pagina col tratto è la seconda: la miniatura 2 ha inchiostro
 const inked2 = await page.evaluate(()=>{
   const cv=document.querySelectorAll('#page-list li canvas')[1];
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   for(let i=0;i<d.length;i+=16){ if(d[i]<100&&d[i+1]<100&&d[i+2]<100) return true; }
   return false;
 });
 const pager = await page.evaluate(()=>document.getElementById('page-label').textContent);
 console.log('riordino: miniatura2 con inchiostro', inked2, 'pager', pager);
 await page.click('#scrim'); await page.waitForTimeout(200);
 await page.click('#btn-prev'); await page.waitForTimeout(300); // vai alla pagina col tratto (ora la 2)

 // ricolorazione: lazo sul tratto, poi tap sul rosso
 await page.click('[data-tool="lasso"]');
 await pen([[260,250],[540,250],[540,350],[260,350]]);
 await page.waitForTimeout(200);
 await page.evaluate(()=>document.querySelectorAll('.swatch')[2].click()); // rosso #d62839
 await page.waitForTimeout(700);
 const color = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length); res(pg.strokes[0].color);
   };};
 }));
 console.log('colore dopo ricolorazione:', color);
 // undo ripristina il nero
 await page.keyboard.press('Control+z'); await page.waitForTimeout(700);
 const color2 = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length); res(pg.strokes[0].color);
   };};
 }));
 console.log('dopo undo:', color2);
 const ok = inked2 && pager==='3 / 3' && color==='#d62839' && color2==='#1c1b1a' && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS misc':'FAIL misc');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
