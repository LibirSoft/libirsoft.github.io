// The particle universe, simulated in JavaScript. Plain typed arrays, no libraries.
// With WebGL2 the page runs the same model on the GPU instead (gpu.js); this version is
// the reference, and what drives the plain 2D canvas when WebGL2 is missing.
//
// Every particle is in one of three modes:
//   INTRO   pinned to the rotating singularity sphere (screen space)
//   AMBIENT free stardust drifting in a flow field (screen space, wraps around)
//   BOUND   one of the M "formation" particles, held by a spring (DOCUMENT space, so
//           it scrolls with the page)
// Every formation has exactly M target points, ordered by x. Bound particle i always
// owns point rank[i] in every formation, so moving between two sections is just a
// per-particle blend from A's point to B's point. The page drives that blend with the
// scroll position: scroll half way, and the particles are half way.
// Points come in two kinds: headings/shapes (kind 0) stay as particles at rest; body
// text (kind 1) is only visible while it is being built or torn down, because at rest
// the crisp DOM text takes over (formation.bodyVis, set by the page, crossfades them).
// A formation may also carry per-point `depth` (brightness) and `tint` (0..1 towards
// teal), and a `dynamic(F, t, dt)` hook that moves its points every frame.

import { createRenderer, STRIDE } from './renderer.js';
import { fib } from './sampler.js';

const TAU = Math.PI * 2;
export const INTRO = 2, AMBIENT = 0, BOUND = 1;

const PALETTE = [
  // r, g, b, weight
  [1.0, 1.0, 1.0, 0.70],
  [0.55, 1.0, 0.95, 0.14],  // teal, from v1
  [0.70, 0.75, 1.0, 0.11],  // blue-violet
  [1.0, 0.84, 0.66, 0.05],  // warm
];
const HOT = [1.0, 0.72, 0.42];
const TEAL = [0.22, 1.0, 0.9];
const MAX_SPEED = 4200;
const RAMP = 0.7;          // seconds for a spring to reach full stiffness
const STAG = 0.5;          // how spread out departures are along a scroll transition
export const FORM_FRAC = 0.66; // share of particles that build formations
export const IMPLODE = 0.34;      // seconds of collapse before the bang

export function pickColor() {
  let r = Math.random();
  for (const c of PALETTE) { if ((r -= c[3]) <= 0) return c; }
  return PALETTE[0];
}

export class Cosmos {
  constructor(canvas, count, renderer) {
    this.canvas = canvas;
    this.renderer = renderer !== undefined ? renderer : createRenderer(canvas);
    this.sim = 'cpu';
    this.kind = this.renderer ? this.renderer.kind : 'none';
    this.N = count;
    this.active = count;
    const F = () => new Float32Array(count);
    this.x = F(); this.y = F(); this.vx = F(); this.vy = F();
    this.k = F(); this.attach = F(); this.swirl = F();
    this.look = F(); this.heat = F(); this.dep = F();
    this.z = F(); this.tw = F(); this.seed = F();
    this.cr = F(); this.cg = F(); this.cb = F();
    this.ux = F(); this.uy = F(); this.uz = F();
    this.stag = F(); this.sway = F(); this.qv = F();
    this.sunk = F();   // how deep in the gravity well a particle is (0..1)
    this.mode = new Uint8Array(count);
    this.rank = new Int32Array(count).fill(-1);
    this.out = new Float32Array(count * STRIDE);

    for (let i = 0; i < count; i++) {
      this.seed[i] = Math.random();
      this.z[i] = 0.12 + 0.88 * Math.pow(Math.random(), 1.7);
      this.tw[i] = Math.random() * TAU;
      const c = pickColor();
      this.cr[i] = c[0]; this.cg[i] = c[1]; this.cb[i] = c[2];
      this.stag[i] = Math.random();
      this.sway[i] = (Math.random() - 0.5) * 140;
    }

    this.formations = [];
    this.segA = 0; this.segB = 0; this.segP = 0;
    this.formed = 0;
    this.time = 0;
    this.scrollY = 0;
    this.lastScrollY = 0;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.mouse = { x: -1e5, y: -1e5, on: false };
    // press and hold: a gravity well in screen space that charges while it is held
    this.well = { x: 0, y: 0, on: false, charge: 0 };
    this.repel = 90;
    this.ambDrag = 0.9;
    this.phase = 'intro';
    this.intro = { cx: 0, cy: 0, R: 100, spin: 0, implodeAt: -1, scale: 1 };
    this.sizeScale = 1;
    this.fadeA = -1e9; this.fadeB = -1e9;   // formations fade out between these screen ys (under the top bar)
    this.panes = null; this.paneCount = 0;  // dark panels (x0, y0, x1, y1, strength): free stars dim inside them
    this.maxStretch = 26;
    this.frame = 0;
    this.drawn = 0;
  }

