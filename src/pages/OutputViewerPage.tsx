import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { buildGenerationDownloadFilename, triggerBrowserDownload } from "../lib/download";
import type { DownloadUrlResponse, GenerationRow } from "../lib/types";
import { isPendingStatus, withCacheBust } from "../lib/utils";

export function OutputViewerPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const generationId = searchParams.get("generationId") ?? "";
  const externalImageUrl = searchParams.get("imageUrl") ?? "";
  const externalTitle = searchParams.get("title") ?? "Image Viewer";
  const refreshNonce = searchParams.get("refreshNonce") ?? "";
  const viewMode = searchParams.get("mode") ?? "";
  const catalogFolderId = searchParams.get("catalogFolderId") ?? "";
  const catalogFolderName = searchParams.get("catalogFolderName") ?? "Catalog";

  const [generation, setGeneration] = useState<GenerationRow | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(externalImageUrl || null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [statusText, setStatusText] = useState("Loading image...");
  const [catalogRows, setCatalogRows] = useState<GenerationRow[]>([]);

  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const generationMode = !!generationId;
  const catalogMode = generationMode && viewMode === "catalog";
  const generationReady = !!generation && generation.status === "done" && !!generation.output_path;

  const catalogVisibleRows = useMemo(
    () => catalogRows.filter((row) => row.status === "done" && !!row.output_path),
    [catalogRows]
  );

  const catalogIndex = useMemo(
    () => catalogVisibleRows.findIndex((row) => row.id === generationId),
    [catalogVisibleRows, generationId]
  );

  const canNavigateCatalog = catalogMode && catalogVisibleRows.length > 1 && catalogIndex >= 0;

  const title = useMemo(() => {
    if (catalogMode) return `${catalogFolderName} Catalog`;
    if (generationMode) return "Output Viewer";
    return externalTitle;
  }, [catalogMode, catalogFolderName, generationMode, externalTitle]);

  async function fetchDownloadUrl(id: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<DownloadUrlResponse>(`/generations/${id}/download-url`, accessToken, {
      method: "GET"
    });
    return withCacheBust(response.download_url);
  }

  async function loadGenerationView() {
    if (!accessToken || !generationId) return;

    setLoading(true);
    try {
      const row = await apiFetch<GenerationRow>(`/generations/${generationId}`, accessToken, {
        method: "GET"
      });
      setGeneration(row);

      if (row.status === "done" && row.output_path) {
        const signed = await fetchDownloadUrl(generationId);
        setImageUrl(signed);
        setStatusText(catalogMode ? "Catalog image" : "Output ready");
      } else if (isPendingStatus(row.status)) {
        setImageUrl(null);
        setStatusText("Visualizing...");
      } else {
        setImageUrl(null);
        setStatusText(row.error || "Output not available");
      }
    } catch (err) {
      setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadCatalogRows() {
    if (!catalogMode || !accessToken || !catalogFolderId) {
      setCatalogRows([]);
      return;
    }

    try {
      const rows = await apiFetch<GenerationRow[]>(
        `/generations?status=done&folder_id=${encodeURIComponent(catalogFolderId)}&limit=100`,
        accessToken,
        { method: "GET" }
      );
      setCatalogRows(rows);
    } catch {
      setCatalogRows([]);
    }
  }

  useEffect(() => {
    if (!generationMode) {
      setStatusText(externalImageUrl ? "Image loaded" : "No image supplied");
      return;
    }
    void loadGenerationView();
  }, [generationId, generationMode, accessToken, refreshNonce, catalogMode]);

  useEffect(() => {
    if (!accessToken || !generationId || !isPendingStatus(generation?.status)) return;
    const timer = window.setInterval(() => {
      void loadGenerationView();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [accessToken, generationId, generation?.status]);

  useEffect(() => {
    void loadCatalogRows();
  }, [catalogMode, accessToken, catalogFolderId]);

  async function handleDownload() {
    if (!generationMode || !generation?.output_path || !generationId) return;
    setDownloading(true);
    try {
      const fresh = await fetchDownloadUrl(generationId);
      setImageUrl(fresh);
      triggerBrowserDownload(
        fresh,
        buildGenerationDownloadFilename(generationId, generation.output_path, fresh)
      );
      setStatusText("Download started");
    } catch (err) {
      setStatusText(`Download failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setDownloading(false);
    }
  }

  function handleMatchColor() {
    if (!generationId) return;
    navigate(`/match-color?generationId=${encodeURIComponent(generationId)}`);
  }

  function handleClose() {
    if (catalogMode && catalogFolderId) {
      const params = new URLSearchParams({ folderName: catalogFolderName });
      navigate(`/catalog/folders/${encodeURIComponent(catalogFolderId)}?${params.toString()}`);
      return;
    }
    navigate(-1);
  }

  function goToCatalogIndex(nextIndex: number) {
    if (!catalogMode || nextIndex < 0 || nextIndex >= catalogVisibleRows.length) return;
    const nextGeneration = catalogVisibleRows[nextIndex];
    if (!nextGeneration) return;

    const params = new URLSearchParams({
      generationId: nextGeneration.id,
      mode: "catalog",
      catalogFolderId,
      catalogFolderName
    });

    navigate(`/output-viewer?${params.toString()}`, { replace: true });
  }

  function handleCatalogPrev() {
    if (!canNavigateCatalog) return;
    const total = catalogVisibleRows.length;
    const nextIndex = (catalogIndex - 1 + total) % total;
    goToCatalogIndex(nextIndex);
  }

  function handleCatalogNext() {
    if (!canNavigateCatalog) return;
    const total = catalogVisibleRows.length;
    const nextIndex = (catalogIndex + 1) % total;
    goToCatalogIndex(nextIndex);
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (!catalogMode) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (!catalogMode || !swipeStartRef.current) return;

    const touch = event.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - swipeStartRef.current.x;
    const dy = touch.clientY - swipeStartRef.current.y;
    swipeStartRef.current = null;

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx < 60 || absDx < absDy * 1.2) return;

    if (dx < 0) {
      handleCatalogNext();
      return;
    }

    handleCatalogPrev();
  }

  return (
    <main className="screen viewer-screen">
      <section className="page-shell viewer-shell">
        <header className="page-header">
          <h1>{title}</h1>
        </header>

        <p className="tiny muted">{statusText}</p>

        <section
          className="viewer-card"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {loading ? (
            <div className="loading-box dark">
              <div className="spinner" />
            </div>
          ) : imageUrl ? (
            <img src={imageUrl} alt={title} />
          ) : (
            <div className="loading-box dark">
              {isPendingStatus(generation?.status) ? <div className="spinner" /> : null}
              <p className="tiny muted-light">
                {isPendingStatus(generation?.status)
                  ? "Visualizing..."
                  : generation?.error || "No image available"}
              </p>
            </div>
          )}
        </section>

        <footer className="row">
          {catalogMode ? (
            <button className="btn btn-light flex-1" onClick={handleCatalogPrev} disabled={!canNavigateCatalog}>
              Previous
            </button>
          ) : null}

          {generationMode && !generationReady ? (
            <button className="btn btn-light flex-1" onClick={loadGenerationView} disabled={loading || downloading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          ) : null}

          {generationMode && !catalogMode ? (
            <button
              className="btn btn-light flex-1"
              onClick={handleDownload}
              disabled={downloading || !generationReady}
            >
              {downloading ? "Preparing..." : "Download"}
            </button>
          ) : null}

          {generationMode && generationReady && !catalogMode ? (
            <button className="btn btn-dark flex-1" onClick={handleMatchColor} disabled={downloading || loading}>
              Match Color
            </button>
          ) : null}

          {!generationMode ? (
            <button className="btn btn-light flex-1" onClick={handleClose}>
              Close
            </button>
          ) : null}

          {generationMode && catalogMode ? (
            <button className="btn btn-light flex-1" onClick={handleClose}>
              Back to Folder
            </button>
          ) : null}

          {catalogMode ? (
            <button className="btn btn-light flex-1" onClick={handleCatalogNext} disabled={!canNavigateCatalog}>
              Next
            </button>
          ) : null}
        </footer>

        {catalogMode ? (
          <p className="tiny muted">
            {canNavigateCatalog
              ? `Swipe left/right or use Previous/Next (${catalogIndex + 1}/${catalogVisibleRows.length})`
              : "Swipe navigation is available when this folder has multiple outputs."}
          </p>
        ) : null}
      </section>
    </main>
  );
}


