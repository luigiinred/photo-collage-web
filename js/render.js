import { toCss, alphaOf } from './color.js';

export const FONTS = [
  { name: 'Playfair Display', fallback: 'serif' },
  { name: 'Lora', fallback: 'serif' },
  { name: 'Abril Fatface', fallback: 'serif' },
  { name: 'Montserrat', fallback: 'sans-serif' },
  { name: 'Inter', fallback: 'sans-serif' },
  { name: 'Oswald', fallback: 'sans-serif' },
  { name: 'Bebas Neue', fallback: 'sans-serif' },
  { name: 'Pacifico', fallback: 'cursive' },
  { name: 'Dancing Script', fallback: 'cursive' },
  { name: 'Great Vibes', fallback: 'cursive' },
  { name: 'Caveat', fallback: 'cursive' },
  { name: 'Permanent Marker', fallback: 'cursive' },
  { name: 'Georgia', fallback: 'serif' },
  { name: 'Courier New', fallback: 'monospace' },
];

const fallbackFor = (name) => FONTS.find((f) => f.name === name)?.fallback ?? 'sans-serif';

export function fontString(t, px) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${px}px "${t.font}", ${fallbackFor(t.font)}`;
}

export function rrPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (!r) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const scaleRect = (r, k) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });

export function photoMetrics(leaf, rect, imgW, imgH) {
  const rot = ((leaf.rot % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const rw = swap ? imgH : imgW;
  const rh = swap ? imgW : imgH;
  const base = leaf.fit === 'fit' ? Math.min(rect.w / rw, rect.h / rh) : Math.max(rect.w / rw, rect.h / rh);
  const s = base * leaf.zoom;
  return { s, dw: rw * s, dh: rh * s, rot };
}

function drawPhotoCell(ctx, leaf, r, radius, img) {
  ctx.save();
  rrPath(ctx, r.x, r.y, r.w, r.h, radius);
  ctx.clip();
  if (alphaOf(leaf.bg) > 0) {
    ctx.fillStyle = toCss(leaf.bg);
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  const { s, dw, dh, rot } = photoMetrics(leaf, r, img.w, img.h);
  const cx = r.x + r.w / 2 + (leaf.ox * Math.max(0, dw - r.w)) / 2;
  const cy = r.y + r.h / 2 + (leaf.oy * Math.max(0, dh - r.h)) / 2;
  ctx.translate(cx, cy);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.src, (-img.w * s) / 2, (-img.h * s) / 2, img.w * s, img.h * s);
  ctx.restore();
}

function wrapLines(ctx, text, maxW, breakLong) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (let word of words) {
      const test = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(test).width <= maxW) {
        line = test;
        if (breakLong && !line.includes(' ')) {
          while (ctx.measureText(line).width > maxW && line.length > 1) {
            let i = line.length - 1;
            while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
            out.push(line.slice(0, i));
            line = line.slice(i);
          }
        }
      } else {
        out.push(line);
        line = word;
        if (breakLong) {
          while (ctx.measureText(line).width > maxW && line.length > 1) {
            let i = line.length - 1;
            while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
            out.push(line.slice(0, i));
            line = line.slice(i);
          }
        }
      }
    }
    out.push(line);
  }
  return out;
}

function setSpacing(ctx, t, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${t.spacing * px}px`;
}

function layoutText(ctx, t, innerW, innerH, short) {
  const fits = (px) => {
    ctx.font = fontString(t, px);
    setSpacing(ctx, t, px);
    const lines = wrapLines(ctx, t.value, innerW, false);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
    return { ok: widest <= innerW + 0.5 && lines.length * px * t.lineHeight <= innerH, lines };
  };
  if (!t.auto) {
    const px = (short * t.size) / 100;
    ctx.font = fontString(t, px);
    setSpacing(ctx, t, px);
    return { px, lines: wrapLines(ctx, t.value, innerW, true) };
  }
  let lo = 4, hi = Math.max(8, innerH);
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid).ok) lo = mid;
    else hi = mid;
  }
  const res = fits(lo);
  return { px: lo, lines: res.lines };
}

