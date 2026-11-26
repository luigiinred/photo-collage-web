let counter = 0;
export const newId = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

export function defaultText() {
  return {
    value: 'Your text',
    font: 'Playfair Display',
    size: 28,
    auto: true,
    color: '#1f2430',
    bg: '#ffffff',
    bold: false,
    italic: false,
    align: 'center',
    valign: 'middle',
    spacing: 0,
    lineHeight: 1.15,
    pad: 8,
  };
}

export const CONTENT_KEYS = ['type', 'photoId', 'zoom', 'ox', 'oy', 'rot', 'fit', 'bg', 'text'];

export const leaf = (extra = {}) => ({
  id: newId(),
  type: 'empty',
  photoId: null,
  zoom: 1,
  ox: 0,
  oy: 0,
  rot: 0,
  fit: 'fill',
  bg: '#00000000',
  text: null,
  ...extra,
});

export const textLeaf = (value = 'Caption') => leaf({ type: 'text', text: { ...defaultText(), value } });

export const split = (dir, children, weights, tilts) => ({
  id: newId(),
  dir,
  children,
  weights: weights ? [...weights] : children.map(() => 1),
  tilts: tilts ? [...tilts] : children.slice(1).map(() => 0),
});

export const tiltsOf = (node) => {
  const n = node.children.length - 1;
  if (!Array.isArray(node.tilts) || node.tilts.length !== n) {
    node.tilts = Array.from({ length: n }, (_, i) => node.tilts?.[i] ?? 0);
  }
  return node.tilts;
};

export const isLeaf = (n) => !n.children;

export function collectLeaves(node, out = []) {
  if (isLeaf(node)) out.push(node);
  else node.children.forEach((c) => collectLeaves(c, out));
  return out;
}

