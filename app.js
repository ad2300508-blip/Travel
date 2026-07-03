// Inchiostro — note a mano ottimizzate per Galaxy Tab S10 Ultra.
//
// Sfrutta al massimo l'hardware del tablet:
//  - canvas "desynchronized" per latenza minima della S Pen
//  - getCoalescedEvents(): tutti i campioni della S Pen (fino a 360 Hz), non solo 60/120
//  - getPredictedEvents(): coda del tratto predetta, l'inchiostro "insegue" la punta
//  - pressione (4096 livelli) e inclinazione della S Pen per tratti naturali
//  - hover della S Pen: anteprima del pennello prima di toccare
//  - pulsante laterale della S Pen come gomma temporanea
//  - palm rejection: il tocco delle dita fa pan/zoom, solo la penna scrive
//  - tema scuro AMOLED a nero puro

import { store, uid } from './store.js';
import { buildPdf, A4W, A4H } from './pdf.js';

/* ================================ Stato ================================ */

const PALETTE = [
  '#1c1b1a', '#2f6fed', '#d62839', '#1f9d55',
  '#f2a007', '#8b5cf6', '#e2517a', '#7a5c3e',
];

const TOOLS = {
  fountain:    { size: 4,  pressure: true,  tilt: true  },
  pen:         { size: 3.5, pressure: true, tilt: false },
  pencil:      { size: 5,  pressure: true,  tilt: true  },
  highlighter: { size: 14, pressure: false, tilt: false },
  eraser:      { size: 18, pressure: false, tilt: false },
  lasso:       { size: 4,  pressure: false, tilt: false },
};

const state = {
  tool: 'fountain',
  color: PALETTE[0],
  size: 4,
  view: { x: 0, y: 0, scale: 1 },
  notebook: null,
  pages: [],          // metadati pagine del quaderno corrente (ordinati)
  page: null,         // pagina corrente { id, notebookId, index, template, strokes }
  undoStack: [],
  redoStack: [],
  dirty: false,
};

const prefs = loadPrefs();

function loadPrefs() {
  try { return Object.assign({
    theme: 'auto', touchDraw: false, barrelEraser: true, autoShapes: true,
    lastNotebook: null, lastPage: null, color: PALETTE[0], sizes: {},
  }, JSON.parse(localStorage.getItem('inchiostro-prefs') || '{}')); }
  catch { return { theme: 'auto', touchDraw: false, barrelEraser: true, autoShapes: true, sizes: {} }; }
}
function savePrefs() { localStorage.setItem('inchiostro-prefs', JSON.stringify(prefs)); }

/* ================================ DOM ================================ */

const $ = sel => document.querySelector(sel);
const stage = $('#stage');
const baseCv = $('#base'), inkCv = $('#ink'), prevCv = $('#preview');
const baseCtx = baseCv.getContext('2d');
// Il layer del tratto in corso è quello critico per la latenza: desynchronized
// permette al compositor Android di saltare la coda di vsync.
const inkCtx = inkCv.getContext('2d', { desynchronized: true });
const prevCtx = prevCv.getContext('2d', { desynchronized: true });

let dpr = Math.min(window.devicePixelRatio || 1, 3);
let stageW = 0, stageH = 0;

/* ============================ Tema e colori ============================ */

function paperColor() {
  if (exportMode) return '#ffffff';
  return getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#fffdf8';
}
function lineColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#e3e0d8';
}