function drawTextCell(ctx, leaf, r, radius) {
  const t = leaf.text;
  if (!t) return;
  ctx.save();
  rrPath(ctx, r.x, r.y, r.w, r.h, radius);
  ctx.clip();
  if (alphaOf(t.bg) > 0) {
    ctx.fillStyle = toCss(t.bg);
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  const short = Math.min(r.w, r.h);
  const pad = (short * t.pad) / 100;
  const iw = Math.max(1, r.w - pad * 2);
  const ih = Math.max(1, r.h - pad * 2);
  const { px, lines } = layoutText(ctx, t, iw, ih, short);
  const lh = px * t.lineHeight;
  const total = lines.length * lh;
  let y = r.y + pad;
  if (t.valign === 'middle') y = r.y + (r.h - total) / 2;
  else if (t.valign === 'bottom') y = r.y + r.h - pad - total;
  let x = r.x + pad;
  if (t.align === 'center') x = r.x + r.w / 2;
  else if (t.align === 'right') x = r.x + r.w - pad;
  ctx.fillStyle = toCss(t.color);
  ctx.textAlign = t.align;
  ctx.textBaseline = 'middle';
  ctx.font = fontString(t, px);
  setSpacing(ctx, t, px);
  lines.forEach((line, i) => ctx.fillText(line, x, y + lh * i + lh / 2));
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.restore();
}

export function drawLeaf(ctx, leaf, r, radius, img) {
  if (leaf.type === 'text') drawTextCell(ctx, leaf, r, radius);
  else if (leaf.type === 'photo' && img) drawPhotoCell(ctx, leaf, r, radius, img);
}

// Preview-only overlay -------------------------------------------------
export const chipRect = (r, d = 1) => ({ x: r.x + 6 * d, y: r.y + 6 * d, w: 26 * d, h: 26 * d });

const ACCENT = '#5b5bd6';

export function drawOverlay(ctx, lay, ui) {
  const d = ui.dpr;
  for (const { node, rect } of lay.leaves) {
    const r = scaleRect(rect, ui.ppi);
    if (ui.isEmpty(node)) {
      ctx.save();
      rrPath(ctx, r.x, r.y, r.w, r.h, ui.radius);
      ctx.fillStyle = 'rgba(91,91,214,0.07)';
      ctx.fill();
      ctx.setLineDash([6 * d, 5 * d]);
      ctx.lineWidth = 1.5 * d;
      ctx.strokeStyle = 'rgba(91,91,214,0.55)';
      ctx.stroke();
      ctx.setLineDash([]);
      const s = Math.min(r.w, r.h);
      if (s > 40 * d) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const arm = Math.min(12 * d, s * 0.1);
        ctx.lineWidth = 2 * d;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy - arm * 0.6);
        ctx.lineTo(cx + arm, cy - arm * 0.6);
        ctx.moveTo(cx, cy - arm * 1.6);
        ctx.lineTo(cx, cy + arm * 0.4);
        ctx.stroke();
        ctx.font = `${12 * d}px Inter, system-ui, sans-serif`;
        const label = 'Drop a photo or tap to add';
        if (ctx.measureText(label).width < r.w - 12 * d && s > 110 * d) {
          ctx.fillStyle = 'rgba(60,60,140,0.8)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, cx, cy + arm + 14 * d);
        }
      }
      ctx.restore();
    }
    if (ui.dropId === node.id) {
      ctx.save();
      rrPath(ctx, r.x, r.y, r.w, r.h, ui.radius);
      ctx.fillStyle = 'rgba(91,91,214,0.25)';
      ctx.fill();
      ctx.lineWidth = 3 * d;
      ctx.strokeStyle = ACCENT;
      ctx.stroke();
      ctx.restore();
    }
  }

  const sel = lay.leaves.find((l) => l.node.id === ui.selectedId);
  if (sel) {
    const r = scaleRect(sel.rect, ui.ppi);
    ctx.save();
    rrPath(ctx, r.x, r.y, r.w, r.h, ui.radius);
    ctx.lineWidth = 2.5 * d;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
    if (!ui.isEmpty(sel.node)) {
      const c = chipRect(r, d);
      rrPath(ctx, c.x, c.y, c.w, c.h, 7 * d);
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 3; j++) {
          ctx.beginPath();
          ctx.arc(c.x + c.w / 2 + (i - 0.5) * 6 * d, c.y + c.h / 2 + (j - 1) * 6 * d, 1.7 * d, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  for (const dv of lay.dividers) {
    const active = ui.activeDivider && ui.activeDivider.node === dv.node && ui.activeDivider.index === dv.index;
    const hover = ui.hoverDivider && ui.hoverDivider.node === dv.node && ui.hoverDivider.index === dv.index;
    if (!active && !hover && !ui.pointerInside) continue;
    const c = dv.center * ui.ppi;
    const a = dv.from * ui.ppi, b = dv.to * ui.ppi;
    const mid = (a + b) / 2;
    const len = Math.min(40 * d, (b - a) * 0.6);
    const hot = active || hover;
    ctx.save();
    if (hot) {
      ctx.fillStyle = 'rgba(91,91,214,0.3)';
      const thick = Math.max(ui.gap * ui.ppi, 4 * d);
      if (dv.horiz) ctx.fillRect(c - thick / 2, a, thick, b - a);
      else ctx.fillRect(a, c - thick / 2, b - a, thick);
    }
    const w = 6 * d;
    if (dv.horiz) rrPath(ctx, c - w / 2, mid - len / 2, w, len, 3 * d);
    else rrPath(ctx, mid - len / 2, c - w / 2, len, w, 3 * d);
    ctx.fillStyle = hot ? ACCENT : 'rgba(30,30,50,0.35)';
    ctx.fill();
    ctx.lineWidth = 1 * d;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.restore();
  }
}
