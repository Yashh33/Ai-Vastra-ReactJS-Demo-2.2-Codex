import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";

import {
  IDENTITY_UNIFORMS,
  NEUTRAL_ADJUSTMENTS,
  compileAdjustments,
  createPreviewRenderer,
  exportAdjusted,
  hueFromSrgb,
  isNeutralStats,
  isWebGLAvailable,
  measureMaskedColor,
  shadeTrackColors,
  type AdjustRenderer,
  type AdjustUniforms,
  type Adjustments,
  type MaskStats,
  type RenderView,
  type ShadeHue
} from "../lib/colorStudio/adjust";
import { SelectionEngine } from "../lib/colorStudio/engine";
import {
  decodeMask,
  encodeMask,
  stampDisc,
  strokeSegment,
  unionRect,
  type Rect
} from "../lib/colorStudio/selection";
import "./ColorStudio.css";

export type ColorStudioProps = {
  /** Image to correct: a picked File or a URL. */
  source: File | string;
  /** Receives the corrected full-resolution JPEG. */
  onSave: (blob: Blob) => void;
  onCancel: () => void;
};

type Mode = "whole" | "select";
type Tool = "brush" | "eraser" | "tap";
type AdjustKey = keyof Adjustments;

const PREVIEW_MAX_EDGE = 1280;
// Without WebGL every slider move is a full CPU pass, so work on a smaller preview.
const CPU_PREVIEW_MAX_EDGE = 720;
const MAX_UNDO = 20;
const REFINE_DEBOUNCE_MS = 150;
const MEASURE_DEBOUNCE_MS = 200;
const BLOWN_OUT_WARNING = 0.25;
// Brush radius as a share of the preview's longest edge: small / medium / large.
const BRUSH_FRACTIONS = [0.012, 0.03, 0.065] as const;
const BRUSH_LABELS = ["Small", "Medium", "Large"] as const;
// Fit-to-edges may grow ~12px past the paint at full preview size.
const REFINE_MARGIN_FRACTION = 12 / PREVIEW_MAX_EDGE;

// Direction dots for near-neutral fabrics: cream, pink, sky blue, mint, lilac, grey.
const PASTELS: { css: string; hue: ShadeHue }[] = [
  [243, 230, 196],
  [244, 198, 208],
  [191, 221, 243],
  [197, 234, 211],
  [217, 200, 238],
  [201, 201, 204]
].map(([r, g, b], index) => ({
  css: `rgb(${r}, ${g}, ${b})`,
  hue: index === 5 ? { a: 0, b: 0 } : hueFromSrgb(r!, g!, b!)
}));

const SLIDERS: { key: Exclude<AdjustKey, "shade">; label: string; left: string; right: string }[] = [
  { key: "temperature", label: "Temperature", left: "Cooler", right: "Warmer" },
  { key: "tint", label: "Tint", left: "Greener", right: "Pinker" },
  { key: "exposure", label: "Exposure", left: "Darker", right: "Brighter" },
  { key: "saturation", label: "Saturation", left: "Duller", right: "Stronger" }
];

type Session = {
  image: HTMLImageElement;
  release: () => void;
  width: number;
  height: number;
  /** Preview size; all live work happens at this resolution. */
  pw: number;
  ph: number;
  rgba: Uint8ClampedArray;
  mask: Uint8Array;
  renderer: AdjustRenderer;
  engine: SelectionEngine | null;
  undo: Uint32Array[];
  /** Bumped on every mask change; async results for an older version are dropped. */
  version: number;
  dirty: Rect | null;
  /** Mask as it was before the brush strokes that have not been fitted to edges yet. */
  pendingPre: Uint8Array | null;
  refineTimer: number;
  refining: Promise<void> | null;
  measureTimer: number;
  raf: number;
  stroke: { pointerId: number; x: number; y: number; radius: number; erase: boolean } | null;
  uniforms: AdjustUniforms;
  view: RenderView;
  disposed: boolean;
};

