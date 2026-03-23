import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type {
  CatalogImageDownloadUrlResponse,
  CatalogImageRow,
  DownloadUrlResponse,
  GenerationRow,
} from "../lib/types";
import { withCacheBust } from "../lib/utils";

type PreviewMap = Record<string, string>;

type CatalogCardItem = {
  key: string;
  kind: "catalog" | "generation";
  id: string;
  label: string;
  createdAtMs: number;
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

function toTimestamp(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCatalogLabel(row: CatalogImageRow) {
  const filename = (row.original_filename ?? "").trim();
  return filename || "Catalog Image";
}

function getGenerationLabel(row: GenerationRow) {
  const label = row.fabric_summary_label?.trim();
  return label || "Garment";
}

export function CatalogOutputsPage() {
  const { folderId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();

  const folderName = (searchParams.get("folderName") ?? "Folder").trim() || "Folder";

  const [catalogRows, setCatalogRows] = useState<CatalogImageRow[]>([]);
  const [generationRows, setGenerationRows] = useState<GenerationRow[]>([]);
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Loading folder images...");

  const visibleCatalogRows = useMemo(
    () => catalogRows.filter((row) => row.is_active !== false && !!row.storage_path),
    [catalogRows]
  );

  const visibleGenerationRows = useMemo(
    () => generationRows.filter((row) => row.status === "done" && !!row.output_path),
    [generationRows]
  );

  const visibleItems = useMemo<CatalogCardItem[]>(() => {
    const catalogItems: CatalogCardItem[] = visibleCatalogRows.map((row) => ({
      key: `catalog:${row.id}`,
      kind: "catalog",
      id: row.id,
      label: getCatalogLabel(row),
      createdAtMs: toTimestamp(row.created_at),
    }));

    const generationItems: CatalogCardItem[] = visibleGenerationRows.map((row) => ({
      key: `generation:${row.id}`,
      kind: "generation",
      id: row.id,
      label: getGenerationLabel(row),
      createdAtMs: toTimestamp(row.created_at),
    }));

    return [...catalogItems, ...generationItems].sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [visibleCatalogRows, visibleGenerationRows]);

  async function getCatalogDownloadUrl(catalogImageId: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<CatalogImageDownloadUrlResponse>(
      `/catalog-images/${catalogImageId}/download-url`,
      accessToken,
      { method: "GET" }
    );
    return withCacheBust(response.download_url);
  }

  async function getGenerationDownloadUrl(generationId: string) {
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
      const [fetchedCatalogRows, fetchedGenerationRows] = await Promise.all([
        apiFetch<CatalogImageRow[]>(`/catalog-images?folder_id=${encodeURIComponent(folderId)}&limit=200`, accessToken, {
          method: "GET",
        }),
        apiFetch<GenerationRow[]>(
          `/generations?status=done&folder_id=${encodeURIComponent(folderId)}&limit=200`,
          accessToken,
          {
            method: "GET",
          }
        ),
      ]);

      setCatalogRows(fetchedCatalogRows);
      setGenerationRows(fetchedGenerationRows);

      const catalogCount = fetchedCatalogRows.filter((row) => row.is_active !== false && !!row.storage_path).length;
      const generationCount = fetchedGenerationRows.filter((row) => row.status === "done" && !!row.output_path).length;
      const total = catalogCount + generationCount;

      setStatusText(
        total
          ? `Loaded ${total} item(s): ${generationCount} generated + ${catalogCount} catalog.`
          : "No images in this folder yet."
      );
    } catch (err) {
      setStatusText(`Failed to load folder images: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRows();
  }, [accessToken, folderId]);

  useEffect(() => {
    if (!accessToken || !visibleItems.length) return;

    const missing = visibleItems.filter((item) => !previewUrls[item.key]);
    if (!missing.length) return;

    Promise.all(
      missing.map(async (item) => {
        try {
          const url =
            item.kind === "catalog"
              ? await getCatalogDownloadUrl(item.id)
              : await getGenerationDownloadUrl(item.id);
          return { key: item.key, url };
        } catch {
          return null;
        }
      })
    )
      .then((items) => {
        const valid = items.filter((item): item is { key: string; url: string } => !!item);
        if (!valid.length) return;
        setPreviewUrls((prev) => {
          const next = { ...prev };
          for (const item of valid) next[item.key] = item.url;
          return next;
        });
      })
      .catch(() => {
        // best effort previews
      });
  }, [accessToken, visibleItems, previewUrls]);

  function openViewer(item: CatalogCardItem) {
    const params = new URLSearchParams({
      mode: "catalog",
      catalogFolderId: folderId,
      catalogFolderName: folderName,
    });

    if (item.kind === "catalog") {
      params.set("catalogImageId", item.id);
    } else {
      params.set("generationId", item.id);
    }

    navigate(`/output-viewer?${params.toString()}`);
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
              <h1 className="catalog-title">{folderName}</h1>
              <p className="catalog-subtitle">{visibleItems.length} items</p>
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
        ) : visibleItems.length === 0 ? (
          <div className="empty-box">No images available in this folder.</div>
        ) : (
          <section className="catalog-grid">
            {visibleItems.map((item) => (
              <article className="catalog-tile" key={item.key}>
                <button className="catalog-image-btn" onClick={() => openViewer(item)}>
                  {previewUrls[item.key] ? (
                    <img className="catalog-image" src={previewUrls[item.key]} alt={item.label} />
                  ) : (
                    <div className="image-placeholder">
                      <div className="spinner spinner-small" />
                    </div>
                  )}
                </button>

                <div className="catalog-meta-row">
                  <p className="catalog-garment-label">{item.label}</p>
                </div>
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
