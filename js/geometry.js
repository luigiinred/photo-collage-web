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

export const split = (dir, children, weights) => ({
  id: newId(),
  dir,
  children,
  weights: weights ? [...weights] : children.map(() => 1),
});

export const isLeaf = (n) => !n.children;

export function collectLeaves(node, out = []) {
  if (isLeaf(node)) out.push(node);
  else node.children.forEach((c) => collectLeaves(c, out));
  return out;
}

export function layoutTree(root, rect, gap) {
  const leaves = [];
  const dividers = [];
  const walk = (node, r) => {
    if (isLeaf(node)) {
      leaves.push({ node, rect: r });
      return;
    }
    const horiz = node.dir === 'h';
    const n = node.children.length;
    const total = node.weights.reduce((a, b) => a + b, 0);
    const span = (horiz ? r.w : r.h) - gap * (n - 1);
    let pos = horiz ? r.x : r.y;
    node.children.forEach((child, i) => {
      const size = (span * node.weights[i]) / total;
      walk(child, horiz ? { x: pos, y: r.y, w: size, h: r.h } : { x: r.x, y: pos, w: r.w, h: size });
      pos += size;
      if (i < n - 1) {
        dividers.push({
          node,
          index: i,
          horiz,
          center: pos + gap / 2,
          from: horiz ? r.y : r.x,
          to: horiz ? r.y + r.h : r.x + r.w,
          span,
          total,
        });
        pos += gap;
      }
    });
  };
  walk(root, rect);
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
const H = (kids, w) => split('h', kids, w);
const V = (kids, w) => split('v', kids, w);
const grid = (cols, rows) => V(Array.from({ length: rows }, () => H(Array.from({ length: cols }, L))));

export const TEMPLATES = [
  { id: 'single', name: 'Single', build: () => L() },
  { id: 'two-cols', name: 'Two across', build: () => H([L(), L()]) },
  { id: 'two-rows', name: 'Two stacked', build: () => V([L(), L()]) },
  { id: 'three-cols', name: 'Three across', build: () => H([L(), L(), L()]) },
  { id: 'three-rows', name: 'Three stacked', build: () => V([L(), L(), L()]) },
  { id: 'grid-2x2', name: '2 × 2 grid', build: () => grid(2, 2) },
  { id: 'grid-2x3', name: '2 × 3 grid', build: () => grid(2, 3) },
  { id: 'grid-3x3', name: '3 × 3 grid', build: () => grid(3, 3) },
  { id: 'hero-left', name: 'Hero + 2', build: () => H([L(), V([L(), L()])], [2, 1]) },
  { id: 'hero-top', name: 'Hero + 3', build: () => V([L(), H([L(), L(), L()])], [2, 1]) },
  { id: 'feature-3', name: 'Feature + 3', build: () => H([L(), V([L(), L(), L()])], [2, 1]) },
  { id: 'hero-grid', name: 'Hero + 4', build: () => H([L(), grid(2, 2)]) },
  { id: 'mosaic', name: 'Mosaic', build: () => H([V([L(), L()]), L(), V([L(), L()])], [1, 1.4, 1]) },
  { id: 'caption', name: 'Photo + caption', build: () => V([L(), textLeaf('Caption')], [6, 1]) },
  { id: 'strip-4', name: 'Photo strip', build: () => V([L(), L(), L(), L()]) },
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
