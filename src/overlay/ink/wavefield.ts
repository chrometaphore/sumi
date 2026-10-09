/**
 * Wave surface: a damped 1D wave field running along a closed ink outline (`WaveField`), the outline
 * geometry it runs on, and the pointer hub that feeds every live surface from one window listener.
 */
import { warn } from "../util";
import { approach, clamp, fmt, fmt3, lerp, smooth, STEP } from "./math";
import { INK_WAVES } from "./tuning";

/* ------------------------------------------------------------------------------------------------
 * Wave surface: a damped 1D wave field running along a closed ink outline
 * --------------------------------------------------------------------------------------------- */

/** A straight piece of an ink outline (local CSS px). `fixed` pieces never move (e.g. off-screen ink). */
export interface InkLine {
  kind: "line";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fixed?: boolean;
}
/** A circular arc from angle a0 to a1 (radians, y down: a1 > a0 runs clockwise on screen). */
export interface InkArc {
  kind: "arc";
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  fixed?: boolean;
}
export type InkSeg = InkLine | InkArc;
/** A closed outline: each segment starts where the previous one ends; the last closes to the first. */
export interface InkOutline {
  segs: InkSeg[];
}

const segLen = (s: InkSeg): number =>
  s.kind === "line" ? Math.hypot(s.x1 - s.x0, s.y1 - s.y0) : Math.abs(s.a1 - s.a0) * s.r;

/** Point and unit tangent at arc length `u` along a segment: out = [x, y, tx, ty]. */
function segAt(s: InkSeg, u: number, out: number[]): void {
  if (s.kind === "line") {
    const L = segLen(s) || 1;
    const k = u / L;
    out[0] = s.x0 + (s.x1 - s.x0) * k;
    out[1] = s.y0 + (s.y1 - s.y0) * k;
    out[2] = (s.x1 - s.x0) / L;
    out[3] = (s.y1 - s.y0) / L;
    return;
  }
  const dir = s.a1 >= s.a0 ? 1 : -1;
  const a = s.a0 + (dir * u) / s.r;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  out[0] = s.cx + s.r * c;
  out[1] = s.cy + s.r * sn;
  out[2] = -sn * dir;
  out[3] = c * dir;
}

/**
 * The exact (rest) SVG path of an outline: straight lines, and arcs as cubic Béziers of at most 90°
 * (radial error < 0.03% of r). Not SVG `A` commands: Chromium rasterizes those ~0.2 px fat, while
 * cubics match the Figma assets (which are cubics too) to the pixel.
 */
export function inkOutlinePath(o: InkOutline): string {
  const segs = o.segs.filter((s) => segLen(s) > 1e-3);
  if (!segs.length) return "";
  const p = [0, 0, 0, 0];
  segAt(segs[0], 0, p);
  let d = `M${fmt3(p[0])} ${fmt3(p[1])}`;
  for (const s of segs) {
    if (s.kind === "line") {
      d += `L${fmt3(s.x1)} ${fmt3(s.y1)}`;
      continue;
    }
    const parts = Math.max(1, Math.ceil(Math.abs(s.a1 - s.a0) / (Math.PI / 2) - 1e-9));
    const da = (s.a1 - s.a0) / parts;
    const k = (4 / 3) * Math.tan(da / 4) * s.r;
    for (let i = 0; i < parts; i++) {
      const a = s.a0 + da * i;
      const b = a + da;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const x0 = s.cx + s.r * ca;
      const y0 = s.cy + s.r * sa;
      const x3 = s.cx + s.r * cb;
      const y3 = s.cy + s.r * sb;
      d += `C${fmt3(x0 - k * sa)} ${fmt3(y0 + k * ca)} ${fmt3(x3 + k * sb)} ${fmt3(y3 - k * cb)} ${fmt3(x3)} ${fmt3(y3)}`;
    }
  }
  return `${d}Z`;
}