function applyTheme() {
  const t = prefs.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : prefs.theme;
  document.documentElement.dataset.theme = t;
  redrawBase();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ========================== Trasformazione vista ========================== */
// Coordinate pagina <-> schermo (CSS px). screen = (page - view.xy) * scale

const toScreenX = x => (x - state.view.x) * state.view.scale;
const toScreenY = y => (y - state.view.y) * state.view.scale;
const toPageX = sx => sx / state.view.scale + state.view.x;
const toPageY = sy => sy / state.view.scale + state.view.y;

function setCanvasTransform(ctx) {
  const s = dpr * state.view.scale;
  ctx.setTransform(s, 0, 0, s, -state.view.x * s, -state.view.y * s);
}

/* ============================== Rendering ============================== */

function resize() {
  const r = stage.getBoundingClientRect();
  stageRect = r;
  stageW = Math.max(1, Math.round(r.width));
  stageH = Math.max(1, Math.round(r.height));
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  for (const cv of [baseCv, inkCv, prevCv]) {
    cv.width = stageW * dpr;
    cv.height = stageH * dpr;
  }
  redrawBase();
}

function clearCanvas(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function drawTemplate(ctx) {
  const tpl = state.page?.template || 'blank';
  if (tpl === 'blank') return;
  const step = 32; // unità pagina
  const x0 = Math.floor(toPageX(0) / step) * step;
  const y0 = Math.floor(toPageY(0) / step) * step;
  const x1 = toPageX(stageW), y1 = toPageY(stageH);
  ctx.strokeStyle = ctx.fillStyle = lineColor();
  ctx.lineWidth = 1 / state.view.scale;
  if (tpl === 'lines') {
    ctx.beginPath();
    for (let y = y0; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  } else if (tpl === 'grid') {
    ctx.beginPath();
    for (let y = y0; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    for (let x = x0; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
  } else if (tpl === 'dots') {
    const r = 1.5 / Math.sqrt(state.view.scale);
    ctx.beginPath();
    for (let y = y0; y <= y1; y += step)
      for (let x = x0; x <= x1; x += step) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.fill();
  }
}

// Larghezza del tratto (unità pagina) per un campione [x, y, pressione, tilt]
function widthAt(tool, size, p, tilt) {
  switch (tool) {
    case 'fountain':  return size * (0.22 + 1.15 * Math.pow(p, 1.4)) * (1 + 0.35 * tilt);
    case 'pen':       return size * (0.75 + 0.35 * p);
    case 'pencil':    return size * (0.5 + 0.5 * p) * (1 + 1.6 * tilt);
    case 'highlighter': return size * 2.2;
    default:          return size;
  }
}

// L'inchiostro "nero" di default è adattivo: su carta scura diventa chiaro,
// così le note restano leggibili in entrambi i temi.
let exportMode = false; // durante l'export l'inchiostro resta scuro
function displayColor(c) {
  if (!exportMode && c === PALETTE[0] && document.documentElement.dataset.theme === 'dark') return '#ecebe8';
  return c;
}

// La matita non usa trasparenza (i segmenti sovrapposti farebbero "perline"):
// schiarisce il colore verso la carta in base alla pressione, stesso effetto visivo.
function pencilColor(color, p, tilt) {
  const t = Math.min(1, 0.35 + 0.65 * p - 0.25 * tilt);
  return mixColors(paperColor(), displayColor(color), t);
}

function mixColors(c1, c2, t) {
  const a = parseColor(c1), b = parseColor(c2);
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}
const colorCache = {};
function parseColor(c) {
  if (colorCache[c]) return colorCache[c];
  const cv = parseColor.cv || (parseColor.cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true }));
  cv.fillStyle = c; cv.fillRect(0, 0, 1, 1);
  const d = cv.getImageData(0, 0, 1, 1).data;
  return (colorCache[c] = [d[0], d[1], d[2]]);
}

/* ----------------------------- Immagini ----------------------------- */
// Un'immagine è un "tratto" con tool:'image': points = 4 angoli, data = dataURL.

const imageCache = new Map(); // dataURL -> { img, loaded }

function imageFor(s) {
  let entry = imageCache.get(s.data);
  if (!entry) {
    const img = new Image();
    entry = { img, loaded: false };
    imageCache.set(s.data, entry);
    img.onload = () => { entry.loaded = true; redrawBase(); };
    img.src = s.data;
  }
  return entry;
}

async function ensureImagesLoaded(pg) {
  const waits = [];
  for (const s of pg.strokes) {
    if (s.tool !== 'image') continue;
    const entry = imageFor(s);
    if (!entry.loaded) waits.push(entry.img.decode().then(() => { entry.loaded = true; }).catch(() => {}));
  }
  await Promise.all(waits);
}

function drawImageStroke(ctx, s) {
  const [a, , c] = [s.points[0], s.points[1], s.points[2]];
  const w = c[0] - a[0], h = c[1] - a[1];
  const entry = imageFor(s);
  if (entry.loaded) {
    ctx.drawImage(entry.img, a[0], a[1], w, h);
  } else {
    ctx.fillStyle = 'rgba(128,128,128,.15)';
    ctx.fillRect(a[0], a[1], w, h);
  }
}

// Disegna un tratto completo (coordinate pagina; il ctx ha già la trasformazione).
function drawStroke(ctx, s) {
  if (s.tool === 'image') { drawImageStroke(ctx, s); return; }
  const pts = s.points;
  if (!pts.length) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = displayColor(s.color);
    ctx.lineWidth = widthAt('highlighter', s.size, 1, 0);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2, my = (pts[i - 1][1] + pts[i][1]) / 2;
      ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  if (pts.length === 1) {
    const [x, y, p, tl] = pts[0];
    ctx.fillStyle = s.tool === 'pencil' ? pencilColor(s.color, p, tl) : displayColor(s.color);
    ctx.beginPath();
    ctx.arc(x, y, widthAt(s.tool, s.size, p, tl) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) drawSegment(ctx, s, pts[i - 1], pts[i]);
}

function drawSegment(ctx, s, a, b) {
  const p = (a[2] + b[2]) / 2, tl = (a[3] + b[3]) / 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = s.tool === 'pencil' ? pencilColor(s.color, p, tl) : displayColor(s.color);
  ctx.lineWidth = Math.max(0.3, widthAt(s.tool, s.size, p, tl));
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function redrawBase(exclude) {
  clearCanvas(baseCtx);
  baseCtx.fillStyle = paperColor();
  baseCtx.fillRect(0, 0, baseCv.width, baseCv.height);
  setCanvasTransform(baseCtx);
  drawTemplate(baseCtx);
  if (state.page) {
    for (const s of state.page.strokes) {
      if (exclude?.has(s)) continue;
      drawStroke(baseCtx, s);
    }
  }
  if (selection && !exclude) updateSelectionUI();
}

/* =========================== Tratto in corso =========================== */

let live = null; // { stroke, erasing, pointerId }

function beginStroke(e, erasing) {
  const tool = erasing ? 'eraser' : state.tool;
  live = {
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    mode: 'ink',
    erasing: erasing || state.tool === 'eraser',
    stroke: { tool, color: state.color, size: state.size, points: [] },
    erased: [], // [indice, tratto] rimossi durante questa gomma
  };
  clearCanvas(inkCtx);
  setCanvasTransform(inkCtx);
  addSamples(e);
}

function samplePoint(ev) {
  let p = ev.pressure;
  if ((p === 0 || p === undefined) && ev.buttons) p = 0.5; // mouse / fallback
  const tilt = Math.min(1, Math.hypot(ev.tiltX || 0, ev.tiltY || 0) / 64);
  return [
    Math.round(toPageX(ev.clientX - stageRect.left) * 100) / 100,
    Math.round(toPageY(ev.clientY - stageRect.top) * 100) / 100,
    Math.round(p * 1000) / 1000,
    Math.round(tilt * 100) / 100,
  ];
}

function addSamples(e) {
  if (live.frozen) return; // il tratto è già stato convertito in forma
  // getCoalescedEvents può restituire [] (eventi sintetici o senza coalescing)
  const coalesced = e.getCoalescedEvents?.();
  const events = coalesced?.length ? coalesced : [e];
  const pts = live.stroke.points;
  let added = false;
  for (const ev of events) {
    const pt = samplePoint(ev);
    const last = pts[pts.length - 1];
    if (last && Math.abs(last[0] - pt[0]) < 0.05 && Math.abs(last[1] - pt[1]) < 0.05) {
      last[2] = Math.max(last[2], pt[2]); // stesso punto: tieni la pressione max
      continue;
    }
    pts.push(pt);
    added = true;
    if (live.erasing) {
      eraseAt(pt[0], pt[1]);
    } else if (live.stroke.tool !== 'highlighter') {
      if (last) drawSegment(inkCtx, live.stroke, last, pt);
      else drawStroke(inkCtx, live.stroke); // primo punto
    }
  }
  if (added && live.stroke.tool === 'highlighter' && !live.erasing) {
    // trasparenza: ridisegna l'intero tratto per evitare giunture più scure
    clearCanvas(inkCtx);
    setCanvasTransform(inkCtx);
    drawStroke(inkCtx, live.stroke);
  }
  if (added && !live.erasing) armShapeTimer(e);
  drawPrediction(e);
}

/* ------------------- Forme automatiche (tieni ferma la penna) ------------------- */

function armShapeTimer(e) {
  if (!prefs.autoShapes) return;
  const x = e.clientX, y = e.clientY;
  const sig = live.lastSig;
  if (!sig || Math.hypot(x - sig.x, y - sig.y) > 6) {
    live.lastSig = { x, y };
    clearTimeout(live.shapeTimer);
    live.shapeTimer = setTimeout(tryShape, 650);
  }
}

function tryShape() {
  if (!live || live.mode !== 'ink' || live.erasing || live.frozen) return;
  const pts = live.stroke.points;
  if (pts.length < 8) return;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (L < 30) return;
  const shaped = fitLine(pts, L) || fitEllipse(pts, L) || fitRect(pts, L);
  if (!shaped) return;
  const p = Math.max(0.35, pts.reduce((a, q) => a + q[2], 0) / pts.length);
  live.stroke.points = shaped.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, p, 0]);
  live.frozen = true;
  clearCanvas(inkCtx);
  setCanvasTransform(inkCtx);
  drawStroke(inkCtx, live.stroke);
  clearCanvas(prevCtx);
  navigator.vibrate?.(12);
}

// Linea: i punti stanno vicini alla corda primo→ultimo (angolo agganciato a 45°).
function fitLine(pts, L) {
  const a = pts[0], b = pts[pts.length - 1];
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (chord < 0.85 * L) return null;
  const tol = Math.max(5, 0.045 * L);
  for (const p of pts) {
    if (Math.sqrt(segDist2(p[0], p[1], a, b)) > tol) return null;
  }
  // aggancia l'angolo ai multipli di 45° se è vicino
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) < 0.09) ang = snapped;
  return [[a[0], a[1]], [a[0] + chord * Math.cos(ang), a[1] + chord * Math.sin(ang)]];
}

function shapeBounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function isClosed(pts, L) {
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.18 * L;
}

// Ellisse/cerchio: raggio normalizzato ~1 per tutti i punti.
function fitEllipse(pts, L) {
  if (!isClosed(pts, L)) return null;
  const b = shapeBounds(pts);
  if (b.w < 24 || b.h < 24) return null;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const rx = b.w / 2, ry = b.h / 2;
  let err = 0;
  for (const p of pts) {
    const q = ((p[0] - cx) / rx) ** 2 + ((p[1] - cy) / ry) ** 2;
    err += Math.abs(q - 1);
  }
  if (err / pts.length > 0.24) return null;
  const out = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48 * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

// Rettangolo: percorso chiuso col perimetro simile a quello del riquadro.
function fitRect(pts, L) {
  if (!isClosed(pts, L)) return null;
  const b = shapeBounds(pts);
  if (b.w < 24 || b.h < 24) return null;
  const per = 2 * (b.w + b.h);
  if (Math.abs(L - per) > 0.2 * per) return null;
  // i punti devono stare vicino al bordo del riquadro (non a metà)
  const tol = 0.22 * Math.min(b.w, b.h);
  for (const p of pts) {
    const dEdge = Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.y0, b.y1 - p[1]);
    if (dEdge > tol) return null;
  }
  return [
    [b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0],
  ];
}

// Coda predetta del tratto: disegnata su un layer a parte, ripulita a ogni frame.
function drawPrediction(e) {
  clearCanvas(prevCtx);
  if (live.erasing) { drawEraserCursor(e); return; }
  const predicted = e.getPredictedEvents?.() ?? [];
  if (!predicted.length) return;
  setCanvasTransform(prevCtx);
  prevCtx.globalAlpha = live.stroke.tool === 'highlighter' ? 0.3 : 0.85;
  let prev = live.stroke.points[live.stroke.points.length - 1];
  for (const ev of predicted.slice(0, 4)) {
    const pt = samplePoint(ev);
    drawSegment(prevCtx, live.stroke, prev, pt);
    prev = pt;
  }
  prevCtx.globalAlpha = 1;
}

function drawEraserCursor(e) {
  clearCanvas(prevCtx);
  const x = e.clientX - stageRect.left, y = e.clientY - stageRect.top;
  const r = eraserRadius() * state.view.scale;
  prevCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  prevCtx.strokeStyle = 'rgba(128,128,128,.8)';
  prevCtx.lineWidth = 1.5;
  prevCtx.beginPath();
  prevCtx.arc(x, y, r, 0, Math.PI * 2);
  prevCtx.stroke();
}

function endStroke(commit) {
  if (!live) return;
  clearTimeout(live.shapeTimer);
  if (live.erasing) {
    if (live.erased.length) {
      pushUndo({ type: 'erase', removed: live.erased });
      markDirty();
    }
  } else if (commit && live.stroke.points.length) {
    state.page.strokes.push(live.stroke);
    pushUndo({ type: 'add' });
    setCanvasTransform(baseCtx);
    drawStroke(baseCtx, live.stroke);
    markDirty();
  }
  live = null;
  clearCanvas(inkCtx);
  clearCanvas(prevCtx);
}

/* ================================ Gomma ================================ */

function eraserRadius() { return Math.max(6, state.size * 2); } // unità pagina

function eraseAt(px, py) {
  const r = eraserRadius();
  const strokes = state.page.strokes;
  let removedAny = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (!strokeHit(s, px, py, r + s.size / 2)) continue;
    live.erased.push([i, s]);
    strokes.splice(i, 1);
    removedAny = true;
  }
  if (removedAny) redrawBase();
}

