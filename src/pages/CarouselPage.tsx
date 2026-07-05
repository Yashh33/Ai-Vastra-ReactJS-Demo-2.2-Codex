import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { GenerationRow } from "../lib/types";

const AUTO_ADVANCE_MS = 3500;
const URL_REFRESH_THRESHOLD_MS = 50 * 60 * 1000;

export function CarouselPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState<GenerationRow[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [statusText, setStatusText] = useState("Loading outputs...");
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const visibleRows = useMemo(
    () => rows.filter((row) => row.status === "done" && !!row.output_path),
    [rows]
  );

  const currentRow = visibleRows[index] ?? null;
  const currentUrl = currentRow?.download_url ?? null;

  async function loadOutputs() {
    if (!accessToken) return;
    setLoading(true);
    try {
      const currentId = visibleRows[index]?.id ?? null;
      const fetchedRows = await apiFetch<GenerationRow[]>(
        "/generations?status=done&limit=100&include_urls=true",
        accessToken,
        { method: "GET" }
      );
      setRows(fetchedRows);

      const nextVisibleRows = fetchedRows.filter((row) => row.status === "done" && !!row.output_path);
      const preservedIndex = currentId ? nextVisibleRows.findIndex((row) => row.id === currentId) : -1;
      setIndex(preservedIndex >= 0 ? preservedIndex : 0);
      setLoadedAt(Date.now());
      setStatusText(fetchedRows.length ? "Carousel ready" : "No outputs available.");
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
    if (!autoAdvance || visibleRows.length <= 1) return;
    const timer = window.setInterval(() => {
      if (loadedAt && Date.now() - loadedAt > URL_REFRESH_THRESHOLD_MS) {
        void loadOutputs();
        return;
      }
      setIndex((prev) => (prev + 1) % visibleRows.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [autoAdvance, visibleRows.length, loadedAt]);

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
