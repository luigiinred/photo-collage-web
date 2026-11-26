import { clamp, parseHex, toHex, toCss, rgbToHsv, hsvToRgb } from './color.js';

const PALETTE = [
  '#ffffff', '#f7f3ea', '#e5e7eb', '#9ca3af', '#4b5563', '#1f2430', '#000000', '#00000000',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e', '#7c2d12', '#064e3b',
  '#fecaca', '#fed7aa', '#fef3c7', '#d9f99d', '#bbf7d0', '#bae6fd', '#c7d2fe', '#fbcfe8',
];
const RECENT_KEY = 'collage.recentColors';

const recents = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
};
const pushRecent = (hex) => {
  try {
    const list = [hex, ...recents().filter((c) => c !== hex)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
};

function dragArea(el, fn, onEnd) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    move(e);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

let closeCurrent = null;
export const closePicker = () => closeCurrent?.();

export function openPicker(anchor, value, onInput, onChange) {
  closePicker();
  const start = parseHex(value) || { r: 0, g: 0, b: 0, a: 1 };
  let { h, s, v } = rgbToHsv(start.r, start.g, start.b);
  let a = start.a;
  let dirty = false;

  const pop = document.createElement('div');
  pop.className = 'cp';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Color picker');
  pop.innerHTML = `
    <div class="cp-sv"><div class="cp-thumb"></div></div>
    <div class="cp-row">
      <div class="cp-preview"><span></span></div>
      <div class="cp-sliders">
        <div class="cp-hue"><div class="cp-thumb"></div></div>
        <div class="cp-alpha"><span class="cp-alpha-fill"></span><div class="cp-thumb"></div></div>
      </div>
      <button type="button" class="cp-eye" title="Pick a color from the screen" aria-label="Eyedropper">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/></svg>
      </button>
    </div>
    <div class="cp-inputs">
      <label>Hex <input class="cp-hex" spellcheck="false" maxlength="9"></label>
      <label>Opacity <input class="cp-opacity" type="number" min="0" max="100" step="1"> %</label>
    </div>
    <div class="cp-label">Swatches</div>
    <div class="cp-swatches"></div>
    <div class="cp-label cp-recent-label">Recent</div>
    <div class="cp-swatches cp-recent"></div>`;
  document.body.append(pop);

  const $ = (sel) => pop.querySelector(sel);
  const svEl = $('.cp-sv'), hueEl = $('.cp-hue'), alphaEl = $('.cp-alpha');
  const hexEl = $('.cp-hex'), opEl = $('.cp-opacity');

  const current = () => toHex({ ...hsvToRgb(h, s, v), a });

  const paint = (skipHex) => {
    const rgb = hsvToRgb(h, s, v);
    const solid = `rgb(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)})`;
    svEl.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${h},100%,50%))`;
    const sv = svEl.querySelector('.cp-thumb');
    sv.style.left = `${s * 100}%`;
    sv.style.top = `${(1 - v) * 100}%`;
    sv.style.background = solid;
    hueEl.querySelector('.cp-thumb').style.left = `${(h / 360) * 100}%`;
    hueEl.querySelector('.cp-thumb').style.background = `hsl(${h},100%,50%)`;
    alphaEl.querySelector('.cp-alpha-fill').style.background = `linear-gradient(to right,transparent,${solid})`;
    alphaEl.querySelector('.cp-thumb').style.left = `${a * 100}%`;
    pop.querySelector('.cp-preview span').style.background = toCss(current());
    if (!skipHex) hexEl.value = current();
    opEl.value = Math.round(a * 100);
  };

  const emit = () => {
    dirty = true;
    paint();
    onInput?.(current());
  };
  const commit = () => {
    if (!dirty) return;
    pushRecent(current());
    onChange?.(current());
    dirty = false;
  };

  const setFromHex = (hex, final) => {
    const c = parseHex(hex);
    if (!c) return false;
    ({ h: h, s, v } = (() => {
      const o = rgbToHsv(c.r, c.g, c.b);
      return { h: o.s === 0 || o.v === 0 ? h : o.h, s: o.s, v: o.v };
    })());
    a = c.a;
    emit();
    if (final) commit();
    return true;
  };

  dragArea(svEl, (x, y) => { s = x; v = 1 - y; emit(); }, commit);
  dragArea(hueEl, (x) => { h = x * 360; emit(); }, commit);
  dragArea(alphaEl, (x) => { a = Math.round(x * 100) / 100; emit(); }, commit);

  hexEl.addEventListener('input', () => {
    const c = parseHex(hexEl.value);
    if (!c) return;
    const o = rgbToHsv(c.r, c.g, c.b);
    h = o.s === 0 || o.v === 0 ? h : o.h; s = o.s; v = o.v; a = c.a;
    dirty = true;
    paint(true);
    onInput?.(current());
  });
  hexEl.addEventListener('change', () => { commit(); paint(); });
  opEl.addEventListener('input', () => { a = clamp(+opEl.value || 0, 0, 100) / 100; emit(); });
  opEl.addEventListener('change', commit);

  const eye = $('.cp-eye');
  if ('EyeDropper' in window) {
    eye.addEventListener('click', async () => {
      try {
        const res = await new window.EyeDropper().open();
        setFromHex(res.sRGBHex, true);
      } catch { /* cancelled */ }
    });
  } else {
    eye.hidden = true;
  }

  const fillSwatches = (container, list) => {
    container.innerHTML = '';
    for (const hex of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-swatch';
      b.title = hex;
      b.setAttribute('aria-label', hex);
      b.innerHTML = `<span style="background:${toCss(hex)}"></span>`;
      b.addEventListener('click', () => setFromHex(hex, true));
      container.append(b);
    }
  };
  fillSwatches($('.cp-swatches'), PALETTE);
  const rec = recents();
  fillSwatches($('.cp-recent'), rec);
  if (!rec.length) {
    $('.cp-recent').hidden = true;
    $('.cp-recent-label').hidden = true;
  }

  paint();

  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hgt = pop.offsetHeight;
    let left = rect.left - w - 12;
    if (left < 8) left = clamp(rect.left, 8, window.innerWidth - w - 8);
    const top = clamp(rect.top - 20, 8, Math.max(8, window.innerHeight - hgt - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };
  place();

  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    commit();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    pop.remove();
    closeCurrent = null;
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  closeCurrent = close;
}

export function createColorField({ value, onInput, onChange, label }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'color-field';
  btn.innerHTML = '<span class="cf-swatch"><span class="cf-fill"></span></span><span class="cf-hex"></span>';
  if (label) btn.setAttribute('aria-label', label);
  const fill = btn.querySelector('.cf-fill');
  const hex = btn.querySelector('.cf-hex');
  let current = value;
  const set = (v) => {
    current = v;
    fill.style.background = toCss(v);
    hex.textContent = v.toUpperCase();
  };
  btn.addEventListener('click', () =>
    openPicker(btn, current, (v) => { set(v); onInput?.(v); }, (v) => { set(v); onChange?.(v); }),
  );
  set(value);
  return { el: btn, set };
}