function strokeHit(s, px, py, r) {
  if (s.tool === 'image') return false; // le immagini si eliminano col lazo
  const pts = s.points;
  const r2 = r * r;
  if (pts.length === 1) {
    const dx = pts[0][0] - px, dy = pts[0][1] - py;
    return dx * dx + dy * dy <= r2;
  }
  for (let i = 1; i < pts.length; i++) {
    if (segDist2(px, py, pts[i - 1], pts[i]) <= r2) return true;
  }
  return false;
}

function segDist2(px, py, a, b) {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/* ========================= Lazo e selezione ========================= */

let selection = null; // { set: Set<stroke>, bbox: {x0,y0,x1,y1} }

function beginLasso(e) {
  clearSelection();
  live = { pointerId: e.pointerId, pointerType: e.pointerType, mode: 'lasso', pts: [] };
  lassoMove(e);
}

function lassoMove(e) {
  const pts = live.pts;
  pts.push([toPageX(e.clientX - stageRect.left), toPageY(e.clientY - stageRect.top)]);
  clearCanvas(prevCtx);
  setCanvasTransform(prevCtx);
  prevCtx.strokeStyle = accentColor();
  prevCtx.lineWidth = 1.5 / state.view.scale;
  prevCtx.setLineDash([6 / state.view.scale, 5 / state.view.scale]);
  prevCtx.beginPath();
  prevCtx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) prevCtx.lineTo(p[0], p[1]);
  prevCtx.closePath();
  prevCtx.stroke();
  prevCtx.setLineDash([]);
}

function endLasso(commit) {
  const poly = live.pts;
  live = null;
  clearCanvas(prevCtx);
  if (!commit || poly.length < 3) return;
  const picked = new Set();
  for (const s of state.page.strokes) {
    const pts = s.points;
    const step = Math.max(1, Math.floor(pts.length / 24)); // campiona per velocità
    let inside = 0, total = 0;
    for (let i = 0; i < pts.length; i += step) {
      total++;
      if (pointInPoly(pts[i][0], pts[i][1], poly)) inside++;
    }
    if (total && inside / total >= 0.5) picked.add(s);
  }
  if (!picked.size) { toast('Nessun tratto nel lazo'); return; }
  selection = { set: picked, bbox: bboxOf(picked) };
  updateSelectionUI();
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bboxOf(set) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of set) {
    const half = widthAt(s.tool, s.size, 1, 1) / 2;
    for (const p of s.points) {
      x0 = Math.min(x0, p[0] - half); y0 = Math.min(y0, p[1] - half);
      x1 = Math.max(x1, p[0] + half); y1 = Math.max(y1, p[1] + half);
    }
  }
  return { x0, y0, x1, y1 };
}

function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6fed';
}

function updateSelectionUI(dx = 0, dy = 0) {
  if (!selection) return;
  const b = selection.bbox;
  clearCanvas(prevCtx);
  prevCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  prevCtx.strokeStyle = accentColor();
  prevCtx.lineWidth = 1.5;
  prevCtx.setLineDash([7, 5]);
  const pad = 6;
  prevCtx.strokeRect(
    toScreenX(b.x0 + dx) - pad, toScreenY(b.y0 + dy) - pad,
    (b.x1 - b.x0) * state.view.scale + pad * 2, (b.y1 - b.y0) * state.view.scale + pad * 2);
  prevCtx.setLineDash([]);
  // maniglia di ridimensionamento nell'angolo in basso a destra
  prevCtx.fillStyle = accentColor();
  const hx = toScreenX(b.x1 + dx) + pad, hy = toScreenY(b.y1 + dy) + pad;
  prevCtx.fillRect(hx - 7, hy - 7, 14, 14);
  // barra azioni sopra la selezione
  const bar = $('#selbar');
  bar.hidden = dx !== 0 || dy !== 0; // nascosta durante lo spostamento
  if (!bar.hidden) {
    bar.style.left = clamp(toScreenX(b.x0), 8, stageW - 170) + 'px';
    bar.style.top = clamp(toScreenY(b.y0) - 52, 8, stageH - 50) + 'px';
  }
}

function clearSelection() {
  if (!selection) return;
  selection = null;
  $('#selbar').hidden = true;
  clearCanvas(prevCtx);
}

function inSelection(px, py) {
  if (!selection) return false;
  const m = 12 / state.view.scale, b = selection.bbox;
  return px >= b.x0 - m && px <= b.x1 + m && py >= b.y0 - m && py <= b.y1 + m;
}

function startSelMove(e) {
  live = {
    pointerId: e.pointerId, pointerType: e.pointerType, mode: 'movesel',
    x0: toPageX(e.clientX - stageRect.left), y0: toPageY(e.clientY - stageRect.top),
    dx: 0, dy: 0,
  };
  redrawBase(selection.set); // la base senza i tratti selezionati
}

function selMove(e) {
  live.dx = toPageX(e.clientX - stageRect.left) - live.x0;
  live.dy = toPageY(e.clientY - stageRect.top) - live.y0;
  clearCanvas(inkCtx);
  setCanvasTransform(inkCtx);
  inkCtx.save();
  inkCtx.translate(live.dx, live.dy);
  for (const s of selection.set) drawStroke(inkCtx, s);
  inkCtx.restore();
  updateSelectionUI(live.dx, live.dy);
}

