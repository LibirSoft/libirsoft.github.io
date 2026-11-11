// Page director: builds formations from the DOM, runs the intro and the big bang,
// and turns the scroll position into "how far the particles are between section A and B".

import { Cosmos, BOUND } from './engine.js';
import { GpuCosmos } from './gpu.js';
import { createRenderer } from './renderer.js';
import { sampleText, sampleShapes, sampleBars, sampleMask, sampleInk, sampleBoxes, InkWriter, docRect, fib } from './sampler.js';

const root = document.documentElement;
// If the module arrives after the no-JS fallback already showed the page, don't yank the
// visitor back into an intro: keep the plain page and just draw a quiet starfield.
const lateBoot = !root.classList.contains('js');
window.__libirBooted = true;
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || params.has('still') || lateBoot;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const canvas = document.getElementById('cosmos');
const fx = document.querySelector('.fx');
const sections = [...document.querySelectorAll('[data-section]')];
const navLinks = new Map([...document.querySelectorAll('.topbar nav a')].map((a) => [a.hash.slice(1), a]));
const singularity = document.getElementById('singularity');
const constellation = document.getElementById('constellation');
const loopEl = document.getElementById('loop');
const hole = document.querySelector('.hole');
const sayIn = document.getElementById('say-in');
const sayGhost = document.querySelector('.say-ghost');
const sayMirror = document.querySelector('.say-mirror');
const focusRing = document.querySelector('.focus-ring');
const topbar = document.querySelector('.topbar');
let topbarScrolled = false;
let lastScrollAt = 0;
addEventListener('scroll', () => {
  lastScrollAt = performance.now();
  const scrolled = window.scrollY > 24;
  if (scrolled !== topbarScrolled) { topbarScrolled = scrolled; topbar.classList.toggle('scrolled', scrolled); }
}, { passive: true });
const HERO = 0;
const CONTACT = sections.findIndex((s) => s.id === 'contact');

const state = sections.map(() => ({ built: false }));
let anchors = [];          // doc-space y of each section's anchor
let homes = [];            // scroll position at which each section is fully built
let docHeight = 0;
let ready = false;
let pendingBang = false;
let liveAt = 0;
let edges = [];

/* ───────────────────────────── budget ───────────────────────────── */

// Phones and tablets run out of GPU fill rate long before the CPU is busy: every
// particle is a blended quad, and the canvas covers the whole (high-DPI) screen.
const touch = matchMedia('(pointer: coarse)').matches;

function budget() {
  const forced = parseInt(params.get('particles'), 10);
  if (forced > 0) return Math.min(40000, forced);
  const area = innerWidth * innerHeight;
  let n = area > 1.3e6 ? 26000 : area > 7e5 ? 20000 : 12000;
  if ((navigator.hardwareConcurrency || 8) <= 4) n *= 0.7;
  if (touch) n *= 0.65;
  return Math.round(n);
}

// With the simulation on the GPU the particle count is no longer a CPU question, only a
// fill-rate one: roughly twice the stars, on phones too.
function gpuBudget() {
  const forced = parseInt(params.get('particles'), 10);
  if (forced > 0) return Math.min(400000, forced);
  const area = innerWidth * innerHeight;
  const n = area > 1.3e6 ? 56000 : area > 7e5 ? 44000 : 26000;
  return Math.round(touch ? n * 0.65 : n);
}

// WebGL2: particles live and move on the graphics card (gpu.js). Anything else, or
// ?cpu, falls back to the JavaScript simulation in engine.js.
const gl2 = createRenderer(canvas);
let engine = null, gpuNote = '';
// A software renderer (no usable GPU, or a blocked one) draws on the CPU: there the extra
// work of the GPU paths is a loss, so it gets the light version: JavaScript simulation, DOM text.
let softwareGL = false;
if (gl2 && gl2.kind === 'webgl2') {
  try {
    const x = gl2.gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(x ? gl2.gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl2.gl.getParameter(gl2.gl.RENDERER));
    softwareGL = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
    if (softwareGL) gpuNote = `software renderer (${name.slice(0, 60)})`;
  } catch { /* unknown is fine */ }
}
if (gl2 && gl2.kind === 'webgl2' && !params.has('cpu') && (!softwareGL || params.has('gpu'))) {
  try {
    engine = new GpuCosmos(canvas, gpuBudget(), gl2);
    engine.selfTest();
  } catch (e) {
    console.warn('[libir] GPU simulation unavailable, simulating in JavaScript', e);
    gpuNote = String((e && e.message) || e).slice(0, 140);
    engine = null;
    gl2.onReinit = null;
  }
}
if (!engine) engine = new Cosmos(canvas, budget(), gl2);
if (engine.kind === '2d') engine.setActive(Math.min(engine.N, 4000));
document.getElementById('pcount').textContent = engine.active.toLocaleString('en-US');

/* ───────────────────────────── ink ───────────────────────────── */

// With WebGL2 nothing on the page is painted by the browser. Body text, borders,
// underlines and the nav are "ink": for every screen pixel a glyph touches there is one
// dot carrying that pixel's coverage, so a section's cloud is its own antialiased bitmap
// and at rest reads as ordinary type. The clouds are static: built once per section,
// uploaded to the GPU and animated there (see renderer.js). The DOM stays where it is,
// invisible, for layout, links, selection and screen readers. Per frame the page only
// hands over a few numbers: how visible each cloud is, where the mouse and the hole are.
const ink = !reduced && !params.has('noink') && (!softwareGL || params.has('gpu')) && engine.kind === 'webgl2' && engine.renderer.ink.ok ? engine.renderer.ink : null;   // ?noink keeps DOM text, for comparing
if (ink) { root.classList.add('ink'); engine.fadeA = 46; engine.fadeB = 82; }
const INK_SKIP = '[data-form="text"], .ghost';
const inkVis = sections.map(() => 0);
const inkLayers = sections.map((_, i) => ({ key: `s${i}`, vis: 0, scroll: 0, fade0: 46, fade1: 82 }));
const navLayer = { key: 'nav', vis: 0, scroll: 0, fade0: -1e5, fade1: -1e5 + 1 };
const inkFx = { x: 0, y: 0, c: 0, hold: 0, blastT: -1, blastC: 0, px: 0, py: 0, pulseT: -1 };
// streaks: ink dots stretch into streaks after a blast (skipped only on a phone that is simulating on its CPU)
const inkLens = { x: 0, y: 0, s: 0 };   // the lens under the pointer: trails it a little and fades in and out
const inkFrame = { time: 0, mouse: [0, 0, 0, 0], well: [0, 0, 0, 0], wellR: [1, 1], blast: [-1, 0], pulse: [0, 0, -1], layers: [], streaks: engine.sim === 'gpu' || !touch };
let inkDots = 0, inkMs = 0, inkMax = 0;

// One dot per pixel of the canvas (which runs below the screen's own resolution on
// phones): finer than that could not be seen, coarser would start to read as dots.
const inkPitch = () => Math.max(0.6, 1 / canvasDpr());

function buildInk(i) {
  if (!ink) return;
  const t0 = performance.now();
  const pitch = inkPitch();
  const out = new InkWriter();
  sampleInk(sections[i], out, { exclude: INK_SKIP, pitch });
  sampleBoxes(sections[i], out, { exclude: '.ghost, svg', pitch });
  inkDots += out.count - ink.count(`s${i}`);
  const packed = bandSort(out);
  ink.set(`s${i}`, packed.data, packed.bands);
  const ms = performance.now() - t0;
  inkMs += ms; if (ms > inkMax) inkMax = ms;
}

/* Dark panels. The cards and the code block sit on a dark fill, and that fill cannot be
   dots (light only adds up). So it is split in two: a plain dark rectangle underneath the
   canvas, which shades the nebula, and a list of the same rectangles for the particle
   shader, which dims the free stars inside them. Together they are the old panel, with
   the ink text on top and nothing shining through it. */
