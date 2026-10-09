/**
 * The gooey metaball filter shared by the dock's morph and the note card's ink drop:
 * feTurbulence → feDisplacementMap (wobble) → feGaussianBlur → feColorMatrix alpha threshold. It is
 * applied only while something moves and removed (ramped to identity first) once the shapes settle.
 */
import { svgEl } from "../util";
import { fmt } from "./math";

/** Goo at full strength: blur σ, then alpha' = M·alpha + B (threshold ≈ 0.48, ~0.55 px AA ramp;
 * softer ramps leave grey half-transparent necks on thin bridges, harder ones alias). */
const GOO_SIGMA = 4;
const GOO_M = 18;
const GOO_B = -8.1;

export interface Goo {
  readonly filter: SVGFilterElement;
  readonly id: string;
  /**
   * Strength `g` (0 … 1) and wobble `w` (displacement px) on `target` (the group it filters); at
   * (≈0, ≈0) the filter is removed. `fx`, `fy`: the noise's base frequencies while it wobbles.
   * Returns the strength now shown (0 when off).
   */
  set(target: Element, g: number, w: number, fx: number, fy: number): number;
}

/** Build the filter in `defs` (user-space region set by the caller, or later via `filter`). */
export function createGoo(defs: Element, id: string, region?: { x: number; y: number; width: number; height: number }): Goo {
  const filter = svgEl("filter", { id, filterUnits: "userSpaceOnUse", ...(region || {}), "color-interpolation-filters": "sRGB" }, defs);
  const turb = svgEl("feTurbulence", { type: "fractalNoise", baseFrequency: "0.02 0.024", numOctaves: 2, seed: 3, result: "noise" }, filter);
  const disp = svgEl("feDisplacementMap", {
    in: "SourceGraphic", in2: "noise", scale: 0, xChannelSelector: "R", yChannelSelector: "G", result: "wob",
  }, filter);
  const blur = svgEl("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 0, result: "soft" }, filter);
  const thresh = svgEl("feColorMatrix", { in: "soft", type: "matrix", values: "" }, filter);
  let on: Element | null = null;
  return {
    filter,
    id,
    set(target, g, w, fx, fy) {
      if (g < 0.002 && w < 0.01) {
        if (on) {
          on.removeAttribute("filter");
          on = null;
        }
        return 0;
      }
      if (on !== target) {
        on?.removeAttribute("filter");
        target.setAttribute("filter", `url(#${id})`);
        on = target;
      }
      blur.setAttribute("stdDeviation", fmt(GOO_SIGMA * g));
      const m = 1 + (GOO_M - 1) * g;
      const b = GOO_B * g;
      thresh.setAttribute("values", `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${m.toFixed(3)} ${b.toFixed(3)}`);
      if (w > 0.01) {
        blur.setAttribute("in", "wob");
        disp.setAttribute("scale", fmt(w));
        turb.setAttribute("baseFrequency", `${fx.toFixed(4)} ${fy.toFixed(4)}`);
      } else {
        blur.setAttribute("in", "SourceGraphic");
      }
      return g;
    },
  };
}
