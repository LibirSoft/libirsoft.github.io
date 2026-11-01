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

/** One entry per word: what to draw and where (viewport coords). */
function wordRuns(el, exclude) {
  const runs = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent) continue;
    if (exclude && parent.closest(exclude)) continue;
    if (!/\S/.test(node.textContent)) continue;
    // text inside a scroll box (the code sample) only counts where it is actually visible
    const clipEl = parent.closest('pre');
    const clip = clipEl ? clipEl.getBoundingClientRect() : null;
    const cs = getComputedStyle(parent);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const upper = cs.textTransform === 'uppercase';
    const spacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    const text = node.textContent;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const r = rects[0];
      if (r.width < 1) continue;
      if (clip && (r.right > clip.right - 4 || r.left < clip.left)) continue;
      runs.push({
        text: upper ? m[0].toLocaleUpperCase('en') : m[0],
        font, spacing,
        left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      });
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

/**
 * Rasterise an element's text exactly where the browser laid it out, then pick points
 * on a jittered, staggered grid so that roughly `desired` points land inside the glyphs.
 * Returns { points: Float32Array (doc coords), step }.
 */
export function sampleText(el, desired, minStep = 1.8, { exclude = null, scale = 1 } = {}) {
  const runs = wordRuns(el, exclude);
  if (!runs.length || desired < 1) return { points: new Float32Array(0), step: minStep };
  const pad = 6;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of runs) {
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad);
  const w = Math.ceil(x1 + pad - x0), h = Math.ceil(y1 + pad - y0);
  if (w <= 0 || h <= 0) return { points: new Float32Array(0), step: minStep };
  // small text is rasterised at 2x so thin strokes survive the alpha threshold
  while (scale > 1 && w * h * scale * scale > 24e6) scale -= 0.5;
  const W = Math.ceil(w * scale), Hh = Math.ceil(h * scale);
  if (W * Hh > 24e6) return { points: new Float32Array(0), step: minStep };

  const ctx = scratchCtx(W, Hh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, Hh);
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
    ctx.fillText(r.text, r.left - x0, r.top - y0 + ascent);
  }

  const data = ctx.getImageData(0, 0, W, Hh).data;
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
      if (ix < 0 || iy < 0 || ix >= W || iy >= Hh) continue;
      if (data[(iy * W + ix) * 4 + 3] > 110) out.push(ox + jx, oy + jy);
    }
  }
  return { points: shufflePairs(Float32Array.from(out)), step };
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
