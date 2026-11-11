// The same universe as engine.js, simulated on the GPU.
//
// engine.js walks every particle in JavaScript each frame and packs it for drawing. Here
// the particles never leave the graphics card: a vertex shader advances them and WebGL2
// transform feedback captures the result into a second buffer (the two swap every frame).
// The same pass works out how each particle looks, so the shader that draws them only
// has to place a quad. Formation targets live in a float
// texture, one block of rows per section. Per frame, JavaScript sets a few dozen uniforms
// and issues two draw calls, however many particles there are.
//
// What stays on the CPU are the rare events that pick and choose particles (the big bang,
// handing out formation ranks, the rebirth): those read the state back once, edit it with
// the same code as engine.js, and upload it again. Clicks and the release of the gravity
// well are frequent, so they are described to the shader as one-frame events instead.

import { INTRO, AMBIENT, BOUND, FORM_FRAC, IMPLODE, pickColor, shuffle } from './engine.js';
import { fib } from './sampler.js';

const TAU = Math.PI * 2;
// per particle, rewritten every frame by the simulation shader:
const DYN = 17;   // x, y, vx, vy | heat, look, sunk (intro: depth), attach | 9 floats for drawing (screen x, y, vx, vy, r, g, b, a, size)
const STA = 16;   // rank, k, swirl, mode | seed, z, stag, sway | ux, uy, uz, tw | r, g, b, -
const X = 0, Y = 1, VX = 2, VY = 3, HEAT = 4, LOOK = 5, SUNK = 6, ATT = 7;
const RANK = 0, K = 1, SWIRL = 2, MODE = 3, SEED = 4, Z = 5, STAG = 6, SWAY = 7, UX = 8, UY = 9, UZ = 10, TW = 11, CR = 12;

const COMMON = `
precision highp float;
precision highp sampler2D;
uniform sampler2D uForm;
uniform ivec4 uLay;      // texture width, points per formation (M), first row of A, first row of B
uniform vec4 uT;         // dt, time, scroll, scroll delta
uniform vec4 uEnv;       // view w, view h, ambient drag, blend progress (-1 = holding one formation)
const float PI = 3.14159265;
const float STAG = 0.5;
vec4 point(int j, int row) { return texelFetch(uForm, ivec2(j % uLay.x, row + j / uLay.x), 0); }
/** How far along its own trip from A to B this particle is: each leaves on its own schedule. */
float tripOf(float stag) {
  if (uEnv.w <= 0.0) return 0.0;
  float q = clamp((uEnv.w - stag * STAG) / (1.0 - STAG), 0.0, 1.0);
  return q * q * (3.0 - 2.0 * q);
}
`;

