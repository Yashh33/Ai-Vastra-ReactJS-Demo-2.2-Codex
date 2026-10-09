// On-device debug strip for the photo pickers: open any page with ?debug=1 and the
// last few picker / upload events show in a box at the bottom of the screen.
// Needed because an iPhone has no console to look at.

const MAX_EVENTS = 10;
// The TV diagnostics overlay scrolls, so it keeps a much longer history than the strip.
const OVERLAY_MAX_EVENTS = 400;
const STORAGE_KEY = "debugStrip";

const events: string[] = [];
let strip: HTMLElement | null = null;
// True while a page shows the events itself (the TV overlay) instead of the strip.
let overlayAttached = false;
let version = 0;
const listeners = new Set<() => void>();

type TileState = "loading" | "loaded" | "fallback" | "failed";
const tileStates = new Map<string, TileState>();
let lastTileLoadedMs: number | null = null;

function readEnabled() {
  if (typeof window === "undefined") return false;
  try {
    // Remembered for the tab, since in-app navigation drops the query string.
    if (new URLSearchParams(window.location.search).get("debug") === "1") {
      window.sessionStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    return window.sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return /[?&]debug=1(&|$)/.test(window.location.search);
  }
}

const enabled = readEnabled();

function notify() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function isDebugEnabled() {
  return enabled;
}

/** For useSyncExternalStore: the snapshot is a counter that changes whenever anything is logged. */
export function subscribeDebug(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDebugVersion() {
  return version;
}

export function getDebugEvents(): readonly string[] {
  return events;
}

/** A page that renders the events itself calls this; the small strip steps aside. Returns the undo. */
export function attachDebugOverlay() {
  overlayAttached = true;
  strip?.remove();
  strip = null;
  return () => {
    overlayAttached = false;
  };
}

/** Records where a Browse grid tile's image has got to, for the overlay's summary line. */
export function debugTileState(label: string, state: TileState) {
  if (!enabled) return;
  tileStates.set(label, state);
  // performance.now() counts from when the page was opened.
  if (state === "loaded" || state === "fallback") lastTileLoadedMs = performance.now();
  notify();
}

/** Call when the grid shows a different set of looks. */
export function debugResetTiles() {
  if (!enabled) return;
  tileStates.clear();
  notify();
}

export function getDebugTileSummary() {
  let loaded = 0;
  let failed = 0;
  let fallback = 0;
  tileStates.forEach((state) => {
    if (state === "loaded") loaded += 1;
    else if (state === "fallback") fallback += 1;
    else if (state === "failed") failed += 1;
  });
  const lastLoaded = lastTileLoadedMs === null ? "-" : `${(lastTileLoadedMs / 1000).toFixed(1)}s`;
  return (
    `tiles ${tileStates.size} | loaded ${loaded + fallback} | failed ${failed} | using fallback ${fallback}` +
    ` | page open -> last tile loaded ${lastLoaded}`
  );
}

/**
 * What the browser exposes about an image it has just loaded: "123KB", "via SW"
 * (the request went through a service worker), both, or "" when neither is known.
 */
export function debugImageInfo(url: string) {
  if (!enabled) return "";
  try {
    const entries = performance.getEntriesByName(url);
    const entry = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
    if (!entry) return "";
    const bytes = entry.transferSize || entry.encodedBodySize;
    const parts: string[] = [];
    if (bytes > 0) parts.push(kb(bytes));
    if (entry.workerStart > 0) parts.push("via SW");
    return parts.join(" ");
  } catch {
    return "";
  }
}

function render() {
  if (!strip) {
    strip = document.createElement("div");
    strip.setAttribute("aria-hidden", "true");
    strip.style.cssText = [
      "position:fixed",
      "left:0",
      "right:0",
      "bottom:0",
      "z-index:2147483647",
      "max-height:40vh",
      "overflow:auto",
      "padding:6px 8px calc(6px + env(safe-area-inset-bottom))",
      "background:rgba(0,0,0,0.82)",
      "color:#7CFC9A",
      "font:11px/1.35 ui-monospace,Menlo,Consolas,monospace",
      "white-space:pre-wrap",
      "word-break:break-word",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(strip);
  }
  strip.textContent = events.join("\n");
}

function timestamp() {
  const now = new Date();
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

export function kb(bytes: number) {
  return `${Math.round(bytes / 1024)}KB`;
}

/** Adds one line to the debug strip. Does nothing unless the page was opened with ?debug=1. */
export function debugLog(message: string) {
  if (!enabled) return;
  events.push(`${timestamp()} ${message}`);
  const maxEvents = overlayAttached ? OVERLAY_MAX_EVENTS : MAX_EVENTS;
  if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  console.log(`[debug] ${message}`);
  try {
    if (!overlayAttached) render();
    notify();
  } catch {
    // The strip is a diagnostic aid; it must never break a photo pick.
  }
}

/** Call first thing in a file input's onChange. */
export function debugLogPicked(file: File | null | undefined) {
  if (!file) {
    debugLog("onChange fired (no file)");
    return;
  }
  debugLog(`onChange fired ${file.name || "(no name)"} ${file.type || "(no type)"} ${kb(file.size)}`);
}

if (enabled && typeof document !== "undefined") {
  const start = () => debugLog("debug strip on");
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
}
