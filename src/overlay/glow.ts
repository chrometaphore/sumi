/**
 * Processing glow: a soft, breathing aurora frame that wraps the viewport (strongest at the
 * corners, a continuous band along every edge) while Claude is working on the page's
 * feedback, plus a faint drifting grid of "+" marks across the whole viewport. The central
 * ~45% of the page never receives frame glow, so it stays readable.
 *
 * Sits above every other overlay layer (dock, note card, pins) and never takes pointer events.
 *
 * WebGL1 fragment shader on a low-resolution, CSS-upscaled, pointer-events:none canvas, drawn at
 * ~30 fps from the ink engine's shared frame scheduler. The WebGL context exists only while the glow
 * shows: it is created on the first activation and released (WEBGL_lose_context) after each fade-out.
 * Falls back to CSS gradients plus an SVG "+" tile with a CSS breathing animation when WebGL
 * is unavailable or fails. Never throws into the page.
 */

import { clock, schedule, unschedule, type Ticker } from "./ink/scheduler";
import { adoptCss, css as setCss, warn as logWarn } from "./util";

export interface Glow {
  /** Fade in (FADE_IN_MS) or out (FADE_OUT_MS, then display:none, no rendering, GL context released). Idempotent. */
  setActive(on: boolean): void;
  /** Remove all elements and listeners and release the GL context. Idempotent. */
  destroy(): void;
  readonly active: boolean;
  /** Renderer: "webgl" while a context is live, "css" (fallback), "none" (not shown yet, or destroyed). */
  readonly mode: "webgl" | "css" | "none";
}

const Z = "2147483647"; // topmost: above the dock, note card and pins (it is pointer-events:none)
const FADE_IN_MS = 220;
const FADE_OUT_MS = 380;
const BREATH_S = 2.4;
const RES_SCALE = 0.5;
const MAX_LONG_SIDE = 960;
/** Frames closer together than this are skipped: the aurora is slow (2.4 s breath, a few px/s of drift),
 * so every other ~30 fps scheduler frame (~15 fps) draws it, also while a full-rate animation runs. */
const MIN_FRAME_MS = 45;
// Keep shader time small for precision. 2400 s is a multiple of the breath (2.4 s), of the
// hue cycle (1 / 0.035 s) and makes the "+" drift (3 and -2 px/s on a 30 px grid) wrap exactly.
const TIME_WRAP_S = BREATH_S * 1000;
const RESIZE_DEBOUNCE_MS = 120;
const SWELL_IN_MS = 650;
const SWELL_IN_GAIN = 0.45;
const SWELL_OUT_GAIN = 0.25;
const CLS = "sumi-glow";

/** "+" grid, in CSS pixels. */
const PLUS_SPACING = 30;
const PLUS_ARM = 3.5;

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;     // canvas size in pixels
uniform float u_time;   // seconds
uniform float u_breath; // 0..1 breathing envelope
uniform float u_gain;   // overall intensity (1, or dimmer for reduced motion)
uniform float u_css;    // CSS pixels per canvas pixel
uniform float u_dpr;    // device pixels per CSS pixel

const float SPACING = ${PLUS_SPACING.toFixed(1)};
const float ARM = ${PLUS_ARM.toFixed(1)};

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 palette(float h) {
  vec3 violet = vec3(0.486, 0.361, 1.000); // #7c5cff
  vec3 blue   = vec3(0.231, 0.510, 0.965); // #3b82f6
  vec3 teal   = vec3(0.176, 0.831, 0.749); // #2dd4bf
  h = fract(h) * 3.0;
  if (h < 1.0) return mix(violet, blue, smoothstep(0.0, 1.0, h));
  if (h < 2.0) return mix(blue, teal, smoothstep(0.0, 1.0, h - 1.0));
  return mix(teal, violet, smoothstep(0.0, 1.0, h - 2.0));
}

// 1 at d = 0, smoothly to 0 at d = r (zero slope at r, so no visible rim). A long, soft
// tail so the visible pool really reaches most of r.
float falloff(float d, float r) {
  float x = 1.0 - clamp(d / r, 0.0, 1.0);
  return mix(x * sqrt(x), x * x * (3.0 - 2.0 * x), 0.5);
}

