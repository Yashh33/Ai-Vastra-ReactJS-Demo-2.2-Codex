import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import {
  attachDebugOverlay,
  debugLog,
  getDebugEvents,
  getDebugTileSummary,
  getDebugVersion,
  subscribeDebug
} from "../lib/debugLog";

// ?debug=1 diagnostics for the TV screen, where there is no console to look at.
// ScreenPage only mounts this when debug is on.

const UA_MAX_LENGTH = 110;
const AUTO_COLLAPSE_MS = 10_000;

const BUTTON_STYLE: CSSProperties = {
  // The box itself lets clicks through to the screen; only its buttons take them.
  pointerEvents: "auto",
  flexShrink: 0,
  font: "inherit",
  fontWeight: 700,
  color: "#000",
  background: "#7CFC9A",
  border: "none",
  borderRadius: 8,
  padding: "6px 14px",
  cursor: "pointer"
};

function describeBrowser() {
  const ua = navigator.userAgent;
  const chrome = /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua)?.[1];
  // Android WebViews mark themselves with "; wv)".
  const isWebView = /; wv\)/.test(ua);
  const browser = chrome ? `${isWebView ? "WebView" : "Chrome"} ${chrome}` : "Chrome version unknown";
  const shortUa = ua.length > UA_MAX_LENGTH ? `${ua.slice(0, UA_MAX_LENGTH)}...` : ua;
  return `${shortUa} | ${browser}`;
}

/** The hashed entry script name changes with every build, so it tells builds apart. */
function describeBuild() {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const name = script?.src.split("/").pop()?.split("?")[0];
  return name ? `build ${name}` : "build unknown";
}

async function clearAppCache() {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
}

export function ScreenDebugOverlay() {
  useSyncExternalStore(subscribeDebug, getDebugVersion);
  const [collapsed, setCollapsed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [serviceWorker, setServiceWorker] = useState(() => !!navigator.serviceWorker?.controller);
  const logRef = useRef<HTMLDivElement>(null);
  const events = getDebugEvents();

  useEffect(() => attachDebugOverlay(), []);

  // Open long enough to read the first results, then out of the way.
  useEffect(() => {
    const timer = window.setTimeout(() => setCollapsed(true), AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const container = navigator.serviceWorker;
    if (!container) return;
    const update = () => setServiceWorker(!!container.controller);
    container.addEventListener("controllerchange", update);
    return () => container.removeEventListener("controllerchange", update);
  }, []);

  // Keep the newest line in view (the log cannot be scrolled by hand: it lets clicks through).
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [events.length, collapsed]);

  async function handleClearCache() {
    setClearing(true);
    try {
      await clearAppCache();
    } catch (err) {
      debugLog(`clear cache FAIL ${err instanceof Error ? err.message : String(err)}`);
      setClearing(false);
      return;
    }
    window.location.reload();
  }

  const toggle = (
    <button type="button" style={BUTTON_STYLE} onClick={() => setCollapsed((prev) => !prev)}>
      {collapsed ? "▾ debug" : "▴ debug"}
    </button>
  );

  if (collapsed) {
    return (
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          zIndex: 2147483647,
          padding: 6,
          pointerEvents: "none",
          font: "clamp(14px, 1.5vw, 24px)/1.4 ui-monospace, Menlo, Consolas, monospace"
        }}
      >
        {toggle}
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2147483647,
        maxHeight: "30vh",
        display: "flex",
        flexDirection: "column",
        pointerEvents: "none",
        background: "rgba(0, 0, 0, 0.82)",
        color: "#7CFC9A",
        font: "clamp(14px, 1.5vw, 24px)/1.4 ui-monospace, Menlo, Consolas, monospace",
        wordBreak: "break-word"
      }}
    >
      <div style={{ flexShrink: 0, padding: "8px 12px", borderBottom: "1px solid rgba(124, 252, 154, 0.35)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          {toggle}
          <div style={{ flex: 1, minWidth: 0 }}>
            {describeBrowser()} | {serviceWorker ? "SW: yes" : "SW: no"} | {describeBuild()}
          </div>
          <button
            type="button"
            disabled={clearing}
            onClick={() => void handleClearCache()}
            style={{ ...BUTTON_STYLE, cursor: clearing ? "default" : "pointer", opacity: clearing ? 0.6 : 1 }}
          >
            {clearing ? "Clearing..." : "Clear app cache"}
          </button>
        </div>
        <div style={{ color: "#FFE08A" }}>{getDebugTileSummary()}</div>
      </div>
      <div ref={logRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "6px 12px", whiteSpace: "pre-wrap" }}>
        {events.join("\n")}
      </div>
    </div>
  );
}
