import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DownloadUrlResponse, GenerationRow } from "../lib/types";

const AUTO_ADVANCE_MS = 3500;

export function CarouselPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState<GenerationRow[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [statusText, setStatusText] = useState("Loading outputs...");

  const visibleRows = useMemo(
    () => rows.filter((row) => row.status === "done" && !!row.output_path),
    [rows]
  );

  const currentRow = visibleRows[index] ?? null;
  const currentUrl = currentRow ? previewUrls[currentRow.id] ?? null : null;

  async function getDownloadUrl(generationId: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<DownloadUrlResponse>(
      `/generations/${generationId}/download-url`,
      accessToken,
      { method: "GET" }
    );
    return response.download_url;
  }

  async function loadOutputs() {
    if (!accessToken) return;
    setLoading(true);
    try {
      setPreviewUrls({});
      const rows = await apiFetch<GenerationRow[]>("/generations?status=done&limit=100", accessToken, {
        method: "GET"
      });
      setRows(rows);
      setIndex(0);
      setStatusText(rows.length ? "Carousel ready" : "No outputs available.");
    } catch (err) {
      setStatusText(`Failed to load outputs: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOutputs();
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !visibleRows.length) return;
    const missing = visibleRows.filter((row) => !previewUrls[row.id]);
    if (!missing.length) return;

    Promise.all(
      missing.map(async (row) => {
        try {
          const url = await getDownloadUrl(row.id);
          return { id: row.id, url };
        } catch {
          return null;
        }
      })
    )
      .then((items) => {
        const valid = items.filter((item): item is { id: string; url: string } => !!item);
        if (!valid.length) return;
        setPreviewUrls((prev) => {
          const next = { ...prev };
          for (const item of valid) next[item.id] = item.url;
          return next;
        });
      })
      .catch(() => {
        // best effort
      });
  }, [accessToken, visibleRows, previewUrls]);

  useEffect(() => {
    if (!autoAdvance || visibleRows.length <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % visibleRows.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [autoAdvance, visibleRows.length]);

  function goPrev() {
    if (!visibleRows.length) return;
    setIndex((prev) => (prev - 1 + visibleRows.length) % visibleRows.length);
  }

  function goNext() {
    if (!visibleRows.length) return;
    setIndex((prev) => (prev + 1) % visibleRows.length);
  }

  return (
    <main className="screen carousel-screen">
      <section className="page-shell carousel-shell">
        <header className="page-header">
          <div>
            <h1>Carousel Mode</h1>
            <p className="muted-light">
              {statusText}
              {visibleRows.length > 1 && autoAdvance ? ` - Auto ${AUTO_ADVANCE_MS / 1000}s` : ""}
            </p>
          </div>
        </header>

        <section className="carousel-viewer" onClick={goNext} role="button" tabIndex={0}>
          {loading ? (
            <div className="loading-box dark">
              <div className="spinner" />
            </div>
          ) : !currentRow ? (
            <div className="loading-box dark">
              <p className="tiny muted-light">No output images available.</p>
            </div>
          ) : currentUrl ? (
            <img src={currentUrl} alt={`Output ${currentRow.id}`} />
          ) : (
            <div className="loading-box dark">
              <div className="spinner" />
            </div>
          )}
        </section>

        <footer className="row">
          <button className="btn btn-light flex-1" onClick={goPrev} disabled={!visibleRows.length}>
            Previous
          </button>
          <span className="counter-chip">
            {visibleRows.length ? `${index + 1} / ${visibleRows.length}` : "0 / 0"}
          </span>
          <button className="btn btn-light flex-1" onClick={goNext} disabled={!visibleRows.length}>
            Next
          </button>
        </footer>

        <div className="row">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(event) => setAutoAdvance(event.target.checked)}
            />
            <span>Auto advance</span>
          </label>
          <button className="btn btn-dark" onClick={loadOutputs} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </section>
    </main>
  );
}