// Polynomial smooth max: a seamless soft union. The blend width scales with the larger
// input, so the bump is at most k/4 of max(a, b) and zero stays exactly zero (no floor).
float smax(float a, float b, float k) {
  float m = max(a, b);
  float w = k * m + 1e-4;
  float h = max(w - abs(a - b), 0.0) / w;
  return m + h * h * w * 0.25;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float s = min(u_res.x, u_res.y);
  vec2 q = px / s;          // aspect-correct units: 1.0 == shorter side
  vec2 ext = u_res / s;
  vec2 uv = px / u_res;     // 0..1 across the viewport
  float t = u_time;

  // Three noise layers drifting in different directions.
  float n1 = vnoise(q * 2.3 + vec2(t * 0.060, t * 0.025));
  float n2 = vnoise(q * 4.2 + vec2(-t * 0.045, t * 0.050) + 7.3);
  float n3 = vnoise(q * 7.9 + vec2(t * 0.030, -t * 0.070) + 19.1);
  float n = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;

  // Distance to the nearest vertical (c.x) and horizontal (c.y) edge. Using the nearest
  // corner/edge only (instead of summing four corners) gives one continuous field on any
  // aspect ratio, with no hot spots where contributions would overlap.
  vec2 c = min(q, ext - q);

  // Each corner gets its own phase so the frame pulses around the viewport instead of
  // in lockstep. 7.2 s is three breaths, so the time wrap stays seamless.
  float cp = (q.x < ext.x * 0.5 ? 0.0 : 1.6) + (q.y < ext.y * 0.5 ? 0.0 : 3.1);
  float slow = 0.5 + 0.5 * sin(6.2831853 * t / 7.2 + cp);

  // Corner pools: the visible pool reaches ~40% of the shorter side at the top of the
  // breath (the falloff tail is invisible, so the parameter sits a little higher).
  float reach = 0.40 * (0.66 + 0.24 * u_breath + 0.14 * slow) * (0.90 + 0.10 * n);
  float corner = falloff(length(c), reach);

  // Edge band: a soft, even frame (up to ~24% of the shorter side).
  float e = min(c.x, c.y);
  float bandW = 0.20 * (0.86 + 0.14 * n2) * (0.78 + 0.16 * u_breath + 0.10 * slow);
  float bx = 1.0 - clamp(e / bandW, 0.0, 1.0);
  float band = bx * sqrt(bx) * (0.46 + 0.20 * n1);

  float mask = clamp(smax(corner, band, 0.35), 0.0, 1.0);

  // Hard guarantee: nothing reaches the central ~45% of the viewport.
  vec2 cd = abs(uv - 0.5) * 2.0;
  mask *= smoothstep(0.45, 0.60, max(cd.x, cd.y));

  float env = 0.55 + 0.45 * u_breath; // clearly visible swell and relax
  float alpha = 0.72 * mask * env * (0.90 + 0.10 * n3) * u_gain;

  // Hue drifts over time, across the viewport and with the noise.
  // Hue also breathes: a visible shift on every cycle, plus a slower per-corner sweep.
  float hue = t * 0.035 + n * 0.65 + uv.x * 0.33 + uv.y * 0.12 + 0.24 * u_breath + 0.16 * slow;
  vec3 col = palette(hue);

  // "+" grid in CSS pixels, drifting a few px per second. Capsule SDF (rounded ends) with
  // box-filtered coverage so a ~1px line keeps a steady weight while it drifts across the
  // low-resolution canvas.
  vec2 cssPx = px * u_css + vec2(t * 3.0, -t * 2.0);
  vec2 l = mod(cssPx, SPACING) - 0.5 * SPACING;
  vec2 al = abs(l);
  float r = min(length(vec2(max(al.x - ARM, 0.0), l.y)), length(vec2(l.x, max(al.y - ARM, 0.0))));
  float th = max(1.0 / max(u_dpr, 1.0), 0.75); // ~1 device pixel, readable on hi-dpi
  float A = max(u_css, 0.001);
  float cov = clamp((min(r + 0.5 * A, 0.5 * th) - max(r - 0.5 * A, -0.5 * th)) / A, 0.0, 1.0);
  cov /= min(th, A) / A; // normalise the peak to 1 when the canvas pixel is wider than the line
  float vig = smoothstep(0.15, 1.05, length(uv * 2.0 - 1.0));
  float pa = clamp(cov, 0.0, 1.0) * mix(0.06, 0.22, max(vig, mask)) * (0.65 + 0.35 * u_breath) * u_gain;
  vec3 pcol = mix(palette(hue + 0.08), vec3(1.0), 0.18);

  // Subtle grain to avoid banding; never adds alpha where there is none.
  float g = hash(px + fract(t * 7.13) * vec2(91.7, 37.3)) - 0.5;
  alpha = clamp(alpha + g * (2.5 / 255.0) * step(0.003, alpha), 0.0, 1.0);
  col = clamp(col + g * (4.0 / 255.0), 0.0, 1.0);

  // "+" over glow, premultiplied.
  float outA = pa + alpha * (1.0 - pa);
  vec3 outC = pcol * pa + col * alpha * (1.0 - pa);
  gl_FragColor = vec4(outC, outA);
}
`;

const PLUS_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' width='${PLUS_SPACING}' height='${PLUS_SPACING}'>` +
  `<path d='M${PLUS_SPACING / 2 - PLUS_ARM} ${PLUS_SPACING / 2}h${PLUS_ARM * 2}M${PLUS_SPACING / 2} ${PLUS_SPACING / 2 - PLUS_ARM}v${PLUS_ARM * 2}' ` +
  `stroke='#8b74ff' stroke-width='1' stroke-linecap='round' fill='none'/></svg>`;