const paneLayer = document.createElement('div');
paneLayer.className = 'panes';
paneLayer.setAttribute('aria-hidden', 'true');
let panes = [];
const paneBuf = new Float32Array(16 * 5);

function layoutPanes() {
  if (!ink) return;
  if (!paneLayer.isConnected) document.querySelector('.nebula').after(paneLayer);
  paneLayer.textContent = '';
  panes = sections.map((sec) => {
    const group = document.createElement('div');
    const list = [];
    for (const el of sec.querySelectorAll('.card, .code')) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/[\d.]+/g);
      const a = m && m.length > 3 ? +m[3] : m ? 1 : 0;
      if (!(a > 0)) continue;
      const r = docRect(el);
      const d = document.createElement('div');
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:${bg}`;
      group.append(d);
      list.push([r.left, r.top, r.left + r.width, r.top + r.height, a]);
    }
    paneLayer.append(group);
    return { group, list, shown: -1 };
  });
}

/** Panels come and go with their section's ink; the visible ones are handed to the engine. */
function paneTick() {
  let n = 0;
  for (let i = 0; i < panes.length; i++) {
    const P = panes[i], v = inkVis[i];
    if (!P.list.length) continue;
    if (Math.abs(v - P.shown) > 0.01 || (v === 0) !== (P.shown === 0) || (v === 1) !== (P.shown === 1)) {
      P.shown = v;
      P.group.style.opacity = v.toFixed(2);
    }
    if (v < 0.02) continue;
    for (const r of P.list) {
      if (n === 16) break;
      paneBuf[n * 5] = r[0]; paneBuf[n * 5 + 1] = r[1]; paneBuf[n * 5 + 2] = r[2]; paneBuf[n * 5 + 3] = r[3];
      paneBuf[n * 5 + 4] = r[4] * v;
      n++;
    }
  }
  engine.panes = paneBuf;
  engine.paneCount = n;
}

/** Order a cloud's dots top to bottom in slices of one small screen, so the renderer can skip the ones out of view. */
const BAND = 420;
function bandSort(out) {
  const n = out.count;
  const src = new Uint32Array(out.u8.buffer, 0, n * 4), y = out.f32;
  const data = new Uint32Array(n * 4);
  if (!n) return { data, bands: [] };
  let y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) { const v = y[4 * k + 1]; if (v < y0) y0 = v; if (v > y1) y1 = v; }
  const nb = Math.max(1, Math.ceil((y1 - y0 + 1) / BAND));
  const counts = new Int32Array(nb + 1);
  for (let k = 0; k < n; k++) counts[Math.min(nb - 1, ((y[4 * k + 1] - y0) / BAND) | 0) + 1]++;
  for (let b = 0; b < nb; b++) counts[b + 1] += counts[b];
  const at = counts.slice(0, nb);
  for (let k = 0; k < n; k++) {
    const d = 4 * at[Math.min(nb - 1, ((y[4 * k + 1] - y0) / BAND) | 0)]++, o = 4 * k;
    data[d] = src[o]; data[d + 1] = src[o + 1]; data[d + 2] = src[o + 2]; data[d + 3] = src[o + 3];
  }
  const bands = [];
  for (let b = 0; b < nb; b++) if (counts[b + 1] > counts[b]) bands.push({ y0: y0 + b * BAND, y1: y0 + (b + 1) * BAND, start: counts[b], count: counts[b + 1] - counts[b] });
  return { data, bands };
}

function buildNavInk() {
  if (!ink) return;
  root.classList.add('measuring');   // the bar slides in on load: measure where it ends up
  void topbar.offsetHeight;
  const pitch = inkPitch();
  const out = new InkWriter(4096);
  sampleInk(topbar, out, { screen: true, pitch });
  const cur = navLinks.get(currentNav);
  if (cur && cur.offsetParent) {
    const r = cur.getBoundingClientRect();
    for (let x = r.left; x <= r.right; x += pitch) out.dot(x, r.bottom + 6, 0, 0.74, 0.7, 0.79, 1.2 * pitch);
  }
  root.classList.remove('measuring');
  ink.set('nav', out.u8.slice(0, out.count * 16));
}

// The section in view is inked at once; the rest follow one per tick, nearest first, so
// a phone never stalls on all nine at the same time.
let inkQueue = [], inkTimer = 0, inkSig = '';
function scheduleInk() {
  if (!ink) return;
  const sig = `${innerWidth}|${document.querySelector('main').offsetHeight}`;
  if (sig === inkSig) return;
  inkSig = sig;
  const cur = Math.max(0, dominant());
  buildInk(cur);
  buildNavInk();
  inkQueue = sections.map((_, i) => i).filter((i) => i !== cur).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
  clearTimeout(inkTimer);
  const pump = () => {
    if (!inkQueue.length) return;
    buildInk(inkQueue.shift());
    if (inkQueue.length) inkTimer = setTimeout(pump, 24);
    else { updateCount(); reInk(CONTACT, 60); }   // the footer counts the dots, itself included
  };
  inkTimer = setTimeout(pump, 24);
}

/** Re-ink one section soon (its text changed, or a code box was scrolled sideways). */
const inkAgain = new Map();
function reInk(i, delay = 0) {
  if (!ink || i < 0) return;
  clearTimeout(inkAgain.get(i));
  inkAgain.set(i, setTimeout(() => buildInk(i), delay));
}

function inkTick(dt) {
  if (!ink) return;
  paneTick();
  const w = engine.well, s = inkFx;
  if (w.on) {
    // the ink follows the hole a beat behind, like something with weight
    const k = s.c > 0.02 ? Math.min(1, dt * 14) : 1;
    s.x += (w.x - s.x) * k; s.y += (w.y - s.y) * k;
    s.c = w.charge; s.hold += dt * (0.3 + 0.7 * w.charge); s.blastT = -1;
  }
  else if (s.blastT >= 0) { s.blastT += dt; if (s.blastT > 2.35) { s.blastT = -1; s.c = 0; } }   // everything is home by then
  else if (s.c > 0) { s.c *= Math.exp(-dt * 9); if (s.c < 0.002) s.c = 0; }
  if (s.pulseT >= 0) { s.pulseT += dt; if (s.pulseT > 1.4) s.pulseT = -1; }
  const live = root.classList.contains('live');
  navLayer.vis += ((live ? 1 : 0) - navLayer.vis) * Math.min(1, dt * 2.2);

  const f = inkFrame;
  f.time = engine.time;
  const mOn = engine.mouse.on && engine.phase === 'live' && !w.on && s.c < 0.02 && s.blastT < 0;
  const L = inkLens;
  if (mOn && L.s < 0.01) { L.x = engine.mouse.x; L.y = engine.mouse.y; }   // appearing: start where the pointer is
  else if (mOn) { const k = Math.min(1, dt * 16); L.x += (engine.mouse.x - L.x) * k; L.y += (engine.mouse.y - L.y) * k; }
  L.s += ((mOn ? 1 : 0) - L.s) * Math.min(1, dt * (mOn ? 5 : 7));
  if (L.s < 0.002) L.s = 0;
  f.mouse[0] = L.x; f.mouse[1] = L.y; f.mouse[2] = engine.repel * 1.35; f.mouse[3] = L.s;
  f.well[0] = s.x; f.well[1] = s.y; f.well[2] = s.c; f.well[3] = s.hold;
  f.wellR[0] = (150 + 330 * s.c) * (engine.w < 640 ? 0.72 : 1); f.wellR[1] = 22 + 26 * s.c;
  f.blast[0] = s.blastT; f.blast[1] = s.blastC;
  f.pulse[0] = s.px; f.pulse[1] = s.py; f.pulse[2] = s.pulseT;
  f.layers.length = 0;
  const sy = window.scrollY;
  for (let i = 0; i < inkLayers.length; i++) {
    if (inkVis[i] < 0.004) continue;
    const L = inkLayers[i];
    L.vis = inkVis[i]; L.scroll = sy;
    f.layers.push(L);
  }
  if (navLayer.vis > 0.004) f.layers.push(navLayer);
  ink.frame = f;
}

// Canvas resolution. The particles are soft glows, so 1.5x is visually free on a phone
// and costs ~45% less fill than 2x. Adaptive quality may lower it further.
let dprCap = touch || innerWidth < 640 ? 1.5 : 2;
const canvasDpr = () => Math.min(dprCap, window.devicePixelRatio || 1);

function viewport() {
  const r = ((engine.renderer && engine.renderer.canvas) || canvas).getBoundingClientRect();
  engine.setViewport(r.width || innerWidth, r.height || innerHeight, canvasDpr());
  fx.style.setProperty('--r', `${engine.intro.R}px`);
}

/* ───────────────────────────── layout → points ───────────────────────────── */

function layoutConstellation() {
  const nodes = [...constellation.querySelectorAll('.node')];
  const core = nodes[0], ring = nodes.slice(1);
  constellation.classList.add('laid-out');
  const W = constellation.clientWidth, H = constellation.clientHeight || W;
  const n = ring.length;
  const angles = ring.map((_, i) => -Math.PI / 2 + (i * Math.PI * 2) / n);
  const widths = ring.map((el) => el.querySelector('.label').getBoundingClientRect().width);
  // the biggest radius at which every label still fits inside the box
  let outer = Math.min(W, H) * 0.42;
  ring.forEach((el, i) => {
    const c = Math.cos(angles[i]), s = Math.sin(angles[i]);
    const lw = widths[i] + 16;
    if (Math.abs(c) > 0.3) outer = Math.min(outer, (W / 2 - lw) / Math.abs(c));
    else outer = Math.min(outer, (H / 2 - 26) / Math.abs(s), (W / 2 - lw / 2) / Math.max(0.05, Math.abs(c)));
  });
  outer = Math.max(outer, Math.min(W, H) * 0.24);
  core.style.setProperty('--x', '50%');
  core.style.setProperty('--y', '50%');
  const pos = [];
  ring.forEach((el, i) => {
    // one ring, slightly uneven so it reads as a constellation rather than a clock face
    const rr = outer * (i % 2 ? 0.93 : 1);
    const c = Math.cos(angles[i]), s = Math.sin(angles[i]);
    const x = W / 2 + c * rr, y = H / 2 + s * rr;
    pos.push([x, y]);
    el.style.setProperty('--x', `${(x / W) * 100}%`);
    el.style.setProperty('--y', `${(y / H) * 100}%`);
    el.classList.remove('l', 'r', 't', 'b');
    el.classList.add(Math.abs(c) > 0.3 ? (c > 0 ? 'r' : 'l') : (s < 0 ? 't' : 'b'));
  });
  // the pack stands round the wolf: spokes stop at the edge of the logo
  core.style.setProperty('--wolf', `${Math.round(outer * 1.02)}px`);
  const dot = (el) => el.querySelector('.dot, .wolf');
  edges = ring.map((el) => [dot(core), dot(el)]);
  for (let i = 0; i < n; i++) edges.push([dot(ring[i]), dot(ring[(i + 1) % n])]);

  const svg = constellation.querySelector('svg');
  const lines = [];
  ring.forEach((_, i) => {
    const [x, y] = pos[i];
    lines.push(`<line x1="${W / 2}" y1="${H / 2}" x2="${x}" y2="${y}"/>`);
    const [x2, y2] = pos[(i + 1) % n];
    lines.push(`<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}"/>`);
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = lines.join('');
}

