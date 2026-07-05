import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { compressImage } from "../lib/compressImage";
import { subscribeToGeneration } from "../lib/realtime";
import { createSignedUrl, uploadToStorage } from "../lib/storage";
import type {
  ApplyToTarget,
  FabricImageRow,
  FolderRow,
  GenerationCreateResponse,
  GenerationFabricAssignmentPayload,
  GenerationRow,
  HeroImageRow,
  ShopContext
} from "../lib/types";
import { guessFileExtension, isPendingStatus, makeRandomSuffix } from "../lib/utils";

type FabricDraft = {
  draftId: string;
  fabricImage: FabricImageRow | null;
  previewUrl: string | null;
  applyTo: ApplyToTarget | "";
  fabricCode: string;
  fabricColor: string;
};

const APPLY_TO_OPTIONS: Array<{ value: ApplyToTarget; label: string }> = [
  { value: "shirt", label: "Shirt" },
  { value: "pant", label: "Pant" },
  { value: "suit_full_body", label: "Suit-Full Body" },
  { value: "suit_upper", label: "Suit-Upper" },
  { value: "koti", label: "Koti" }
];

function createEmptyFabricDraft(): FabricDraft {
  return {
    draftId: makeRandomSuffix(),
    fabricImage: null,
    previewUrl: null,
    applyTo: "",
    fabricCode: "",
    fabricColor: ""
  };
}

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

  const [fabricDrafts, setFabricDrafts] = useState<FabricDraft[]>([createEmptyFabricDraft()]);
  const [activeFabricDraftId, setActiveFabricDraftId] = useState<string | null>(null);

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

  const configuredFabricCount = useMemo(
    () => fabricDrafts.filter((item) => item.fabricImage && item.applyTo && item.fabricCode.trim()).length,
    [fabricDrafts]
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
    if (!accessToken || !visualizingGenerationId) return;
    let cancelled = false;

    const handleStatusRow = (row: { id: string; status: string; error: string | null }) => {
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
    };

    const poll = async () => {
      try {
        const row = await apiFetch<GenerationRow>(`/generations/${visualizingGenerationId}`, accessToken, {
          method: "GET"
        });
        handleStatusRow(row);
      } catch (err) {
        if (cancelled) return;
        setStatusText(`Generation status failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    };

    void poll();
    const unsubscribe = subscribeToGeneration(visualizingGenerationId, handleStatusRow);
    const timer = window.setInterval(poll, 10000);

    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [visualizingGenerationId, accessToken, navigate]);

  async function handleFabricPicked(file: File | null, draftId: string | null) {
    if (!file || !accessToken || !shopContext || !draftId) return;
    setUploadingFabric(true);
    try {
      const compressedFile = await compressImage(file, 1600);
      const ext = guessFileExtension(compressedFile.name, compressedFile.type);
      const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
      const storagePath = `${shopContext.shop_id}/${filename}`;

      setStatusText("Uploading fabric image...");
      await uploadToStorage("fabric-images", storagePath, compressedFile);

      const row = await apiFetch<FabricImageRow>("/fabric-images", accessToken, {
        method: "POST",
        body: JSON.stringify({
          storage_path: storagePath,
          original_filename: compressedFile.name || filename,
          mime_type: compressedFile.type || "image/jpeg",
          file_size_bytes: compressedFile.size,
          width: null,
          height: null
        })
      });

      const preview = await createSignedUrl("fabric-images", row.storage_path, 3600).catch(() => null);

      setFabricDrafts((prev) =>
        prev.map((item) =>
          item.draftId === draftId
            ? {
                ...item,
                fabricImage: row,
                previewUrl: preview
              }
            : item
        )
      );

      setStatusText("Fabric image selected.");
    } catch (err) {
      setStatusText(`Fabric upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setUploadingFabric(false);
      setActiveFabricDraftId(null);
      if (galleryInputRef.current) galleryInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  function onFabricGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFabricPicked(event.target.files?.[0] ?? null, activeFabricDraftId);
  }

  function onFabricCameraChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFabricPicked(event.target.files?.[0] ?? null, activeFabricDraftId);
  }

  function openFabricPicker(draftId: string, mode: "camera" | "gallery") {
    if (actionBusy) return;
    setActiveFabricDraftId(draftId);
    if (mode === "camera") {
      cameraInputRef.current?.click();
      return;
    }
    galleryInputRef.current?.click();
  }

  function handleApplyToChange(draftId: string, value: string) {
    const normalized = value as ApplyToTarget | "";
    setFabricDrafts((prev) =>
      prev.map((item) =>
        item.draftId === draftId
          ? {
              ...item,
              applyTo: normalized
            }
          : item
      )
    );
  }

  function handleFabricCodeChange(draftId: string, value: string) {
    setFabricDrafts((prev) =>
      prev.map((item) =>
        item.draftId === draftId
          ? {
              ...item,
              fabricCode: value
            }
          : item
      )
    );
  }

  function handleFabricColorChange(draftId: string, value: string) {
    setFabricDrafts((prev) =>
      prev.map((item) =>
        item.draftId === draftId
          ? {
              ...item,
              fabricColor: value
            }
          : item
      )
    );
  }

  function handleAddFabric() {
    if (fabricDrafts.length >= 3) {
      setStatusText("Maximum 3 fabrics allowed in one generation.");
      return;
    }
    setFabricDrafts((prev) => [...prev, createEmptyFabricDraft()]);
  }

  function handleRemoveFabric(draftId: string) {
    setFabricDrafts((prev) => {
      if (prev.length <= 1) {
        return [createEmptyFabricDraft()];
      }
      return prev.filter((item) => item.draftId !== draftId);
    });
  }

  function buildGenerationFabrics(): GenerationFabricAssignmentPayload[] | null {
    const touched = fabricDrafts.filter((item) => item.fabricImage || item.applyTo || item.fabricCode.trim() || item.fabricColor.trim());

    if (!touched.length) {
      setStatusText("Upload at least one fabric image.");
      return null;
    }

    const payload: GenerationFabricAssignmentPayload[] = [];

    for (const [index, item] of touched.entries()) {
      if (!item.fabricImage?.id) {
        setStatusText(`Fabric image missing in slot ${index + 1}.`);
        return null;
      }
      if (!item.applyTo) {
        setStatusText(`Select Apply to for fabric slot ${index + 1}.`);
        return null;
      }
      const fabricCode = item.fabricCode.trim();
      if (!fabricCode) {
        setStatusText(`Enter Fabric Code for slot ${index + 1}.`);
        return null;
      }

      payload.push({
        fabric_image_id: item.fabricImage.id,
        apply_to: item.applyTo,
        fabric_code: fabricCode,
        fabric_color: item.fabricColor.trim() || null
      });
    }

    const targets = payload.map((item) => item.apply_to);
    const uniqueTargets = new Set(targets);
    if (uniqueTargets.size !== targets.length) {
      setStatusText("Duplicate Apply to values are not allowed.");
      return null;
    }

    if (payload.length > 1 && targets.includes("suit_full_body")) {
      setStatusText("Suit-Full Body cannot be combined with other Apply to values.");
      return null;
    }

    return payload;
  }

  async function handleCreateGeneration() {
    if (!accessToken) return;
    if (!selectedHeroImageId) {
      setStatusText("Select a hero image first.");
      return;
    }

    const generationFabrics = buildGenerationFabrics();
    if (!generationFabrics?.length) {
      return;
    }

    const primaryFabric = generationFabrics[0];
    if (!primaryFabric) {
      setStatusText("Upload at least one fabric image.");
      return;
    }

    setCreatingGeneration(true);
    try {
      setStatusText("Creating generation job...");
      const response = await apiFetch<GenerationCreateResponse>("/generations", accessToken, {
        method: "POST",
        body: JSON.stringify({
          hero_image_id: selectedHeroImageId,
          // Keep legacy field for backward-compatible backend paths.
          fabric_image_id: primaryFabric.fabric_image_id,
          fabrics: generationFabrics
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
            <p className="muted">Select hero image + one or more fabrics, then generate.</p>
          </div>
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
          <div className="between">
            <h2>Fabric Image Selection</h2>
            <span className="chip">{configuredFabricCount}/{fabricDrafts.length} configured</span>
          </div>

          {fabricDrafts.map((item, index) => (
            <article className="fabric-draft-card stack-sm" key={item.draftId}>
              <div className="between">
                <p className="tiny"><strong>Fabric {index + 1}</strong></p>
                {fabricDrafts.length > 1 ? (
                  <button
                    className="btn btn-light"
                    type="button"
                    onClick={() => handleRemoveFabric(item.draftId)}
                    disabled={actionBusy}
                  >
                    Remove
                  </button>
                ) : null}
              </div>

              {item.previewUrl ? (
                <img className="preview-image" src={item.previewUrl} alt={`Fabric ${index + 1}`} />
              ) : (
                <div className="preview-placeholder">Capture or choose a fabric image</div>
              )}

              <label className="field">
                <span>Apply to</span>
                <select
                  className="select-input"
                  value={item.applyTo}
                  onChange={(event) => handleApplyToChange(item.draftId, event.target.value)}
                  disabled={actionBusy}
                >
                  <option value="">Select target garment</option>
                  {APPLY_TO_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Fabric Code <strong>*</strong></span>
                <input
                  type="text"
                  value={item.fabricCode}
                  onChange={(event) => handleFabricCodeChange(item.draftId, event.target.value)}
                  disabled={actionBusy}
                  placeholder="e.g. F123"
                />
              </label>

              <label className="field">
                <span>Fabric Color (optional)</span>
                <input
                  type="text"
                  value={item.fabricColor}
                  onChange={(event) => handleFabricColorChange(item.draftId, event.target.value)}
                  disabled={actionBusy}
                  placeholder="e.g. Navy Blue"
                />
              </label>

              <div className="row">
                <button
                  className="btn btn-light flex-1"
                  onClick={() => openFabricPicker(item.draftId, "camera")}
                  disabled={actionBusy}
                >
                  Capture
                </button>
                <button
                  className="btn btn-light flex-1"
                  onClick={() => openFabricPicker(item.draftId, "gallery")}
                  disabled={actionBusy}
                >
                  Gallery
                </button>
              </div>
            </article>
          ))}

          <button className="btn btn-light" onClick={handleAddFabric} disabled={actionBusy || fabricDrafts.length >= 3}>
            Add Fabric
          </button>

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
            disabled={actionBusy || !selectedHeroImageId || configuredFabricCount === 0}
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