function endSelMove(commit) {
  const { dx, dy } = live;
  live = null;
  clearCanvas(inkCtx);
  if (commit && (dx || dy)) {
    moveStrokes(selection.set, dx, dy);
    selection.bbox.x0 += dx; selection.bbox.x1 += dx;
    selection.bbox.y0 += dy; selection.bbox.y1 += dy;
    pushUndo({ type: 'move', strokes: [...selection.set], dx, dy });
    markDirty();
  }
  redrawBase();
  updateSelectionUI();
}

function moveStrokes(set, dx, dy) {
  for (const s of set) {
    for (const p of s.points) { p[0] += dx; p[1] += dy; }
  }
}

function deleteSelection() {
  if (!selection) return;
  const removed = [];
  const strokes = state.page.strokes;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (selection.set.has(strokes[i])) {
      removed.push([i, strokes[i]]);
      strokes.splice(i, 1);
    }
  }
  clearSelection();
  pushUndo({ type: 'erase', removed });
  markDirty();
  redrawBase();
}

function duplicateSelection() {
  if (!selection) return;
  const off = 24;
  const clones = [...selection.set].map(s => ({
    ...s,
    points: s.points.map(p => [p[0] + off, p[1] + off, p[2], p[3]]),
  }));
  state.page.strokes.push(...clones);
  pushUndo({ type: 'add-multi', count: clones.length });
  const b = selection.bbox;
  selection = {
    set: new Set(clones),
    bbox: { x0: b.x0 + off, y0: b.y0 + off, x1: b.x1 + off, y1: b.y1 + off },
  };
  markDirty();
  redrawBase();
  updateSelectionUI();
}

// i tocchi sulla barra azioni non devono arrivare allo stage (nuovo lazo)
$('#selbar').addEventListener('pointerdown', e => e.stopPropagation());
$('#sel-delete').addEventListener('click', deleteSelection);
$('#sel-duplicate').addEventListener('click', duplicateSelection);

/* ============================= Undo / Redo ============================= */

function pushUndo(op) {
  state.undoStack.push(op);
  if (state.undoStack.length > 200) state.undoStack.shift();
  state.redoStack.length = 0;
  updateUndoButtons();
}

function undo() {
  const op = state.undoStack.pop();
  if (!op) return;
  clearSelection();
  const strokes = state.page.strokes;
  if (op.type === 'add') {
    op.stroke = strokes.pop();
  } else if (op.type === 'add-multi') {
    op.strokes = strokes.splice(strokes.length - op.count, op.count);
  } else if (op.type === 'erase') {
    // reinserisce in ordine di indice crescente per ripristinare le posizioni
    for (const [i, s] of [...op.removed].sort((a, b) => a[0] - b[0])) strokes.splice(i, 0, s);
  } else if (op.type === 'move') {
    moveStrokes(op.strokes, -op.dx, -op.dy);
  } else if (op.type === 'scale') {
    scaleStrokes(op.strokes, 1 / op.f, op.cx, op.cy);
  } else if (op.type === 'recolor') {
    for (const [s, old] of op.changes) s.color = old;
  } else if (op.type === 'clear') {
    state.page.strokes = op.strokes;
  }
  state.redoStack.push(op);
  redrawBase(); markDirty(); updateUndoButtons();
}

function redo() {
  const op = state.redoStack.pop();
  if (!op) return;
  clearSelection();
  if (op.type === 'add') {
    state.page.strokes.push(op.stroke);
  } else if (op.type === 'add-multi') {
    state.page.strokes.push(...op.strokes);
  } else if (op.type === 'erase') {
    for (const [, s] of op.removed) {
      const i = state.page.strokes.indexOf(s);
      if (i >= 0) state.page.strokes.splice(i, 1);
    }
  } else if (op.type === 'move') {
    moveStrokes(op.strokes, op.dx, op.dy);
  } else if (op.type === 'scale') {
    scaleStrokes(op.strokes, op.f, op.cx, op.cy);
  } else if (op.type === 'recolor') {
    for (const [s] of op.changes) s.color = op.color;
  } else if (op.type === 'clear') {
    state.page.strokes = [];
  }
  state.undoStack.push(op);
  redrawBase(); markDirty(); updateUndoButtons();
}

function updateUndoButtons() {
  $('#btn-undo').disabled = !state.undoStack.length;
  $('#btn-redo').disabled = !state.redoStack.length;
}

/* ========================= Input: penna e tocco ========================= */

let stageRect = { left: 0, top: 0 };
const touches = new Map();   // pointerId -> {x, y}
let gesture = null;          // { startView, moved, p0:[{x,y},{x,y}] | [{x,y}] }
let tapCandidate = null;     // { id, t } dito singolo appena appoggiato
let lastTapTime = 0;

stage.addEventListener('contextmenu', e => e.preventDefault());

