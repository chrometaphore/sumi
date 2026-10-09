/**
 * Sumi overlay entry. Injected into the reviewed page by the proxy as
 * <script src="/__sumi/overlay.js?k=<session key>" defer>. Mounts a <sumi-root> host with an
 * open shadow root on document.documentElement and boots the UI. Never throws into the page.
 *
 * `window.__sumi` exposes only `version` and `destroy()`. Debug hooks (`host`: the shadow host,
 * `app`: the SumiApp instance, for tests and harnesses) are added when `window.__SUMI_DEBUG__ === true`
 * before the overlay loads, or `sessionStorage["sumi:debug"] === "1"` (set it, then reload).
 */
import "./api"; // reads the session key from our own <script> tag while it is still current
import { SumiApp } from "./ui";
import { warn } from "./util";

/** The host's own styles, set through CSSOM (a page CSP that blocks inline style attributes allows this). */
const HOST_STYLE: Array<[string, string]> = [
  ["all", "initial"],
  ["display", "block"],
  ["position", "fixed"],
  ["top", "0"],
  ["left", "0"],
  ["right", "auto"],
  ["bottom", "auto"],
  ["width", "0"],
  ["height", "0"],
  ["margin", "0"],
  ["padding", "0"],
  ["border", "0"],
  ["background", "none"],
  ["overflow", "visible"],
  ["z-index", "2147483647"],
  ["pointer-events", "auto"],
  ["visibility", "visible"],
  ["opacity", "1"],
  ["transform", "none"],
  ["filter", "none"],
  ["contain", "style"],
];

function debugHooks(): boolean {
  try {
    if ((window as any).__SUMI_DEBUG__ === true) return true;
  } catch {
    /* ignore */
  }
  try {
    return window.sessionStorage.getItem("sumi:debug") === "1";
  } catch {
    return false;
  }
}

function boot(): void {
  const w = window as any;
  if (w.__sumi) return;
  try {
    if (window.top !== window.self) return; // one overlay per tab, not per iframe
  } catch {
    return; // cross-origin frame
  }
  const host = document.createElement("sumi-root");
  for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
  host.setAttribute("data-sumi", "");
  const shadow = host.attachShadow({ mode: "open" });
  const app = new SumiApp(host, shadow);
  const api: Record<string, unknown> = {
    version: __SUMI_VERSION__,
    destroy: () => app.destroy(),
  };
  if (debugHooks()) {
    api.host = host;
    api.app = app;
  }
  w.__sumi = api;
  document.documentElement.appendChild(host);
  app.start();
}

(function () {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if ((window as any).__sumi) return;
    if (document.documentElement) boot();
    else document.addEventListener("DOMContentLoaded", () => {
      try {
        boot();
      } catch (e) {
        warn(e);
      }
    });
  } catch (e) {
    warn(e);
  }
})();
