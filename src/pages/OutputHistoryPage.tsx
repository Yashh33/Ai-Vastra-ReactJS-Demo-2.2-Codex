import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { buildGenerationDownloadFilename, triggerBrowserDownload } from "../lib/download";
import { useGenerations } from "../lib/queries";
import type { GenerationRow } from "../lib/types";

type HistoryFilters = {
  fabricCode: string;
  fabricColor: string;
};

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden focusable="false">
      <path
        d="M20 11a8 8 0 1 1-2.34-5.66M20 4v6h-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden focusable="false">
      <path
        d="M4 6h16M7 12h10M10 18h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
      <path
        d="M5 7h14M9 7V5h6v2M8 7v12h8V7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden focusable="false">
      <path
        d="M12 4v10m0 0 4-4m-4 4-4-4M5 20h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function summarizeFilters(filters: HistoryFilters) {
  const parts: string[] = [];
  if (filters.fabricCode) parts.push(`code: ${filters.fabricCode}`);
  if (filters.fabricColor) parts.push(`color: ${filters.fabricColor}`);
  return parts.join(", ");
}

export function OutputHistoryPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [statusText, setStatusText] = useState("Loading output history...");
  const [downloadingGenerationId, setDownloadingGenerationId] = useState<string | null>(null);
  const [deletingGenerationId, setDeletingGenerationId] = useState<string | null>(null);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fabricCodeInput, setFabricCodeInput] = useState("");
  const [fabricColorInput, setFabricColorInput] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<HistoryFilters>({ fabricCode: "", fabricColor: "" });
  const skipStatusUpdateRef = useRef(false);

  const {
    data: rowsData,
    isFetching: loading,
    error: loadError,
    refetch: refetchHistory
  } = useGenerations({
    status: "done",
    fabric_code: appliedFilters.fabricCode,
    fabric_color: appliedFilters.fabricColor,
    limit: 100,
    include_urls: true
  });
  const rows = rowsData ?? [];

  const visibleRows = useMemo(
    () => rows.filter((row) => row.status === "done" && !!row.output_path),
    [rows]
  );

  useEffect(() => {
    function handleExternalToggle() {
      setFiltersOpen((prev) => !prev);
    }

    window.addEventListener("aivastra:toggle-fabric-filters", handleExternalToggle);
    return () => {
      window.removeEventListener("aivastra:toggle-fabric-filters", handleExternalToggle);
    };
  }, []);

  function getFabricSummaryLabel(row: GenerationRow) {
    const label = row.fabric_summary_label?.trim();
    return label || "Garment";
  }

  useEffect(() => {
    if (loading) return;
    if (skipStatusUpdateRef.current) {
      skipStatusUpdateRef.current = false;
      return;
    }

    if (loadError) {
      setStatusText(`Failed to load output history: ${loadError instanceof Error ? loadError.message : "Unknown error"}`);
      return;
    }

    const filterSummary = summarizeFilters(appliedFilters);
    if (!rows.length) {
      setStatusText(filterSummary ? `No outputs found for ${filterSummary}.` : "No outputs yet.");
    } else {
      setStatusText(
        filterSummary
          ? `Loaded ${rows.length} output image(s) for ${filterSummary}.`
          : `Loaded ${rows.length} output image(s)`
      );
    }
  }, [loading, loadError, rows.length, appliedFilters]);

  function applyFilters() {
    setAppliedFilters({
      fabricCode: fabricCodeInput.trim(),
      fabricColor: fabricColorInput.trim()
    });
  }

  function clearFilters() {
    setFabricCodeInput("");
    setFabricColorInput("");
    setAppliedFilters({ fabricCode: "", fabricColor: "" });
  }

  function toggleFilters() {
    setFiltersOpen((prev) => !prev);
  }

  async function handleQuickDownload(row: GenerationRow) {
    if (!row.output_path || !row.download_url) return;
    setDownloadingGenerationId(row.id);
    try {
      const url = row.download_url;
      triggerBrowserDownload(url, buildGenerationDownloadFilename(row.id, row.output_path, url));
      setStatusText("Download started");
    } catch (err) {
      setStatusText(`Download failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setDownloadingGenerationId(null);
    }
  }

  async function handleDeleteGeneration(row: GenerationRow) {
    if (!accessToken) return;

    const confirmed = window.confirm("Delete this saved output image?");
    if (!confirmed) return;

    setDeletingGenerationId(row.id);
    try {
      const response = await apiFetch<{
        deleted: boolean;
        generation_id: string;
        output_path?: string | null;
        warning?: string;
      }>(`/generations/${row.id}`, accessToken, {
        method: "DELETE"
      });

      skipStatusUpdateRef.current = true;
      void queryClient.invalidateQueries({ queryKey: ["generations"] });

      const base = `Deleted output ${response.generation_id}.`;
      setStatusText(response.warning ? `${base} Warning: ${response.warning}` : base);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setStatusText(`Delete failed: ${message}`);
      window.alert(`Delete failed: ${message}`);
    } finally {
      setDeletingGenerationId(null);
    }
  }

  return (
    <main className="screen catalog-screen">
      <section className="catalog-shell">
        <header className="catalog-header">
          <div className="catalog-header-left">
            <div className="catalog-brand-mark" aria-hidden>
              AV
            </div>

            <div className="catalog-title-wrap">
              <h1 className="catalog-title">Garments</h1>
              <p className="catalog-subtitle">{visibleRows.length} items</p>
            </div>
          </div>

          <div className="catalog-header-actions">
            <button
              className="catalog-icon-btn"
              onClick={() => void refetchHistory()}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
            <button
              className={`catalog-icon-btn ${filtersOpen ? "catalog-icon-btn-active" : ""}`}
              onClick={toggleFilters}
              disabled={loading}
              aria-label="Fabric filters"
              title="Fabric Filters"
            >
              <FilterIcon />
            </button>
          </div>
        </header>

        <section className="card stack-sm">
          <div className="between">
            <h2>Filters</h2>
            <button className="btn btn-light" onClick={toggleFilters} disabled={loading}>
              {filtersOpen ? "Hide Filters" : "Show Filters"}
            </button>
          </div>

          {filtersOpen ? (
            <>
              <div className="row">
                <label className="field flex-1">
                  <span>Fabric Code</span>
                  <input
                    type="text"
                    value={fabricCodeInput}
                    onChange={(event) => setFabricCodeInput(event.target.value)}
                    placeholder="e.g. LAX123"
                    disabled={loading}
                  />
                </label>
                <label className="field flex-1">
                  <span>Fabric Color</span>
                  <input
                    type="text"
                    value={fabricColorInput}
                    onChange={(event) => setFabricColorInput(event.target.value)}
                    placeholder="e.g. White"
                    disabled={loading}
                  />
                </label>
              </div>
              <div className="row">
                <button className="btn btn-dark" onClick={applyFilters} disabled={loading}>
                  Apply Filters
                </button>
                <button className="btn btn-light" onClick={clearFilters} disabled={loading}>
                  Clear
                </button>
              </div>
            </>
          ) : (
            <p className="tiny muted">Open filters to search by fabric code and fabric color.</p>
          )}

          <p className="tiny muted">{statusText}</p>
        </section>

        {loading ? (
          <div className="loading-box">
            <div className="spinner" />
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="empty-box">{statusText || "No output images yet."}</div>
        ) : (
          <section className="catalog-grid">
            {visibleRows.map((row) => (
              <article className="catalog-tile" key={row.id}>
                <button
                  className="catalog-image-btn"
                  onClick={() => navigate(`/output-viewer?generationId=${encodeURIComponent(row.id)}`)}
                >
                  {row.thumb_url ? (
                    <img
                      className="catalog-image"
                      src={row.thumb_url}
                      alt={`Output ${row.id}`}
                      loading="lazy"
                      decoding="async"
                      style={{ aspectRatio: "3/4", objectFit: "cover" }}
                    />
                  ) : (
                    <div className="image-placeholder">
                      <div className="spinner spinner-small" />
                    </div>
                  )}
                </button>

                <div className="catalog-meta-row">
                  <p className="catalog-garment-label">{getFabricSummaryLabel(row)}</p>
                  <div className="catalog-action-row">
                    <button
                      className="catalog-chip-btn catalog-chip-delete"
                      onClick={() => void handleDeleteGeneration(row)}
                      disabled={deletingGenerationId === row.id || downloadingGenerationId === row.id}
                      aria-label="Delete output"
                    >
                      {deletingGenerationId === row.id ? "..." : <DeleteIcon />}
                    </button>
                    <button
                      className="catalog-chip-btn catalog-chip-download"
                      onClick={() => void handleQuickDownload(row)}
                      disabled={downloadingGenerationId === row.id || deletingGenerationId === row.id}
                      aria-label="Download output"
                    >
                      {downloadingGenerationId === row.id ? "..." : <DownloadIcon />}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
