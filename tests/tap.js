const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9302,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 await page.goto('http://localhost:9302/'); await page.waitForTimeout(500);
 const res = await page.evaluate(async ()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,id,x,y,b)=>new PointerEvent(t,{pointerId:id,pointerType:'touch',clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true,cancelable:true});
   const badge=()=>document.getElementById('zoom-badge').textContent;
   const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   // pinch a 200%
   stage.dispatchEvent(ev('pointerdown',31,500,400,1));
   stage.dispatchEvent(ev('pointerdown',32,700,400,1));
   stage.dispatchEvent(ev('pointermove',31,400,400,1));
   stage.dispatchEvent(ev('pointermove',32,800,400,1));
   stage.dispatchEvent(ev('pointerup',31,400,400,0));
   stage.dispatchEvent(ev('pointerup',32,800,400,0));
   const afterPinch=badge();
   // subito un pinch di nuovo (rilasci ravvicinati) -> NON deve resettare
   await sleep(50);
   stage.dispatchEvent(ev('pointerdown',33,500,400,1));
   stage.dispatchEvent(ev('pointerdown',34,700,400,1));
   stage.dispatchEvent(ev('pointermove',33,450,400,1));
   stage.dispatchEvent(ev('pointermove',34,750,400,1));
   stage.dispatchEvent(ev('pointerup',33,450,400,0));
   stage.dispatchEvent(ev('pointerup',34,750,400,0));
   const afterPinch2=badge();
   // doppio tap a un dito -> reset a 100%
   await sleep(50);
   stage.dispatchEvent(ev('pointerdown',35,600,500,1));
   stage.dispatchEvent(ev('pointerup',35,600,500,0));
   await sleep(100);
   stage.dispatchEvent(ev('pointerdown',36,600,500,1));
   stage.dispatchEvent(ev('pointerup',36,600,500,0));
   const afterDoubleTap=badge();
   // pan singolo -> non deve resettare (movimento)
   stage.dispatchEvent(ev('pointerdown',37,600,500,1));
   stage.dispatchEvent(ev('pointermove',37,700,520,1));
   stage.dispatchEvent(ev('pointerup',37,700,520,0));
   const panPos = badge();
   return {afterPinch, afterPinch2, afterDoubleTap, panPos};
 });
 console.log(JSON.stringify(res));
 const ok = res.afterPinch==='200%' && res.afterPinch2!=='100%' && res.afterDoubleTap==='100%';
 console.log(ok?'PASS doppio-tap/pinch':'FAIL doppio-tap/pinch');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
