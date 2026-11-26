import {
  TEMPLATES, applyTemplate, clearContent, collectLeaves, defaultText, findNode, layoutTree, pointInPoly, polyArea, tiltsOf,
  removeLeaf, splitLeaf, swapContent,
} from './geometry.js';
import { FONTS, chipRect, drawLeaf, drawOverlay, fontString, photoMetrics, polyPath, scaleCell, scaleRect } from './render.js';
import { createColorField, closePicker } from './colorpicker.js';
import { clamp, toCss } from './color.js';
import { withDpi } from './export.js';
import * as store from './db.js';

const $ = (s, root = document) => root.querySelector(s);

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_PIXELS = IS_IOS ? 16_000_000 : 200_000_000;
const MAX_SIDE = 16384;

const PAPER = [
  [4, 6], [6, 4], [5, 7], [7, 5], [8, 10], [10, 8], [8, 8], [11, 14], [14, 11], [16, 20], [20, 16],
];

// State ------------------------------------------------------------------
const state = {
  page: { w: 8, h: 10, dpi: 300, margin: 0.25, gap: 0.12, radius: 0, bg: '#ffffff' },
  root: TEMPLATES.find((t) => t.id === 'grid-2x2').build(),
  selectedId: null,
};
const exportSettings = { format: 'png', quality: 0.95 };
const photos = new Map();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const project = { id: null, name: '', created: 0 };
let storageOk = true;
const ui = { hoverDivider: null, activeDivider: null, dropId: null, pointerInside: false };

const history = { stack: [], index: -1 };
const snapshot = () => JSON.stringify({ page: state.page, root: state.root });
function commit() {
  const s = snapshot();
  if (history.stack[history.index] === s) return;
  history.stack.length = history.index + 1;
  history.stack.push(s);
  if (history.stack.length > 100) history.stack.shift();
  history.index = history.stack.length - 1;
  updateHistoryButtons();
  scheduleSave();
}
let commitTimer = 0;
function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commit, 400);
}
function restore(i) {
  if (i < 0 || i >= history.stack.length) return;
  const d = JSON.parse(history.stack[i]);
  state.page = d.page;
  state.root = d.root;
  history.index = i;
  if (!findNode(state.root, state.selectedId)) state.selectedId = null;
  syncPageControls();
  renderCellPanel();
  resizeStage();
  updateHistoryButtons();
}
const undo = () => { clearTimeout(commitTimer); commit(); restore(history.index - 1); };
const redo = () => restore(history.index + 1);
function updateHistoryButtons() {
  $('#undo').disabled = history.index <= 0;
  $('#redo').disabled = history.index >= history.stack.length - 1;
}

// Helpers ----------------------------------------------------------------
const selectedLeaf = () => (state.selectedId ? findNode(state.root, state.selectedId)?.node ?? null : null);
const leafById = (id) => findNode(state.root, id)?.node ?? null;
const orderedLeaves = () => collectLeaves(state.root);
const isEmptyLeaf = (l) => l.type === 'empty' || (l.type === 'photo' && !photos.has(l.photoId));
const pageLayout = () => {
  const { w, h, margin, gap } = state.page;
  return layoutTree(state.root, { x: margin, y: margin, w: w - margin * 2, h: h - margin * 2 }, gap);
};
const imgFor = (l) => {
  const p = l.type === 'photo' ? photos.get(l.photoId) : null;
  return p ? { src: p.preview, w: p.w, h: p.h } : null;
};
const borderAt = (k, page = state.page) => ({ width: (page.border ?? 0) * k, color: page.borderColor ?? '#111111' });
const isUsed = (id) => orderedLeaves().some((l) => l.type === 'photo' && l.photoId === id);

let toastTimer = 0;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// Stage ------------------------------------------------------------------
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const view = { cssPerIn: 1, dpr: 1 };
let raf = 0;
const requestRender = () => { if (!raf) raf = requestAnimationFrame(render); };

function resizeStage() {
  const box = $('#stage-inner');
  const pad = window.innerWidth < 700 ? 12 : 28;
  const availW = Math.max(60, box.clientWidth - pad * 2);
  const availH = Math.max(60, box.clientHeight - pad * 2);
  const scale = Math.min(availW / state.page.w, availH / state.page.h);
  const cssW = Math.max(40, Math.floor(state.page.w * scale));
  const cssH = Math.max(40, Math.floor(state.page.h * scale));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  view.cssPerIn = cssW / state.page.w;
  view.dpr = dpr;
  requestRender();
}

function ensureFontsForPreview() {
  for (const l of orderedLeaves()) {
    if (l.type !== 'text') continue;
    const f = fontString(l.text, 20);
    if (!document.fonts.check(f, l.text.value)) document.fonts.load(f, l.text.value).then(requestRender).catch(() => {});
  }
}

function render() {
  raf = 0;
  const { radius, bg, gap } = state.page;
  const ppi = view.cssPerIn * view.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = toCss(bg);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ensureFontsForPreview();
  const lay = pageLayout();
  for (const item of lay.leaves) drawLeaf(ctx, item.node, scaleCell(item, ppi), radius * ppi, imgFor(item.node), borderAt(ppi));
  drawOverlay(ctx, lay, {
    ppi, dpr: view.dpr, radius: radius * ppi, gap, isEmpty: isEmptyLeaf, selectedId: state.selectedId,
    dropId: ui.dropId, hoverDivider: ui.hoverDivider, activeDivider: ui.activeDivider, pointerInside: ui.pointerInside,
  });
  updateExportInfo();
}

// Hit testing ------------------------------------------------------------
function toInches(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / view.cssPerIn, y: (e.clientY - r.top) / view.cssPerIn };
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function hitTest(p, touch, interactive = true) {
  const lay = pageLayout();
  const px = p.x * view.cssPerIn, py = p.y * view.cssPerIn;
  const sel = lay.leaves.find((l) => l.node.id === state.selectedId);
  if (interactive && sel && !isEmptyLeaf(sel.node)) {
    const c = chipRect(scaleRect(sel.inner, view.cssPerIn));
    const slop = touch ? 8 : 2;
    if (px >= c.x - slop && px <= c.x + c.w + slop && py >= c.y - slop && py <= c.y + c.h + slop) return { kind: 'chip', leaf: sel };
  }
  if (interactive) {
    const endTol = (touch ? 20 : 10) / view.cssPerIn;
    for (const d of lay.dividers) {
      for (const end of ['a', 'b']) if (Math.hypot(p.x - d[end].x, p.y - d[end].y) <= endTol) return { kind: 'tilt', div: d, end };
    }
    const tol = (touch ? 16 : 7) / view.cssPerIn;
    for (const d of lay.dividers) if (distToSeg(p, d.a, d.b) <= Math.max(tol, state.page.gap / 2)) return { kind: 'divider', div: d };
  }
  const leaf = lay.leaves.find((l) => pointInPoly(p, l.poly));
  return leaf ? { kind: 'leaf', leaf } : { kind: 'none' };
}

const layoutValid = () => pageLayout().leaves.every((l) => l.poly.length >= 3 && polyArea(l.poly) > 0.15);

function applyDividerChange(drag, wi, tilt) {
  const d = drag.div;
  const tilts = tiltsOf(d.node);
  const sum = drag.w0[d.index] + drag.w0[d.index + 1];
  d.node.weights[d.index] = wi;
  d.node.weights[d.index + 1] = sum - wi;
  if (tilt != null) tilts[d.index] = tilt;
  if (layoutValid()) {
    drag.last = { w: [...d.node.weights], t: [...tilts] };
  } else {
    d.node.weights = [...drag.last.w];
    d.node.tilts = [...drag.last.t];
  }
}

