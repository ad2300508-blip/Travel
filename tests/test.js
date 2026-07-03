// Test end-to-end: serve l'app, simula tratti di penna con pressione,
// gomma, undo/redo, persistenza IndexedDB, zoom, pagine, export.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

function penStroke(page, pts) {
  // Dispatch di PointerEvent sintetici tipo "pen" con pressione, dentro la pagina.
  return page.evaluate(pts => {
    const stage = document.getElementById('stage');
    const r = stage.getBoundingClientRect();
    const ev = (type, x, y, pressure, buttons) => new PointerEvent(type, {
      pointerId: 7, pointerType: 'pen', isPrimary: true,
      clientX: r.left + x, clientY: r.top + y,
      pressure, buttons, bubbles: true, cancelable: true,
    });
    stage.dispatchEvent(ev('pointerdown', pts[0][0], pts[0][1], pts[0][2], 1));
    for (let i = 1; i < pts.length; i++)
      stage.dispatchEvent(ev('pointermove', pts[i][0], pts[i][1], pts[i][2], 1));
    const last = pts[pts.length - 1];
    stage.dispatchEvent(ev('pointerup', last[0], last[1], 0, 0));
  }, pts);
}

(async () => {
  await new Promise(r => server.listen(9301, r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

 await page.addInitScript(()=>localStorage.setItem('inchiostro-prefs', JSON.stringify({welcomed:true})));
  await page.goto('http://localhost:9301/');
  await page.waitForTimeout(600);

  const results = [];
  const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

  // 1. bootstrap: quaderno e pagina creati
  const boot = await page.evaluate(() => ({
    title: document.getElementById('notebook-title').textContent,
    pager: document.getElementById('page-label').textContent,
  }));
  check('bootstrap quaderno', boot.title === 'Il mio quaderno' && boot.pager === '1 / 1', JSON.stringify(boot));

  // 2. tratto di penna con pressione variabile
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([200 + i * 8, 300 + Math.sin(i / 5) * 60, 0.2 + 0.6 * (i / 40)]);
  await penStroke(page, pts);
  await page.waitForTimeout(100);
  let n = await page.evaluate(() => window.__strokes?.() ?? -1);
  // esponi lo stato per i test
  await page.evaluate(() => {}); // no-op
  const strokeCount = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      const db = req.result;
      db.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.map(p => p.strokes.length));
      };
    };
  }));
  await page.waitForTimeout(800); // attesa autosave
  const savedCount = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('tratto salvato su IndexedDB', savedCount === 1, `strokes=${savedCount}`);

  // 3. pixel disegnati sul canvas base
  const inkPixels = await page.evaluate(() => {
    const cv = document.getElementById('base');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 0; i < d.length; i += 40) {
      if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) painted++;
    }
    return painted;
  });
  check('inchiostro visibile sul canvas', inkPixels > 50, `pixels=${inkPixels}`);

  // 4. undo rimuove il tratto
  await page.click('#btn-undo');
  await page.waitForTimeout(700);
  const afterUndo = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('undo', afterUndo === 0, `strokes=${afterUndo}`);

  // 5. redo lo ripristina
  await page.click('#btn-redo');
  await page.waitForTimeout(700);
  const afterRedo = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('redo', afterRedo === 1, `strokes=${afterRedo}`);

  // 6. gomma: seleziona lo strumento e passa sopra il tratto
  await page.click('[data-tool="eraser"]');
  await penStroke(page, [[200, 300, 0.5], [280, 310, 0.5], [360, 290, 0.5]]);
  await page.waitForTimeout(700);
  const afterErase = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('gomma cancella il tratto', afterErase === 0, `strokes=${afterErase}`);

  // 7. pulsante laterale S Pen (buttons=2) come gomma temporanea
  await page.click('[data-tool="fountain"]');
  await penStroke(page, [[500, 500, 0.5], [560, 510, 0.6], [620, 500, 0.7]]);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const r = stage.getBoundingClientRect();
    const ev = (type, x, y, buttons) => new PointerEvent(type, {
      pointerId: 9, pointerType: 'pen', clientX: r.left + x, clientY: r.top + y,
      pressure: 0.5, buttons, bubbles: true, cancelable: true,
    });
    stage.dispatchEvent(ev('pointerdown', 500, 500, 3)); // contatto + barrel
    stage.dispatchEvent(ev('pointermove', 620, 505, 3));
    stage.dispatchEvent(ev('pointerup', 620, 505, 0));
  });
  await page.waitForTimeout(700);
  const afterBarrel = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('pulsante S Pen = gomma', afterBarrel === 0, `strokes=${afterBarrel}`);

  // 8. palm rejection: un tocco durante la scrittura non disegna
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const r = stage.getBoundingClientRect();
    const pev = (type, id, ptype, x, y, buttons) => new PointerEvent(type, {
      pointerId: id, pointerType: ptype, clientX: r.left + x, clientY: r.top + y,
      pressure: buttons ? 0.5 : 0, buttons, bubbles: true, cancelable: true,
    });
    stage.dispatchEvent(pev('pointerdown', 11, 'pen', 100, 600, 1));
    stage.dispatchEvent(pev('pointerdown', 12, 'touch', 300, 650, 1)); // palmo
    stage.dispatchEvent(pev('pointermove', 11, 'pen', 200, 600, 1));
    stage.dispatchEvent(pev('pointermove', 12, 'touch', 400, 650, 1));
    stage.dispatchEvent(pev('pointerup', 11, 'pen', 200, 600, 0));
    stage.dispatchEvent(pev('pointerup', 12, 'touch', 400, 650, 0));
  });
  await page.waitForTimeout(700);
  const afterPalm = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('palm rejection (1 tratto penna, palmo ignorato)', afterPalm === 1, `strokes=${afterPalm}`);

  // 9. pinch a due dita: zoom cambia
  const zoomBefore = await page.evaluate(() => document.getElementById('zoom-badge').textContent);
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const r = stage.getBoundingClientRect();
    const pev = (type, id, x, y, buttons) => new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y,
      pressure: buttons ? 0.5 : 0, buttons, bubbles: true, cancelable: true,
    });
    stage.dispatchEvent(pev('pointerdown', 21, 500, 400, 1));
    stage.dispatchEvent(pev('pointerdown', 22, 700, 400, 1));
    stage.dispatchEvent(pev('pointermove', 21, 400, 400, 1));
    stage.dispatchEvent(pev('pointermove', 22, 800, 400, 1));
    stage.dispatchEvent(pev('pointerup', 21, 400, 400, 0));
    stage.dispatchEvent(pev('pointerup', 22, 800, 400, 0));
  });
  const zoom = await page.evaluate(() => document.getElementById('zoom-badge').textContent);
  check('pinch zoom', zoom === '200%', `badge=${zoom}`);

  // 10. nuova pagina + navigazione
  await page.click('#btn-addpage');
  await page.waitForTimeout(300);
  const pager2 = await page.evaluate(() => document.getElementById('page-label').textContent);
  check('nuova pagina', pager2 === '2 / 2', pager2);
  await page.click('#btn-prev');
  await page.waitForTimeout(300);
  const pager3 = await page.evaluate(() => document.getElementById('page-label').textContent);
  check('pagina precedente', pager3 === '1 / 2', pager3);

  // 10b. lazo: seleziona, sposta, duplica, elimina, undo
  await page.click('[data-tool="fountain"]');
  await penStroke(page, [[400, 400, 0.5], [450, 410, 0.6], [500, 400, 0.5]]);
  await page.waitForTimeout(100);
  await page.click('[data-tool="lasso"]');
  // lazo attorno al tratto
  await penStroke(page, [[350, 350, 0.5], [560, 350, 0.5], [560, 460, 0.5], [350, 460, 0.5]]);
  await page.waitForTimeout(100);
  const selVisible = await page.evaluate(() => !document.getElementById('selbar').hidden);
  check('lazo seleziona (barra visibile)', selVisible);
  // sposta la selezione di +100,+50
  await penStroke(page, [[450, 405, 0.5], [500, 430, 0.5], [550, 455, 0.5]]);
  await page.waitForTimeout(700);
  const movedPt = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        const pg = this.result.find(p => p.strokes.length);
        res(pg ? pg.strokes[pg.strokes.length - 1].points[0] : null);
      };
    };
  }));
  check('lazo sposta il tratto', movedPt && Math.abs(movedPt[0] - 500) < 2 && Math.abs(movedPt[1] - 450) < 2,
    JSON.stringify(movedPt));
  // duplica
  await page.click('#sel-duplicate');
  await page.waitForTimeout(700);
  const afterDup = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('duplica selezione', afterDup === 3, `strokes=${afterDup}`); // 2 + tratto del test palm-rejection
  // elimina la selezione (il duplicato)
  await page.click('#sel-delete');
  await page.waitForTimeout(700);
  const afterDel = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  check('elimina selezione', afterDel === 2, `strokes=${afterDel}`);
  // undo x3: elimina, duplica, move -> il tratto torna alla posizione iniziale
  await page.click('#btn-undo'); await page.click('#btn-undo'); await page.click('#btn-undo');
  await page.waitForTimeout(700);
  const backPt = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        const pg = this.result.find(p => p.strokes.length);
        res(pg ? [pg.strokes.length, pg.strokes[pg.strokes.length - 1].points[0]] : null);
      };
    };
  }));
  check('undo move/duplica/elimina', backPt && backPt[0] === 2 && Math.abs(backPt[1][0] - 400) < 2 && Math.abs(backPt[1][1] - 400) < 2,
    JSON.stringify(backPt));
  // pulizia: cancella il tratto per non sporcare i test successivi
  await page.click('[data-tool="eraser"]');
  await penStroke(page, [[395, 395, 0.5], [450, 410, 0.5], [505, 405, 0.5]]);
  await page.click('[data-tool="fountain"]');
  await page.waitForTimeout(700);

  // 11. persistenza: reload e il tratto c'è ancora
  await page.reload();
  await page.waitForTimeout(600);
  const afterReload = await page.evaluate(() => new Promise(res => {
    const req = indexedDB.open('inchiostro');
    req.onsuccess = () => {
      req.result.transaction('pages').objectStore('pages').getAll().onsuccess = function () {
        res(this.result.reduce((a, p) => a + p.strokes.length, 0));
      };
    };
  }));
  const pagerReload = await page.evaluate(() => document.getElementById('page-label').textContent);
  check('persistenza dopo reload', afterReload === 1 && pagerReload === '1 / 2', `strokes=${afterReload} pager=${pagerReload}`);

  // 12. tema scuro
  await page.click('#btn-settings');
  await page.selectOption('#opt-theme', 'dark');
  await page.waitForTimeout(200);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  check('tema scuro', theme === 'dark', theme);

  // 13. service worker registrato
  const sw = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length;
  });
  check('service worker', sw >= 1, `regs=${sw}`);

  // screenshot finali
  await page.screenshot({ path: require('path').join(__dirname, 'shot-dark.png') });
  await page.selectOption('#opt-theme', 'light');
  await page.click('#scrim'); // chiudi pannello
  await page.waitForTimeout(200);
  // ridisegna qualcosa di carino per lo screenshot chiaro
  await page.click('[data-tool="fountain"]');
  await page.screenshot({ path: require('path').join(__dirname, 'shot-light.png') });

  console.log(results.join('\n'));
  console.log(errors.length ? '\nERRORI JS:\n' + errors.join('\n') : '\nNessun errore JS.');
  await browser.close();
  server.close();
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})();
