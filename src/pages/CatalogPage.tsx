import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DownloadUrlResponse, GarmentType, GenerationRow } from "../lib/types";
import { withCacheBust } from "../lib/utils";

type PreviewMap = Record<string, string>;

type GenerationTileProps = {
  row: GenerationRow;
  imageUrl?: string;
  onOpen: (row: GenerationRow) => void;
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

function getFabricSummaryLabel(row: GenerationRow) {
  const label = row.fabric_summary_label?.trim();
  if (!label) return "Garment";
  // Remove ": unknown" or ":unknown" suffix if present
  return label.replace(/:\s*unknown$/i, "").trim() || "Garment";
}

function GenerationTile({ row, imageUrl, onOpen, onVisible }: GenerationTileProps & { onVisible: (id: string) => void }) {
  const tileRef = useRef<HTMLElement | null>(null);
  const observedRef = useRef(false);

  useEffect(() => {
    const el = tileRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !observedRef.current) {
            observedRef.current = true;
            onVisible(row.id);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [row.id, onVisible]);

  return (
    <article ref={tileRef} className="catalog-tile">
      <button className="catalog-image-btn" onClick={() => onOpen(row)}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={getFabricSummaryLabel(row)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
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
  );
}

export function CatalogPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [garmentTypes, setGarmentTypes] = useState<GarmentType[]>([]);
  const [selectedGarmentId, setSelectedGarmentId] = useState("");
  const [generationRows, setGenerationRows] = useState<GenerationRow[]>([]);
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const [loadingGarments, setLoadingGarments] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [statusText, setStatusText] = useState("Select a garment type to view catalog");

  const selectedGarment = useMemo(
    () => garmentTypes.find((garment) => garment.id === selectedGarmentId) ?? null,
    [garmentTypes, selectedGarmentId]
  );

  const visibleRows = useMemo(
    () => generationRows.filter((row) => row.status === "done" && !!row.output_path),
    [generationRows]
  );

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    async function loadGarmentTypes() {
      if (!accessToken) return;
      setLoadingGarments(true);
      try {
        const rows = await apiFetch<GarmentType[]>("/garment-types", accessToken, { method: "GET" });
        if (cancelled) return;
        setGarmentTypes(rows);
        setStatusText(rows.length ? "Select a garment type to view catalog" : "No garment types found");
      } catch (err) {
        if (!cancelled) {
          setStatusText(`Failed to load garment types: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      } finally {
        if (!cancelled) setLoadingGarments(false);
      }
    }

    void loadGarmentTypes();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  async function loadGenerations(garment: GarmentType | null) {
    if (!accessToken || !garment) return;

    setLoadingRows(true);
    setPreviewUrls({});

    try {
      const rows = await apiFetch<GenerationRow[]>(
        `/generations?status=done&folder_id=${encodeURIComponent(garment.id)}&limit=100`,
        accessToken,
        { method: "GET" }
      );
      setGenerationRows(rows);
      setPreviewUrls({});
      setStatusText(rows.length ? `Loaded ${rows.length} look(s)` : "No looks generated for this garment yet");
    } catch (err) {
      setGenerationRows([]);
      setPreviewUrls({});
      setStatusText(`Failed to load catalog: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoadingRows(false);
    }
  }

  useEffect(() => {
    if (!selectedGarment) {
      setGenerationRows([]);
      setPreviewUrls({});
      setStatusText("Select a garment type to view catalog");
      return;
    }

    void loadGenerations(selectedGarment);
  }, [accessToken, selectedGarmentId]);

  async function getDownloadUrl(generationId: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<DownloadUrlResponse>(
      `/generations/${generationId}/download-url`,
      accessToken,
      { method: "GET" }
    );
    return withCacheBust(response.download_url);
  }

  const handleTileVisible = useCallback(async (id: string) => {
    if (!accessToken) return;
    try {
      const url = await getDownloadUrl(id);
      setPreviewUrls((prev) => ({ ...prev, [id]: url }));
    } catch (err) {
      console.error("Download URL failed for generation", id, err);
    }
  }, [accessToken]);

  function openViewer(row: GenerationRow) {
    const params = new URLSearchParams({
      generationId: row.id,
      mode: "catalog"
    });

    if (selectedGarment?.name) {
      params.set("catalogFolderName", selectedGarment.name);
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
              <h1 className="catalog-title">Catalog</h1>
              <p className="catalog-subtitle">{selectedGarment ? `${visibleRows.length} items` : "Garment type"}</p>
            </div>
          </div>

          <div className="catalog-header-actions">
            <button
              className="catalog-icon-btn"
              onClick={() => void loadGenerations(selectedGarment)}
              disabled={loadingRows || !selectedGarment}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
          </div>
        </header>

        <section className="card stack-sm">
          <label className="field">
            <span>Garment Type</span>
            <select
              className="select-input"
              value={selectedGarmentId}
              onChange={(event) => setSelectedGarmentId(event.target.value)}
              disabled={loadingGarments}
            >
              <option value="">{loadingGarments ? "Loading garment types..." : "Select garment type"}</option>
              {garmentTypes.map((garment) => (
                <option key={garment.id} value={garment.id}>
                  {garment.name}
                </option>
              ))}
            </select>
          </label>
          <p className="tiny muted">{statusText}</p>
        </section>

        {!selectedGarment ? (
          <div className="empty-box">Select a garment type to view catalog</div>
        ) : loadingRows ? (
          <div className="loading-box">
            <div className="spinner" />
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="empty-box">No looks generated for this garment yet</div>
        ) : (
          <section className="catalog-grid">
            {visibleRows.map((row) => (
              <GenerationTile
                key={row.id}
                row={row}
                imageUrl={previewUrls[row.id]}
                onOpen={openViewer}
                onVisible={handleTileVisible}
              />
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