// Pointer interaction ------------------------------------------------------
let drag = null;
const pointers = new Map();
let lastTap = { id: null, wasSelected: false };
let lastTouchTap = { time: 0, x: 0, y: 0, id: null };
let lastPointerType = 'mouse';

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  closePicker();
  canvas.focus({ preventScroll: true });
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);

  if (pointers.size === 2 && drag?.kind === 'pan') {
    const [a, b] = [...pointers.values()];
    drag = { kind: 'pinch', leaf: drag.leaf, dist: Math.hypot(a.x - b.x, a.y - b.y), zoom0: drag.leaf.zoom, moved: true };
    return;
  }
  if (pointers.size > 1) return;

  const touch = e.pointerType !== 'mouse';
  lastPointerType = e.pointerType;
  const p = toInches(e);
  const hit = hitTest(p, touch);
  const start = { x: e.clientX, y: e.clientY };
  const now = performance.now();
  const second = touch && now - lastTouchTap.time < 320 && Math.hypot(e.clientX - lastTouchTap.x, e.clientY - lastTouchTap.y) < 40;
  if (second && hit.kind !== 'none' && hit.kind !== 'divider' && hit.kind !== 'tilt') {
    const leaf = leafById(lastTouchTap.id);
    if (leaf && imgFor(leaf)) {
      lastTouchTap.time = 0;
      drag = { kind: 'onezoom', leaf, zoom0: leaf.zoom, moved: false, start };
      return;
    }
  }
  if (hit.kind === 'chip') {
    drag = { kind: 'swap', leafId: hit.leaf.node.id, moved: false, start };
    canvas.style.cursor = 'grabbing';
  } else if (hit.kind === 'divider' || hit.kind === 'tilt') {
    const d = hit.div;
    const t0 = [...tiltsOf(d.node)];
    drag = { kind: hit.kind, div: d, end: hit.end, startP: p, w0: [...d.node.weights], last: { w: [...d.node.weights], t: t0 }, moved: false, start };
    ui.activeDivider = { node: d.node, index: d.index };
  } else if (hit.kind === 'leaf') {
    const leaf = hit.leaf.node;
    lastTap = { id: leaf.id, wasSelected: state.selectedId === leaf.id };
    selectLeaf(leaf.id);
    const img = imgFor(leaf);
    if (img) {
      drag = { kind: 'pan', leaf, startP: p, ox0: leaf.ox, oy0: leaf.oy, rect: hit.leaf.rect, img, moved: false, start };
      canvas.style.cursor = 'grabbing';
    } else {
      drag = { kind: 'tap', leaf, moved: false, start };
    }
  } else {
    selectLeaf(null);
    drag = null;
  }
  requestRender();
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const touch = e.pointerType !== 'mouse';

  if (!drag) {
    if (touch) return;
    const hit = hitTest(toInches(e), false);
    const hd = hit.kind === 'divider' || hit.kind === 'tilt' ? { node: hit.div.node, index: hit.div.index } : null;
    const changed = (hd?.node !== ui.hoverDivider?.node) || (hd?.index !== ui.hoverDivider?.index);
    ui.hoverDivider = hd;
    canvas.style.cursor = hit.kind === 'tilt' ? 'grab'
      : hit.kind === 'divider' ? (hit.div.horiz ? 'col-resize' : 'row-resize')
      : hit.kind === 'chip' ? 'grab' : hit.kind === 'leaf' && imgFor(hit.leaf.node) ? 'grab' : 'default';
    if (changed) requestRender();
    return;
  }

  if (Math.hypot(e.clientX - drag.start?.x, e.clientY - drag.start?.y) > 4) drag.moved = true;

  if (drag.kind === 'onezoom') {
    drag.leaf.zoom = clamp(drag.zoom0 * Math.exp((e.clientY - drag.start.y) / 160), 1, 6);
    renderCellPanelValuesSoon();
    requestRender();
  } else if (drag.kind === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    drag.leaf.zoom = clamp((drag.zoom0 * dist) / drag.dist, 1, 6);
    renderCellPanelValuesSoon();
    requestRender();
  } else if (drag.kind === 'pan') {
    const p = toInches(e);
    const { dw, dh } = photoMetrics(drag.leaf, drag.rect, drag.img.w, drag.img.h);
    const rx = Math.max(0, dw - drag.rect.w) / 2, ry = Math.max(0, dh - drag.rect.h) / 2;
    if (rx > 0) drag.leaf.ox = clamp(drag.ox0 + (p.x - drag.startP.x) / rx, -1, 1);
    if (ry > 0) drag.leaf.oy = clamp(drag.oy0 + (p.y - drag.startP.y) / ry, -1, 1);
    requestRender();
  } else if (drag.kind === 'divider') {
    const d = drag.div, p = toInches(e);
    const delta = (d.horiz ? p.x - drag.startP.x : p.y - drag.startP.y) / (d.span / d.total);
    const sum = drag.w0[d.index] + drag.w0[d.index + 1];
    const min = d.total * 0.05;
    let wi = clamp(drag.w0[d.index] + delta, min, sum - min);
    if (Math.abs(wi - sum / 2) < d.total * 0.02) wi = sum / 2;
    applyDividerChange(drag, wi, null);
    requestRender();
  } else if (drag.kind === 'tilt') {
    const d = drag.div, p = toInches(e);
    const uv = (pt) => (d.horiz ? { u: pt.x, v: pt.y } : { u: pt.y, v: pt.x });
    const O = uv(drag.end === 'a' ? d.b : d.a), E = uv(drag.end === 'a' ? d.a : d.b), P = uv(p);
    if (Math.abs(E.v - O.v) > 1e-6) {
      let t = clamp(-(P.u - O.u) / (E.v - O.v), -1.2, 1.2);
      if (Math.abs(t) < 0.025) t = 0;
      const c = O.u + t * (O.v - d.mid);
      const sum = drag.w0[d.index] + drag.w0[d.index + 1];
      const min = d.total * 0.05;
      const wi = clamp(drag.w0[d.index] + (c - d.center) / (d.span / d.total), min, sum - min);
      applyDividerChange(drag, wi, t);
      requestRender();
    }
  } else if (drag.kind === 'swap') {
    const hit = hitTest(toInches(e), touch, false);
    const id = hit.kind === 'leaf' && hit.leaf.node.id !== drag.leafId ? hit.leaf.node.id : null;
    if (id !== ui.dropId) { ui.dropId = id; requestRender(); }
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!drag) return;
  if (drag.kind === 'pinch') {
    if (pointers.size < 2) { commit(); drag = null; renderCellPanel(); }
    return;
  }
  const d = drag;
  drag = null;
  canvas.style.cursor = 'default';
  if (d.kind === 'onezoom') {
    if (!d.moved) d.leaf.zoom = d.leaf.zoom > 1.05 ? 1 : 2;
    if (d.leaf.zoom === 1) Object.assign(d.leaf, { ox: 0, oy: 0 });
    commit();
    renderCellPanelValuesSoon();
    requestRender();
    return;
  }
  if (e.pointerType !== 'mouse' && !d.moved && e.type === 'pointerup' && (d.kind === 'pan' || d.kind === 'tap')) {
    lastTouchTap = { time: performance.now(), x: e.clientX, y: e.clientY, id: d.leaf.id };
  }
  ui.activeDivider = null;
  if (d.kind === 'swap' && ui.dropId && e.type === 'pointerup') {
    const a = leafById(d.leafId), b = leafById(ui.dropId);
    if (a && b) { swapContent(a, b); state.selectedId = b.id; renderCellPanel(); commit(); }
  } else if (d.kind === 'tap' && !d.moved && lastTap.wasSelected && e.type === 'pointerup' && isEmptyLeaf(d.leaf)) {
    openFilePicker(d.leaf.id);
  } else if (d.moved) {
    commit();
    if (d.kind === 'pan') renderCellPanelValuesSoon();
  }
  ui.dropId = null;
  requestRender();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerenter', () => { ui.pointerInside = true; requestRender(); });