stage.addEventListener('pointerdown', e => {
  stageRect = stage.getBoundingClientRect();

  if (e.pointerType === 'touch') {
    if (live) {
      // Palm rejection: mentre la penna scrive il tocco è ignorato del tutto.
      if (live.pointerType !== 'touch') return;
      // Secondo dito mentre si disegna col dito: annulla e passa al gesto.
      cancelLive();
    }
    if (prefs.touchDraw && touches.size === 0) {
      if (state.tool === 'lasso') beginLassoOrMove(e);
      else beginStroke(e, false);
      try { stage.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // candidato "tap": un solo dito; un secondo dito lo annulla
    tapCandidate = touches.size === 1
      ? { id: e.pointerId, t: performance.now() }
      : null;
    startGesture();
    return;
  }

  // penna o mouse
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen') notePen(e);
  if (touches.size) { // la penna vince sul palmo
    touches.clear();
    gesture = null;
    if (gestureSnap) { gestureSnap = null; redrawBase(); }
  }
  const barrel = prefs.barrelEraser && e.pointerType === 'pen' && ((e.buttons & 2) || (e.buttons & 32));
  if (state.tool === 'lasso' && !barrel) beginLassoOrMove(e);
  else beginStroke(e, barrel);
  try { stage.setPointerCapture(e.pointerId); } catch {}
});

function cancelLive() {
  if (!live) return;
  if (live.mode === 'lasso') endLasso(false);
  else if (live.mode === 'movesel') endSelMove(false);
  else if (live.mode === 'scalesel') endSelScale(false);
  else endStroke(false);
}

function beginLassoOrMove(e) {
  const px = toPageX(e.clientX - stageRect.left);
  const py = toPageY(e.clientY - stageRect.top);
  if (selection && onScaleHandle(px, py)) startSelScale(e);
  else if (selection && inSelection(px, py)) startSelMove(e);
  else beginLasso(e);
}

function onScaleHandle(px, py) {
  const b = selection.bbox;
  const hs = 20 / state.view.scale;
  return Math.abs(px - b.x1) < hs && Math.abs(py - b.y1) < hs;
}

/* --------------------- Ridimensionamento selezione --------------------- */

function startSelScale(e) {
  const b = selection.bbox;
  live = {
    pointerId: e.pointerId, pointerType: e.pointerType, mode: 'scalesel',
    cx: b.x0, cy: b.y0,
    diag0: Math.hypot(b.x1 - b.x0, b.y1 - b.y0) || 1,
    f: 1,
  };
  redrawBase(selection.set);
}

function selScale(e) {
  const px = toPageX(e.clientX - stageRect.left);
  const py = toPageY(e.clientY - stageRect.top);
  const d = Math.hypot(px - live.cx, py - live.cy);
  live.f = clamp(d / live.diag0, 0.08, 20);
  clearCanvas(inkCtx);
  setCanvasTransform(inkCtx);
  inkCtx.save();
  inkCtx.translate(live.cx, live.cy);
  inkCtx.scale(live.f, live.f);
  inkCtx.translate(-live.cx, -live.cy);
  for (const s of selection.set) drawStroke(inkCtx, s);
  inkCtx.restore();
  // riquadro tratteggiato scalato
  const b = selection.bbox;
  clearCanvas(prevCtx);
  prevCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  prevCtx.strokeStyle = accentColor();
  prevCtx.lineWidth = 1.5;
  prevCtx.setLineDash([7, 5]);
  prevCtx.strokeRect(
    toScreenX(b.x0), toScreenY(b.y0),
    (b.x1 - b.x0) * live.f * state.view.scale, (b.y1 - b.y0) * live.f * state.view.scale);
  prevCtx.setLineDash([]);
}

function endSelScale(commit) {
  const { f, cx, cy } = live;
  live = null;
  clearCanvas(inkCtx);
  if (commit && Math.abs(f - 1) > 0.01) {
    scaleStrokes(selection.set, f, cx, cy);
    const b = selection.bbox;
    selection.bbox = {
      x0: b.x0, y0: b.y0,
      x1: cx + (b.x1 - cx) * f, y1: cy + (b.y1 - cy) * f,
    };
    pushUndo({ type: 'scale', strokes: [...selection.set], f, cx, cy });
    markDirty();
  }
  redrawBase();
  updateSelectionUI();
}

function scaleStrokes(set, f, cx, cy) {
  for (const s of set) {
    if (s.tool !== 'image') s.size *= f;
    for (const p of s.points) {
      p[0] = cx + (p[0] - cx) * f;
      p[1] = cy + (p[1] - cy) * f;
    }
  }
}

stage.addEventListener('pointermove', e => {
  if (live && e.pointerId === live.pointerId) {
    if (live.mode === 'lasso') lassoMove(e);
    else if (live.mode === 'movesel') selMove(e);
    else if (live.mode === 'scalesel') selScale(e);
    else addSamples(e);
    return;
  }
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moveGesture();
    return;
  }
  // Hover della S Pen: anteprima del pennello
  if (e.pointerType === 'pen' && !e.buttons) {
    notePen(e);
    drawHoverCursor(e);
  }
});

stage.addEventListener('pointerup', e => onPointerEnd(e, true));
stage.addEventListener('pointercancel', e => onPointerEnd(e, false));
stage.addEventListener('pointerleave', e => {
  if (e.pointerType === 'pen' && !live) clearCanvas(prevCtx);
});

function onPointerEnd(e, commit) {
  if (live && e.pointerId === live.pointerId) {
    if (live.mode === 'lasso') { if (commit) lassoMove(e); endLasso(commit); }
    else if (live.mode === 'movesel') { if (commit) selMove(e); endSelMove(commit); }
    else if (live.mode === 'scalesel') { if (commit) selScale(e); endSelScale(commit); }
    else { if (commit) addSamples(e); endStroke(commit); }
    return;
  }
  if (touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    if (touches.size) startGesture(); else endGesture(e);
  }
}

function drawHoverCursor(e) {
  clearCanvas(prevCtx);
  const x = e.clientX - stageRect.left, y = e.clientY - stageRect.top;
  if (state.tool === 'lasso') {
    if (selection) updateSelectionUI();
    prevCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    prevCtx.strokeStyle = accentColor();
    prevCtx.lineWidth = 1.5;
    prevCtx.beginPath();
    prevCtx.arc(x, y, 4, 0, Math.PI * 2);
    prevCtx.stroke();
    return;
  }
  prevCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.tool === 'eraser') {
    prevCtx.strokeStyle = 'rgba(128,128,128,.8)';
    prevCtx.lineWidth = 1.5;
    prevCtx.beginPath();
    prevCtx.arc(x, y, eraserRadius() * state.view.scale, 0, Math.PI * 2);
    prevCtx.stroke();
  } else {
    const r = Math.max(1.5, widthAt(state.tool, state.size, 0.6, 0) * state.view.scale / 2);
    prevCtx.fillStyle = state.tool === 'highlighter'
      ? displayColor(state.color) + '55'
      : displayColor(state.color);
    prevCtx.beginPath();
    prevCtx.arc(x, y, r, 0, Math.PI * 2);
    prevCtx.fill();
  }
}

const penCaps = { seen: false, pressure: false, tilt: false };
function notePen(e) {
  const before = penCaps.seen + penCaps.pressure + penCaps.tilt;
  penCaps.seen = true;
  if (e.pressure > 0 && e.pressure !== 0.5) penCaps.pressure = true;
  if (e.tiltX || e.tiltY) penCaps.tilt = true;
  if (penCaps.seen + penCaps.pressure + penCaps.tilt === before) return;
  $('#pen-status').textContent =
    `S Pen rilevata · pressione ${penCaps.pressure ? '✓' : '—'} · inclinazione ${penCaps.tilt ? '✓' : '—'} · hover ✓`;
}

/* ------------------------- Gesti: pan e pinch ------------------------- */

// Durante il gesto non si ridisegnano i tratti: si trasla/scala la bitmap
// della vista pre-gesto (fluido anche con pagine piene a 120 Hz);
// il ridisegno nitido avviene al rilascio.
let gestureSnap = null; // { canvas, view }

function startGesture() {
  const pts = [...touches.values()].slice(0, 2);
  gesture = { startView: { ...state.view }, moved: gesture?.moved ?? false, p0: pts.map(p => ({ ...p })) };
  if (!gestureSnap) {
    const c = document.createElement('canvas');
    c.width = baseCv.width; c.height = baseCv.height;
    c.getContext('2d').drawImage(baseCv, 0, 0);
    gestureSnap = { canvas: c, view: { ...state.view } };
  }
}

function blitGesture() {
  const v0 = gestureSnap.view, v1 = state.view;
  const k = v1.scale / v0.scale;
  const ox = (v0.x - v1.x) * v1.scale * dpr;
  const oy = (v0.y - v1.y) * v1.scale * dpr;
  baseCtx.setTransform(1, 0, 0, 1, 0, 0);
  baseCtx.fillStyle = paperColor();
  baseCtx.fillRect(0, 0, baseCv.width, baseCv.height);
  baseCtx.drawImage(gestureSnap.canvas, ox, oy, gestureSnap.canvas.width * k, gestureSnap.canvas.height * k);
  if (selection) updateSelectionUI();
}

function moveGesture() {
  if (!gesture) return;
  const pts = [...touches.values()].slice(0, 2);
  const g = gesture;
  if (!g.moved && pts.some((p, i) => g.p0[i] && Math.hypot(p.x - g.p0[i].x, p.y - g.p0[i].y) > 8)) {
    g.moved = true;
  }
  if (pts.length === 1 && g.p0.length >= 1) {
    state.view.x = g.startView.x - (pts[0].x - g.p0[0].x) / g.startView.scale;
    state.view.y = g.startView.y - (pts[0].y - g.p0[0].y) / g.startView.scale;
    state.view.scale = g.startView.scale;
  } else if (pts.length >= 2 && g.p0.length >= 2) {
    const d0 = Math.hypot(g.p0[1].x - g.p0[0].x, g.p0[1].y - g.p0[0].y) || 1;
    const d1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const scale = clamp(g.startView.scale * d1 / d0, 0.2, 8);
    const c0 = { x: (g.p0[0].x + g.p0[1].x) / 2, y: (g.p0[0].y + g.p0[1].y) / 2 };
    const c1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    // il punto pagina sotto il centro iniziale resta sotto il centro attuale
    const pageC = {
      x: (c0.x - stageRect.left) / g.startView.scale + g.startView.x,
      y: (c0.y - stageRect.top) / g.startView.scale + g.startView.y,
    };
    state.view.scale = scale;
    state.view.x = pageC.x - (c1.x - stageRect.left) / scale;
    state.view.y = pageC.y - (c1.y - stageRect.top) / scale;
  }
  showZoom();
  blitGesture();
}

