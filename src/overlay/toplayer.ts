/**
 * Keep the overlay usable above the page's top layer.
 *
 * z-index cannot lift anything above a modal <dialog> or a fullscreen element: they live in the
 * browser's top layer, and a modal dialog also makes everything outside it inert. While one is up,
 * the host moves into the topmost modal dialog (so it is not inert) or the fullscreen element (Chromium
 * shows nothing outside it) and, where the Popover API
 * exists (Chrome 114+, Safari 17+), enters the top layer itself as a manual popover, re-shown after
 * every top-layer change so it stays above the newest entry. Once nothing is up it returns to
 * <html> and leaves the top layer, so ordinary pages never see a popover.
 * Never throws.
 */
import { safe, warn } from "./util";

const HOLDS_CHILDREN_NOT = new Set(["video", "canvas", "img", "iframe", "embed", "object", "audio", "input", "textarea", "select"]);

export class TopLayer {
  /** Modal dialogs in the order they opened (last = topmost). */
  private order: Element[] = [];
  private popover = false;
  private undoBackdrop: (() => void) | null = null;
  private readonly canPopover: boolean;
  /** The parent we chose for the host (null = the document root). */
  parent: Element | null = null;

  constructor(private host: HTMLElement, private shadow: ShadowRoot) {
    this.canPopover = safe(
      () => typeof (host as any).showPopover === "function" && typeof (host as any).hidePopover === "function",
      false
    );
  }

  /** Is the host in the top layer right now (a modal dialog or fullscreen element is up)? */
  get active(): boolean {
    return this.popover;
  }

  /** Something may have entered or left the top layer: put the host where it belongs. */
  sync(reshow = true): void {
    try {
      const modal = this.topModal();
      const fs = fullscreenElement();
      let parent: Element = document.documentElement;
      if (modal) parent = modal;
      // Chromium renders and hit-tests only the fullscreen element's subtree: join it (a <video> can't
      // hold us; then the overlay simply waits until fullscreen ends).
      else if (fs && !HOLDS_CHILDREN_NOT.has(fs.localName)) parent = fs;
      this.parent = parent === document.documentElement ? null : parent;
      const focused = this.shadow.activeElement as HTMLElement | null;
      let moved = false;
      if (this.host.parentNode !== parent) {
        moveInto(parent, this.host);
        moved = true;
      }
      const need = !!modal || !!fs;
      if (this.canPopover) {
        if (need) this.show(reshow || moved);
        else this.hide();
      }
      // Moving a node (or re-showing a popover) drops focus inside it: put it back.
      if (focused && focused.isConnected && this.shadow.activeElement !== focused) {
        safe(() => focused.focus({ preventScroll: true }), undefined);
      }
    } catch (e) {
      warn(e);
    }
  }

  /** Did these mutations touch a <dialog> (opened, closed, added or removed)? */
  static touchesDialogs(records: MutationRecord[]): boolean {
    for (const r of records) {
      if (r.type === "attributes") {
        if (r.attributeName === "open" && (r.target as Element).localName === "dialog") return true;
        continue;
      }
      if (r.type !== "childList") continue;
      for (const list of [r.addedNodes, r.removedNodes]) {
        for (let i = 0; i < list.length; i++) {
          const n = list[i] as Element;
          if (n.nodeType !== 1 || n.localName === "sumi-root") continue;
          if (n.localName === "dialog" || (typeof n.querySelector === "function" && n.firstElementChild && n.querySelector("dialog[open]"))) return true;
        }
      }
    }
    return false;
  }

  /** Back to <html>, out of the top layer (teardown). */
  release(): void {
    this.hide();
    this.order = [];
    this.parent = null;
  }

  private topModal(): Element | null {
    let now: Element[];
    try {
      now = Array.from(document.querySelectorAll("dialog:modal"));
    } catch {
      return null; // no :modal support (old engines): nothing we can detect
    }
    this.order = this.order.filter((d) => now.includes(d));
    for (const d of now) if (!this.order.includes(d)) this.order.push(d);
    return this.order.length ? this.order[this.order.length - 1] : null;
  }

  private show(reshow: boolean): void {
    const h = this.host as any;
    try {
      if (!this.popover) {
        this.popover = true;
        this.host.setAttribute("popover", "manual");
        this.addBackdropGuard();
      }
      const open = safe(() => this.host.matches(":popover-open"), false);
      if (open && !reshow) return;
      if (open) h.hidePopover();
      h.showPopover(); // appended to the top of the top layer: above whatever just entered it
    } catch (e) {
      warn(e);
    }
  }

  private hide(): void {
    if (!this.popover) return;
    this.popover = false;
    try {
      if (safe(() => this.host.matches(":popover-open"), false)) (this.host as any).hidePopover();
    } catch {
      /* ignore */
    }
    this.host.removeAttribute("popover");
    this.undoBackdrop?.();
    this.undoBackdrop = null;
  }

  /** A page rule like `::backdrop { background: … }` must not dim the page behind our (invisible) host. */
  private addBackdropGuard(): void {
    try {
      const d = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
      if (!Array.isArray(d.adoptedStyleSheets) || typeof (CSSStyleSheet.prototype as any).replaceSync !== "function") return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("sumi-root[data-sumi]::backdrop { display: none !important; background: none !important; }");
      d.adoptedStyleSheets = [...d.adoptedStyleSheets, sheet];
      this.undoBackdrop = () => {
        try {
          d.adoptedStyleSheets = (d.adoptedStyleSheets || []).filter((s) => s !== sheet);
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* best effort */
    }
  }
}

function fullscreenElement(): Element | null {
  return safe(() => document.fullscreenElement || (document as any).webkitFullscreenElement || null, null);
}

/** Re-parent keeping state where the browser can (Node.moveBefore keeps focus and animations). */
function moveInto(parent: Element, node: Element): void {
  const p = parent as Element & { moveBefore?: (n: Node, ref: Node | null) => void };
  if (typeof p.moveBefore === "function" && node.isConnected && parent.isConnected) {
    try {
      p.moveBefore(node, null);
      return;
    } catch {
      /* fall back to a plain move */
    }
  }
  parent.appendChild(node);
}