canvas.addEventListener('pointerleave', () => { ui.pointerInside = false; ui.hoverDivider = null; requestRender(); });

canvas.addEventListener('dblclick', (e) => {
  if (lastPointerType !== 'mouse') return;
  const hit = hitTest(toInches(e), false, false);
  if (hit.kind !== 'leaf') return;
  const leaf = hit.leaf.node;
  if (leaf.type === 'text') $('#cell-body textarea')?.focus();
  else openFilePicker(leaf.id);
});

canvas.addEventListener('wheel', (e) => {
  const hit = hitTest(toInches(e), false, false);
  if (hit.kind !== 'leaf' || !imgFor(hit.leaf.node)) return;
  e.preventDefault();
  const leaf = hit.leaf.node;
  leaf.zoom = clamp(leaf.zoom * Math.exp(-e.deltaY * 0.0015), 1, 6);
  requestRender();
  renderCellPanelValuesSoon();
  commitSoon();
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Selection --------------------------------------------------------------
const isCompact = () => window.matchMedia('(max-width: 960px)').matches;
function openSheet(mode) {
  document.body.dataset.sheet = mode;
  $('#sheet-title').textContent = mode === 'edit' ? 'Adjust cell' : 'More';
  $('.inspector').scrollTop = 0;
}
function closeSheet() {
  closePicker();
  delete document.body.dataset.sheet;
}
$('#more-btn').addEventListener('click', () => openSheet('more'));
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', closeSheet);

function selectLeaf(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  renderCellPanel();
  requestRender();
}

// Photos -----------------------------------------------------------------
async function decodeFull(file) {
  try {
    const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { src: b, w: b.width, h: b.height, close: () => b.close() };
  } catch { /* try next */ }
  try {
    const b = await createImageBitmap(file);
    return { src: b, w: b.width, h: b.height, close: () => b.close() };
  } catch { /* try img */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function loadPhoto(file, existing = null) {
  const bmp = await decodeFull(file);
  const sc = Math.min(1, 1800 / Math.max(bmp.w, bmp.h));
  const pc = document.createElement('canvas');
  pc.width = Math.max(1, Math.round(bmp.w * sc));
  pc.height = Math.max(1, Math.round(bmp.h * sc));
  const pctx = pc.getContext('2d');
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(bmp.src, 0, 0, pc.width, pc.height);
  const ts = 200 / Math.max(bmp.w, bmp.h);
  const tc = document.createElement('canvas');
  tc.width = Math.max(1, Math.round(bmp.w * ts));
  tc.height = Math.max(1, Math.round(bmp.h * ts));
  tc.getContext('2d').drawImage(pc, 0, 0, tc.width, tc.height);
  const rec = { id: existing?.id ?? uuid(), name: existing?.name ?? file.name, file, w: bmp.w, h: bmp.h, preview: pc, thumb: tc.toDataURL('image/jpeg', 0.8), removed: false, saved: !!existing };
  bmp.close();
  photos.set(rec.id, rec);
  return rec;
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif|avif)$/i.test(f.name));
  if (!files.length) return [];
  toast(`Loading ${files.length} photo${files.length > 1 ? 's' : ''}…`, 0);
  const out = [];
  let failed = 0;
  for (const f of files) {
    try { out.push(await loadPhoto(f)); } catch { failed++; }
  }
  renderTray();
  toast(failed ? `${failed} photo${failed > 1 ? 's' : ''} couldn’t be opened (HEIC works in Safari only).` : `Added ${out.length} photo${out.length > 1 ? 's' : ''}.`, 2500);
  return out;
}

function assignPhoto(leafId, photoId) {
  const l = leafById(leafId);
  if (!l) return;
  Object.assign(l, { type: 'photo', photoId, zoom: 1, ox: 0, oy: 0, rot: 0, text: null });
}

function placePhotos(records, startLeafId) {
  if (!records.length) return;
  const leaves = orderedLeaves();
  const queue = [...records];
  const first = startLeafId ? leafById(startLeafId) : null;
  if (first) {
    assignPhoto(first.id, queue.shift().id);
    selectLeaf(first.id);
  }
  for (const l of leaves) {
    if (!queue.length) break;
    if (l.id !== first?.id && isEmptyLeaf(l)) assignPhoto(l.id, queue.shift().id);
  }
  renderCellPanel();
  renderTray();
  requestRender();
  commit();
}

function autoFill() {
  const unused = [...photos.values()].filter((p) => !p.removed && !isUsed(p.id));
  if (!unused.length) return toast('No unused photos to place.');
  placePhotos(unused);
}

const fileInput = $('#file-input');
let pickerTarget = null;
function openFilePicker(leafId = null) {
  pickerTarget = leafId;
  fileInput.click();
}
fileInput.addEventListener('change', async () => {
  const target = pickerTarget;
  pickerTarget = null;
  const recs = await addFiles(fileInput.files);
  fileInput.value = '';
  if (target === 'wizard') { wz.recs.push(...recs); renderWizard(); return; }
  placePhotos(recs, target);
});

function renderTray() {
  const wrap = $('#thumbs');
  wrap.innerHTML = '';
  wrap.append(el('button', { type: 'button', class: 'thumb-add', 'aria-label': 'Add photos', onClick: () => openFilePicker(state.selectedId && isEmptyLeaf(selectedLeaf() ?? {}) ? state.selectedId : null) }, '+'));
  const list = [...photos.values()].filter((p) => !p.removed);
  $('#tray-empty').hidden = list.length > 0;
  for (const p of list) {
    const used = isUsed(p.id);
    const t = el('div', { class: 'thumb', draggable: 'true', title: p.name },
      el('img', { src: p.thumb, alt: p.name, draggable: 'false' }),
      used && el('span', { class: 'used' }, 'used'),
      el('button', { class: 'x', type: 'button', 'aria-label': `Remove ${p.name}`, onClick: (e) => {
        e.stopPropagation();
        p.removed = true;
        for (const l of orderedLeaves()) if (l.photoId === p.id) clearContent(l);
        renderTray(); renderCellPanel(); requestRender(); commit();
      } }, '×'));
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-collage-photo', p.id);
      e.dataTransfer.setData('text/plain', p.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    t.addEventListener('click', () => {
      let target = selectedLeaf();
      if (!target || target.type === 'text') target = orderedLeaves().find(isEmptyLeaf) ?? null;
      if (!target) return toast('Select a cell first, then tap a photo.');
      assignPhoto(target.id, p.id);
      selectLeaf(target.id);
      renderCellPanel(); renderTray(); requestRender(); commit();
    });
    wrap.append(t);
  }
}

$('#add-photos').addEventListener('click', () => openFilePicker(null));
$('#auto-fill').addEventListener('click', autoFill);

// Drag and drop of files / tray photos ---------------------------------------
function leafAtEvent(e) {
  const hit = hitTest(toInches(e), false, false);
  return hit.kind === 'leaf' ? hit.leaf.node : null;
}
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files') || [...(e.dataTransfer?.types ?? [])].includes('application/x-collage-photo');

canvas.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const id = leafAtEvent(e)?.id ?? null;
  if (id !== ui.dropId) { ui.dropId = id; requestRender(); }
});
canvas.addEventListener('dragleave', () => { ui.dropId = null; requestRender(); });
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const target = leafAtEvent(e);
  ui.dropId = null;
  requestRender();
  const id = e.dataTransfer.getData('application/x-collage-photo');
  if (id && photos.has(id) && target) {
    assignPhoto(target.id, id);
    selectLeaf(target.id);
    renderCellPanel(); renderTray(); requestRender(); commit();
    return;
  }
  const files = e.dataTransfer.files;
  if (files?.length) placePhotos(await addFiles(files), target?.id ?? null);
});

