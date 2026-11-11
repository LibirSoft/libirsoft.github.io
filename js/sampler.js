// Turns DOM elements into target points for particles, in DOCUMENT coordinates
// (viewport rect + scroll), so formations stay glued to the page while it scrolls.

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Shuffle a flat [x0,y0,x1,y1,...] array in place, pairwise. Any prefix is then a uniform subsample. */
export function shufflePairs(a) {
  for (let i = a.length / 2 - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const ax = a[2 * i], ay = a[2 * i + 1];
    a[2 * i] = a[2 * j]; a[2 * i + 1] = a[2 * j + 1];
    a[2 * j] = ax; a[2 * j + 1] = ay;
  }
  return a;
}

function docRect(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
}

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" → [r, g, b, a] in 0..1. */
function parseColor(str) {
  const m = str && str.match(/[\d.]+/g);
  if (!m || m.length < 3) return [1, 1, 1, 1];
  return [m[0] / 255, m[1] / 255, m[2] / 255, m.length > 3 ? +m[3] : 1];
}

/** One entry per word: what to draw and where (viewport coords), and how it is styled. */
function wordRuns(el, exclude) {
  const runs = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const styles = new Map(), links = new Map();
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent) continue;
    if (exclude && parent.closest(exclude)) continue;
    if (!/\S/.test(node.textContent)) continue;
    // text inside a scroll box (the code sample) only counts where it is actually visible
    const clipEl = parent.closest('pre');
    const clip = clipEl ? clipEl.getBoundingClientRect() : null;
    let st = styles.get(parent);
    if (!st) {
      const cs = getComputedStyle(parent);
      st = {
        hidden: cs.display === 'none' || cs.visibility === 'hidden',
        font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
        size: parseFloat(cs.fontSize) || 16,
        upper: cs.textTransform === 'uppercase',
        spacing: cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing,
        color: parseColor(cs.color),
        ul: null,
      };
      // an underline belongs to the link, not to the text node's own parent
      const link = parent.closest('a');
      if (link) {
        if (!links.has(link)) {
          const ls = getComputedStyle(link);
          links.set(link, ls.textDecorationLine.includes('underline') ? parseColor(ls.textDecorationColor) : null);
        }
        st.ul = links.get(link);
      }
      styles.set(parent, st);
    }
    if (st.hidden) continue;
    const text = node.textContent;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const push = (txt, r) => {
        if (!r || r.width < 1) return;
        if (clip && (r.right > clip.right - 4 || r.left < clip.left)) return;
        runs.push({
          text: st.upper ? txt.toLocaleUpperCase('en') : txt,
          font: st.font, spacing: st.spacing, size: st.size, color: st.color, ul: st.ul,
          left: r.left, top: r.top, right: r.right, bottom: r.bottom, base: r.bottom,
        });
      };
      if (rects.length === 1) { push(m[0], rects[0]); continue; }
      // the word wraps (after a hyphen, usually): one run per line, split where the line changes
      const word = m[0];
      let start = 0, prevTop = null;
      for (let k = 0; k <= word.length; k++) {
        let top = null;
        if (k < word.length) {
          range.setStart(node, m.index + k); range.setEnd(node, m.index + k + 1);
          const cr = range.getClientRects()[0];
          top = cr ? cr.top : prevTop;
        }
        if (k === word.length || (prevTop !== null && top !== null && Math.abs(top - prevTop) > 3)) {
          range.setStart(node, m.index + start); range.setEnd(node, m.index + k);
          push(word.slice(start, k), range.getClientRects()[0]);
          start = k;
        }
        if (top !== null) prevTop = top;
      }
    }
  }
  return runs;
}

let scratch;
function scratchCtx(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  return scratch.getContext('2d', { willReadFrequently: true });
}