/* The granny loop: a rounded track with the four roles on it. Particles run round it
   clockwise (implementer → checks → reviewers → judge → back to fix) for as long as you watch. */
const LUT_N = 512;
let loopGeo = null;

function layoutLoop() {
  if (!loopEl) return;
  loopEl.classList.add('laid-out');
  const W = loopEl.clientWidth, H = loopEl.clientHeight || W * 0.8;
  const L = W * 0.24, R = W * 0.93, T = H * 0.27, B = H * 0.68;
  const mx = (L + R) / 2, my = (T + B) / 2;
  const r = Math.min(W * 0.13, (B - T) / 2);
  const inX = W * 0.045, outY = H * 0.93;

  // the track as a polyline, starting at the implementer (west) and heading up
  const pts = [];
  const line = (ax, ay, bx, by) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
    for (let i = 0; i < n; i++) pts.push(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
  };
  const arc = (cx, cy, a0) => {
    const n = Math.max(2, Math.ceil((r * Math.PI) / 4));
    for (let i = 0; i < n; i++) { const a = a0 + (Math.PI / 2) * (i / n); pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
  };
  line(L, my, L, T + r); arc(L + r, T + r, Math.PI);
  line(L + r, T, R - r, T); arc(R - r, T + r, Math.PI * 1.5);
  line(R, T + r, R, B - r); arc(R - r, B - r, 0);
  line(R - r, B, L + r, B); arc(L + r, B - r, Math.PI / 2);
  line(L, B - r, L, my);

  // resample by arc length, so "phase" along the track means distance travelled
  const n = pts.length >> 1;
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(pts[2 * k] - pts[2 * i], pts[2 * k + 1] - pts[2 * i + 1]);
  }
  const P = cum[n];
  const lx = new Float32Array(LUT_N), ly = new Float32Array(LUT_N);
  for (let i = 0, s = 0; i < LUT_N; i++) {
    const d = (i / LUT_N) * P;
    while (s < n - 1 && cum[s + 1] < d) s++;
    const k = (s + 1) % n, w = (d - cum[s]) / Math.max(1e-6, cum[s + 1] - cum[s]);
    lx[i] = pts[2 * s] + (pts[2 * k] - pts[2 * s]) * w;
    ly[i] = pts[2 * s + 1] + (pts[2 * k + 1] - pts[2 * s + 1]) * w;
  }

  const at = {
    plan: [inX, my, 't'], implementer: [L, my, 'r'], checks: [mx, T, 't'], reviewers: [R, my, 'l'],
    judge: [mx, B, 't'], branch: [mx, outY, 'r'],
    fix: [L + (mx - L) * 0.5, B, 'b'], clean: [mx, (B + outY) / 2, 'l'],
  };
  for (const el of loopEl.querySelectorAll('.node')) {
    const [x, y, side] = at[el.dataset.at];
    el.style.setProperty('--x', `${(x / W) * 100}%`);
    el.style.setProperty('--y', `${(y / H) * 100}%`);
    el.classList.remove('l', 'r', 't', 'b');
    el.classList.add(side);
  }

  const svg = loopEl.querySelector('svg');
  let d = '';
  for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${pts[2 * i].toFixed(1)} ${pts[2 * i + 1].toFixed(1)}`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<path d="${d}Z"/><line x1="${inX}" y1="${my}" x2="${L}" y2="${my}"/><line x1="${mx}" y1="${B}" x2="${mx}" y2="${outY}"/>`;

  loopGeo = { lx, ly, P, lines: [[inX, my, L, my], [mx, B, mx, outY]] };
}

/**
 * Points for the loop. type 0 rides the track (its position is recomputed every frame
 * from `phase`), type 1 sits on the way in or out and only pulses.
 */
