import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CustomerConsentModal } from "../components/CustomerConsentModal";
import { TryOnFlow } from "../components/TryOnFlow";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { createSignedUrl, uploadToStorage } from "../lib/storage";
import type {
  ApplyToTarget,
  FabricImageRow,
  GarmentType,
  GenerationCreateResponse,
  GenerationFabricAssignmentPayload,
  GenerationRow,
  HeroImageRow,
  ShopContext
} from "../lib/types";
import { guessFileExtension, isPendingStatus, makeRandomSuffix } from "../lib/utils";

type MeResponse = ShopContext & {
  credits?: number | string | null;
  credit_balance?: number | string | null;
  balance?: number | string | null;
  creditBalance?: number | string | null;
  current_balance?: number | string | null;
};

function extractCreditBalance(me: MeResponse) {
  const candidates = [
    me.credits,
    me.credit_balance,
    me.balance,
    me.creditBalance,
    me.current_balance
  ];

  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return String(numeric);
  }

  return "-";
}

function mapGarmentToApplyTo(garment: GarmentType): ApplyToTarget {
  const context = `${garment.name} ${garment.prompt_template}`.toLowerCase();

  if (context.includes("shirt")) return "shirt";
  if (context.includes("pant") || context.includes("trouser")) return "pant";
  if (context.includes("koti") || context.includes("vest")) return "koti";
  if (context.includes("upper")) return "suit_upper";

  return "suit_full_body";
}

async function findFabricImageById(accessToken: string, fabricImageId: string) {
  const pageSize = 100;

  for (let offset = 0; offset <= 1000; offset += pageSize) {
    const rows = await apiFetch<FabricImageRow[]>(
      `/fabric-images?limit=${pageSize}&offset=${offset}`,
      accessToken,
      { method: "GET" }
    );

    const match = rows.find((row) => row.id === fabricImageId);
    if (match) return match;
    if (rows.length < pageSize) return null;
  }

  return null;
}

const FINE_CHECKS_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" fill="#B8C8E0"/>
  ${Array.from({ length: 15 }, (_, i) => `<line x1="0" y1="${(i + 1) * 4}" x2="64" y2="${(i + 1) * 4}" stroke="#2B4B8A" stroke-width="0.7" opacity="0.7"/>`).join("")}
  ${Array.from({ length: 15 }, (_, i) => `<line x1="${(i + 1) * 4}" y1="0" x2="${(i + 1) * 4}" y2="64" stroke="#2B4B8A" stroke-width="0.7" opacity="0.7"/>`).join("")}
</svg>`;

const MEDIUM_CHECKS_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" fill="#B8C8E0"/>
  ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${(i + 1) * 8}" x2="64" y2="${(i + 1) * 8}" stroke="#2B4B8A" stroke-width="1.5" opacity="0.8"/>`).join("")}
  ${Array.from({ length: 7 }, (_, i) => `<line x1="${(i + 1) * 8}" y1="0" x2="${(i + 1) * 8}" y2="64" stroke="#2B4B8A" stroke-width="1.5" opacity="0.8"/>`).join("")}
</svg>`;

const BOLD_CHECKS_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" fill="#B8C8E0"/>
  ${Array.from({ length: 3 }, (_, i) => `<line x1="0" y1="${(i + 1) * 16}" x2="64" y2="${(i + 1) * 16}" stroke="#2B4B8A" stroke-width="3" opacity="0.9"/>`).join("")}
  ${Array.from({ length: 3 }, (_, i) => `<line x1="${(i + 1) * 16}" y1="0" x2="${(i + 1) * 16}" y2="64" stroke="#2B4B8A" stroke-width="3" opacity="0.9"/>`).join("")}
</svg>`;

