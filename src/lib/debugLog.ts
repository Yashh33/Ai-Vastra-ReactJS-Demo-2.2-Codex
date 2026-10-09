// On-device debug strip for the photo pickers: open any page with ?debug=1 and the
// last few picker / upload events show in a box at the bottom of the screen.
// Needed because an iPhone has no console to look at.

const MAX_EVENTS = 10;
const STORAGE_KEY = "debugStrip";

const events: string[] = [];
let strip: HTMLElement | null = null;

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
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  console.log(`[debug] ${message}`);
  try {
    render();
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