const PLUS_URI = `url("data:image/svg+xml,${encodeURIComponent(PLUS_SVG)}")`;
// Radial mask: ~0.06 alpha in the centre up to ~0.22 at the edges (layer opacity is .22).
const PLUS_MASK = "radial-gradient(ellipse at center, rgba(0,0,0,.27) 0%, rgba(0,0,0,.35) 30%, #000 85%)";

const FALLBACK_CSS = `
@keyframes ${CLS}-breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes ${CLS}-drift { 0% { opacity: 0; } 100% { opacity: 1; } }
@keyframes ${CLS}-plus-move { from { background-position: 0 0; } to { background-position: ${PLUS_SPACING}px -${PLUS_SPACING}px; } }
@keyframes ${CLS}-plus-hue { from { filter: hue-rotate(0deg); } to { filter: hue-rotate(-80deg); } }
.${CLS}-fb, .${CLS}-l { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
.${CLS}-fb { animation: ${CLS}-breathe ${BREATH_S}s ease-in-out infinite; }
.${CLS}-l1 {
  background:
    radial-gradient(circle at 0 0, rgba(124,92,255,.72) 0, rgba(124,92,255,.34) 10vmin, rgba(124,92,255,0) 34vmin),
    radial-gradient(circle at 100% 0, rgba(59,130,246,.70) 0, rgba(59,130,246,.32) 10vmin, rgba(59,130,246,0) 34vmin),
    radial-gradient(circle at 0 100%, rgba(45,212,191,.68) 0, rgba(45,212,191,.30) 10vmin, rgba(45,212,191,0) 34vmin),
    radial-gradient(circle at 100% 100%, rgba(124,92,255,.72) 0, rgba(124,92,255,.34) 10vmin, rgba(124,92,255,0) 34vmin),
    linear-gradient(to bottom, rgba(59,130,246,.34), rgba(59,130,246,.10) 6vmin, rgba(59,130,246,0) 16vmin),
    linear-gradient(to top, rgba(124,92,255,.34), rgba(124,92,255,.10) 6vmin, rgba(124,92,255,0) 16vmin),
    linear-gradient(to right, rgba(124,92,255,.32), rgba(124,92,255,.10) 6vmin, rgba(124,92,255,0) 16vmin),
    linear-gradient(to left, rgba(45,212,191,.32), rgba(45,212,191,.10) 6vmin, rgba(45,212,191,0) 16vmin);
}
.${CLS}-l2 {
  animation: ${CLS}-drift ${BREATH_S * 4}s ease-in-out infinite alternate;
  background:
    radial-gradient(circle at 0 0, rgba(59,130,246,.70) 0, rgba(59,130,246,.32) 10vmin, rgba(59,130,246,0) 34vmin),
    radial-gradient(circle at 100% 0, rgba(45,212,191,.68) 0, rgba(45,212,191,.30) 10vmin, rgba(45,212,191,0) 34vmin),
    radial-gradient(circle at 0 100%, rgba(124,92,255,.72) 0, rgba(124,92,255,.32) 10vmin, rgba(124,92,255,0) 34vmin),
    radial-gradient(circle at 100% 100%, rgba(45,212,191,.70) 0, rgba(45,212,191,.32) 10vmin, rgba(45,212,191,0) 34vmin);
}
.${CLS}-plus {
  opacity: .22;
  background-image: ${PLUS_URI};
  background-size: ${PLUS_SPACING}px ${PLUS_SPACING}px;
  -webkit-mask-image: ${PLUS_MASK};
  mask-image: ${PLUS_MASK};
  animation: ${CLS}-plus-move ${Math.round(PLUS_SPACING / 3)}s linear infinite, ${CLS}-plus-hue ${BREATH_S * 6}s ease-in-out infinite alternate;
}
@media (prefers-reduced-motion: reduce) {
  .${CLS}-fb, .${CLS}-l2, .${CLS}-plus { animation: none; }
  .${CLS}-fb { opacity: .6; }
  .${CLS}-l2 { opacity: 0; }
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed: " + log);
  }
  return sh;
}

interface GLState {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uBreath: WebGLUniformLocation | null;
  uGain: WebGLUniformLocation | null;
  uCss: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
}

function initGL(gl: WebGLRenderingContext): GLState {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(program));
  }
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("createBuffer failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One oversized triangle covers the whole viewport.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(program);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND); // we write premultiplied colour; the compositor blends over the page
  gl.clearColor(0, 0, 0, 0);
  return {
    program,
    buffer,
    uRes: gl.getUniformLocation(program, "u_res"),
    uTime: gl.getUniformLocation(program, "u_time"),
    uBreath: gl.getUniformLocation(program, "u_breath"),
    uGain: gl.getUniformLocation(program, "u_gain"),
    uCss: gl.getUniformLocation(program, "u_css"),
    uDpr: gl.getUniformLocation(program, "u_dpr"),
  };
}

const warn = (e: unknown): void => logWarn(e, "glow");
const css = (el: HTMLElement, decls: Record<string, string>): void => setCss(el, decls, true);

const GL_OPTS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
  failIfMajorPerformanceCaveat: true,
};

export function createGlow(root: ShadowRoot | HTMLElement): Glow {
  let destroyed = false;
  let active = false;
  let shown = false; // container displayed (active, or fading out)
  /** WebGL failed once (or is unavailable): the CSS fallback from then on. */
  let useCss = false;

  let container: HTMLDivElement | null = null;
  /** Removes the fallback stylesheet (adopted sheet, or a <style> outside a shadow root). */
  let unstyle: (() => void) | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | null = null;
  let st: GLState | null = null;
  let lost = false;
  let cssPerPx = 1; // CSS pixels per canvas pixel, refreshed on resize
  let fallbackEl: HTMLDivElement | null = null;

  let lastFrame = -Infinity;
  let scheduled = false;
  const t0 = clock();
  let activatedAt = -1;
  let deactivatedAt = -1;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  let reducedMql: MediaQueryList | null = null;
  let dprMql: MediaQueryList | null = null;
  let reduced = false;

  const mode = (): "webgl" | "css" | "none" => (destroyed ? "none" : useCss ? "css" : gl ? "webgl" : "none");

  // ---- media query helpers (addEventListener with Safari < 14 fallback) ----
  function mqOn(m: MediaQueryList, fn: () => void): void {
    if (typeof m.addEventListener === "function") m.addEventListener("change", fn);
    else (m as any).addListener?.(fn);
  }
  function mqOff(m: MediaQueryList, fn: () => void): void {
    if (typeof m.removeEventListener === "function") m.removeEventListener("change", fn);
    else (m as any).removeListener?.(fn);
  }

  // ---- rendering ----
  function viewportSize(): [number, number] {
    const de = document.documentElement;
    const w = (de && de.clientWidth) || window.innerWidth || 1;
    const h = (de && de.clientHeight) || window.innerHeight || 1;
    return [w, h];
  }

  function resize(): void {
    if (!canvas || !gl || lost) return;
    const [cw, ch] = viewportSize();
    const dpr = window.devicePixelRatio || 1;
    let w = cw * dpr * RES_SCALE;
    let h = ch * dpr * RES_SCALE;
    const long = Math.max(w, h);
    if (long > MAX_LONG_SIDE) {
      const k = MAX_LONG_SIDE / long;
      w *= k;
      h *= k;
    }
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    cssPerPx = cw / W;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      gl.viewport(0, 0, W, H);
      if (shown && reduced) drawStatic();
    }
  }

  function draw(time: number, breath: number, gain: number): void {
    if (!gl || !st || lost || !canvas) return;
    gl.uniform2f(st.uRes, canvas.width, canvas.height);
    gl.uniform1f(st.uTime, time);
    gl.uniform1f(st.uBreath, breath);
    gl.uniform1f(st.uGain, gain);
    gl.uniform1f(st.uCss, cssPerPx);
    gl.uniform1f(st.uDpr, window.devicePixelRatio || 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawAnimated(ts: number): void {
    const secs = ((ts - t0) / 1000) % TIME_WRAP_S;
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * secs) / BREATH_S);
    draw(secs, breath, swellGain(ts));
  }

  /** Brief over-bright swell on activation, and a small flare as it leaves. */
  function swellGain(ts: number): number {
    let g = 1;
    if (active && activatedAt >= 0) {
      const t = Math.min(1, (ts - activatedAt) / SWELL_IN_MS);
      const e = 1 - (1 - t) * (1 - t); // ease-out
      g += SWELL_IN_GAIN * (1 - e);
    } else if (!active && deactivatedAt >= 0) {
      const t = Math.min(1, (ts - deactivatedAt) / FADE_OUT_MS);
      g += SWELL_OUT_GAIN * (1 - t);
    }
    return g;
  }

  function drawStatic(): void {
    draw(12.0, 0.5, 0.6);
  }

  const ticker: Ticker = {
    lowRate: true,
    tick(ts: number): boolean {
      try {
        if (!wantsLoop()) {
          scheduled = false;
          return false;
        }
        if (ts - lastFrame >= MIN_FRAME_MS) {
          lastFrame = ts;
          drawAnimated(ts);
        }
        return true;
      } catch (e) {
        warn(e);
        scheduled = false;
        toFallback();
        return false;
      }
    },
    finish(): void {
      scheduled = false; // document hidden: onVisibility picks it back up
    },
  };

  function wantsLoop(): boolean {
    return !destroyed && shown && !!gl && !lost && !reduced && !document.hidden;
  }

  function stopLoop(): void {
    unschedule(ticker);
    scheduled = false;
  }

  /** Reconcile the render loop with the current state. */
  function update(): void {
    try {
      if (wantsLoop()) {
        if (!scheduled) {
          scheduled = true;
          lastFrame = -Infinity;
          schedule(ticker);
        }
      } else {
        stopLoop();
        if (!destroyed && shown && gl && !lost && reduced) drawStatic();
      }
    } catch (e) {
      warn(e);
      toFallback();
    }
  }

  // ---- WebGL, created on demand ----
  function startGL(): void {
    if (useCss || destroyed || !container || (gl && !lost)) return;
    teardownCanvas();
    try {
      canvas = document.createElement("canvas");
      css(canvas, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        display: "block",
        margin: "0",
        padding: "0",
        border: "0",
        "pointer-events": "none",
      });
      gl = (canvas.getContext("webgl", GL_OPTS) || canvas.getContext("experimental-webgl", GL_OPTS)) as WebGLRenderingContext | null;
      if (!gl) {
        toFallback(); // WebGL simply unavailable: not an error worth logging
        return;
      }
      lost = false;
      st = initGL(gl);
      canvas.addEventListener("webglcontextlost", onLost as EventListener, false);
      canvas.addEventListener("webglcontextrestored", onRestored, false);
      container.appendChild(canvas);
      resize();
    } catch (e) {
      warn(e);
      toFallback();
    }
  }

  // ---- fallback ----
  function toFallback(): void {
    if (destroyed || useCss || !container) return;
    useCss = true;
    try {
      stopLoop();
      teardownCanvas();
      if (!unstyle) {
        if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
          unstyle = adoptCss(root, FALLBACK_CSS); // survives a page CSP that blocks <style>
        } else {
          const styleEl = document.createElement("style");
          styleEl.textContent = FALLBACK_CSS;
          root.insertBefore(styleEl, root.firstChild);
          unstyle = () => styleEl.remove();
        }
      }
      const fb = document.createElement("div");
      fb.className = `${CLS}-fb`;
      const l1 = document.createElement("div");
      l1.className = `${CLS}-l ${CLS}-l1`;
      const l2 = document.createElement("div");
      l2.className = `${CLS}-l ${CLS}-l2`;
      const plus = document.createElement("div");
      plus.className = `${CLS}-l ${CLS}-plus`;
      fb.appendChild(l1);
      fb.appendChild(l2);
      fb.appendChild(plus);
      container.appendChild(fb);
      fallbackEl = fb;
    } catch (e) {
      warn(e);
    }
  }

  /** Release the GL context (WEBGL_lose_context) and drop the canvas. */
  function teardownCanvas(): void {
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      try {
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
      canvas.remove();
    }
    canvas = null;
    gl = null;
    st = null;
    lost = false;
  }

  // ---- event handlers ----
  function onLost(e: Event): void {
    try {
      e.preventDefault(); // allow restoration
    } catch {
      /* ignore */
    }
    lost = true;
    st = null;
    stopLoop();
  }

  function onRestored(): void {
    try {
      if (destroyed || !gl) return;
      lost = false;
      st = initGL(gl);
      if (canvas) gl.viewport(0, 0, canvas.width, canvas.height);
      resize();
      update();
    } catch (e) {
      warn(e);
      toFallback();
    }
  }

  function onVisibility(): void {
    update();
  }

  function onResize(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      try {
        resize();
      } catch (e) {
        warn(e);
      }
    }, RESIZE_DEBOUNCE_MS);
  }

  function onReduced(): void {
    reduced = !!reducedMql?.matches;
    update();
  }

  function watchDpr(): void {
    try {
      if (dprMql) mqOff(dprMql, onDpr);
      dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mqOn(dprMql, onDpr);
    } catch {
      dprMql = null;
    }
  }

  function onDpr(): void {
    watchDpr();
    onResize();
  }

  // ---- setup: only the (hidden) container; no canvas and no GL context until the glow first shows ----
  try {
    container = document.createElement("div");
    container.className = CLS;
    container.setAttribute("aria-hidden", "true");
    css(container, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      width: "auto",
      height: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      "pointer-events": "none",
      "z-index": Z,
      display: "none",
      opacity: "0",
      overflow: "hidden",
      background: "transparent",
      transform: "none",
      filter: "none",
      contain: "strict",
    });
    root.appendChild(container);

    try {
      reducedMql = window.matchMedia("(prefers-reduced-motion: reduce)");
      reduced = reducedMql.matches;
      mqOn(reducedMql, onReduced);
    } catch {
      reducedMql = null;
    }

    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    watchDpr();
  } catch (e) {
    warn(e);
    toFallback();
  }

  // ---- public API ----
  function setActive(on: boolean): void {
    try {
      on = !!on;
      if (destroyed || !container || on === active) return;
      active = on;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (on) {
        activatedAt = clock();
        deactivatedAt = -1;
        startGL();
        if (!shown) {
          shown = true;
          css(container, { display: "block", opacity: "0", transition: "none" });
          resize();
          void container.offsetWidth; // commit opacity:0 before transitioning
        }
        css(container, { transition: `opacity ${FADE_IN_MS}ms ease-out`, opacity: "1" });
        update();
      } else {
        deactivatedAt = clock();
        activatedAt = -1;
        css(container, { transition: `opacity ${FADE_OUT_MS}ms ease-in-out`, opacity: "0" });
        hideTimer = setTimeout(() => {
          hideTimer = null;
          try {
            if (destroyed || active || !container) return;
            shown = false;
            css(container, { display: "none", transition: "none" });
            update();
            teardownCanvas(); // the context lives only while the glow shows
          } catch (e) {
            warn(e);
          }
        }, FADE_OUT_MS + 20);
      }
    } catch (e) {
      warn(e);
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    active = false;
    shown = false;
    try {
      stopLoop();
      if (hideTimer) clearTimeout(hideTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      hideTimer = resizeTimer = null;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (reducedMql) mqOff(reducedMql, onReduced);
      if (dprMql) mqOff(dprMql, onDpr);
      reducedMql = dprMql = null;
      teardownCanvas();
      fallbackEl?.remove();
      fallbackEl = null;
      container?.remove();
      container = null;
      unstyle?.();
      unstyle = null;
    } catch (e) {
      warn(e);
    }
  }

  return {
    setActive,
    destroy,
    get active() {
      return active;
    },
    get mode() {
      return mode();
    },
  };
}