function endGesture(e) {
  if (gestureSnap) {
    gestureSnap = null;
    redrawBase(); // ridisegno nitido a fine gesto
  }
  // doppio tap a un dito (quando il dito non disegna): torna al 100%
  const now = performance.now();
  const isTap = !prefs.touchDraw
    && tapCandidate && tapCandidate.id === e.pointerId
    && now - tapCandidate.t < 250
    && gesture && !gesture.moved;
  gesture = null;
  tapCandidate = null;
  if (!isTap) { lastTapTime = 0; return; }
  if (now - lastTapTime < 320) { resetView(); lastTapTime = 0; }
  else lastTapTime = now;
}

function resetView() {
  state.view = { x: 0, y: 0, scale: 1 };
  showZoom();
  redrawBase();
}

let zoomTimer = null;
function showZoom() {
  const b = $('#zoom-badge');
  b.textContent = Math.round(state.view.scale * 100) + '%';
  b.hidden = false;
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => { b.hidden = true; }, 900);
}

// Trackpad / mouse in Samsung DeX: rotellina = pan, Ctrl+rotellina = zoom
stage.addEventListener('wheel', e => {
  e.preventDefault();
  stageRect = stage.getBoundingClientRect();
  if (e.ctrlKey) {
    const factor = Math.exp(-e.deltaY * 0.0015);
    const scale = clamp(state.view.scale * factor, 0.2, 8);
    const sx = e.clientX - stageRect.left, sy = e.clientY - stageRect.top;
    const px = toPageX(sx), py = toPageY(sy);
    state.view.scale = scale;
    state.view.x = px - sx / scale;
    state.view.y = py - sy / scale;
  } else {
    state.view.x += (e.shiftKey ? e.deltaY : e.deltaX) / state.view.scale;
    state.view.y += (e.shiftKey ? 0 : e.deltaY) / state.view.scale;
  }
  showZoom();
  redrawBase();
}, { passive: false });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ======================== Quaderni e pagine ======================== */

async function init() {
  applyTheme();
  resize();
  new ResizeObserver(resize).observe(stage);

  let notebooks = await store.listNotebooks();
  if (!notebooks.length) {
    const nb = { id: uid(), title: 'Il mio quaderno', created: Date.now(), updated: Date.now() };
    await store.putNotebook(nb);
    await store.putPage({ id: uid(), notebookId: nb.id, index: 0, template: 'blank', strokes: [] });
    notebooks = [nb];
  }
  const nb = notebooks.find(n => n.id === prefs.lastNotebook) || notebooks[0];
  await openNotebook(nb);
  state.color = prefs.color || PALETTE[0];
  buildColorBar();
  selectTool(state.tool);
  syncSettingsUI();

  if (!prefs.welcomed) {
    $('#welcome').hidden = false;
    $('#wc-ok').addEventListener('click', () => {
      $('#welcome').hidden = true;
      prefs.welcomed = true;
      savePrefs();
    }, { once: true });
  }
}

async function openNotebook(nb) {
  await flushSave();
  state.notebook = nb;
  // listPages restituisce i record completi (tratti inclusi): state.pages è
  // l'unica fonte di verità e state.page punta a uno dei suoi elementi.
  state.pages = await store.listPages(nb.id);
  if (!state.pages.length) {
    const p = { id: uid(), notebookId: nb.id, index: 0, template: 'blank', strokes: [] };
    await store.putPage(p);
    state.pages = [p];
  }
  const page = state.pages.find(p => p.id === prefs.lastPage) || state.pages[0];
  prefs.lastNotebook = nb.id;
  savePrefs();
  $('#notebook-title').textContent = nb.title;
  await openPage(page.id);
}

async function openPage(id) {
  await flushSave();
  cancelLive();
  clearSelection();
  state.page = state.pages.find(p => p.id === id);
  state.undoStack = [];
  state.redoStack = [];
  prefs.lastPage = id;
  savePrefs();
  resetViewSilently();
  updatePager();
  updateUndoButtons();
  $('#opt-template').value = state.page.template || 'blank';
  redrawBase();
}

function resetViewSilently() { state.view = { x: 0, y: 0, scale: 1 }; }

function updatePager() {
  const i = state.pages.findIndex(p => p.id === state.page.id);
  $('#page-label').textContent = `${i + 1} / ${state.pages.length}`;
  $('#btn-prev').disabled = i <= 0;
  $('#btn-next').disabled = i >= state.pages.length - 1;
}

async function gotoPage(delta) {
  const i = state.pages.findIndex(p => p.id === state.page.id);
  const j = i + delta;
  if (j < 0 || j >= state.pages.length) return;
  await openPage(state.pages[j].id);
}

async function addPage() {
  await flushSave();
  const i = state.pages.findIndex(p => p.id === state.page.id);
  const page = {
    id: uid(), notebookId: state.notebook.id,
    index: (state.pages[i]?.index ?? 0) + 0.5,
    template: state.page?.template || 'blank',
    strokes: [],
  };
  state.pages.splice(i + 1, 0, page);
  state.pages.forEach((p, k) => { p.index = k; });
  await Promise.all(state.pages.map(p => store.putPage(p)));
  await openPage(page.id);
  toast('Nuova pagina');
}

/* ------------------------------ Salvataggio ------------------------------ */

let saveTimer = null;
function markDirty() {
  state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!state.dirty || !state.page) return;
  state.dirty = false;
  try {
    await store.putPage(state.page);
    if (state.notebook) {
      state.notebook.updated = Date.now();
      await store.putNotebook(state.notebook);
    }
  } catch (err) {
    state.dirty = true; // riprova al prossimo salvataggio
    toast(err?.name === 'QuotaExceededError'
      ? 'Spazio esaurito: esporta un backup e libera spazio'
      : 'Salvataggio non riuscito, riprovo…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 4000);
  }
}
window.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

/* ============================ Barra strumenti ============================ */

function selectTool(tool) {
  if (tool !== 'lasso') clearSelection();
  // memorizza lo spessore preferito per lo strumento precedente
  prefs.sizes[state.tool] = state.size;
  state.tool = tool;
  state.size = prefs.sizes[tool] ?? TOOLS[tool].size;
  $('#size').value = state.size;
  document.querySelectorAll('.tool').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  updateSizeDot();
  savePrefs();
}

function updateSizeDot() {
  const d = clamp(widthAt(state.tool, state.size, 0.7, 0), 3, 26);
  const dot = $('#size-dot');
  dot.style.setProperty('--dot', d + 'px');
  dot.style.setProperty('--dot-color', state.tool === 'eraser' ? 'var(--muted)' : state.color);
}

function buildColorBar() {
  const bar = $('#colors');
  bar.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => setColor(c));
    bar.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.value = state.color;
  custom.title = 'Colore personalizzato';
  custom.addEventListener('input', () => setColor(custom.value));
  bar.appendChild(custom);
  refreshSwatches();
}

function setColor(c) {
  state.color = c;
  prefs.color = c;
  savePrefs();
  if (state.tool === 'eraser') selectTool('fountain');
  // con una selezione attiva, il colore si applica ai tratti selezionati
  if (state.tool === 'lasso' && selection) {
    const changes = [];
    for (const s of selection.set) {
      if (s.tool === 'image' || s.color === c) continue;
      changes.push([s, s.color]);
      s.color = c;
    }
    if (changes.length) {
      pushUndo({ type: 'recolor', changes, color: c });
      markDirty();
      redrawBase();
      updateSelectionUI();
    }
  }
  refreshSwatches();
  updateSizeDot();
}

function refreshSwatches() {
  document.querySelectorAll('.swatch').forEach(b =>
    b.classList.toggle('active', b.title === state.color));
}

document.querySelectorAll('.tool').forEach(b =>
  b.addEventListener('click', () => selectTool(b.dataset.tool)));

$('#size').addEventListener('input', e => {
  state.size = parseFloat(e.target.value);
  prefs.sizes[state.tool] = state.size;
  savePrefs();
  updateSizeDot();
});

