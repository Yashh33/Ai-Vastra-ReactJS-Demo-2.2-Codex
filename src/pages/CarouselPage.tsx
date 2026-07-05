import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useGenerations } from "../lib/queries";

const AUTO_ADVANCE_MS = 3500;
const URL_REFRESH_THRESHOLD_MS = 50 * 60 * 1000;

export function CarouselPage() {
  const navigate = useNavigate();

  const [index, setIndex] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [statusText, setStatusText] = useState("Loading outputs...");
  const pendingCurrentIdRef = useRef<string | null>(null);

  const {
    data: rowsData,
    isFetching: loading,
    error: loadError,
    dataUpdatedAt,
    refetch
  } = useGenerations({ status: "done", limit: 100, include_urls: true });
  const rows = rowsData ?? [];

  const visibleRows = useMemo(
    () => rows.filter((row) => row.status === "done" && !!row.output_path),
    [rows]
  );

  const currentRow = visibleRows[index] ?? null;
  const currentUrl = currentRow?.download_url ?? null;

  function loadOutputs() {
    pendingCurrentIdRef.current = visibleRows[index]?.id ?? null;
    return refetch();
  }

  useEffect(() => {
    if (!rowsData) return;
    const lastId = pendingCurrentIdRef.current;
    pendingCurrentIdRef.current = null;

    const preservedIndex = lastId ? visibleRows.findIndex((row) => row.id === lastId) : -1;
    setIndex(preservedIndex >= 0 ? preservedIndex : 0);
  }, [rowsData]);

  useEffect(() => {
    if (loading) return;
    if (loadError) {
      setStatusText(`Failed to load outputs: ${loadError instanceof Error ? loadError.message : "Unknown error"}`);
      return;
    }
    setStatusText(rows.length ? "Carousel ready" : "No outputs available.");
  }, [loading, loadError, rows.length]);

  useEffect(() => {
    if (!autoAdvance || visibleRows.length <= 1) return;
    const timer = window.setInterval(() => {
      if (dataUpdatedAt && Date.now() - dataUpdatedAt > URL_REFRESH_THRESHOLD_MS) {
        void loadOutputs();
        return;
      }
      setIndex((prev) => (prev + 1) % visibleRows.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [autoAdvance, visibleRows.length, dataUpdatedAt]);

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
