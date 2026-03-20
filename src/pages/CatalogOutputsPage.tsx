import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
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

export function CatalogOutputsPage() {
  const { folderId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();

  const folderName = (searchParams.get("folderName") ?? "Folder").trim() || "Folder";

  const [rows, setRows] = useState<GenerationRow[]>([]);
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Loading outputs...");

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

  async function loadRows() {
    if (!accessToken || !folderId) return;
    setLoading(true);
    try {
      setPreviewUrls({});
      const fetchedRows = await apiFetch<GenerationRow[]>(
        `/generations?status=done&folder_id=${encodeURIComponent(folderId)}&limit=100`,
        accessToken,
        { method: "GET" }
      );
      setRows(fetchedRows);
      setStatusText(fetchedRows.length ? `Loaded ${fetchedRows.length} output image(s).` : "No outputs in this folder yet.");
    } catch (err) {
      setStatusText(`Failed to load outputs: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRows();
  }, [accessToken, folderId]);

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

  function openViewer(generationId: string) {
    const params = new URLSearchParams({
      generationId,
      mode: "catalog",
      catalogFolderId: folderId,
      catalogFolderName: folderName
    });
    navigate(`/output-viewer?${params.toString()}`);
  }

  return (
    <main className="screen catalog-screen">
      <section className="catalog-shell">
        <header className="catalog-header">
          <div className="catalog-header-left">
            <button
              className="catalog-back-btn"
              onClick={() => navigate("/catalog")}
              aria-label="Back to folders"
            >
              <span aria-hidden>&larr;</span>
            </button>

            <div className="catalog-brand-mark" aria-hidden>
              AV
            </div>

            <div className="catalog-title-wrap">
              <h1 className="catalog-title">{folderName}</h1>
              <p className="catalog-subtitle">{visibleRows.length} items</p>
            </div>
          </div>

          <div className="catalog-header-actions">
            <button className="catalog-icon-btn" onClick={loadRows} disabled={loading} aria-label="Refresh">
              <RefreshIcon />
            </button>
          </div>
        </header>

        <section className="card stack-sm">
          <p className="tiny muted">{statusText}</p>
          <p className="tiny muted">Catalog mode is read-only. Tap an image to open full view.</p>
        </section>

        {loading ? (
          <div className="loading-box">
            <div className="spinner" />
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="empty-box">No outputs available in this folder.</div>
        ) : (
          <section className="catalog-grid">
            {visibleRows.map((row) => (
              <article className="catalog-tile" key={row.id}>
                <button className="catalog-image-btn" onClick={() => openViewer(row.id)}>
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
                </div>
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
