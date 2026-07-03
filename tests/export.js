const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9304,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const ctx = await browser.newContext({acceptDownloads:true});
 const page = await ctx.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 await page.goto('http://localhost:9304/'); await page.waitForTimeout(500);
 // disegna su pagina 1, crea pagina 2 e disegna
 const draw = (x0,y0) => page.evaluate(({x0,y0})=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,p,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:p,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',x0,y0,0.4,1));
   for(let i=1;i<=30;i++) stage.dispatchEvent(ev('pointermove',x0+i*8,y0+Math.sin(i/3)*30,0.3+0.5*i/30,1));
   stage.dispatchEvent(ev('pointerup',x0+240,y0,0,0));
 },{x0,y0});
 await draw(150,300);
 await page.click('#btn-addpage'); await page.waitForTimeout(300);
 await draw(200,400);
 await page.waitForTimeout(800);
 // PDF
 await page.click('#btn-settings');
 const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-exportpdf')]);
 const pdfPath = path.join(__dirname,'out.pdf');
 await dl.saveAs(pdfPath);
 const pdf = fs.readFileSync(pdfPath);
 const head = pdf.slice(0,8).toString('latin1');
 const hasEOF = pdf.slice(-20).toString('latin1').includes('%%EOF');
 const pageCount = (pdf.toString('latin1').match(/\/Type \/Page /g)||[]).length;
 console.log('pdf:', pdf.length, 'bytes, header', JSON.stringify(head), 'EOF', hasEOF, 'pagine', pageCount);
 // backup
 await page.click('#btn-settings');
 const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-backup')]);
 const bakPath = path.join(__dirname,'backup.json');
 await dl2.saveAs(bakPath);
 const bak = JSON.parse(fs.readFileSync(bakPath,'utf8'));
 const strokesInBak = bak.notebooks.reduce((a,nb)=>a+nb.pages.reduce((b,p)=>b+p.strokes.length,0),0);
 console.log('backup: quaderni', bak.notebooks.length, 'tratti', strokesInBak);
 // import del backup (id già presenti -> copia)
 await page.click('#btn-settings');
 const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-restore')]);
 await chooser.setFiles(bakPath);
 await page.waitForTimeout(800);
 await page.click('#btn-menu'); await page.waitForTimeout(300);
 const nbCount = await page.evaluate(()=>document.querySelectorAll('#notebook-list li').length);
 console.log('quaderni dopo import:', nbCount);
 const ok = head.startsWith('%PDF-1.4') && hasEOF && pageCount===2
   && bak.notebooks.length===1 && strokesInBak===2 && nbCount===2 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS export':'FAIL export');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