const trayDrop = $('#tray-drop');
trayDrop.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); trayDrop.classList.add('over'); } });
trayDrop.addEventListener('dragleave', () => trayDrop.classList.remove('over'));
trayDrop.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  trayDrop.classList.remove('over');
  if (e.dataTransfer.files?.length) placePhotos(await addFiles(e.dataTransfer.files));
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (document.body.dataset.view !== 'editor') return;
  if (e.dataTransfer?.files?.length) placePhotos(await addFiles(e.dataTransfer.files));
});
window.addEventListener('paste', async (e) => {
  if (document.body.dataset.view !== 'editor') return;
  if (/input|textarea/i.test(document.activeElement?.tagName)) return;
  if (e.clipboardData?.files?.length) placePhotos(await addFiles(e.clipboardData.files), state.selectedId);
});

// Page controls -------------------------------------------------------------------
const fmtIn = (v) => `${(+v).toFixed(2)} in`;

function buildPaperOptions() {
  const sel = $('#paper');
  for (const [w, h] of PAPER) sel.append(el('option', { value: `${w}x${h}` }, `${w} × ${h} in`));
  sel.append(el('option', { value: 'custom' }, 'Custom'));
}

function syncPageControls() {
  const p = state.page;
  const key = `${p.w}x${p.h}`;
  $('#paper').value = PAPER.some(([w, h]) => `${w}x${h}` === key) ? key : 'custom';
  $('#page-w').value = p.w;
  $('#page-h').value = p.h;
  for (const k of ['margin', 'gap', 'radius', 'border']) {
    $(`#${k}`).value = p[k] ?? 0;
    $(`#${k}-out`).textContent = fmtIn(p[k] ?? 0);
  }
  borderField.set(p.borderColor ?? '#111111');
  $('#dpi').value = String(p.dpi);
  $('#page-summary').textContent = `${p.w} × ${p.h} in`;
  bgField.set(p.bg);
  updateExportInfo();
}

function setPaper(w, h) {
  state.page.w = w;
  state.page.h = h;
  state.page.margin = Math.min(state.page.margin, Math.min(w, h) / 4);
  syncPageControls();
  resizeStage();
  commit();
}

let bgField, borderField;
function initPageControls() {
  buildPaperOptions();
  bgField = createColorField({
    value: state.page.bg, label: 'Background color',
    onInput: (v) => { state.page.bg = v; requestRender(); },
    onChange: () => commit(),
  });
  $('#page-bg-slot').append(bgField.el);

  $('#paper').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    const [w, h] = e.target.value.split('x').map(Number);
    setPaper(w, h);
  });
  const dimInput = (id, key) => $(id).addEventListener('change', (e) => {
    const v = clamp(parseFloat(e.target.value) || state.page[key], 1, 60);
    state.page[key] = v;
    syncPageControls();
    resizeStage();
    commit();
  });
  dimInput('#page-w', 'w');
  dimInput('#page-h', 'h');
  $('#swap-orient').addEventListener('click', () => setPaper(state.page.h, state.page.w));
  borderField = createColorField({
    value: '#111111', label: 'Border color',
    onInput: (v) => { state.page.borderColor = v; requestRender(); },
    onChange: () => commit(),
  });
  $('#border-color-slot').append(borderField.el);
  for (const k of ['margin', 'gap', 'radius', 'border']) {
    $(`#${k}`).addEventListener('input', (e) => {
      state.page[k] = +e.target.value;
      $(`#${k}-out`).textContent = fmtIn(state.page[k]);
      requestRender();
    });
    $(`#${k}`).addEventListener('change', commit);
  }
  $('#dpi').addEventListener('change', (e) => { state.page.dpi = +e.target.value; updateExportInfo(); commit(); });
  $('#format').addEventListener('change', (e) => {
    exportSettings.format = e.target.value;
    $('#quality-row').hidden = e.target.value !== 'jpeg';
  });
  $('#quality').addEventListener('input', (e) => {
    exportSettings.quality = +e.target.value;
    $('#quality-out').textContent = `${Math.round(exportSettings.quality * 100)}%`;
  });
  $('#quality-out').textContent = '95%';
}

function effectiveDpi() {
  const { w, h, dpi } = state.page;
  const W = w * dpi, H = h * dpi;
  const k = Math.min(1, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_PIXELS / (W * H)));
  return k < 1 ? { dpi: Math.max(72, Math.floor(dpi * k)), clamped: true } : { dpi, clamped: false };
}

function updateExportInfo() {
  const { w, h } = state.page;
  const { dpi, clamped } = effectiveDpi();
  const W = Math.round(w * dpi), H = Math.round(h * dpi);
  $('#export-info').textContent = `${W.toLocaleString()} × ${H.toLocaleString()} px · ${((W * H) / 1e6).toFixed(1)} MP · ${w} × ${h} in @ ${dpi} DPI` +
    (clamped ? ` — reduced from ${state.page.dpi} DPI, the most this ${IS_IOS ? 'device' : 'browser'} can render.` : '');
}

function drawLayoutThumb(g, tpl, rect, gap) {
  for (const { node, poly } of layoutTree(tpl.build(), rect, gap).leaves) {
    g.fillStyle = node.type === 'text' ? '#8f93e8' : tpl.comic ? '#b3b7ef' : '#c3c6f3';
    polyPath(g, poly, 0);
    g.fill();
  }
}

// Templates --------------------------------------------------------------------
function initTemplates() {
  const grid = $('#templates');
  for (const tpl of TEMPLATES) {
    const c = document.createElement('canvas');
    c.width = 60; c.height = 75;
    const g = c.getContext('2d');
    drawLayoutThumb(g, tpl, { x: 3, y: 3, w: 54, h: 69 }, 3);
    grid.append(el('button', { class: 'tpl', type: 'button', title: tpl.name, 'aria-label': tpl.name, onClick: () => {
      state.root = applyTemplate(state.root, tpl);
      if (!findNode(state.root, state.selectedId)) state.selectedId = null;
      renderCellPanel(); renderTray(); requestRender(); commit();
    } }, c));
  }
}

// Cell inspector -----------------------------------------------------------------
let panelValuesTimer = 0;
function renderCellPanelValuesSoon() {
  clearTimeout(panelValuesTimer);
  panelValuesTimer = setTimeout(() => {
    const l = selectedLeaf();
    const z = $('#zoom-input');
    if (l && z) { z.value = l.zoom; $('#zoom-input-out').textContent = `${Math.round(l.zoom * 100)}%`; }
    updateResolutionBadge();
  }, 30);
}