/** Draw an element's text exactly where the browser laid it out and read the pixels back. */
function rasterText(el, exclude, scale) {
  const runs = wordRuns(el, exclude);
  if (!runs.length) return null;
  const pad = 6;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of runs) {
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad);
  const w = Math.ceil(x1 + pad - x0), h = Math.ceil(y1 + pad - y0);
  if (w <= 0 || h <= 0) return null;
  // small text is rasterised at 2x so thin strokes survive the alpha threshold
  while (scale > 1 && w * h * scale * scale > 24e6) scale -= 0.5;
  const W = Math.ceil(w * scale), H = Math.ceil(h * scale);
  if (W * H > 24e6) return null;

  const ctx = scratchCtx(W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const r of runs) {
    ctx.font = r.font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = r.spacing;
    const m = ctx.measureText(r.text);
    // A text range's client rect is the font's content area: top + ascent = baseline.
    const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    r.base = r.top + ascent;
    ctx.fillText(r.text, r.left - x0, r.base - y0);
  }
  return { runs, data: ctx.getImageData(0, 0, W, H).data, W, H, x0, y0, w, h, scale };
}

/**
 * Rasterise an element's text, then pick points on a jittered, staggered grid so that
 * roughly `desired` points land inside the glyphs.
 * Returns { points: Float32Array (doc coords), step }.
 */
export function sampleText(el, desired, minStep = 1.8, { exclude = null, scale = 1 } = {}) {
  const R = desired >= 1 ? rasterText(el, exclude, scale) : null;
  if (!R) return { points: new Float32Array(0), step: minStep };
  const { data, W, H, x0, y0, w, h } = R;
  scale = R.scale;
  let filled = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 110) filled++;
  if (!filled) return { points: new Float32Array(0), step: minStep };
  filled /= scale * scale;

  const step = Math.max(minStep, Math.sqrt(filled / desired) * 0.97);
  const jitter = step * 0.32;
  const out = [];
  const ox = x0 + window.scrollX, oy = y0 + window.scrollY;
  let row = 0;
  for (let y = step * 0.5; y < h; y += step * 0.866, row++) {
    const shift = row & 1 ? step * 0.5 : 0;
    for (let x = step * 0.5 + shift; x < w; x += step) {
      const jx = x + (Math.random() - 0.5) * jitter;
      const jy = y + (Math.random() - 0.5) * jitter;
      const ix = (jx * scale) | 0, iy = (jy * scale) | 0;
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      if (data[(iy * W + ix) * 4 + 3] > 110) out.push(ox + jx, oy + jy);
    }
  }
  return { points: shufflePairs(Float32Array.from(out)), step };
}

/* ───────────────────────────── ink ───────────────────────────── */

// Ink is the page's readable layer. It is not an approximation of the text in dots: it is
// the text's own antialiased bitmap, one dot per pixel that has any ink in it, each dot
// carrying that pixel's coverage. Drawn back as small overlapping gaussians, the dots
// reproduce the bitmap (so at rest it reads as ordinary type) and every one of them is
// still free to be pulled away.

/** Each dot's share of the light: with sigma = 0.45 pitch, a field of them then sums to 1. */
const AMP = 0.79;

/** Packs dots for the renderer, 16 bytes each: x, y (float32), r, g, b, a, radius, random (bytes). */
export class InkWriter {
  constructor(cap = 16384) {
    this.count = 0;
    this.grow(cap);
  }
  grow(cap) {
    const buf = new ArrayBuffer(cap * 16);
    const u8 = new Uint8Array(buf);
    if (this.u8) u8.set(this.u8.subarray(0, this.count * 16));
    this.cap = cap; this.u8 = u8; this.f32 = new Float32Array(buf);
  }
  /** rgb 0..1, a 0..1 (already including coverage), radius in px. */
  dot(x, y, r, g, b, a, radius) {
    if (this.count === this.cap) this.grow(this.cap * 2);
    const n = this.count++, o = n * 16;
    this.f32[n * 4] = x; this.f32[n * 4 + 1] = y;
    const u8 = this.u8;
    u8[o + 8] = r * 255; u8[o + 9] = g * 255; u8[o + 10] = b * 255;
    u8[o + 11] = a >= 1 ? 255 : a * 255;
    u8[o + 12] = radius >= 6.3 ? 255 : radius * 40;
    u8[o + 13] = Math.random() * 256;
  }
}

/**
 * An element's text as ink. `pitch` is the size of one dot cell in CSS px (one screen
 * pixel, normally). `screen: true` keeps viewport coordinates (for the fixed top bar).
 */