  setViewport(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    if (this.renderer) this.renderer.resize(w, h, dpr);
    const I = this.intro;
    I.cx = w / 2; I.cy = h / 2;
    I.R = Math.max(70, Math.min(w, h) * (w < 640 ? 0.26 : 0.2));
    this.sizeScale = w < 640 ? 0.85 : 1;
    this.repel = w < 640 ? 70 : 95;
    // in-transit streaks dominate the fill cost; a phone screen doesn't need them as long
    this.maxStretch = w < 640 ? 13 : 26;
  }

  setActive(n) {
    this.active = Math.max(500, Math.min(this.N, n | 0));
    for (let i = this.active; i < this.N; i++) { this.mode[i] = AMBIENT; this.rank[i] = -1; }
  }

  /** How many particles build formations (every formation has exactly this many points). */
  get M() { return Math.round(this.active * FORM_FRAC); }

  /* ───────────────────────────── phases ───────────────────────────── */

  /** Black screen, a sphere of light, faint stars. */
  startIntro() {
    const M = Math.round(this.active * 0.86);
    const v = [0, 0, 0];
    for (let i = 0; i < this.active; i++) {
      this.vx[i] = 0; this.vy[i] = 0;
      this.rank[i] = -1; this.look[i] = 0; this.heat[i] = 0;
      if (i < M) {
        fib(i, M, v);
        this.ux[i] = v[0]; this.uy[i] = v[1]; this.uz[i] = v[2];
        this.mode[i] = INTRO;
      } else {
        this.mode[i] = AMBIENT;
        this.x[i] = Math.random() * this.w;
        this.y[i] = Math.random() * this.h;
        this.z[i] = 0.12 + 0.3 * Math.random();   // only distant stars before the bang
      }
    }
    this.phase = 'intro';
    this.intro.implodeAt = -1;
    this.stepIntro(0);
  }

  /** Static starfield for prefers-reduced-motion. */
  startStill() {
    for (let i = 0; i < this.active; i++) {
      this.mode[i] = AMBIENT; this.rank[i] = -1; this.look[i] = 0; this.heat[i] = 0;
      this.vx[i] = 0; this.vy[i] = 0;
      this.x[i] = Math.random() * this.w;
      this.y[i] = Math.random() * this.h;
    }
    this.phase = 'still';
  }

  implode() {
    if (this.phase !== 'intro') return false;
    this.phase = 'implode';
    this.intro.implodeAt = this.time;
    return true;
  }

  /** The big bang: every sphere particle gets a radial kick sized so the cloud settles across the screen. */
  bang() {
    const I = this.intro;
    this.phase = 'bang';
    this.bangAt = this.time;
    const reach = Math.hypot(this.w, this.h) * 0.6;
    const lam = 2.3;
    for (let i = 0; i < this.active; i++) {
      if (this.mode[i] === INTRO) {
        let dx = this.x[i] - I.cx, dy = this.y[i] - I.cy;
        let d = Math.hypot(dx, dy);
        let a = d > 0.01 ? Math.atan2(dy, dx) : Math.random() * TAU;
        a += (Math.random() - 0.5) * 0.6;
        const rf = (0.05 + 0.95 * Math.sqrt(Math.random())) * reach;
        const sp = lam * rf * (0.85 + 0.3 * Math.random());
        this.vx[i] = Math.cos(a) * sp;
        this.vy[i] = Math.sin(a) * sp;
        this.mode[i] = AMBIENT;
        this.heat[i] = 0.75 + 0.25 * Math.random();
        this.look[i] = 0.6;
      } else if (this.mode[i] === AMBIENT) {
        this.kick(i, this.x[i] - I.cx, this.y[i] - I.cy, 700);
      }
    }
    this.ambDrag = lam;
  }

