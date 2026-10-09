/** Pin mode: hit-testing under the capture layer and the hover highlight. */
import { semanticClasses } from "./selector";
import { nearestComponent } from "./source";
import { viewW } from "./util";

/** Topmost page element at a viewport point, ignoring the sumi host. html/body are valid results. */
export function elementAt(x: number, y: number, host: Element): Element | null {
  let list: Element[] = [];
  try {
    list = document.elementsFromPoint(x, y);
  } catch {
    list = [];
  }
  for (const el of list) {
    if (el === host || host.contains(el)) continue;
    return el;
  }
  return list.length ? document.documentElement : null;
}

export function tagLabel(tag: string, classes: string[]): string {
  return classes.length ? `${tag}.${classes[0]}` : tag;
}

export function describeElement(el: Element): { primary: string; secondary: string } {
  const tag = tagLabel(el.localName || el.tagName.toLowerCase(), semanticClasses(el, 1));
  const comp = nearestComponent(el);
  return comp ? { primary: comp, secondary: tag } : { primary: tag, secondary: "" };
}

export class Picker {
  current: Element | null = null;
  private desc = { primary: "", secondary: "" };

  constructor(
    private host: Element,
    private box: HTMLElement,
    private primary: HTMLElement,
    private secondary: HTMLElement,
    private size: HTMLElement
  ) {}

  move(x: number, y: number): void {
    const el = elementAt(x, y, this.host);
    if (el !== this.current) {
      this.current = el;
      this.desc = el ? describeElement(el) : { primary: "", secondary: "" };
      this.primary.textContent = this.desc.primary;
      this.secondary.textContent = this.desc.secondary;
      this.secondary.hidden = !this.desc.secondary;
    }
    this.draw();
  }

  draw(): void {
    const el = this.current;
    if (!el || !el.isConnected) {
      this.box.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    const vw = viewW();
    const vh = window.innerHeight;
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, vw);
    const bottom = Math.min(r.bottom, vh);
    this.box.hidden = false;
    this.box.style.left = `${left}px`;
    this.box.style.top = `${top}px`;
    this.box.style.width = `${Math.max(0, right - left)}px`;
    this.box.style.height = `${Math.max(0, bottom - top)}px`;
    this.size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    this.box.classList.toggle("below", top < 30);
    this.box.classList.toggle("inside", top < 30 && bottom > vh - 30);
    this.box.classList.toggle("flip-x", left > vw - 220);
  }

  clear(): void {
    this.current = null;
    this.box.hidden = true;
  }
}

/** While a mode is active the capture layer eats wheel events; forward them to inner scroll containers. */
export function forwardWheel(e: WheelEvent, host: Element): void {
  let dx = e.deltaX;
  let dy = e.deltaY;
  if (e.deltaMode === 1) {
    dx *= 16;
    dy *= 16;
  } else if (e.deltaMode === 2) {
    dx *= window.innerWidth;
    dy *= window.innerHeight;
  }
  let el = elementAt(e.clientX, e.clientY, host);
  while (el && el !== document.body && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    const canY =
      dy !== 0 &&
      /(auto|scroll|overlay)/.test(cs.overflowY) &&
      el.scrollHeight > el.clientHeight + 1 &&
      (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0);
    const canX =
      dx !== 0 &&
      /(auto|scroll|overlay)/.test(cs.overflowX) &&
      el.scrollWidth > el.clientWidth + 1 &&
      (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0);
    if (canY || canX) {
      e.preventDefault();
      el.scrollBy({ left: canX ? dx : 0, top: canY ? dy : 0 });
      return;
    }
    el = el.parentElement;
  }
  // Nothing inner to scroll: let the browser scroll the document natively.
}
