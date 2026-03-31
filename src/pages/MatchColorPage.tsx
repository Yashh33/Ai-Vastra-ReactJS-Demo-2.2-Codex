import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  applyLivePreviewAdjustment,
  emptySwatchAdjustment,
  extractProminentSwatches,
  hexToHsl01,
  isZeroAdjustment,
  resizeImageToCanvas,
  type SwatchAdjustment
} from "../lib/matchColor";
import type { DownloadUrlResponse, GenerationRow, MatchColorEditPayload, MatchColorSaveResponse } from "../lib/types";
import { MatchColorWebGLRenderer, type MatchColorDrawOptions } from "../lib/webglMatchColor";
import { withCacheBust } from "../lib/utils";

type PreviewMode = "webgl" | "cpu";

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = src;
  });
}

async function fetchImageAsObjectUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch preview image (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function clampRange(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function wrapHue01(value: number) {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

function hsl01ToCss(h: number, s: number, l: number) {
  const hue = Math.round(wrapHue01(h) * 360);
  const sat = Math.round(clamp01(s) * 100);
  const light = Math.round(clamp01(l) * 100);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function buildHueTrackGradient(centerHue: number) {
  const stops: string[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const pct = (i / steps) * 100;
    const offset = -0.5 + i / steps; // -180..+180 degrees around center
    const hue = wrapHue01(centerHue + offset);
    stops.push(`${hsl01ToCss(hue, 1, 0.5)} ${pct.toFixed(2)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function buildSaturationTrackGradient(baseHue: number, baseSat: number, baseLight: number) {
  return `linear-gradient(90deg, ${hsl01ToCss(baseHue, 0, baseLight)} 0%, ${hsl01ToCss(
    baseHue,
    baseSat,
    baseLight
  )} 50%, ${hsl01ToCss(baseHue, 1, baseLight)} 100%)`;
}

type RangeTrackStyle = CSSProperties & {
  "--track-gradient"?: string;
};

export function MatchColorPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const generationId = searchParams.get("generationId") ?? "";

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const fullResCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inspectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inspectScratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglRendererRef = useRef<MatchColorWebGLRenderer | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const inspectDrawRafRef = useRef<number | null>(null);
  const fastPreviewTimerRef = useRef<number | null>(null);

  const [previewMode, setPreviewMode] = useState<PreviewMode>("webgl");
  const [fastPreview, setFastPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState("Loading output image...");
  const [displayImageUrl, setDisplayImageUrl] = useState<string | null>(null);
  const [sourceImageData, setSourceImageData] = useState<ImageData | null>(null);
  const [fullResReady, setFullResReady] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectZoom, setInspectZoom] = useState(2.2);
  const [inspectCenter, setInspectCenter] = useState({ x: 0.5, y: 0.5 });
  const [swatches, setSwatches] = useState<string[]>([]);
  const [selectedSwatch, setSelectedSwatch] = useState<string | null>(null);
  const [adjustmentsBySwatch, setAdjustmentsBySwatch] = useState<Record<string, SwatchAdjustment>>(
    {}
  );

  const currentAdjustment = useMemo(() => {
    if (!selectedSwatch) return emptySwatchAdjustment();
    return adjustmentsBySwatch[selectedSwatch] ?? emptySwatchAdjustment();
  }, [selectedSwatch, adjustmentsBySwatch]);

  const editedSwatchCount = useMemo(
    () => swatches.filter((hex) => !isZeroAdjustment(adjustmentsBySwatch[hex])).length,
    [swatches, adjustmentsBySwatch]
  );

  const actionBusy = loading || saving;
  const selectedHsl = useMemo(() => {
    return selectedSwatch ? hexToHsl01(selectedSwatch) : null;
  }, [selectedSwatch]);

  const hueTrackGradient = useMemo(() => {
    const centerHue = selectedHsl?.h ?? 0;
    return buildHueTrackGradient(centerHue);
  }, [selectedHsl?.h]);

  const saturationTrackGradient = useMemo(() => {
    const hue = selectedHsl?.h ?? 0;
    const sat = selectedHsl?.s ?? 0.5;
    // Keep saturation track readable for very dark/very light colors.
    const light = selectedHsl ? Math.min(0.72, Math.max(0.28, selectedHsl.l)) : 0.5;
    return buildSaturationTrackGradient(hue, sat, light);
  }, [selectedHsl]);

  const lightnessTrackGradient = "linear-gradient(90deg, rgb(0 0 0) 0%, rgb(128 128 128) 50%, rgb(255 255 255) 100%)";

  const hueRangeStyle: RangeTrackStyle = useMemo(
    () => ({
      "--track-gradient": hueTrackGradient
    }),
    [hueTrackGradient]
  );

  const saturationRangeStyle: RangeTrackStyle = useMemo(
    () => ({
      "--track-gradient": saturationTrackGradient
    }),
    [saturationTrackGradient]
  );

  const lightnessRangeStyle: RangeTrackStyle = useMemo(
    () => ({
      "--track-gradient": lightnessTrackGradient
    }),
    []
  );

  function buildWebGLDrawOptions(): MatchColorDrawOptions {
    const targetHsl = selectedSwatch ? hexToHsl01(selectedSwatch) : null;
    const adjustment = currentAdjustment;
    return {
      targetHsl: targetHsl ?? { h: 0, s: 0, l: 0 },
      hueShift: adjustment.hueShiftDeg / 360,
      satDelta: adjustment.satDeltaPct / 100,
      lightDelta: adjustment.lightDeltaPct / 100
    };
  }

  function scheduleWebGLDraw() {
    if (previewMode !== "webgl") return;
    if (drawRafRef.current !== null) return;

    drawRafRef.current = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      try {
        webglRendererRef.current?.draw(buildWebGLDrawOptions());
      } catch {
        // If GPU draw fails at runtime, fall back to CPU path.
        setPreviewMode("cpu");
      }
    });
  }

  function initOrRefreshWebGLRenderer() {
    if (previewMode !== "webgl") return;
    if (!previewCanvasRef.current || !sourceCanvasRef.current) return;

    try {
      if (!webglRendererRef.current) {
        webglRendererRef.current = new MatchColorWebGLRenderer(previewCanvasRef.current);
      }

      const sourceCanvas = sourceCanvasRef.current;
      webglRendererRef.current.setSource(sourceCanvas, sourceCanvas.width, sourceCanvas.height);
      webglRendererRef.current.setOutputScale(fastPreview ? 0.9 : 1);
      scheduleWebGLDraw();
    } catch {
      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      setPreviewMode("cpu");
      setStatusText((prev) =>
        prev.includes("CPU fallback") ? prev : `${prev} (CPU fallback active)`
      );
    }
  }

  function drawInspectCanvas() {
    if (!inspectOpen) return;
    const fullResCanvas = fullResCanvasRef.current;
    const inspectCanvas = inspectCanvasRef.current;
    if (!fullResCanvas || !inspectCanvas) return;

    const sourceCtx = fullResCanvas.getContext("2d", { willReadFrequently: true });
    const outCtx = inspectCanvas.getContext("2d");
    if (!sourceCtx || !outCtx) return;

    const zoom = clampRange(inspectZoom, 1.2, 6);
    const cropWidth = Math.max(48, Math.round(fullResCanvas.width / zoom));
    const cropHeight = Math.max(48, Math.round(fullResCanvas.height / zoom));
    const maxLeft = Math.max(0, fullResCanvas.width - cropWidth);
    const maxTop = Math.max(0, fullResCanvas.height - cropHeight);

    const centerX = inspectCenter.x * fullResCanvas.width;
    const centerY = inspectCenter.y * fullResCanvas.height;
    const cropLeft = Math.round(clampRange(centerX - cropWidth / 2, 0, maxLeft));
    const cropTop = Math.round(clampRange(centerY - cropHeight / 2, 0, maxTop));

    const roiImageData = sourceCtx.getImageData(cropLeft, cropTop, cropWidth, cropHeight);
    const rendered = applyLivePreviewAdjustment(roiImageData, selectedSwatch, currentAdjustment);

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.round(inspectCanvas.clientWidth || 240));
    const cssHeight = Math.max(1, Math.round(inspectCanvas.clientHeight || 240));
    const outputWidth = Math.max(1, Math.round(cssWidth * dpr));
    const outputHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (inspectCanvas.width !== outputWidth || inspectCanvas.height !== outputHeight) {
      inspectCanvas.width = outputWidth;
      inspectCanvas.height = outputHeight;
    }

    const scratch = inspectScratchCanvasRef.current ?? document.createElement("canvas");
    inspectScratchCanvasRef.current = scratch;
    scratch.width = rendered.width;
    scratch.height = rendered.height;
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) return;
    scratchCtx.putImageData(rendered, 0, 0);

    outCtx.clearRect(0, 0, outputWidth, outputHeight);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(scratch, 0, 0, outputWidth, outputHeight);

    const crossX = outputWidth / 2;
    const crossY = outputHeight / 2;
    outCtx.strokeStyle = "rgb(248 250 252 / 88%)";
    outCtx.lineWidth = Math.max(1.5, Math.round(dpr));
    outCtx.beginPath();
    outCtx.moveTo(crossX - 16 * dpr, crossY);
    outCtx.lineTo(crossX + 16 * dpr, crossY);
    outCtx.moveTo(crossX, crossY - 16 * dpr);
    outCtx.lineTo(crossX, crossY + 16 * dpr);
    outCtx.stroke();
  }

  function scheduleInspectDraw() {
    if (!inspectOpen) return;
    if (inspectDrawRafRef.current !== null) return;

    inspectDrawRafRef.current = window.requestAnimationFrame(() => {
      inspectDrawRafRef.current = null;
      drawInspectCanvas();
    });
  }

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current = [];

      if (drawRafRef.current !== null) {
        window.cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }

      if (inspectDrawRafRef.current !== null) {
        window.cancelAnimationFrame(inspectDrawRafRef.current);
        inspectDrawRafRef.current = null;
      }

      if (fastPreviewTimerRef.current !== null) {
        window.clearTimeout(fastPreviewTimerRef.current);
        fastPreviewTimerRef.current = null;
      }

      webglRendererRef.current?.dispose();
      webglRendererRef.current = null;
      fullResCanvasRef.current = null;
      inspectScratchCanvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    initOrRefreshWebGLRenderer();
  }, [previewMode, sourceImageData]);

  useEffect(() => {
    if (!webglRendererRef.current || previewMode !== "webgl") return;
    webglRendererRef.current.setOutputScale(fastPreview ? 0.9 : 1);
    scheduleWebGLDraw();
  }, [fastPreview, previewMode]);

  useEffect(() => {
    if (!sourceImageData || !previewCanvasRef.current || previewMode !== "cpu") return;
    const ctx = previewCanvasRef.current.getContext("2d");
    if (!ctx) return;

    const rendered = applyLivePreviewAdjustment(sourceImageData, selectedSwatch, currentAdjustment);
    previewCanvasRef.current.width = rendered.width;
    previewCanvasRef.current.height = rendered.height;
    ctx.putImageData(rendered, 0, 0);
  }, [sourceImageData, selectedSwatch, currentAdjustment, previewMode]);

  useEffect(() => {
    if (previewMode !== "webgl") return;
    scheduleWebGLDraw();
  }, [selectedSwatch, currentAdjustment, previewMode]);

  useEffect(() => {
    if (!inspectOpen) return;
    scheduleInspectDraw();
  }, [inspectOpen, inspectCenter, inspectZoom, selectedSwatch, currentAdjustment, sourceImageData]);

  useEffect(() => {
    if (!inspectOpen) return;
    const handleResize = () => scheduleInspectDraw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [inspectOpen]);

  async function fetchDownloadUrl(id: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<DownloadUrlResponse>(`/generations/${id}/download-url`, accessToken, {
      method: "GET"
    });
    return response.download_url;
  }

  async function loadMatchColorData() {
    if (!accessToken || !generationId) return;
    setLoading(true);
    setInspectOpen(false);
    setInspectCenter({ x: 0.5, y: 0.5 });
    setInspectZoom(2.2);
    setFullResReady(false);
    try {
      setStatusText("Loading generation...");
      const generation = await apiFetch<GenerationRow>(`/generations/${generationId}`, accessToken, {
        method: "GET"
      });

      if (generation.status !== "done" || !generation.output_path) {
        throw new Error(generation.error || "Output image is not ready yet");
      }

      setStatusText("Downloading editable preview...");
      const signedUrl = await fetchDownloadUrl(generationId);
      setDisplayImageUrl(withCacheBust(signedUrl));

      const objectUrl = await fetchImageAsObjectUrl(signedUrl);
      objectUrlsRef.current.push(objectUrl);

      const image = await loadImageElement(objectUrl);
      const fullResCanvas = document.createElement("canvas");
      fullResCanvas.width = image.naturalWidth;
      fullResCanvas.height = image.naturalHeight;
      const fullCtx = fullResCanvas.getContext("2d", { willReadFrequently: true });
      if (!fullCtx) {
        throw new Error("Canvas context unavailable");
      }
      fullCtx.drawImage(image, 0, 0, fullResCanvas.width, fullResCanvas.height);
      fullResCanvasRef.current = fullResCanvas;
      setFullResReady(true);

      const canvas = resizeImageToCanvas(image, 680);
      sourceCanvasRef.current = canvas;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas context unavailable");
      }

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setSourceImageData(imageData);

      const nextSwatches = extractProminentSwatches(imageData, 8);
      if (!nextSwatches.length) {
        throw new Error("No prominent colors found in the output image");
      }

      setSwatches(nextSwatches);
      setAdjustmentsBySwatch((prev) => {
        const next: Record<string, SwatchAdjustment> = {};
        for (const hex of nextSwatches) {
          next[hex] = prev[hex] ?? emptySwatchAdjustment();
        }
        return next;
      });
      setSelectedSwatch((prev) => (prev && nextSwatches.includes(prev) ? prev : (nextSwatches[0] ?? null)));
      setStatusText(
        previewMode === "webgl"
          ? "Select a swatch and adjust H/S/L sliders (GPU preview active)."
          : "Select a swatch and adjust H/S/L sliders (CPU fallback active)."
      );
    } catch (err) {
      setStatusText(`Match Color failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  function handlePreviewInspectTap(
    event: ReactPointerEvent<HTMLCanvasElement | HTMLImageElement>
  ) {
    if (!fullResReady) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nextX = clamp01((event.clientX - rect.left) / rect.width);
    const nextY = clamp01((event.clientY - rect.top) / rect.height);
    setInspectCenter({ x: nextX, y: nextY });
    setInspectOpen(true);
  }

  useEffect(() => {
    if (!generationId) {
      setStatusText("Missing generation id");
      return;
    }
    void loadMatchColorData();
  }, [generationId, accessToken]);

  function updateSelectedSwatch(
    updater: (current: SwatchAdjustment) => SwatchAdjustment
  ) {
    if (!selectedSwatch) return;
    setAdjustmentsBySwatch((prev) => {
      const current = prev[selectedSwatch] ?? emptySwatchAdjustment();
      return {
        ...prev,
        [selectedSwatch]: updater(current)
      };
    });
  }

  function resetSelectedSwatch() {
    if (!selectedSwatch) return;
    setAdjustmentsBySwatch((prev) => ({
      ...prev,
      [selectedSwatch]: emptySwatchAdjustment()
    }));
    setStatusText(`Reset ${selectedSwatch}`);
  }

  async function handleSave() {
    if (!accessToken || !generationId) return;
    const edits: MatchColorEditPayload[] = swatches
      .map((hex) => ({
        hex,
        adjustment: adjustmentsBySwatch[hex] ?? emptySwatchAdjustment()
      }))
      .filter((row) => !isZeroAdjustment(row.adjustment))
      .map((row) => ({
        selected_hex: row.hex,
        hue_shift_degrees: row.adjustment.hueShiftDeg,
        saturation_delta_percent: row.adjustment.satDeltaPct,
        lightness_delta_percent: row.adjustment.lightDeltaPct
      }));

    if (!edits.length) {
      setStatusText("Make at least one swatch edit before saving.");
      return;
    }

    setSaving(true);
    try {
      setStatusText(`Saving ${edits.length} swatch edit(s)...`);
      await apiFetch<MatchColorSaveResponse>(`/generations/${generationId}/match-color`, accessToken, {
        method: "POST",
        body: JSON.stringify({ edits })
      });
      setStatusText("Saved. Returning to output viewer.");
      navigate(
        `/output-viewer?generationId=${encodeURIComponent(generationId)}&refreshNonce=${Date.now()}`,
        {
          replace: true
        }
      );
    } catch (err) {
      setStatusText(`Save failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  function handleSliderInput(
    event: FormEvent<HTMLInputElement>,
    key: "hueShiftDeg" | "satDeltaPct" | "lightDeltaPct"
  ) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    updateSelectedSwatch((current) => ({
      ...current,
      [key]: value
    }));
  }

  function beginSliderInteraction() {
    if (previewMode !== "webgl") return;
    if (fastPreviewTimerRef.current !== null) {
      window.clearTimeout(fastPreviewTimerRef.current);
      fastPreviewTimerRef.current = null;
    }
    setFastPreview(false);

    // Keep sharp image for quick micro-adjustments, degrade slightly only on longer drag.
    fastPreviewTimerRef.current = window.setTimeout(() => {
      fastPreviewTimerRef.current = null;
      setFastPreview(true);
    }, 220);
  }

  function endSliderInteraction() {
    if (fastPreviewTimerRef.current !== null) {
      window.clearTimeout(fastPreviewTimerRef.current);
      fastPreviewTimerRef.current = null;
    }
    setFastPreview(false);
  }

  const sliderInteractionHandlers = {
    onPointerDown: beginSliderInteraction,
    onPointerUp: endSliderInteraction,
    onPointerCancel: endSliderInteraction,
    onPointerLeave: endSliderInteraction,
    onBlur: endSliderInteraction
  };

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="page-header">
          <div>
            <h1>Match Color</h1>
            <p className="muted">Pick a prominent swatch and tune H/S/L with live preview.</p>
          </div>
        </header>

        <section className="card stack-sm">
          <p className="tiny">{statusText}</p>
        </section>

        <section className="card stack-sm">
          <div className="between">
            <h2>Preview</h2>
            <div className="row">
              <button className="btn btn-light" onClick={loadMatchColorData} disabled={actionBusy}>
                {loading ? "Refreshing..." : "Refresh Colors"}
              </button>
              <button
                className="btn btn-light"
                onClick={() => setInspectOpen((prev) => !prev)}
                disabled={!fullResReady}
              >
                {inspectOpen ? "Hide Inspect" : "Inspect"}
              </button>
            </div>
          </div>
          <div className="match-preview-wrap">
            {sourceImageData ? (
              <canvas
                ref={previewCanvasRef}
                className="match-preview-canvas"
                onPointerUp={handlePreviewInspectTap}
              />
            ) : displayImageUrl ? (
              <img
                className="preview-image"
                src={displayImageUrl}
                alt="Output preview"
                onPointerUp={handlePreviewInspectTap}
              />
            ) : (
              <div className="preview-placeholder">No preview available</div>
            )}
            {fullResReady ? (
              <span
                className="inspect-focus-dot"
                style={{
                  left: `${inspectCenter.x * 100}%`,
                  top: `${inspectCenter.y * 100}%`
                }}
                aria-hidden
              />
            ) : null}
          </div>
          <p className="tiny muted inspect-help-text">Tap image to set inspect focus.</p>
        </section>

        {inspectOpen ? (
          <section className="card stack-sm">
            <div className="between">
              <h2>Inspect (High Quality)</h2>
              <span className="chip">{inspectZoom.toFixed(1)}x</span>
            </div>
            <p className="tiny muted">
              Zoomed crop from original image. Center crosshair shows current inspect point.
            </p>
            <div className="inspect-canvas-wrap">
              <canvas ref={inspectCanvasRef} className="inspect-canvas" />
            </div>
            <label className="range-field">
              <span>Inspect Zoom: {inspectZoom.toFixed(1)}x</span>
              <input
                className="range-input"
                type="range"
                min={1.2}
                max={6}
                step={0.1}
                value={inspectZoom}
                onInput={(event) => setInspectZoom(Number((event.currentTarget as HTMLInputElement).value))}
              />
            </label>
          </section>
        ) : null}

        <section className="card stack-sm">
          <h2>Adjust Colors</h2>
          {swatches.length ? (
            <>
              <div className="swatch-row">
                {swatches.map((hex) => {
                  const selected = selectedSwatch === hex;
                  const edited = !isZeroAdjustment(adjustmentsBySwatch[hex]);
                  return (
                    <button
                      key={hex}
                      className={`swatch-btn ${selected ? "swatch-selected" : ""} ${
                        edited ? "swatch-edited" : ""
                      }`}
                      onClick={() => setSelectedSwatch(hex)}
                      disabled={actionBusy}
                      title={hex}
                    >
                      <span style={{ backgroundColor: hex }} />
                    </button>
                  );
                })}
              </div>
              <div className="between">
                <p className="tiny muted">
                  Selected: {selectedSwatch ?? "None"} (same-color areas may also change)
                </p>
                <span className="chip">{editedSwatchCount}/{swatches.length} edited</span>
              </div>
            </>
          ) : (
            <div className="empty-box">No swatches found yet.</div>
          )}

          <label className="range-field">
            <span>Hue: {currentAdjustment.hueShiftDeg} deg</span>
            <input
              className="range-input"
              type="range"
              min={-180}
              max={180}
              step={1}
              value={currentAdjustment.hueShiftDeg}
              onInput={(event) => handleSliderInput(event, "hueShiftDeg")}
              disabled={!selectedSwatch || actionBusy}
              style={hueRangeStyle}
              {...sliderInteractionHandlers}
            />
          </label>

          <label className="range-field">
            <span>Saturation: {currentAdjustment.satDeltaPct}%</span>
            <input
              className="range-input"
              type="range"
              min={-100}
              max={100}
              step={1}
              value={currentAdjustment.satDeltaPct}
              onInput={(event) => handleSliderInput(event, "satDeltaPct")}
              disabled={!selectedSwatch || actionBusy}
              style={saturationRangeStyle}
              {...sliderInteractionHandlers}
            />
          </label>

          <label className="range-field">
            <span>Lightness: {currentAdjustment.lightDeltaPct}%</span>
            <input
              className="range-input"
              type="range"
              min={-100}
              max={100}
              step={1}
              value={currentAdjustment.lightDeltaPct}
              onInput={(event) => handleSliderInput(event, "lightDeltaPct")}
              disabled={!selectedSwatch || actionBusy}
              style={lightnessRangeStyle}
              {...sliderInteractionHandlers}
            />
          </label>
        </section>

        <footer className="row">
          <button
            className="btn btn-light flex-1"
            onClick={resetSelectedSwatch}
            disabled={!selectedSwatch || actionBusy}
          >
            Reset Selected
          </button>
          <button
            className="btn btn-dark flex-1"
            onClick={handleSave}
            disabled={actionBusy || editedSwatchCount === 0}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </footer>
      </section>
    </main>
  );
}


