const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9309,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:9309/'); await page.waitForTimeout(500);
 // tratto orizzontale al centro
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:0.6,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',600,450,1));
   stage.dispatchEvent(ev('pointermove',700,450,1));
   stage.dispatchEvent(ev('pointerup',700,450,0));
 });
 await page.waitForTimeout(100);
 // durante il pinch (senza rilascio) il blit deve mostrare il tratto ingrandito
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,id,x,y,b)=>new PointerEvent(t,{pointerId:id,pointerType:'touch',clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',21,550,450,1));
   stage.dispatchEvent(ev('pointerdown',22,750,450,1));
   stage.dispatchEvent(ev('pointermove',21,450,450,1)); // zoom x2 attorno al centro (650,450)
   stage.dispatchEvent(ev('pointermove',22,850,450,1));
 });
 const during = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let dark=0; for(let i=0;i<d.length;i+=40){ if(d[i]<100) dark++; }
   return dark;
 });
 // rilascio -> ridisegno nitido
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,id,x,y)=>new PointerEvent(t,{pointerId:id,pointerType:'touch',clientX:r.left+x,clientY:r.top+y,pressure:0,buttons:0,bubbles:true});
   stage.dispatchEvent(ev('pointerup',21,450,450));
   stage.dispatchEvent(ev('pointerup',22,850,450));
 });
 await page.waitForTimeout(200);
 const after = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let dark=0; for(let i=0;i<d.length;i+=40){ if(d[i]<100) dark++; }
   const badge=document.getElementById('zoom-badge').textContent;
   return {dark, badge};
 });
 console.log('inchiostro durante blit:', during, '| dopo rilascio:', after.dark, 'zoom', after.badge);
 // il tratto ingrandito 2x deve coprire ~2x i pixel del tratto originale (~era metà)
 const ok = during>50 && after.dark>50 && after.badge==='200%' && Math.abs(after.dark-during)/after.dark<0.35 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS blit':'FAIL blit');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
