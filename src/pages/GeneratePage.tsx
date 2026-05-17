import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

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

  const [heroChangeOpen, setHeroChangeOpen] = useState(false);
  const [heroReplacementFile, setHeroReplacementFile] = useState<File | null>(null);
  const [heroReplacementPreviewUrl, setHeroReplacementPreviewUrl] = useState<string | null>(null);

  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingPickedFabric, setLoadingPickedFabric] = useState(false);
  const [creatingGeneration, setCreatingGeneration] = useState(false);
  const [visualizingGenerationId, setVisualizingGenerationId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Preparing Generate screen...");

  const selectedGarment = useMemo(
    () => garmentTypes.find((garment) => garment.id === selectedGarmentId) ?? null,
    [garmentTypes, selectedGarmentId]
  );

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

  useEffect(() => {
    if (!fabricPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(fabricPreviewUrl);
  }, [fabricPreviewUrl]);

  useEffect(() => {
    if (!heroReplacementPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(heroReplacementPreviewUrl);
  }, [heroReplacementPreviewUrl]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    async function loadInitialData() {
      if (!accessToken) return;
      setLoadingInitial(true);
      try {
        const [me, garmentRows] = await Promise.all([
          apiFetch<MeResponse>("/me", accessToken, { method: "GET" }),
          apiFetch<GarmentType[]>("/garment-types", accessToken, { method: "GET" })
        ]);

        if (cancelled) return;

        setShopContext(me);
        setCreditBalance(extractCreditBalance(me));
        setGarmentTypes(garmentRows);
        setStatusText(garmentRows.length ? "Ready to generate." : "No garment types found.");
      } catch (err) {
        if (!cancelled) {
          setStatusText(`Load failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      } finally {
        if (!cancelled) setLoadingInitial(false);
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

  function handleFabricPicked(file: File | null) {
    if (!file) return;
    setFabricFile(file);
    setExistingFabricImage(null);
    setFabricPreviewUrl(URL.createObjectURL(file));
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
        fabric_color: saveToSilo ? fabricColor.trim() || null : null
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
                <img className="fabric-thumb selected" src={fabricPreviewUrl} alt="Selected cloth" />
                <span className="fabric-label">
                  {existingFabricImage?.original_filename?.trim() || fabricFile?.name || "Selected"}
                </span>
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
          <h2>Select Style</h2>

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

          {visualizingGenerationId ? (
            <div className="loading-box">
              <div className="spinner" />
              <p className="tiny muted">Generating look...</p>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