export function GeneratePage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const pickedFabricImageId =
    searchParams.get("fabric_image_id") ?? searchParams.get("selectedFabricImageId") ?? "";

  const [shopContext, setShopContext] = useState<ShopContext | null>(null);
  const [creditBalance, setCreditBalance] = useState("-");
  const [garmentTypes, setGarmentTypes] = useState<GarmentType[]>([]);
  const [selectedGarmentId, setSelectedGarmentId] = useState("");

  const [fabricFile, setFabricFile] = useState<File | null>(null);
  const [existingFabricImage, setExistingFabricImage] = useState<FabricImageRow | null>(null);
  const [fabricPreviewUrl, setFabricPreviewUrl] = useState<string | null>(null);
  const [saveToSilo, setSaveToSilo] = useState(false);
  const [fabricCode, setFabricCode] = useState("");
  const [fabricColor, setFabricColor] = useState("");
  const [hasPattern, setHasPattern] = useState(false);
  const [fabricScale, setFabricScale] = useState<"fine" | "medium" | "bold" | null>(null);

  const [heroChangeOpen, setHeroChangeOpen] = useState(false);
  const [heroReplacementFile, setHeroReplacementFile] = useState<File | null>(null);
  const [heroReplacementPreviewUrl, setHeroReplacementPreviewUrl] = useState<string | null>(null);

  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingPickedFabric, setLoadingPickedFabric] = useState(false);
  const [creatingGeneration, setCreatingGeneration] = useState(false);
  const [visualizingGenerationId, setVisualizingGenerationId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Preparing Generate screen...");
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [showTryOnFlow, setShowTryOnFlow] = useState(false);

  const selectedGarment = useMemo(
    () => garmentTypes.find((garment) => garment.id === selectedGarmentId) ?? null,
    [garmentTypes, selectedGarmentId]
  );

  const selectedFabricImageId = existingFabricImage?.id ?? "";
  const selectedHeroPreviewUrl =
    heroReplacementPreviewUrl || selectedGarment?.hero_image_signed_url || null;

  const fabricReady = !!fabricFile || !!existingFabricImage?.id;
  const heroReady = !!heroReplacementFile || !!selectedGarment?.default_hero_image_id;
  const actionBusy = loadingInitial || loadingPickedFabric || creatingGeneration || !!visualizingGenerationId;
  const canGenerate =
    fabricReady &&
    !!selectedGarment &&
    heroReady &&
    (!saveToSilo || !!fabricCode.trim()) &&
    !actionBusy;

  const loadGarmentTypes = useCallback(async () => {
    if (!accessToken) return;

    setLoadingInitial(true);
    try {
      const garmentRows = await apiFetch<GarmentType[]>("/garment-types", accessToken, { method: "GET" });
      setGarmentTypes(garmentRows);
      setStatusText(garmentRows.length ? "Ready to generate." : "No garment types found.");
    } catch (err) {
      setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoadingInitial(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!fabricPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(fabricPreviewUrl);
  }, [fabricPreviewUrl]);

  useEffect(() => {
    if (!heroReplacementPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(heroReplacementPreviewUrl);
  }, [heroReplacementPreviewUrl]);

  useEffect(() => {
    void loadGarmentTypes();
  }, [loadGarmentTypes]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    async function loadInitialData() {
      if (!accessToken) return;
      try {
        const me = await apiFetch<MeResponse>("/me", accessToken, { method: "GET" });

        if (cancelled) return;

        setShopContext(me);
        setCreditBalance(extractCreditBalance(me));
      } catch (err) {
        if (!cancelled) {
          setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }
    }

    void loadInitialData();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !pickedFabricImageId) return;
    let cancelled = false;

    async function loadPickedFabric() {
      if (!accessToken) return;
      setLoadingPickedFabric(true);
      try {
        setStatusText("Loading selected fabric...");
        const row = await findFabricImageById(accessToken, pickedFabricImageId);
        if (cancelled) return;

        if (!row) {
          setStatusText("Selected fabric was not found.");
          return;
        }

        const signed = await createSignedUrl("fabric-images", row.storage_path, 3600).catch(() => null);
        if (cancelled) return;

        setExistingFabricImage(row);
        setFabricFile(null);
        setFabricPreviewUrl(signed);
        setHasPattern(false);
        setFabricScale(null);
        setStatusText("Fabric selected from silo.");
      } catch (err) {
        if (!cancelled) {
          setStatusText(`Selected fabric failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      } finally {
        if (!cancelled) setLoadingPickedFabric(false);
      }
    }

    void loadPickedFabric();

    return () => {
      cancelled = true;
    };
  }, [accessToken, pickedFabricImageId]);

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
          setStatusText("Generation ready.");
          navigate(`/output-viewer?generationId=${encodeURIComponent(row.id)}`);
          return;
        }

        if (row.status === "failed") {
          setVisualizingGenerationId(null);
          setStatusText(row.error || "Generation failed.");
          return;
        }

        if (isPendingStatus(row.status)) {
          setStatusText("Generating look...");
        }
      } catch (err) {
        if (!cancelled) {
          setStatusText(`Generation status failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }
    };

    void poll();
    const timer = window.setInterval(poll, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessToken, navigate, visualizingGenerationId]);

  function clearFabricSelection() {
    setFabricFile(null);
    setExistingFabricImage(null);
    setFabricPreviewUrl(null);
    setHasPattern(false);
    setFabricScale(null);
  }

  function handleFabricPicked(file: File | null) {
    if (!file) return;
    setFabricFile(file);
    setExistingFabricImage(null);
    setFabricPreviewUrl(URL.createObjectURL(file));
    setHasPattern(false);
    setFabricScale(null);
    setStatusText("Fabric image selected.");
  }

  function onFabricCameraChange(event: ChangeEvent<HTMLInputElement>) {
    handleFabricPicked(event.target.files?.[0] ?? null);
    event.target.value = "";
  }

  function onFabricGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    handleFabricPicked(event.target.files?.[0] ?? null);
    event.target.value = "";
  }

  function onHeroReplacementChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;

    setHeroReplacementFile(file);
    setHeroReplacementPreviewUrl(URL.createObjectURL(file));
    setStatusText("Replacement hero selected for this generation.");
  }

  async function uploadFabricImage(file: File) {
    if (!accessToken || !shopContext) throw new Error("Shop context is still loading.");

    const ext = guessFileExtension(file.name, file.type);
    const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
    const storagePath = `${shopContext.shop_id}/${filename}`;
    const originalFilename = saveToSilo && fabricCode.trim() ? fabricCode.trim() : file.name || filename;

    setStatusText(saveToSilo ? "Saving fabric image..." : "Uploading fabric image...");
    await uploadToStorage("fabric-images", storagePath, file);

    return apiFetch<FabricImageRow>("/fabric-images", accessToken, {
      method: "POST",
      body: JSON.stringify({
        storage_path: storagePath,
        original_filename: originalFilename,
        mime_type: file.type || "image/jpeg",
        file_size_bytes: file.size,
        width: null,
        height: null
      })
    });
  }

  async function uploadHeroReplacement(file: File, garment: GarmentType) {
    if (!accessToken || !shopContext) throw new Error("Shop context is still loading.");

    const ext = guessFileExtension(file.name, file.type);
    const storagePath = `temp/${shopContext.shop_id}/${Date.now()}-${makeRandomSuffix()}.${ext}`;

    setStatusText("Uploading temporary hero image...");
    await uploadToStorage("hero-images", storagePath, file);

    return apiFetch<HeroImageRow>("/hero-images", accessToken, {
      method: "POST",
      body: JSON.stringify({
        folder_id: garment.id,
        storage_path: storagePath,
        original_filename: file.name || `hero-${Date.now()}.${ext}`,
        mime_type: file.type || "image/jpeg",
        file_size_bytes: file.size,
        width: null,
        height: null
      })
    });
  }

  async function ensureFabricImage() {
    if (existingFabricImage?.id) return existingFabricImage;
    if (fabricFile) return uploadFabricImage(fabricFile);
    throw new Error("Select a fabric image first.");
  }

  async function ensureHeroImageId(garment: GarmentType) {
    if (heroReplacementFile) {
      const row = await uploadHeroReplacement(heroReplacementFile, garment);
      return row.id;
    }

    if (garment.default_hero_image_id) return garment.default_hero_image_id;

    throw new Error("This garment type has no default hero image. Use Change to select one.");
  }

  async function handleCreateGeneration() {
    if (!accessToken || !selectedGarment) return;

    setCreatingGeneration(true);
    try {
      const fabricImage = await ensureFabricImage();
      const heroImageId = await ensureHeroImageId(selectedGarment);

      const fabricAssignment: GenerationFabricAssignmentPayload = {
        fabric_image_id: fabricImage.id,
        apply_to: mapGarmentToApplyTo(selectedGarment),
        fabric_code: saveToSilo ? fabricCode.trim() : "unknown",
        fabric_color: saveToSilo ? fabricColor.trim() || null : null,
        fabric_scale: hasPattern && fabricScale ? fabricScale : null
      };

      setStatusText("Creating generation job...");
      const response = await apiFetch<GenerationCreateResponse>("/generations", accessToken, {
        method: "POST",
        body: JSON.stringify({
          hero_image_id: heroImageId,
          fabric_image_id: fabricImage.id,
          fabrics: [fabricAssignment]
        })
      });

      if (Number.isFinite(response.balance_after)) {
        setCreditBalance(String(response.balance_after));
      }

      setVisualizingGenerationId(response.id);
      setStatusText("Generating look...");
    } catch (err) {
      setStatusText(`Generate failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setCreatingGeneration(false);
    }
  }

  async function handleQuickTryOnSubmit(customerPhotoFile: File): Promise<string> {
    if (!accessToken) throw new Error("Not authenticated");
    if (!selectedFabricImageId && !fabricFile) {
      throw new Error("Please select a fabric first");
    }
    if (!selectedGarmentId) {
      throw new Error("Please select a garment type first");
    }
    if (!shopContext) {
      throw new Error("Shop context is still loading.");
    }

    let fabricImageId = selectedFabricImageId;

    if (!fabricImageId && fabricFile) {
      const ext = guessFileExtension(fabricFile.name, fabricFile.type);
      const path = `${shopContext.shop_id}/${Date.now()}-${makeRandomSuffix()}.${ext}`;
      const storagePath = await uploadToStorage(
        "fabric-images",
        path,
        fabricFile
      );
      const uploaded = await apiFetch<{ id: string }>(
        "/fabric-images",
        accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            storage_path: storagePath,
            original_filename: fabricFile.name,
            mime_type: fabricFile.type,
            file_size_bytes: fabricFile.size,
          }),
        }
      );
      fabricImageId = uploaded.id;
    }

    if (!fabricImageId) {
      throw new Error("Could not resolve fabric image");
    }

    const reader = new FileReader();
    const photoB64 = await new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        const result = reader.result as string;
        const b64 = result.split(",")[1];
        if (!b64) {
          reject(new Error("Failed to read customer photo"));
          return;
        }
        resolve(b64);
      };
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read customer photo"));
      reader.readAsDataURL(customerPhotoFile);
    });

    const response = await apiFetch<{
      result_b64: string;
      result_mime: string;
    }>(
      "/tryon/quick",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          fabric_image_id: fabricImageId,
          folder_id: selectedGarmentId,
          customer_photo_b64: photoB64,
          customer_photo_mime:
            customerPhotoFile.type || "image/jpeg",
        }),
      }
    );

    function base64ToBlob(b64: string, mime: string): Blob {
      const bytes = atob(b64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        arr[i] = bytes.charCodeAt(i);
      }
      return new Blob([arr], { type: mime });
    }

    const blob = base64ToBlob(
      response.result_b64,
      response.result_mime
    );
    return URL.createObjectURL(blob);
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="page-header">
          <div>
            <h1>Sew a New Look</h1>
          </div>
        </header>

        <section className="card stack-sm">
          <p className="tiny muted">{statusText}</p>
        </section>

        <section className="card stack-sm">
          <h2>Choose Cloth</h2>

          <div className="fabric-scroll">
            <div className="fabric-tile">
              <button
                className="fabric-thumb-new"
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                disabled={actionBusy}
                aria-label="Add new cloth"
                title="Add new cloth"
              >
                <svg viewBox="0 0 24 24" aria-hidden focusable="false">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <span className="fabric-label">New</span>
            </div>

            {fabricPreviewUrl ? (
              <div className="fabric-tile">
                <div style={{ position: "relative", display: "inline-block" }}>
                  <img className="fabric-thumb selected" src={fabricPreviewUrl} alt="selected fabric" />
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearFabricSelection();
                    }}
                    style={{
                      position: "absolute",
                      top: "-6px",
                      right: "-6px",
                      width: "20px",
                      height: "20px",
                      borderRadius: "50%",
                      background: "#1B1B2F",
                      border: "2px solid var(--white)",
                      color: "#C9A84C",
                      fontSize: "12px",
                      fontWeight: 700,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1,
                      padding: 0
                    }}
                    aria-label="Remove fabric selection"
                  >
                    &times;
                  </button>
                </div>
                <div className="fabric-label">
                  {existingFabricImage?.original_filename?.trim() || fabricFile?.name || "Selected"}
                </div>
              </div>
            ) : null}
          </div>

          <div className="row">
            <button
              className="btn btn-light flex-1"
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={actionBusy}
            >
              Capture
            </button>
            <button
              className="btn btn-light flex-1"
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={actionBusy}
            >
              Gallery
            </button>
            <button
              className="btn btn-light flex-1"
              type="button"
              onClick={() => navigate("/fabric-silo?picker=true")}
              disabled={actionBusy}
            >
              Fabric Silo
            </button>
          </div>

          <label className="silo-toggle-row">
            <input
              type="checkbox"
              checked={saveToSilo}
              onChange={(event) => setSaveToSilo(event.target.checked)}
              disabled={actionBusy}
            />
            <span>Save new cloth to My Fabrics</span>
          </label>

          {/* Pattern selector */}
          <div style={{
            background: "var(--white)",
            border: "0.5px solid var(--border)",
            borderRadius: "12px",
            padding: "12px"
          }}>
            <label style={{
              display: "flex", alignItems: "center", gap: "10px", cursor: "pointer"
            }}>
              <input
                type="checkbox"
                checked={hasPattern}
                onChange={(e) => {
                  setHasPattern(e.target.checked);
                  if (!e.target.checked) setFabricScale(null);
                }}
                style={{ width: "16px", height: "16px", accentColor: "#1B1B2F" }}
              />
              <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                This fabric has a pattern (checks, stripes, print)
              </span>
            </label>

            {hasPattern && (
              <div style={{ marginTop: "12px", display: "grid", gap: "8px" }}>
                <span style={{
                  fontSize: "11px", fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.06em"
                }}>
                  How large is the pattern?
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "8px" }}>
                  {([
                    { key: "fine", label: "Fine", hint: "Small, tight" },
                    { key: "medium", label: "Medium", hint: "Classic size" },
                    { key: "bold", label: "Bold", hint: "Large, wide" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setFabricScale(opt.key)}
                      style={{
                        border: fabricScale === opt.key
                          ? "2px solid #C9A84C"
                          : "1px solid var(--border)",
                        borderRadius: "12px",
                        padding: "8px 6px",
                        background: fabricScale === opt.key ? "#FDF6E8" : "var(--white)",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <div style={{
                        width: "56px", height: "56px", borderRadius: "8px",
                        overflow: "hidden", border: "0.5px solid var(--border)"
                      }}
                        dangerouslySetInnerHTML={{
                          __html:
                            opt.key === "fine" ? FINE_CHECKS_SVG :
                              opt.key === "medium" ? MEDIUM_CHECKS_SVG :
                                BOLD_CHECKS_SVG
                        }}
                      />
                      <span style={{
                        fontSize: "12px", fontWeight: 600,
                        color: fabricScale === opt.key ? "#8B6914" : "var(--text-primary)"
                      }}>{opt.label}</span>
                      <span style={{
                        fontSize: "10px",
                        color: "var(--text-muted)"
                      }}>{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {saveToSilo ? (
            <>
              <label className="field">
                <span>Fabric Code <strong>*</strong></span>
                <input
                  type="text"
                  value={fabricCode}
                  onChange={(event) => setFabricCode(event.target.value)}
                  placeholder="e.g. F123"
                  disabled={actionBusy}
                />
              </label>
              <label className="field">
                <span>Fabric Color (optional)</span>
                <input
                  type="text"
                  value={fabricColor}
                  onChange={(event) => setFabricColor(event.target.value)}
                  placeholder="e.g. Navy Blue"
                  disabled={actionBusy}
                />
              </label>
            </>
          ) : null}

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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
            <span className="section-label">Select Style</span>
            <button
              onClick={loadGarmentTypes}
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                border: "0.5px solid var(--border)",
                background: "var(--white)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                color: "var(--text-muted)"
              }}
              aria-label="Refresh garment types"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>
          </div>

          <div className="pill-row">
            {garmentTypes.map((garment) => (
              <button
                key={garment.id}
                className={`style-pill ${selectedGarmentId === garment.id ? "active" : ""}`}
                type="button"
                onClick={() => {
                  setSelectedGarmentId(garment.id);
                  setHeroChangeOpen(false);
                  setHeroReplacementFile(null);
                  setHeroReplacementPreviewUrl(null);
                }}
                disabled={actionBusy || loadingInitial}
              >
                {garment.name}
              </button>
            ))}
          </div>

          {loadingInitial ? <p className="tiny muted">Loading garment types...</p> : null}

          {selectedGarment ? (
            <>
              <div className="model-preview-box">
                {selectedHeroPreviewUrl ? (
                  <img className="model-preview-img" src={selectedHeroPreviewUrl} alt={`${selectedGarment.name} hero`} />
                ) : (
                  <div className="model-preview-placeholder">No hero preview available</div>
                )}
                <button
                  className="model-change-btn"
                  type="button"
                  onClick={() => setHeroChangeOpen((prev) => !prev)}
                  disabled={actionBusy}
                >
                  Change
                </button>
              </div>

              {heroChangeOpen ? (
                <label className="field">
                  <span>Replacement Hero Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onHeroReplacementChange}
                    disabled={actionBusy}
                  />
                </label>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="card stack-sm">
          <button
            className="btn-primary"
            type="button"
            disabled={!canGenerate}
            onClick={() => void handleCreateGeneration()}
          >
            {creatingGeneration ? (
              "Sewing..."
            ) : (
              <>
                <svg viewBox="0 0 24 24" aria-hidden focusable="false">
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
                </svg>
                Sew this Look
              </>
            )}
          </button>

          <button
            onClick={() => {
              if (!selectedFabricImageId && !fabricFile) {
                alert("Please select a fabric first");
                return;
              }
              if (!selectedGarmentId) {
                alert("Please select a garment type first");
                return;
              }
              setShowConsentModal(true);
            }}
            style={{
              width: "100%",
              minHeight: "48px",
              background: "transparent",
              color: "#1B1B2F",
              border: "1.5px solid #1B1B2F",
              borderRadius: "14px",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              marginTop: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
            }}
          >
            👤 Try On Customer
          </button>

          {visualizingGenerationId ? (
            <div className="loading-box">
              <div className="spinner" />
              <p className="tiny muted">Generating look...</p>
            </div>
          ) : null}
        </section>
      </section>

      {showConsentModal && (
        <CustomerConsentModal
          onConsent={() => {
            setShowConsentModal(false);
            setShowTryOnFlow(true);
          }}
          onCancel={() => setShowConsentModal(false)}
        />
      )}

      {showTryOnFlow && (
        <TryOnFlow
          onClose={() => setShowTryOnFlow(false)}
          onSubmit={handleQuickTryOnSubmit}
        />
      )}
    </main>
  );
}
