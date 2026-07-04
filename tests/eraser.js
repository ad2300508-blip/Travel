const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(9313,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true, eraserMode:'partial'})));
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:9313/'); await page.waitForTimeout(500);
 const pen=(pts)=>page.evaluate(pts=>{
   const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
   const ev=(t,x,y,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:0.5,buttons:b,bubbles:true});
   stage.dispatchEvent(ev('pointerdown',pts[0][0],pts[0][1],1));
   for(let i=1;i<pts.length;i++) stage.dispatchEvent(ev('pointermove',pts[i][0],pts[i][1],1));
   const l=pts[pts.length-1]; stage.dispatchEvent(ev('pointerup',l[0],l[1],0));
 },pts);
 const dump=()=>page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length)||{strokes:[]};
     res(pg.strokes.map(s=>[s.points.length, s.points[0][0], s.points[s.points.length-1][0]]));
   };};
 }));
 // tratto lungo denso da 200 a 800
 const line=[]; for(let i=0;i<=120;i++) line.push([200+i*5,400]);
 await pen(line);
 await page.waitForTimeout(200);
 // gomma parziale al centro (~500)
 await page.click('[data-tool="eraser"]');
 await pen([[500,395],[500,400],[500,405]]);
 await page.waitForTimeout(800);
 const after = await dump();
 console.log('dopo gomma parziale:', JSON.stringify(after));
 const twoParts = after.length===2 && after[0][2]<500 && after[1][1]>500;
 // undo -> tratto intero di nuovo
 await page.keyboard.press('Control+z'); await page.waitForTimeout(700);
 const undone = await dump();
 // redo -> di nuovo 2
 await page.keyboard.press('Control+y'); await page.waitForTimeout(700);
 const redone = await dump();
 console.log('undo:', JSON.stringify(undone), '| redo:', redone.length, 'tratti');
 const ok = twoParts && undone.length===1 && undone[0][0]>=120 && redone.length===2 && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS gomma-parziale':'FAIL gomma-parziale');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
