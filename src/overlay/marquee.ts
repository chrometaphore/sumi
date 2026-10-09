/** Marquee mode: drag out a rectangle in viewport coordinates. */

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class Marquee {
  private start: { x: number; y: number } | null = null;
  private rect: ViewRect | null = null;

  constructor(private box: HTMLElement, private size: HTMLElement) {}

  get active(): boolean {
    return !!this.start;
  }

  down(x: number, y: number): void {
    this.start = { x, y };
    this.rect = { left: x, top: y, width: 0, height: 0 };
    this.draw();
  }

  move(x: number, y: number): void {
    if (!this.start) return;
    const s = this.start;
    this.rect = {
      left: Math.min(s.x, x),
      top: Math.min(s.y, y),
      width: Math.abs(x - s.x),
      height: Math.abs(y - s.y),
    };
    this.draw();
  }

  /** Returns the finished rectangle, or null for a click / tiny drag. */
  up(x: number, y: number): ViewRect | null {
    this.move(x, y);
    const r = this.rect;
    this.cancel();
    return r && r.width >= 8 && r.height >= 8 ? r : null;
  }

  cancel(): void {
    this.start = null;
    this.rect = null;
    this.box.hidden = true;
  }

  private draw(): void {
    const r = this.rect;
    if (!r) return;
    this.box.hidden = r.width < 2 && r.height < 2;
    this.box.style.left = `${r.left}px`;
    this.box.style.top = `${r.top}px`;
    this.box.style.width = `${r.width}px`;
    this.box.style.height = `${r.height}px`;
    this.size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  }
}
