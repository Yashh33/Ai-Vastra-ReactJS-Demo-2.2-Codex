import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { createSignedUrl, uploadToStorage } from "../lib/storage";
import type {
  FabricImageRow,
  FolderRow,
  GenerationCreateResponse,
  GenerationRow,
  HeroImageRow,
  ShopContext
} from "../lib/types";
import { guessFileExtension, isPendingStatus, makeRandomSuffix } from "../lib/utils";

export function VisualizePage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [shopContext, setShopContext] = useState<ShopContext | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [heroImages, setHeroImages] = useState<HeroImageRow[]>([]);

  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedHeroImageId, setSelectedHeroImageId] = useState("");
  const [selectedHeroPreviewUrl, setSelectedHeroPreviewUrl] = useState<string | null>(null);

  const [selectedFabricImage, setSelectedFabricImage] = useState<FabricImageRow | null>(null);
  const [selectedFabricPreviewUrl, setSelectedFabricPreviewUrl] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [uploadingFabric, setUploadingFabric] = useState(false);
  const [creatingGeneration, setCreatingGeneration] = useState(false);
  const [visualizingGenerationId, setVisualizingGenerationId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Preparing Visualize screen...");

  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId) ?? null,
    [folders, selectedFolderId]
  );

  const selectedHero = useMemo(
    () => heroImages.find((hero) => hero.id === selectedHeroImageId) ?? null,
    [heroImages, selectedHeroImageId]
  );

  const actionBusy = loading || uploadingFabric || creatingGeneration || !!visualizingGenerationId;

  async function loadInitialData() {
    if (!accessToken) return;
    setLoading(true);
    try {
      const [me, folderRows] = await Promise.all([
        apiFetch<ShopContext>("/me", accessToken, { method: "GET" }),
        apiFetch<FolderRow[]>("/folders?include_inactive=true", accessToken, { method: "GET" })
      ]);

      setShopContext(me);
      setFolders(folderRows);
      setStatusText("Ready to visualize.");
    } catch (err) {
      setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadHeroImagesForFolder(folderId: string) {
    if (!accessToken || !folderId) {
      setHeroImages([]);
      return;
    }
    try {
      const rows = await apiFetch<HeroImageRow[]>(
        `/hero-images?folder_id=${encodeURIComponent(folderId)}&limit=100`,
        accessToken,
        { method: "GET" }
      );
      setHeroImages(rows);
    } catch (err) {
      setStatusText(`Failed to load hero images: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  useEffect(() => {
    loadInitialData();
  }, [accessToken]);

  useEffect(() => {
    const pickedFolderId = searchParams.get("pickedHeroFolderId") ?? "";
    const pickedHeroId = searchParams.get("pickedHeroImageId") ?? "";
    if (!pickedFolderId || !pickedHeroId) return;

    setSelectedFolderId(pickedFolderId);
    setSelectedHeroImageId(pickedHeroId);
    setStatusText("Hero image selected.");
  }, [searchParams]);

  useEffect(() => {
    if (!selectedFolderId) return;
    void loadHeroImagesForFolder(selectedFolderId);
  }, [selectedFolderId, accessToken]);

  useEffect(() => {
    if (!selectedHero?.storage_path) {
      setSelectedHeroPreviewUrl(null);
      return;
    }
    createSignedUrl("hero-images", selectedHero.storage_path, 3600)
      .then((signed) => setSelectedHeroPreviewUrl(signed))
      .catch(() => setSelectedHeroPreviewUrl(null));
  }, [selectedHero?.id, selectedHero?.storage_path]);

  useEffect(() => {
    if (!selectedFabricImage?.storage_path) {
      setSelectedFabricPreviewUrl(null);
      return;
    }
    createSignedUrl("fabric-images", selectedFabricImage.storage_path, 3600)
      .then((signed) => setSelectedFabricPreviewUrl(signed))
      .catch(() => setSelectedFabricPreviewUrl(null));
  }, [selectedFabricImage?.id, selectedFabricImage?.storage_path]);

  useEffect(() => {
    if (!accessToken || !visualizingGenerationId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const row = await apiFetch<GenerationRow>(`/generations/${visualizingGenerationId}`, accessToken, {
          method: "GET"
        });

        if (cancelled) return;

        if (row.status === "done") {
          setVisualizingGenerationId(null);
          setStatusText("Visualization ready.");
          navigate(`/output-viewer?generationId=${encodeURIComponent(row.id)}`);
          return;
        }

        if (row.status === "failed") {
          setVisualizingGenerationId(null);
          setStatusText(row.error || "Generation failed.");
          return;
        }

        if (isPendingStatus(row.status)) {
          setStatusText("Visualizing...");
        }
      } catch (err) {
        if (cancelled) return;
        setStatusText(`Generation status failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    };

    void poll();
    const timer = window.setInterval(poll, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visualizingGenerationId, accessToken, navigate]);

  async function handleFabricPicked(file: File | null) {
    if (!file || !accessToken || !shopContext) return;
    setUploadingFabric(true);
    try {
      const ext = guessFileExtension(file.name, file.type);
      const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
      const storagePath = `${shopContext.shop_id}/${filename}`;

      setStatusText("Uploading fabric image...");
      await uploadToStorage("fabric-images", storagePath, file);

      const row = await apiFetch<FabricImageRow>("/fabric-images", accessToken, {
        method: "POST",
        body: JSON.stringify({
          storage_path: storagePath,
          original_filename: file.name || filename,
          mime_type: file.type || "image/jpeg",
          file_size_bytes: file.size,
          width: null,
          height: null
        })
      });

      setSelectedFabricImage(row);
      setStatusText("Fabric image selected.");
    } catch (err) {
      setStatusText(`Fabric upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setUploadingFabric(false);
      if (galleryInputRef.current) galleryInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  function onFabricGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFabricPicked(event.target.files?.[0] ?? null);
  }

  function onFabricCameraChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFabricPicked(event.target.files?.[0] ?? null);
  }

  async function handleCreateGeneration() {
    if (!accessToken) return;
    if (!selectedHeroImageId) {
      setStatusText("Select a hero image first.");
      return;
    }
    if (!selectedFabricImage?.id) {
      setStatusText("Upload or capture a fabric image first.");
      return;
    }

    setCreatingGeneration(true);
    try {
      setStatusText("Creating generation job...");
      const response = await apiFetch<GenerationCreateResponse>("/generations", accessToken, {
        method: "POST",
        body: JSON.stringify({
          hero_image_id: selectedHeroImageId,
          fabric_image_id: selectedFabricImage.id
        })
      });

      setVisualizingGenerationId(response.id);
      setStatusText("Visualizing...");
    } catch (err) {
      setStatusText(`Generate failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setCreatingGeneration(false);
    }
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="page-header">
          <div>
            <h1>Visualize</h1>
            <p className="muted">Select hero image + fabric image, then generate.</p>
          </div>
          <button className="btn btn-light" onClick={() => navigate(-1)}>
            Back
          </button>
        </header>

        <section className="card stack-sm">
          <p className="tiny">{statusText}</p>
        </section>

        <section className="card stack-sm">
          <div className="between">
            <h2>Hero Image Selection</h2>
            <button
              className="btn btn-dark"
              onClick={() => navigate("/hero-folders?picker=1")}
              disabled={actionBusy}
            >
              Select Hero Image
            </button>
          </div>

          {selectedHeroPreviewUrl ? (
            <img className="preview-image" src={selectedHeroPreviewUrl} alt="Selected hero" />
          ) : (
            <div className="preview-placeholder">No hero image selected yet</div>
          )}
          {selectedFolder?.name ? <p className="tiny muted">Folder: {selectedFolder.name}</p> : null}
        </section>

        <section className="card stack-sm">
          <h2>Fabric Image Selection</h2>
          {selectedFabricPreviewUrl ? (
            <img className="preview-image" src={selectedFabricPreviewUrl} alt="Selected fabric" />
          ) : (
            <div className="preview-placeholder">Capture or choose a fabric image</div>
          )}

          <div className="row">
            <button
              className="btn btn-light flex-1"
              onClick={() => cameraInputRef.current?.click()}
              disabled={actionBusy}
            >
              Capture
            </button>
            <button
              className="btn btn-light flex-1"
              onClick={() => galleryInputRef.current?.click()}
              disabled={actionBusy}
            >
              Gallery
            </button>
          </div>

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={onFabricCameraChange}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onFabricGalleryChange}
          />
        </section>

        <section className="card stack-sm">
          <h2>Generate</h2>
          <button
            className="btn btn-dark"
            disabled={actionBusy || !selectedHeroImageId || !selectedFabricImage?.id}
            onClick={handleCreateGeneration}
          >
            {creatingGeneration ? "Starting..." : "Generate"}
          </button>

          {visualizingGenerationId ? (
            <div className="loading-box">
              <div className="spinner" />
              <p className="tiny muted">Visualizing...</p>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