$('#notebook-title').addEventListener('click', async () => {
  if (!state.notebook) return;
  const t = prompt('Nome del quaderno:', state.notebook.title);
  if (t && t.trim()) {
    state.notebook.title = t.trim();
    await store.putNotebook(state.notebook);
    $('#notebook-title').textContent = state.notebook.title;
  }
});

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-prev').addEventListener('click', () => gotoPage(-1));
$('#btn-next').addEventListener('click', () => gotoPage(1));
$('#btn-addpage').addEventListener('click', addPage);

/* ============================== Sidebar ============================== */

const sidebar = $('#sidebar'), scrim = $('#scrim');

function toggleSidebar(show) {
  const s = show ?? sidebar.hidden;
  sidebar.hidden = !s;
  scrim.hidden = !s;
  if (s) { renderNotebookList(); renderPageList(); }
}
$('#btn-menu').addEventListener('click', () => toggleSidebar());
scrim.addEventListener('click', () => { toggleSidebar(false); toggleSettings(false); });

async function renderNotebookList() {
  const list = $('#notebook-list');
  list.innerHTML = '';
  const notebooks = await store.listNotebooks();
  for (const nb of notebooks) {
    const pages = await store.listPages(nb.id);
    const li = document.createElement('li');
    li.classList.toggle('active', nb.id === state.notebook?.id);
    const name = document.createElement('span');
    name.className = 'nb-name';
    name.textContent = nb.title;
    const count = document.createElement('span');
    count.className = 'nb-pages';
    count.textContent = pages.length === 1 ? '1 pagina' : `${pages.length} pagine`;
    const ren = document.createElement('button');
    ren.className = 'nb-del';
    ren.textContent = '✎';
    ren.title = 'Rinomina quaderno';
    ren.addEventListener('click', async ev => {
      ev.stopPropagation();
      const t = prompt('Nome del quaderno:', nb.title);
      if (t && t.trim()) {
        nb.title = t.trim();
        await store.putNotebook(nb);
        if (nb.id === state.notebook?.id) $('#notebook-title').textContent = nb.title;
        renderNotebookList();
      }
    });
    const del = document.createElement('button');
    del.className = 'nb-del';
    del.textContent = '✕';
    del.title = 'Elimina quaderno';
    del.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!confirm(`Eliminare "${nb.title}" e tutte le sue pagine?`)) return;
      await store.deleteNotebook(nb.id);
      if (nb.id === state.notebook?.id) {
        const rest = await store.listNotebooks();
        if (rest.length) await openNotebook(rest[0]);
        else { toggleSidebar(false); await init(); return; }
      }
      renderNotebookList();
    });
    li.append(name, count, ren, del);
    li.addEventListener('click', async () => {
      await openNotebook(nb);
      toggleSidebar(false);
    });
    li.addEventListener('dblclick', async ev => {
      ev.stopPropagation();
      const t = prompt('Nome del quaderno:', nb.title);
      if (t && t.trim()) {
        nb.title = t.trim();
        await store.putNotebook(nb);
        if (nb.id === state.notebook?.id) $('#notebook-title').textContent = nb.title;
        renderNotebookList();
      }
    });
    list.appendChild(li);
  }
}

async function renderPageList(secondPass = false) {
  const list = $('#page-list');
  // se ci sono immagini non ancora caricate, attendile e ridisegna una volta
  if (!secondPass) {
    const pending = state.pages.some(pg =>
      pg.strokes.some(s => s.tool === 'image' && !imageCache.get(s.data)?.loaded));
    if (pending) {
      Promise.all(state.pages.map(ensureImagesLoaded)).then(() => {
        if (!sidebar.hidden) renderPageList(true);
      });
    }
  }
  list.innerHTML = '';
  state.pages.forEach((pg, i) => {
    const li = document.createElement('li');
    li.classList.toggle('active', pg.id === state.page?.id);
    li.appendChild(renderThumbnail(pg));
    const num = document.createElement('span');
    num.className = 'pg-num';
    num.textContent = i + 1;
    li.appendChild(num);
    if (state.pages.length > 1) {
      const del = document.createElement('button');
      del.className = 'pg-del';
      del.textContent = '✕';
      del.title = 'Elimina pagina';
      del.addEventListener('click', async ev => {
        ev.stopPropagation();
        if (pg.strokes.length && !confirm(`Eliminare la pagina ${i + 1}?`)) return;
        await deletePageById(pg.id);
      });
      li.appendChild(del);
      // riordino
      for (const [delta, label, title] of [[-1, '‹', 'Sposta prima'], [1, '›', 'Sposta dopo']]) {
        if ((delta < 0 && i === 0) || (delta > 0 && i === state.pages.length - 1)) continue;
        const mv = document.createElement('button');
        mv.className = 'pg-move' + (delta > 0 ? ' right' : '');
        mv.textContent = label;
        mv.title = title;
        mv.addEventListener('click', async ev => {
          ev.stopPropagation();
          await movePage(pg.id, delta);
        });
        li.appendChild(mv);
      }
    }
    li.addEventListener('click', async () => {
      await openPage(pg.id);
      toggleSidebar(false);
    });
    list.appendChild(li);
  });
}

// Miniatura: i tratti della pagina adattati in un piccolo canvas.
function renderThumbnail(pg) {
  const W = 300, H = 212; // 2x per nitidezza, mostrato a metà
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = paperColor();
  ctx.fillRect(0, 0, W, H);
  if (!pg.strokes.length) return cv;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of pg.strokes) for (const p of s.points) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  const pad = 24;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const scale = Math.min(W / (x1 - x0), H / (y1 - y0), 0.5);
  const ox = (W - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = (H - (y1 - y0) * scale) / 2 - y0 * scale;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  for (const s of pg.strokes) drawStroke(ctx, s);
  return cv;
}

async function movePage(id, delta) {
  const i = state.pages.findIndex(p => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  state.pages.forEach((p, k) => { p.index = k; });
  await Promise.all(state.pages.map(p => store.putPage(p)));
  updatePager();
  renderPageList();
}

async function deletePageById(id) {
  const i = state.pages.findIndex(p => p.id === id);
  if (i < 0 || state.pages.length <= 1) return;
  const wasCurrent = state.page?.id === id;
  state.pages.splice(i, 1);
  state.pages.forEach((p, k) => { p.index = k; });
  await store.deletePage(id);
  await Promise.all(state.pages.map(p => store.putPage(p)));
  if (wasCurrent) {
    await openPage(state.pages[Math.min(i, state.pages.length - 1)].id);
  } else {
    updatePager();
  }
  renderPageList();
  toast('Pagina eliminata');
}

$('#btn-newnotebook').addEventListener('click', async () => {
  const t = prompt('Nome del nuovo quaderno:', 'Quaderno ' + new Date().toLocaleDateString('it-IT'));
  if (t === null) return;
  const nb = { id: uid(), title: (t.trim() || 'Quaderno'), created: Date.now(), updated: Date.now() };
  await store.putNotebook(nb);
  await store.putPage({ id: uid(), notebookId: nb.id, index: 0, template: 'blank', strokes: [] });
  await openNotebook(nb);
  toggleSidebar(false);
});

/* ============================ Impostazioni ============================ */

const settingsPanel = $('#settings-panel');
function toggleSettings(show) {
  const s = show ?? settingsPanel.hidden;
  settingsPanel.hidden = !s;
  scrim.hidden = !s && sidebar.hidden;
}
$('#btn-settings').addEventListener('click', () => toggleSettings());

function syncSettingsUI() {
  $('#opt-theme').value = prefs.theme;
  $('#opt-touchdraw').checked = prefs.touchDraw;
  $('#opt-barrel').checked = prefs.barrelEraser;
  $('#opt-shapes').checked = prefs.autoShapes;
}

$('#opt-theme').addEventListener('change', e => { prefs.theme = e.target.value; savePrefs(); applyTheme(); });
$('#opt-touchdraw').addEventListener('change', e => { prefs.touchDraw = e.target.checked; savePrefs(); });
$('#opt-barrel').addEventListener('change', e => { prefs.barrelEraser = e.target.checked; savePrefs(); });
$('#opt-shapes').addEventListener('change', e => { prefs.autoShapes = e.target.checked; savePrefs(); });

$('#opt-template').addEventListener('change', e => {
  if (!state.page) return;
  state.page.template = e.target.value;
  markDirty();
  redrawBase();
});

$('#btn-clearpage').addEventListener('click', () => {
  if (!state.page?.strokes.length) return;
  pushUndo({ type: 'clear', strokes: state.page.strokes });
  state.page.strokes = [];
  markDirty();
  redrawBase();
  toggleSettings(false);
  toast('Pagina cancellata — Annulla per ripristinare');
});

$('#btn-export').addEventListener('click', exportPNG);

async function exportPNG() {
  const strokes = state.page?.strokes || [];
  if (!strokes.length) { toast('La pagina è vuota'); return; }
  await ensureImagesLoaded(state.page);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.points) {
    const w = widthAt(s.tool, s.size, 1, 1);
    x0 = Math.min(x0, p[0] - w); y0 = Math.min(y0, p[1] - w);
    x1 = Math.max(x1, p[0] + w); y1 = Math.max(y1, p[1] + w);
  }
  const pad = 40, scale = 2;
  const w = Math.ceil((x1 - x0 + pad * 2) * scale);
  const h = Math.ceil((y1 - y0 + pad * 2) * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  exportMode = true; // sempre inchiostro scuro su carta bianca
  try {
    ctx.fillStyle = paperColor();
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, (pad - x0) * scale, (pad - y0) * scale);
    for (const s of strokes) drawStroke(ctx, s);
  } finally {
    exportMode = false;
  }
  cv.toBlob(blob => shareOrDownload(blob, `${state.notebook.title} — pagina.png`, 'image/png'), 'image/png');
  toggleSettings(false);
}

