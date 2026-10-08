import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../lib/auth";
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
import {
  GARMENT_PARTS,
  defaultPartForGarmentName,
  findGarmentPart,
  type GarmentPart
} from "../lib/colorStudio/garmentParts";
import {
  MaskDecoder,
  buildSegmentUpload,
  requestSegment,
  type SegmentPoint
} from "../lib/colorStudio/segment";
import "./ColorStudio.css";

export type ColorStudioProps = {
  /** Image to correct: a picked File / Blob, or a URL. */
  source: File | Blob | string;
  /** Stored look this image belongs to; lets the backend segment it by id. */
  generationId?: string;
  /** Garment type name, used to pre-select the part to colour. */
  garmentTypeName?: string;
  /**
   * Whether "Select only one part" is offered. Must be false for try-on results
   * and anything else showing the customer: those images never go to /segment.
   */
  allowSegment: boolean;
  /** Start with "Select only one part" ticked. */
  defaultSegment?: boolean;
  /** Receives the corrected full-resolution JPEG. The modal shows "Saving…" until this settles. */
  onSave: (blob: Blob) => void | Promise<void>;
  onClose: () => void;
};

type AdjustKey = keyof Adjustments;
type FixMode = "add" | "remove";

const PREVIEW_MAX_EDGE = 1280;
// Without WebGL every slider move is a full CPU pass, so work on a smaller preview.
const CPU_PREVIEW_MAX_EDGE = 720;
const BLOWN_OUT_WARNING = 0.25;

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
  /** Mask currently on screen (the active part's, or empty). */
  mask: Uint8Array;
  /** Cleaned masks by part key, so going back to a part costs nothing. */
  masks: Map<string, Uint8Array>;
  renderer: AdjustRenderer;
  decoder: MaskDecoder;
  /** JPEG data URL sent for "upload" segment requests; built once. */
  upload: string | null;
  raf: number;
  uniforms: AdjustUniforms;
  view: RenderView;
  disposed: boolean;
};

