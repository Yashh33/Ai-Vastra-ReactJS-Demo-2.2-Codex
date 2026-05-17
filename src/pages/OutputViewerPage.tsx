import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { buildGenerationDownloadFilename, triggerBrowserDownload } from "../lib/download";
import type {
  CatalogImageDownloadUrlResponse,
  CatalogImageRow,
  DownloadUrlResponse,
  GenerationRow,
} from "../lib/types";
import { isPendingStatus, withCacheBust } from "../lib/utils";

export function OutputViewerPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const generationId = searchParams.get("generationId") ?? "";
  const catalogImageId = searchParams.get("catalogImageId") ?? "";
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
  const [catalogGenerationRows, setCatalogGenerationRows] = useState<GenerationRow[]>([]);
  const [catalogImageRows, setCatalogImageRows] = useState<CatalogImageRow[]>([]);

  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const generationMode = !!generationId;
  const catalogImageMode = !!catalogImageId;
  const dataMode = generationMode || catalogImageMode;
  const catalogMode = dataMode && viewMode === "catalog";
  const generationReady = !!generation && generation.status === "done" && !!generation.output_path;

  const generationCatalogVisibleRows = useMemo(
    () => catalogGenerationRows.filter((row) => row.status === "done" && !!row.output_path),
    [catalogGenerationRows]
  );

  const catalogImageVisibleRows = useMemo(
    () => catalogImageRows.filter((row) => row.is_active !== false && !!row.storage_path),
    [catalogImageRows]
  );

  const activeCatalogCount = generationMode ? generationCatalogVisibleRows.length : catalogImageVisibleRows.length;

  const activeCatalogIndex = useMemo(() => {
    if (!catalogMode) return -1;
    if (generationMode) {
      return generationCatalogVisibleRows.findIndex((row) => row.id === generationId);
    }
    if (catalogImageMode) {
      return catalogImageVisibleRows.findIndex((row) => row.id === catalogImageId);
    }
    return -1;
  }, [
    catalogMode,
    generationMode,
    generationCatalogVisibleRows,
    generationId,
    catalogImageMode,
    catalogImageVisibleRows,
    catalogImageId,
  ]);

  const canNavigateCatalog = catalogMode && activeCatalogCount > 1 && activeCatalogIndex >= 0;

  const title = useMemo(() => {
    if (catalogMode) return catalogFolderName || "Catalog";
    if (generationMode) return "Output Viewer";
    if (catalogImageMode) return "Catalog Viewer";
    return externalTitle;
  }, [catalogMode, catalogFolderName, generationMode, catalogImageMode, externalTitle]);

  async function fetchGenerationDownloadUrl(id: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<DownloadUrlResponse>(`/generations/${id}/download-url`, accessToken, {
      method: "GET",
    });
    return withCacheBust(response.download_url);
  }

  async function fetchCatalogImageDownloadUrl(id: string) {
    if (!accessToken) throw new Error("Missing access token");
    const response = await apiFetch<CatalogImageDownloadUrlResponse>(`/catalog-images/${id}/download-url`, accessToken, {
      method: "GET",
    });
    return withCacheBust(response.download_url);
  }

  async function loadGenerationView() {
    if (!accessToken || !generationId) return;

    setLoading(true);
    try {
      const row = await apiFetch<GenerationRow>(`/generations/${generationId}`, accessToken, {
        method: "GET",
      });
      setGeneration(row);

      if (row.status === "done" && row.output_path) {
        const signed = await fetchGenerationDownloadUrl(generationId);
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

  async function loadCatalogImageView() {
    if (!catalogImageMode || !accessToken || !catalogImageId) return;

    setLoading(true);
    try {
      const signed = await fetchCatalogImageDownloadUrl(catalogImageId);
      setImageUrl(signed);
      setStatusText("Catalog image");
    } catch (err) {
      setImageUrl(null);
      setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadCatalogRows() {
    if (!catalogMode || !accessToken || !catalogFolderId) {
      setCatalogGenerationRows([]);
      setCatalogImageRows([]);
      return;
    }

    try {
      if (generationMode) {
        const rows = await apiFetch<GenerationRow[]>(
          `/generations?status=done&folder_id=${encodeURIComponent(catalogFolderId)}&limit=100`,
          accessToken,
          { method: "GET" }
        );
        setCatalogGenerationRows(rows);
        setCatalogImageRows([]);
        return;
      }

      const rows = await apiFetch<CatalogImageRow[]>(
        `/catalog-images?folder_id=${encodeURIComponent(catalogFolderId)}&limit=200`,
        accessToken,
        { method: "GET" }
      );
      setCatalogImageRows(rows);
      setCatalogGenerationRows([]);
    } catch {
      setCatalogGenerationRows([]);
      setCatalogImageRows([]);
    }
  }

  useEffect(() => {
    if (generationMode) {
      void loadGenerationView();
      return;
    }

    if (catalogImageMode) {
      void loadCatalogImageView();
      return;
    }

    setStatusText(externalImageUrl ? "Image loaded" : "No image supplied");
  }, [generationId, generationMode, catalogImageId, catalogImageMode, accessToken, refreshNonce, catalogMode]);

  useEffect(() => {
    if (!accessToken || !generationId || !isPendingStatus(generation?.status)) return;
    const timer = window.setInterval(() => {
      void loadGenerationView();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [accessToken, generationId, generation?.status]);

  useEffect(() => {
    void loadCatalogRows();
  }, [catalogMode, accessToken, catalogFolderId, generationMode]);

  async function handleDownload() {
    if (generationMode && generation?.output_path && generationId) {
      setDownloading(true);
      try {
        const fresh = await fetchGenerationDownloadUrl(generationId);
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
      return;
    }

    if (catalogImageMode && imageUrl && catalogImageId) {
      triggerBrowserDownload(imageUrl, `ai-vastra-catalog-${catalogImageId}.jpg`);
      setStatusText("Download started");
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
    if (!catalogMode || nextIndex < 0 || nextIndex >= activeCatalogCount) return;

    if (generationMode) {
      const nextGeneration = generationCatalogVisibleRows[nextIndex];
      if (!nextGeneration) return;

      const params = new URLSearchParams({
        generationId: nextGeneration.id,
        mode: "catalog",
        catalogFolderId,
        catalogFolderName,
      });

      navigate(`/output-viewer?${params.toString()}`, { replace: true });
      return;
    }

    if (catalogImageMode) {
      const nextCatalogImage = catalogImageVisibleRows[nextIndex];
      if (!nextCatalogImage) return;

      const params = new URLSearchParams({
        catalogImageId: nextCatalogImage.id,
        mode: "catalog",
        catalogFolderId,
        catalogFolderName,
      });

      navigate(`/output-viewer?${params.toString()}`, { replace: true });
    }
  }

  function handleCatalogPrev() {
    if (!canNavigateCatalog) return;
    const nextIndex = (activeCatalogIndex - 1 + activeCatalogCount) % activeCatalogCount;
    goToCatalogIndex(nextIndex);
  }

  function handleCatalogNext() {
    if (!canNavigateCatalog) return;
    const nextIndex = (activeCatalogIndex + 1) % activeCatalogCount;
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

        <section className="viewer-card" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
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
            <button className="btn btn-light flex-1" onClick={handleDownload} disabled={downloading || !generationReady}>
              {downloading ? "Preparing..." : "Download"}
            </button>
          ) : null}

          {generationMode && generationReady && !catalogMode ? (
            <button className="btn btn-dark flex-1" onClick={handleMatchColor} disabled={downloading || loading}>
              Match Color
            </button>
          ) : null}

          {!dataMode ? (
            <button className="btn btn-light flex-1" onClick={handleClose}>
              Close
            </button>
          ) : null}

          {dataMode && catalogMode ? (
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
              ? `Swipe left/right or use Previous/Next (${activeCatalogIndex + 1}/${activeCatalogCount})`
              : "Swipe navigation is available when this folder has multiple images."}
          </p>
        ) : null}
      </section>
    </main>
  );
}