/* ========================= PDF, backup, ripristino ========================= */

// Rende una pagina su canvas in proporzione A4 (contenuto adattato e centrato).
function renderPageToCanvas(pg, pxW, pxH) {
  const cv = document.createElement('canvas');
  cv.width = pxW; cv.height = pxH;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pxW, pxH);
  if (!pg.strokes.length) return cv;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of pg.strokes) for (const p of s.points) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  const pad = 60;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const scale = Math.min(pxW / (x1 - x0), pxH / (y1 - y0), 3);
  const ox = (pxW - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = (pxH - (y1 - y0) * scale) / 2 - y0 * scale;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  exportMode = true; // esporta sempre inchiostro scuro su carta bianca
  try {
    for (const s of pg.strokes) drawStroke(ctx, s);
  } finally {
    exportMode = false;
  }
  return cv;
}

async function exportNotebookPDF() {
  await flushSave();
  toast('Genero il PDF…');
  const pxW = Math.round(A4W * 2), pxH = Math.round(A4H * 2);
  const images = [];
  for (const pg of state.pages) {
    await ensureImagesLoaded(pg);
    const cv = renderPageToCanvas(pg, pxW, pxH);
    const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.88));
    images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: pxW, h: pxH });
  }
  await shareOrDownload(buildPdf(images), `${state.notebook.title}.pdf`, 'application/pdf');
  toggleSettings(false);
}

async function exportBackup() {
  await flushSave();
  const notebooks = await store.listNotebooks();
  const data = { app: 'inchiostro', version: 1, exported: Date.now(), notebooks: [] };
  for (const nb of notebooks) {
    data.notebooks.push({ ...nb, pages: await store.listPages(nb.id) });
  }
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const d = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `inchiostro-backup-${d}.json`);
  toggleSettings(false);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'inchiostro' || !Array.isArray(data.notebooks)) throw new Error('formato');
  } catch {
    toast('File di backup non valido');
    return;
  }
  const existing = new Set((await store.listNotebooks()).map(n => n.id));
  let imported = 0;
  for (const nb of data.notebooks) {
    const { pages = [], ...meta } = nb;
    if (existing.has(meta.id)) {
      // già presente: importa come copia con nuovi id
      meta.id = uid();
      meta.title += ' (importato)';
      for (const pg of pages) { pg.id = uid(); pg.notebookId = meta.id; }
    }
    if (!meta.title) meta.title = 'Quaderno importato';
    await store.putNotebook(meta);
    for (const pg of pages) await store.putPage(pg);
    imported++;
  }
  toast(`Importati ${imported} quaderni`);
  const notebooks = await store.listNotebooks();
  await openNotebook(notebooks.find(n => n.id === state.notebook?.id) || notebooks[0]);
  toggleSettings(false);
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[/\\:*?"<>|]/g, '-');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Su Android apre il foglio di condivisione di sistema; altrove scarica.
async function shareOrDownload(blob, name, mime) {
  const file = new File([blob], name.replace(/[/\\:*?"<>|]/g, '-'), { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // annullato dall'utente
    }
  }
  downloadBlob(blob, name);
}

/* ------------------------ Inserimento immagini ------------------------ */

async function insertImage(file) {
  const dataUrl = await downscaleImage(file, 1600);
  if (!dataUrl) { toast('Immagine non valida'); return; }
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; })
    .catch(() => null);
  if (!img.naturalWidth) { toast('Immagine non valida'); return; }
  // centra nel viewport, larghezza ~55% dello schermo (in unità pagina)
  const w = (stageW * 0.55) / state.view.scale;
  const h = w * img.naturalHeight / img.naturalWidth;
  const cx = toPageX(stageW / 2), cy = toPageY(stageH / 2);
  const x0 = cx - w / 2, y0 = cy - h / 2;
  const s = {
    tool: 'image', color: '', size: 0, data: dataUrl,
    points: [
      [x0, y0, 0.5, 0], [x0 + w, y0, 0.5, 0],
      [x0 + w, y0 + h, 0.5, 0], [x0, y0 + h, 0.5, 0],
    ],
  };
  imageCache.set(dataUrl, { img, loaded: true });
  state.page.strokes.push(s);
  pushUndo({ type: 'add' });
  markDirty();
  redrawBase();
  // selezionala subito: si può spostare senza cambiare strumento
  selectTool('lasso');
  selection = { set: new Set([s]), bbox: { x0, y0, x1: x0 + w, y1: y0 + h } };
  updateSelectionUI();
  toggleSettings(false);
  toast('Immagine inserita — trascinala col lazo');
}

// Ridimensiona l'immagine (lato massimo maxDim) e la serializza in dataURL.
async function downscaleImage(file, maxDim) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const isPng = file.type === 'image/png';
    return cv.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.87);
  } catch {
    return null;
  }
}

$('#btn-insertimg').addEventListener('click', () => $('#image-file').click());
$('#image-file').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) insertImage(f);
});

$('#btn-exportpdf').addEventListener('click', exportNotebookPDF);
$('#btn-backup').addEventListener('click', exportBackup);
$('#btn-restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importBackup(f);
});

/* =========================== Tastiera (DeX) =========================== */

window.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); resetView(); }
  else if (k >= '1' && k <= '6') selectTool(Object.keys(TOOLS)[k - 1]);
  else if (k === 'escape') clearSelection();
  else if ((k === 'delete' || k === 'backspace') && selection) { e.preventDefault(); deleteSelection(); }
  else if (k === 'm') toggleSidebar();
  else if (k === 'pageup') gotoPage(-1);
  else if (k === 'pagedown') gotoPage(1);
  else if (k === '[' || k === ']') {
    state.size = clamp(state.size + (k === ']' ? 1 : -1), 1, 30);
    $('#size').value = state.size;
    updateSizeDot();
  }
});

/* ================================ Toast ================================ */

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ============================ Service worker ============================ */

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

init();