  /** Restart from the contact-page singularity: blow the bound sphere apart in document space. */
  rebirth(cxDoc, cyDoc) {
    const syc = cyDoc - this.scrollY;
    for (let i = 0; i < this.active; i++) {
      if (this.mode[i] === BOUND) {
        let dx = this.x[i] - cxDoc, dy = this.y[i] - cyDoc;
        const d = Math.hypot(dx, dy);
        const a = d > 0.01 ? Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.5 : Math.random() * TAU;
        const sp = 500 + 1500 * Math.random();
        this.vx[i] = Math.cos(a) * sp;
        this.vy[i] = Math.sin(a) * sp;
        this.heat[i] = 0.8 + 0.2 * Math.random();
        this.attach[i] = this.time + 0.35 + Math.random() * 0.6;
        this.swirl[i] = 0.3 * (0.6 + 0.8 * Math.random());
      } else if (this.mode[i] === AMBIENT) {
        this.kick(i, this.x[i] - this.w / 2, this.y[i] - syc, 900);
      }
    }
    this.ambDrag = 2.0;
  }

  kick(i, dx, dy, power) {
    const d = Math.hypot(dx, dy) || 1;
    const f = power / (1 + d / 260);
    this.vx[i] += (dx / d) * f;
    this.vy[i] += (dy / d) * f;
  }