async function loadSource(source: File | Blob | string) {
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

export function ColorStudio({
  source,
  generationId,
  garmentTypeName,
  allowSegment,
  defaultSegment = false,
  onSave,
  onClose
}: ColorStudioProps) {
  const { accessToken } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [aspect, setAspect] = useState(1);
  const [rendererKind, setRendererKind] = useState<"webgl" | "cpu">("webgl");

  const [segmentOn, setSegmentOn] = useState(allowSegment && defaultSegment);
  const [activePartKey, setActivePartKey] = useState<string | null>(null);
  const [loadingPartKey, setLoadingPartKey] = useState<string | null>(null);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  /** Bumped whenever the on-screen mask changes, to re-measure it. */
  const [maskVersion, setMaskVersion] = useState(0);
  const [hasMask, setHasMask] = useState(false);
  const [fixMode, setFixMode] = useState<FixMode | null>(null);
  const [dotsByPart, setDotsByPart] = useState<Record<string, SegmentPoint[]>>({});
  const [overlayOn, setOverlayOn] = useState(true);

  const [adjustments, setAdjustments] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [pastel, setPastel] = useState<number | null>(null);
  const [stats, setStats] = useState<MaskStats | null>(null);
  const [comparing, setComparing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Read by async segment calls, which finish after later renders.
  const activePartRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  const autoRanRef = useRef(false);

  const activePart = findGarmentPart(activePartKey);
  const dots = (activePartKey ? dotsByPart[activePartKey] : undefined) ?? [];

  /* ----- rendering ----- */

  const requestRender = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.raf) return;
    session.raf = requestAnimationFrame(() => {
      session.raf = 0;
      if (session.disposed) return;
      session.renderer.render(session.uniforms, session.view);
    });
  }, []);

  /** Puts a part's mask (or nothing) on screen. */
  const showMask = useCallback(
    (mask: Uint8Array | null) => {
      const session = sessionRef.current;
      if (!session) return;
      if (mask) session.mask.set(mask);
      else session.mask.fill(0);
      session.renderer.setMask(session.mask, session.pw, session.ph);
      setHasMask(Boolean(mask));
      setMaskVersion((version) => version + 1);
      requestRender();
    },
    [requestRender]
  );

  /* ----- load ----- */

  useEffect(() => {
    let cancelled = false;

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
          masks: new Map(),
          renderer,
          decoder: new MaskDecoder(),
          upload: null,
          raf: 0,
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
      session.renderer.dispose();
      session.decoder.dispose();
      session.release();
    };
    // The studio is opened for one image; callers remount it for another.
  }, []);

  /* ----- part selection (SAM 3 via the backend) ----- */

  const runSegment = useCallback(
    async (part: GarmentPart, points: SegmentPoint[], useCache: boolean) => {
      const session = sessionRef.current;
      // allowSegment is the guard for the "no customer photos to /segment" rule.
      if (!session || !allowSegment) return;
      if (!accessToken) {
        setSegmentError("Please sign in again to select a part.");
        return;
      }

      const seq = ++requestSeqRef.current;
      setLoadingPartKey(part.key);
      setSegmentError(null);
      try {
        if (!generationId && !session.upload) session.upload = buildSegmentUpload(session.image);
        const response = await requestSegment(accessToken, {
          generationId,
          imageDataUrl: generationId ? undefined : session.upload ?? undefined,
          part,
          points,
          useCache
        });
        if (session.disposed) return;
        const decoded = await session.decoder.decode(response.mask_png_base64, session.pw, session.ph);
        if (session.disposed) return;

        // The request was paid for, so keep the result even if the user moved on.
        session.masks.set(part.key, decoded.mask);
        if (activePartRef.current !== part.key) return;
        showMask(decoded.mask);
        setOverlayOn(true);
        if (decoded.selected === 0) {
          setSegmentError(
            `Couldn't find ${part.label.toLowerCase()} in this photo. Try another part, or use Fix selection and tap on it.`
          );
        }
      } catch (err) {
        if (!session.disposed && activePartRef.current === part.key) {
          setSegmentError(err instanceof Error ? err.message : "Selection failed. Try again.");
        }
      } finally {
        if (requestSeqRef.current === seq) setLoadingPartKey(null);
      }
    },
    [accessToken, allowSegment, generationId, showMask]
  );

  const selectPart = useCallback(
    (part: GarmentPart) => {
      const session = sessionRef.current;
      if (!session) return;
      activePartRef.current = part.key;
      setActivePartKey(part.key);
      setSegmentError(null);
      setFixMode(null);
      setOverlayOn(true);

      const cached = session.masks.get(part.key);
      if (cached) {
        // Stop a request still in flight for another part from clearing the spinner state later.
        requestSeqRef.current += 1;
        setLoadingPartKey(null);
        showMask(cached);
        return;
      }
      showMask(null);
      void runSegment(part, [], true);
    },
    [runSegment, showMask]
  );

  // First time the box is ticked: select the part that matches the garment type.
  useEffect(() => {
    if (status !== "ready" || !segmentOn || autoRanRef.current) return;
    autoRanRef.current = true;
    const part = defaultPartForGarmentName(garmentTypeName);
    if (part) selectPart(part);
  }, [status, segmentOn, garmentTypeName, selectPart]);

  const handleCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!segmentOn || !fixMode || !activePartKey || saving) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const point: SegmentPoint = {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      label: fixMode === "add" ? 1 : 0
    };
    setDotsByPart((current) => ({ ...current, [activePartKey]: [...(current[activePartKey] ?? []), point] }));
    setOverlayOn(true);
  };

  const handleSelectAgain = () => {
    if (!activePart || dots.length === 0) return;
    void runSegment(activePart, dots, false);
  };

  const handleClearDots = () => {
    if (!activePartKey) return;
    setDotsByPart((current) => ({ ...current, [activePartKey]: [] }));
  };

  /* ----- derived adjustment state ----- */

  const whole = !segmentOn;
  const neutral = isNeutralStats(stats);
  const pickedHue = neutral && pastel !== null ? PASTELS[pastel]?.hue ?? null : null;
  const shadeNeedsPick = neutral && pastel === null;
  // In part mode with no mask yet the sliders would change nothing.
  const canAdjust = status === "ready" && (whole || hasMask);

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
      whole,
      overlay: !whole && (overlayOn || fixMode !== null) ? 1 : 0,
      original: comparing
    };
    requestRender();
  }, [uniforms, whole, overlayOn, fixMode, comparing, status, requestRender]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || status !== "ready") return;
    setStats(measureMaskedColor(session.rgba, session.pw, session.ph, whole ? null : session.mask));
  }, [status, whole, maskVersion]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  /* ----- adjustments ----- */

  const setAdjustment = (key: AdjustKey, value: number) => {
    setAdjustments((current) => ({ ...current, [key]: value }));
    // Get the gold overlay out of the way so the colour change is visible.
    setOverlayOn(false);
    setFixMode(null);
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
      const blob = await exportAdjusted({
        image: session.image,
        width: session.width,
        height: session.height,
        mask: whole ? null : { data: session.mask, width: session.pw, height: session.ph },
        uniforms
      });
      await onSave(blob);
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
  const loadingPart = findGarmentPart(loadingPartKey);
  const showDots = segmentOn && !comparing && (overlayOn || fixMode !== null);
  const fixBusy = !!loadingPartKey || saving;

  return createPortal(
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label="Match colour">
      <header className="cs-header">
        <h2>Match colour</h2>
        <button type="button" className="cs-close" onClick={onClose} disabled={saving} aria-label="Close">
          ×
        </button>
      </header>

      <div className="cs-body">
        {allowSegment && status !== "error" && (
          <label className="cs-check">
            <input
              type="checkbox"
              checked={segmentOn}
              disabled={!ready || saving}
              onChange={(event) => {
                setSegmentOn(event.target.checked);
                setFixMode(null);
                setOverlayOn(true);
              }}
            />
            <span>Select only one part (Kurta, Koti, Lehenga…)</span>
          </label>
        )}

        {segmentOn && status !== "error" && (
          <div className="cs-chips" role="listbox" aria-label="Part to colour">
            {GARMENT_PARTS.map((part) => (
              <button
                key={part.key}
                type="button"
                role="option"
                aria-selected={activePartKey === part.key}
                className={`cs-chip${activePartKey === part.key ? " is-active" : ""}`}
                disabled={!ready || saving}
                onClick={() => selectPart(part)}
              >
                {part.label}
              </button>
            ))}
          </div>
        )}

        <div className="cs-stage" style={stageStyle}>
          <div className="cs-canvas-wrap">
            <canvas
              ref={canvasRef}
              className={`cs-canvas${segmentOn && fixMode ? " is-tapping" : ""}`}
              onClick={handleCanvasClick}
            />
            {showDots &&
              dots.map((dot, index) => (
                <span
                  key={index}
                  className={`cs-dot-mark${dot.label === 1 ? " is-add" : " is-remove"}`}
                  style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }}
                  aria-hidden
                />
              ))}
            {comparing && <span className="cs-badge">Original</span>}
            {segmentOn && loadingPart && (
              <div className="cs-finding" role="status">
                <div className="spinner spinner-small" />
                <span>Finding {loadingPart.label}...</span>
              </div>
            )}
            {ready && (
              <button
                type="button"
                className="cs-compare"
                disabled={!adjusted || !canAdjust}
                onContextMenu={(event) => event.preventDefault()}
                {...compareHandlers}
              >
                Hold: Before
              </button>
            )}
          </div>
          {status === "loading" && (
            <div className="cs-stage-cover">
              <div className="spinner" aria-label="Loading" />
            </div>
          )}
        </div>

        {errorText && <p className="error-text">{errorText}</p>}

        {segmentOn && status !== "error" && (
          <div className="cs-panel">
            {segmentError && <p className="error-text">{segmentError}</p>}
            {!activePart && <p className="cs-hint">Pick the part you want to colour.</p>}
            {activePart && (
              <>
                <div className="cs-fix">
                  <span className="cs-fix-label">Fix selection</span>
                  <button
                    type="button"
                    className={`cs-fix-btn is-add${fixMode === "add" ? " is-active" : ""}`}
                    aria-pressed={fixMode === "add"}
                    disabled={fixBusy}
                    onClick={() => setFixMode((mode) => (mode === "add" ? null : "add"))}
                  >
                    + Add
                  </button>
                  <button
                    type="button"
                    className={`cs-fix-btn is-remove${fixMode === "remove" ? " is-active" : ""}`}
                    aria-pressed={fixMode === "remove"}
                    disabled={fixBusy}
                    onClick={() => setFixMode((mode) => (mode === "remove" ? null : "remove"))}
                  >
                    − Remove
                  </button>
                </div>
                {(fixMode || dots.length > 0) && (
                  <>
                    <p className="cs-hint">
                      {fixMode === "remove"
                        ? "Tap the photo where the selection should NOT be (red dots)."
                        : fixMode === "add"
                          ? "Tap the photo where the selection is missing (green dots)."
                          : "Dots are placed. Select again to apply them."}
                    </p>
                    <div className="cs-fix">
                      <button
                        type="button"
                        className="btn-secondary cs-fix-action"
                        disabled={dots.length === 0 || fixBusy}
                        onClick={handleSelectAgain}
                      >
                        Select again
                      </button>
                      <button
                        type="button"
                        className="btn-secondary cs-fix-action"
                        disabled={dots.length === 0 || fixBusy}
                        onClick={handleClearDots}
                      >
                        Clear dots
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            <p className="cs-footnote">Each new selection costs ~₹0.5</p>
          </div>
        )}

        {status !== "error" && (
          <>
            {canAdjust && stats && stats.blownFraction > BLOWN_OUT_WARNING && (
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
                  disabled={!canAdjust}
                  onChange={(value) => setAdjustment(slider.key, value)}
                />
              ))}

              <AdjustSlider
                label="Shade strength"
                left="Paler"
                right="Stronger"
                value={adjustments.shade}
                disabled={!canAdjust || shadeNeedsPick}
                trackStyle={
                  shadeTrack
                    ? ({ "--cs-track": `linear-gradient(90deg, ${shadeTrack[0]}, ${shadeTrack[1]})` } as CSSProperties)
                    : undefined
                }
                onChange={(value) => setAdjustment("shade", value)}
              />
              {neutral && canAdjust && (
                <div className="cs-dots">
                  <span className="cs-dots-label">
                    This fabric is almost colourless. Pick the shade it should lean to:
                  </span>
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
            </div>

            {rendererKind === "cpu" && ready && (
              <p className="cs-hint">This device has no WebGL, so the preview is smaller and slower.</p>
            )}
          </>
        )}
      </div>

      <footer className="cs-footer">
        {status !== "error" && (
          <button type="button" className="btn-secondary" onClick={handleReset} disabled={!adjusted || saving}>
            Reset
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        {status !== "error" && (
          <button
            type="button"
            className="btn-primary cs-save"
            onClick={() => void handleSave()}
            disabled={!canAdjust || !adjusted || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </footer>
    </div>,
    document.body
  );
}