function loopFlow(maxPoints) {
  const g = loopGeo;
  const none = { points: new Float32Array(0), type: [], phase: [], jx: [], jy: [], ox: 0, oy: 0 };
  if (!g || maxPoints < 50) return none;
  const o = docRect(loopEl);
  if (o.width < 10) return none;
  const pts = [], type = [], phase = [], jx = [], jy = [];
  const nRing = Math.max(40, Math.min(Math.round(g.P / 0.85), Math.round(maxPoints * 0.85)));
  for (let i = 0; i < nRing; i++) {
    const ph = (i + Math.random()) / nRing;
    const k = (ph * LUT_N) | 0;
    const dx = (Math.random() - 0.5) * 4.4, dy = (Math.random() - 0.5) * 4.4;
    pts.push(o.left + g.lx[k] + dx, o.top + g.ly[k] + dy);
    type.push(0); phase.push(ph); jx.push(dx); jy.push(dy);
  }
  for (const [ax, ay, bx, by] of g.lines) {
    const len = Math.hypot(bx - ax, by - ay);
    const a = 20, b = len - 20;   // keep clear of the node discs and their halos
    for (let dd = a; dd <= b; dd += 2.6) {
      const u = dd / len;
      pts.push(o.left + ax + (bx - ax) * u + (Math.random() - 0.5), o.top + ay + (by - ay) * u + (Math.random() - 0.5));
      type.push(1); phase.push((dd - a) / Math.max(1, b - a)); jx.push(0); jy.push(0);
    }
  }
  return { points: Float32Array.from(pts), type, phase, jx, jy, ox: o.left, oy: o.top };
}

const LAP = 11;        // seconds for one trip round the loop
const COMETS = 4;      // bright heads on the track, each dragging a tail
const BASE_DEPTH = 0.87;

/** Attach brightness, tint and (for the loop) motion to a finished formation. */
function dress(F, src, M, bars, barsAt, mask, maskAt, flow, flowAt) {
  const nx = bars.tone.length, nm = mask.depth.length, nf = flow.type.length;
  if (!nx && !nm && !nf) return F;
  const depth = new Float32Array(M).fill(BASE_DEPTH), tint = new Float32Array(M);
  const fj = [], fn = [];
  for (let k = 0; k < M; k++) {
    const s = src[k];
    if (s >= barsAt && s < barsAt + nx) {
      const mine = bars.tone[s - barsAt];
      depth[k] = mine ? 1 : 0.42;
      tint[k] = mine ? 0.9 : 0;
    } else if (s >= maskAt && s < maskAt + nm) {
      depth[k] = mask.depth[s - maskAt];
      tint[k] = 0.92;
    } else if (s >= flowAt && s < flowAt + nf) {
      const n = s - flowAt;
      fj.push(k); fn.push(n);
      if (flow.type[n] === 0) {
        const x = (flow.phase[n] * COMETS) % 1;
        depth[k] = 0.04 + 0.96 * Math.pow(x, 2.1);
        tint[k] = 0.85;
      }
    }
  }
  F.depth = depth; F.tint = tint;
  if (nf && loopGeo) {
    const { lx, ly } = loopGeo;
    const { type, phase, jx, jy, ox, oy } = flow;
    F.dynamic = (F, t) => {
      const lap = (t / LAP) % 1;
      for (let i = 0; i < fj.length; i++) {
        const k = fj[i], n = fn[i];
        if (type[n] === 0) {
          let s = phase[n] + lap; s -= Math.floor(s);
          const f = s * LUT_N, a = f | 0, b = (a + 1) % LUT_N, w = f - a;
          F.points[2 * k] = ox + lx[a] + (lx[b] - lx[a]) * w + jx[n];
          F.points[2 * k + 1] = oy + ly[a] + (ly[b] - ly[a]) * w + jy[n];
        } else {
          // the way in and the way out stay put; a pulse of light travels along them
          let u = phase[n] * 1.5 - t * 0.7; u -= Math.floor(u);
          F.depth[k] = 0.05 + 0.95 * u * u * u;
        }
      }
    };
    F.dynamic(F, engine.time);
  }
  return F;
}

/**
 * Every formation gets exactly M points (subsampled or padded), ordered by x. Particle
 * rank j then means "j-th from the left" in every section, which keeps paths short.
 * `kinds` travels with the points: 0 = heading/shape, 1 = body text.
 */
function finalize(points, kinds, M, fallback) {
  let n = points.length >> 1;
  let synthetic = false;
  if (!n) {
    points = new Float32Array(2 * M);
    kinds = new Uint8Array(M);
    synthetic = true;
    for (let k = 0; k < M; k++) {
      points[2 * k] = fallback.left + Math.random() * fallback.width;
      points[2 * k + 1] = fallback.top + Math.random() * fallback.height;
    }
    n = M;
  }
  const order = new Int32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  for (let k = n - 1; k > 0; k--) { const r = (Math.random() * (k + 1)) | 0; const t = order[k]; order[k] = order[r]; order[r] = t; }
  const raw = new Float32Array(2 * M), rk = new Uint8Array(M), rs = new Int32Array(M);
  for (let k = 0; k < M; k++) {
    const src = k < n ? order[k] : order[(Math.random() * n) | 0];
    const pad = k < n ? 0 : 1.6;
    raw[2 * k] = points[2 * src] + (Math.random() - 0.5) * pad;
    raw[2 * k + 1] = points[2 * src + 1] + (Math.random() - 0.5) * pad;
    rk[k] = kinds[src];
    rs[k] = synthetic ? -1 : src;
  }
  const idx = orderByX(M, (k) => raw[2 * k] + (Math.random() - 0.5) * 40);
  // src: which input point each output point came from, so callers can hang extra
  // per-point data (brightness, tint, motion) on the result
  const out = new Float32Array(2 * M), kind = new Uint8Array(M), src = new Int32Array(M);
  for (let k = 0; k < M; k++) {
    out[2 * k] = raw[2 * idx[k]]; out[2 * k + 1] = raw[2 * idx[k] + 1];
    kind[k] = rk[idx[k]];
    src[k] = rs[idx[k]];
  }
  return { points: out, kind, src };
}

/**
 * Indices 0..n-1 ordered by key(k). The key and the index are packed into one float64 so
 * the typed array's own sort does the work: no comparator calls, about ten times faster
 * than sorting indices, which matters with tens of thousands of points per section.
 */
function orderByX(n, key) {
  const packed = new Float64Array(n);
  for (let k = 0; k < n; k++) packed[k] = Math.round((key(k) + 4096) * 8) * 1048576 + k;
  packed.sort();
  const idx = new Int32Array(n);
  for (let k = 0; k < n; k++) idx[k] = packed[k] % 1048576;
  return idx;
}

const BODY_EXCLUDE = '[data-form="text"], .ghost';

function buildFormations() {
  // measure the final layout, not a half-faded one
  root.classList.add('measuring');
  void root.offsetHeight;
  const small = innerWidth < 640;
  const M = engine.M;
  const minStep = small ? 1.45 : 1.85;
  const bodyStep = small ? 1.3 : 1.5;
  const forms = sections.map((sec, i) => {
    // body text first: every paragraph, card, label and line of code in the section
    const bodyShare = i === HERO ? 0.22 : i === CONTACT ? 0.4 : 0.55;
    const shapes = i === CONTACT ? new Float32Array(0)
      : sampleShapes(sec, { spacing: small ? 3 : 3.4, edges: sec.id === 'asena' ? edges : [] });
    const bars = sampleBars(sec, M * (small ? 0.36 : 0.26), 2.4);
    const flow = sec.id === 'granny' ? loopFlow(M * 0.2) : loopFlow(0);
    const mask = sampleMask(sec.querySelector('[data-form="mask"]'), M * 0.2, small ? 2.5 : 2.3);
    const nx = bars.points.length >> 1, nm = mask.points.length >> 1, nf = flow.points.length >> 1;
    const body = sampleText(sec, Math.max(200, (M - shapes.length / 2 - nx - nm - nf) * bodyShare), bodyStep, { exclude: BODY_EXCLUDE, scale: 1 });
    const bsize = Math.min(1.3, Math.max(0.85, body.step * 0.5));
    if (i === CONTACT) return sphereFormation(M, body.points, bsize);
    const title = sec.querySelector('[data-form="text"]');
    const nb = body.points.length >> 1, ns = shapes.length >> 1;
    const head = sampleText(title, Math.max(300, M - nb - ns - nx - nm - nf), minStep);
    const nh = head.points.length >> 1;
    const barsAt = nh + ns, maskAt = barsAt + nx, flowAt = maskAt + nm, bodyAt = flowAt + nf;
    const all = new Float32Array(2 * (bodyAt + nb));
    all.set(head.points, 0); all.set(shapes, 2 * nh);
    all.set(bars.points, 2 * barsAt); all.set(mask.points, 2 * maskAt); all.set(flow.points, 2 * flowAt);
    all.set(body.points, 2 * bodyAt);
    const kinds = new Uint8Array(bodyAt + nb);
    kinds.fill(1, bodyAt);
    const { points, kind, src } = finalize(all, kinds, M, docRect(title));
    return dress({
      id: sec.id,
      points, kind,
      psize: Math.min(2.3, Math.max(1.15, head.step * 0.62)),
      bsize,
      bodyVis: 1,
    }, src, M, bars, barsAt, mask, maskAt, flow, flowAt);
  });
  anchors = sections.map((sec, i) => {
    const a = i === CONTACT ? singularity : sec.querySelector('[data-form="text"]');
    return docRect(a).top;
  });
  docHeight = docRect(document.querySelector('main')).top + document.querySelector('main').offsetHeight;
  root.classList.remove('measuring');
  return forms;
}