  /** Click/tap shockwave in screen space. */
  impulse(sx, sy, radius = 190, power = 900) {
    const r2 = radius * radius;
    for (let i = 0; i < this.active; i++) {
      const m = this.mode[i];
      if (m === INTRO) continue;
      const py = m === BOUND ? this.y[i] - this.scrollY : this.y[i];
      const dx = this.x[i] - sx, dy = py - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 < 0.01) continue;
      const d = Math.sqrt(d2);
      const f = (1 - d / radius) * power;
      this.vx[i] += (dx / d) * f;
      this.vy[i] += (dy / d) * f;
      this.heat[i] = Math.max(this.heat[i], 0.25 * (1 - d / radius));
    }
  }

  wellRadius() { return (150 + 330 * this.well.charge) * (this.w < 640 ? 0.72 : 1); }

  /** Let go of the hole. Whatever it gathered is thrown back out; returns the charge it had (0 for a mere click). */
  releaseWell() {
    const well = this.well;
    if (!well.on) return 0;
    const c = well.charge, R = this.wellRadius() * 1.25;
    well.on = false; well.charge = 0;
    if (c < 0.22) return 0;
    const t = this.time, sy = this.scrollY;
    for (let i = 0; i < this.active; i++) {
      const m = this.mode[i];
      if (m === INTRO) continue;
      const dx = this.x[i] - well.x, dy = (m === BOUND ? this.y[i] - sy : this.y[i]) - well.y;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const f = 1 - d / R;
      const a = d > 0.5 ? Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.5 : Math.random() * TAU;
      const sp = (500 + 1900 * c) * f * (0.5 + Math.random());
      this.vx[i] = this.vx[i] * 0.3 + Math.cos(a) * sp;
      this.vy[i] = this.vy[i] * 0.3 + Math.sin(a) * sp;
      this.heat[i] = Math.max(this.heat[i], 0.45 + 0.55 * f);
      if (m === BOUND) this.attach[i] = t + 0.15 + Math.random() * 0.65 * c;
    }
    this.ambDrag = 1.6;
    return c;
  }

  /* ───────────────────────────── formations ───────────────────────────── */

  toBound(i) { if (this.mode[i] !== BOUND) { this.y[i] += this.scrollY; this.mode[i] = BOUND; } }
  toAmbient(i) {
    if (this.mode[i] === BOUND) this.y[i] -= this.scrollY;
    this.mode[i] = AMBIENT;
    this.rank[i] = -1;
  }

  /** Which two formations the scroll position sits between, and how far along (0..1). */
  setSegment(a, b, p) {
    this.segA = a; this.segB = b; this.segP = p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /**
   * Pick the M formation particles and give each a rank. Ranks follow x, and every
   * formation's points are ordered by x too, so particle paths between any two
   * sections run mostly straight up or down instead of criss-crossing.
   */
  assign({ delay = 0, spread = 0.45, swirl = 0, stiffness = 1 } = {}) {
    const M = this.M;
    const bound = [], ambient = [];
    for (let i = 0; i < this.active; i++) {
      if (this.mode[i] === BOUND) bound.push(i);
      else if (this.mode[i] === AMBIENT) ambient.push(i);
    }
    let pool = bound;
    if (pool.length > M) {
      shuffle(pool);
      for (const i of pool.splice(M)) this.toAmbient(i);
    } else if (pool.length < M) {
      shuffle(ambient);
      const take = ambient.slice(0, M - pool.length);
      for (const i of take) this.toBound(i);
      pool = pool.concat(take);
    }
    const key = this.pkey || (this.pkey = new Float32Array(this.N));
    for (const i of pool) key[i] = this.x[i] + (Math.random() - 0.5) * 40;
    pool.sort((a, b) => key[a] - key[b]);
    const t = this.time;
    for (let j = 0; j < pool.length; j++) {
      const i = pool[j];
      this.rank[i] = j;
      this.attach[i] = t + delay + Math.random() * spread;
      this.k[i] = (100 + 60 * Math.random()) * stiffness;
      this.swirl[i] = swirl * (0.6 + 0.8 * Math.random());
    }
  }

  /* ───────────────────────────── simulation ───────────────────────────── */

  stepIntro(dt) {
    const I = this.intro;
    const t = this.time;
    let p = 0;
    if (I.implodeAt >= 0) p = Math.min(1, (t - I.implodeAt) / IMPLODE);
    const scale = (1 + 0.025 * Math.sin(t * 1.7)) * (1 - 0.93 * p * p * p);
    I.spin += dt * (0.22 + p * p * 9);
    const R = I.R * scale;
    const ry = I.spin, rx = 0.36 + 0.06 * Math.sin(t * 0.31);
    const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    for (let i = 0; i < this.active; i++) {
      if (this.mode[i] !== INTRO) continue;
      const ux = this.ux[i], uy = this.uy[i], uz = this.uz[i];
      const X = ux * cy + uz * sy;
      const Z = -ux * sy + uz * cy;
      const Y = uy * cx - Z * sx;
      const Z2 = uy * sx + Z * cx;
      const wob = 1 + 0.012 * Math.sin(t * 2.3 + this.seed[i] * 40);
      this.x[i] = I.cx + X * R * wob;
      this.y[i] = I.cy + Y * R * wob;
      this.dep[i] = Z2;
      this.heat[i] = p * p * 0.9;
    }
    return p;
  }

  step(dt) {
    this.time += dt;
    this.frame++;
    const t = this.time;
    const phase = this.phase;
    if (phase === 'still') return;

    if (phase === 'intro' || phase === 'implode') this.stepIntro(dt);

    const sy = this.scrollY;
    const dScroll = sy - this.lastScrollY;
    this.lastScrollY = sy;

    this.ambDrag += (0.9 - this.ambDrag) * Math.min(1, dt * 0.7);
    const ambDrag = this.ambDrag;

    const FA = this.formations[this.segA], FB = this.formations[this.segB];
    if (FA && FA.dynamic) FA.dynamic(FA, t, dt);
    if (FB && FB !== FA && FB.dynamic) FB.dynamic(FB, t, dt);
    const PA = FA ? FA.points : null, PB = FB ? FB.points : null;
    const blend = PA && PB && PA !== PB && this.segP > 0;
    const segP = this.segP;
    let near = 0, nBound = 0;

    const well = this.well;
    if (well.on) well.charge = Math.min(1, well.charge + dt / 1.5);
    const wOn = well.on && well.charge > 0.06;   // a plain click never gets this far
    const wx = well.x, wy = well.y, wc = well.charge;
    const WR = this.wellRadius(), WR2 = WR * WR, r0 = 22 + 26 * wc;

    const mOn = this.mouse.on && !wOn;
    const mx = this.mouse.x, my = this.mouse.y;
    const R = this.repel, R2 = R * R;
    const RA = R * 1.7, RA2 = RA * RA;
    const W = this.w, H = this.h, MW = W + 60, MH = H + 60;
    const heatDecay = Math.exp(-dt * 1.15), sunkDecay = Math.exp(-dt * 5);
    const lookRate = Math.min(1, dt * 2.2);

    const { x, y, vx, vy, mode } = this;
    for (let i = 0, n = this.active; i < n; i++) {
      const m = mode[i];
      if (m === INTRO) continue;
      let px = x[i], py = y[i], ax, ay;
      const vxi = vx[i], vyi = vy[i];

      if (m === BOUND) {
        const j = this.rank[i];
        if (j < 0 || !PA) { this.toAmbient(i); continue; }
        let tx = PA[2 * j], ty = PA[2 * j + 1];
        let q = 0;
        if (blend) {
          // each particle leaves on its own schedule, so a transition reads as a stream
          q = (segP - this.stag[i] * STAG) / (1 - STAG);
          q = q < 0 ? 0 : q > 1 ? 1 : q;
          q = q * q * (3 - 2 * q);
          if (q > 0) {
            tx += (PB[2 * j] - tx) * q + Math.sin(q * Math.PI) * this.sway[i];
            ty += (PB[2 * j + 1] - ty) * q;
          }
        }
        this.qv[i] = q;
        const age = t - this.attach[i];
        if (age > 0) {
          const ramp = age >= RAMP ? 1 : (age / RAMP) * (age / RAMP);
          const kk = this.k[i] * ramp;
          const c = 1.7 * Math.sqrt(kk) + 0.6;
          const dx = tx - px, dy = ty - py;
          ax = dx * kk - vxi * c;
          ay = dy * kk - vyi * c;
          nBound++;
          if (dx * dx + dy * dy < 25) near++;
          const sw = age < 1.6 ? this.swirl[i] : 0;
          if (sw > 0) {
            const d = Math.abs(dx) + Math.abs(dy);
            if (d > 30) {
              const f = sw * kk * (d / (d + 140));
              ax -= dy * f; ay += dx * f;
            }
          }
        } else {
          ax = -vxi * 1.8; ay = -vyi * 1.8;
          nBound++;
        }
        if (mOn) {
          const dx = px - mx, dy = (py - sy) - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < R2 && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (1 - d / R);
            const push = f * f * 5200;
            ax += (dx / d) * push; ay += (dy / d) * push;
          }
        }
        this.look[i] += (1 - this.look[i]) * lookRate;
      } else {
        // ambient: parallax with the page, then drift in a slow flow field
        const z = this.z[i];
        py -= dScroll * (0.08 + 0.32 * z);
        const sd = this.seed[i];
        const ang = (Math.sin(px * 0.0021 + t * 0.11 + sd * 5) + Math.cos(py * 0.0024 - t * 0.09 + sd * 3)) * Math.PI;
        const sp = 4 + 10 * z;
        ax = (Math.cos(ang) * sp - vxi) * ambDrag;
        ay = (Math.sin(ang) * sp - vyi) * ambDrag;
        if (mOn) {
          const dx = px - mx, dy = py - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < RA2 && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = 1 - d / RA;
            const push = f * f * 1400 * z;
            ax += (dx / d) * push - (dy / d) * push * 0.6;
            ay += (dy / d) * push + (dx / d) * push * 0.6;
          }
        }
        this.look[i] -= this.look[i] * lookRate * 0.6;
      }

      if (wOn) {
        const dx = wx - px, dy = wy - (m === BOUND ? py - sy : py);
        const d2 = dx * dx + dy * dy;
        if (d2 < WR2) {
          // the spring lets go as the hole takes over; matter falls to a ring and is dragged round it
          const d = Math.sqrt(d2) + 0.01;
          let w = 1 - d / WR; w = wc * w * (2 - w);
          const nx = dx / d, ny = dy / d;
          let e = (d - r0) / 70; e = e > 1 ? 1 : e < -1 ? -1 : e;
          const keep = (1 - w) * (1 - w);
          const rad = 5200 * w * e, tan = 900 * w, drag = 2.4 * w;
          ax = ax * keep + nx * rad - ny * tan - vxi * drag;
          ay = ay * keep + ny * rad + nx * tan - vyi * drag;
          this.sunk[i] = w;
        }
      }

      let nvx = vxi + ax * dt, nvy = vyi + ay * dt;
      const s2 = nvx * nvx + nvy * nvy;
      if (s2 > MAX_SPEED * MAX_SPEED) { const k = MAX_SPEED / Math.sqrt(s2); nvx *= k; nvy *= k; }
      px += nvx * dt; py += nvy * dt;

      if (m === AMBIENT && (px < -30 || px > W + 30 || py < -30 || py > H + 30)) {
        if (px < -240 || px > W + 240 || py < -240 || py > H + 240) {
          // far away (e.g. released from an off-screen formation): re-seed as a fresh star,
          // otherwise a wrapped block of particles would keep the old text's shape
          px = Math.random() * W; py = Math.random() * H;
          nvx = 0; nvy = 0; this.look[i] = 0; this.heat[i] = 0;
        } else {
          // wrap, but scatter along the other axis so no shape survives the trip
          if (px < -30 || px > W + 30) { px = ((px + 30) % MW + MW) % MW - 30; py = Math.random() * H; }
          else { py = ((py + 30) % MH + MH) % MH - 30; px = Math.random() * W; }
          nvx *= 0.25; nvy *= 0.25;
        }
      }
      x[i] = px; y[i] = py; vx[i] = nvx; vy[i] = nvy;
      this.heat[i] *= heatDecay;
      this.sunk[i] *= sunkDecay;
    }

    this.formed = nBound ? near / nBound : 0;
  }

  /* ───────────────────────────── render ───────────────────────────── */

  render() {
    if (!this.renderer) return;
    const o = this.out;
    const W = this.w, H = this.h, sy = this.scrollY, t = this.time;
    const ss = this.sizeScale;
    const introP = this.intro.implodeAt >= 0 ? Math.min(1, (t - this.intro.implodeAt) / IMPLODE) : 0;
    const FA = this.formations[this.segA], FB = this.formations[this.segB] || FA;
    const phaseLive = this.phase === 'live';
    let n = 0;
    for (let i = 0, N = this.active; i < N; i++) {
      const m = this.mode[i];
      const px = this.x[i];
      const py = m === BOUND ? this.y[i] - sy : this.y[i];
      if (px < -40 || px > W + 40 || py < -40 || py > H + 40) continue;
      let size, alpha;
      let r = this.cr[i], g = this.cg[i], b = this.cb[i];
      if (m === INTRO) {
        const d = (this.dep[i] + 1) * 0.5;
        // slow ripples of light crawling over the sphere: the only "hint" on screen
        const rip = Math.sin(this.uy[i] * 7 + this.ux[i] * 2 - t * 2.1);
        const glow = rip > 0.92 ? (rip - 0.92) * 9 : 0;
        size = (0.7 + 0.9 * d) * 1.25 * ss * (1 + introP);
        alpha = (0.05 + 0.62 * d * d) * (1 + glow) * (1 + introP * 2);
        r += (1 - r) * 0.7; g += (1 - g) * 0.7; b += (1 - b) * 0.7;
      } else {
        const L = this.look[i];
        const z = this.z[i];
        const tw = 0.72 + 0.28 * Math.sin(t * (0.6 + this.seed[i] * 2.4) + this.tw[i]);
        const ambS = (0.5 + 1.25 * z) * ss;
        const ambA = (0.06 + 0.36 * z * z) * tw;
        let fs = 1.9 * ss, fa = 0.9, tint = 0;
        if (m === BOUND && FA) {
          const j = this.rank[i], q = this.qv[i];
          const kA = FA.kind ? FA.kind[j] : 0, kB = FB.kind ? FB.kind[j] : 0;
          let aA = FA.depth ? 0.25 + 0.75 * FA.depth[j] : 0.9;
          let aB = FB.depth ? 0.25 + 0.75 * FB.depth[j] : 0.9;
          if (kA) aA = 0.85 * FA.bodyVis;
          if (kB) aB = 0.85 * FB.bodyVis;
          const sA = kA ? FA.bsize : FA.psize, sB = kB ? FB.bsize : FB.psize;
          fs = (sA + (sB - sA) * q) * ss;
          fa = aA + (aB - aA) * q;
          const tA = FA.tint ? FA.tint[j] : 0, tB = FB.tint ? FB.tint[j] : 0;
          tint = tA + (tB - tA) * q;
          if (q > 0 && q < 1) fa = Math.max(fa, 0.85 * Math.sin(q * Math.PI));
          if (fa < 0.015 && L > 0.95 && this.heat[i] < 0.02 && this.sunk[i] < 0.02) continue;
          if (q > 0 && q < 1) {
            // in transit: thinner and dimmer, so the stream never smothers the text it crosses
            const f = Math.sin(q * Math.PI);
            fa *= 1 - 0.5 * f;
            fs *= 1 - 0.25 * f;
          }
        }
        size = ambS + (fs - ambS) * L;
        alpha = ambA + (fa - ambA) * L;
        if (m !== BOUND && this.paneCount) {
          const P = this.panes, dy = py + sy;
          let dim = 0;
          for (let k = 0, e = this.paneCount * 5; k < e; k += 5) {
            if (px > P[k] && px < P[k + 2] && dy > P[k + 1] && dy < P[k + 3] && P[k + 4] > dim) dim = P[k + 4];
          }
          if (dim) alpha *= 1 - dim * (1 - Math.min(1, this.sunk[i] * 2 + this.heat[i]));
        }
        if (m === BOUND && py < this.fadeB && phaseLive) {
          const f = (py - this.fadeA) / (this.fadeB - this.fadeA);
          alpha *= f <= 0 ? 0 : f * f * (3 - 2 * f);
        }
        const wl = L * 0.55;
        r += (1 - r) * wl; g += (1 - g) * wl; b += (1 - b) * wl;
        if (tint > 0) {
          const tl = tint * L;
          r += (TEAL[0] - r) * tl; g += (TEAL[1] - g) * tl; b += (TEAL[2] - b) * tl;
        }
      }
      const sk = this.sunk[i];
      if (sk > 0.01) {
        // matter in the well glows like an accretion disc, but each grain is dimmed: thousands
        // of them share a few pixels there, and additive light would wash out to plain white
        if (m === BOUND && alpha < sk * 0.5) alpha = sk * 0.5;
        r += (HOT[0] - r) * sk; g += (HOT[1] * 0.86 - g) * sk; b += (HOT[2] * 0.7 - b) * sk;
        alpha *= 1 - 0.74 * sk;
        size *= 1 - 0.2 * sk;
      }
      const h = this.heat[i];
      if (h > 0.01) {
        // hot matter always shows, even body text that is normally left to the DOM
        if (m === BOUND && alpha < h * 0.6) alpha = h * 0.6;
        r += (HOT[0] - r) * h; g += (HOT[1] - g) * h; b += (HOT[2] - b) * h;
        alpha *= 1 + h * 1.8;
        size *= 1 + h * 0.5;
      }
      const k = n * STRIDE;
      o[k] = px; o[k + 1] = py;
      o[k + 2] = this.vx[i]; o[k + 3] = this.vy[i];
      o[k + 4] = r; o[k + 5] = g; o[k + 6] = b; o[k + 7] = alpha;
      o[k + 8] = size;
      n++;
    }
    this.drawn = n;
    this.renderer.draw(o, n, this.maxStretch);
  }
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
