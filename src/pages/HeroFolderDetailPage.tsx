import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { createSignedUrl, uploadToStorage } from "../lib/storage";
import type { FolderRow, HeroImageRow, ShopContext } from "../lib/types";
import { formatDateLabel, guessFileExtension, makeRandomSuffix } from "../lib/utils";

type PreviewMap = Record<string, string>;

export function HeroFolderDetailPage() {
  const { folderId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const pickerMode = useMemo(() => {
    const value = searchParams.get("picker");
    return value === "1" || value === "true";
  }, [searchParams]);

  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [shopContext, setShopContext] = useState<ShopContext | null>(null);
  const [folder, setFolder] = useState<FolderRow | null>(null);
  const [images, setImages] = useState<HeroImageRow[]>([]);
  const [previewUrls, setPreviewUrls] = useState<PreviewMap>({});
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [statusText, setStatusText] = useState("Loading folder...");

  const sortedImages = useMemo(
    () =>
      [...images].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [images]
  );

  async function loadFolderAndImages() {
    if (!accessToken || !folderId) return;
    setLoading(true);
    try {
      const [me, folders, heroImages] = await Promise.all([
        apiFetch<ShopContext>("/me", accessToken, { method: "GET" }),
        apiFetch<FolderRow[]>("/folders?include_inactive=true", accessToken, { method: "GET" }),
        apiFetch<HeroImageRow[]>(
          `/hero-images?folder_id=${encodeURIComponent(folderId)}&limit=100`,
          accessToken,
          { method: "GET" }
        )
      ]);

      setShopContext(me);
      const foundFolder = folders.find((row) => row.id === folderId) ?? null;
      setFolder(foundFolder);
      setImages(heroImages);
      setPreviewUrls({});
      setStatusText(foundFolder ? `Loaded ${heroImages.length} image(s)` : "Folder not found");
    } catch (err) {
      setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFolderAndImages();
  }, [accessToken, folderId]);

  useEffect(() => {
    if (!sortedImages.length) return;
    const missingRows = sortedImages.filter((row) => !previewUrls[row.id]);
    if (!missingRows.length) return;

    Promise.all(
      missingRows.map(async (row) => {
        try {
          const signed = await createSignedUrl("hero-images", row.storage_path, 3600);
          return { id: row.id, signed };
        } catch {
          return null;
        }
      })
    )
      .then((rows) => {
        const valid = rows.filter((row): row is { id: string; signed: string } => !!row);
        if (!valid.length) return;
        setPreviewUrls((prev) => {
          const next = { ...prev };
          for (const item of valid) next[item.id] = item.signed;
          return next;
        });
      })
      .catch(() => {
        // previews are best effort
      });
  }, [sortedImages, previewUrls]);

  async function handleUploadFile(file: File | null) {
    if (!file || !accessToken || !folderId || !shopContext) return;
    setUploading(true);
    try {
      const ext = guessFileExtension(file.name, file.type);
      const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
      const storagePath = `${shopContext.shop_id}/${folderId}/${filename}`;

      await uploadToStorage("hero-images", storagePath, file);
      await apiFetch<HeroImageRow>("/hero-images", accessToken, {
        method: "POST",
        body: JSON.stringify({
          folder_id: folderId,
          storage_path: storagePath,
          original_filename: file.name || filename,
          mime_type: file.type || "image/jpeg",
          file_size_bytes: file.size,
          width: null,
          height: null
        })
      });

      setStatusText("Hero image uploaded");
      await loadFolderAndImages();
    } catch (err) {
      setStatusText(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setUploading(false);
      if (galleryInputRef.current) galleryInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  function onGalleryPicked(event: ChangeEvent<HTMLInputElement>) {
    void handleUploadFile(event.target.files?.[0] ?? null);
  }

  function onCameraPicked(event: ChangeEvent<HTMLInputElement>) {
    void handleUploadFile(event.target.files?.[0] ?? null);
  }

  async function onImageClick(row: HeroImageRow) {
    let imageUrl = previewUrls[row.id] || "";
    if (!imageUrl) {
      try {
        imageUrl = await createSignedUrl("hero-images", row.storage_path, 3600);
      } catch {
        imageUrl = "";
      }
    }

    if (pickerMode) {
      const params = new URLSearchParams({
        pickedHeroImageId: row.id,
        pickedHeroFolderId: row.folder_id,
        pickedHeroImageNonce: String(Date.now())
      });
      navigate(`/visualize?${params.toString()}`, { replace: true });
      return;
    }

    const params = new URLSearchParams({
      mode: "hero-preview",
      imageId: row.id,
      folderId: row.folder_id,
      title: folder?.name ? `${folder.name} Hero Image` : "Hero Image"
    });
    if (imageUrl) params.set("imageUrl", imageUrl);
    navigate(`/output-viewer?${params.toString()}`);
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="page-header">
          <div>
            <h1>{folder?.name ?? "Hero Folder"}</h1>
            <p className="muted">
              {pickerMode
                ? "Picker mode: tap an image to use it in Visualize."
                : "Manage hero images. Tap any image to open detailed view."}
            </p>
          </div>
          <button className="btn btn-light" onClick={() => navigate(-1)}>
            Back
          </button>
        </header>

        <section className="card stack-sm">
          <h2>Add Hero Image</h2>
          <p className="tiny muted">{statusText}</p>
          <div className="row">
            <button
              className="btn btn-dark flex-1"
              onClick={() => galleryInputRef.current?.click()}
              disabled={uploading || loading}
            >
              {uploading ? "Uploading..." : "Add from Gallery"}
            </button>
            <button
              className="btn btn-light flex-1"
              onClick={() => cameraInputRef.current?.click()}
              disabled={uploading || loading}
            >
              Use Camera
            </button>
          </div>
          <button className="btn btn-light" onClick={loadFolderAndImages} disabled={loading || uploading}>
            {loading ? "Refreshing..." : "Refresh Images"}
          </button>

          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            onChange={onGalleryPicked}
            hidden
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onCameraPicked}
            hidden
          />
        </section>

        <section className="card">
          {loading ? (
            <div className="loading-box">
              <div className="spinner" />
            </div>
          ) : sortedImages.length === 0 ? (
            <div className="empty-box">No hero images in this folder yet.</div>
          ) : (
            <div className="tile-grid">
              {sortedImages.map((row) => (
                <button key={row.id} className="image-tile" onClick={() => void onImageClick(row)}>
                  {previewUrls[row.id] ? (
                    <img src={previewUrls[row.id]} alt={row.original_filename ?? row.id} />
                  ) : (
                    <div className="image-placeholder">
                      <div className="spinner spinner-small" />
                    </div>
                  )}
                  {pickerMode ? <span className="tile-chip">Tap to Select</span> : null}
                  <span className="tiny muted">{formatDateLabel(row.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
