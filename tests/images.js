const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9306,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const ctx = await browser.newContext({acceptDownloads:true});
 const page = await ctx.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 await page.goto('http://localhost:9306/'); await page.waitForTimeout(500);
 // inserisci immagine
 await page.click('#btn-settings');
 const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-insertimg')]);
 await chooser.setFiles(path.join(__dirname,'test-img.png'));
 await page.waitForTimeout(900);
 // pixel rossi sul canvas base?
 const red = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let n=0; for(let i=0;i<d.length;i+=40){ if(d[i]>150&&d[i+1]<90&&d[i+2]<110) n++; }
   return n;
 });
 console.log('pixel immagine:', red);
 // selezione attiva subito dopo l'inserimento
 const selNow = await page.evaluate(()=>!document.getElementById('selbar').hidden);
 // spostala di 200,100 col lazo (drag dal centro)
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const cx=r.width/2, cy=r.height/2;
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:8,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:b?0.5:0,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',cx,cy,1));
   stage.dispatchEvent(ev('pointermove',cx+100,cy+50,1));
   stage.dispatchEvent(ev('pointermove',cx+200,cy+100,1));
   stage.dispatchEvent(ev('pointerup',cx+200,cy+100,0));
 });
 await page.waitForTimeout(800);
 const moved = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length);
     const im=pg&&pg.strokes.find(s=>s.tool==='image');
     res(im?{n:pg.strokes.length, sizeKB:Math.round(im.data.length/1024)}:null);
   };};
 }));
 console.log('selezione subito:', selNow, '| immagine salvata:', JSON.stringify(moved));
 // undo rimuove l'immagine
 await page.keyboard.press('Escape');
 await page.keyboard.press('Control+z');
 await page.waitForTimeout(800); // undo del move
 await page.keyboard.press('Control+z');
 await page.waitForTimeout(800); // undo dell'inserimento
 const afterUndo = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     res(this.result.reduce((a,p)=>a+p.strokes.length,0));
   };};
 }));
 console.log('dopo 2 undo:', afterUndo, 'tratti');
 // redo x2 e PDF con immagine
 await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y');
 await page.waitForTimeout(600);
 await page.click('#btn-settings');
 const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-exportpdf')]);
 await dl.saveAs(path.join(__dirname,'out-img.pdf'));
 const pdf = fs.readFileSync(path.join(__dirname,'out-img.pdf'));
 console.log('pdf con immagine:', pdf.length, 'bytes');
 const ok = red>100 && selNow && moved && moved.n===1 && afterUndo===0 && pdf.length>5000 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS immagini':'FAIL immagini');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
