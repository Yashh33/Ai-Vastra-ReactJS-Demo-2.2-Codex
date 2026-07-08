import { useQueryClient } from "@tanstack/react-query";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { compressImage } from "../lib/compressImage";
import { useFabricImages, useMe } from "../lib/queries";
import { createSignedUrl, uploadToStorage } from "../lib/storage";
import type { FabricImageRow } from "../lib/types";
import { guessFileExtension, makeRandomSuffix } from "../lib/utils";

type PreviewMap = Record<string, string>;

type FabricTileProps = {
  row: FabricImageRow;
  imageUrl?: string;
  pickerMode: boolean;
  onSelect: (row: FabricImageRow) => void;
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

function getFabricLabel(row: FabricImageRow) {
  const label = row.original_filename?.trim();
  return label || "Fabric";
}

function FabricTile({ row, imageUrl, pickerMode, onSelect, onVisible }: FabricTileProps & { onVisible: (id: string) => void }) {
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
      <button
        className="catalog-image-btn"
        type="button"
        onClick={pickerMode ? () => onSelect(row) : undefined}
      >
        {imageUrl ? (
          <img
            className="catalog-image"
            src={imageUrl}
            alt="fabric"
          />
        ) : (
          <div className="image-placeholder">
            <div className="spinner spinner-small" />
          </div>
        )}
      </button>

      <div className="catalog-meta-row">
        <p className="catalog-garment-label">{getFabricLabel(row)}</p>
        {pickerMode ? (
          <button className="catalog-chip-btn catalog-chip-download" type="button" onClick={() => onSelect(row)}>
            Select
          </button>
        ) : null}
      </div>
    </article>
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

  const {
    data: fabricImagesData,
    isLoading: loadingRows,
    error: fabricImagesError,
    refetch: refetchFabricImages
  } = useFabricImages();
  const rows = fabricImagesData ?? [];

  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const [statusText, setStatusText] = useState("Loading fabric silo...");
  const skipStatusUpdateRef = useRef(false);

  const [addOpen, setAddOpen] = useState(false);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [draftPreviewUrl, setDraftPreviewUrl] = useState<string | null>(null);
  const [draftFabricCode, setDraftFabricCode] = useState("");
  const [draftFabricColor, setDraftFabricColor] = useState("");
  const [saving, setSaving] = useState(false);

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
    setPreviewUrls({});
    await refetchFabricImages();
  }

  function resetDraft() {
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
    const compressed = await compressImage(file, 1600);
    setDraftFile(compressed);
    setDraftPreviewUrl(URL.createObjectURL(compressed));
    setStatusText("Fabric image selected.");
  }

  function onCameraChange(event: ChangeEvent<HTMLInputElement>) {
    void handleDraftFilePicked(event.target.files?.[0] ?? null);
    event.target.value = "";
  }

  function onGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    void handleDraftFilePicked(event.target.files?.[0] ?? null);
    event.target.value = "";
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
      await uploadToStorage("fabric-images", storagePath, draftFile);

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

      createSignedUrl("fabric-images", row.storage_path, 3600)
        .then((url) => {
          setPreviewUrls((prev) => ({ ...prev, [row.id]: url }));
        })
        .catch((err) => {
          console.error("Signed URL failed for", row.storage_path, err);
        });

      skipStatusUpdateRef.current = true;
      queryClient.setQueryData<FabricImageRow[]>(["fabric-images"], (prev) => [row, ...(prev ?? [])]);
      void queryClient.invalidateQueries({ queryKey: ["fabric-images"] });

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

  const handleTileVisible = useCallback(async (id: string) => {
    if (!accessToken) return;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    try {
      const url = await createSignedUrl("fabric-images", row.storage_path, 3600);
      setPreviewUrls((prev) => ({ ...prev, [id]: url }));
    } catch (err) {
      console.error("Signed URL failed for", row.storage_path, err);
    }
  }, [accessToken, rows]);

  return (
    <main className="screen catalog-screen">
      <section className="catalog-shell">
        <header className="catalog-header">
          <div className="catalog-header-left">
            <div className="catalog-title-wrap">
              <h1 className="catalog-title">{pageTitle}</h1>
              <p className="catalog-subtitle">{rows.length} cloths saved</p>
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
                onClick={() => cameraInputRef.current?.click()}
                disabled={saving}
              >
                Capture
              </button>
              <button
                className="btn btn-light flex-1"
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                disabled={saving}
              >
                Gallery
              </button>
            </div>

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
              hidden
              onChange={onCameraChange}
            />
            <input ref={galleryInputRef} type="file" accept="image/*" hidden onChange={onGalleryChange} />
          </section>
        ) : null}

        {loadingRows ? (
          <div className="loading-box">
            <div className="spinner" />
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-box">No cloths saved yet. Tap + to add your first cloth.</div>
        ) : (
          <section className="catalog-grid">
            {rows.map((row) => (
              <FabricTile
                key={row.id}
                row={row}
                imageUrl={previewUrls[row.id]}
                pickerMode={pickerMode}
                onSelect={selectFabric}
                onVisible={handleTileVisible}
              />
            ))}
          </section>
        )}

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
