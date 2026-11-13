import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { FabricLibraryGrid, useFabricLibrary } from "../components/FabricLibrary";
import { PhotoPickStatus } from "../components/PhotoPickStatus";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { compressImage, PHOTO_READ_ERROR } from "../lib/compressImage";
import { debugLog, debugLogPicked } from "../lib/debugLog";
import { FABRIC_IMAGES_QUERY_KEY, useMe } from "../lib/queries";
import { uploadFabricPhoto } from "../lib/storage";
import type { FabricImageRow } from "../lib/types";
import { guessFileExtension, makeRandomSuffix } from "../lib/utils";

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

export function FabricSiloPage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const pickerMode = searchParams.get("picker") === "true" || searchParams.get("picker") === "1";

  const { data: me, error: meError } = useMe();
  const shopContext = me ?? null;

  // Same query as the grid below (and the Generate page's picker); react-query shares it.
  const {
    rows,
    hasMore: hasMoreRows,
    isLoading: loadingRows,
    error: fabricImagesError,
    refetch: refetchFabricImages
  } = useFabricLibrary();

  const [statusText, setStatusText] = useState("Loading fabric silo...");
  const skipStatusUpdateRef = useRef(false);

  const [addOpen, setAddOpen] = useState(false);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [draftPreviewUrl, setDraftPreviewUrl] = useState<string | null>(null);
  const [draftFabricCode, setDraftFabricCode] = useState("");
  const [draftFabricColor, setDraftFabricColor] = useState("");
  const [saving, setSaving] = useState(false);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const pageTitle = pickerMode ? "Select a Cloth" : "My Fabrics";

  useEffect(() => {
    if (!draftPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(draftPreviewUrl);
  }, [draftPreviewUrl]);

  useEffect(() => {
    if (meError) {
      setStatusText(`Failed to load shop context: ${meError instanceof Error ? meError.message : "Unknown error"}`);
    }
  }, [meError]);

  useEffect(() => {
    if (loadingRows) return;
    if (skipStatusUpdateRef.current) {
      skipStatusUpdateRef.current = false;
      return;
    }
    if (fabricImagesError) {
      setStatusText(`Failed to load fabric silo: ${fabricImagesError instanceof Error ? fabricImagesError.message : "Unknown error"}`);
      return;
    }
    setStatusText(rows.length ? `Loaded ${rows.length} fabric(s)` : "No fabrics saved yet.");
  }, [loadingRows, fabricImagesError, rows.length]);

  async function loadRows() {
    await refetchFabricImages();
  }

  function resetDraft() {
    setPhotoError(null);
    setDraftFile(null);
    setDraftPreviewUrl(null);
    setDraftFabricCode("");
    setDraftFabricColor("");
  }

  function closeAddSheet() {
    setAddOpen(false);
    resetDraft();
  }

  async function handleDraftFilePicked(file: File | null) {
    if (!file) return;
    setPhotoError(null);
    setPreparingPhoto(true);
    let compressed: File;
    try {
      compressed = await compressImage(file, 1600);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : PHOTO_READ_ERROR);
      return;
    } finally {
      setPreparingPhoto(false);
    }
    setDraftFile(compressed);
    setDraftPreviewUrl(URL.createObjectURL(compressed));
    setStatusText("Fabric image selected.");
  }

  function onCameraChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    void handleDraftFilePicked(file);
  }

  function onGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    void handleDraftFilePicked(file);
  }

  async function handleSaveFabric() {
    if (!accessToken || !shopContext || !draftFile) return;

    const fabricCode = draftFabricCode.trim();
    if (!fabricCode) {
      setStatusText("Fabric Code is required.");
      return;
    }

    setSaving(true);
    try {
      const ext = guessFileExtension(draftFile.name, draftFile.type);
      const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
      const storagePath = `${shopContext.shop_id}/${filename}`;

      setStatusText("Saving fabric...");
      await uploadFabricPhoto(storagePath, draftFile);

      const row = await apiFetch<FabricImageRow>("/fabric-images", accessToken, {
        method: "POST",
        body: JSON.stringify({
          storage_path: storagePath,
          original_filename: fabricCode,
          mime_type: draftFile.type || "image/jpeg",
          file_size_bytes: draftFile.size,
          width: null,
          height: null
        })
      });

      skipStatusUpdateRef.current = true;
      queryClient.setQueryData<InfiniteData<FabricImageRow[], number>>(FABRIC_IMAGES_QUERY_KEY, (prev) =>
        prev
          ? { ...prev, pages: [[row, ...(prev.pages[0] ?? [])], ...prev.pages.slice(1)] }
          : { pages: [[row]], pageParams: [0] }
      );
      void queryClient.invalidateQueries({ queryKey: FABRIC_IMAGES_QUERY_KEY });

      setStatusText(draftFabricColor.trim() ? `Saved ${fabricCode} (${draftFabricColor.trim()}).` : `Saved ${fabricCode}.`);
      closeAddSheet();
    } catch (err) {
      setStatusText(`Save failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  function selectFabric(row: FabricImageRow) {
    const returnTab = searchParams.get("returnTab");
    const slotId = searchParams.get("slotId");

    if (returnTab === "multi" && slotId) {
      navigate(
        `/generate?tab=multi&slot_id=${encodeURIComponent(slotId)}&fabric_image_id=${encodeURIComponent(row.id)}`
      );
      return;
    }

    navigate(`/generate?fabric_image_id=${encodeURIComponent(row.id)}`);
  }

  return (
    <main className="screen catalog-screen">
      <section className="catalog-shell">
        <header className="catalog-header">
          <div className="catalog-header-left">
            <div className="catalog-title-wrap">
              <h1 className="catalog-title">{pageTitle}</h1>
              {/* With more pages to come only the loaded count is known, so it gets a "+". */}
              <p className="catalog-subtitle">
                {rows.length}
                {hasMoreRows ? "+" : ""} cloths saved
              </p>
            </div>
          </div>

          <div className="catalog-header-actions">
            <button
              className="catalog-icon-btn"
              onClick={() => void loadRows()}
              disabled={loadingRows}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
          </div>
        </header>

        <section className="card stack-sm">
          <p className="tiny muted">{statusText}</p>
        </section>

        {addOpen ? (
          <section className="card stack-sm">
            <h2>Add New Cloth</h2>

            <div className="row">
              <button
                className="btn btn-light flex-1"
                type="button"
                onClick={() => {
                  debugLog("input clicked");
                  cameraInputRef.current?.click();
                }}
                disabled={saving}
              >
                Capture
              </button>
              <button
                className="btn btn-light flex-1"
                type="button"
                onClick={() => {
                  debugLog("input clicked");
                  galleryInputRef.current?.click();
                }}
                disabled={saving}
              >
                Gallery
              </button>
            </div>

            <PhotoPickStatus preparing={preparingPhoto} error={photoError} />

            {draftPreviewUrl ? (
              <img className="preview-image" src={draftPreviewUrl} alt="Fabric preview" />
            ) : (
              <div className="preview-placeholder">Capture or choose a fabric image</div>
            )}

            <label className="field">
              <span>Cloth Code <strong>*</strong></span>
              <input
                type="text"
                value={draftFabricCode}
                onChange={(event) => setDraftFabricCode(event.target.value)}
                placeholder="e.g. F123"
                disabled={saving}
              />
            </label>

            <label className="field">
              <span>Colour</span>
              <input
                type="text"
                value={draftFabricColor}
                onChange={(event) => setDraftFabricColor(event.target.value)}
                placeholder="e.g. Navy Blue"
                disabled={saving}
              />
            </label>

            <div className="row">
              <button
                className="btn btn-dark flex-1"
                type="button"
                onClick={() => void handleSaveFabric()}
                disabled={saving || !draftFile || !draftFabricCode.trim()}
              >
                {saving ? "Saving..." : "Save Cloth"}
              </button>
              <button className="btn btn-light flex-1" type="button" onClick={closeAddSheet} disabled={saving}>
                Cancel
              </button>
            </div>

            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="visually-hidden-input"
              tabIndex={-1}
              aria-hidden
              onChange={onCameraChange}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="visually-hidden-input"
              tabIndex={-1}
              aria-hidden
              onChange={onGalleryChange}
            />
          </section>
        ) : null}

        <FabricLibraryGrid
          variant="silo"
          onSelect={pickerMode ? selectFabric : undefined}
          emptyText="No cloths saved yet. Tap + to add your first cloth."
        />

        <div className="fab-wrap">
          <button
            className="fab-btn"
            type="button"
            onClick={() => setAddOpen(true)}
            disabled={saving}
            aria-label="Add fabric"
            title="Add fabric"
          >
            <svg viewBox="0 0 24 24" aria-hidden focusable="false">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </section>
    </main>
  );
}
