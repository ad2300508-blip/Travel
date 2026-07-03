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
    theme: 'auto', touchDraw: false, barrelEraser: true,
    lastNotebook: null, lastPage: null, color: PALETTE[0], sizes: {},
  }, JSON.parse(localStorage.getItem('inchiostro-prefs') || '{}')); }
  catch { return { theme: 'auto', touchDraw: false, barrelEraser: true, sizes: {} }; }
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
function displayColor(c) {
  if (c === PALETTE[0] && document.documentElement.dataset.theme === 'dark') return '#ecebe8';
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

// Disegna un tratto completo (coordinate pagina; il ctx ha già la trasformazione).
function drawStroke(ctx, s) {
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

function redrawBase() {
  clearCanvas(baseCtx);
  baseCtx.fillStyle = paperColor();
  baseCtx.fillRect(0, 0, baseCv.width, baseCv.height);
  setCanvasTransform(baseCtx);
  drawTemplate(baseCtx);
  if (state.page) for (const s of state.page.strokes) drawStroke(baseCtx, s);
}

/* =========================== Tratto in corso =========================== */

let live = null; // { stroke, erasing, pointerId }

function beginStroke(e, erasing) {
  const tool = erasing ? 'eraser' : state.tool;
  live = {
    pointerId: e.pointerId,
    pointerType: e.pointerType,
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
  drawPrediction(e);
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
  const strokes = state.page.strokes;
  if (op.type === 'add') {
    op.stroke = strokes.pop();
  } else if (op.type === 'erase') {
    // reinserisce in ordine di indice crescente per ripristinare le posizioni
    for (const [i, s] of [...op.removed].sort((a, b) => a[0] - b[0])) strokes.splice(i, 0, s);
  } else if (op.type === 'clear') {
    state.page.strokes = op.strokes;
  }
  state.redoStack.push(op);
  redrawBase(); markDirty(); updateUndoButtons();
}

function redo() {
  const op = state.redoStack.pop();
  if (!op) return;
  if (op.type === 'add') {
    state.page.strokes.push(op.stroke);
  } else if (op.type === 'erase') {
    for (const [, s] of op.removed) {
      const i = state.page.strokes.indexOf(s);
      if (i >= 0) state.page.strokes.splice(i, 1);
    }
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
      endStroke(false);
    }
    if (prefs.touchDraw && touches.size === 0) {
      beginStroke(e, false);
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
  if (touches.size) { touches.clear(); gesture = null; } // la penna vince sul palmo
  const barrel = prefs.barrelEraser && e.pointerType === 'pen' && ((e.buttons & 2) || (e.buttons & 32));
  beginStroke(e, barrel);
  try { stage.setPointerCapture(e.pointerId); } catch {}
});

stage.addEventListener('pointermove', e => {
  if (live && e.pointerId === live.pointerId) {
    addSamples(e);
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
    if (commit) addSamples(e);
    endStroke(commit);
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

function startGesture() {
  const pts = [...touches.values()].slice(0, 2);
  gesture = { startView: { ...state.view }, moved: gesture?.moved ?? false, p0: pts.map(p => ({ ...p })) };
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
  redrawBase();
}

function endGesture(e) {
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
  await store.putPage(state.page);
  if (state.notebook) {
    state.notebook.updated = Date.now();
    await store.putNotebook(state.notebook);
  }
}
window.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

/* ============================ Barra strumenti ============================ */

function selectTool(tool) {
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
  if (s) renderNotebookList();
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
    li.append(name, count, del);
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
}

$('#opt-theme').addEventListener('change', e => { prefs.theme = e.target.value; savePrefs(); applyTheme(); });
$('#opt-touchdraw').addEventListener('change', e => { prefs.touchDraw = e.target.checked; savePrefs(); });
$('#opt-barrel').addEventListener('change', e => { prefs.barrelEraser = e.target.checked; savePrefs(); });

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

function exportPNG() {
  const strokes = state.page?.strokes || [];
  if (!strokes.length) { toast('La pagina è vuota'); return; }
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
  ctx.fillStyle = paperColor();
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, (pad - x0) * scale, (pad - y0) * scale);
  for (const s of strokes) drawStroke(ctx, s);
  cv.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.notebook.title} — pagina.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
  toggleSettings(false);
}

/* =========================== Tastiera (DeX) =========================== */

window.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); resetView(); }
  else if (k >= '1' && k <= '5') selectTool(Object.keys(TOOLS)[k - 1]);
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
