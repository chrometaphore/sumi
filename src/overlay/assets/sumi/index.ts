/**
 * Sumi UI icons, exported unmodified from the Sumi design file and bundled as markup (scripts/build.mjs
 * loads .svg as text). icons.ts parses them into inline SVG, so a page CSP with a strict `img-src`
 * cannot block them; state colours come from CSS filters rather than edits to the files. Intrinsic
 * sizes are noted per asset. corner-top/bottom.svg are the fillet geometry the dock draws in code
 * (ink.ts `dockOutline`); they are kept as the design reference and not bundled.
 */
import brush from "./brush.svg"; // 20×20, stroke #999
import close from "./close.svg"; // 20×20, stroke #BBB
import drop from "./drop.svg"; // 24×24, filled white ink drop (closed-state icon)
import loader from "./loader.svg"; // 24×24, white open arc, stroke 2 (loading-state icon, rotate it)
import marquee from "./marquee.svg"; // 20×20, stroke #999
import more from "./more.svg"; // 20×20, #BBB dots
import pin from "./pin.svg"; // 25.3333×30.3333, white + baked drop-shadow; sits in a 20×20 slot at inset -25.83% -13.33%
import send from "./send.svg"; // 20×20, stroke #333; displayed mirrored horizontally (rotate(180) + scaleY(-1))

export const SUMI_ICONS = { brush, close, drop, loader, marquee, more, pin, send } as const;
