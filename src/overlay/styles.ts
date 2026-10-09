/** All overlay CSS. Lives inside the shadow root, isolated from the page. Sumi chrome is always ink. */
import { DROP, TAB_H, TAB_W } from "./ink";

/** Gap between the dock's ink and the surfaces that emerge to its left (menu, hint, toasts). */
export const GAP = 10;
/** Tooltips sit a little closer to the dock than the menu and hint do. */
export const TIP_GAP = 6;
const SIDE = TAB_W + GAP; // right offset of tooltips, hint, menu, toasts
const SIDE_CLOSED = DROP + GAP + 10; // the closed drop sits 10px off the edge

/** The dock's tool column: top inset in the tab, padding, and one 40 px row per tool. */
const TOOLS_TOP = 16;
const TOOLS_PAD = 4;
const ROW = 40;
/** Tab-local centre y of tool row `i` (pin 0, marquee 1, brush 2). */
export const toolRowY = (i: number): number => TOOLS_TOP + TOOLS_PAD + ROW * i + ROW / 2;

export const CSS = `
:host { all: initial !important;
  /* Re-assert the host's own stacking after the reset: it must stay a max-z-index fixed layer,
     or every overlay layer falls back into the page's stacking order (headers would cover it). */
  display: block !important; position: fixed !important; top: 0 !important; left: 0 !important;
  width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; }
.dp {
  --ink: #000; --ink-2: #1c1c1c; --ink-3: #2a2a2a; --paper: #fff; --mute: #888; --mute-2: #777; --on-paper: #111;
  --amber: #f59e0b; --blue: #3b82f6; --violet: #8b5cf6; --green: #22c55e; --grey: #9ca3af;
  --ink-shadow: 0 14px 36px rgba(0, 0, 0, .26), 0 2px 8px rgba(0, 0, 0, .16);
  --ease: cubic-bezier(.2, .7, .3, 1);
  font: 400 13px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--paper);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  letter-spacing: normal; text-transform: none; text-align: left; direction: ltr;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; text-align: inherit; -webkit-tap-highlight-color: transparent; }
button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid rgba(255, 255, 255, .9); outline-offset: 2px; }
svg { display: block; flex: none; }

@keyframes dp-pop { from { transform: scale(.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes dp-fade { from { opacity: 0; } to { opacity: 1; } }

/* status palette: page marks (draft = ink) */
[data-s="draft"] { --c: var(--ink); --cbg: rgba(0, 0, 0, .08); --on-c: #fff; }
[data-s="sent"] { --c: var(--blue); --cbg: rgba(59, 130, 246, .10); --on-c: #fff; }
[data-s="needs-input"] { --c: var(--violet); --cbg: rgba(139, 92, 246, .10); --on-c: #fff; }
[data-s="resolved"] { --c: var(--green); --cbg: rgba(34, 197, 94, .10); --on-c: #fff; }
.detached { --c: var(--grey) !important; --cbg: rgba(156, 163, 175, .10) !important; }
/* on ink surfaces a draft reads as paper */
.ink [data-s="draft"] { --c: var(--paper); --cbg: rgba(255, 255, 255, .07); --on-c: var(--on-paper); }

/* capture layer (only while a mode is active) */
.capture { position: fixed; inset: 0; z-index: 1; cursor: crosshair; background: transparent; touch-action: none; }
.capture.brush-mode { cursor: none; }

/* brush: live stroke, saved strokes, size preview (draft strokes are sumi ink) */
/* Solid, hard-edged brush. Drafts paint with the loading gradient (stroke attribute); other statuses use their colour. */
.stroke-path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.stroke-region:not([data-s="draft"]) .stroke-path, .stroke-region.detached .stroke-path { stroke: var(--c); }
.live-stroke { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 2; pointer-events: none; overflow: visible; opacity: .6; }
.stroke-region { position: fixed; left: 0; top: 0; pointer-events: none; overflow: visible; opacity: .6;
  transition: opacity .12s; animation: dp-fade .12s ease-out; }
.stroke-region.hot { opacity: .75; }
.brush-cursor { position: fixed; left: 0; top: 0; z-index: 4; pointer-events: none; border-radius: 50%;
  border: 1.5px solid rgba(0, 0, 0, .9); background: rgba(0, 0, 0, .06);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .75), inset 0 0 0 1px rgba(255, 255, 255, .55); }
.brush-cursor::after { content: ""; position: absolute; left: 50%; top: 50%; width: 3px; height: 3px; margin: -1.5px 0 0 -1.5px;
  border-radius: 50%; background: #000; box-shadow: 0 0 0 1px rgba(255, 255, 255, .7); }

/* hover highlight: crisp ink line with a paper halo, legible on light and dark pages */
.hl { position: fixed; z-index: 2; pointer-events: none; border: 1.5px solid #000; border-radius: 3px; background: rgba(0, 0, 0, .035);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .95), inset 0 0 0 1px rgba(255, 255, 255, .9); }
.hl-label { position: absolute; left: -1.5px; bottom: 100%; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
  max-width: 320px; padding: 3px 9px; border-radius: 999px; background: #000; color: #fff; font-size: 11.5px; line-height: 18px;
  white-space: nowrap; box-shadow: 0 0 0 1px rgba(255, 255, 255, .14), 0 4px 12px rgba(0, 0, 0, .22); }
.hl-label b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.hl-label i { font-style: normal; color: var(--mute); overflow: hidden; text-overflow: ellipsis; }
.hl-label .dim { color: var(--mute-2); font-variant-numeric: tabular-nums; }
.hl.below .hl-label { bottom: auto; top: 100%; margin: 6px 0 0; }
.hl.inside .hl-label { bottom: auto; top: 4px; left: 4px; margin: 0; }
.hl.flip-x .hl-label { left: auto; right: -1.5px; }
.hl.inside.flip-x .hl-label { right: 4px; }

/* outline of the hovered / open annotation's element */
.tgt { position: fixed; z-index: 2; pointer-events: none; border: 1.5px solid #000; border-radius: 4px; background: rgba(0, 0, 0, .03);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .95), inset 0 0 0 1px rgba(255, 255, 255, .9); transition: opacity .12s; }

/* live marquee rectangle */
/* Selection colour = the loading drop's gradient, so it reads on any site. */
.marquee, .region[data-s="draft"]:not(.detached) { border: 0; border-radius: 6px;
  background: linear-gradient(149deg, rgba(124, 92, 255, .14), rgba(59, 130, 246, .12) 52%, rgba(45, 212, 191, .14));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .55); }
/* 2px gradient edge: a masked layer, so only the ring is opaque and the page stays visible inside. */
.marquee::before, .region[data-s="draft"]:not(.detached)::before { content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 2px; background: linear-gradient(149deg, #7c5cff 21%, #3b82f6 52%, #2dd4bf 82%); pointer-events: none;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.marquee { position: fixed; z-index: 2; pointer-events: none; }
.marquee .dim, .region .dim { position: absolute; right: 4px; bottom: 4px; padding: 1px 7px; border-radius: 999px; background: rgba(0, 0, 0, .86);
  color: #fff; font-size: 10.5px; font-variant-numeric: tabular-nums; }

/* marks: regions + pins */
.marks { position: fixed; inset: 0; z-index: 3; pointer-events: none; }
.region { position: fixed; left: 0; top: 0; pointer-events: none; border: 1.5px dashed var(--c); background: var(--cbg); border-radius: 6px;
  transition: border-color .12s, background-color .12s; animation: dp-fade .12s ease-out; }
.region.hot { border-style: solid; }
/* Regions are placed with transform, so only pins (hover scale) may transition it; otherwise new regions slide in from 0,0. */
.pin { transition: opacity .6s ease, transform .12s ease; }
.region, .stroke-region { transition: opacity .6s ease; }
.pin.leaving, .region.leaving, .stroke-region.leaving { opacity: 0 !important; pointer-events: none !important; }
.pin { position: fixed; left: 0; top: 0; width: 24px; height: 24px; border-radius: 50%; pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  background: var(--c); color: var(--on-c, #fff); border: 2px solid #fff; font-size: 11.5px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
  box-shadow: 0 3px 10px rgba(0, 0, 0, .26), 0 1px 2px rgba(0, 0, 0, .18);
  transition: transform .12s var(--ease), background-color .12s, box-shadow .12s; animation: dp-pop .18s var(--ease); }
.pin:hover, .pin.active { transform: scale(1.12); box-shadow: 0 5px 16px rgba(0, 0, 0, .32), 0 0 0 3px var(--cbg); }
.pin[data-s="draft"]:hover, .pin[data-s="draft"].active { box-shadow: 0 5px 16px rgba(0, 0, 0, .34), 0 0 0 3px rgba(0, 0, 0, .14); }
.pin.pending { box-shadow: 0 0 0 4px rgba(0, 0, 0, .16), 0 3px 10px rgba(0, 0, 0, .26); }
.pin:focus-visible { outline: 2px solid #000; outline-offset: 2px; }
.pin .sub { position: absolute; top: -6px; right: -6px; width: 15px; height: 15px; border-radius: 50%; background: #fff; color: var(--c);
  display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); }
.pin .sub svg { width: 9px; height: 9px; }
.pin .tip { position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%); width: max-content; max-width: 240px;
  padding: 7px 11px; border-radius: 12px; background: #000; color: #fff; font-size: 12px; font-weight: 400; line-height: 1.35; text-align: left;
  pointer-events: none; opacity: 0; transition: opacity .12s; box-shadow: 0 6px 18px rgba(0, 0, 0, .24); white-space: normal; }
.pin .tip b { font-weight: 600; margin-right: 4px; }
.pin .tip .r { display: block; margin-top: 3px; color: #aaa; }
.pin.tip-left .tip { left: auto; right: calc(100% + 8px); }
.pin:hover .tip { opacity: 1; }
.pin.active .tip { opacity: 0; }

/* ---------------------------------------------------------------- dock (content of the ink tab) */
.dock-col { position: absolute; inset: 0; }
.dock-tools { position: absolute; left: 16px; top: ${TOOLS_TOP}px; width: ${ROW}px; padding: ${TOOLS_PAD}px 0; display: flex; flex-direction: column; }
.dk-send { position: absolute; left: 16px; top: 152px; }
.dock-sec { position: absolute; left: 16px; top: 208px; width: 40px; padding: 4px 0; display: flex; flex-direction: column;
  border-radius: 100px; background: var(--ink-2); }
.dk { position: relative; width: ${ROW}px; height: ${ROW}px; display: grid; place-items: center; border-radius: 50%; color: #fff; }
.dk::before { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: rgba(255, 255, 255, .07); opacity: 0; transition: opacity .15s; }
.dk:hover::before, .dk[aria-expanded="true"]::before { opacity: 1; }
/* Selected tool: a soft pool of light under the icon so the current tool reads at a glance. */
.dk.on::before { opacity: 1; inset: 0; filter: blur(3px);
  background: radial-gradient(circle, rgba(255, 255, 255, .38) 0%, rgba(255, 255, 255, .17) 42%, rgba(255, 255, 255, 0) 72%); }
.dk:focus-visible { outline: 2px solid rgba(255, 255, 255, .85); outline-offset: -1px; }
.si { position: relative; display: block; width: 20px; height: 20px; flex: none; pointer-events: none; transition: transform .15s var(--ease); }
.si > svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; transition: filter .15s; }
/* the Figma pin sits in its 20×20 slot at inset -25.83% -13.33% (baked glow) */
.si > svg.si-pin { left: -13.333%; top: -25.833%; width: 126.667%; height: 151.667%; }
.dk:active .si { transform: scale(.9); }
/* Idle colours follow the Figma assets: tools #999 (the white pin dimmed by brightness(.6)), More /
 * Close #BBB. Hover (and the open More menu) lightens both to #CCC / #DDD; the selected tool is white + glow. */
.dk svg.si-pin { filter: brightness(.6); }
.dk:hover svg.si-pin { filter: brightness(.8); }
.dk.on svg.si-pin { filter: none; }
.dk:hover svg:not(.si-pin):not(.si-soft) { filter: brightness(1.3333); }
.dk:hover svg.si-soft, .dk[aria-expanded="true"] svg.si-soft { filter: brightness(1.1765); }
.dk.on svg:not(.si-pin) { filter: brightness(0) invert(1) drop-shadow(0 0 6px rgba(255, 255, 255, .45)); }
.dk-send { width: 40px; height: 40px; border-radius: 50%; display: block; }
.dk-send:focus-visible { outline-offset: 3px; }
.dk-pill { position: absolute; inset: 0; border-radius: 50%; display: grid; place-items: center;
  border: 2px solid #fff; background: linear-gradient(to bottom, #fff 50%, rgba(255, 255, 255, .9) 97.5%);
  box-shadow: 0 0 12px rgba(255, 255, 255, .35); transition: box-shadow .2s, border-color .2s, background .2s, transform .15s var(--ease); }
.dk-pill svg { width: 20px; height: 20px; display: block; transform: scaleX(-1); transition: filter .2s; }
.dk-send:hover .dk-pill { box-shadow: 0 0 18px rgba(255, 255, 255, .55); }
.dk-send:active .dk-pill { transform: scale(.94); }
/* nothing to send (or offline): the pill rests as quiet ink; it lights up white once there are drafts */
.dk-send[aria-disabled="true"] { cursor: default; }
.dk-send[aria-disabled="true"] .dk-pill { background: var(--ink-2); border-color: var(--ink-3); box-shadow: none; transform: none; }
/* disabled arrow #BBB: the #333 asset inverted is #CCC, × 187/204 */
.dk-send[aria-disabled="true"] .dk-pill svg { filter: invert(1) brightness(.9167); }
.dk-count { position: absolute; left: -5px; top: -5px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px;
  background: #fff; color: var(--on-paper); font-size: 10px; font-weight: 700; line-height: 17px; text-align: center;
  font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px #000; pointer-events: none; animation: dp-pop .2s var(--ease); }

/* ---------------------------------------------------------------- ink surfaces */
.ink { background: var(--ink); color: var(--paper); box-shadow: var(--ink-shadow); }
.kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 5px;
  background: var(--ink-3); color: #bdbdbd; font: 500 10.5px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums; }

/* tooltips */
.tt { position: fixed; z-index: 12; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; border-radius: 14px;
  font-size: 12px; font-weight: 500; white-space: nowrap; pointer-events: none; }
.tt.plain { padding-right: 12px; }
.tt .sub { color: var(--mute); font-weight: 400; }
.tt .dim { color: #6b6b6b; }

/* mode hint (+ brush size) */
.mode-hint { position: fixed; z-index: 8; height: 32px; display: flex; align-items: center; gap: 4px; padding: 0 8px 0 13px; border-radius: 16px;
  font-size: 12px; color: #d4d4d4; white-space: nowrap; pointer-events: none; transition: top .24s var(--ease); }
.mode-hint.interactive { pointer-events: auto; }
.mode-hint .sep { color: #555; margin: 0 3px; }
.size-slider { -webkit-appearance: none; appearance: none; width: 88px; height: 18px; margin: 0 6px 0 4px; background: transparent; cursor: pointer; }
.size-slider::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--ink-3); }
.size-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; margin-top: -4.5px; border-radius: 50%;
  background: #fff; box-shadow: 0 0 6px rgba(255, 255, 255, .35); }
.size-slider::-moz-range-track { height: 3px; border-radius: 2px; background: var(--ink-3); }
.size-slider::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }
.size-slider:focus-visible { outline-offset: 0; border-radius: 4px; }
.size-val { min-width: 38px; color: var(--mute); font-variant-numeric: tabular-nums; }

/* more menu */
.menu { position: fixed; z-index: 9; width: 236px; padding: 6px; border-radius: 18px; }
.mi { display: flex; align-items: center; gap: 10px; width: 100%; height: 34px; padding: 0 10px; border-radius: 12px; color: #ececec;
  font-size: 12.5px; transition: background-color .12s, color .12s; }
.mi svg { width: 15px; height: 15px; color: var(--mute); transition: color .12s; }
.mi:hover:not(:disabled), .mi:focus-visible { background: var(--ink-2); color: #fff; }
.mi:hover:not(:disabled) svg { color: #cfcfcf; }
.mi:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .7); }
.mi:disabled { color: #5c5c5c; cursor: default; }
.mi:disabled svg { color: #444; }
.mi .grow { flex: 1; }
.mi .n { color: var(--mute); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.menu-credit { padding: 8px 10px 4px; margin-top: 4px; border-top: 1px solid var(--ink-2); font-size: 10.5px; color: #8f8f8f; letter-spacing: .01em; }
.menu-credit a { color: #b5b5b5; text-decoration: none; }
.menu-credit a:hover { color: #fff; text-decoration: underline; text-underline-offset: 2px; }
.menu-credit a:focus-visible { outline: none; color: #fff; text-decoration: underline; }
.mi .chev { width: 13px; height: 13px; transition: transform .15s var(--ease); }
.mi[aria-expanded="true"] .chev { transform: rotate(90deg); }
.menu-sep { height: 1px; margin: 5px 8px; background: var(--ink-2); }
.keys { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; padding: 4px 12px 8px 12px; font-size: 11.5px; color: var(--mute); }
.keys .kk { display: flex; gap: 3px; justify-content: flex-end; }

/* shared bits on ink */
.badge { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--c); color: var(--on-c, #fff); display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.status { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--mute); white-space: nowrap; }
.status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 13px; border-radius: 999px; font-weight: 600; font-size: 12.5px;
  white-space: nowrap; transition: background-color .12s, color .12s, opacity .12s, box-shadow .12s; }
.btn svg { width: 14px; height: 14px; }
.btn svg.mirror { width: 16px; height: 16px; transform: scaleX(-1); }
.btn-primary { background: var(--paper); color: var(--on-paper); box-shadow: 0 0 12px rgba(255, 255, 255, .18); }
.btn-primary:hover { background: #e9e9e9; }
.btn-soft { background: var(--ink-2); color: #f2f2f2; }
.btn-soft:hover { background: var(--ink-3); color: #fff; }
.btn-ghost { color: var(--mute); font-weight: 500; padding: 0 10px; }
.btn-ghost:hover { background: var(--ink-2); color: #fff; }
.btn-danger:hover { background: rgba(248, 113, 113, .12); color: #fca5a5; }
.btn-danger.confirm { background: rgba(248, 113, 113, .14); color: #fca5a5; }
.btn:disabled { opacity: .4; cursor: default; }
.btn:disabled:hover { background: none; color: var(--mute); }
.btn-soft:disabled:hover { background: var(--ink-2); color: #f2f2f2; }
.icon-btn { flex: none; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--mute-2); transition: background-color .12s, color .12s; }
.icon-btn:hover { background: var(--ink-2); color: #fff; }
.icon-btn svg { width: 14px; height: 14px; }
.panel-f .icon-btn { width: 30px; height: 30px; }
.panel-f .icon-btn svg { width: 15px; height: 15px; }

/* popover (note editor) */
.pop { position: fixed; left: 0; top: 0; z-index: 10; width: 320px; max-width: calc(100vw - 24px); padding: 14px; border-radius: 20px; }
.pop-h { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; min-width: 0; }
.pop-t { flex: 1; min-width: 0; }
.pop-title { font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop-meta { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 1px; }
.pop-sub { flex: 1; min-width: 0; font-size: 11.5px; color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop-h .icon-btn { margin: -3px -4px 0 0; }
textarea { display: block; width: 100%; min-height: 112px; max-height: 240px; resize: vertical; margin: 0; padding: 9px 11px;
  border: 1px solid var(--ink-3); border-radius: 12px; background: var(--ink-2); color: #fff; caret-color: #fff;
  font: inherit; line-height: 1.45; outline: none; transition: border-color .12s, box-shadow .12s; }
textarea::placeholder { color: #8f8f8f; opacity: 1; } /* ≥ 4.5:1 on --ink-2 */
textarea:focus { border-color: #4a4a4a; box-shadow: 0 0 0 3px rgba(255, 255, 255, .07); }
textarea:focus-visible { outline: none; }
.pop-f { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
.pop-f .grow { flex: 1; }
.pop-f .btn-ghost { margin-left: -6px; }
.hint { font-size: 11px; color: #8f8f8f; } /* ≥ 4.5:1 on ink */
.pop-steal { margin: 8px 0 0; font-size: 11.5px; line-height: 1.4; color: #fcd34d; }
.reply { margin-bottom: 12px; padding: 10px 11px; border-radius: 12px; background: #121212; background: color-mix(in srgb, var(--c) 13%, #0b0b0b);
  border: 1px solid #2a2a2a; border: 1px solid color-mix(in srgb, var(--c) 42%, transparent); color: #ededed; font-size: 12.5px;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.reply-label { display: block; margin-bottom: 3px; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--c); }
.reply[data-s="needs-input"] .reply-label { color: #c4b5fd; }
.reply[data-s="sent"] .reply-label { color: #93c5fd; }
.reply[data-s="resolved"] .reply-label { color: #86efac; }
.reply textarea { min-height: 56px; margin-top: 9px; background: #0d0d0d; white-space: normal; }
.reply .answer-row { display: flex; justify-content: flex-end; margin-top: 9px; }
.reply .you { display: block; margin-top: 6px; color: var(--mute); }

/* notes panel: left of the dock, vertically centred on it */
.panel { position: fixed; z-index: 7; right: ${TAB_W + 12}px; top: 0; bottom: 0; margin: auto 0; height: fit-content;
  width: min(360px, calc(100vw - ${TAB_W + 24}px)); max-height: 70vh; display: flex; flex-direction: column; border-radius: 22px; }
.panel-h { display: flex; align-items: center; gap: 8px; padding: 14px 12px 8px 18px; }
.panel-h .ttl { font-weight: 600; flex: 1; color: #fff; }
.panel-h .ttl span { color: var(--mute); font-weight: 400; margin-left: 6px; font-variant-numeric: tabular-nums; }
.panel-list { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 8px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ink-3) transparent; }
.item { display: flex; gap: 11px; width: 100%; padding: 10px; border-radius: 14px; transition: background-color .12s; }
.item:hover { background: var(--ink-2); }
.item:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .7); }
.item .badge { margin-top: 1px; }
.item-b { flex: 1; min-width: 0; }
.item-meta { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--mute); min-width: 0; }
.item-meta .kind { display: inline-flex; margin-right: -3px; }
.item-meta .kind .si { width: 14px; height: 14px; }
.item-meta .kind svg.si-pin { filter: brightness(.53); }
.item-meta .intent { font-weight: 600; color: #fff; }
.path { margin-left: auto; padding: 1px 7px; border-radius: 6px; background: var(--ink-2); font: 500 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--mute); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-note { margin-top: 3px; color: #e8e8e8; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.item-note.empty { color: #8f8f8f; font-style: italic; }
.item-reply { margin-top: 4px; font-size: 12px; color: var(--mute); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.item-reply b { color: var(--c); font-weight: 600; }
.item-reply[data-s="needs-input"] b { color: #c4b5fd; }
.item-reply[data-s="sent"] b { color: #93c5fd; }
.item-reply[data-s="resolved"] b { color: #86efac; }
.panel-empty { padding: 18px 18px 24px; text-align: center; color: var(--mute); line-height: 1.9; }
.panel-f { display: flex; align-items: center; gap: 4px; padding: 10px 10px 12px; border-top: 1px solid var(--ink-2); white-space: nowrap; }
.panel-f .btn { padding: 0 11px; }
.panel-f .btn-ghost { padding: 0 9px; }
.panel-f .grow { flex: 1; }

/* toasts: left of the dock, near its bottom */
.toasts { position: fixed; z-index: 13; right: ${SIDE}px; bottom: calc(50% - ${TAB_H / 2}px); display: flex; flex-direction: column; align-items: flex-end;
  gap: 6px; pointer-events: none; }
.dp:not(.dock-open) .toasts { right: ${SIDE_CLOSED}px; bottom: calc(50% - ${DROP / 2}px); }
.dp.panel-open .toasts { right: calc(${TAB_W + 12}px + min(360px, 100vw - ${TAB_W + 24}px) + 10px); }
.dp.menu-open .toasts { right: ${SIDE + 236 + 10}px; }
.toast { height: 34px; padding: 0 15px 0 12px; border-radius: 17px; font-size: 12.5px; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
.toast svg { width: 14px; height: 14px; color: var(--green); }
.toast.err svg { color: #f87171; }

@media (max-width: 720px) {
  .dp.panel-open .toasts, .dp.menu-open .toasts { right: 50%; bottom: auto; top: 16px; transform: translateX(50%); align-items: center; }
}
@media (prefers-reduced-motion: reduce) {
  .pin, .region, .stroke-region, .hl, .tgt, .marquee, .si, .si > svg, .dk::before, .dk-pill, .dk-count,
  .mi, .mi svg, .btn, .item, .icon-btn, textarea, .mode-hint { animation: none !important; transition: none !important; }
}
`;