// Polygon helpers ---------------------------------------------------------
export function bboxOf(poly) {
  if (!poly.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const b = bboxOf(poly);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPoly(pt, poly) {
  if (poly.length < 3) return false;
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const c = (q.x - p.x) * (pt.y - p.y) - (q.y - p.y) * (pt.x - p.x);
    if (c > 1e-9) pos = true;
    else if (c < -1e-9) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

// Keeps the side where nx*x + ny*y <= c.
function clipHalf(poly, nx, ny, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nx * a.x + ny * a.y - c;
    const db = nx * b.x + ny * b.y - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function lineInPoly(poly, P, d) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = { x: b.x - a.x, y: b.y - a.y };
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const w = { x: a.x - P.x, y: a.y - P.y };
    const s = (w.x * e.y - w.y * e.x) / den;
    const u = (w.x * d.y - w.y * d.x) / den;
    if (u >= -1e-9 && u <= 1 + 1e-9) { lo = Math.min(lo, s); hi = Math.max(hi, s); }
  }
  if (!Number.isFinite(lo)) return [P, P];
  return [{ x: P.x + d.x * lo, y: P.y + d.y * lo }, { x: P.x + d.x * hi, y: P.y + d.y * hi }];
}

function innerRect(poly, bb) {
  if (poly.length < 3) return bb;
  const c = centroid(poly);
  const fits = (k) => {
    const w = (bb.w * k) / 2, h = (bb.h * k) / 2;
    return [[-w, -h], [w, -h], [w, h], [-w, h]].every(([dx, dy]) => pointInPoly({ x: c.x + dx, y: c.y + dy }, poly));
  };
  let lo = 0, hi = 1;
  if (fits(1)) lo = 1;
  else for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
  return { x: c.x - (bb.w * lo) / 2, y: c.y - (bb.h * lo) / 2, w: bb.w * lo, h: bb.h * lo };
}

const rectPoly = (r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];

// A split's divider i is the line u = center - tilt * (v - mid), where u runs along the
// split axis and v across it; tilt is a slope, so angles survive page resizes.
export function layoutTree(root, rect, gap) {
  const leaves = [];
  const dividers = [];
  const walk = (node, poly) => {
    const bb = bboxOf(poly);
    if (isLeaf(node)) {
      leaves.push({ node, poly, rect: bb, inner: innerRect(poly, bb) });
      return;
    }
    const horiz = node.dir === 'h';
    const n = node.children.length;
    const tilts = node.tilts ?? [];
    const total = node.weights.reduce((x, y) => x + y, 0);
    const span = (horiz ? bb.w : bb.h) - gap * (n - 1);
    const mid = horiz ? bb.y + bb.h / 2 : bb.x + bb.w / 2;
    let pos = horiz ? bb.x : bb.y;
    const lines = [];
    for (let i = 0; i < n - 1; i++) {
      pos += (span * node.weights[i]) / total;
      const c = pos + gap / 2;
      pos += gap;
      const t = tilts[i] ?? 0;
      const len = Math.hypot(1, t);
      const P = horiz ? { x: c, y: mid } : { x: mid, y: c };
      const d = horiz ? { x: -t, y: 1 } : { x: 1, y: -t };
      const nrm = horiz ? { x: 1 / len, y: t / len } : { x: t / len, y: 1 / len };
      lines.push({ c, t, P, d, nrm, k: nrm.x * P.x + nrm.y * P.y });
    }
    node.children.forEach((child, i) => {
      let p = poly;
      if (i > 0) { const L = lines[i - 1]; p = clipHalf(p, -L.nrm.x, -L.nrm.y, -(L.k + gap / 2)); }
      if (i < n - 1) { const L = lines[i]; p = clipHalf(p, L.nrm.x, L.nrm.y, L.k - gap / 2); }
      walk(child, p);
    });
    lines.forEach((L, i) => {
      const [a, b] = lineInPoly(poly, L.P, L.d);
      dividers.push({ node, index: i, horiz, center: L.c, tilt: L.t, mid, a, b, span, total });
    });
  };
  walk(root, rectPoly(rect));
  return { leaves, dividers };
}

export function findNode(root, id) {
  let result = null;
  const walk = (node, parent, index) => {
    if (node.id === id) {
      result = { node, parent, index };
      return true;
    }
    return node.children ? node.children.some((c, i) => walk(c, node, i)) : false;
  };
  walk(root, null, -1);
  return result;
}

const firstLeaf = (n) => (isLeaf(n) ? n : firstLeaf(n.children[0]));

export function splitLeaf(root, id, dir) {
  const found = findNode(root, id);
  if (!found) return { root, newId: null };
  const { node, parent, index } = found;
  const fresh = leaf();
  if (parent && parent.dir === dir) {
    const w = parent.weights[index];
    parent.weights[index] = w / 2;
    tiltsOf(parent).splice(index, 0, 0);
    parent.children.splice(index + 1, 0, fresh);
    parent.weights.splice(index + 1, 0, w / 2);
    return { root, newId: fresh.id };
  }
  const container = split(dir, [node, fresh]);
  if (!parent) return { root: container, newId: fresh.id };
  parent.children[index] = container;
  return { root, newId: fresh.id };
}

export function removeLeaf(root, id) {
  const found = findNode(root, id);
  if (!found || !found.parent) return { root, removed: false };
  const { parent, index } = found;
  const w = parent.weights[index];
  tiltsOf(parent).splice(Math.max(0, index - 1), 1);
  parent.children.splice(index, 1);
  parent.weights.splice(index, 1);
  const neighbor = Math.max(0, index - 1);
  parent.weights[neighbor] += w;
  let next = firstLeaf(parent.children[neighbor]).id;
  if (parent.children.length === 1) {
    const only = parent.children[0];
    next = firstLeaf(only).id;
    const gp = findNode(root, parent.id);
    if (!gp.parent) return { root: only, removed: true, next };
    if (only.children && only.dir === gp.parent.dir) {
      const wp = gp.parent.weights[gp.index];
      const sum = only.weights.reduce((a, b) => a + b, 0);
      tiltsOf(gp.parent).splice(gp.index, 0, ...tiltsOf(only));
      gp.parent.children.splice(gp.index, 1, ...only.children);
      gp.parent.weights.splice(gp.index, 1, ...only.weights.map((x) => (x / sum) * wp));
    } else {
      gp.parent.children[gp.index] = only;
    }
  }
  return { root, removed: true, next };
}

export function swapContent(a, b) {
  for (const k of CONTENT_KEYS) {
    const t = a[k];
    a[k] = b[k];
    b[k] = t;
  }
}

export function clearContent(l) {
  Object.assign(l, leaf(), { id: l.id });
}

// Templates -----------------------------------------------------------
const L = () => leaf();
const H = (kids, w, t) => split('h', kids, w, t);
const V = (kids, w, t) => split('v', kids, w, t);
const grid = (cols, rows) => V(Array.from({ length: rows }, () => H(Array.from({ length: cols }, L))));

export const TEMPLATES = [
  { id: 'single', name: 'Single', build: () => L() },
  { id: 'duo', name: 'Duo 60/40', build: () => H([L(), L()], [3, 2]) },
  { id: 'grid-2x2', name: 'Classic 2 × 2', build: () => grid(2, 2) },
  { id: 'offset-2x2', name: 'Offset four', build: () => V([H([L(), L()], [2, 1]), H([L(), L()], [1, 2])]) },
  { id: 'magazine', name: 'Magazine', build: () => H([L(), V([L(), L()], [3, 2])], [3, 2]) },
  { id: 'hero-strip', name: 'Hero + strip', build: () => V([L(), H([L(), L(), L(), L()])], [3, 1]) },
  { id: 'center-hero', name: 'Center hero', build: () => H([V([L(), L()], [3, 2]), L(), V([L(), L()], [2, 3])], [1, 2, 1]) },
  { id: 'staggered', name: 'Staggered five', build: () => H([V([L(), L()], [3, 2]), V([L(), L(), L()], [2, 3, 2])]) },
  { id: 'gallery', name: 'Gallery six', build: () => V([H([L(), L(), L()], [2, 1, 1]), H([L(), L(), L()], [1, 1, 2])]) },
  { id: 'caption', name: 'Photo + caption', build: () => V([L(), textLeaf('Caption')], [7, 1]) },
  { id: 'slash', name: 'Diagonal duo', comic: true, build: () => H([L(), L()], [1, 1], [0.45]) },
  { id: 'comic-strip', name: 'Comic strip', comic: true, build: () => H([L(), L(), L()], [1, 1, 1], [0.12, -0.1]) },
  { id: 'impact', name: 'Impact', comic: true, build: () => H([L(), V([L(), L()], [1, 1], [-0.22])], [3, 2], [0.16]) },
  { id: 'shards', name: 'Shards', comic: true, build: () => V([H([L(), L()], [3, 2], [0.3]), H([L(), L(), L()], [2, 3, 2], [-0.25, 0.2])], [1, 1], [0.08]) },
  { id: 'comic-page', name: 'Comic page', comic: true, build: () => V([
    H([L(), L()], [3, 2], [0.14]),
    H([L(), L(), L()], [1, 1, 1], [-0.1, 0.1]),
    H([L(), L()], [2, 3], [0.14]),
  ], [1, 1, 1], [0.04, -0.04]) },
];

export function applyTemplate(oldRoot, tpl) {
  const old = collectLeaves(oldRoot);
  const root = tpl.build();
  collectLeaves(root).forEach((l, i) => {
    if (old[i] && l.type !== 'text') {
      for (const k of CONTENT_KEYS) l[k] = structuredClone(old[i][k]);
    }
  });
  return root;
}