export function sampleInk(el, out, { exclude = null, screen = false, pitch = 1 } = {}) {
  const R = rasterText(el, exclude, 1 / pitch);
  if (!R) return out;
  const { runs, data, W, H, x0, y0, scale } = R;
  const sx0 = screen ? 0 : window.scrollX, sy0 = screen ? 0 : window.scrollY;
  const ox = x0 + sx0, oy = y0 + sy0;
  const cell = 1 / scale, radius = 1.2 * cell;
  for (const run of runs) {
    const [cr, cg, cb, ca] = run.color;
    const k = (ca * AMP) / 255;
    const xa = Math.max(0, Math.floor((run.left - x0) * scale)), xb = Math.min(W, Math.ceil((run.right - x0) * scale));
    const ya = Math.max(0, Math.floor((run.top - y0) * scale) - 1), yb = Math.min(H, Math.ceil((run.bottom - y0) * scale) + 1);
    for (let y = ya; y < yb; y++) {
      const py = oy + (y + 0.5) * cell;
      for (let x = xa, i = (y * W + xa) * 4 + 3; x < xb; x++, i += 4) {
        const a = data[i];
        if (a < 10) continue;
        data[i] = 0;   // claimed: a neighbouring word must not emit this pixel a second time
        out.dot(ox + (x + 0.5) * cell, py, cr, cg, cb, a * k, radius);
      }
    }
    if (run.ul) inkLine(out, run.left + sx0, run.base + 3.5 + sy0, run.right + sx0, run.base + 3.5 + sy0, run.ul, run.ul[3], 1, cell);
  }
  return out;
}

/** A straight rule `width` px thick, as rows of dots one cell apart. */
function inkLine(out, ax, ay, bx, by, c, alpha, width, cell) {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 0.5 || alpha <= 0) return;
  const n = Math.max(1, Math.round(len / cell));
  const rows = Math.max(1, Math.round(width / cell));
  const nx = -(by - ay) / len, ny = (bx - ax) / len;   // across the line
  const a = alpha * AMP, radius = 1.2 * cell;
  for (let r = 0; r < rows; r++) {
    const off = (r - (rows - 1) / 2) * cell;
    for (let i = 0; i <= n; i++) out.dot(ax + ((bx - ax) * i) / n + nx * off, ay + ((by - ay) * i) / n + ny * off, c[0], c[1], c[2], a, radius);
  }
}

/**
 * The page's line work as ink: every visible CSS border (card frames, the code block's
 * accent bar, tag pills, rules), plus [data-ink="vline"] elements as a vertical line.
 */
export function sampleBoxes(root, out, { exclude = null, screen = false, pitch = 1 } = {}) {
  const sx = screen ? 0 : window.scrollX, sy = screen ? 0 : window.scrollY;
  for (const el of root.querySelectorAll('*')) {
    if (exclude && el.closest(exclude)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const wT = parseFloat(cs.borderTopWidth), wR = parseFloat(cs.borderRightWidth);
    const wB = parseFloat(cs.borderBottomWidth), wL = parseFloat(cs.borderLeftWidth);
    const vline = el.dataset.ink === 'vline';
    if (!(wT || wR || wB || wL) && !vline) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 2) continue;
    const x0 = r.left + sx, y0 = r.top + sy, x1 = r.right + sx, y1 = r.bottom + sy;
    if (vline) { inkLine(out, (x0 + x1) / 2, y0, (x0 + x1) / 2, y1, [1, 1, 1], 0.3, 1, pitch); continue; }
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (wT && wR && wB && wL && rad >= r.height / 2 - 1 && r.height < 60) {
      // a pill: two straight runs and two half circles
      const c = parseColor(cs.borderTopColor);
      if (!c[3]) continue;
      const rr = r.height / 2 - wT / 2, cyc = (y0 + y1) / 2;
      inkLine(out, x0 + r.height / 2, y0 + wT / 2, x1 - r.height / 2, y0 + wT / 2, c, c[3], wT, pitch);
      inkLine(out, x0 + r.height / 2, y1 - wT / 2, x1 - r.height / 2, y1 - wT / 2, c, c[3], wT, pitch);
      const n = Math.max(3, Math.round((Math.PI * rr) / pitch));
      for (let i = 1; i < n; i++) {
        const t = (i / n) * Math.PI;
        out.dot(x1 - r.height / 2 + Math.sin(t) * rr, cyc - Math.cos(t) * rr, c[0], c[1], c[2], c[3] * AMP, 1.2 * pitch);
        out.dot(x0 + r.height / 2 - Math.sin(t) * rr, cyc - Math.cos(t) * rr, c[0], c[1], c[2], c[3] * AMP, 1.2 * pitch);
      }
      continue;
    }
    const side = (w, color, ax, ay, bx, by) => {
      if (!w) return;
      const c = parseColor(color);
      inkLine(out, ax, ay, bx, by, c, c[3], w, pitch);
    };
    side(wT, cs.borderTopColor, x0, y0 + wT / 2, x1, y0 + wT / 2);
    side(wB, cs.borderBottomColor, x0, y1 - wB / 2, x1, y1 - wB / 2);
    side(wL, cs.borderLeftColor, x0 + wL / 2, y0, x0 + wL / 2, y1);
    side(wR, cs.borderRightColor, x1 - wR / 2, y0, x1 - wR / 2, y1);
  }
  return out;
}