function sphereFormation(M, bodyPts, bsize) {
  const r = docRect(singularity);
  const cx0 = r.left + r.width / 2, cy0 = r.top + r.height / 2, R0 = r.width * 0.36;
  const nb = Math.min(bodyPts.length >> 1, Math.floor(M * 0.45));
  const S = M - nb;
  const v = [0, 0, 0];
  const entries = [];
  for (let s = 0; s < S; s++) { fib(s, S, v); entries.push({ k: cx0 + v[0] * R0, d: [v[0], v[1], v[2]] }); }
  for (let b = 0; b < nb; b++) entries.push({ k: bodyPts[2 * b], b: [bodyPts[2 * b], bodyPts[2 * b + 1]] });
  for (const e of entries) e.k += (Math.random() - 0.5) * 40;
  entries.sort((a, b) => a.k - b.k);
  const ux = new Float32Array(M), uy = new Float32Array(M), uz = new Float32Array(M);
  const isS = new Uint8Array(M), kind = new Uint8Array(M);
  const points = new Float32Array(M * 2), depth = new Float32Array(M).fill(1);
  const sIdx = [];
  const tp = new Float32Array(M * 2);   // where each sphere particle goes when the visitor types a word
  entries.forEach((e, j) => {
    if (e.d) { isS[j] = 1; ux[j] = e.d[0]; uy[j] = e.d[1]; uz[j] = e.d[2]; sIdx.push(j); }
    else { kind[j] = 1; points[2 * j] = e.b[0]; points[2 * j + 1] = e.b[1]; }
  });
  const F = {
    id: 'contact',
    points, depth, kind,
    psize: 1.5,
    bsize,
    bodyVis: 1,
    cx: cx0,
    cy: cy0,
    R: R0,
    scale: 1,
    targetScale: 1,
    spin: 0,
    say: 0,
    sayTarget: 0,
    sphereCount: S,
    /** Give the sphere a word to spell (text points in doc space), or nothing to become a sphere again. */
    setText(pts) {
      const np = pts.length >> 1;
      if (!np) { F.sayTarget = 0; return; }
      const pick = [];
      for (let n = 0; n < sIdx.length; n++) pick.push(n < np ? n : (Math.random() * np) | 0);
      pick.sort((a, b) => pts[2 * a] - pts[2 * b]);   // sIdx runs left to right too: short trips
      for (let n = 0; n < sIdx.length; n++) {
        const j = sIdx[n], s = pick[n], pad = n < np ? 0 : 1.5;
        tp[2 * j] = pts[2 * s] + (Math.random() - 0.5) * pad;
        tp[2 * j + 1] = pts[2 * s + 1] + (Math.random() - 0.5) * pad;
      }
      F.sayTarget = 1;
    },
    dynamic(F, t, dt) {
      F.say += (F.sayTarget - F.say) * Math.min(1, dt * 4);
      const say = F.say < 0.002 ? 0 : F.say;
      F.scale += (F.targetScale - F.scale) * Math.min(1, dt * (F.targetScale < 1 ? 9 : 3));
      F.spin += dt * (0.3 + (1 - F.scale) * 6);
      const R = F.R * F.scale * (1 + 0.02 * Math.sin(t * 1.7));
      const cy = Math.cos(F.spin), sy = Math.sin(F.spin), cx = Math.cos(0.4), sx = Math.sin(0.4);
      for (let j = 0; j < M; j++) {
        if (!isS[j]) continue;
        const X = ux[j] * cy + uz[j] * sy;
        const Z = -ux[j] * sy + uz[j] * cy;
        const Y = uy[j] * cx - Z * sx;
        const Z2 = uy[j] * sx + Z * cx;
        const bx = F.cx + X * R, by = F.cy + Y * R, bd = (Z2 + 1) * 0.5;
        F.points[2 * j] = bx + (tp[2 * j] - bx) * say;
        F.points[2 * j + 1] = by + (tp[2 * j + 1] - by) * say;
        F.depth[j] = bd + (1 - bd) * say;
      }
    },
  };
  F.dynamic(F, 0, 0);
  return F;
}

/** Scroll position at which each section is "home": its heading sits in the upper part of the screen. */
function computeHomes() {
  const H = innerHeight;
  const maxS = Math.max(0, docHeight - H);
  homes = anchors.map((a, i) => (i === HERO ? 0 : Math.min(maxS, Math.max(0, a - H * 0.22))));
  for (let i = 1; i < homes.length; i++) homes[i] = Math.max(homes[i], homes[i - 1] + 1);
}

/**
 * Between two homes the particles hold the first section, then, over the last
 * ~0.9 screens of scrolling, stream to the next one. Returns [a, b, progress].
 */
function segmentAt(sy) {
  const n = homes.length;
  if (!n) return [HERO, HERO, 0];
  if (sy >= homes[n - 1]) return [n - 1, n - 1, 0];
  let i = 0;
  while (i < n - 2 && sy >= homes[i + 1]) i++;
  const a = homes[i], b = homes[i + 1];
  const L = Math.min(b - a, innerHeight * 0.9);
  const start = b - L;
  return [i, i + 1, sy <= start ? 0 : (sy - start) / L];
}

let builtM = 0, buildMs = 0;
function rebuild() {
  const t0 = performance.now();
  layoutConstellation();
  layoutLoop();
  layoutPanes();
  engine.formations = buildFormations();
  computeHomes();
  if (engine.phase === 'live' && builtM !== engine.M) engine.assign({ spread: 0.2 });
  builtM = engine.M;
  applySay();
  buildMs = performance.now() - t0;
  scheduleInk();
}

/* ───────────────────────────── effects ───────────────────────────── */

function flashAt(x, y) {
  fx.style.setProperty('--x', `${x}px`);
  fx.style.setProperty('--y', `${y}px`);
  fx.classList.remove('bang', 'nova');
  void fx.offsetWidth;
  fx.classList.add('bang');
  root.classList.remove('shake');
  void root.offsetWidth;
  root.classList.add('shake');
  setTimeout(() => root.classList.remove('shake'), 500);
}

/** The small version, for a hole that was let go before it was full. */
function novaAt(x, y, c) {
  if (c > 0.8) return flashAt(x, y);
  fx.style.setProperty('--x', `${x}px`);
  fx.style.setProperty('--y', `${y}px`);
  fx.classList.remove('bang', 'nova');
  void fx.offsetWidth;
  fx.classList.add('nova');
}

/* ───────────────────────────── press and hold ───────────────────────────── */

