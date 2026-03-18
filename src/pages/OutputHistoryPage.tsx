import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { buildGenerationDownloadFilename, triggerBrowserDownload } from "../lib/download";
import type { DownloadUrlResponse, GenerationRow } from "../lib/types";
import { withCacheBust } from "../lib/utils";

type PreviewMap = Record<string, string>;

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

function PlaceholderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden focusable="false">
      <path
        d="M4 7h16v13H4zM9 7V5h6v2"
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

export function OutputHistoryPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState<GenerationRow[]>([]);
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Loading output history...");
  const [downloadingGenerationId, setDownloadingGenerationId] = useState<string | null>(null);
  const [deletingGenerationId, setDeletingGenerationId] = useState<string | null>(null);

  const visibleRows = useMemo(
    () => rows.filter((row) => row.status === "done" && !!row.output_path),
    [rows]
  );
  function getFabricSummaryLabel(row: GenerationRow) {
    const label = row.fabric_summary_label?.trim();
    return label || "Garment";
  }

  async function getDownloadUrl(generationId: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<DownloadUrlResponse>(
      `/generations/${generationId}/download-url`,
      accessToken,
      { method: "GET" }
    );
    return withCacheBust(response.download_url);
  }

  async function loadHistory() {
    if (!accessToken) return;
    setLoading(true);
    try {
      setPreviewUrls({});
      const rows = await apiFetch<GenerationRow[]>("/generations?status=done&limit=100", accessToken, {
        method: "GET"
      });
      setRows(rows);
      setStatusText(rows.length ? `Loaded ${rows.length} output image(s)` : "No outputs yet.");
    } catch (err) {
      setStatusText(`Failed to load output history: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHistory();
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
        // best effort previews
      });
  }, [accessToken, visibleRows, previewUrls]);

  async function handleQuickDownload(row: GenerationRow) {
    if (!row.output_path) return;
    setDownloadingGenerationId(row.id);
    try {
      const url = await getDownloadUrl(row.id);
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

      setRows((prev) => prev.filter((item) => item.id !== row.id));
      setPreviewUrls((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });

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
            <button className="catalog-back-btn" onClick={() => navigate(-1)} aria-label="Back">
              <span aria-hidden>&larr;</span>
            </button>

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
              onClick={loadHistory}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
            <button className="catalog-icon-btn" aria-label="Icon placeholder" title="Icon slot">
              <PlaceholderIcon />
            </button>
          </div>
        </header>

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
                  {previewUrls[row.id] ? (
                    <img className="catalog-image" src={previewUrls[row.id]} alt={`Output ${row.id}`} />
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
                      onClick={() => handleDeleteGeneration(row)}
                      disabled={deletingGenerationId === row.id || downloadingGenerationId === row.id}
                      aria-label="Delete output"
                    >
                      {deletingGenerationId === row.id ? "..." : <DeleteIcon />}
                    </button>
                    <button
                      className="catalog-chip-btn catalog-chip-download"
                      onClick={() => handleQuickDownload(row)}
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

