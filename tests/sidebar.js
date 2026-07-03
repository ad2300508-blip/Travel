const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9303,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 await page.goto('http://localhost:9303/'); await page.waitForTimeout(500);
 // disegna un tratto, crea 2 pagine extra
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,p,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:p,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',200,300,0.5,1));
   stage.dispatchEvent(ev('pointermove',400,350,0.7,1));
   stage.dispatchEvent(ev('pointerup',400,350,0,0));
 });
 await page.click('#btn-addpage'); await page.waitForTimeout(200);
 await page.click('#btn-addpage'); await page.waitForTimeout(200);
 // apri sidebar
 await page.click('#btn-menu'); await page.waitForTimeout(300);
 const thumbs = await page.evaluate(()=>document.querySelectorAll('#page-list li').length);
 const activeIdx = await page.evaluate(()=>[...document.querySelectorAll('#page-list li')].findIndex(li=>li.classList.contains('active')));
 console.log('thumbs:',thumbs,'active:',activeIdx);
 // clic sulla prima pagina
 await page.click('#page-list li:first-child'); await page.waitForTimeout(300);
 const pager = await page.evaluate(()=>document.getElementById('page-label').textContent);
 console.log('pager dopo click pagina 1:', pager);
 // riapri e cancella pagina 3 (vuota, niente confirm)
 await page.click('#btn-menu'); await page.waitForTimeout(300);
 await page.click('#page-list li:nth-child(3) .pg-del'); await page.waitForTimeout(400);
 const thumbs2 = await page.evaluate(()=>document.querySelectorAll('#page-list li').length);
 const pager2 = await page.evaluate(()=>document.getElementById('page-label').textContent);
 console.log('dopo delete: thumbs',thumbs2,'pager',pager2);
 // la miniatura della pagina 1 deve avere inchiostro
 const inked = await page.evaluate(()=>{
   const cv=document.querySelector('#page-list li canvas');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   for(let i=0;i<d.length;i+=16){ if(d[i]<100&&d[i+1]<100&&d[i+2]<100) return true; }
   return false;
 });
 console.log('miniatura con inchiostro:', inked);
 const ok = thumbs===3 && activeIdx===2 && pager==='1 / 3' && thumbs2===2 && pager2==='1 / 2' && inked && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS sidebar':'FAIL sidebar');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
