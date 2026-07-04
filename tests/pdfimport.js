const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9312,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:9312/'); await page.waitForTimeout(500);

 // genera un PDF di 2 pagine col generatore dell'app stessa
 const pdfB64 = await page.evaluate(async ()=>{
   const { buildPdf } = await import('/pdf.js');
   const mk = (color) => {
     const cv=document.createElement('canvas'); cv.width=600; cv.height=848;
     const c=cv.getContext('2d');
     c.fillStyle='#fff'; c.fillRect(0,0,600,848);
     c.fillStyle=color; c.fillRect(80,80,440,300);
     c.fillStyle='#333'; c.font='40px sans-serif'; c.fillText('Documento di prova',90,500);
     return cv;
   };
   const jpegs=[];
   for (const col of ['#8ecae6','#ffb703']) {
     const blob = await new Promise(r=>mk(col).toBlob(r,'image/jpeg',0.9));
     jpegs.push({jpeg:new Uint8Array(await blob.arrayBuffer()), w:600, h:848});
   }
   const pdfBlob = buildPdf(jpegs);
   const buf = new Uint8Array(await pdfBlob.arrayBuffer());
   let s=''; for (const b of buf) s+=String.fromCharCode(b);
   return btoa(s);
 });
 console.log('pdf di prova:', Math.round(pdfB64.length*3/4/1024), 'KB');

 // importa
 await page.click('#btn-settings');
 const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-importpdf')]);
 await chooser.setFiles({name:'prova.pdf', mimeType:'application/pdf', buffer: Buffer.from(pdfB64,'base64')});
 await page.waitForTimeout(4000);

 const pager = await page.evaluate(()=>document.getElementById('page-label').textContent);
 // pixel dell'immagine di sfondo visibili (azzurro della pagina 1)
 const bluish = await page.evaluate(()=>{
   const cv=document.getElementById('base');
   const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
   let n=0; for(let i=0;i<d.length;i+=40){ if(d[i]>100&&d[i]<180&&d[i+2]>200) n++; }
   return n;
 });
 // annota sopra e verifica che il tratto si salvi sulla pagina importata
 await page.evaluate(()=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+300,clientY:r.top+300,pressure:0.5,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',0,0,1));
   const ev2=(x,y)=>new PointerEvent('pointermove',{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:0.6,buttons:1,bubbles:true});
   stage.dispatchEvent(ev2(400,320));
   stage.dispatchEvent(ev2(500,340));
   stage.dispatchEvent(new PointerEvent('pointerup',{pointerId:7,pointerType:'pen',clientX:r.left+500,clientY:r.top+340,pressure:0,buttons:0,bubbles:true}));
 });
 await page.waitForTimeout(900);
 const saved = await page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pages=this.result.sort((a,b)=>a.index-b.index);
     res({n:pages.length, imgs:pages.map(p=>p.strokes.filter(s=>s.tool==='image').length), strokes:pages.map(p=>p.strokes.length)});
   };};
 }));
 console.log('pager:', pager, '| pixel sfondo:', bluish, '| pagine:', JSON.stringify(saved));
 await page.screenshot({path: path.join(__dirname,'shot-pdf.png')});
 const ok = pager==='2 / 3' && bluish>200 && saved.n===3 && saved.imgs[1]===1 && saved.imgs[2]===1 && saved.strokes[1]===2 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS pdf-import':'FAIL pdf-import');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
