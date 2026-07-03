const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{let p=req.url.split('?')[0]; if(p==='/')p='/index.html';
try{res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(path.join(ROOT,p)));}catch{res.writeHead(404);res.end();}});

(async()=>{
 await new Promise(r=>server.listen(9305,r));
 const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
 const page = await browser.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
 await page.goto('http://localhost:9305/'); await page.waitForTimeout(500);

 // disegna e tiene ferma la penna 800ms prima del rilascio
 async function strokeAndHold(pts){
   await page.evaluate(pts=>{
     const stage=document.getElementById('stage'); const r=stage.getBoundingClientRect();
     window.__ev=(t,x,y,p,b)=>new PointerEvent(t,{pointerId:7,pointerType:'pen',clientX:r.left+x,clientY:r.top+y,pressure:p,buttons:b,bubbles:true});
     stage.dispatchEvent(window.__ev('pointerdown',pts[0][0],pts[0][1],0.5,1));
     for(let i=1;i<pts.length;i++) stage.dispatchEvent(window.__ev('pointermove',pts[i][0],pts[i][1],0.5,1));
   },pts);
   await page.waitForTimeout(820); // penna ferma
   await page.evaluate(pts=>{
     const stage=document.getElementById('stage');
     const l=pts[pts.length-1];
     stage.dispatchEvent(window.__ev('pointerup',l[0],l[1],0,0));
   },pts);
   await page.waitForTimeout(750);
 }
 const lastStroke = () => page.evaluate(()=>new Promise(res=>{
   const req=indexedDB.open('inchiostro');
   req.onsuccess=()=>{req.result.transaction('pages').objectStore('pages').getAll().onsuccess=function(){
     const pg=this.result.find(p=>p.strokes.length); if(!pg){res(null);return;}
     const s=pg.strokes[pg.strokes.length-1]; res({n:s.points.length, pts:s.points});
   };};
 }));

 // 1. linea storta orizzontale -> 2 punti, agganciata a 0°
 const wob=[]; for(let i=0;i<=50;i++) wob.push([150+i*7, 250+Math.sin(i/3)*4+i*0.15]);
 await strokeAndHold(wob);
 const line = await lastStroke();
 const lineOK = line && line.n===2 && Math.abs(line.pts[0][1]-line.pts[1][1])<0.5;
 console.log('linea:', line && line.n, 'punti, snap 0°:', lineOK ? 'sì':'no');

 // 2. cerchio approssimativo -> 49 punti su ellisse
 const circ=[]; for(let i=0;i<=70;i++){const a=i/70*Math.PI*2; circ.push([500+Math.cos(a)*(100+Math.sin(i)*5), 500+Math.sin(a)*(98+Math.cos(i)*5)]);}
 await strokeAndHold(circ);
 const ell = await lastStroke();
 const ellOK = ell && ell.n===49;
 console.log('ellisse:', ell && ell.n, 'punti:', ellOK?'sì':'no');

 // 3. rettangolo -> 5 punti
 const rect=[];
 for(let i=0;i<=20;i++) rect.push([800+i*10, 300+Math.sin(i)*3]);
 for(let i=0;i<=12;i++) rect.push([1000+Math.sin(i)*3, 300+i*10]);
 for(let i=0;i<=20;i++) rect.push([1000-i*10, 420+Math.sin(i)*3]);
 for(let i=0;i<=12;i++) rect.push([800+Math.sin(i)*3, 420-i*10]);
 await strokeAndHold(rect);
 const rc = await lastStroke();
 const rectOK = rc && rc.n===5;
 console.log('rettangolo:', rc && rc.n, 'punti:', rectOK?'sì':'no');

 // 4. scarabocchio -> NON convertito (resta com'è)
 const scr=[]; for(let i=0;i<=60;i++) scr.push([300+i*4+Math.sin(i/2)*40, 700+Math.cos(i/1.7)*50]);
 await strokeAndHold(scr);
 const sc = await lastStroke();
 const scrOK = sc && sc.n>30;
 console.log('scarabocchio non convertito:', sc && sc.n, 'punti:', scrOK?'sì':'no');

 // 5. con opzione disattivata la linea resta a mano
 await page.click('#btn-settings'); await page.click('#opt-shapes'); await page.click('#scrim');
 await page.waitForTimeout(150);
 await strokeAndHold(wob.map(p=>[p[0],p[1]+300]));
 const off = await lastStroke();
 const offOK = off && off.n>30;
 console.log('opzione off, niente forma:', off && off.n, 'punti:', offOK?'sì':'no');


 // 6. triangolo -> 4 punti (3 vertici + chiusura)
 await page.click('#btn-settings'); await page.click('#opt-shapes'); await page.click('#scrim'); // riattiva
 await page.waitForTimeout(150);
 const tri=[];
 for(let i=0;i<=20;i++) tri.push([600+i*8, 620-i*6+Math.sin(i)*3]);      // sale
 for(let i=0;i<=20;i++) tri.push([760+i*8, 500+i*6+Math.sin(i)*3]);      // scende
 for(let i=0;i<=32;i++) tri.push([920-i*10, 620+Math.sin(i)*3]);         // base
 await strokeAndHold(tri);
 const tr = await lastStroke();
 const triOK = tr && tr.n===4;
 console.log('triangolo:', tr && tr.n, 'punti:', triOK?'sì':'no');

 const ok = lineOK && ellOK && rectOK && scrOK && offOK && triOK && !errors.length;
 console.log(errors.length?('ERRORI: '+errors.join(' | ')):'', ok?'PASS forme':'FAIL forme');
 await browser.close(); server.close(); process.exit(ok?0:1);
})();
