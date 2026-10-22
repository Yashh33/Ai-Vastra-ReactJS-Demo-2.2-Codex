import { useQueryClient } from "@tanstack/react-query";
import { ChangeEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ColorStudio } from "../components/ColorStudio";
import { CustomerConsentModal } from "../components/CustomerConsentModal";
import { HeroPreviewImage } from "../components/HeroPreviewImage";
import { PhotoPickStatus } from "../components/PhotoPickStatus";
import { TryOnFlow } from "../components/TryOnFlow";
import { apiFetch, apiFetchBinary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useGarmentTypes, useMe } from "../lib/queries";
import { subscribeToGeneration } from "../lib/realtime";
import { createSignedUrl, uploadToStorage } from "../lib/storage";
import { supabase } from "../lib/supabase";
import type {
  ApplyToTarget,
  FabricImageRow,
  GarmentFabricSlot,
  GarmentType,
  GenerationCreateResponse,
  GenerationFabricAssignmentPayload,
  GenerationRow,
  HeroImageRow
} from "../lib/types";
import { compressImage, PHOTO_READ_ERROR } from "../lib/compressImage";
import { debugLog, debugLogPicked } from "../lib/debugLog";
import { guessFileExtension, isPendingStatus, makeRandomSuffix } from "../lib/utils";

function mapGarmentToApplyTo(garment: GarmentType): ApplyToTarget {
  const context = `${garment.name} ${garment.prompt_template}`.toLowerCase();

  if (context.includes("shirt")) return "shirt";
  if (context.includes("pant") || context.includes("trouser")) return "pant";
  if (context.includes("koti") || context.includes("vest")) return "koti";
  if (context.includes("upper")) return "suit_upper";

  return "suit_full_body";
}

function sortSlots(slots: GarmentFabricSlot[] | undefined) {
  return [...(slots ?? [])].sort((a, b) => a.sort_order - b.sort_order);
}

/** Plain message for a failed look; the raw backend error only goes to the console. */
function friendlyGenerateError(garmentName: string, slotCount: number) {
  const check =
    slotCount === 0
      ? "Check that the fabric is added"
      : slotCount === 2
        ? "Check that both fabrics are added"
        : "Check that all fabrics are added";
  return `Couldn't create the ${garmentName} look. ${check} and try again.`;
}

const MULTI_DRAFT_STORAGE_KEY = "aivastra-multi-draft";

type MultiFabricSelection = {
  /** Empty while a freshly picked photo is still waiting to be uploaded. */
  fabricImageId: string;
  previewUrl: string | null;
  label: string;
  /** A new Capture/Gallery photo, held locally until Sew / Try On so its colour can be corrected first. */
  pendingFile?: File;
  colourAdjusted?: boolean;
};

/** Which photo picker a "Preparing photo…" spinner or read error belongs to. */
type PhotoPicker = "fabric" | "hero" | "multi";

/** Which freshly picked fabric photo the Match colour studio is open for. */
type ColourTarget = { kind: "single" } | { kind: "multi"; slotId: string };

function isSlotFilled(selection: MultiFabricSelection | undefined) {
  return !!selection && (!!selection.fabricImageId || !!selection.pendingFile);
}

type MultiDraftSelection = { fabricImageId: string; label: string };

type MultiDraft = {
  selectedGarmentId?: string;
  multiSelections?: Record<string, MultiDraftSelection>;
};

/** Style card thumbnail; falls back to a plain tile when the image is missing or fails. */
function StyleCardImage({ url, alt, onUrlExpired }: { url: string | null; alt: string; onUrlExpired: () => void }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!url || failedUrl === url) return <span className="style-card-img style-card-img-empty" aria-hidden />;
  return (
    <img
      className="style-card-img"
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => {
        setFailedUrl(url);
        onUrlExpired();
      }}
    />
  );
}

