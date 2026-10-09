/**
 * Paused Web Animations seeked from the ink clock: content entrances and exits that stay frame-exact
 * with the ink they ride on (the dock's tools, the note card's rows).
 */
import { clamp } from "./math";

/** `translate` where supported (it composes with the UI's own transforms), else `transform`. */
const translateKey = ((): "translate" | "transform" => {
  try {
    return CSS.supports("translate", "1px 0") ? "translate" : "transform";
  } catch {
    return "transform";
  }
})();

/** A keyframe moving an element by (x, y) px. */
export const shift = (x: number, y: number): Keyframe =>
  translateKey === "translate" ? { translate: `${x}px ${y}px` } : { transform: `translate(${x}px, ${y}px)` };

export class Choreo {
  private anims: Array<{ a: Animation; offset: number; dur: number }> = [];
  /** Time (ms from the choreography's start) at which the last animation ends. */
  end = 0;

  get size(): number {
    return this.anims.length;
  }

  /** Add an animation of `node` that starts `offset` ms in and lasts `dur` ms (paused at its start). */
  add(node: Element, frames: Keyframe[], dur: number, easing: string, offset: number): void {
    if (typeof (node as HTMLElement).animate !== "function") return;
    try {
      const d = Math.max(1, dur);
      const a = (node as HTMLElement).animate(frames, { duration: d, easing, fill: "both" });
      a.pause();
      a.currentTime = 0;
      this.anims.push({ a, offset, dur: d });
    } catch {
      /* no WAAPI: the content just shows */
    }
  }

  /** Seek every animation to `e` ms; true while the choreography is still running. */
  seek(e: number): boolean {
    for (const c of this.anims) {
      try {
        c.a.currentTime = clamp(e - c.offset, 0, c.dur);
      } catch {
        /* ignore */
      }
    }
    return e < this.end;
  }

  /** Drop every animation: the elements fall back to their own styles. */
  cancel(): void {
    for (const c of this.anims) {
      try {
        c.a.cancel();
      } catch {
        /* ignore */
      }
    }
    this.anims = [];
  }
}