const SIM_VS = `#version 300 es
${COMMON}
layout(location = 0) in vec4 aPV;
layout(location = 1) in vec4 aSt;
layout(location = 2) in vec4 aS1;
layout(location = 3) in vec4 aS2;
layout(location = 4) in vec4 aS3;
layout(location = 5) in vec4 aS4;
uniform vec4 uMouse;     // x, y, repel radius, on
uniform vec4 uWell;      // x, y, charge (0 = off), reach
uniform vec4 uIntro;     // cx, cy, radius, implosion 0..1
uniform vec4 uRot;       // cos/sin of the sphere's spin, cos/sin of its tilt
uniform vec4 uImpulse;   // x, y, radius (0 = none), power     one frame only
uniform vec4 uBlast;     // x, y, reach, charge (0 = none)      one frame only
uniform vec4 uLookA;     // heading size, body size, body visibility, has a formation
uniform vec4 uLookB;
uniform vec4 uMisc;      // size scale, implosion 0..1, fade from y, fade to y (formations only)
uniform vec4 uPane[16];  // dark panels (cards, code): x0, y0, x1, y1 in document space
uniform float uPaneA[16];// how much starlight each one swallows
uniform int uPaneN;
out vec4 oPV;            // state: position (bound particles: document space), velocity
out vec4 oSt;            // state: heat, look, sunk (intro: depth), attach time
out vec4 oD1;            // for drawing: screen position, velocity
out vec4 oD2;            // for drawing: colour, alpha
out float oSize;         // for drawing: size (0 = not on screen)
const float RAMP = 0.7;
const float MAX_SPEED = 4200.0;
const vec3 HOT = vec3(1.0, 0.72, 0.42);
const vec3 TEAL = vec3(0.22, 1.0, 0.9);
float rnd(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  float dt = uT.x, t = uT.y, scroll = uT.z;
  vec2 p = aPV.xy, v = aPV.zw;
  float heat = aSt.x, look = aSt.y, sunk = aSt.z, attach = aSt.w;
  float mode = aS1.w, seed = aS2.x, z = aS2.y;
  bool intro = mode > 1.5;
  bool bound = mode > 0.5 && !intro;
  float W = uEnv.x, H = uEnv.y;
  vec2 nv = vec2(0.0);
  // the formation texels this particle owns: x, y, brightness (negative = body text), tint
  vec4 A = vec4(0.0, 0.0, 0.9, 0.0), B = A;
  float q = 0.0;
  bool owns = false;

  if (intro) {
    // pinned to the rotating singularity sphere
    vec3 u = aS3.xyz;
    float Xr = u.x * uRot.x + u.z * uRot.y;
    float Zr = -u.x * uRot.y + u.z * uRot.x;
    float Yr = u.y * uRot.z - Zr * uRot.w;
    float wob = 1.0 + 0.012 * sin(t * 2.3 + seed * 40.0);
    p = uIntro.xy + vec2(Xr, Yr) * uIntro.z * wob;
    heat = uIntro.w * uIntro.w * 0.9;
    sunk = u.y * uRot.w + Zr * uRot.z;   // depth on the sphere, kept in the spare slot
  } else {
    float lookRate = min(1.0, dt * 2.2);
    vec2 a;
    if (bound) {
      int j = int(aS1.x + 0.5);
      if (j < uLay.y) {
        owns = true;
        A = point(j, uLay.z);
        vec2 tg = A.xy;
        q = tripOf(aS2.z);
        if (q > 0.0) {
          B = point(j, uLay.w);
          tg += (B.xy - tg) * q;
          tg.x += sin(q * PI) * aS2.w;
        }
        float age = t - attach;
        if (age > 0.0) {
          float ramp = age >= RAMP ? 1.0 : (age / RAMP) * (age / RAMP);
          float kk = aS1.y * ramp;
          float c = 1.7 * sqrt(kk) + 0.6;
          vec2 d = tg - p;
          a = d * kk - v * c;
          float sw = age < 1.6 ? aS1.z : 0.0;
          if (sw > 0.0) {
            float dd = abs(d.x) + abs(d.y);
            if (dd > 30.0) { float f = sw * kk * (dd / (dd + 140.0)); a += vec2(-d.y, d.x) * f; }
          }
        } else {
          a = -v * 1.8;
        }
      } else {
        a = -v * 1.8;
      }
      if (uMouse.w > 0.5) {
        vec2 dm = vec2(p.x - uMouse.x, p.y - scroll - uMouse.y);
        float d2 = dot(dm, dm), R = uMouse.z;
        if (d2 < R * R && d2 > 0.01) { float d = sqrt(d2); float f = 1.0 - d / R; a += dm / d * f * f * 5200.0; }
      }
      look += (1.0 - look) * lookRate;
    } else {
      // ambient: parallax with the page, then drift in a slow flow field
      p.y -= uT.w * (0.08 + 0.32 * z);
      float ang = (sin(p.x * 0.0021 + t * 0.11 + seed * 5.0) + cos(p.y * 0.0024 - t * 0.09 + seed * 3.0)) * PI;
      float spd = 4.0 + 10.0 * z;
      a = (vec2(cos(ang), sin(ang)) * spd - v) * uEnv.z;
      if (uMouse.w > 0.5) {
        vec2 dm = p - uMouse.xy;
        float d2 = dot(dm, dm), R = uMouse.z * 1.7;
        if (d2 < R * R && d2 > 0.01) {
          float d = sqrt(d2); float f = 1.0 - d / R; float push = f * f * 1400.0 * z;
          vec2 n = dm / d;
          a += n * push + vec2(-n.y, n.x) * push * 0.6;
        }
      }
      look -= look * lookRate * 0.6;
    }

    vec2 sp = bound ? vec2(p.x, p.y - scroll) : p;   // where it is on screen

    if (uWell.z > 0.06) {
      vec2 dw = uWell.xy - sp;
      float d2 = dot(dw, dw), WR = uWell.w;
      if (d2 < WR * WR) {
        // the spring lets go as the hole takes over; matter falls to a ring and is dragged round it
        float d = sqrt(d2) + 0.01;
        float w = 1.0 - d / WR; w = uWell.z * w * (2.0 - w);
        vec2 n = dw / d;
        float r0 = 22.0 + 26.0 * uWell.z;
        float e = clamp((d - r0) / 70.0, -1.0, 1.0);
        float keep = (1.0 - w) * (1.0 - w);
        a = a * keep + n * (5200.0 * w * e) + vec2(-n.y, n.x) * (900.0 * w) - v * (2.4 * w);
        sunk = w;
      }
    }
    if (uImpulse.z > 0.0) {
      vec2 di = sp - uImpulse.xy;
      float d2 = dot(di, di);
      if (d2 < uImpulse.z * uImpulse.z && d2 > 0.01) {
        float d = sqrt(d2); float f = 1.0 - d / uImpulse.z;
        v += di / d * f * uImpulse.w;
        heat = max(heat, 0.25 * f);
      }
    }
    if (uBlast.w > 0.0) {
      vec2 db = sp - uBlast.xy;
      float d = length(db);
      if (d < uBlast.z) {
        float f = 1.0 - d / uBlast.z;
        float r1 = rnd(seed * 311.7 + t), r2 = rnd(seed * 73.13 + t * 1.7), r3 = rnd(seed * 19.19 + t * 0.37);
        float ang = d > 0.5 ? atan(db.y, db.x) + (r1 - 0.5) * 0.5 : r1 * 6.2832;
        float s = (500.0 + 1900.0 * uBlast.w) * f * (0.5 + r2);
        v = v * 0.3 + vec2(cos(ang), sin(ang)) * s;
        heat = max(heat, 0.45 + 0.55 * f);
        if (bound) attach = t + 0.15 + r3 * 0.65 * uBlast.w;
      }
    }

    nv = v + a * dt;
    float s2 = dot(nv, nv);
    if (s2 > MAX_SPEED * MAX_SPEED) nv *= MAX_SPEED / sqrt(s2);
    p += nv * dt;

    if (!bound && (p.x < -30.0 || p.x > W + 30.0 || p.y < -30.0 || p.y > H + 30.0)) {
      float rA = rnd(seed * 91.7 + t * 3.1), rB = rnd(seed * 47.3 + t * 2.3);
      if (p.x < -240.0 || p.x > W + 240.0 || p.y < -240.0 || p.y > H + 240.0) {
        // far away (released from an off-screen formation, say): come back as a fresh star
        p = vec2(rA * W, rB * H); nv = vec2(0.0); look = 0.0; heat = 0.0;
      } else {
        // wrap, but scatter along the other axis so no shape survives the trip
        if (p.x < -30.0 || p.x > W + 30.0) { p.x = mod(p.x + 30.0, W + 60.0) - 30.0; p.y = rA * H; }
        else { p.y = mod(p.y + 30.0, H + 60.0) - 30.0; p.x = rA * W; }
        nv *= 0.25;
      }
    }
    heat *= exp(-dt * 1.15);
    sunk *= exp(-dt * 5.0);
  }
  oPV = vec4(p, nv);
  oSt = vec4(heat, look, sunk, attach);

  // ── how it looks, worked out here once per particle: the draw pass then has nothing to think about
  vec2 scr = bound ? vec2(p.x, p.y - scroll) : p;
  vec3 col = aS4.rgb;
  float size = 0.0, alpha = 0.0;
  float ss = uMisc.x;
  bool shown = scr.x > -40.0 && scr.x < W + 40.0 && scr.y > -40.0 && scr.y < H + 40.0;
  if (shown && intro) {
    float d = (sunk + 1.0) * 0.5;
    // slow ripples of light crawling over the sphere: the only "hint" on screen
    float rip = sin(aS3.y * 7.0 + aS3.x * 2.0 - t * 2.1);
    float glow = rip > 0.92 ? (rip - 0.92) * 9.0 : 0.0;
    size = (0.7 + 0.9 * d) * 1.25 * ss * (1.0 + uMisc.y);
    alpha = (0.05 + 0.62 * d * d) * (1.0 + glow) * (1.0 + uMisc.y * 2.0);
    col += (1.0 - col) * 0.7;
    col = mix(col, HOT, min(heat, 1.0));
    alpha *= 1.0 + heat * 1.8;
    size *= 1.0 + heat * 0.5;
  } else if (shown) {
    float L = look;
    float tw = 0.72 + 0.28 * sin(t * (0.6 + seed * 2.4) + aS3.w);
    float ambS = (0.5 + 1.25 * z) * ss;
    float ambA = (0.06 + 0.36 * z * z) * tw;
    float fs = 1.9 * ss, fa = 0.9, tint = 0.0;
    if (owns && uLookA.w > 0.5) {
      bool kA = A.z < 0.0, kB = B.z < 0.0;
      float aA = kA ? 0.85 * uLookA.z : A.z;
      float aB = kB ? 0.85 * uLookB.z : B.z;
      fs = mix(kA ? uLookA.y : uLookA.x, kB ? uLookB.y : uLookB.x, q) * ss;
      fa = mix(aA, aB, q);
      tint = mix(A.w, B.w, q);
      bool moving = q > 0.0 && q < 1.0;
      float f = sin(q * PI);
      if (moving) fa = max(fa, 0.85 * f);
      if (fa < 0.015 && L > 0.95 && heat < 0.02 && sunk < 0.02) shown = false;
      // in transit: thinner and dimmer, so the stream never smothers what it crosses
      if (moving) { fa *= 1.0 - 0.5 * f; fs *= 1.0 - 0.25 * f; }
    }
    if (shown) {
      size = mix(ambS, fs, L);
      alpha = mix(ambA, fa, L);
      if (!bound && uPaneN > 0) {
        // a card is a dark cloud: free stars behind it are dimmed, so none shines through the
        // text on it. Anything hot or caught by the hole is exempt and lights up as it leaves.
        vec2 dp = vec2(scr.x, scr.y + scroll);
        float dim = 0.0;
        for (int k = 0; k < uPaneN; k++) {
          vec4 r = uPane[k];
          float inside = smoothstep(r.x - 3.0, r.x + 3.0, dp.x) * (1.0 - smoothstep(r.z - 3.0, r.z + 3.0, dp.x))
                       * smoothstep(r.y - 3.0, r.y + 3.0, dp.y) * (1.0 - smoothstep(r.w - 3.0, r.w + 3.0, dp.y));
          dim = max(dim, inside * uPaneA[k]);
        }
        alpha *= 1.0 - dim * (1.0 - min(1.0, sunk * 2.0 + heat));
      }
      if (bound && scr.y < uMisc.w) {
        float f = clamp((scr.y - uMisc.z) / (uMisc.w - uMisc.z), 0.0, 1.0);
        alpha *= f * f * (3.0 - 2.0 * f);
      }
      col += (1.0 - col) * (L * 0.55);
      if (tint > 0.0) col = mix(col, TEAL, tint * L);
      if (sunk > 0.01) {
        // matter in the well glows like an accretion disc, but each grain is dimmed: thousands
        // of them share a few pixels there, and additive light would wash out to plain white
        if (bound && alpha < sunk * 0.5) alpha = sunk * 0.5;
        col = mix(col, HOT * vec3(1.0, 0.86, 0.7), sunk);
        alpha *= 1.0 - 0.74 * sunk;
        size *= 1.0 - 0.2 * sunk;
      }
      if (heat > 0.01) {
        if (bound && alpha < heat * 0.6) alpha = heat * 0.6;
        col = mix(col, HOT, min(heat, 1.0));
        alpha *= 1.0 + heat * 1.8;
        size *= 1.0 + heat * 0.5;
      }
    }
  }
  oD1 = vec4(scr, nv);
  oD2 = vec4(col, alpha);
  oSize = shown ? size : 0.0;
}`;

