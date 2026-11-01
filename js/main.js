// Page director: builds formations from the DOM, runs the intro and the big bang,
// and turns the scroll position into "how far the particles are between section A and B".

import { Cosmos, BOUND } from './engine.js';
import { sampleText, sampleShapes, shufflePairs, docRect, fib } from './sampler.js';

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
const topbar = document.querySelector('.topbar');
let topbarScrolled = false;
addEventListener('scroll', () => {
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

function budget() {
  const forced = parseInt(params.get('particles'), 10);
  if (forced > 0) return Math.min(40000, forced);
  const area = innerWidth * innerHeight;
  let n = area > 1.3e6 ? 26000 : area > 7e5 ? 20000 : 12000;
  if ((navigator.hardwareConcurrency || 8) <= 4) n = Math.round(n * 0.7);
  return n;
}

const engine = new Cosmos(canvas, budget());
if (engine.kind === '2d') engine.setActive(Math.min(engine.N, 4000));
document.getElementById('pcount').textContent = engine.active.toLocaleString('en-US');

function viewport() {
  const r = ((engine.renderer && engine.renderer.canvas) || canvas).getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  engine.setViewport(r.width || innerWidth, r.height || innerHeight, dpr);
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
  const dot = (el) => el.querySelector('.dot');
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

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/**
 * Every formation gets exactly M points (subsampled or padded), ordered by x. Particle
 * rank j then means "j-th from the left" in every section, which keeps paths short.
 * `kinds` travels with the points: 0 = heading/shape, 1 = body text.
 */
function finalize(points, kinds, M, fallback) {
  let n = points.length >> 1;
  if (!n) {
    points = new Float32Array(2 * M);
    kinds = new Uint8Array(M);
    for (let k = 0; k < M; k++) {
      points[2 * k] = fallback.left + Math.random() * fallback.width;
      points[2 * k + 1] = fallback.top + Math.random() * fallback.height;
    }
    n = M;
  }
  const order = new Int32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  for (let k = n - 1; k > 0; k--) { const r = (Math.random() * (k + 1)) | 0; const t = order[k]; order[k] = order[r]; order[r] = t; }
  const raw = new Float32Array(2 * M), rk = new Uint8Array(M);
  for (let k = 0; k < M; k++) {
    const src = k < n ? order[k] : order[(Math.random() * n) | 0];
    const pad = k < n ? 0 : 1.6;
    raw[2 * k] = points[2 * src] + (Math.random() - 0.5) * pad;
    raw[2 * k + 1] = points[2 * src + 1] + (Math.random() - 0.5) * pad;
    rk[k] = kinds[src];
  }
  const key = new Float32Array(M);
  const idx = new Int32Array(M);
  for (let k = 0; k < M; k++) { idx[k] = k; key[k] = raw[2 * k] + (Math.random() - 0.5) * 40; }
  idx.sort((a, b) => key[a] - key[b]);
  const out = new Float32Array(2 * M), kind = new Uint8Array(M);
  for (let k = 0; k < M; k++) {
    out[2 * k] = raw[2 * idx[k]]; out[2 * k + 1] = raw[2 * idx[k] + 1];
    kind[k] = rk[idx[k]];
  }
  return { points: out, kind };
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
    const body = sampleText(sec, Math.max(200, (M - shapes.length / 2) * bodyShare), bodyStep, { exclude: BODY_EXCLUDE, scale: 2 });
    const bsize = Math.min(1.3, Math.max(0.85, body.step * 0.5));
    if (i === CONTACT) return sphereFormation(M, body.points, bsize);
    const title = sec.querySelector('[data-form="text"]');
    const nb = body.points.length >> 1, ns = shapes.length >> 1;
    const head = sampleText(title, Math.max(300, M - nb - ns), minStep);
    const nh = head.points.length >> 1;
    const all = new Float32Array(2 * (nh + ns + nb));
    all.set(head.points, 0); all.set(shapes, 2 * nh); all.set(body.points, 2 * (nh + ns));
    const kinds = new Uint8Array(nh + ns + nb);
    kinds.fill(1, nh + ns);
    const { points, kind } = finalize(all, kinds, M, docRect(title));
    return {
      id: sec.id,
      points, kind,
      psize: Math.min(2.3, Math.max(1.15, head.step * 0.62)),
      bsize,
      bodyVis: 1,
    };
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
  entries.forEach((e, j) => {
    if (e.d) { isS[j] = 1; ux[j] = e.d[0]; uy[j] = e.d[1]; uz[j] = e.d[2]; }
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
    dynamic(F, t, dt) {
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
        F.points[2 * j] = F.cx + X * R;
        F.points[2 * j + 1] = F.cy + Y * R;
        F.depth[j] = (Z2 + 1) * 0.5;
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
  engine.formations = buildFormations();
  computeHomes();
  if (engine.phase === 'live' && builtM !== engine.M) engine.assign({ spread: 0.2 });
  builtM = engine.M;
  buildMs = performance.now() - t0;
}

/* ───────────────────────────── effects ───────────────────────────── */

function flashAt(x, y) {
  fx.style.setProperty('--x', `${x}px`);
  fx.style.setProperty('--y', `${y}px`);
  fx.classList.remove('bang');
  void fx.offsetWidth;
  fx.classList.add('bang');
  root.classList.remove('shake');
  void root.offsetWidth;
  root.classList.add('shake');
  setTimeout(() => root.classList.remove('shake'), 500);
}

/* ───────────────────────────── the big bang ───────────────────────────── */

function triggerBang() {
  if (engine.phase !== 'intro') return;
  if (!ready) { pendingBang = true; return; }
  engine.implode();
  root.classList.add('imploding');
  setTimeout(() => {
    engine.bang();
    flashAt(engine.intro.cx, engine.intro.cy);
    setTimeout(() => {
      engine.phase = 'live';
      liveAt = engine.time;
      engine.setSegment(HERO, HERO, 0);
      engine.assign({ spread: 0.55, swirl: 0.45, stiffness: 0.6 });
    }, 420);
    setTimeout(() => root.classList.remove('intro', 'imploding'), 1000);
  }, 340);
}

let armedAt = performance.now() + 650;
let moved = 0, lastPX = null, lastPY = null;
function onPointerMove(e) {
  engine.mouse.x = e.clientX;
  engine.mouse.y = e.clientY;
  engine.mouse.on = e.pointerType !== 'touch' || e.buttons > 0 || e.pressure > 0;
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
  if (engine.phase === 'live' && !e.target.closest('a, button, pre, input, textarea, .card')) {
    engine.impulse(e.clientX, e.clientY);
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
    if (Math.abs(o - shownO[i]) > 0.004 || (o === 0) !== (shownO[i] === 0)) {
      shownO[i] = o;
      sections[i].style.setProperty('--o', o.toFixed(3));
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
let perf = { frames: 0, acc: 0, fps: 60, checked: false, liveChecked: false, liveAcc: 0, liveFrames: 0 };

function loop(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 1 / 30);

  engine.scrollY = window.scrollY;
  if (engine.phase === 'live') {
    const [a, b, p] = segmentAt(engine.scrollY);
    engine.setSegment(a, b, p);
  }

  applyOpacity(dt);
  engine.step(dt);
  engine.render();
  updateSections();
  adapt(raw);
  if (!degraded) requestAnimationFrame(loop);
}
let degraded = false;

// Drop particles once if this machine can't keep up. Skipped when ?particles= is set.
function adapt(raw) {
  if (params.has('particles') || raw > 0.25) return;
  perf.acc += raw; perf.frames++;
  if (perf.frames >= 30) { perf.fps = perf.frames / perf.acc; perf.acc = 0; perf.frames = 0; }
  const capped = perf.fps > 27 && perf.fps < 32;   // Low Power Mode / Energy Saver
  if (!perf.checked && engine.phase === 'intro' && engine.time > 1.2 && perf.fps < 40 && !capped) {
    perf.checked = true;
    engine.setActive(engine.active * 0.6);
    engine.startIntro();
    if (ready) rebuild();
    document.getElementById('pcount').textContent = engine.active.toLocaleString('en-US');
  }
  if (engine.phase === 'live' && !perf.liveChecked) {
    perf.liveAcc += raw; perf.liveFrames++;
    if (perf.liveAcc > 3) {
      perf.liveChecked = true;
      const fps = perf.liveFrames / perf.liveAcc;
      if (fps < 38 && !(fps > 27 && fps < 32) && engine.active > 3000) {
        engine.setActive(engine.active * 0.65);
        rebuild();
        document.getElementById('pcount').textContent = engine.active.toLocaleString('en-US');
      }
    }
  }
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

function bootReduced() {
  root.classList.add('reduced', 'live');
  root.classList.remove('intro');
  sections.forEach((s, i) => { state[i].built = true; s.classList.add('is-built'); });
  layoutConstellation();
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
        if (innerWidth !== w) { w = innerWidth; layoutConstellation(); engine.startStill(); engine.render(); }
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
  addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') engine.mouse.on = false; }, { passive: true });
  addEventListener('pointercancel', () => { engine.mouse.on = false; }, { passive: true });
  document.addEventListener('pointerleave', () => { engine.mouse.on = false; });
  addEventListener('blur', () => { engine.mouse.on = false; });
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
        root.classList.add('reduced', 'live');
        root.classList.remove('intro');
      }, 2000);
    };
    r.onRestored = () => clearTimeout(lostTimer);
  }

  await fontsReady();
  rebuild();
  ready = true;
  if (pendingBang) triggerBang();

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
  document.fonts?.addEventListener?.('loadingdone', () => { roH = -1; relayout(); });

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

boot();

/* ───────────────────────────── debug hook (used by the screenshot harness) ───────────────────────────── */

Object.defineProperty(window, '__libir', {
  value: {
    get ready() { return ready; },
    get phase() { return engine.phase; },
    get focus() { const d = dominant(); return d >= 0 ? sections[d].id : null; },
    get segment() { return [sections[engine.segA]?.id, sections[engine.segB]?.id, +engine.segP.toFixed(3)]; },
    get fps() { return Math.round(perf.fps); },
    get particles() { return engine.active; },
    get drawn() { return engine.drawn; },
    get formed() { return +engine.formed.toFixed(3); },
    get renderer() { return engine.kind; },
    get time() { return +engine.time.toFixed(2); },
    get buildMs() { return Math.round(buildMs); },
    get bound() { let n = 0; for (let i = 0; i < engine.active; i++) if (engine.mode[i] === BOUND) n++; return n; },
  },
});
// raw engine access for debugging; non-enumerable so JSON snapshots of __libir stay small
Object.defineProperty(window.__libir, 'engine', { get: () => engine, enumerable: false });
