// Draws particles. WebGL2 instanced quads (stretched along velocity, additive glow),
// with a plain Canvas2D fallback for machines without WebGL2.
//
// Instance layout, 9 floats: x, y, vx, vy, r, g, b, a, size   (CSS pixels, px/s)

export const STRIDE = 9;

const VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPV;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aSize;
uniform vec2 uView;
uniform float uStretch;
uniform float uMaxStretch;
out vec2 vUv;
out float vLen;
out vec4 vColor;
void main() {
  vec2 vel = aPV.zw;
  float sp = length(vel);
  vec2 dir = sp > 0.001 ? vel / sp : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = aSize * 2.0;
  float stretch = min(sp * uStretch, uMaxStretch);
  float halfLen = r + stretch;
  vec2 p = aPV.xy + dir * (aCorner.x * halfLen) + nrm * (aCorner.y * r);
  vec2 c = p / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  vUv = vec2(aCorner.x * halfLen / r, aCorner.y);
  vLen = halfLen / r - 1.0;
  // a streak spreads the same light over a longer shape
  vColor = vec4(aColor.rgb, aColor.a * mix(1.0, r / halfLen, 0.6));
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vLen;
in vec4 vColor;
out vec4 outColor;
void main() {
  float x = max(abs(vUv.x) - vLen, 0.0);
  float d2 = x * x + vUv.y * vUv.y;
  if (d2 > 1.0) discard;
  float core = exp(-d2 * 11.0);
  float glow = exp(-d2 * 3.5) * 0.28;
  float a = (core + glow) * vColor.a;
  outColor = vec4(vColor.rgb * a, a);
}`;

// ───────────────────────────── ink ─────────────────────────────
// Everything you can read on the page (body text, borders, underlines, the nav) is "ink":
// dense clouds of dots that sit still, so they are uploaded once per section and never
// touched by JavaScript again. The mouse, the click ripple, the gravity well and the
// blast after it are all worked out here in the vertex shader from a handful of uniforms.
//
// There is one dot per screen pixel of every glyph, carrying that pixel's coverage as its
// alpha, and each is drawn as a small gaussian whose neighbours add up to a flat field:
// at rest the cloud is, to the eye, the antialiased text itself.
//
// A dot is 16 bytes: x, y (float32, document px), r, g, b, a (bytes), radius, random (bytes)
export const INK_BYTES = 16;

const INK_HEAD = `
uniform vec2 uView;
uniform float uScroll;
uniform float uVis;
uniform float uTime;
uniform float uDpr;
uniform vec2 uFade;     // content fades out under the top bar between these two screen ys
uniform vec3 uMouse;    // x, y, radius (0 = off)
uniform vec4 uWell;     // x, y, charge, seconds held
uniform vec2 uWellR;    // reach, ring radius
uniform vec2 uBlast;    // seconds since release (-1 = none), charge at release
uniform vec3 uPulse;    // x, y, seconds since the click (-1 = none)
uniform float uStretch;
uniform float uMaxStretch;
out vec2 vUv;
out float vLen;
out vec4 vColor;
const vec3 HOT = vec3(1.0, 0.62, 0.3);
`;

const INK_BODY = `
void main() {
  float r1 = aMeta.y;
  float r2 = fract(r1 * 91.731 + 0.137 + aPos.x * 0.618);
  vec2 p = aPos - vec2(0.0, uScroll);
  float alpha = aColor.a * uVis * smoothstep(uFade.x, uFade.y, p.y);
  if (alpha < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 col = aColor.rgb;
  vec2 vel = vec2(0.0);
  float size = aMeta.x * 6.375;   // a byte, 1/40 px steps

  // a section condenses out of scattered dust as its particles land, and dissolves the same way
  if (uVis < 0.999) {
    float k = 1.0 - uVis; k *= k;
    float a0 = (r1 + r2) * 6.2832;
    p += vec2(cos(a0), sin(a0)) * k * (20.0 + 120.0 * r2);
  }

  if (uMouse.z > 0.0) {
    vec2 dm = p - uMouse.xy;
    float d = length(dm);
    if (d < uMouse.z && d > 0.01) { float f = 1.0 - d / uMouse.z; p += dm / d * f * f * 38.0; }
  }
  if (uPulse.z >= 0.0) {
    vec2 dp = p - uPulse.xy;
    float d = length(dp) + 0.01;
    float ring = 50.0 + 560.0 * uPulse.z;
    float g = (d - ring) / 46.0;
    p += dp / d * 16.0 * exp(-3.2 * uPulse.z) * exp(-g * g);
  }
  if (uWell.z > 0.002) {
    vec2 dv = p - uWell.xy;
    float d = length(dv) + 0.001;
    float WR = uWellR.x;
    if (d < WR * 1.25) {
      float e = clamp(1.0 - d / WR, 0.0, 1.0);
      float w = uWell.z * e * (2.0 - e);
      // held: fall to a ring round the hole and get dragged along it, faster the deeper you are
      float ringR = uWellR.y * (0.75 + 1.3 * r2);
      float rr = mix(d, ringR, w * sqrt(w));
      float om = (2.6 + 4.2 * r1) * w * w;
      float ang = atan(dv.y, dv.x) - om * uWell.w;
      vec2 radial = vec2(cos(ang), sin(ang));
      vec2 held = uWell.xy + radial * rr;
      float heat = w;
      float dim = 1.0 - 0.72 * w;
      if (uBlast.x >= 0.0) {
        // let go: thrown outwards, slowing down, then drifting home at its own pace
        float tb = uBlast.x;
        float f = clamp(1.0 - d / (WR * 1.25), 0.0, 1.0);
        float v0 = (500.0 + 1900.0 * uBlast.y) * f * (0.5 + r2);
        float a2 = ang + (r1 - 0.5) * 0.5;
        vec2 out2 = vec2(cos(a2), sin(a2));
        float decay = exp(-2.4 * tb);
        vec2 flown = held + out2 * v0 * (1.0 - decay) / 2.4;
        float t0 = 0.2 + 0.7 * r1 * uBlast.y;
        float m = smoothstep(t0, t0 + 1.1, tb);
        vel = out2 * v0 * decay * (1.0 - m);
        p = mix(flown, p, m);
        heat = (0.45 + 0.55 * f) * exp(-1.15 * tb) * step(0.0001, f);
        dim = 1.0 + 1.1 * heat;
      } else {
        vel = vec2(radial.y, -radial.x) * om * rr;
        p = held;
        size *= 1.0 - 0.15 * w;
      }
      col = mix(col, HOT, clamp(heat, 0.0, 1.0));
      alpha *= dim;
    }
  }

`;

// A dot is one vertex (a point sprite) nearly all the time. Only in the first moments
// after the hole lets go does it become a quad, so it can stretch into a streak.
const INK_VS_POINT = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec2 aMeta;
${INK_HEAD}${INK_BODY}
  vec2 c = p / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = max(1.0, size * 2.0 * uDpr);
  vUv = vec2(0.0);
  vLen = 0.0;
  vColor = vec4(col, alpha);
}`;

const INK_VS_QUAD = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aPos;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aMeta;
${INK_HEAD}${INK_BODY}
  float sp = length(vel);
  vec2 dir = sp > 0.001 ? vel / sp : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfLen = size + min(sp * uStretch, uMaxStretch);
  vec2 q = p + dir * (aCorner.x * halfLen) + nrm * (aCorner.y * size);
  vec2 c = q / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  vUv = vec2(aCorner.x * halfLen / size, aCorner.y);
  vLen = halfLen / size - 1.0;
  vColor = vec4(col, alpha * mix(1.0, size / halfLen, 0.6));
}`;

// a gaussian of sigma 0.45 dot pitches: neighbouring dots sum to an even tone, so a filled
// stroke reads as solid while each dot is still its own thing the moment it moves
const INK_FS_QUAD = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vLen;
in vec4 vColor;
out vec4 outColor;
void main() {
  float x = max(abs(vUv.x) - vLen, 0.0);
  float d2 = x * x + vUv.y * vUv.y;
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 3.556) * vColor.a;
  outColor = vec4(vColor.rgb * a, a);
}`;

const INK_FS_POINT = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vLen;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(uv, uv);
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 3.556) * vColor.a;
  outColor = vec4(vColor.rgb * a, a);
}`;

/** Assigning canvas.width/height reallocates the backing store even for the same value, so only touch what changed. */
function setSize(canvas, w, h, dpr) {
  const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
}

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

function createGL(canvas) {
  let gl;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
  } catch { gl = null; }
  if (!gl) return null;

  let prog, vao, instBuf, uView, uStretch, uMaxStretch, capacity = 0;
  let lost = false;
  let W = 1, H = 1;
  let quad, inkReady = false, DPR = 1;
  const INK_UNIFORMS = ['uView', 'uScroll', 'uVis', 'uTime', 'uDpr', 'uFade', 'uMouse', 'uWell', 'uWellR', 'uBlast', 'uPulse', 'uStretch', 'uMaxStretch'];
  const inkPoint = { prog: null, u: {} }, inkQuad = { prog: null, u: {} };
  const inkStore = new Map();   // key -> { count, bands, buf, vaoPoint, vaoQuad }

  function uploadInk(e, data) {
    e.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, e.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);   // the card keeps the only copy
    // the attribute pointers are aimed at one band at a time when drawing
    e.vaoPoint = gl.createVertexArray();
    gl.bindVertexArray(e.vaoPoint);
    for (let i = 0; i < 3; i++) gl.enableVertexAttribArray(i);
    e.vaoQuad = gl.createVertexArray();
    gl.bindVertexArray(e.vaoQuad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let i = 1; i < 4; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribDivisor(i, 1); }
    gl.bindVertexArray(null);
  }

  function inkProgram(target, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('ink link: ' + gl.getProgramInfoLog(p));
    target.prog = p;
    for (const n of INK_UNIFORMS) target.u[n] = gl.getUniformLocation(p, n);
  }

  function initInk() {
    inkReady = false;
    inkProgram(inkPoint, INK_VS_POINT, INK_FS_POINT);
    inkProgram(inkQuad, INK_VS_QUAD, INK_FS_QUAD);
    inkReady = true;
    inkStore.clear();   // after a lost context the clouds are gone: the page inks its sections again
  }

  function drawInk(f, maxStretch) {
    if (!inkReady || !f || !f.layers.length) return;
    // Quads (four vertices and a streak per dot) only for the first moments of a blast, when
    // things really fly. Held in the hole, or drifting home, a dot is still a single point.
    const busy = f.well[2] > 0.002;
    const quads = f.streaks && f.blast[0] >= 0 && f.blast[0] < 1.1;
    const P = quads ? inkQuad : inkPoint, u = P.u;
    const base = quads ? 1 : 0, bytes = INK_BYTES;
    const margin = busy ? f.wellR[0] * 1.25 + 40 : 170;
    gl.useProgram(P.prog);
    gl.uniform2f(u.uView, W, H);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uDpr, DPR);
    gl.uniform3f(u.uMouse, f.mouse[0], f.mouse[1], f.mouse[2]);
    gl.uniform4f(u.uWell, f.well[0], f.well[1], f.well[2], f.well[3]);
    gl.uniform2f(u.uWellR, f.wellR[0], f.wellR[1]);
    gl.uniform2f(u.uBlast, f.blast[0], f.blast[1]);
    gl.uniform3f(u.uPulse, f.pulse[0], f.pulse[1], f.pulse[2]);
    gl.uniform1f(u.uStretch, 0.0105);
    gl.uniform1f(u.uMaxStretch, maxStretch * 0.6);   // ink is many: shorter streaks keep the fill down
    let drawn = 0;
    for (const L of f.layers) {
      const e = inkStore.get(L.key);
      if (!e || !e.buf || L.vis < 0.004) continue;
      gl.uniform1f(u.uScroll, L.scroll);
      gl.uniform1f(u.uVis, L.vis);
      gl.uniform2f(u.uFade, L.fade0, L.fade1);
      gl.bindVertexArray(quads ? e.vaoQuad : e.vaoPoint);
      gl.bindBuffer(gl.ARRAY_BUFFER, e.buf);
      for (const b of e.bands) {
        // a band that is nowhere near the screen is never even sent to the vertex shader
        if (b.y1 - L.scroll < -margin || b.y0 - L.scroll > H + margin) continue;
        const off = b.start * bytes;
        gl.vertexAttribPointer(base, 2, gl.FLOAT, false, bytes, off);
        gl.vertexAttribPointer(base + 1, 4, gl.UNSIGNED_BYTE, true, bytes, off + 8);
        gl.vertexAttribPointer(base + 2, 2, gl.UNSIGNED_BYTE, true, bytes, off + 12);
        if (quads) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
        else gl.drawArrays(gl.POINTS, 0, b.count);
        drawn += b.count;
      }
    }
    api.ink.drawn = drawn;
    gl.bindVertexArray(null);
  }

  function init() {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    prog = p;
    uView = gl.getUniformLocation(p, 'uView');
    uStretch = gl.getUniformLocation(p, 'uStretch');
    uMaxStretch = gl.getUniformLocation(p, 'uMaxStretch');

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    instBuf = gl.createBuffer();
    capacity = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const bytes = STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, bytes, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, bytes, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, bytes, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  try { init(); } catch (e) { console.warn('[libir] WebGL2 init failed, falling back', e); return { failedAfterContext: true }; }
  try { initInk(); } catch (e) { console.warn('[libir] ink shader failed, keeping DOM text', e); inkReady = false; }

  const api = {
    kind: 'webgl2',
    gl,
    canvas,
    onLost: null,
    onRestored: null,
    resize(w, h, dpr) {
      W = w; H = h; DPR = dpr;
      setSize(canvas, w, h, dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    /** maxStretch: longest motion streak in CSS px (long streaks are most of the fill cost). */
    /**
     * Static dot clouds. set() uploads one (bytes, see INK_BYTES) or drops it. `bands` slices it
     * top to bottom ({ y0, y1, start, count } in dots) so only the slices on screen are drawn;
     * `frame` says which clouds to draw this frame and what is acting on them.
     */
    ink: {
      get ok() { return inkReady; },
      frame: null,
      drawn: 0,
      set(key, data, bands) {
        const old = inkStore.get(key);
        if (old && old.buf && !lost) { gl.deleteBuffer(old.buf); gl.deleteVertexArray(old.vaoPoint); gl.deleteVertexArray(old.vaoQuad); }
        inkStore.delete(key);
        if (!data || !data.byteLength || lost || !inkReady) return;
        const count = data.byteLength / INK_BYTES;
        const e = { count, bands: bands || [{ y0: -1e9, y1: 1e9, start: 0, count }], buf: null, vaoPoint: null, vaoQuad: null };
        inkStore.set(key, e);
        uploadInk(e, data);
      },
      count(key) { const e = inkStore.get(key); return e ? e.count : 0; },
    },
    get lost() { return lost; },
    onReinit: null,
    /** Clear and lay down the ink. A caller that draws its own particles (gpu.js) starts here. */
    beginFrame(maxStretch = 26) {
      if (lost) return false;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawInk(api.ink.frame, maxStretch);
      return true;
    },
    draw(data, count, maxStretch = 26) {
      if (!api.beginFrame(maxStretch)) return;
      if (!count) return;
      gl.useProgram(prog);
      gl.uniform2f(uView, W, H);
      gl.uniform1f(uStretch, 0.0105);
      gl.uniform1f(uMaxStretch, maxStretch);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      if (data.byteLength > capacity) {
        capacity = data.byteLength;
        gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * STRIDE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(null);
    },
  };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; api.onLost?.(); });
  canvas.addEventListener('webglcontextrestored', () => {
    try { init(); try { initInk(); } catch { inkReady = false; } lost = false; gl.viewport(0, 0, canvas.width, canvas.height); api.onReinit?.(); api.onRestored?.(); } catch (e) { console.warn(e); }
  });
  return api;
}

function create2D(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let W = 1, H = 1;
  return {
    kind: '2d',
    canvas,
    resize(w, h, dpr) {
      W = w; H = h;
      setSize(canvas, w, h, dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    draw(data, count) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#fff';
      for (let i = 0; i < count; i++) {
        const o = i * STRIDE;
        const a = data[o + 7];
        if (a < 0.02) continue;
        const s = data[o + 8] * 1.3;
        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.fillRect(data[o] - s * 0.5, data[o + 1] - s * 0.5, s, s);
      }
      ctx.globalAlpha = 1;
    },
  };
}

export function createRenderer(canvas) {
  const gl = createGL(canvas);
  if (gl && !gl.failedAfterContext) return gl;
  if (gl && gl.failedAfterContext) {
    // a canvas that already handed out a webgl2 context can't give a 2d one: swap in a fresh copy
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    return create2D(fresh);
  }
  return create2D(canvas);
}