const SIM_FS = `#version 300 es
precision mediump float;
void main() {}`;

// The draw pass only places a quad: everything else was decided by the simulation.
const DRAW_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aD1;
layout(location = 2) in vec4 aD2;
layout(location = 3) in float aSize;
uniform vec2 uView;
uniform vec2 uStreak;    // stretch per px/s, longest streak
out vec2 vUv;
out float vLen;
out vec4 vColor;
void main() {
  if (aSize <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 vel = aD1.zw;
  float sp = length(vel);
  vec2 dir = sp > 0.001 ? vel / sp : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // the quad hugs the visible glow: 0.8x the old one, a third less area to fill
  float r = aSize * 1.6;
  float halfLen = r + min(sp * uStreak.x, uStreak.y);
  vec2 q = aD1.xy + dir * (aCorner.x * halfLen) + nrm * (aCorner.y * r);
  vec2 c = q / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  vUv = vec2(aCorner.x * halfLen / r, aCorner.y);
  vLen = halfLen / r - 1.0;
  // a streak spreads the same light over a longer shape
  vColor = vec4(aD2.rgb, aD2.a * mix(1.0, r / halfLen, 0.6));
}`;

const DRAW_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vLen;
in vec4 vColor;
out vec4 outColor;
void main() {
  float x = max(abs(vUv.x) - vLen, 0.0);
  float d2 = x * x + vUv.y * vUv.y;
  float e = d2 * 0.64;
  float a = (exp(-e * 11.0) + exp(-e * 3.5) * 0.28) * (1.0 - smoothstep(0.7, 1.0, d2)) * vColor.a;
  outColor = vec4(vColor.rgb * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader: ' + log);
  }
  return s;
}

function program(gl, vs, fs, feedback) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  if (feedback) gl.transformFeedbackVaryings(p, feedback, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

export class GpuCosmos {
  /** Throws if the GPU path cannot be set up; the caller then falls back to engine.js. */
  constructor(canvas, count, renderer) {
    if (!renderer || renderer.kind !== 'webgl2') throw new Error('needs WebGL2');
    this.canvas = canvas;
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.kind = 'webgl2';
    this.sim = 'gpu';
    this.N = count;
    this.active = count;
    this.dyn = new Float32Array(count * DYN);
    this.sta = new Float32Array(count * STA);
    this.mode = new Uint8Array(count);
    this.rank = new Int32Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
      const s = i * STA;
      this.sta[s + RANK] = -1;
      this.sta[s + SEED] = Math.random();
      this.sta[s + Z] = 0.12 + 0.88 * Math.pow(Math.random(), 1.7);
      this.sta[s + TW] = Math.random() * TAU;
      const c = pickColor();
      this.sta[s + CR] = c[0]; this.sta[s + CR + 1] = c[1]; this.sta[s + CR + 2] = c[2];
      this.sta[s + STAG] = Math.random();
      this.sta[s + SWAY] = (Math.random() - 0.5) * 140;
    }
    this._forms = [];
    this.segA = 0; this.segB = 0; this.segP = 0;
    this.time = 0;
    this.scrollY = 0;
    this.lastScrollY = 0;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.mouse = { x: -1e5, y: -1e5, on: false };
    this.well = { x: 0, y: 0, on: false, charge: 0 };
    this.repel = 90;
    this.ambDrag = 0.9;
    this.phase = 'intro';
    this.intro = { cx: 0, cy: 0, R: 100, spin: 0, implodeAt: -1, scale: 1 };
    this.sizeScale = 1;
    this.fadeA = -1e9; this.fadeB = -1e9;
    this.maxStretch = 26;
    this.frame = 0;
    this.drawn = count;
    this.assignedAt = -1e9;
    this.cur = 0;            // which of the two state buffers holds the present
    this.ahead = false;      // the GPU has state the CPU mirror has not seen
    this.impulseEv = null;
    this.blastEv = null;
    this.panes = null;       // Float32Array of x0, y0, x1, y1, strength per dark panel (set by the page)
    this.paneCount = 0;
    this.paneXY = new Float32Array(64);
    this.paneA = new Float32Array(16);
    this.texW = 0; this.texRows = 0; this.texM = 0;
    this.initGL();
    renderer.onReinit = () => this.reinit();
  }

  /* ───────────────────────────── GL plumbing ───────────────────────────── */

  initGL() {
    const gl = this.gl;
    this.simP = program(gl, SIM_VS, SIM_FS, ['oPV', 'oSt', 'oD1', 'oD2', 'oSize']);
    this.drawP = program(gl, DRAW_VS, DRAW_FS);
    const bytes = this.N * DYN * 4;
    this.dynBuf = [gl.createBuffer(), gl.createBuffer()];
    for (const b of this.dynBuf) { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_COPY); }
    this.staBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sta, gl.STATIC_DRAW);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // attribute i reads n floats at `off` of `buf`; div 1 = one per particle (instanced drawing)
    const attr = (i, buf, stride, off, div, n = 4) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, n, gl.FLOAT, false, stride * 4, off * 4);
      gl.vertexAttribDivisor(i, div);
    };
    this.simVao = []; this.drawVao = [];
    for (let k = 0; k < 2; k++) {
      const sv = gl.createVertexArray();
      gl.bindVertexArray(sv);
      attr(0, this.dynBuf[k], DYN, 0, 0); attr(1, this.dynBuf[k], DYN, 4, 0);
      attr(2, this.staBuf, STA, 0, 0); attr(3, this.staBuf, STA, 4, 0); attr(4, this.staBuf, STA, 8, 0); attr(5, this.staBuf, STA, 12, 0);
      this.simVao.push(sv);
      const dv = gl.createVertexArray();
      gl.bindVertexArray(dv);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      attr(1, this.dynBuf[k], DYN, 8, 1); attr(2, this.dynBuf[k], DYN, 12, 1); attr(3, this.dynBuf[k], DYN, 16, 1, 1);
      this.drawVao.push(dv);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.tex = gl.createTexture();
    this.texW = 0;
    this.maxTex = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const err = gl.getError();
    if (err) throw new Error('GL error ' + err);
  }

  /** After a lost context everything on the card is gone: rebuild it and let the particles re-form. */
  reinit() {
    this.initGL();
    for (let i = 0; i < this.active; i++) {
      const d = i * DYN;
      this.dyn[d + X] = Math.random() * this.w;
      this.dyn[d + Y] = Math.random() * this.h + (this.mode[i] === BOUND ? this.scrollY : 0);
      this.dyn[d + VX] = 0; this.dyn[d + VY] = 0; this.dyn[d + HEAT] = 0; this.dyn[d + SUNK] = 0;
      this.dyn[d + ATT] = this.time + Math.random() * 0.5;
    }
    this.ahead = false;
    this.pushDyn(); this.pushSta();
    this.uploadFormations();
  }

  /** Bring the CPU mirror up to date (one synchronous read; only the rare events pay for it). */
  pull() {
    if (!this.ahead || this.renderer.lost) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf[this.cur]);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.dyn, 0, this.active * DYN);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.ahead = false;
  }
  pushDyn() {
    if (this.renderer.lost) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf[this.cur]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dyn, 0, this.active * DYN);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.ahead = false;
  }
  pushSta() {
    if (this.renderer.lost) return;
    const gl = this.gl;
    for (let i = 0; i < this.N; i++) { this.sta[i * STA + MODE] = this.mode[i]; this.sta[i * STA + RANK] = this.rank[i]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sta);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /* ───────────────────────────── formations ───────────────────────────── */

  get formations() { return this._forms; }
  set formations(f) { this._forms = f || []; this.uploadFormations(); }

  /** One formation → its block of texels: x, y, brightness (negative for body text), tint. */
  packFormation(F, block) {
    const M = this.texM, pts = F.points, kind = F.kind, depth = F.depth, tint = F.tint;
    for (let j = 0; j < M; j++) {
      const o = j * 4;
      block[o] = pts[2 * j]; block[o + 1] = pts[2 * j + 1];
      block[o + 2] = kind && kind[j] ? -1 : depth ? 0.25 + 0.75 * depth[j] : 0.9;
      block[o + 3] = tint ? tint[j] : 0;
    }
  }

  uploadFormations() {
    const forms = this._forms;
    if (!forms.length || this.renderer.lost) return;
    const gl = this.gl;
    const M = forms[0].points.length >> 1;
    const W = Math.min(this.maxTex, Math.max(1, M)), rows = Math.ceil(M / W);
    this.texW = W; this.texRows = rows; this.texM = M;
    const all = new Float32Array(W * rows * forms.length * 4);
    this.blocks = forms.map((F, i) => {
      const block = all.subarray(i * W * rows * 4, (i + 1) * W * rows * 4);
      this.packFormation(F, block);
      return block;
    });
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, rows * forms.length, 0, gl.RGBA, gl.FLOAT, all);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** A formation that moves (the sphere, the granny loop) is re-sent while it is in play. */
  moveFormation(i, t, dt) {
    const F = this._forms[i];
    if (!F || !F.dynamic || !this.texW || this.renderer.lost) return;
    F.dynamic(F, t, dt);
    const gl = this.gl, block = this.blocks[i];
    this.packFormation(F, block);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, i * this.texRows, this.texW, this.texRows, gl.RGBA, gl.FLOAT, block);
  }

  /* ───────────────────────────── same interface as engine.js ───────────────────────────── */

  setViewport(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.renderer.resize(w, h, dpr);
    const I = this.intro;
    I.cx = w / 2; I.cy = h / 2;
    I.R = Math.max(70, Math.min(w, h) * (w < 640 ? 0.26 : 0.2));
    this.sizeScale = w < 640 ? 0.85 : 1;
    this.repel = w < 640 ? 70 : 95;
    // with the simulation off the CPU a phone can afford a longer streak than it used to (13)
    this.maxStretch = w < 640 ? 16 : 26;
  }

  setActive(n) {
    this.active = Math.max(500, Math.min(this.N, n | 0));
    for (let i = this.active; i < this.N; i++) { this.mode[i] = AMBIENT; this.rank[i] = -1; }
    this.drawn = this.active;
    this.pushSta();
  }

  get M() { return Math.round(this.active * FORM_FRAC); }

  /** No per-particle readback here: how settled the formation is, judged by the clock. */
  get formed() {
    const f = (this.time - this.assignedAt - 0.5) / 1.3;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  startIntro() {
    const M = Math.round(this.active * 0.86);
    const v = [0, 0, 0], d = this.dyn, s = this.sta;
    for (let i = 0; i < this.active; i++) {
      const o = i * DYN, q = i * STA;
      d[o + VX] = 0; d[o + VY] = 0; d[o + HEAT] = 0; d[o + LOOK] = 0; d[o + SUNK] = 0; d[o + ATT] = 0;
      this.rank[i] = -1;
      if (i < M) {
        fib(i, M, v);
        s[q + UX] = v[0]; s[q + UY] = v[1]; s[q + UZ] = v[2];
        this.mode[i] = INTRO;
        d[o + X] = -1e4; d[o + Y] = -1e4;   // placed by the first step
      } else {
        this.mode[i] = AMBIENT;
        d[o + X] = Math.random() * this.w;
        d[o + Y] = Math.random() * this.h;
        s[q + Z] = 0.12 + 0.3 * Math.random();   // only distant stars before the bang
      }
    }
    this.phase = 'intro';
    this.intro.implodeAt = -1;
    this.ahead = false;
    this.pushDyn(); this.pushSta();
  }

  startStill() {
    const d = this.dyn;
    for (let i = 0; i < this.active; i++) {
      const o = i * DYN;
      this.mode[i] = AMBIENT; this.rank[i] = -1;
      d[o + X] = Math.random() * this.w; d[o + Y] = Math.random() * this.h;
      d[o + VX] = 0; d[o + VY] = 0; d[o + HEAT] = 0; d[o + LOOK] = 0; d[o + SUNK] = 0;
    }
    this.phase = 'still';
    this.ahead = false;
    this.pushDyn(); this.pushSta();
    this.simulate(0);   // nothing moves in this mode: one pass to work out how the stars look
  }

  implode() {
    if (this.phase !== 'intro') return false;
    this.phase = 'implode';
    this.intro.implodeAt = this.time;
    return true;
  }

  kick(i, dx, dy, power) {
    const dd = Math.hypot(dx, dy) || 1;
    const f = power / (1 + dd / 260);
    this.dyn[i * DYN + VX] += (dx / dd) * f;
    this.dyn[i * DYN + VY] += (dy / dd) * f;
  }

  /** The big bang: every sphere particle gets a radial kick sized so the cloud settles across the screen. */
  bang() {
    this.pull();
    const I = this.intro, d = this.dyn;
    this.phase = 'bang';
    this.bangAt = this.time;
    const reach = Math.hypot(this.w, this.h) * 0.6;
    const lam = 2.3;
    for (let i = 0; i < this.active; i++) {
      const o = i * DYN;
      if (this.mode[i] === INTRO) {
        const dx = d[o + X] - I.cx, dy = d[o + Y] - I.cy;
        const dist = Math.hypot(dx, dy);
        let a = dist > 0.01 ? Math.atan2(dy, dx) : Math.random() * TAU;
        a += (Math.random() - 0.5) * 0.6;
        const rf = (0.05 + 0.95 * Math.sqrt(Math.random())) * reach;
        const sp = lam * rf * (0.85 + 0.3 * Math.random());
        d[o + VX] = Math.cos(a) * sp; d[o + VY] = Math.sin(a) * sp;
        this.mode[i] = AMBIENT;
        d[o + HEAT] = 0.75 + 0.25 * Math.random();
        d[o + LOOK] = 0.6;
        d[o + SUNK] = 0;
      } else if (this.mode[i] === AMBIENT) {
        this.kick(i, d[o + X] - I.cx, d[o + Y] - I.cy, 700);
      }
    }
    this.ambDrag = lam;
    this.pushDyn(); this.pushSta();
  }

  /** Restart from the contact-page singularity: blow the bound sphere apart in document space. */
  rebirth(cxDoc, cyDoc) {
    this.pull();
    const d = this.dyn, s = this.sta;
    const syc = cyDoc - this.scrollY;
    for (let i = 0; i < this.active; i++) {
      const o = i * DYN;
      if (this.mode[i] === BOUND) {
        const dx = d[o + X] - cxDoc, dy = d[o + Y] - cyDoc;
        const dist = Math.hypot(dx, dy);
        const a = dist > 0.01 ? Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.5 : Math.random() * TAU;
        const sp = 500 + 1500 * Math.random();
        d[o + VX] = Math.cos(a) * sp; d[o + VY] = Math.sin(a) * sp;
        d[o + HEAT] = 0.8 + 0.2 * Math.random();
        d[o + ATT] = this.time + 0.35 + Math.random() * 0.6;
        s[i * STA + SWIRL] = 0.3 * (0.6 + 0.8 * Math.random());
      } else if (this.mode[i] === AMBIENT) {
        this.kick(i, d[o + X] - this.w / 2, d[o + Y] - syc, 900);
      }
    }
    this.ambDrag = 2.0;
    this.pushDyn(); this.pushSta();
  }

  /** Click/tap shockwave in screen space: handed to the shader for one frame. */
  impulse(sx, sy, radius = 190, power = 900) { this.impulseEv = [sx, sy, radius, power]; }

  wellRadius() { return (150 + 330 * this.well.charge) * (this.w < 640 ? 0.72 : 1); }

  /** Let go of the hole. Returns the charge it had (0 for a mere click); the blast itself runs in the shader. */
  releaseWell() {
    const well = this.well;
    if (!well.on) return 0;
    const c = well.charge, R = this.wellRadius() * 1.25;
    well.on = false; well.charge = 0;
    if (c < 0.22) return 0;
    this.blastEv = [well.x, well.y, R, c];
    this.ambDrag = 1.6;
    return c;
  }

  toBound(i) { if (this.mode[i] !== BOUND) { this.dyn[i * DYN + Y] += this.scrollY; this.mode[i] = BOUND; } }
  toAmbient(i) {
    if (this.mode[i] === BOUND) this.dyn[i * DYN + Y] -= this.scrollY;
    this.mode[i] = AMBIENT;
    this.rank[i] = -1;
  }

  setSegment(a, b, p) {
    this.segA = a; this.segB = b; this.segP = p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /** Pick the M formation particles and rank them by x, exactly as engine.js does. */
  assign({ delay = 0, spread = 0.45, swirl = 0, stiffness = 1 } = {}) {
    this.pull();
    const M = this.M, d = this.dyn, s = this.sta;
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
    for (const i of pool) key[i] = d[i * DYN + X] + (Math.random() - 0.5) * 40;
    pool.sort((a, b) => key[a] - key[b]);
    const t = this.time;
    for (let j = 0; j < pool.length; j++) {
      const i = pool[j];
      this.rank[i] = j;
      d[i * DYN + ATT] = t + delay + Math.random() * spread;
      s[i * STA + K] = (100 + 60 * Math.random()) * stiffness;
      s[i * STA + SWIRL] = swirl * (0.6 + 0.8 * Math.random());
    }
    this.assignedAt = t + delay + spread * 0.5;
    this.pushDyn(); this.pushSta();
  }

  /* ───────────────────────────── per frame ───────────────────────────── */

  step(dt) {
    this.time += dt;
    this.frame++;
    if (this.phase === 'still') return;
    this.simulate(dt);
  }

  /** One pass of the simulation shader. dt = 0 moves nothing and just works out how things look. */
  simulate(dt) {
    const t = this.time, phase = this.phase;
    if (this.renderer.lost) return;
    const gl = this.gl, I = this.intro;

    let ip = 0;
    if (I.implodeAt >= 0) ip = Math.min(1, (t - I.implodeAt) / IMPLODE);
    if (phase === 'intro' || phase === 'implode') I.spin += dt * (0.22 + ip * ip * 9);
    const iscale = (1 + 0.025 * Math.sin(t * 1.7)) * (1 - 0.93 * ip * ip * ip);
    const rx = 0.36 + 0.06 * Math.sin(t * 0.31);

    const sy = this.scrollY, dScroll = sy - this.lastScrollY;
    this.lastScrollY = sy;
    this.ambDrag += (0.9 - this.ambDrag) * Math.min(1, dt * 0.7);

    const forms = this._forms, has = forms.length > 0 && this.texW > 0;
    if (has) {
      this.moveFormation(this.segA, t, dt);
      if (this.segB !== this.segA) this.moveFormation(this.segB, t, dt);
    }
    const well = this.well;
    if (well.on) well.charge = Math.min(1, well.charge + dt / 1.5);
    const wOn = well.on && well.charge > 0.06;

    const u = this.simP.u;
    gl.useProgram(this.simP.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.uForm, 0);
    gl.uniform4i(u.uLay, Math.max(1, this.texW), has ? this.texM : 0, this.segA * this.texRows, this.segB * this.texRows);
    gl.uniform4f(u.uT, dt, t, sy, dScroll);
    gl.uniform4f(u.uEnv, this.w, this.h, this.ambDrag, has && this.segA !== this.segB ? this.segP : -1);
    gl.uniform4f(u.uMouse, this.mouse.x, this.mouse.y, this.repel, this.mouse.on && !wOn ? 1 : 0);
    gl.uniform4f(u.uWell, well.x, well.y, wOn ? well.charge : 0, this.wellRadius());
    gl.uniform4f(u.uIntro, I.cx, I.cy, I.R * iscale, ip);
    gl.uniform4f(u.uRot, Math.cos(I.spin), Math.sin(I.spin), Math.cos(rx), Math.sin(rx));
    const im = this.impulseEv, bl = this.blastEv;
    gl.uniform4f(u.uImpulse, im ? im[0] : 0, im ? im[1] : 0, im ? im[2] : 0, im ? im[3] : 0);
    gl.uniform4f(u.uBlast, bl ? bl[0] : 0, bl ? bl[1] : 0, bl ? bl[2] : 1, bl ? bl[3] : 0);
    this.impulseEv = null; this.blastEv = null;
    const FA = forms[this.segA], FB = forms[this.segB] || FA, live = phase === 'live';
    gl.uniform4f(u.uLookA, FA ? FA.psize : 1.9, FA ? FA.bsize : 1, FA ? FA.bodyVis : 1, has && FA ? 1 : 0);
    gl.uniform4f(u.uLookB, FB ? FB.psize : 1.9, FB ? FB.bsize : 1, FB ? FB.bodyVis : 1, has && FB ? 1 : 0);
    gl.uniform4f(u.uMisc, this.sizeScale, ip, live ? this.fadeA : -1e9, live ? this.fadeB : -1e9 + 1);
    const pn = this.panes ? Math.min(16, this.paneCount) : 0;
    for (let k = 0; k < pn; k++) {
      this.paneXY.set(this.panes.subarray(k * 5, k * 5 + 4), k * 4);
      this.paneA[k] = this.panes[k * 5 + 4];
    }
    gl.uniform1i(u.uPaneN, pn);
    if (pn) { gl.uniform4fv(u['uPane[0]'], this.paneXY); gl.uniform1fv(u['uPaneA[0]'], this.paneA); }

    gl.bindVertexArray(this.simVao[this.cur]);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.dynBuf[1 - this.cur]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.active);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindVertexArray(null);
    this.cur = 1 - this.cur;
    this.ahead = true;
  }

  render() {
    if (!this.renderer.beginFrame(this.maxStretch)) return;
    const gl = this.gl, u = this.drawP.u;
    gl.useProgram(this.drawP.p);
    gl.uniform2f(u.uView, this.w, this.h);
    gl.uniform2f(u.uStreak, 0.0105, this.maxStretch);
    gl.bindVertexArray(this.drawVao[this.cur]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.active);
    gl.bindVertexArray(null);
  }
}