function sliderRow(label, { min, max, step, value, format }, onInput, onChange, id) {
  const out = el('output', { id: id && `${id}-out` }, format(value));
  const input = el('input', { type: 'range', min, max, step, id });
  input.value = value;
  input.addEventListener('input', () => { out.textContent = format(+input.value); onInput(+input.value); });
  input.addEventListener('change', () => onChange?.());
  return el('label', { class: 'row slider' }, el('span', { class: 'lbl' }, label), input, out);
}

function segmented(options, value, onPick) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  for (const [val, label, title] of options) {
    wrap.append(el('button', { type: 'button', title: title ?? label, 'aria-pressed': String(val === value), onClick: () => onPick(val) }, label));
  }
  return wrap;
}

function colorRow(label, value, onInput, onChange) {
  const f = createColorField({ value, label, onInput, onChange });
  return el('div', { class: 'row center' }, el('span', { class: 'lbl' }, label), f.el);
}

function updateResolutionBadge() {
  const badge = $('#res-badge');
  const l = selectedLeaf();
  if (!badge || !l || l.type !== 'photo') return;
  const p = photos.get(l.photoId);
  const found = pageLayout().leaves.find((x) => x.node.id === l.id);
  if (!p || !found) return;
  const { s } = photoMetrics(l, found.rect, p.w, p.h);
  const ppi = Math.round(1 / s);
  const cls = ppi >= 200 ? 'res-good' : ppi >= 120 ? 'res-ok' : 'res-low';
  badge.className = `res-badge ${cls}`;
  badge.textContent = `${ppi} PPI in print${ppi < 150 ? ' · may look soft' : ''}`;
}

function renderCellBar(leaf) {
  const bar = $('#cellbar');
  bar.innerHTML = '';
  bar.hidden = !leaf;
  if (!leaf) return;
  const change = () => { renderCellPanel(); requestRender(); renderTray(); commit(); };
  const btn = (label, onClick, cls = 'btn') => el('button', { class: cls, type: 'button', onClick }, label);
  const hasPhoto = leaf.type === 'photo' && photos.has(leaf.photoId);
  const multiple = orderedLeaves().length > 1;
  const split = (dir) => { const r = splitLeaf(state.root, leaf.id, dir); state.root = r.root; state.selectedId = r.newId; change(); };
  if (hasPhoto) {
    bar.append(btn('Adjust…', () => openSheet('edit'), 'btn primary'), btn('Replace', () => openFilePicker(leaf.id)),
      btn('⟳ Rotate', () => { leaf.rot = (leaf.rot + 90) % 360; change(); }),
      btn(leaf.fit === 'fit' ? 'Fill' : 'Fit', () => { leaf.fit = leaf.fit === 'fit' ? 'fill' : 'fit'; change(); }));
  } else if (leaf.type === 'text') {
    bar.append(btn('Edit text…', () => { openSheet('edit'); setTimeout(() => $('#cell-body textarea')?.focus(), 250); }, 'btn primary'));
  } else {
    bar.append(btn('+ Photo', () => openFilePicker(leaf.id), 'btn primary'),
      btn('+ Text', () => { Object.assign(leaf, { type: 'text', photoId: null, text: leaf.text ?? defaultText() }); change(); }));
  }
  bar.append(btn('Split ↔', () => split('h')), btn('Split ↕', () => split('v')));
  if (leaf.type !== 'empty') bar.append(btn('Clear', () => { clearContent(leaf); change(); }));
  if (multiple) bar.append(btn('Delete', () => { const r = removeLeaf(state.root, leaf.id); state.root = r.root; state.selectedId = r.next ?? null; change(); }, 'btn danger'));
}

function renderCellPanel() {
  renderCellBar(selectedLeaf());
  const body = $('#cell-body');
  closePicker();
  body.innerHTML = '';
  const leaf = selectedLeaf();
  if (!leaf) {
    body.append(el('p', { class: 'muted' }, 'Tap a cell on the page to add a photo or text, split it, or change its settings.'));
    return;
  }
  const change = () => { renderCellPanel(); requestRender(); renderTray(); commit(); };
  const multiple = orderedLeaves().length > 1;

  body.append(el('div', { class: 'btn-row' },
    el('button', { class: 'btn', type: 'button', onClick: () => openFilePicker(leaf.id) }, leaf.type === 'photo' && photos.has(leaf.photoId) ? 'Replace photo' : '+ Photo'),
    leaf.type !== 'text' && el('button', { class: 'btn', type: 'button', onClick: () => { Object.assign(leaf, { type: 'text', photoId: null, text: leaf.text ?? defaultText() }); change(); } }, '+ Text'),
    el('button', { class: 'btn', type: 'button', title: 'Split side by side', onClick: () => { const r = splitLeaf(state.root, leaf.id, 'h'); state.root = r.root; selectLeaf(r.newId); change(); } }, 'Split ↔'),
    el('button', { class: 'btn', type: 'button', title: 'Split top and bottom', onClick: () => { const r = splitLeaf(state.root, leaf.id, 'v'); state.root = r.root; selectLeaf(r.newId); change(); } }, 'Split ↕'),
    leaf.type !== 'empty' && el('button', { class: 'btn', type: 'button', onClick: () => { clearContent(leaf); change(); } }, 'Clear'),
    multiple && el('button', { class: 'btn danger', type: 'button', onClick: () => {
      const r = removeLeaf(state.root, leaf.id);
      state.root = r.root; state.selectedId = r.next ?? null; change();
    } }, 'Delete cell')));

  if (leaf.type === 'photo' && photos.has(leaf.photoId)) {
    body.append(el('div', { class: 'row center' }, el('span', { id: 'res-badge' })));
    body.append(sliderRow('Zoom', { min: 1, max: 6, step: 0.01, value: leaf.zoom, format: (v) => `${Math.round(v * 100)}%` },
      (v) => { leaf.zoom = v; requestRender(); updateResolutionBadge(); }, commit, 'zoom-input'));
    body.append(el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', onClick: () => { leaf.rot = (leaf.rot + 270) % 360; change(); } }, '⟲ Rotate'),
      el('button', { class: 'btn', type: 'button', onClick: () => { leaf.rot = (leaf.rot + 90) % 360; change(); } }, '⟳ Rotate'),
      el('button', { class: 'btn', type: 'button', onClick: () => { Object.assign(leaf, { zoom: 1, ox: 0, oy: 0 }); change(); } }, 'Reset crop'),
      segmented([['fill', 'Fill'], ['fit', 'Fit']], leaf.fit, (v) => { leaf.fit = v; change(); })));
    if (leaf.fit === 'fit') body.append(colorRow('Fill color', leaf.bg, (v) => { leaf.bg = v; requestRender(); }, commit));
    updateResolutionBadge();
  }

  if (leaf.type === 'text') renderTextControls(body, leaf, change);
}