/** A w × h rounded rectangle (radius r) in local px, clockwise from the end of its top-left corner. */
export function inkRoundRect(w: number, h: number, r: number): InkOutline {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const P = Math.PI;
  return {
    segs: [
      { kind: "line", x0: r, y0: 0, x1: w - r, y1: 0 },
      { kind: "arc", cx: w - r, cy: r, r, a0: -P / 2, a1: 0 },
      { kind: "line", x0: w, y0: r, x1: w, y1: h - r },
      { kind: "arc", cx: w - r, cy: h - r, r, a0: 0, a1: P / 2 },
      { kind: "line", x0: w - r, y0: h, x1: r, y1: h },
      { kind: "arc", cx: r, cy: h - r, r, a0: P / 2, a1: P },
      { kind: "line", x0: 0, y0: h - r, x1: 0, y1: r },
      { kind: "arc", cx: r, cy: r, r, a0: P, a1: 1.5 * P },
    ],
  };
}

/** A circle outline, clockwise from its top. */
export function inkCircle(cx: number, cy: number, r: number): InkOutline {
  return { segs: [{ kind: "arc", cx, cy, r, a0: -Math.PI / 2, a1: 1.5 * Math.PI }] };
}

/** Ambient modes: [wavelength × ambientWave, direction, speed × ambientDrift, weight, phase]. */
const AMBIENT: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [1, 1, 1, 0.45, 0.7],
  [0.58, -1, 1.4, 0.25, 2.3],
  [1.7, 1, 0.7, 0.3, 4.1],
];

/**
 * The surface: N samples along the outline (by arc length), each with a displacement h along its
 * outward normal and a velocity v. A damped wave equation with a weak restoring force moves them
 * (fixed 1/240 s sub-steps); pointer impulses are low-passed in through pending buffers; a smooth
 * travelling noise (the ambient shimmer) is added at render time. Rendered as a Catmull-Rom spline,
 * or as the exact rest path while it is quiet.
 */
export class WaveField {
  readonly n: number;
  readonly ds: number;
  readonly restD: string;
  /** rest positions, outward normals, tangents, mobility (0 pinned … 1 free) */
  private readonly rx: Float64Array;
  private readonly ry: Float64Array;
  private readonly nx: Float64Array;
  private readonly ny: Float64Array;
  private readonly tx: Float64Array;
  private readonly ty: Float64Array;
  private readonly mob: Float64Array;
  private readonly corner: Uint8Array;
  private readonly inner: Uint8Array;
  readonly h: Float64Array;
  readonly v: Float64Array;
  private readonly ph: Float64Array;
  private readonly pv: Float64Array;
  private readonly acc: Float64Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly as: Float64Array[] = [];
  private readonly ac: Float64Array[] = [];
  private readonly am: number[] = [];
  private readonly box: [number, number, number, number];
  readonly L: number;
  /** ambient amplitude (px) */
  amb = 0;
  /** 0..1: how close the pointer is to the edge */
  prox = 0;
  /** pointer over the ink or within wakeDist of it */
  near = false;
  /** sustained ambient amplitude (px) regardless of the pointer (the drop while loading) */
  floor = 0;
  time = 0;
  peak = 0;
  private pending = false;
  /** field time (s) of the last pointer move near the surface, and of the last pointer ripple */
  private movedAt = 0;
  private touchedAt = -Infinity;
  /** samples drawn while only the ambient shimmer moves the edge: every other one (plus corners and pinned ink) */
  private readonly coarse: Int32Array;
  private readonly all: Int32Array;

