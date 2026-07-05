import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { createSignedUrl } from "../lib/storage";
import type { GenerationRow, MatchColorSaveResponse } from "../lib/types";
import { MatchColorWebGLRenderer, type MatchColorDrawOptions } from "../lib/webglMatchColor";

const NAVY = "#1B1B2F";
const GOLD = "#C9A84C";
const MAX_SWATCHES = 8;

type AdjustmentKey = keyof SwatchAdjustment;

async function loadImageFromUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image fetch failed (HTTP ${response.status})`);
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Image load failed"));
    element.src = objectUrl;
  });

  return { image, objectUrl };
}

export function MatchColorPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const generationId = searchParams.get("generationId") ?? "";

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<MatchColorWebGLRenderer | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingDrawRef = useRef<MatchColorDrawOptions | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [outputImageUrl, setOutputImageUrl] = useState<string | null>(null);
  const [sourceImageData, setSourceImageData] = useState<ImageData | null>(null);
  const [swatches, setSwatches] = useState<string[]>([]);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [adjustmentsByHex, setAdjustmentsByHex] = useState<Record<string, SwatchAdjustment>>({});
  const [savedHexes, setSavedHexes] = useState<Set<string>>(new Set());

  const currentAdjustment = useMemo(
    () => (selectedHex ? adjustmentsByHex[selectedHex] ?? emptySwatchAdjustment() : emptySwatchAdjustment()),
    [selectedHex, adjustmentsByHex]
  );

  async function loadMatchColorData() {
    if (!generationId || !accessToken) return;

    setLoading(true);
    setErrorText(null);

    try {
      const generation = await apiFetch<GenerationRow>(`/generations/${generationId}`, accessToken, {
        method: "GET"
      });

      if (!generation.output_path) {
        throw new Error(generation.error || "Output image is not ready yet");
      }

      const signedUrl = await createSignedUrl("generated-outputs", generation.output_path);
      setOutputPath(generation.output_path);

      const loaded = await loadImageFromUrl(signedUrl);
      setOutputImageUrl(loaded.objectUrl);

      const canvas = resizeImageToCanvas(loaded.image, 680);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas context unavailable");
      }

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      sourceCanvasRef.current = canvas;
      setSourceImageData(imageData);

      const nextSwatches = extractProminentSwatches(imageData, MAX_SWATCHES);
      setSwatches(nextSwatches);
      setAdjustmentsByHex({});
      setSavedHexes(new Set());
      setSelectedHex(nextSwatches[0] ?? null);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMatchColorData();
  }, [accessToken, generationId]);

  useEffect(() => {
    if (!outputImageUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(outputImageUrl);
  }, [outputImageUrl]);

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    if (!canvas || !sourceCanvas || !sourceImageData) return;

    let renderer: MatchColorWebGLRenderer | null = null;
    try {
      renderer = new MatchColorWebGLRenderer(canvas);
      renderer.setSource(sourceCanvas, sourceCanvas.width, sourceCanvas.height);
    } catch {
      renderer = null;
    }
    rendererRef.current = renderer;

    return () => {
      renderer?.dispose();
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, [sourceImageData]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  function scheduleDraw(options: MatchColorDrawOptions) {
    pendingDrawRef.current = options;
    if (rafIdRef.current !== null) return;

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const pending = pendingDrawRef.current;
      pendingDrawRef.current = null;
      const renderer = rendererRef.current;
      if (renderer && pending) {
        renderer.draw(pending);
      }
    });
  }

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const renderer = rendererRef.current;
    if (renderer) {
      const targetHsl = (selectedHex && hexToHsl01(selectedHex)) || { h: 0, s: 0, l: 0 };
      scheduleDraw({
        targetHsl,
        hueShift: currentAdjustment.hueShiftDeg / 360,
        satDelta: currentAdjustment.satDeltaPct / 100,
        lightDelta: currentAdjustment.lightDeltaPct / 100
      });
      return;
    }

    if (!sourceImageData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rendered = applyLivePreviewAdjustment(sourceImageData, selectedHex, currentAdjustment);
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    ctx.putImageData(rendered, 0, 0);
  }, [sourceImageData, selectedHex, currentAdjustment]);

  function handleSliderInput(event: FormEvent<HTMLInputElement>, key: AdjustmentKey) {
    if (!selectedHex) return;
    const value = Number((event.currentTarget as HTMLInputElement).value);

    setAdjustmentsByHex((prev) => ({
      ...prev,
      [selectedHex]: {
        ...(prev[selectedHex] ?? emptySwatchAdjustment()),
        [key]: value
      }
    }));
  }

  function handleResetSelected() {
    if (!selectedHex) return;
    setAdjustmentsByHex((prev) => ({
      ...prev,
      [selectedHex]: emptySwatchAdjustment()
    }));
  }

  async function handleSave() {
    if (!accessToken || !generationId || !selectedHex) return;

    setSaving(true);
    setErrorText(null);

    try {
      const adjustment = adjustmentsByHex[selectedHex] ?? emptySwatchAdjustment();
      const response = await apiFetch<MatchColorSaveResponse>(
        `/generations/${generationId}/match-color`,
        accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            edits: [
              {
                selected_hex: selectedHex,
                hue_shift_degrees: adjustment.hueShiftDeg,
                saturation_delta_percent: adjustment.satDeltaPct,
                lightness_delta_percent: adjustment.lightDeltaPct
              }
            ]
          })
        }
      );

      const nextPath = response.output_path || outputPath;
      if (nextPath) {
        const signedUrl = await createSignedUrl("generated-outputs", nextPath);
        setOutputPath(nextPath);
        setOutputImageUrl(signedUrl);
      }

      setSavedHexes((prev) => {
        const next = new Set(prev);
        next.add(selectedHex);
        return next;
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  function handleBack() {
    navigate(`/output-viewer?generationId=${encodeURIComponent(generationId)}`);
  }

  const ready = !loading && !!outputImageUrl && swatches.length > 0;

  return (
    <main className="screen" style={{ background: "var(--surface)" }}>
      <section className="page-shell">
        <header className="page-header">
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <button
              className="btn btn-light"
              onClick={handleBack}
              aria-label="Back to output viewer"
              style={{ width: 44, padding: 0, fontSize: 20, color: NAVY }}
            >
              &larr;
            </button>
            <h1 style={{ color: NAVY }}>Match Color</h1>
          </div>
        </header>

        {loading ? (
          <section className="card" style={{ minHeight: 240, display: "grid", placeItems: "center" }}>
            <div className="stack-sm" style={{ placeItems: "center" }}>
              <div className="spinner" />
              <p className="tiny muted">Loading image and colors...</p>
            </div>
          </section>
        ) : null}

        {!loading && errorText && !ready ? (
          <section className="card stack-sm">
            <p className="error-text">{errorText}</p>
            <button className="btn btn-dark" onClick={loadMatchColorData} disabled={!accessToken}>
              Retry
            </button>
          </section>
        ) : null}

        {ready ? (
          <>
            {outputImageUrl ? (
              <img src={outputImageUrl} alt="Generated output" style={{ width: "100%", borderRadius: 14 }} />
            ) : null}

            <p className="tiny muted">Tap image to set inspect focus.</p>

            <section className="card stack-sm">
              <div className="between">
                <h2>Adjust Colors</h2>
                <span className="chip">{savedHexes.size}/{MAX_SWATCHES} edited</span>
              </div>

              <div className="swatch-row" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {swatches.map((hex) => {
                  const isSelected = hex === selectedHex;
                  const isSaved = savedHexes.has(hex);

                  return (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setSelectedHex(hex)}
                      title={hex}
                      style={{
                        position: "relative",
                        width: 44,
                        height: 44,
                        borderRadius: "50%",
                        padding: 0,
                        cursor: "pointer",
                        background: hex,
                        border: isSelected ? "3px solid #FFFFFF" : "2px solid var(--border)",
                        boxShadow: isSelected
                          ? `0 0 0 2px ${NAVY}`
                          : isSaved
                          ? `0 0 0 2px ${GOLD}`
                          : "none"
                      }}
                    >
                      {isSaved ? (
                        <span
                          aria-hidden
                          style={{
                            position: "absolute",
                            top: -4,
                            right: -4,
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            background: GOLD,
                            color: NAVY,
                            fontSize: 10,
                            lineHeight: "16px",
                            fontWeight: 700
                          }}
                        >
                          &#10003;
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {selectedHex ? (
                <p className="tiny muted">
                  Selected: {selectedHex} (same-color areas may also change)
                </p>
              ) : null}

              <div className="match-preview-wrap">
                <canvas ref={previewCanvasRef} className="match-preview-canvas" />
              </div>

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
                  disabled={!selectedHex}
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
                  disabled={!selectedHex}
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
                  disabled={!selectedHex}
                />
              </label>

              {errorText ? <p className="error-text">{errorText}</p> : null}

              <footer className="row">
                <button
                  className="btn btn-light flex-1"
                  onClick={handleResetSelected}
                  disabled={!selectedHex || saving}
                >
                  Reset Selected
                </button>
                <button
                  className="btn btn-dark flex-1"
                  onClick={handleSave}
                  disabled={!selectedHex || saving || isZeroAdjustment(currentAdjustment)}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </footer>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