async function loadSource(source: File | string) {
  let blob: Blob | null = null;
  if (typeof source === "string") {
    // Going through fetch keeps the canvas readable for any URL that allows CORS.
    try {
      const response = await fetch(source);
      if (response.ok) blob = await response.blob();
    } catch {
      blob = null;
    }
  } else {
    blob = source;
  }

  const url = blob ? URL.createObjectURL(blob) : (source as string);
  const image = new Image();
  if (!blob) image.crossOrigin = "anonymous";
  image.decoding = "async";
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This image could not be opened"));
      image.src = url;
    });
  } catch (err) {
    if (blob) URL.revokeObjectURL(url);
    throw err;
  }
  return {
    image,
    release: () => {
      if (blob) URL.revokeObjectURL(url);
    }
  };
}

// An <img> is drawn with its EXIF orientation applied (the default in every
// current browser), so both the preview and the export come out upright.
function drawPreview(image: HTMLImageElement, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

function toUnit(values: Adjustments): Adjustments {
  return {
    temperature: values.temperature / 100,
    tint: values.tint / 100,
    exposure: values.exposure / 100,
    saturation: values.saturation / 100,
    shade: values.shade / 100
  };
}

function formatValue(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

type AdjustSliderProps = {
  label: string;
  left: string;
  right: string;
  value: number;
  disabled?: boolean;
  trackStyle?: CSSProperties;
  onChange: (value: number) => void;
};

function AdjustSlider({ label, left, right, value, disabled, trackStyle, onChange }: AdjustSliderProps) {
  return (
    <div className={`cs-slider${disabled ? " is-disabled" : ""}`}>
      <div className="cs-slider-head">
        <span>{label}</span>
        <button
          type="button"
          className="cs-slider-value"
          onClick={() => onChange(0)}
          disabled={disabled || value === 0}
          aria-label={`Reset ${label}`}
        >
          {formatValue(value)}
        </button>
      </div>
      <div className="cs-slider-track" style={trackStyle}>
        <span className="cs-slider-tick" aria-hidden />
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      <div className="cs-slider-ends" aria-hidden>
        <span>{left}</span>
        <span>Original</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

export function ColorStudio({ source, onSave, onCancel }: ColorStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [aspect, setAspect] = useState(1);
  const [rendererKind, setRendererKind] = useState<"webgl" | "cpu">("webgl");

  const [mode, setMode] = useState<Mode>("whole");
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(1);
  const [tolerance, setTolerance] = useState(18);
  const [fitEdges, setFitEdges] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [overlayOn, setOverlayOn] = useState(true);
  const [busy, setBusy] = useState(0);

  const [adjustments, setAdjustments] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [pastel, setPastel] = useState<number | null>(null);
  const [stats, setStats] = useState<MaskStats | null>(null);
  const [comparing, setComparing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Latest tool settings for pointer handlers and timers, which outlive a render.
  const live = useRef({ mode, tool, brushSize, tolerance, fitEdges });
  live.current = { mode, tool, brushSize, tolerance, fitEdges };

  /* ----- rendering ----- */

  const requestRender = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.raf) return;
    session.raf = requestAnimationFrame(() => {
      session.raf = 0;
      if (session.disposed) return;
      if (session.dirty) {
        session.renderer.updateMask(session.mask, session.dirty);
        session.dirty = null;
      }
      session.renderer.render(session.uniforms, session.view);
    });
  }, []);

  const measureNow = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.disposed) return;
    window.clearTimeout(session.measureTimer);
    session.measureTimer = 0;
    setStats(
      measureMaskedColor(
        session.rgba,
        session.pw,
        session.ph,
        live.current.mode === "whole" ? null : session.mask
      )
    );
  }, []);

  const maskChanged = useCallback(
    (rect: Rect | null) => {
      const session = sessionRef.current;
      if (!session) return;
      session.version += 1;
      session.dirty = unionRect(session.dirty, rect);
      requestRender();
      window.clearTimeout(session.measureTimer);
      session.measureTimer = window.setTimeout(measureNow, MEASURE_DEBOUNCE_MS);
    },
    [measureNow, requestRender]
  );

  /* ----- load ----- */

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorText(null);
    setMode("whole");
    setAdjustments(NEUTRAL_ADJUSTMENTS);
    setPastel(null);
    setStats(null);
    setCanUndo(false);

    void (async () => {
      try {
        const loaded = await loadSource(source);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) {
          loaded.release();
          return;
        }

        const preview = drawPreview(loaded.image, isWebGLAvailable() ? PREVIEW_MAX_EDGE : CPU_PREVIEW_MAX_EDGE);
        const pw = preview.canvas.width;
        const ph = preview.canvas.height;
        const mask = new Uint8Array(pw * ph);
        const renderer = createPreviewRenderer(canvas);
        renderer.setImage(preview.canvas);
        renderer.setMask(mask, pw, ph);

        sessionRef.current = {
          image: loaded.image,
          release: loaded.release,
          width: loaded.image.naturalWidth,
          height: loaded.image.naturalHeight,
          pw,
          ph,
          rgba: preview.pixels,
          mask,
          renderer,
          engine: null,
          undo: [],
          version: 0,
          dirty: null,
          pendingPre: null,
          refineTimer: 0,
          refining: null,
          measureTimer: 0,
          raf: 0,
          stroke: null,
          uniforms: IDENTITY_UNIFORMS,
          view: { whole: true, overlay: 0, original: false },
          disposed: false
        };
        setAspect(pw / ph);
        setRendererKind(renderer.kind);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorText(err instanceof Error ? err.message : "This image could not be opened");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      session.disposed = true;
      cancelAnimationFrame(session.raf);
      window.clearTimeout(session.refineTimer);
      window.clearTimeout(session.measureTimer);
      session.renderer.dispose();
      session.engine?.dispose();
      session.release();
    };
  }, [source]);

  /* ----- derived adjustment state ----- */

  const neutral = isNeutralStats(stats);
  const pickedHue = neutral && pastel !== null ? PASTELS[pastel]?.hue ?? null : null;
  const hasSelection = mode === "whole" || (stats?.coverage ?? 0) > 0;
  const shadeNeedsPick = neutral && pastel === null;

  const uniforms = useMemo(
    () => compileAdjustments(toUnit(adjustments), stats, pickedHue),
    [adjustments, stats, pickedHue]
  );
  const shadeTrack = useMemo(() => shadeTrackColors(stats, pickedHue), [stats, pickedHue]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || status !== "ready") return;
    session.uniforms = uniforms;
    session.view = {
      whole: mode === "whole",
      overlay: mode === "select" && overlayOn ? 1 : 0,
      original: comparing
    };
    requestRender();
  }, [uniforms, mode, overlayOn, comparing, status, requestRender]);

  useEffect(() => {
    if (status === "ready") measureNow();
  }, [mode, status, measureNow]);

  useEffect(() => {
    // The first switch to Select starts the worker and its Lab conversion.
    const session = sessionRef.current;
    if (status !== "ready" || mode !== "select" || !session || session.engine) return;
    session.engine = new SelectionEngine(session.rgba, session.pw, session.ph);
  }, [mode, status]);

  /* ----- selection actions ----- */

  const pushUndo = useCallback((session: Session) => {
    session.undo.push(encodeMask(session.mask));
    if (session.undo.length > MAX_UNDO) session.undo.shift();
    setCanUndo(true);
  }, []);

  const runRefine = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    if (!session) return Promise.resolve();
    window.clearTimeout(session.refineTimer);
    session.refineTimer = 0;
    const pre = session.pendingPre;
    const engine = session.engine;
    if (!pre || !engine) return Promise.resolve();

    const version = session.version;
    const longest = Math.max(session.pw, session.ph);
    const margin = Math.max(4, Math.round(longest * REFINE_MARGIN_FRACTION));
    const inset = (BRUSH_FRACTIONS[live.current.brushSize] ?? BRUSH_FRACTIONS[1]) * longest * 0.6;

    setBusy((count) => count + 1);
    const task = engine
      .refine(pre, session.mask, margin, inset)
      .then((result) => {
        // The user painted again in the meantime: this result is stale. The next
        // stroke end refines against the same `pre`, so nothing is lost.
        if (session.disposed || session.version !== version) return;
        session.pendingPre = null;
        if (!result.rect) return;
        session.mask.set(result.mask);
        maskChanged(result.rect);
      })
      .catch(() => {
        session.pendingPre = null;
      })
      .finally(() => {
        if (session.refining === task) session.refining = null;
        setBusy((count) => count - 1);
      });
    session.refining = task;
    return task;
  }, [maskChanged]);

  const runTap = useCallback(
    (x: number, y: number) => {
      const session = sessionRef.current;
      if (!session?.engine) return;
      window.clearTimeout(session.refineTimer);
      session.refineTimer = 0;
      const version = session.version;

      setBusy((count) => count + 1);
      session.engine
        .tap(session.mask, x, y, live.current.tolerance)
        .then((result) => {
          if (session.disposed || session.version !== version || !result.rect) return;
          pushUndo(session);
          session.pendingPre = null;
          session.mask.set(result.mask);
          maskChanged(result.rect);
        })
        .catch(() => undefined)
        .finally(() => setBusy((count) => count - 1));
    },
    [maskChanged, pushUndo]
  );

  const handleUndo = () => {
    const session = sessionRef.current;
    const snapshot = session?.undo.pop();
    if (!session || !snapshot) return;
    window.clearTimeout(session.refineTimer);
    session.refineTimer = 0;
    session.pendingPre = null;
    decodeMask(snapshot, session.mask);
    maskChanged({ x0: 0, y0: 0, x1: session.pw, y1: session.ph });
    setCanUndo(session.undo.length > 0);
    setOverlayOn(true);
  };

  const handleClear = () => {
    const session = sessionRef.current;
    if (!session) return;
    window.clearTimeout(session.refineTimer);
    session.refineTimer = 0;
    session.pendingPre = null;
    pushUndo(session);
    session.mask.fill(0);
    maskChanged({ x0: 0, y0: 0, x1: session.pw, y1: session.ph });
    setOverlayOn(true);
  };

  const handleFitToggle = (next: boolean) => {
    setFitEdges(next);
    const session = sessionRef.current;
    if (!session || next) return;
    window.clearTimeout(session.refineTimer);
    session.refineTimer = 0;
    session.pendingPre = null;
  };

  /* ----- pointer painting ----- */

  const brushRadius = (session: Session) =>
    Math.max(3, (BRUSH_FRACTIONS[live.current.brushSize] ?? BRUSH_FRACTIONS[1]) * Math.max(session.pw, session.ph));

  const moveRing = (event: ReactPointerEvent<HTMLCanvasElement>, session: Session, visible: boolean) => {
    const ring = ringRef.current;
    if (!ring) return;
    if (!visible || live.current.mode !== "select" || live.current.tool === "tap") {
      ring.style.opacity = "0";
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const diameter = (brushRadius(session) * 2 * bounds.width) / session.pw;
    ring.style.opacity = "1";
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    ring.style.transform = `translate(${event.clientX - bounds.left - diameter / 2}px, ${
      event.clientY - bounds.top - diameter / 2
    }px)`;
  };

  const toImagePoint = (
    event: { clientX: number; clientY: number },
    canvas: HTMLCanvasElement,
    session: Session
  ) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * session.pw,
      y: ((event.clientY - bounds.top) / bounds.height) * session.ph
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = sessionRef.current;
    if (!session || mode !== "select" || saving || session.stroke) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    setOverlayOn(true);

    const point = toImagePoint(event, event.currentTarget, session);
    if (tool === "tap") {
      runTap(point.x, point.y);
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety (keeps the stroke alive off-canvas); painting works without it.
    }
    window.clearTimeout(session.refineTimer);
    session.refineTimer = 0;
    pushUndo(session);

    const erase = tool === "eraser";
    if (!erase && fitEdges && !session.pendingPre) session.pendingPre = session.mask.slice();
    const radius = brushRadius(session);
    session.stroke = { pointerId: event.pointerId, x: point.x, y: point.y, radius, erase };
    maskChanged(stampDisc(session.mask, session.pw, session.ph, point.x, point.y, radius, erase));
    moveRing(event, session, true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = sessionRef.current;
    if (!session) return;
    moveRing(event, session, true);
    const stroke = session.stroke;
    if (!stroke || stroke.pointerId !== event.pointerId) return;

    // Coalesced events give the full finger path between frames on fast swipes.
    const native = event.nativeEvent;
    const points = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    let rect: Rect | null = null;
    for (const sample of points.length > 0 ? points : [native]) {
      const point = toImagePoint(sample, event.currentTarget, session);
      rect = unionRect(
        rect,
        strokeSegment(
          session.mask,
          session.pw,
          session.ph,
          stroke.x,
          stroke.y,
          point.x,
          point.y,
          stroke.radius,
          stroke.erase
        )
      );
      stroke.x = point.x;
      stroke.y = point.y;
    }
    if (rect) maskChanged(rect);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = sessionRef.current;
    if (!session) return;
    if (event.pointerType !== "mouse" || event.type === "pointerleave") moveRing(event, session, false);
    const stroke = session.stroke;
    if (!stroke || stroke.pointerId !== event.pointerId || event.type === "pointerleave") return;
    session.stroke = null;
    if (!stroke.erase && live.current.fitEdges && session.pendingPre) {
      session.refineTimer = window.setTimeout(() => void runRefine(), REFINE_DEBOUNCE_MS);
    }
  };

  /* ----- adjustments ----- */

  const setAdjustment = (key: AdjustKey, value: number) => {
    setAdjustments((current) => ({ ...current, [key]: value }));
    // Get the gold overlay out of the way so the colour change is visible.
    setOverlayOn(false);
  };

  const handleReset = () => {
    setAdjustments(NEUTRAL_ADJUSTMENTS);
    setPastel(null);
  };

  const handleSave = async () => {
    const session = sessionRef.current;
    if (!session || saving) return;
    setSaving(true);
    setErrorText(null);
    try {
      // Let a pending fit-to-edges finish so the export matches what was painted.
      if (session.refineTimer) await runRefine();
      else if (session.refining) await session.refining;

      const whole = live.current.mode === "whole";
      const finalStats = measureMaskedColor(session.rgba, session.pw, session.ph, whole ? null : session.mask);
      const blob = await exportAdjusted({
        image: session.image,
        width: session.width,
        height: session.height,
        mask: whole ? null : { data: session.mask, width: session.pw, height: session.ph },
        uniforms: compileAdjustments(toUnit(adjustments), finalStats, pickedHue)
      });
      if (!session.disposed) onSave(blob);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Could not save the image");
    } finally {
      setSaving(false);
    }
  };

  const adjusted = uniforms.active;
  const ready = status === "ready";
  const stageStyle = { "--cs-aspect": String(aspect) } as CSSProperties;
  const compareHandlers = {
    onPointerDown: () => setComparing(true),
    onPointerUp: () => setComparing(false),
    onPointerLeave: () => setComparing(false),
    onPointerCancel: () => setComparing(false),
    onKeyDown: (event: { key: string }) => {
      if (event.key === " " || event.key === "Enter") setComparing(true);
    },
    onKeyUp: () => setComparing(false),
    onBlur: () => setComparing(false)
  };

  return (
    <div className="cs">
      <div className="cs-stage" style={stageStyle}>
        <div className="cs-canvas-wrap">
          <canvas
            ref={canvasRef}
            className={`cs-canvas${mode === "select" ? " is-selecting" : ""}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onPointerLeave={handlePointerEnd}
            onLostPointerCapture={handlePointerEnd}
          />
          <div ref={ringRef} className="cs-ring" aria-hidden />
          {comparing && <span className="cs-badge">Original</span>}
          {!comparing && busy > 0 && <span className="cs-badge">Fitting…</span>}
        </div>
        {status === "loading" && (
          <div className="cs-stage-cover">
            <div className="spinner" aria-label="Loading" />
          </div>
        )}
      </div>

      {errorText && <p className="error-text">{errorText}</p>}

      {status !== "error" && (
        <>
          <div className="cs-panel">
            <div className="cs-segment" role="tablist" aria-label="What to adjust">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "whole"}
                className={mode === "whole" ? "is-active" : ""}
                onClick={() => setMode("whole")}
                disabled={!ready}
              >
                Whole photo
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "select"}
                className={mode === "select" ? "is-active" : ""}
                onClick={() => {
                  setMode("select");
                  setOverlayOn(true);
                }}
                disabled={!ready}
              >
                Select garment
              </button>
            </div>

            {mode === "select" && (
              <>
                <div className="cs-tools">
                  {(["brush", "eraser", "tap"] as const).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`cs-tool${tool === name ? " is-active" : ""}`}
                      aria-pressed={tool === name}
                      onClick={() => {
                        setTool(name);
                        setOverlayOn(true);
                      }}
                    >
                      {name === "brush" ? "Brush" : name === "eraser" ? "Eraser" : "Tap"}
                    </button>
                  ))}
                  <button type="button" className="cs-tool" onClick={handleUndo} disabled={!canUndo}>
                    Undo
                  </button>
                  <button
                    type="button"
                    className="cs-tool"
                    onClick={handleClear}
                    disabled={(stats?.coverage ?? 0) === 0}
                  >
                    Clear
                  </button>
                </div>

                {tool === "tap" ? (
                  <label className="cs-option">
                    <span>Tolerance</span>
                    <input
                      type="range"
                      min={4}
                      max={45}
                      step={1}
                      value={tolerance}
                      onChange={(event) => setTolerance(Number(event.target.value))}
                    />
                    <span className="cs-option-value">{tolerance}</span>
                  </label>
                ) : (
                  <label className="cs-option">
                    <span>Brush size</span>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={1}
                      value={brushSize}
                      onChange={(event) => setBrushSize(Number(event.target.value))}
                    />
                    <span className="cs-option-value">{BRUSH_LABELS[brushSize]}</span>
                  </label>
                )}

                <label className="cs-check">
                  <input
                    type="checkbox"
                    checked={fitEdges}
                    onChange={(event) => handleFitToggle(event.target.checked)}
                  />
                  <span>Fit to edges after each brush stroke</span>
                </label>

                {!hasSelection && (
                  <p className="cs-hint">
                    {tool === "tap"
                      ? "Tap the garment to select everything of that colour."
                      : "Paint over the garment. The colour sliders only change what is gold."}
                  </p>
                )}
              </>
            )}
          </div>

          {hasSelection && stats && stats.blownFraction > BLOWN_OUT_WARNING && (
            <p className="cs-warning" role="status">
              Photo is too bright here – colour can be adjusted but detail is lost.
            </p>
          )}

          <div className="cs-panel">
            {SLIDERS.map((slider) => (
              <AdjustSlider
                key={slider.key}
                label={slider.label}
                left={slider.left}
                right={slider.right}
                value={adjustments[slider.key]}
                disabled={!ready}
                onChange={(value) => setAdjustment(slider.key, value)}
              />
            ))}

            <AdjustSlider
              label="Shade strength"
              left="Paler"
              right="Stronger"
              value={adjustments.shade}
              disabled={!ready || shadeNeedsPick}
              trackStyle={
                shadeTrack
                  ? ({ "--cs-track": `linear-gradient(90deg, ${shadeTrack[0]}, ${shadeTrack[1]})` } as CSSProperties)
                  : undefined
              }
              onChange={(value) => setAdjustment("shade", value)}
            />
            {neutral && ready && (
              <div className="cs-dots">
                <span className="cs-dots-label">This fabric is almost colourless. Pick the shade it should lean to:</span>
                <div className="cs-dots-row">
                  {PASTELS.map((entry, index) => (
                    <button
                      key={entry.css}
                      type="button"
                      className={`cs-dot${pastel === index ? " is-active" : ""}`}
                      style={{ background: entry.css }}
                      aria-label={`Shade option ${index + 1}`}
                      aria-pressed={pastel === index}
                      onClick={() => {
                        setPastel(index);
                        setOverlayOn(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <button type="button" className="btn-secondary cs-reset" onClick={handleReset} disabled={!adjusted}>
              Reset colour
            </button>
          </div>

          {rendererKind === "cpu" && ready && (
            <p className="cs-hint">This device has no WebGL, so the preview is smaller and slower.</p>
          )}
        </>
      )}

      <div className="cs-actions">
        {status !== "error" && (
          <button
            type="button"
            className="btn-secondary cs-compare"
            disabled={!ready || !adjusted}
            onContextMenu={(event) => event.preventDefault()}
            {...compareHandlers}
          >
            Hold: Before
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {status !== "error" && (
          <button type="button" className="btn-primary cs-save" onClick={() => void handleSave()} disabled={!ready || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}