function renderTextControls(body, leaf, change) {
  const t = leaf.text;
  const live = () => { requestRender(); };
  const ta = el('textarea', { rows: 3, 'aria-label': 'Text', placeholder: 'Type your text…' });
  ta.value = t.value;
  ta.addEventListener('input', () => { t.value = ta.value; live(); commitSoon(); });
  body.append(el('label', {}, 'Text', ta));

  const fonts = el('div', { class: 'fonts' });
  for (const f of FONTS) {
    fonts.append(el('button', { class: 'font-btn', type: 'button', title: f.name, 'aria-pressed': String(t.font === f.name), onClick: () => { t.font = f.name; change(); } },
      el('span', { class: 'aa', style: `font-family:"${f.name}",${f.fallback}` }, 'Aa'),
      el('small', {}, f.name)));
  }
  body.append(el('div', { class: 'lbl', style: 'margin:8px 0 6px;color:var(--muted);font-size:12px' }, 'Font'), fonts);

  const toggle = (label, key, title) => el('button', { class: 'btn', type: 'button', title, 'aria-pressed': String(t[key]), style: t[key] ? 'background:var(--accent-soft);color:var(--accent);font-weight:700' : '', onClick: () => { t[key] = !t[key]; change(); } }, label);
  body.append(el('div', { class: 'btn-row' },
    toggle('B', 'bold', 'Bold'), toggle('I', 'italic', 'Italic'),
    segmented([['left', '⇤', 'Align left'], ['center', '↔', 'Center'], ['right', '⇥', 'Align right']], t.align, (v) => { t.align = v; change(); }),
    segmented([['top', '⤒', 'Top'], ['middle', '↕', 'Middle'], ['bottom', '⤓', 'Bottom']], t.valign, (v) => { t.valign = v; change(); })));

  const auto = el('input', { type: 'checkbox', id: 'auto-size' });
  auto.checked = t.auto;
  auto.addEventListener('change', () => { t.auto = auto.checked; change(); });
  body.append(el('label', { class: 'row center', style: 'color:var(--text)' }, auto, ' Auto-fit text to the cell'));
  if (!t.auto) body.append(sliderRow('Size', { min: 3, max: 100, step: 1, value: t.size, format: (v) => `${v}%` }, (v) => { t.size = v; live(); }, commit));

  body.append(colorRow('Text color', t.color, (v) => { t.color = v; live(); }, commit));
  body.append(colorRow('Box color', t.bg, (v) => { t.bg = v; live(); }, commit));
  body.append(sliderRow('Letter space', { min: -0.05, max: 0.5, step: 0.01, value: t.spacing, format: (v) => `${v.toFixed(2)} em` }, (v) => { t.spacing = v; live(); }, commit));
  body.append(sliderRow('Line height', { min: 0.8, max: 2, step: 0.05, value: t.lineHeight, format: (v) => v.toFixed(2) }, (v) => { t.lineHeight = v; live(); }, commit));
  body.append(sliderRow('Padding', { min: 0, max: 30, step: 1, value: t.pad, format: (v) => `${v}%` }, (v) => { t.pad = v; live(); }, commit));
}

// Export -------------------------------------------------------------------------
let exporting = false;
async function exportImage() {
  if (exporting) return;
  exporting = true;
  const btns = [$('#download'), $('#download-top')];
  btns.forEach((b) => (b.disabled = true));
  try {
    const { w, h, margin, gap, radius, bg } = state.page;
    const { dpi } = effectiveDpi();
    const W = Math.round(w * dpi), H = Math.round(h * dpi);
    const png = exportSettings.format === 'png';
    const mime = png ? 'image/png' : 'image/jpeg';
    toast(`Rendering ${W.toLocaleString()} × ${H.toLocaleString()} px…`, 0);
    await new Promise((r) => setTimeout(r, 30));

    await Promise.all(orderedLeaves().filter((l) => l.type === 'text').map((l) => document.fonts.load(fontString(l.text, 40), l.text.value).catch(() => {})));

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (!g) throw new Error('canvas');
    if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }
    g.fillStyle = toCss(bg);
    g.fillRect(0, 0, W, H);
    const lay = layoutTree(state.root, { x: margin, y: margin, w: w - margin * 2, h: h - margin * 2 }, gap);
    for (const item of lay.leaves) {
      const { node } = item;
      const cell = scaleCell(item, dpi);
      const p = node.type === 'photo' ? photos.get(node.photoId) : null;
      if (p) {
        const full = await decodeFull(p.file);
        drawLeaf(g, node, cell, radius * dpi, full, borderAt(dpi));
        full.close();
      } else {
        drawLeaf(g, node, cell, radius * dpi, null, borderAt(dpi));
      }
    }
    let blob = await new Promise((res) => c.toBlob(res, mime, exportSettings.quality));
    c.width = c.height = 1;
    if (!blob) throw new Error('encode');
    blob = await withDpi(blob, mime, dpi);
    const slug = (project.name || 'collage').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collage';
    const name = `${slug}-${w}x${h}in-${dpi}dpi.${png ? 'png' : 'jpg'}`;
    const file = new File([blob], name, { type: mime });
    if (IS_IOS && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Collage' });
        toast('Done — choose “Save Image” to keep it in Photos.');
        return;
      } catch (err) {
        if (err?.name === 'AbortError') { toast('Cancelled.'); return; }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`Saved ${name}`);
  } catch (err) {
    console.error(err);
    toast('Couldn’t render that size. Try a lower DPI or a smaller print.', 6000);
  } finally {
    exporting = false;
    btns.forEach((b) => (b.disabled = false));
  }
}
$('#download').addEventListener('click', exportImage);
$('#download-top').addEventListener('click', exportImage);

// Keyboard -----------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    if (typing && tag === 'TEXTAREA') return;
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selectedLeaf()) {
    e.preventDefault();
    clearContent(selectedLeaf());
    renderCellPanel(); renderTray(); requestRender(); commit();
  } else if (e.key === 'Escape' && document.body.dataset.sheet) {
    closeSheet();
  } else if (e.key === 'Escape' && !typing) {
    selectLeaf(null);
  }
});
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);


// Saving ---------------------------------------------------------------------------
let saveTimer = 0;
const setStatus = (t) => { $('#save-status').textContent = t; };

function scheduleSave() {
  if (!project.id || !storageOk) return;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

function renderThumb() {
  const { w, h, bg, radius } = state.page;
  const ppi = 420 / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * ppi));
  c.height = Math.max(1, Math.round(h * ppi));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = toCss(bg);
  g.fillRect(0, 0, c.width, c.height);
  for (const item of pageLayout().leaves) drawLeaf(g, item.node, scaleCell(item, ppi), radius * ppi, imgFor(item.node), borderAt(ppi));
  return c.toDataURL('image/jpeg', 0.82);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!project.id || !storageOk) return;
  try {
    for (const p of photos.values()) {
      const keep = !p.removed || isUsed(p.id);
      if (keep && !p.saved) {
        await store.putPhoto({ id: p.id, projectId: project.id, name: p.name, file: p.file, w: p.w, h: p.h });
        p.saved = true;
      } else if (!keep && p.saved) {
        await store.deletePhoto(p.id);
        p.saved = false;
      }
    }
    await store.putProject({
      id: project.id, name: project.name, created: project.created, updated: Date.now(),
      page: state.page, root: state.root, thumb: renderThumb(),
    });
    setStatus('Saved');
    navigator.storage?.persist?.();
  } catch (err) {
    console.error(err);
    storageOk = false;
    setStatus('');
    toast('Couldn’t save in this browser (private mode or storage full). Download your collage before leaving.', 7000);
  }
}
window.addEventListener('pagehide', () => { if (project.id) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && project.id) saveNow(); });

// Views ----------------------------------------------------------------------------
function resetHistory() {
  history.stack = [];
  history.index = -1;
  commit();
}

function showView(v, { push = true } = {}) {
  document.body.dataset.view = v;
  if (v === 'editor' && push && project.id) {
    const url = `#c/${project.id}`;
    if (window.history.state?.view === 'editor') window.history.replaceState({ view: 'editor' }, '', url);
    else window.history.pushState({ view: 'editor' }, '', url);
  }
  closePicker();
  closeSheet();
  if (v === 'editor') { resizeStage(); } else { renderHome(); }
}

