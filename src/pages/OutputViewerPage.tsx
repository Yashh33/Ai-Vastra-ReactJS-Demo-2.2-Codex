import { useEffect, useMemo, useState } from "react";
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

  const [generation, setGeneration] = useState<GenerationRow | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(externalImageUrl || null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [statusText, setStatusText] = useState("Loading image...");

  const generationMode = !!generationId;
  const generationReady = !!generation && generation.status === "done" && !!generation.output_path;

  const title = useMemo(() => {
    if (generationMode) return "Output Viewer";
    return externalTitle;
  }, [generationMode, externalTitle]);

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
        setStatusText("Output ready");
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

  useEffect(() => {
    if (!generationMode) {
      setStatusText(externalImageUrl ? "Image loaded" : "No image supplied");
      return;
    }
    void loadGenerationView();
  }, [generationId, generationMode, accessToken, refreshNonce]);

  useEffect(() => {
    if (!accessToken || !generationId || !isPendingStatus(generation?.status)) return;
    const timer = window.setInterval(() => {
      void loadGenerationView();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [accessToken, generationId, generation?.status]);

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

  return (
    <main className="screen viewer-screen">
      <section className="page-shell viewer-shell">
        <header className="page-header">
          <h1>{title}</h1>
          <button className="btn btn-light" onClick={() => navigate(-1)}>
            Close
          </button>
        </header>

        <p className="tiny muted">{statusText}</p>

        <section className="viewer-card">
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
          {generationMode && !generationReady ? (
            <button className="btn btn-light flex-1" onClick={loadGenerationView} disabled={loading || downloading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          ) : null}

          {generationMode ? (
            <button
              className="btn btn-light flex-1"
              onClick={handleDownload}
              disabled={downloading || !generationReady}
            >
              {downloading ? "Preparing..." : "Download"}
            </button>
          ) : (
            <button className="btn btn-light flex-1" onClick={() => navigate(-1)}>
              Close
            </button>
          )}

          {generationMode && generationReady ? (
            <button className="btn btn-dark flex-1" onClick={handleMatchColor} disabled={downloading || loading}>
              Match Color
            </button>
          ) : null}
        </footer>
      </section>
    </main>
  );
}