// Hold anywhere and space caves in: particles spiral into the pointer and heat up for
// as long as you hold (drag it around if you like). Let go and they are thrown back out.
let holdId = -1, holing = false;
function startHold(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  holdId = e.pointerId;
  const w = engine.well;
  w.x = e.clientX; w.y = e.clientY; w.charge = 0; w.on = true;
  inkFx.hold = 0;
}
function endHold(e, quiet) {
  if (holdId < 0 || (e && e.pointerId !== holdId)) return;
  holdId = -1;
  const w = engine.well, x = w.x, y = w.y;
  let c = 0;
  if (quiet) { w.on = false; w.charge = 0; } else c = engine.releaseWell();
  if (c > 0) { inkFx.blastT = 0; inkFx.blastC = c; inkFx.c = c; novaAt(x, y, c); }
}
function drawHole() {
  const w = engine.well;
  const show = w.on && w.charge > 0.06;
  if (show) hole.style.transform = `translate3d(${w.x}px, ${w.y}px, 0) scale(${(0.3 + 0.7 * w.charge).toFixed(3)})`;
  if (show !== holing) {
    holing = show;
    fx.classList.toggle('holing', show);
    root.classList.toggle('holding', show);   // no text selection or callouts while holding
  }
}

/* ───────────────────────────── say it with stars ───────────────────────────── */

// Whatever is typed into the box at the end of the page, the singularity spells out.
function applySay() {
  if (!sayIn || !sayGhost) return;
  const text = sayIn.value.trim().slice(0, 16);
  if (sayMirror) {
    // the box itself is invisible like everything else: its ink comes from this mirror
    const shown = sayIn.value || sayIn.placeholder;
    if (sayMirror.textContent !== shown) {
      sayMirror.textContent = shown;
      sayMirror.classList.toggle('ph', !sayIn.value);
      reInk(CONTACT);
    }
  }
  sayGhost.textContent = text;
  singularity.classList.toggle('saying', !!text);
  if (text) {
    sayGhost.style.fontSize = '100px';
    const w = sayGhost.getBoundingClientRect().width || 1;
    const avail = Math.min(innerWidth - 32, 980);
    sayGhost.style.fontSize = `${Math.max(26, Math.min(150, (100 * avail) / w)).toFixed(1)}px`;
  }
  const F = engine.formations[CONTACT];
  if (!F || !F.setText) return;
  F.setText(text ? sampleText(sayGhost, F.sphereCount, 2).points : new Float32Array(0));
}
if (sayIn) {
  sayIn.addEventListener('input', applySay);
  sayIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') sayIn.blur(); });
}

/* ───────────────────────────── the big bang ───────────────────────────── */

let askedAt = 0;
function triggerBang() {
  if (engine.phase !== 'intro' || rescued) return;
  if (!askedAt) {
    // whatever happens next, nobody is left looking at the sphere: if the universe has not
    // opened a few seconds after it was asked to, the page gives up on it and shows itself
    askedAt = performance.now();
    setTimeout(() => { if (engine.phase !== 'live') rescue(new Error(`the intro did not open (${engine.phase}${ready ? '' : ', page not ready'})`)); }, 6000);
  }
  if (!ready) { pendingBang = true; return; }
  engine.implode();
  root.classList.add('imploding');
  setTimeout(guard(() => {
    engine.bang();
    flashAt(engine.intro.cx, engine.intro.cy);
    setTimeout(guard(() => {
      engine.phase = 'live';
      liveAt = engine.time;
      engine.setSegment(HERO, HERO, 0);
      engine.assign({ spread: 0.55, swirl: 0.45, stiffness: 0.6 });
    }), 420);
    setTimeout(() => root.classList.remove('intro', 'imploding'), 1000);
  }), 340);
}

let armedAt = performance.now() + 650;
let moved = 0, lastPX = null, lastPY = null;
function onPointerMove(e) {
  engine.mouse.x = e.clientX;
  engine.mouse.y = e.clientY;
  engine.mouse.on = e.pointerType !== 'touch' || e.buttons > 0 || e.pressure > 0;
  if (e.pointerId === holdId) { engine.well.x = e.clientX; engine.well.y = e.clientY; }
  if (engine.phase === 'intro' && performance.now() > armedAt) {
    if (lastPX !== null) moved += Math.hypot(e.clientX - lastPX, e.clientY - lastPY);
    if (moved > 24) triggerBang();
  }
  lastPX = e.clientX; lastPY = e.clientY;
}
function onStart(e) {
  if (engine.phase === 'intro') {
    if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    // explicit input (tap, key, wheel) always counts; too-early ones just wait for the sphere to settle in
    const wait = armedAt - 300 - performance.now();
    if (wait > 0) setTimeout(triggerBang, wait); else triggerBang();
  }
}

function onPointerDown(e) {
  engine.mouse.x = e.clientX; engine.mouse.y = e.clientY;
  if (e.pointerType === 'touch') engine.mouse.on = true;
  if (engine.phase === 'intro') return onStart(e);
  if (engine.phase === 'live' && !e.target.closest('a, button, pre, input, textarea, label, .card')) {
    engine.impulse(e.clientX, e.clientY);
    inkFx.px = e.clientX; inkFx.py = e.clientY; inkFx.pulseT = 0;
    startHold(e);
  }
}

/* ───────────────────────────── reveal ───────────────────────────── */

function build(i) {
  const st = state[i];
  if (st.built) return;
  st.built = true;
  sections[i].classList.add('is-built');
  if (i === HERO && !root.classList.contains('live')) {
    root.classList.add('live');
    if (location.hash && location.hash.length > 1) {
      const target = document.getElementById(location.hash.slice(1));
      if (target && target !== sections[HERO]) setTimeout(() => target.scrollIntoView({ behavior: 'smooth' }), 400);
    }
  }
}

/** The section the particles mostly belong to right now. */
function dominant() {
  if (engine.phase !== 'live') return -1;
  return engine.segP < 0.5 ? engine.segA : engine.segB;
}

const smooth = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };
let heroReveal = 0;
const shownO = sections.map(() => -1);
const fadeEls = sections.map((s) => [...s.children]);
const layered = sections.map(() => false);

/** Opacity goes straight onto the section's children (no inherited variable, so no subtree restyle). */
function setSectionOpacity(i, o) {
  const v = o.toFixed(3);
  // only while a fade is running is the content its own GPU layer: the fade is then
  // compositor-only instead of a repaint of the section's text on every frame
  const mid = o > 0 && o < 1;
  for (const el of fadeEls[i]) {
    el.style.opacity = v;
    if (mid !== layered[i]) el.style.willChange = mid ? 'opacity' : '';
  }
  layered[i] = mid;
}

function clearSectionOpacity() {
  fadeEls.forEach((els, i) => {
    for (const el of els) { el.style.opacity = ''; el.style.willChange = ''; }
    layered[i] = false; shownO[i] = -1;
  });
}

/**
 * How solid each section's DOM content is. It dissolves as its particles start to
 * leave and condenses only once the next section's particles have arrived, so the
 * crisp text and the particle text crossfade instead of overlapping.
 */
function applyOpacity(dt) {
  const live = engine.phase === 'live';
  if (state[HERO].built) heroReveal = Math.min(1, heroReveal + dt / 0.9);
  const a = engine.segA, b = engine.segB, p = engine.segP;
  for (let i = 0; i < sections.length; i++) {
    let o = 0;
    if (live) {
      if (a === b) o = i === a ? 1 : 0;
      else if (i === a) o = 1 - smooth(0.02, 0.3, p);
      else if (i === b) o = smooth(0.72, 0.98, p);
    }
    if (i === HERO) o *= heroReveal;
    const F = engine.formations[i];
    if (F) F.bodyVis = 1 - o;
    inkVis[i] = o;
    if (Math.abs(o - shownO[i]) > 0.004 || (o === 0) !== (shownO[i] === 0) || (o === 1) !== (shownO[i] === 1)) {
      shownO[i] = o;
      if (!ink || degraded) setSectionOpacity(i, o);   // with ink the DOM stays invisible: nothing to restyle
      sections[i].classList.toggle('is-faded', o < 0.5);
    }
  }
}