async function goHome(fromHistory = false) {
  clearTimeout(commitTimer);
  if (project.id) { commit(); await saveNow(); }
  project.id = null;
  showView('home');
  if (!fromHistory && window.history.state?.view === 'editor') window.history.back();
  else if (location.hash) window.history.replaceState(null, '', location.pathname + location.search);
}
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#c\/(.+)$/);
  if (m && document.body.dataset.view === 'home') {
    window.history.replaceState(null, '', location.pathname + location.search);
    openProject(decodeURIComponent(m[1]));
  }
});
window.addEventListener('popstate', () => {
  if (document.body.dataset.sheet) closeSheet();
  if (document.body.dataset.view === 'editor' && window.history.state?.view !== 'editor') goHome(true);
});

let homeToken = 0;
async function renderHome() {
  const token = ++homeToken;
  const grid = $('#project-grid');
  let list = [];
  try { list = await store.listProjects(); } catch { storageOk = false; }
  if (token !== homeToken) return;
  grid.innerHTML = '';
  $('#home-empty').hidden = list.length > 0;
  $('#home-note').hidden = list.length === 0 && storageOk;
  if (!storageOk) $('#home-note').textContent = 'Saving isn’t available in this browser, so collages can’t be kept between visits. You can still create and download them.';
  for (const pr of list) {
    const when = new Date(pr.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    grid.append(el('div', { class: 'project-card' },
      el('button', { class: 'project-thumb', type: 'button', 'aria-label': `Open ${pr.name}`, onClick: () => openProject(pr.id) }, el('img', { src: pr.thumb, alt: '' })),
      el('div', { class: 'project-meta' }, el('b', {}, pr.name || 'Untitled collage'), el('span', {}, `${pr.page.w} × ${pr.page.h} in · ${when}`)),
      el('div', { class: 'project-actions' },
        el('button', { class: 'btn', type: 'button', onClick: () => openProject(pr.id) }, 'Open'),
        el('button', { class: 'btn primary', type: 'button', onClick: async () => { await openProject(pr.id); exportImage(); } }, 'Download'),
        el('button', { class: 'btn danger', type: 'button', 'aria-label': `Delete ${pr.name}`, onClick: async () => {
          if (!confirm(`Delete “${pr.name || 'Untitled collage'}”? This can’t be undone.`)) return;
          await store.deleteProject(pr.id);
          renderHome();
        } }, 'Delete'))));
  }
}

async function openProject(id) {
  const rec = await store.getProject(id);
  if (!rec) return toast('That collage could not be found.');
  toast('Opening…', 0);
  photos.clear();
  const saved = await store.getPhotos(id);
  for (const sp of saved) {
    try { await loadPhoto(sp.file, sp); } catch { /* skip unreadable photo */ }
  }
  Object.assign(project, { id: rec.id, name: rec.name, created: rec.created });
  state.page = rec.page;
  state.root = rec.root;
  state.selectedId = null;
  $('#project-name').value = project.name;
  $('#dpi').value = String(state.page.dpi);
  showView('editor');
  syncPageControls();
  renderCellPanel();
  renderTray();
  resetHistory();
  setStatus('Saved');
  toast('', 1);
}

// Guided flow ------------------------------------------------------------------------
const wizard = $('#wizard');
const wz = { step: 1, maxStep: 1, w: 8, h: 10, tpl: 'grid-2x2', recs: [], margin: 0.24, gap: 0.1, radius: 0, bg: '#ffffff', border: 0, borderColor: '#111111', borderTouched: false, spacingFor: null };
const defaultSpacing = (w, h) => { const m = Math.min(w, h); return { margin: Math.min(0.5, Math.round(m * 3) / 100), gap: Math.round(m * 1.2) / 100 }; };
const SIZE_LABELS = { '4x6': 'Standard print', '6x4': 'Standard print', '5x7': 'Small frame', '7x5': 'Small frame', '8x10': 'Classic frame', '10x8': 'Classic frame', '8x8': 'Square', '11x14': 'Large frame', '14x11': 'Large frame', '16x20': 'Poster', '20x16': 'Poster' };

function startWizard() {
  Object.assign(wz, { step: 1, maxStep: 1, recs: [], radius: 0, bg: '#ffffff', border: 0, borderColor: '#111111', borderTouched: false, spacingFor: null });
  photos.clear();
  wizard.hidden = false;
  renderWizard();
}
const closeWizard = () => { wizard.hidden = true; };

function renderWizard() {
  const body = $('#wz-body');
  body.innerHTML = '';
  const titles = ['Pick a print size', 'Set spacing and background', 'Choose a layout', 'Add your photos'];
  $('#wz-title').textContent = titles[wz.step - 1];
  $('#wz-steps').innerHTML = '';
  ['Size', 'Style', 'Layout', 'Photos'].forEach((label, i) => {
    const n = i + 1;
    const cls = n === wz.step ? 'on' : n <= wz.maxStep ? 'done' : '';
    const text = `${n}. ${label}`;
    $('#wz-steps').append(el('li', { class: cls },
      n !== wz.step && n <= wz.maxStep ? el('button', { type: 'button', onClick: () => goStep(n) }, text) : text));
  });
  $('#wz-back').hidden = wz.step === 1;
  $('#wz-skip').hidden = wz.step !== 4;
  $('#wz-next').textContent = wz.step === 4 ? (wz.recs.length ? 'Create collage' : 'Create empty collage') : 'Next';

  if (wz.step === 1) {
    const grid = el('div', { class: 'size-grid' });
    for (const [w, h] of PAPER) {
      const k = `${w}x${h}`, scale = 62 / Math.max(w, h);
      grid.append(el('button', { class: 'size-card', type: 'button', 'aria-pressed': String(wz.w === w && wz.h === h), onClick: () => { wz.w = w; wz.h = h; renderWizard(); } },
        el('div', { class: 'size-shape' }, el('span', { style: `width:${w * scale}px;height:${h * scale}px` })),
        el('b', {}, `${w} × ${h}`), el('small', {}, SIZE_LABELS[k])));
    }
    body.append(grid);
    const isCustom = !PAPER.some(([w, h]) => w === wz.w && h === wz.h);
    const wi = el('input', { type: 'number', min: 1, max: 60, step: 0.25 }), hi = el('input', { type: 'number', min: 1, max: 60, step: 0.25 });
    wi.value = wz.w; hi.value = wz.h;
    const upd = () => { wz.w = clamp(+wi.value || wz.w, 1, 60); wz.h = clamp(+hi.value || wz.h, 1, 60); renderWizard(); };
    wi.addEventListener('change', upd); hi.addEventListener('change', upd);
    body.append(el('div', { class: 'custom-size' }, el('label', {}, 'Custom width (in)', wi), el('label', {}, 'Height (in)', hi),
      isCustom && el('span', { class: 'muted' }, 'Custom size selected')));
  } else if (wz.step === 2) {
    const prev = document.createElement('canvas');
    const drawPrev = () => {
      const k = 190 / Math.max(wz.w, wz.h), dpr = 2;
      prev.width = Math.round(wz.w * k * dpr); prev.height = Math.round(wz.h * k * dpr);
      prev.style.width = `${prev.width / dpr}px`; prev.style.height = `${prev.height / dpr}px`;
      const g = prev.getContext('2d');
      g.fillStyle = toCss(wz.bg); g.fillRect(0, 0, prev.width, prev.height);
      const tpl = TEMPLATES.find((t) => t.id === wz.tpl) ?? TEMPLATES.find((t) => t.id === 'grid-2x2');
      const lay = layoutTree(tpl.build(), { x: wz.margin, y: wz.margin, w: wz.w - wz.margin * 2, h: wz.h - wz.margin * 2 }, wz.gap);
      const px = k * dpr;
      for (const item of lay.leaves) {
        const cell = scaleCell(item, px);
        polyPath(g, cell.poly, wz.radius * px);
        g.fillStyle = '#b7bbf0';
        g.fill();
        drawLeaf(g, { type: 'empty' }, cell, wz.radius * px, null, { width: wz.border * px, color: wz.borderColor });
      }
    };
    const bg = createColorField({ value: wz.bg, label: 'Background color', onInput: (v) => { wz.bg = v; drawPrev(); }, onChange: (v) => { wz.bg = v; drawPrev(); } });
    const sl = (label, key, max, step = 0.01) => sliderRow(label, { min: 0, max, step, value: wz[key], format: fmtIn }, (v) => { wz[key] = v; if (key === 'border') wz.borderTouched = true; drawPrev(); });
    const bc = createColorField({ value: wz.borderColor, label: 'Border color', onInput: (v) => { wz.borderColor = v; drawPrev(); }, onChange: (v) => { wz.borderColor = v; drawPrev(); } });
    body.append(el('div', { class: 'style-wrap' },
      el('div', {}, sl('Outer margin', 'margin', 1), sl('Gap between', 'gap', 0.6), sl('Corner radius', 'radius', 0.6),
        el('div', { class: 'row center' }, el('span', { class: 'lbl' }, 'Background'), bg.el),
        sl('Panel border', 'border', 0.12, 0.005),
        el('div', { class: 'row center' }, el('span', { class: 'lbl' }, 'Border color'), bc.el),
        el('p', { class: 'muted' }, 'You can change these any time from Page settings in the editor.')),
      el('div', { class: 'style-preview' }, prev)));
    drawPrev();
  } else if (wz.step === 3) {
    const grid = el('div', { class: 'lay-grid' });
    const tw = 84, th = Math.round(clamp(tw * (wz.h / wz.w), 50, 130)), tw2 = Math.round(th * (wz.w / wz.h));
    for (const tpl of TEMPLATES) {
      const c = document.createElement('canvas');
      c.width = tw2 * 2; c.height = th * 2;
      c.style.width = `${tw2}px`; c.style.height = `${th}px`;
      const g = c.getContext('2d');
      g.scale(2, 2);
      g.fillStyle = '#fff'; g.fillRect(0, 0, tw2, th);
      drawLayoutThumb(g, tpl, { x: 4, y: 4, w: tw2 - 8, h: th - 8 }, 3);
      g.strokeStyle = '#d4d6de'; g.strokeRect(0.5, 0.5, tw2 - 1, th - 1);
      grid.append(el('button', { class: 'lay-card', type: 'button', 'aria-pressed': String(wz.tpl === tpl.id), onClick: () => { wz.tpl = tpl.id; renderWizard(); } }, c, el('small', {}, tpl.name)));
    }
    body.append(grid);
  } else {
    const zone = el('div', { class: 'add-zone' },
      el('p', {}, 'Choose photos from your library, or drag them in. They’ll fill your layout automatically — you can swap and adjust everything next.'),
      el('button', { class: 'btn primary big', type: 'button', onClick: () => openFilePicker('wizard') }, wz.recs.length ? 'Add more photos' : 'Add photos'));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); zone.classList.remove('over');
      wz.recs.push(...(await addFiles(e.dataTransfer.files)));
      renderWizard();
    });
    body.append(zone);
    if (wz.recs.length) body.append(el('div', { class: 'wz-thumbs' }, wz.recs.map((r) => el('img', { src: r.thumb, alt: r.name }))));
    const need = orderedCountFor(wz.tpl);
    body.append(el('p', { class: 'muted' }, `${wz.recs.length} photo${wz.recs.length === 1 ? '' : 's'} added · this layout has ${need} cell${need === 1 ? '' : 's'}.`));
  }
}
const orderedCountFor = (id) => collectLeaves(TEMPLATES.find((t) => t.id === id).build()).filter((l) => l.type !== 'text').length;