export function GeneratePage() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const multiCameraInputRef = useRef<HTMLInputElement | null>(null);
  const multiGalleryInputRef = useRef<HTMLInputElement | null>(null);
  /** Slot the multi Capture / Gallery picker was opened for. */
  const multiPickSlotRef = useRef<string | null>(null);
  const hydratedMultiDraftRef = useRef(false);
  const handledMultiReturnParamsRef = useRef(false);
  const styleThumbRefreshRef = useRef(false);
  /** Message shown if the running generation fails; set when the job is created. */
  const failureMessageRef = useRef("");

  const pickedFabricImageId =
    searchParams.get("fabric_image_id") ?? searchParams.get("selectedFabricImageId") ?? "";

  const { data: me } = useMe();
  const {
    data: garmentTypesData,
    isLoading: loadingGarmentTypes,
    error: garmentTypesError,
    refetch: refetchGarmentTypes
  } = useGarmentTypes();
  const garmentTypes = garmentTypesData ?? [];
  const shopContext = me ?? null;
  const [selectedGarmentId, setSelectedGarmentId] = useState("");

  const [fabricFile, setFabricFile] = useState<File | null>(null);
  const [existingFabricImage, setExistingFabricImage] = useState<FabricImageRow | null>(null);
  const [fabricPreviewUrl, setFabricPreviewUrl] = useState<string | null>(null);
  const [fabricColourAdjusted, setFabricColourAdjusted] = useState(false);
  const [colourTarget, setColourTarget] = useState<ColourTarget | null>(null);
  const [preparingPhoto, setPreparingPhoto] = useState<PhotoPicker | null>(null);
  const [photoError, setPhotoError] = useState<{ picker: PhotoPicker; message: string } | null>(null);
  /** Slot the multi photo spinner / read error belongs to. */
  const [photoSlotId, setPhotoSlotId] = useState<string | null>(null);

  const [productDetailsOpen, setProductDetailsOpen] = useState(false);
  const [lookBarcode, setLookBarcode] = useState("");
  const [lookMrp, setLookMrp] = useState("");
  const [lookDescription, setLookDescription] = useState("");

  // The "Change" hero button is not shown; the replacement flow stays for garments with no hero.
  const [heroChangeOpen, setHeroChangeOpen] = useState(false);
  const [heroReplacementFile, setHeroReplacementFile] = useState<File | null>(null);
  const [heroReplacementPreviewUrl, setHeroReplacementPreviewUrl] = useState<string | null>(null);

  const [loadingPickedFabric, setLoadingPickedFabric] = useState(false);
  const [creatingGeneration, setCreatingGeneration] = useState(false);
  const [visualizingGenerationId, setVisualizingGenerationId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [showTryOnFlow, setShowTryOnFlow] = useState(false);

  const [multiSelections, setMultiSelections] = useState<Record<string, MultiFabricSelection>>({});

  const selectedGarment = useMemo(
    () => garmentTypes.find((garment) => garment.id === selectedGarmentId) ?? null,
    [garmentTypes, selectedGarmentId]
  );

  const sortedFabricSlots: GarmentFabricSlot[] = useMemo(
    () => sortSlots(selectedGarment?.fabric_slots),
    [selectedGarment]
  );
  // The garment type decides the flow: fabric slots mean one fabric per slot.
  const isMulti = sortedFabricSlots.length > 0;
  const allMultiSlotsFilled =
    sortedFabricSlots.length > 0 &&
    sortedFabricSlots.every((slot) => isSlotFilled(multiSelections[slot.id]));

  const selectedFabricImageId = existingFabricImage?.id ?? "";
  const selectedHeroPreviewUrl =
    heroReplacementPreviewUrl ||
    selectedGarment?.hero_thumb_signed_url ||
    selectedGarment?.hero_image_signed_url ||
    null;

  const fabricReady = !!fabricFile || !!existingFabricImage?.id;
  const fabricsReady = isMulti ? allMultiSlotsFilled : fabricReady;
  const heroReady = !!heroReplacementFile || !!selectedGarment?.default_hero_image_id;
  const actionBusy = loadingGarmentTypes || loadingPickedFabric || creatingGeneration || !!visualizingGenerationId;
  const canGenerate = fabricReady && !!selectedGarment && heroReady && !actionBusy;
  const canGenerateMulti = !!selectedGarment && allMultiSlotsFilled && heroReady && !actionBusy;
  const canSew = isMulti ? canGenerateMulti : canGenerate;
  const canTryOn = !!selectedGarment && fabricsReady && !actionBusy;

  const actionHint = !selectedGarment
    ? "Pick a style to continue"
    : !fabricsReady
      ? isMulti
        ? "Add all fabrics to continue"
        : "Add the fabric to continue"
      : !heroReady
        ? "Add a model photo for this style to continue"
        : null;

  useEffect(() => {
    if (!fabricPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(fabricPreviewUrl);
  }, [fabricPreviewUrl]);

  useEffect(() => {
    if (!heroReplacementPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(heroReplacementPreviewUrl);
  }, [heroReplacementPreviewUrl]);

  useEffect(() => {
    if (garmentTypesError) console.error("[generate] garment types load failed", garmentTypesError);
  }, [garmentTypesError]);

  useEffect(() => {
    if (!accessToken || !pickedFabricImageId) return;
    let cancelled = false;

    async function loadPickedFabric() {
      if (!accessToken) return;
      setLoadingPickedFabric(true);
      try {
        setStatusText("Loading selected fabric...");
        const row = await apiFetch<FabricImageRow>(
          `/fabric-images/${encodeURIComponent(pickedFabricImageId)}`,
          accessToken,
          { method: "GET" }
        ).catch(() => null);
        if (cancelled) return;

        if (!row) {
          setErrorText("That fabric couldn't be found. Please add it again.");
          return;
        }

        const signed = await createSignedUrl("fabric-images", row.storage_path, 3600).catch(() => null);
        if (cancelled) return;

        setExistingFabricImage(row);
        setFabricFile(null);
        setFabricColourAdjusted(false);
        setFabricPreviewUrl(signed);
      } catch (err) {
        if (!cancelled) {
          console.error("[generate] selected fabric load failed", err);
          setErrorText("Couldn't load the selected fabric. Please add it again.");
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

    const handleStatusRow = (row: { id: string; status: string; error: string | null }) => {
      if (cancelled) return;

      if (row.status === "done") {
        setVisualizingGenerationId(null);
        setStatusText("Generation ready.");
        setMultiSelections({});
        try {
          sessionStorage.removeItem(MULTI_DRAFT_STORAGE_KEY);
        } catch {
          // ignore storage errors
        }
        navigate(`/output-viewer?generationId=${encodeURIComponent(row.id)}`);
        return;
      }

      if (row.status === "failed") {
        console.error("[generate] generation failed", row.error);
        setVisualizingGenerationId(null);
        setStatusText("");
        setErrorText(failureMessageRef.current || "Couldn't create the look. Please try again.");
        return;
      }

      if (isPendingStatus(row.status)) {
        setStatusText("Generating look...");
      }
    };

    const poll = async () => {
      try {
        const row = await apiFetch<GenerationRow>(`/generations/${visualizingGenerationId}`, accessToken, {
          method: "GET"
        });
        handleStatusRow(row);
      } catch (err) {
        // A missed status check is not a failed look; realtime or the next poll catches up.
        if (!cancelled) console.error("[generate] generation status check failed", err);
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
  }, [accessToken, navigate, visualizingGenerationId]);

  function assignFabricToSlot(slotId: string, selection: MultiFabricSelection) {
    setMultiSelections((prev) => ({ ...prev, [slotId]: selection }));
  }

  function removeSlotFabric(slotId: string) {
    setMultiSelections((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  }

  useEffect(() => {
    try {
      const draftSelections: Record<string, MultiDraftSelection> = {};
      Object.entries(multiSelections).forEach(([slotId, selection]) => {
        // Photos not uploaded yet have no id to restore from, so they are not part of the draft.
        if (!selection.fabricImageId) return;
        draftSelections[slotId] = { fabricImageId: selection.fabricImageId, label: selection.label };
      });
      const draft: MultiDraft = { selectedGarmentId, multiSelections: draftSelections };
      sessionStorage.setItem(MULTI_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // ignore storage errors
    }
  }, [selectedGarmentId, multiSelections]);

  useEffect(() => {
    if (!accessToken || hydratedMultiDraftRef.current) return;
    hydratedMultiDraftRef.current = true;
    let cancelled = false;

    async function hydrateDraft() {
      if (!accessToken) return;
      try {
        const raw = sessionStorage.getItem(MULTI_DRAFT_STORAGE_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw) as MultiDraft;
        if (parsed.selectedGarmentId) setSelectedGarmentId(parsed.selectedGarmentId);

        const entries = Object.entries(parsed.multiSelections ?? {});
        if (!entries.length) return;

        setMultiSelections((prev) => {
          const next = { ...prev };
          entries.forEach(([slotId, selection]) => {
            next[slotId] = { fabricImageId: selection.fabricImageId, label: selection.label, previewUrl: null };
          });
          return next;
        });

        for (const [slotId, selection] of entries) {
          try {
            const row = await apiFetch<FabricImageRow>(
              `/fabric-images/${encodeURIComponent(selection.fabricImageId)}`,
              accessToken,
              { method: "GET" }
            );
            const signed = await createSignedUrl("fabric-images", row.storage_path, 3600).catch(() => null);
            if (cancelled) return;
            setMultiSelections((prev) =>
              prev[slotId] ? { ...prev, [slotId]: { ...prev[slotId], previewUrl: signed } } : prev
            );
          } catch {
            // tolerate a failed re-sign; keep the selection with no preview
          }
        }
      } catch {
        // ignore malformed draft
      }
    }

    void hydrateDraft();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || handledMultiReturnParamsRef.current) return;

    const slotId = searchParams.get("slot_id");
    const fabricImageId = searchParams.get("fabric_image_id");
    if (!slotId || !fabricImageId) return;

    handledMultiReturnParamsRef.current = true;
    let cancelled = false;

    async function resolveReturnedFabric() {
      if (!accessToken) return;
      try {
        const row = await apiFetch<FabricImageRow>(
          `/fabric-images/${encodeURIComponent(fabricImageId as string)}`,
          accessToken,
          { method: "GET" }
        );
        const signed = await createSignedUrl("fabric-images", row.storage_path, 3600).catch(() => null);
        if (cancelled) return;
        assignFabricToSlot(slotId as string, {
          fabricImageId: row.id,
          previewUrl: signed,
          label: row.original_filename?.trim() || "Fabric"
        });
      } catch {
        // tolerate a failed resolve; slot stays unpicked
      }
    }

    void resolveReturnedFabric();

    return () => {
      cancelled = true;
    };
  }, [accessToken, searchParams]);

  function clearFabricSelection() {
    setFabricFile(null);
    setFabricColourAdjusted(false);
    setExistingFabricImage(null);
    setFabricPreviewUrl(null);
  }

  /** Switches style; fabrics are kept only while the number of fabric parts stays the same. */
  function selectGarment(garment: GarmentType) {
    if (garment.id === selectedGarmentId) return;

    const prevSlots = sortedFabricSlots;
    const nextSlots = sortSlots(garment.fabric_slots);
    if (prevSlots.length === nextSlots.length && nextSlots.length > 0) {
      setMultiSelections((prev) => {
        const next: Record<string, MultiFabricSelection> = {};
        prevSlots.forEach((slot, index) => {
          const selection = prev[slot.id];
          const target = nextSlots[index];
          if (selection && target) next[target.id] = selection;
        });
        return next;
      });
    } else if (prevSlots.length !== nextSlots.length) {
      clearFabricSelection();
      setMultiSelections({});
    }

    setSelectedGarmentId(garment.id);
    setColourTarget(null);
    setHeroChangeOpen(false);
    setHeroReplacementFile(null);
    setHeroReplacementPreviewUrl(null);
    setErrorText(null);
    setStatusText("");
    setPhotoError(null);
  }

  /** Converts a just-picked photo to JPEG, showing a spinner meanwhile. Null (with a message shown) if unreadable. */
  async function preparePhoto(file: File, picker: PhotoPicker) {
    setPhotoError(null);
    setPreparingPhoto(picker);
    try {
      return await compressImage(file, 1600);
    } catch (err) {
      setPhotoError({ picker, message: err instanceof Error ? err.message : PHOTO_READ_ERROR });
      return null;
    } finally {
      setPreparingPhoto(null);
    }
  }

  async function handleFabricPicked(file: File | null) {
    if (!file) return;
    const compressed = await preparePhoto(file, "fabric");
    if (!compressed) return;
    setFabricFile(compressed);
    setFabricColourAdjusted(false);
    setExistingFabricImage(null);
    setFabricPreviewUrl(URL.createObjectURL(compressed));
    setErrorText(null);
  }

  function onFabricCameraChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    void handleFabricPicked(file);
  }

  function onFabricGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    void handleFabricPicked(file);
  }

  async function onHeroReplacementChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    if (!file) return;

    const compressed = await preparePhoto(file, "hero");
    if (!compressed) return;
    setHeroReplacementFile(compressed);
    setHeroReplacementPreviewUrl(URL.createObjectURL(compressed));
  }

  async function uploadFabricImage(file: File) {
    if (!accessToken || !shopContext) throw new Error("Shop context is still loading.");

    const ext = guessFileExtension(file.name, file.type);
    const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
    const storagePath = `${shopContext.shop_id}/${filename}`;

    setStatusText("Uploading fabric image...");
    await uploadToStorage("fabric-images", storagePath, file);

    return apiFetch<FabricImageRow>("/fabric-images", accessToken, {
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

    throw new Error("This garment type has no default hero image.");
  }

  async function handleCreateGeneration() {
    if (!accessToken || !selectedGarment) return;
    setErrorText(null);

    // Optional product details: only the filled fields are sent with the create request.
    const productDetails: { barcode?: string; mrp?: number; description?: string } = {};
    if (lookBarcode.trim()) productDetails.barcode = lookBarcode.trim();
    if (lookDescription.trim()) productDetails.description = lookDescription.trim();
    if (lookMrp.trim()) {
      const mrp = Number(lookMrp.trim());
      if (!Number.isFinite(mrp) || mrp < 0) {
        setErrorText("Enter a valid MRP, or leave it empty.");
        return;
      }
      productDetails.mrp = mrp;
    }

    const failureMessage = friendlyGenerateError(selectedGarment.name, 0);
    setCreatingGeneration(true);
    try {
      const fabricImage = await ensureFabricImage();
      const heroImageId = await ensureHeroImageId(selectedGarment);

      const fabricAssignment: GenerationFabricAssignmentPayload = {
        fabric_image_id: fabricImage.id,
        apply_to: mapGarmentToApplyTo(selectedGarment),
        fabric_code: "unknown",
        fabric_color: null
      };

      setStatusText("Creating generation job...");
      const response = await apiFetch<GenerationCreateResponse>("/generations", accessToken, {
        method: "POST",
        body: JSON.stringify({
          hero_image_id: heroImageId,
          fabric_image_id: fabricImage.id,
          fabrics: [fabricAssignment],
          ...productDetails
        })
      });

      void queryClient.invalidateQueries({ queryKey: ["generations"] });

      if (Number.isFinite(response.balance_after)) {
        queryClient.setQueryData(["me"], (prev: typeof me) =>
          prev ? { ...prev, credits_balance: response.balance_after } : prev
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["me"] });

      failureMessageRef.current = failureMessage;
      setVisualizingGenerationId(response.id);
      setStatusText("Generating look...");
    } catch (err) {
      console.error("[generate] create failed", err);
      setStatusText("");
      setErrorText(failureMessage);
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
      await uploadToStorage(
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
            storage_path: path,
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

    const compressedPhoto = await compressImage(customerPhotoFile, 1280);

    const formData = new FormData();
    formData.set("fabric_image_id", fabricImageId);
    formData.set("folder_id", selectedGarmentId);
    formData.set("consent_confirmed", "true");
    formData.set("customer_photo", compressedPhoto);

    const blob = await apiFetchBinary("/tryon/quick/v2", accessToken, {
      method: "POST",
      body: formData,
    });

    return URL.createObjectURL(blob);
  }

  async function uploadMultiFabricImage(file: File) {
    if (!accessToken || !shopContext) throw new Error("Shop context is still loading.");

    const ext = guessFileExtension(file.name, file.type);
    const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
    const storagePath = `${shopContext.shop_id}/${filename}`;

    await uploadToStorage("fabric-images", storagePath, file);

    return apiFetch<FabricImageRow>("/fabric-images", accessToken, {
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
  }

  // A new photo stays on the device until Sew / Try On, so "Match colour" can
  // replace it before anything is uploaded.
  async function handleMultiFabricPicked(file: File | null, slotId: string) {
    if (!file) return;

    setPhotoSlotId(slotId);
    const compressed = await preparePhoto(file, "multi");
    if (!compressed) return;
    assignFabricToSlot(slotId, {
      fabricImageId: "",
      previewUrl: URL.createObjectURL(compressed),
      label: "New fabric",
      pendingFile: compressed
    });
    setErrorText(null);
  }

  /** Uploads every slot photo still held locally and returns the selections with real ids. */
  async function uploadPendingMultiFabrics() {
    const resolved: Record<string, MultiFabricSelection> = { ...multiSelections };
    for (const [slotId, selection] of Object.entries(multiSelections)) {
      const pendingFile = selection.pendingFile;
      if (!pendingFile) continue;

      setStatusText("Uploading fabric image...");
      const uploaded = await uploadMultiFabricImage(pendingFile);
      const next: MultiFabricSelection = { ...selection, fabricImageId: uploaded.id, pendingFile: undefined };
      resolved[slotId] = next;
      setMultiSelections((prev) => (prev[slotId]?.pendingFile === pendingFile ? { ...prev, [slotId]: next } : prev));
    }
    return resolved;
  }

  const colourSourceFile =
    colourTarget?.kind === "single"
      ? fabricFile
      : colourTarget?.kind === "multi"
        ? multiSelections[colourTarget.slotId]?.pendingFile ?? null
        : null;

  async function handleFabricColourSaved(blob: Blob) {
    const target = colourTarget;
    if (!target || !colourSourceFile) return;

    // Same name, now a JPEG; this replaces the picked photo before any upload happens.
    const corrected = await compressImage(
      new File([blob], colourSourceFile.name || "fabric.jpg", { type: "image/jpeg" }),
      1600
    );
    const previewUrl = URL.createObjectURL(corrected);
    if (target.kind === "single") {
      setFabricFile(corrected);
      setFabricPreviewUrl(previewUrl);
      setFabricColourAdjusted(true);
    } else {
      setMultiSelections((prev) => {
        const selection = prev[target.slotId];
        if (!selection) return prev;
        return {
          ...prev,
          [target.slotId]: { ...selection, pendingFile: corrected, previewUrl, colourAdjusted: true }
        };
      });
    }
    setColourTarget(null);
  }

  function openMultiPicker(slotId: string, source: "camera" | "gallery") {
    debugLog("input clicked");
    multiPickSlotRef.current = slotId;
    (source === "camera" ? multiCameraInputRef : multiGalleryInputRef).current?.click();
  }

  function onMultiCameraChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    if (multiPickSlotRef.current) void handleMultiFabricPicked(file, multiPickSlotRef.current);
  }

  function onMultiGalleryChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    debugLogPicked(file);
    event.target.value = "";
    if (multiPickSlotRef.current) void handleMultiFabricPicked(file, multiPickSlotRef.current);
  }

  async function handleCreateMultiGeneration() {
    if (!accessToken || !selectedGarment || !allMultiSlotsFilled) return;
    setErrorText(null);

    const failureMessage = friendlyGenerateError(selectedGarment.name, sortedFabricSlots.length);
    setCreatingGeneration(true);
    try {
      const selections = await uploadPendingMultiFabrics();
      const heroImageId = await ensureHeroImageId(selectedGarment);

      const fabrics: GenerationFabricAssignmentPayload[] = sortedFabricSlots.map((slot) => {
        const selection = selections[slot.id];
        if (!selection?.fabricImageId) throw new Error(`Missing fabric selection for ${slot.label}.`);

        return {
          fabric_image_id: selection.fabricImageId,
          apply_to: slot.apply_to as ApplyToTarget,
          fabric_code: selection.label !== "New fabric" ? selection.label : "unknown",
          fabric_color: null
        };
      });

      setStatusText("Creating generation job...");
      const response = await apiFetch<GenerationCreateResponse>("/generations", accessToken, {
        method: "POST",
        body: JSON.stringify({
          hero_image_id: heroImageId,
          fabrics
        })
      });

      void queryClient.invalidateQueries({ queryKey: ["generations"] });

      if (Number.isFinite(response.balance_after)) {
        queryClient.setQueryData(["me"], (prev: typeof me) =>
          prev ? { ...prev, credits_balance: response.balance_after } : prev
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["me"] });

      failureMessageRef.current = failureMessage;
      setVisualizingGenerationId(response.id);
      setStatusText("Generating look...");
    } catch (err) {
      console.error("[generate] create failed", err);
      setStatusText("");
      setErrorText(failureMessage);
    } finally {
      setCreatingGeneration(false);
    }
  }

  async function handlePushToScreen(blob: Blob): Promise<void> {
    if (!accessToken) throw new Error("Not authenticated");
    const folderId = isMulti ? selectedGarment?.id : selectedGarmentId;
    if (!folderId) throw new Error("Select a garment type first.");
    const fd = new FormData();
    fd.set("result_image", blob, "tryon.jpg");
    fd.set("folder_id", folderId);
    if (!isMulti && selectedFabricImageId) fd.set("fabric_image_id", selectedFabricImageId);
    await apiFetch("/tryon/push-to-screen", accessToken, { method: "POST", body: fd });
  }

  async function handleShowCarousel(): Promise<void> {
    if (!me?.shop_id) return;
    const { error } = await supabase.rpc("set_screen_mode", { p_shop_id: me.shop_id, p_mode: "catalog" });
    if (error) throw new Error(error.message);
  }

  async function handleMultiTryOnSubmit(customerPhotoFile: File): Promise<string> {
    if (!accessToken) throw new Error("Not authenticated");
    if (!selectedGarment) throw new Error("Select a garment type first.");
    if (!allMultiSlotsFilled) throw new Error("Fill all fabric slots first.");
    if (!shopContext) throw new Error("Shop context is loading.");

    const selections = await uploadPendingMultiFabrics();
    const heroImageId = await ensureHeroImageId(selectedGarment);
    const compressedPhoto = await compressImage(customerPhotoFile, 1280);

    const formData = new FormData();
    formData.set("hero_image_id", heroImageId);
    formData.set("folder_id", selectedGarment.id);
    formData.set("consent_confirmed", "true");
    formData.set("customer_photo", compressedPhoto);

    sortedFabricSlots.forEach((slot, index) => {
      const selection = selections[slot.id];
      if (!selection?.fabricImageId) return;
      formData.set(`fabric_image_id_${index + 1}`, selection.fabricImageId);
      formData.set(`apply_to_${index + 1}`, slot.apply_to);
    });

    const blob = await apiFetchBinary("/tryon/multi/v2", accessToken, {
      method: "POST",
      body: formData
    });

    return URL.createObjectURL(blob);
  }

  /** Try-on errors shown in the flow are plain text; the raw error goes to the console. */
  async function handleTryOnSubmit(customerPhotoFile: File): Promise<string> {
    try {
      return await (isMulti ? handleMultiTryOnSubmit(customerPhotoFile) : handleQuickTryOnSubmit(customerPhotoFile));
    } catch (err) {
      console.error("[try-on] failed", err);
      if (err instanceof Error && err.message === PHOTO_READ_ERROR) throw err;
      throw new Error(
        `Couldn't create the try-on for ${selectedGarment?.name ?? "this style"}. Check the fabrics and try again.`
      );
    }
  }

  function renderFabricCard(card: {
    key: string;
    title: string;
    tag?: string;
    previewUrl: string | null;
    previewAlt: string;
    onRemove: (() => void) | null;
    onCapture: () => void;
    onGallery: () => void;
    onMatchColour: (() => void) | null;
    colourAdjusted: boolean;
    status: ReactNode;
  }) {
    return (
      <div key={card.key} className="fabric-card">
        <div className="fabric-card-head">
          <span className="fabric-card-title">{card.title}</span>
          {card.tag ? <span className="slot-tag">{card.tag}</span> : null}
        </div>

        <div className="fabric-card-body">
          <div className="fabric-card-thumb-wrap">
            {card.previewUrl ? (
              <img className="fabric-card-thumb" src={card.previewUrl} alt={card.previewAlt} />
            ) : (
              <div className="fabric-card-thumb fabric-card-thumb-empty" aria-hidden>
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </div>
            )}
            {card.onRemove ? (
              <button
                type="button"
                className="fabric-card-remove"
                onClick={card.onRemove}
                disabled={actionBusy}
                aria-label="Remove fabric"
              >
                &times;
              </button>
            ) : null}
          </div>

          <div className="fabric-card-actions">
            <div className="row">
              <button className="btn btn-light flex-1" type="button" onClick={card.onCapture} disabled={actionBusy}>
                Capture
              </button>
              <button className="btn btn-light flex-1" type="button" onClick={card.onGallery} disabled={actionBusy}>
                Gallery
              </button>
            </div>
            {card.onMatchColour || card.colourAdjusted ? (
              <div className="row">
                {card.onMatchColour ? (
                  <button
                    className="btn btn-light"
                    type="button"
                    style={{ minHeight: "36px", padding: "0 12px", fontSize: "12px" }}
                    onClick={card.onMatchColour}
                    disabled={actionBusy}
                  >
                    🎨 Match colour
                  </button>
                ) : null}
                {card.colourAdjusted ? <span className="chip">Colour adjusted</span> : null}
              </div>
            ) : null}
          </div>
        </div>

        {card.status}
      </div>
    );
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
          <div className="between">
            <span className="section-label">1 · Pick a style</span>
            <button
              onClick={() => void refetchGarmentTypes()}
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

          {garmentTypes.length ? (
            <div className="style-card-row">
              {garmentTypes.map((garment) => {
                const selected = selectedGarmentId === garment.id;
                return (
                  <button
                    key={garment.id}
                    className={`style-card ${selected ? "selected" : ""}`}
                    type="button"
                    onClick={() => selectGarment(garment)}
                    disabled={actionBusy}
                    aria-pressed={selected}
                  >
                    <span className="style-card-frame">
                      <StyleCardImage
                        url={garment.hero_thumb_signed_url || garment.hero_image_signed_url || null}
                        alt=""
                        onUrlExpired={() => {
                          if (styleThumbRefreshRef.current) return;
                          styleThumbRefreshRef.current = true;
                          void queryClient.invalidateQueries({ queryKey: ["garment-types"] });
                        }}
                      />
                      {selected ? (
                        <span className="style-card-check" aria-hidden>
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="m5 12 5 5 9-10" />
                          </svg>
                        </span>
                      ) : null}
                    </span>
                    <span className="style-card-name">{garment.name}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {loadingGarmentTypes ? <p className="tiny muted">Loading styles...</p> : null}
          {garmentTypesError ? <p className="error-box">Couldn't load styles. Tap refresh to try again.</p> : null}
          {!loadingGarmentTypes && !garmentTypesError && !garmentTypes.length ? (
            <p className="tiny muted">No styles found.</p>
          ) : null}

          {selectedGarment ? (
            <>
              {selectedHeroPreviewUrl ? (
                <div className="hero-full-box">
                  <HeroPreviewImage
                    key={selectedGarment.id}
                    thumbUrl={heroReplacementPreviewUrl || selectedGarment.hero_thumb_signed_url}
                    fullUrl={heroReplacementPreviewUrl ? null : selectedGarment.hero_image_signed_url}
                    alt={`${selectedGarment.name} hero`}
                    onUrlsExpired={() => void queryClient.invalidateQueries({ queryKey: ["garment-types"] })}
                  />
                </div>
              ) : null}

              {/* A garment with no hero goes straight to the upload prompt instead of an empty box. */}
              {heroChangeOpen || !selectedHeroPreviewUrl ? (
                <label className="field">
                  <span>Replacement Hero Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    onClick={() => debugLog("input clicked")}
                    onChange={onHeroReplacementChange}
                    disabled={actionBusy}
                  />
                </label>
              ) : null}
              <PhotoPickStatus
                preparing={preparingPhoto === "hero"}
                error={photoError?.picker === "hero" ? photoError.message : null}
              />
            </>
          ) : null}
        </section>

        {selectedGarment ? (
          <section className="card stack-sm">
            <span className="section-label">{isMulti ? "2 · Add the cloth for each part" : "2 · Add the cloth"}</span>

            {isMulti
              ? sortedFabricSlots.map((slot, index) => {
                  const selection = multiSelections[slot.id];
                  return renderFabricCard({
                    key: slot.id,
                    title: `${index + 1}. ${slot.label}`,
                    tag: slot.apply_to,
                    previewUrl: selection?.previewUrl ?? null,
                    previewAlt: selection?.label ?? slot.label,
                    onRemove: selection ? () => removeSlotFabric(slot.id) : null,
                    onCapture: () => openMultiPicker(slot.id, "camera"),
                    onGallery: () => openMultiPicker(slot.id, "gallery"),
                    onMatchColour: selection?.pendingFile
                      ? () => setColourTarget({ kind: "multi", slotId: slot.id })
                      : null,
                    colourAdjusted: !!selection?.colourAdjusted,
                    status: (
                      <PhotoPickStatus
                        preparing={preparingPhoto === "multi" && photoSlotId === slot.id}
                        error={photoError?.picker === "multi" && photoSlotId === slot.id ? photoError.message : null}
                      />
                    )
                  });
                })
              : renderFabricCard({
                  key: "single",
                  title: "Fabric",
                  previewUrl: fabricPreviewUrl,
                  previewAlt: existingFabricImage?.original_filename?.trim() || fabricFile?.name || "Selected fabric",
                  onRemove: fabricPreviewUrl || fabricReady ? clearFabricSelection : null,
                  onCapture: () => {
                    debugLog("input clicked");
                    cameraInputRef.current?.click();
                  },
                  onGallery: () => {
                    debugLog("input clicked");
                    galleryInputRef.current?.click();
                  },
                  onMatchColour: fabricFile ? () => setColourTarget({ kind: "single" }) : null,
                  colourAdjusted: fabricColourAdjusted,
                  status: (
                    <PhotoPickStatus
                      preparing={preparingPhoto === "fabric"}
                      error={photoError?.picker === "fabric" ? photoError.message : null}
                    />
                  )
                })}
          </section>
        ) : null}

        {/* Product details are sent with the single-fabric request only, as before. */}
        {selectedGarment && !isMulti ? (
          <section className="card stack-sm">
            <button
              type="button"
              aria-expanded={productDetailsOpen}
              onClick={() => setProductDetailsOpen((prev) => !prev)}
              style={{
                background: "transparent",
                border: "none",
                color: "#1B1B2F",
                fontWeight: 600,
                fontSize: "13px",
                fontFamily: "inherit",
                cursor: "pointer",
                padding: 0,
                textAlign: "left"
              }}
            >
              {productDetailsOpen ? "▾" : "▸"} Add product details (optional)
            </button>

            {productDetailsOpen ? (
              <>
                <label className="field">
                  <span>Barcode</span>
                  <input
                    type="text"
                    value={lookBarcode}
                    onChange={(event) => setLookBarcode(event.target.value)}
                    disabled={actionBusy}
                  />
                </label>
                <label className="field">
                  <span>MRP (₹)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={lookMrp}
                    onChange={(event) => setLookMrp(event.target.value)}
                    placeholder="e.g. 1299"
                    disabled={actionBusy}
                  />
                </label>
                <label className="field">
                  <span>Description</span>
                  <textarea
                    rows={3}
                    maxLength={300}
                    value={lookDescription}
                    onChange={(event) => setLookDescription(event.target.value)}
                    disabled={actionBusy}
                  />
                </label>
              </>
            ) : null}
          </section>
        ) : null}

        <section className="card stack-sm">
          <button
            className="btn-primary"
            type="button"
            disabled={!canSew}
            onClick={() => void (isMulti ? handleCreateMultiGeneration() : handleCreateGeneration())}
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
                Sew this look
              </>
            )}
          </button>

          {actionHint && !actionBusy ? <p className="action-hint">{actionHint}</p> : null}

          <button
            className="btn-outline-navy"
            type="button"
            onClick={() => {
              if (!canTryOn) return;
              setShowConsentModal(true);
            }}
            disabled={!canTryOn}
          >
            👤 Try on customer
          </button>

          {actionBusy && !loadingGarmentTypes ? (
            <div className="loading-box">
              <div className="spinner" />
              <p className="tiny muted">{statusText || "Working..."}</p>
            </div>
          ) : null}

          {errorText ? (
            <p className="error-box" role="alert">
              {errorText}
            </p>
          ) : null}
        </section>

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden-input"
          tabIndex={-1}
          aria-hidden
          onChange={onFabricCameraChange}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          className="visually-hidden-input"
          tabIndex={-1}
          aria-hidden
          onChange={onFabricGalleryChange}
        />
        <input
          ref={multiCameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden-input"
          tabIndex={-1}
          aria-hidden
          onChange={onMultiCameraChange}
        />
        <input
          ref={multiGalleryInputRef}
          type="file"
          accept="image/*"
          className="visually-hidden-input"
          tabIndex={-1}
          aria-hidden
          onChange={onMultiGalleryChange}
        />
      </section>

      {colourTarget && colourSourceFile && (
        <ColorStudio
          source={colourSourceFile}
          allowSegment
          defaultSegment={false}
          onSave={handleFabricColourSaved}
          onClose={() => setColourTarget(null)}
        />
      )}

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
          onSubmit={handleTryOnSubmit}
          onPushToScreen={handlePushToScreen}
          onShowCarousel={handleShowCarousel}
        />
      )}
    </main>
  );
}
