const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9311,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:9311/'); await page.waitForTimeout(500);
 // tratto al centro
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:0.5,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',400,300,1));
   stage.dispatchEvent(ev('pointermove',700,500,1));
   stage.dispatchEvent(ev('pointerup',700,500,0));
 });
 // pan lontano col dito, poi F per tornare al contenuto
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:20,pointerType:'touch',clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',600,400,1));
   stage.dispatchEvent(ev('pointermove',100,100,1)); // pan di -500,-300
   stage.dispatchEvent(ev('pointerup',100,100,0));
 });
 await page.waitForTimeout(100);
 const inkBefore = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let n=0; for(let i=0;i<d.length;i+=40) if(d[i]<100) n++;
   return n;
 });
 await page.keyboard.press('f');
 await page.waitForTimeout(200);
 const inkAfter = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let n=0; for(let i=0;i<d.length;i+=40) if(d[i]<100) n++;
   return n;
 });
 // memoria vista per pagina: nuova pagina, torna indietro -> vista fit conservata
 const viewFit = await page.evaluate(()=>document.getElementById('zoom-badge').textContent);
 await page.click('#btn-addpage'); await page.waitForTimeout(300);
 const viewNew = await page.evaluate(()=>document.getElementById('zoom-badge')); // pagina nuova: default
 await page.click('#btn-prev'); await page.waitForTimeout(800);
 const viewBack = await page.evaluate(()=>Math.round((JSON.parse(localStorage.getItem('x'))||0))); // n/a
 // ricarica: la vista della pagina 1 deve tornare dal DB
 await page.reload(); await page.waitForTimeout(700);
 const inkReload = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let n=0; for(let i=0;i<d.length;i+=40) if(d[i]<100) n++;
   return n;
 });
 console.log('pan via:', inkBefore, '| dopo F:', inkAfter, '| dopo reload (vista ricordata):', inkReload);
 const ok = inkBefore < inkAfter/3 && inkAfter>100 && inkReload>100 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS fit':'FAIL fit');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