/** Dotted segment between two doc-space points. */
function pushLine(out, ax, ay, bx, by, spacing, trimA = 0, trimB = 0) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const start = trimA, end = len - trimB;
  for (let d = start; d <= end; d += spacing) {
    const j = (Math.random() - 0.5) * 0.6;
    out.push(ax + ux * d - uy * j, ay + uy * d + ux * j);
  }
}

/** Filled disc using a sunflower pattern. */
function pushDisc(out, cx, cy, radius, spacing) {
  const n = Math.max(1, Math.round((Math.PI * radius * radius) / (spacing * spacing)));
  for (let i = 0; i < n; i++) {
    const r = radius * Math.sqrt((i + 0.5) / n);
    const a = i * GOLDEN;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

function pushRing(out, cx, cy, radius, spacing) {
  const n = Math.max(6, Math.round((TAU * radius) / spacing));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
  }
}

/**
 * Shape sources inside a section:
 *   data-form="spine"   vertical dotted line along the element's left rail (timeline)
 *   data-form="dot"     filled disc the size of the element
 *   data-form="corners" HUD brackets on the element's four corners
 * plus constellation edges supplied by the caller.
 */
export function sampleShapes(sectionEl, { spacing = 3.2, edges = [] } = {}) {
  const out = [];
  for (const el of sectionEl.querySelectorAll('[data-form="spine"]')) {
    const r = docRect(el);
    const x = r.left + 6.5;
    pushLine(out, x, r.top + 10, x, r.top + r.height - 10, spacing * 1.35);
  }
  for (const el of sectionEl.querySelectorAll('[data-form="dot"]')) {
    const r = docRect(el);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const rad = Math.max(2.5, r.width / 2);
    pushDisc(out, cx, cy, rad, Math.min(spacing * 0.7, 2.2));
    if (rad > 7) pushRing(out, cx, cy, rad + 9, spacing * 1.1);
  }
  for (const el of sectionEl.querySelectorAll('[data-form="corners"]')) {
    const r = docRect(el);
    const L = 16, s = spacing * 0.9;
    const x0 = r.left - 0.5, y0 = r.top - 0.5, x1 = r.left + r.width - 0.5, y1 = r.top + r.height - 0.5;
    pushLine(out, x0, y0, x0 + L, y0, s); pushLine(out, x0, y0 + s, x0, y0 + L, s);
    pushLine(out, x1, y0, x1 - L, y0, s); pushLine(out, x1, y0 + s, x1, y0 + L, s);
    pushLine(out, x0, y1, x0 + L, y1, s); pushLine(out, x0, y1 - s, x0, y1 - L, s);
    pushLine(out, x1, y1, x1 - L, y1, s); pushLine(out, x1, y1 - s, x1, y1 - L, s);
  }
  for (const [a, b] of edges) {
    const ra = docRect(a), rb = docRect(b);
    const ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2;
    const bx = rb.left + rb.width / 2, by = rb.top + rb.height / 2;
    pushLine(out, ax, ay, bx, by, spacing * 1.6, ra.width / 2 + 7, rb.width / 2 + 7);
  }
  return Float32Array.from(out);
}

/**
 * Chart bars: every [data-form="bar"] element becomes a filled rectangle of points.
 * The grid step grows until all bars together fit in maxPoints. Returns the points and,
 * per point, whether its bar is a highlighted one (data-tone="mine").
 */
export function sampleBars(sectionEl, maxPoints, minStep = 2.4) {
  const rects = [];
  let area = 0;
  for (const el of sectionEl.querySelectorAll('[data-form="bar"]')) {
    const r = docRect(el);
    if (r.width < 1 || r.height < 1) continue;
    rects.push([r, el.dataset.tone === 'mine' ? 1 : 0]);
    area += r.width * r.height;
  }
  if (!rects.length || maxPoints < 1) return { points: new Float32Array(0), tone: new Float32Array(0) };
  const step = Math.max(minStep, Math.sqrt(area / (0.866 * maxPoints)));
  const pts = [], tone = [];
  for (const [r, t] of rects) {
    const rows = Math.max(1, Math.round(r.height / (step * 0.866)));
    const pitch = r.height / rows;
    for (let j = 0; j < rows; j++) {
      const y = r.top + pitch * (j + 0.5);
      for (let x = r.left + step * (j & 1 ? 0.75 : 0.25); x < r.left + r.width; x += step) {
        pts.push(x + (Math.random() - 0.5) * step * 0.3, y + (Math.random() - 0.5) * pitch * 0.3);
        tone.push(t);
      }
    }
  }
  return { points: Float32Array.from(pts), tone: Float32Array.from(tone) };
}

/**
 * An image's silhouette (its alpha channel) as points. The outline comes out bright and
 * the inside is shaded left to right, so a flat logo still reads as a shape.
 * Returns { points, depth }.
 */
export function sampleMask(img, maxPoints, minStep = 2.4) {
  const none = { points: new Float32Array(0), depth: new Float32Array(0) };
  if (!img || !img.complete || !img.naturalWidth || maxPoints < 1) return none;
  const r = docRect(img);
  if (r.width < 8 || r.height < 8) return none;
  const S = 200;
  let data;
  try {
    const ctx = scratchCtx(S, S);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(img, 0, 0, S, S);
    data = ctx.getImageData(0, 0, S, S).data;
  } catch { return none; }
  const solid = (u, v) => {
    const ix = (u * S) | 0, iy = (v * S) | 0;
    return ix >= 0 && iy >= 0 && ix < S && iy < S && data[(iy * S + ix) * 4 + 3] > 120;
  };
  let filled = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 120) filled++;
  if (!filled) return none;
  const area = (filled / (S * S)) * r.width * r.height;
  const step = Math.max(minStep, Math.sqrt(area / (0.866 * maxPoints)));
  const pts = [], depth = [];
  const eu = (step * 1.15) / r.width, ev = (step * 1.15) / r.height;
  let row = 0;
  for (let y = step * 0.5; y < r.height; y += step * 0.866, row++) {
    for (let x = step * (row & 1 ? 0.75 : 0.25); x < r.width; x += step) {
      const jx = x + (Math.random() - 0.5) * step * 0.3, jy = y + (Math.random() - 0.5) * step * 0.3;
      const u = jx / r.width, v = jy / r.height;
      if (!solid(u, v)) continue;
      const edge = !solid(u - eu, v) || !solid(u + eu, v) || !solid(u, v - ev) || !solid(u, v + ev);
      pts.push(r.left + jx, r.top + jy);
      depth.push(edge ? 1 : 0.16 + 0.5 * u);
    }
  }
  return { points: Float32Array.from(pts), depth: Float32Array.from(depth) };
}

/** Fibonacci sphere direction for index i of n (unit vector). */
export function fib(i, n, out) {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = i * GOLDEN;
  out[0] = Math.cos(a) * r;
  out[1] = y;
  out[2] = Math.sin(a) * r;
  return out;
}

export { docRect };