let currentNav = '';
function updateSections() {
  const sy = window.scrollY;
  const dom = dominant();
  if (dom >= 0) {
    for (let i = 0; i < sections.length; i++) {
      if (state[i].built) continue;
      if (i === dom) {
        // the hero waits for its big reveal; later sections never make you wait to read
        if (i !== HERO || engine.formed > 0.7 || engine.time - liveAt > 3) build(i);
      } else if (anchors[i] - sy < -60) {
        build(i);
      }
    }
  }
  const nav = dom >= 0 ? sections[dom].id : '';
  if (nav !== currentNav) {
    navLinks.get(currentNav)?.removeAttribute('aria-current');
    navLinks.get(nav)?.setAttribute('aria-current', 'true');
    currentNav = nav;
    buildNavInk();
  }
}

/* ───────────────────────────── restart ───────────────────────────── */

let restarting = false;
const brand = document.querySelector('.brand');
singularity.addEventListener('click', () => {
  if (reduced || engine.phase !== 'live') {
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    brand.focus({ preventScroll: true });
    return;
  }
  if (restarting) return;
  restarting = true;
  const F = engine.formations[CONTACT];
  F.targetScale = 0.06;
  setTimeout(() => {
    const r = singularity.getBoundingClientRect();
    flashAt(r.left + r.width / 2, r.top + r.height / 2);
    engine.rebirth(F.cx, F.cy);
    F.targetScale = 1;
    // the particles fly free for a moment, then follow the scroll all the way back up
    window.scrollTo({ top: 0, behavior: 'smooth' });
    brand.focus({ preventScroll: true });
    setTimeout(() => { restarting = false; }, 1500);
  }, 420);
});

/* ───────────────────────────── loop ───────────────────────────── */

let last = performance.now();
const perf = {
  frames: 0, acc: 0, fps: 60, checked: false, js: 0, jsN: 0,
  intro: [], base: 1000 / 60,          // frame interval this device manages when the work is light (ms)
  win: 0, winN: 0, winJank: 0, bad: 0, settle: 0, pendingCut: false, steps: 0,
};

function loop(now) {
  if (degraded) return;
  try { frame(now); } catch (e) { rescue(e); return; }
  if (!degraded) requestAnimationFrame(loop);
}

function frame(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 1 / 30);

  engine.scrollY = window.scrollY;
  if (engine.phase === 'live') {
    const [a, b, p] = segmentAt(engine.scrollY);
    engine.setSegment(a, b, p);
  }

  const j0 = performance.now();
  applyOpacity(dt);
  drawHole();
  drawFocus();
  inkTick(dt);
  engine.step(dt);
  engine.render();
  updateSections();
  perf.js += performance.now() - j0; perf.jsN++;
  adapt(raw, now);
}
let degraded = false;

/* ───────────────────────────── rescue ───────────────────────────── */

// The page is ordinary HTML underneath, and it must never be held hostage by its own
// effects. Any error in the frame loop, in setup or in the bang, or an intro that fails
// to open, ends here: the canvas goes away and the plain page is shown, as if the script
// had never loaded. The reason is kept (footer, ?debug) so a broken device can be traced.
let rescued = false, lastError = '';
function rescue(err) {
  if (rescued) return;
  rescued = true;
  degraded = true;
  lastError = String((err && (err.message || err.reason)) || err || 'unknown error').slice(0, 180);
  console.error('[libir] showing the plain page:', err);
  try { clearSectionOpacity(); } catch { /* nothing to clear */ }
  root.classList.remove('js', 'intro', 'imploding', 'ink', 'holding', 'measuring', 'shake');
  root.classList.add('rescued');
  for (const el of document.querySelectorAll('canvas, .fx, .panes')) el.style.display = 'none';
  const foot = document.querySelector('.foot');
  if (foot) {
    const note = document.createElement('span');
    note.textContent = `The particles are off on this device: ${lastError}`;
    foot.append(note);
  }
}
const guard = (fn) => (...args) => { try { return fn(...args); } catch (e) { rescue(e); } };
addEventListener('error', (e) => { if (engine.phase !== 'live' && /\/js\//.test(e.filename || '')) rescue(e.error || e.message); });
addEventListener('unhandledrejection', (e) => { if (engine.phase !== 'live') rescue(e.reason); });

// Keyboard focus needs a visible ring, and the DOM that would draw one is invisible:
// a single overlay follows whatever has :focus-visible.
let focusEl = null;
function drawFocus() {
  if (!focusEl || !focusRing) return;
  const r = focusEl.getBoundingClientRect();
  focusRing.style.transform = `translate3d(${r.left - 5}px, ${r.top - 5}px, 0)`;
  focusRing.style.width = `${r.width + 10}px`;
  focusRing.style.height = `${r.height + 10}px`;
}
if (ink && focusRing) {
  addEventListener('focusin', (e) => {
    const t = e.target;
    focusEl = t && t.matches && t.matches(':focus-visible') && t !== sayIn ? t : null;
    focusRing.classList.toggle('on', !!focusEl);
  });
  addEventListener('focusout', () => { focusEl = null; focusRing.classList.remove('on'); });
}

/* ───────────────────────────── adaptive quality ───────────────────────────── */

// The expensive moments are the scroll transitions (thousands of streaking particles),
// not the calm hero, so quality is watched for the whole visit, in 1.5 s windows.
// A slow window first lowers the canvas resolution (instant, nothing to rebuild);
// only repeated slow windows cut particles, which needs a rebuild and therefore waits
// until the visitor stops scrolling. Skipped when ?particles= is set.
const MIN_PARTICLES = 3000;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

function updateCount() {
  document.getElementById('pcount').textContent = (engine.active + inkDots).toLocaleString('en-US');
}

function setDpr(v) {
  dprCap = v;
  viewport();
  perf.settle = 0.6;
  perf.steps++;
}

function cutParticles() {
  engine.setActive(engine.active * 0.7);
  rebuild();
  updateCount();
  perf.settle = 1;
  perf.steps++;
}

function adapt(raw, now) {
  if (params.has('particles') || raw > 0.25) return;
  perf.acc += raw; perf.frames++;
  if (perf.frames >= 30) { perf.fps = perf.frames / perf.acc; perf.acc = 0; perf.frames = 0; }

  if (engine.phase === 'intro') {
    if (engine.time > 0.4 && perf.intro.length < 300) perf.intro.push(raw * 1000);
    const capped = perf.fps > 27 && perf.fps < 32;   // Low Power Mode / Energy Saver
    if (!perf.checked && engine.time > 1.2 && perf.fps < 40 && !capped) {
      perf.checked = true;
      perf.intro.length = 0;   // measure the display again with the lighter load
      engine.setActive(engine.active * 0.6);
      engine.startIntro();
      if (ready) rebuild();
      updateCount();
    }
    return;
  }
  if (engine.phase !== 'live') return;
  if (perf.intro) {
    // the light intro shows what this device's display does: 60, 120, or a 30 Hz power-save cap
    if (perf.intro.length >= 20) perf.base = Math.max(1000 / 165, median(perf.intro));
    perf.intro = null;
  }
  if (perf.pendingCut) {
    if (now - lastScrollAt > 350) { perf.pendingCut = false; cutParticles(); }
    return;
  }
  if (perf.settle > 0) { perf.settle -= raw; return; }

  const ms = raw * 1000;
  perf.win += raw; perf.winN++;
  if (ms > Math.max(perf.base * 1.8, 26)) perf.winJank++;
  if (perf.win < 1.5) return;
  const mean = (perf.win * 1000) / perf.winN;
  // slow: well below what this display does when idle and under ~52 fps, or visibly stuttering
  const slow = mean > Math.max(perf.base * 1.3, 19) || perf.winJank / perf.winN > 0.12;
  perf.win = 0; perf.winN = 0; perf.winJank = 0;
  perf.bad = slow ? perf.bad + 1 : 0;
  if (!slow) return;

  const dpr = canvasDpr();
  if (dpr > 1.25) { setDpr(dpr > 1.5 ? 1.5 : 1.25); return; }
  if (perf.bad < 2) return;
  perf.bad = 0;
  if (engine.active > MIN_PARTICLES) perf.pendingCut = true;
  else if (dpr > 1) setDpr(1);
}

/* ───────────────────────────── boot ───────────────────────────── */

async function fontsReady() {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('700 100px "Space Grotesk"'),
        document.fonts.load('400 16px "JetBrains Mono"'),
      ]).then(() => document.fonts.ready),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* draw with whatever font we have */ }
}

