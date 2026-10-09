/**
 * Brush mode: paint a freehand stroke with a round brush. Points are recorded in
 * page coordinates so the live stroke stays glued to the page if it scrolls mid-gesture.
 */
import type { Rect, Stroke } from "../shared/types";
import { clamp } from "./util";

export const BRUSH_DEFAULT = 48;
export const BRUSH_MIN = 16;
export const BRUSH_MAX = 160;
export const BRUSH_STEP = 8;

type Pt = { x: number; y: number };


const num = (n: number) => String(Math.round(n * 10) / 10);

/** SVG path data for a polyline, offset by (ox, oy). A single point becomes a dot (round caps). */
export function strokePath(points: Pt[], ox = 0, oy = 0): string {
  if (!points.length) return "";
  let d = `M${num(points[0].x - ox)} ${num(points[0].y - oy)}`;
  if (points.length === 1) return d + "l0.01 0";
  for (let i = 1; i < points.length; i++) d += `L${num(points[i].x - ox)} ${num(points[i].y - oy)}`;
  return d;
}

export function strokeLength(points: Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker, iterative. Keeps the first and last points. */
export function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Page-coordinate bounds of a stroke, inflated by half the brush size and rounded outward. */
export function strokeBounds(s: Stroke): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  const r = s.size / 2;
  const x = Math.floor(x0 - r);
  const y = Math.floor(y0 - r);
  return { x, y, width: Math.ceil(x1 + r) - x, height: Math.ceil(y1 + r) - y };
}

export class Brush {
  size = BRUSH_DEFAULT;
  private points: Pt[] | null = null;
  private len = 0;
  private d = "";

  /**
   * `layer` is a full-viewport SVG, `group` its scroll-offset <g>, `path` the live stroke,
   * `cursor` the round size preview that follows the pointer.
   */
  constructor(
    private layer: SVGSVGElement,
    private group: SVGGElement,
    private path: SVGPathElement,
    private cursor: HTMLElement
  ) {
    this.applySize();
  }

  get active(): boolean {
    return !!this.points;
  }

  setSize(n: number): number {
    const v = clamp(Math.round(n / BRUSH_STEP) * BRUSH_STEP, BRUSH_MIN, BRUSH_MAX);
    if (v !== this.size) {
      this.size = v;
      this.applySize();
    }
    return this.size;
  }

  private applySize(): void {
    this.path.setAttribute("stroke-width", String(this.size));
    this.cursor.style.width = `${this.size}px`;
    this.cursor.style.height = `${this.size}px`;
    this.cursor.style.marginLeft = `${-this.size / 2}px`;
    this.cursor.style.marginTop = `${-this.size / 2}px`;
  }

  /** Move the size preview to a viewport point. */
  hover(x: number, y: number): void {
    this.cursor.hidden = false;
    this.cursor.style.transform = `translate(${x}px, ${y}px)`;
  }

  hideCursor(): void {
    this.cursor.hidden = true;
  }

  down(x: number, y: number): void {
    const p = { x: x + window.scrollX, y: y + window.scrollY };
    this.points = [p];
    this.len = 0;
    this.d = `M${num(p.x)} ${num(p.y)}`;
    this.layer.removeAttribute("hidden");
    this.sync();
    this.hover(x, y);
    this.render();
  }

  move(x: number, y: number): void {
    this.hover(x, y);
    const pts = this.points;
    if (!pts) return;
    const p = { x: x + window.scrollX, y: y + window.scrollY };
    const last = pts[pts.length - 1];
    const dist = Math.hypot(p.x - last.x, p.y - last.y);
    if (dist < 1) return;
    pts.push(p);
    this.len += dist;
    this.d += `L${num(p.x)} ${num(p.y)}`;
    this.render();
  }

  /** Finished stroke (simplified, page coordinates), or null when it was really a click. */
  up(x: number, y: number): Stroke | null {
    this.move(x, y);
    const pts = this.points;
    const len = this.len;
    this.cancel();
    if (!pts || pts.length < 2 || len < 8) return null;
    const points = simplify(pts, 2).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    return { points, size: this.size };
  }

  cancel(): void {
    this.points = null;
    this.len = 0;
    this.d = "";
    this.path.setAttribute("d", "");
    this.layer.setAttribute("hidden", "");
  }

  /** Re-offset the live stroke for the current scroll position. */
  sync(): void {
    if (!this.points) return;
    this.group.setAttribute("transform", `translate(${-window.scrollX} ${-window.scrollY})`);
  }

  private render(): void {
    const pts = this.points;
    if (!pts) return;
    this.path.setAttribute("d", pts.length === 1 ? this.d + "l0.01 0" : this.d);
  }
}