  constructor(o: InkOutline) {
    const W = INK_WAVES;
    const segs = o.segs.filter((s) => segLen(s) > 0.5);
    if (!segs.length) throw new Error("empty ink outline");
    const lens = segs.map(segLen);
    const L = lens.reduce((a, b) => a + b, 0);
    const sp = Math.max(W.spacing, L / Math.max(16, W.maxSamples));
    const n = Math.max(16, Math.round(L / sp));
    const ds = L / n;
    this.n = n;
    this.ds = ds;
    this.L = L;
    const F = (): Float64Array => new Float64Array(n);
    this.rx = F();
    this.ry = F();
    this.nx = F();
    this.ny = F();
    this.tx = F();
    this.ty = F();
    this.mob = F();
    this.h = F();
    this.v = F();
    this.ph = F();
    this.pv = F();
    this.acc = F();
    this.px = F();
    this.py = F();
    this.corner = new Uint8Array(n);
    this.inner = new Uint8Array(n);
    const fixed = new Uint8Array(n);
    const segOf = new Uint16Array(n);
    const p = [0, 0, 0, 0];

    // uniform samples by arc length
    let si = 0;
    let acc0 = 0;
    for (let k = 0; k < n; k++) {
      const s = k * ds;
      while (si < segs.length - 1 && s > acc0 + lens[si]) {
        acc0 += lens[si];
        si++;
      }
      segAt(segs[si], Math.min(s - acc0, lens[si]), p);
      this.rx[k] = p[0];
      this.ry[k] = p[1];
      this.tx[k] = p[2];
      this.ty[k] = p[3];
      fixed[k] = segs[si].fixed ? 1 : 0;
      segOf[k] = si;
    }
    // sharp joints: snap the nearest sample onto the corner, tangent = bisector
    acc0 = 0;
    const q = [0, 0, 0, 0];
    for (let i = 0; i < segs.length; i++) {
      const prev = segs[(i - 1 + segs.length) % segs.length];
      segAt(prev, segLen(prev), q);
      segAt(segs[i], 0, p);
      if (q[2] * p[2] + q[3] * p[3] < 0.9) {
        const k = Math.round(acc0 / ds) % n;
        this.rx[k] = p[0];
        this.ry[k] = p[1];
        const bx = q[2] + p[2];
        const by = q[3] + p[3];
        const bl = Math.hypot(bx, by) || 1;
        this.tx[k] = bx / bl;
        this.ty[k] = by / bl;
        this.corner[k] = 1;
        fixed[k] = prev.fixed || segs[i].fixed ? 1 : 0;
        segOf[k] = i;
      }
      acc0 += lens[i];
    }
    // orientation → outward normals
    let area = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      area += this.rx[k] * this.ry[j] - this.rx[j] * this.ry[k];
    }
    const sg = area > 0 ? 1 : -1;
    for (let k = 0; k < n; k++) {
      this.nx[k] = sg * this.ty[k];
      this.ny[k] = -sg * this.tx[k];
      this.inner[k] = segs[segOf[k]].kind === "line" && !this.corner[k] ? 1 : 0;
    }
    // mobility: 0 on fixed stretches, ramping up to 1 over edgeRamp px of free outline
    const dist = new Float64Array(n).fill(1e9);
    let anyFixed = false;
    for (let k = 0; k < n; k++) {
      if (fixed[k]) {
        dist[k] = 0;
        anyFixed = true;
      }
    }
    if (anyFixed) {
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < n; k++) dist[k] = Math.min(dist[k], dist[(k - 1 + n) % n] + ds);
        for (let k = n - 1; k >= 0; k--) dist[k] = Math.min(dist[k], dist[(k + 1) % n] + ds);
      }
    }
    for (let k = 0; k < n; k++) this.mob[k] = !anyFixed ? 1 : dist[k] === 0 ? 0 : smooth(dist[k] / Math.max(1, W.edgeRamp));
    // ambient bases: whole numbers of wavelengths around the loop, so the pattern closes seamlessly
    for (const [wf, , , , ph0] of AMBIENT) {
      const m = Math.max(2, Math.round(L / Math.max(8, W.ambientWave * wf)));
      const sA = F();
      const cA = F();
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * m * k) / n + ph0;
        sA[k] = Math.sin(a);
        cA[k] = Math.cos(a);
      }
      this.as.push(sA);
      this.ac.push(cA);
      this.am.push(m);
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < n; k++) {
      if (!(this.mob[k] > 0)) continue;
      x0 = Math.min(x0, this.rx[k]);
      x1 = Math.max(x1, this.rx[k]);
      y0 = Math.min(y0, this.ry[k]);
      y1 = Math.max(y1, this.ry[k]);
    }
    this.box = [x0, y0, x1, y1];
    this.restD = inkOutlinePath(o);
    const idx: number[] = [];
    for (let k = 0; k < n; k++) if (k % 2 === 0 || this.corner[k] || this.mob[k] < 1) idx.push(k);
    this.coarse = Int32Array.from(idx);
    this.all = Int32Array.from({ length: n }, (_, k) => k);
  }

  /** Carry the motion of a previous field (same shape, other size) over by relative arc length. */
  adopt(o: WaveField): void {
    for (let k = 0; k < this.n; k++) {
      const f = (k / this.n) * o.n;
      const i = Math.floor(f) % o.n;
      const j = (i + 1) % o.n;
      const t = f - Math.floor(f);
      this.h[k] = lerp(o.h[i], o.h[j], t);
      this.v[k] = lerp(o.v[i], o.v[j], t);
      this.ph[k] = lerp(o.ph[i], o.ph[j], t);
      this.pv[k] = lerp(o.pv[i], o.pv[j], t);
    }
    this.amb = o.amb;
    this.prox = o.prox;
    this.near = o.near;
    this.time = o.time;
    this.peak = o.peak;
    this.pending = o.pending;
    this.movedAt = o.movedAt;
    this.touchedAt = o.touchedAt;
  }

  reset(): void {
    this.h.fill(0);
    this.v.fill(0);
    this.ph.fill(0);
    this.pv.fill(0);
    this.amb = 0;
    this.peak = 0;
    this.pending = false;
  }

  leave(): void {
    this.near = false;
    this.prox = 0;
  }

  /** The pointer is near but has not moved for `restAfter` s: the shimmer fades and the frames stop. */
  resting(): boolean {
    return this.near && this.time - this.movedAt > INK_WAVES.restAfter;
  }

  /** Pointer ripples are running (full frame rate); otherwise only ambient / self-driven motion (30 fps). */
  hot(): boolean {
    return this.time - this.touchedAt < INK_WAVES.hotFor;
  }

  awake(): boolean {
    return (this.near && !this.resting()) || this.floor > 0 || this.amb > 0 || this.pending || this.peak > INK_WAVES.sleep;
  }

  private nearest(x: number, y: number): number {
    let best = -1;
    let bd = Infinity;
    const { rx, ry, mob } = this;
    for (let k = 0; k < this.n; k++) {
      if (!(mob[k] > 0)) continue;
      const ex = x - rx[k];
      const ey = y - ry[k];
      const d2 = ex * ex + ey * ey;
      if (d2 < bd) {
        bd = d2;
        best = k;
      }
    }
    return best;
  }

  /**
   * Pointer at local (x, y), moved by (dx, dy) since its previous event. Updates hover state and
   * injects a direction-aware impulse near the closest edge point. Returns true when the surface
   * needs frames.
   */
  feed(x: number, y: number, dx: number, dy: number): boolean {
    const W = INK_WAVES;
    const reach = Math.max(W.hoverDist, W.wakeDist);
    const was = this.near || this.prox > 0;
    const [x0, y0, x1, y1] = this.box;
    if (x < x0 - reach || x > x1 + reach || y < y0 - reach || y > y1 + reach) {
      this.leave();
      return was;
    }
    const b = this.nearest(x, y);
    if (b < 0) return was;
    const ex = x - this.rx[b];
    const ey = y - this.ry[b];
    const dist = Math.hypot(ex, ey);
    const inside = ex * this.nx[b] + ey * this.ny[b] < 0;
    this.prox = dist < W.hoverDist ? smooth(1 - dist / W.hoverDist) * this.mob[b] : 0;
    this.near = inside || dist < reach;
    const len = Math.hypot(dx, dy);
    if (len > 0) this.movedAt = this.time;
    if (this.prox > 0.001 && len > 0 && len < 160) {
      this.touchedAt = this.time;
      const w = this.prox;
      const dn = dx * this.nx[b] + dy * this.ny[b]; // + away from the ink, − toward it
      const dt = dx * this.tx[b] + dy * this.ty[b]; // along the edge
      const cap = W.clamp * 0.6; // one event never saturates the edge on its own
      const push = clamp(W.push * dn * w, -cap, cap); // a dent (toward) or a lift (away) that splits into two ripples
      // sliding along the edge pushes ink ahead of the pointer and leaves a trough behind it: a
      // zero-mean packet (so a small closed outline like the drop never inflates) that already
      // travels the pointer's way at wave speed
      const dir = dt >= 0 ? 1 : -1;
      const crest = Math.min(cap, W.drag * Math.abs(dt) * w) * 1.65; // 1.65 ≈ 1/peak of (s/σ)·g
      const sig = Math.max(2, W.falloff);
      const span = Math.min(Math.ceil((3 * sig) / this.ds), Math.floor((this.n - 1) / 2));
      const lim = W.clamp * 2;
      for (let o = -span; o <= span; o++) {
        const j = (b + o + this.n) % this.n;
        const m = this.mob[j];
        if (!(m > 0)) continue;
        const s = o * this.ds;
        const u = s / sig;
        const g = Math.exp(-0.5 * u * u);
        const pk = dir * u * g; // the packet: + ahead of the pointer, − behind
        const pkd = (dir * (1 - u * u) * g) / sig; // ∂pk/∂s
        this.ph[j] = clamp(this.ph[j] + m * (push * g + crest * pk), -lim, lim);
        this.pv[j] += m * -W.speed * dir * crest * pkd; // v = −c·∂h/∂s: runs toward `dir`
      }
      this.pending = true;
    }
    return this.near || was || this.pending;
  }

  /** A bump of `amount` px (outward if positive) at the edge point closest to local (x, y). */
  poke(x: number, y: number, amount: number): void {
    const b = this.nearest(x, y);
    if (b < 0) return;
    const sig = Math.max(2, INK_WAVES.falloff * 0.8);
    const span = Math.min(Math.ceil((3 * sig) / this.ds), Math.floor((this.n - 1) / 2));
    for (let o = -span; o <= span; o++) {
      const j = (b + o + this.n) % this.n;
      const s = o * this.ds;
      this.ph[j] += this.mob[j] * amount * Math.exp((-s * s) / (2 * sig * sig));
    }
    this.pending = true;
  }

  step(dt: number): void {
    const W = INK_WAVES;
    const resting = this.resting();
    const pointer = this.near && !resting ? W.ambientRest + (W.ambientHover - W.ambientRest) * this.prox : 0;
    const want = Math.max(pointer, this.floor);
    this.amb = approach(this.amb, want, want > this.amb ? W.ambientRise : resting ? W.restFall : W.ambientFall, dt);
    if (!want && this.amb < W.sleep * 0.5) this.amb = 0;
    this.time += dt;
    // a quiet surface (no ripple, nothing pending) has h = v = 0 everywhere: nothing to integrate
    if (!this.pending && this.peak <= W.sleep) return;
    let rem = Math.min(dt, 0.1);
    while (rem > 1e-9) {
      const k = Math.min(rem, STEP);
      rem -= k;
      this.sub(k);
    }
    let pk = 0;
    const { h, v } = this;
    for (let i = 0; i < this.n; i++) {
      const a = Math.abs(h[i]);
      if (a > pk) pk = a;
      const b = Math.abs(v[i]) * 0.05;
      if (b > pk) pk = b;
    }
    this.peak = pk;
    if (pk <= W.sleep && !this.pending) {
      h.fill(0);
      v.fill(0);
    }
  }

  private sub(dt: number): void {
    const W = INK_WAVES;
    const { n, h, v, ph, pv, mob, acc } = this;
    const ds2 = this.ds * this.ds;
    const c2 = (W.speed * W.speed) / ds2;
    const nu = W.viscosity / ds2;
    const k = W.restore;
    const dmp = W.damping;
    const sponge = W.sponge;
    const lim = W.clamp * 1.6;
    if (this.pending) {
      const f = 1 - Math.exp(-dt / Math.max(1e-3, W.smoothing));
      let left = false;
      for (let i = 0; i < n; i++) {
        const a = ph[i] * f;
        const b = pv[i] * f;
        h[i] += a;
        v[i] += b;
        ph[i] -= a;
        pv[i] -= b;
        if (Math.abs(ph[i]) > 1e-3 || Math.abs(pv[i]) > 0.05) left = true;
      }
      if (!left) {
        ph.fill(0);
        pv.fill(0);
      }
      this.pending = left;
    }
    for (let i = 0; i < n; i++) {
      const a = i ? i - 1 : n - 1;
      const b = i < n - 1 ? i + 1 : 0;
      acc[i] =
        c2 * (h[a] - 2 * h[i] + h[b]) + nu * (v[a] - 2 * v[i] + v[b]) - (dmp + sponge * (1 - mob[i])) * v[i] - k * h[i];
    }
    for (let i = 0; i < n; i++) {
      v[i] += acc[i] * dt;
      let y = h[i] + v[i] * dt;
      if (y > lim) {
        y = lim;
        if (v[i] > 0) v[i] = 0;
      } else if (y < -lim) {
        y = -lim;
        if (v[i] < 0) v[i] = 0;
      }
      h[i] = y;
    }
  }

  /** The displaced outline as an SVG path (`uniform` px added everywhere, e.g. breathing). */
  path(uniform = 0): string {
    const W = INK_WAVES;
    if (this.amb < W.sleep && this.peak <= W.sleep && !this.pending && Math.abs(uniform) < W.sleep) return this.restD;
    const { rx, ry, nx, ny, mob, h, px, py, corner, inner } = this;
    // only the ambient shimmer (long wavelengths) and breathing move the edge: half the samples draw it
    const ix = !this.pending && this.peak <= W.sleep ? this.coarse : this.all;
    const m = ix.length;
    const cl = Math.max(0.5, W.clamp);
    const cs: number[] = [];
    const sn: number[] = [];
    for (let a = 0; a < AMBIENT.length; a++) {
      const [, dir, sf, wgt] = AMBIENT[a];
      const off = (-dir * 2 * Math.PI * this.am[a] * W.ambientDrift * sf * this.time) / this.L;
      cs.push(Math.cos(off) * wgt * this.amb);
      sn.push(Math.sin(off) * wgt * this.amb);
    }
    for (let q = 0; q < m; q++) {
      const i = ix[q];
      let a = h[i] + uniform;
      for (let b = 0; b < cs.length; b++) a += this.as[b][i] * cs[b] + this.ac[b][i] * sn[b];
      const d = mob[i] * cl * Math.tanh(a / cl);
      px[i] = rx[i] + nx[i] * d;
      py[i] = ry[i] + ny[i] * d;
    }
    let d = `M${fmt(px[ix[0]])} ${fmt(py[ix[0]])}`;
    for (let q = 0; q < m; q++) {
      const i = ix[q];
      const j = ix[q < m - 1 ? q + 1 : 0];
      const j1 = ix[q < m - 2 ? q + 2 : q + 2 - m];
      if (mob[i] === 0 && mob[j] === 0) {
        // a pinned straight stretch: only its corners and its last point matter
        if (inner[j] && mob[j1] === 0 && j !== ix[0]) continue;
        d += `L${fmt(px[j])} ${fmt(py[j])}`;
        continue;
      }
      const i0 = ix[q ? q - 1 : m - 1];
      let c1x: number;
      let c1y: number;
      let c2x: number;
      let c2y: number;
      if (corner[i]) {
        c1x = px[i] + (px[j] - px[i]) / 3;
        c1y = py[i] + (py[j] - py[i]) / 3;
      } else {
        c1x = px[i] + (px[j] - px[i0]) / 6;
        c1y = py[i] + (py[j] - py[i0]) / 6;
      }
      if (corner[j]) {
        c2x = px[j] - (px[j] - px[i]) / 3;
        c2y = py[j] - (py[j] - py[i]) / 3;
      } else {
        c2x = px[j] - (px[j1] - px[i]) / 6;
        c2y = py[j] - (py[j1] - py[i]) / 6;
      }
      d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(px[j])} ${fmt(py[j])}`;
    }
    return `${d}Z`;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Pointer hub: one passive window listener feeds every live wave surface (the ink is mostly
 * pointer-events:none, and ripples start before the pointer reaches it)
 * --------------------------------------------------------------------------------------------- */

export interface WaveClient {
  /** Pointer at viewport (cx, cy), moved by (dx, dy) since the previous event. */
  move(cx: number, cy: number, dx: number, dy: number): void;
  /** Pointer left the window. */
  out(): void;
}

const waveClients = new Set<WaveClient>();
let hubOn = false;
let lastPX = NaN;
let lastPY = NaN;

function hubPoint(x: number, y: number): void {
  const dx = Number.isFinite(lastPX) ? x - lastPX : 0;
  const dy = Number.isFinite(lastPY) ? y - lastPY : 0;
  lastPX = x;
  lastPY = y;
  for (const c of Array.from(waveClients)) {
    try {
      c.move(x, y, dx, dy);
    } catch (e) {
      warn(e, "ink waves");
    }
  }
}

function hubMove(e: PointerEvent): void {
  try {
    if (e.pointerType === "touch") return;
    let pts: PointerEvent[] = [];
    try {
      if (typeof e.getCoalescedEvents === "function") pts = e.getCoalescedEvents();
    } catch {
      pts = [];
    }
    if (pts.length > 1) {
      // keep the path's shape (at most 4 points per event), always ending on the latest one
      const step = Math.ceil(pts.length / 4);
      for (let i = (pts.length - 1) % step; i < pts.length; i += step) hubPoint(pts[i].clientX, pts[i].clientY);
    } else hubPoint(e.clientX, e.clientY);
  } catch (err) {
    warn(err, "ink waves");
  }
}

function hubLeave(): void {
  lastPX = NaN;
  lastPY = NaN;
  for (const c of Array.from(waveClients)) {
    try {
      c.out();
    } catch (e) {
      warn(e, "ink waves");
    }
  }
}

function hubOut(e: PointerEvent): void {
  if (!e.relatedTarget) hubLeave();
}

export function hubAdd(c: WaveClient): void {
  waveClients.add(c);
  if (hubOn) return;
  hubOn = true;
  try {
    window.addEventListener("pointermove", hubMove, { capture: true, passive: true });
    window.addEventListener("pointerout", hubOut, { capture: true, passive: true });
    window.addEventListener("blur", hubLeave);
  } catch (e) {
    warn(e, "ink waves");
  }
}

export function hubRemove(c: WaveClient): void {
  waveClients.delete(c);
  if (!hubOn || waveClients.size) return;
  hubOn = false;
  try {
    window.removeEventListener("pointermove", hubMove, { capture: true });
    window.removeEventListener("pointerout", hubOut, { capture: true });
    window.removeEventListener("blur", hubLeave);
  } catch {
    /* ignore */
  }
}
