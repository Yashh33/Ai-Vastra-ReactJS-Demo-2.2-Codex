import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { useGarmentTypes, useGenerations } from "../lib/queries";
import type { GarmentType, GenerationRow } from "../lib/types";

const SHARE_CONCURRENCY = 4;

type GenerationTileProps = {
  row: GenerationRow;
  onOpen: (row: GenerationRow) => void;
  selectMode: boolean;
  isSelected: boolean;
  onSelectToggle: (id: string) => void;
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

function GenerationTile({ row, onOpen, selectMode, isSelected, onSelectToggle }: GenerationTileProps) {
  return (
    <article
      className="catalog-tile"
      style={{
        outline: isSelected ? "2.5px solid #C9A84C" : "none",
        outlineOffset: "-2px",
        position: "relative",
      }}
    >
      {isSelected && (
        <div style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          width: "22px",
          height: "22px",
          borderRadius: "50%",
          background: "#C9A84C",
          border: "2px solid white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 2,
          fontSize: "12px",
          color: "#1B1B2F",
          fontWeight: 700,
        }}>✓</div>
      )}
      <button className="catalog-image-btn" onClick={() => {
        if (selectMode) onSelectToggle(row.id);
        else onOpen(row);
      }}>
        {row.thumb_url ? (
          <img
            className="catalog-image"
            src={row.thumb_url}
            alt={getFabricSummaryLabel(row)}
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
      </div>
    </article>
  );
}

export function CatalogPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [selectedGarmentId, setSelectedGarmentId] = useState("");
  const [statusText, setStatusText] = useState("Select a garment type to view catalog");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);

  const {
    data: garmentTypesData,
    isLoading: loadingGarments,
    error: garmentTypesError
  } = useGarmentTypes();
  const garmentTypes = garmentTypesData ?? [];

  const selectedGarment = useMemo(
    () => garmentTypes.find((garment) => garment.id === selectedGarmentId) ?? null,
    [garmentTypes, selectedGarmentId]
  );

  const {
    data: generationRowsData,
    isFetching: loadingRows,
    error: generationsError,
    refetch: refetchGenerations
  } = useGenerations(
    { status: "done", folder_id: selectedGarmentId, limit: 100, include_urls: true },
    { enabled: !!selectedGarmentId }
  );
  const generationRows = generationRowsData ?? [];

  const visibleRows = useMemo(
    () => generationRows.filter((row) => row.status === "done" && !!row.output_path),
    [generationRows]
  );

  useEffect(() => {
    if (loadingGarments) return;
    if (garmentTypesError) {
      setStatusText(
        `Failed to load garment types: ${garmentTypesError instanceof Error ? garmentTypesError.message : "Unknown error"}`
      );
      return;
    }
    if (!selectedGarmentId) {
      setStatusText(garmentTypes.length ? "Select a garment type to view catalog" : "No garment types found");
    }
  }, [loadingGarments, garmentTypesError, garmentTypes.length, selectedGarmentId]);

  useEffect(() => {
    if (!selectedGarmentId) {
      setStatusText("Select a garment type to view catalog");
      return;
    }
    if (loadingRows) return;
    if (generationsError) {
      setStatusText(`Failed to load catalog: ${generationsError instanceof Error ? generationsError.message : "Unknown error"}`);
      return;
    }
    setStatusText(generationRows.length ? `Loaded ${generationRows.length} look(s)` : "No looks generated for this garment yet");
  }, [selectedGarmentId, loadingRows, generationsError, generationRows.length]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkShare = async () => {
    if (!accessToken || selectedIds.size === 0) return;
    setSharing(true);
    try {
      const ids = Array.from(selectedIds);
      const files: (File | null)[] = new Array(ids.length).fill(null);
      let cursor = 0;

      async function worker() {
        while (cursor < ids.length) {
          const index = cursor++;
          const id = ids[index];
          const url = generationRows.find((row) => row.id === id)?.download_url;
          if (!url) continue;
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            files[index] = new File([blob], `ai-vastra-look-${index + 1}.jpg`, { type: "image/jpeg" });
          } catch {
            // skip failed
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(SHARE_CONCURRENCY, ids.length) }, () => worker())
      );

      const validFiles = files.filter((file): file is File => !!file);
      if (validFiles.length === 0) return;
      if (navigator.share && navigator.canShare({ files: validFiles })) {
        await navigator.share({ files: validFiles });
      } else {
        for (const file of validFiles) {
          const url = URL.createObjectURL(file);
          window.open(url, "_blank");
        }
      }
      exitSelectMode();
    } catch {
      // cancelled or error
    } finally {
      setSharing(false);
    }
  };

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
            <div className="catalog-title-wrap">
              <h1 className="catalog-title">Lookbook</h1>
              <p className="catalog-subtitle">{selectedGarment ? `${visibleRows.length} looks` : "Style"}</p>
            </div>
          </div>

          <div className="catalog-header-actions">
            <button
              className="catalog-icon-btn"
              onClick={() => void refetchGenerations()}
              disabled={loadingRows || !selectedGarment}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
            <button
              onClick={() => {
                if (selectMode) exitSelectMode();
                else setSelectMode(true);
              }}
              style={{
                width: "34px",
                height: "34px",
                borderRadius: "50%",
                border: "0.5px solid var(--border)",
                background: selectMode ? "#1B1B2F" : "var(--white)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                color: selectMode ? "#C9A84C" : "var(--text-muted)",
              }}
              aria-label="Select images"
            >
              <svg viewBox="0 0 24 24" width="16" height="16"
                fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round">
                <circle cx="12" cy="12" r="9"/>
                <path d="M8 12l3 3 5-5"/>
              </svg>
            </button>
          </div>
        </header>

        <section className="card stack-sm">
          <h2>Select Style</h2>
          <div style={{
            display: "flex",
            gap: "8px",
            overflowX: "auto",
            scrollbarWidth: "none",
            msOverflowStyle: "none",
            paddingBottom: "4px",
            flexWrap: "nowrap",
          }}>
            {garmentTypes.map((garment) => (
              <button
                key={garment.id}
                className={`style-pill ${selectedGarmentId === garment.id ? "active" : ""}`}
                style={{ flexShrink: 0 }}
                type="button"
                onClick={() => setSelectedGarmentId(garment.id)}
                disabled={loadingGarments}
              >
                {garment.name}
              </button>
            ))}
          </div>
          {loadingGarments ? <p className="tiny muted">Loading garment types...</p> : null}
          <p className="tiny muted">{statusText}</p>
        </section>

        {!selectedGarment ? (
          <div className="empty-box">Select a style to view lookbook</div>
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
                onOpen={openViewer}
                selectMode={selectMode}
                isSelected={selectedIds.has(row.id)}
                onSelectToggle={toggleSelect}
              />
            ))}
          </section>
        )}

        {selectMode && (
          <div style={{
            position: "fixed",
            bottom: "65px",
            left: 0,
            right: 0,
            background: "#1B1B2F",
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            zIndex: 40,
          }}>
            <button
              onClick={exitSelectMode}
              style={{
                background: "transparent",
                border: "0.5px solid rgba(201,168,76,0.4)",
                borderRadius: "10px",
                color: "#C9A84C",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            <span style={{
              color: "rgba(201,168,76,0.7)",
              fontSize: "13px",
              fontWeight: 600,
            }}>
              {selectedIds.size} selected
            </span>
            <button
              onClick={handleBulkShare}
              disabled={sharing || selectedIds.size === 0}
              style={{
                background: "#C9A84C",
                border: "none",
                borderRadius: "10px",
                color: "#1B1B2F",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
                opacity: sharing ? 0.6 : 1,
              }}
            >
              {sharing
                ? "Preparing..."
                : `Share ${selectedIds.size} look${selectedIds.size > 1 ? "s" : ""}`
              }
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
