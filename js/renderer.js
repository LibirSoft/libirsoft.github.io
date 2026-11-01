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
out vec2 vUv;
out float vLen;
out vec4 vColor;
void main() {
  vec2 vel = aPV.zw;
  float sp = length(vel);
  vec2 dir = sp > 0.001 ? vel / sp : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = aSize * 2.0;
  float stretch = min(sp * uStretch, 26.0);
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

  let prog, vao, instBuf, uView, uStretch, capacity = 0;
  let lost = false;
  let W = 1, H = 1;

  function init() {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    prog = p;
    uView = gl.getUniformLocation(p, 'uView');
    uStretch = gl.getUniformLocation(p, 'uStretch');

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const quad = gl.createBuffer();
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

  const api = {
    kind: 'webgl2',
    gl,
    canvas,
    onLost: null,
    onRestored: null,
    resize(w, h, dpr) {
      W = w; H = h;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    draw(data, count) {
      if (lost) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!count) return;
      gl.useProgram(prog);
      gl.uniform2f(uView, W, H);
      gl.uniform1f(uStretch, 0.0105);
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
    try { init(); lost = false; gl.viewport(0, 0, canvas.width, canvas.height); api.onRestored?.(); } catch (e) { console.warn(e); }
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
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
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