/** The logo has to be decoded before its silhouette can be sampled; a late one triggers a rebuild. */
async function imagesReady() {
  const imgs = [...document.querySelectorAll('img[data-form="mask"]')];
  await Promise.race([
    Promise.all(imgs.map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()))),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  for (const img of imgs) if (!img.complete) img.addEventListener('load', () => { if (ready) rebuild(); }, { once: true });
}

function bootReduced() {
  root.classList.add('reduced', 'live');
  root.classList.remove('intro');
  sections.forEach((s, i) => { state[i].built = true; s.classList.add('is-built'); });
  layoutConstellation();
  layoutLoop();
  applySay();
  ready = true;
  if (engine.renderer) {
    viewport();
    engine.setActive(Math.min(engine.active, 2500));
    engine.startStill();
    engine.render();
    let t = 0, w = innerWidth;
    addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        viewport(); engine.render();
        if (innerWidth !== w) { w = innerWidth; layoutConstellation(); layoutLoop(); engine.startStill(); engine.render(); }
      }, 200);
    });
  }
}

async function boot() {
  if (!engine.renderer || reduced) {
    if (!engine.renderer) root.classList.add('no-canvas');
    bootReduced();
    return;
  }
  window.scrollTo(0, 0);
  viewport();
  engine.startIntro();
  requestAnimationFrame((t) => { last = t; loop(t); });

  addEventListener('pointermove', onPointerMove, { passive: true });
  addEventListener('pointerdown', onPointerDown, { passive: true });
  addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') engine.mouse.on = false; endHold(e); }, { passive: true });
  // a cancel means the browser took the gesture (a scroll, usually): let go without the fireworks
  addEventListener('pointercancel', (e) => { engine.mouse.on = false; endHold(e, true); }, { passive: true });
  document.addEventListener('pointerleave', () => { engine.mouse.on = false; endHold(null, true); });
  addEventListener('blur', () => { engine.mouse.on = false; endHold(null, true); });
  addEventListener('contextmenu', (e) => { if (engine.well.on && engine.well.charge > 0.15) e.preventDefault(); });
  addEventListener('touchstart', onStart, { passive: true });
  addEventListener('wheel', onStart, { passive: true });
  addEventListener('keydown', onStart);
  addEventListener('scroll', onStart, { passive: true });
  addEventListener('focusin', onStart);
  // screen readers, switch access and the like may never send a qualifying event
  setTimeout(() => { if (engine.phase === 'intro') triggerBang(); }, 10000);

  const r = engine.renderer;
  if (r && r.kind === 'webgl2') {
    let lostTimer = 0;
    r.onLost = () => {
      // if the GPU doesn't come back, fall back to the plain page instead of an empty one
      lostTimer = setTimeout(() => {
        degraded = true;
        clearSectionOpacity();
        root.classList.remove('ink');
        root.classList.add('reduced', 'live');
        root.classList.remove('intro');
      }, 2000);
    };
    r.onRestored = () => { clearTimeout(lostTimer); inkSig = ''; scheduleInk(); };   // the clouds were on the card: ink again
  }

  await Promise.all([fontsReady(), imagesReady()]);
  rebuild();
  ready = true;
  if (pendingBang) guard(triggerBang)();

  // text can reflow without a window resize (late fonts, text-only zoom): rebuild then too
  let roTimer = 0, roH = document.querySelector('main').offsetHeight;
  const relayout = () => {
    clearTimeout(roTimer);
    roTimer = setTimeout(() => {
      const h = document.querySelector('main').offsetHeight;
      if (Math.abs(h - roH) > 2) { roH = h; rebuild(); }
    }, 200);
  };
  if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(document.querySelector('main'));
  document.fonts?.addEventListener?.('loadingdone', () => { roH = -1; inkSig = ''; relayout(); });
  // a code box scrolled sideways shows other text: ink it again once the scroll settles
  for (const pre of document.querySelectorAll('pre')) {
    pre.addEventListener('scroll', () => reInk(sections.indexOf(pre.closest('[data-section]')), 140), { passive: true });
  }

  let lastW = innerWidth, timer = 0, mainH = document.querySelector('main').offsetHeight;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      viewport();
      computeHomes();
      if (Math.abs(innerWidth - lastW) > 1 || Math.abs(document.querySelector('main').offsetHeight - mainH) > 40) {
        lastW = innerWidth;
        rebuild();
        mainH = document.querySelector('main').offsetHeight;
      }
    }, 160);
  });
}

boot().catch(rescue);
// setup itself must not hang either (fonts, the logo and the first build are all bounded)
setTimeout(() => { if (!ready && !reduced) rescue(new Error('setup did not finish')); }, 9000);

/* ───────────────────────────── debug hook (used by the screenshot harness) ───────────────────────────── */

Object.defineProperty(window, '__libir', {
  value: {
    get ready() { return ready; },
    get phase() { return engine.phase; },
    get focus() { const d = dominant(); return d >= 0 ? sections[d].id : null; },
    get segment() { return [sections[engine.segA]?.id, sections[engine.segB]?.id, +engine.segP.toFixed(3)]; },
    get fps() { return Math.round(perf.fps); },
    /** Mean main-thread time per frame since the last read (ms): what the page's own JavaScript costs. */
    get jsMs() { const v = perf.jsN ? perf.js / perf.jsN : 0; perf.js = 0; perf.jsN = 0; return +v.toFixed(3); },
    get particles() { return engine.active; },
    get dpr() { return canvasDpr(); },
    get quality() { return { steps: perf.steps, base: +perf.base.toFixed(1), pendingCut: perf.pendingCut }; },
    get drawn() { return engine.drawn; },
    get formed() { return +engine.formed.toFixed(3); },
    get renderer() { return engine.kind; },
    get sim() { return engine.sim; },
    get note() { return gpuNote || null; },
    get error() { return lastError || null; },
    get time() { return +engine.time.toFixed(2); },
    get buildMs() { return Math.round(buildMs); },
    get ink() { return ink ? { dots: inkDots, drawn: ink.drawn, ms: Math.round(inkMs), slowest: Math.round(inkMax), pending: inkQueue.length } : null; },
    get bound() { let n = 0; for (let i = 0; i < engine.active; i++) if (engine.mode[i] === BOUND) n++; return n; },
  },
});
// raw engine access for debugging; non-enumerable so JSON snapshots of __libir stay small
Object.defineProperty(window.__libir, 'engine', { get: () => engine, enumerable: false });

// ?debug: a small readout, for checking the adaptive quality on a real phone
if (params.has('debug')) {
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:20;pointer-events:none;font:11px/1.4 var(--mono);color:#7fe8e0;background:rgba(0,0,0,.7);padding:4px 7px;border-radius:4px';
  document.body.append(hud);
  setInterval(() => {
    const c = (engine.renderer && engine.renderer.canvas) || canvas;
    hud.textContent = `${Math.round(perf.fps)} fps · ${engine.active} particles · ${engine.sim}${ink ? '+ink' : ''} · dpr ${canvasDpr()} · ${c.width}×${c.height} · step ${perf.steps} · ${engine.phase}${ready ? '' : ' (not ready)'}${gpuNote ? ' · ' + gpuNote : ''}${lastError ? ' · ERROR ' + lastError : ''}`;
  }, 500);
}