async function finishWizard() {
  const { w, h } = wz;
  const tpl = TEMPLATES.find((t) => t.id === wz.tpl);
  Object.assign(project, { id: uuid(), name: `${w} × ${h} collage`, created: Date.now() });
  const border = tpl.comic && !wz.borderTouched ? 0.03 : wz.border;
  state.page = { w, h, dpi: 300, margin: wz.margin, gap: wz.gap, radius: wz.radius, bg: wz.bg, border, borderColor: wz.borderColor };
  state.root = tpl.build();
  state.selectedId = null;
  $('#project-name').value = project.name;
  closeWizard();
  showView('editor');
  syncPageControls();
  renderCellPanel();
  renderTray();
  resetHistory();
  placePhotos(wz.recs);
  await saveNow();
}

function goStep(n) {
  if (wz.step === 1) {
    const key = `${wz.w}x${wz.h}`;
    if (wz.spacingFor !== key) { Object.assign(wz, defaultSpacing(wz.w, wz.h)); wz.spacingFor = key; }
  }
  wz.step = n;
  wz.maxStep = Math.max(wz.maxStep, n);
  renderWizard();
}
$('#wz-next').addEventListener('click', () => { if (wz.step < 4) goStep(wz.step + 1); else finishWizard(); });
$('#wz-skip').addEventListener('click', () => { wz.recs = []; photos.clear(); finishWizard(); });
$('#wz-back').addEventListener('click', () => goStep(wz.step - 1));
$('#wz-close').addEventListener('click', closeWizard);
wizard.addEventListener('pointerdown', (e) => { if (e.target === wizard) closeWizard(); });
for (const id of ['#new-collage', '#new-empty']) $(id).addEventListener('click', startWizard);
const pageModal = $('#page-modal');
const closePageModal = () => { closePicker(); pageModal.hidden = true; };
$('#open-page-settings').addEventListener('click', () => { pageModal.hidden = false; });
$('#page-done').addEventListener('click', closePageModal);
$('#page-close').addEventListener('click', closePageModal);
pageModal.addEventListener('pointerdown', (e) => { if (e.target === pageModal) closePageModal(); });
$('#go-home').addEventListener('click', goHome);
$('#brand').addEventListener('click', () => { if (document.body.dataset.view === 'editor') goHome(); });
$('#project-name').addEventListener('input', (e) => { project.name = e.target.value; scheduleSave(); });

// Boot ---------------------------------------------------------------------------
initPageControls();
initTemplates();
syncPageControls();
renderCellPanel();
renderTray();
commit();
new ResizeObserver(resizeStage).observe($('#stage-inner'));
window.addEventListener('resize', resizeStage);
document.fonts?.ready.then(requestRender);
const startHash = location.hash.match(/^#c\/(.+)$/);
if (startHash) window.history.replaceState(null, '', location.pathname + location.search);
store.isAvailable().then((ok) => {
  storageOk = ok;
  if (ok && startHash) openProject(decodeURIComponent(startHash[1]));
  else showView('home');
});
showView('home');

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (IS_IOS && !standalone && localStorage.getItem('collage.installHint') !== 'dismissed') $('#install-hint').hidden = false;
$('#install-dismiss').addEventListener('click', () => {
  $('#install-hint').hidden = true;
  try { localStorage.setItem('collage.installHint', 'dismissed'); } catch { /* storage unavailable */ }
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});

window.__collage = { state, photos, addFiles, placePhotos, orderedLeaves, project };
