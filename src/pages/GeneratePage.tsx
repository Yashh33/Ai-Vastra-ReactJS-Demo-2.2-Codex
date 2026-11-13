import { useQueryClient } from "@tanstack/react-query";
import { ChangeEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ColorStudio } from "../components/ColorStudio";
import { CustomerConsentModal } from "../components/CustomerConsentModal";
import { FabricPickerOverlay, getFabricLabel } from "../components/FabricLibrary";
import { PhotoPickStatus } from "../components/PhotoPickStatus";
import { TryOnFlow } from "../components/TryOnFlow";
import { apiFetch } from "../lib/api";
import { ApiError, errorCodeMessage, friendlyError, GENERIC_ERROR_MESSAGE, MissingFabricError } from "../lib/apiError";
import { type Attempt, attemptRef, newAttempt, refFromId, reportNoResponse } from "../lib/attempt";
import { useAuth } from "../lib/auth";
import { forgetLook, listPendingLooks, pendingLookCreatedAt, rememberLook } from "../lib/pendingLooks";
import { FABRIC_IMAGES_QUERY_KEY, useGarmentTypes, useMe } from "../lib/queries";
import { subscribeToGeneration } from "../lib/realtime";
import { createSewTicketBook, withSewRetries } from "../lib/sewTicket";
import { signFabricPreviewUrl, signUrlsBatch, uploadFabricPhoto, uploadToStorage } from "../lib/storage";
import { supabase } from "../lib/supabase";
import { sendTryOn, tryOnFailure } from "../lib/tryOnTicket";
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

/** "Check the fabric(s)" message for a look whose fabric is missing / invalid; the raw backend error only goes to the console. */
function fabricLookError(garmentName: string, slotCount: number) {
  const check =
    slotCount === 0
      ? "Check that the fabric is added"
      : slotCount === 2
        ? "Check that both fabrics are added"
        : "Check that all fabrics are added";
  return `Couldn't create the ${garmentName} look. ${check} and try again.`;
}

const MULTI_DRAFT_STORAGE_KEY = "aivastra-multi-draft";

/** After this long the waiting state stops blocking the page; the look is still checked quietly. */
const SEW_WAIT_LIMIT_MS = 6 * 60 * 1000;
/** How often remembered looks that are not being waited on are checked. */
const QUIET_CHECK_MS = 15 * 1000;
const SLOW_LOOK_MESSAGE =
  "This is taking longer than usual. It will appear in Browse when it is ready. You do not need to sew it again.";

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

/** A saved fabric open in the colour studio, with its full photo already downloaded. */
type SavedColourSession = { target: ColourTarget; fabricImageId: string; source: Blob };

const SAVED_FABRIC_LOAD_ERROR = "Couldn't load this fabric. Please try again.";
const SAVED_FABRIC_SAVE_ERROR = "Couldn't save the colour change. Please try again.";

/** The card a colour target belongs to: "single" or the slot id (same keys as renderFabricCard). */
function colourCardKey(target: ColourTarget) {
  return target.kind === "single" ? "single" : target.slotId;
}

/** POST /fabric-images/{id}/replace-photo is not on this backend yet (or the fabric is gone). */
function isMissingReplaceEndpoint(err: unknown) {
  return err instanceof ApiError && (err.status === 404 || err.status === 405);
}

/** Which fabric card the "My Fabrics" picker was opened from. */
type FabricPickerTarget = { kind: "single" } | { kind: "multi"; slotId: string };

function isSlotFilled(selection: MultiFabricSelection | undefined) {
  return !!selection && (!!selection.fabricImageId || !!selection.pendingFile);
}

/** Built-in plain fabric the backend uses for an optional slot left empty. */
type DefaultFabricChoice = "white" | "black";

const DEFAULT_FABRIC_OPTIONS: { value: DefaultFabricChoice; label: string }[] = [
  { value: "white", label: "White" },
  { value: "black", label: "Black" }
];

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
  /** Short attempt-log id shown if the running generation fails; set when the job is created. */
  const failureRefRef = useRef<string | null>(null);
  /** X-Client-Request-Id of the latest try-on; push-to-screen sends it to link the stored result. */
  const tryOnRequestIdRef = useRef<string | null>(null);
  /**
   * The single-flow fabric photo already saved, so a retry or the next try-on reuses it
   * instead of uploading it again. Tied to that exact File: a new photo or a colour fix uploads afresh.
   */
  const uploadedFabricRef = useRef<{ file: File; row: FabricImageRow } | null>(null);
  /** Same for a replacement model photo, so a retry sends the same request (and ticket). */
  const uploadedHeroRef = useRef<{ file: File; id: string } | null>(null);
  /** A second tap on Sew while the first is running does nothing (set before any await). */
  const sewBusyRef = useRef(false);
  /** One ticket per unchanged Sew request; a finished attempt or any change gets a new one. */
  const sewTicketsRef = useRef(createSewTicketBook());
  const mountedRef = useRef(true);
  const checkingLooksRef = useRef(false);
  /** Looks already shown in the "Your look is ready" banner (not fetched again meanwhile). */
  const readyLookIdsRef = useRef<string[]>([]);
  /** Looks the "taking longer than usual" note was already shown for. */
  const slowNotedRef = useRef(new Set<string>());

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
  const [fabricPickerTarget, setFabricPickerTarget] = useState<FabricPickerTarget | null>(null);
  /** Match colour for a saved fabric (fresh photos use colourTarget, unchanged). */
  const [savedColour, setSavedColour] = useState<SavedColourSession | null>(null);
  /** Card whose saved fabric is being opened in / saved from the colour studio; its buttons are disabled. */
  const [colourBusyCard, setColourBusyCard] = useState<string | null>(null);
  const [colourCardError, setColourCardError] = useState<{ card: string; message: string } | null>(null);
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
  /** "Ref" line for a generation error; only shown while that same error text is on screen. */
  const [errorRef, setErrorRef] = useState<{ forText: string; ref: string } | null>(null);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [showTryOnFlow, setShowTryOnFlow] = useState(false);
  /** Remembered looks that finished while nobody was waiting; the first one gets the banner. */
  const [readyLookIds, setReadyLookIds] = useState<string[]>([]);
  const [slowLookNote, setSlowLookNote] = useState(false);

  const [multiSelections, setMultiSelections] = useState<Record<string, MultiFabricSelection>>({});
  /** White / Black per optional slot id; a slot not listed here uses White. */
  const [slotDefaults, setSlotDefaults] = useState<Record<string, DefaultFabricChoice>>({});

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
  // Only the first slot (lowest sort_order) needs a fabric; the others can use White / Black.
  const requiredSlot = sortedFabricSlots[0] ?? null;
  const requiredSlotFilled = !!requiredSlot && isSlotFilled(multiSelections[requiredSlot.id]);

  const selectedFabricImageId = existingFabricImage?.id ?? "";
  const shopId = shopContext?.shop_id ?? null;
  // Read by the remembered-look checks, which run outside React's render.
  const visualizingIdRef = useRef<string | null>(null);
  visualizingIdRef.current = visualizingGenerationId;
  readyLookIdsRef.current = readyLookIds;
  const garmentHasHero = !!(selectedGarment?.hero_thumb_signed_url || selectedGarment?.hero_image_signed_url);

  const fabricReady = !!fabricFile || !!existingFabricImage?.id;
  const fabricsReady = isMulti ? requiredSlotFilled : fabricReady;
  const heroReady = !!heroReplacementFile || !!selectedGarment?.default_hero_image_id;
  const actionBusy = loadingGarmentTypes || loadingPickedFabric || creatingGeneration || !!visualizingGenerationId;
  const canGenerate = fabricReady && !!selectedGarment && heroReady && !actionBusy;
  const canGenerateMulti = !!selectedGarment && requiredSlotFilled && heroReady && !actionBusy;
  const canSew = isMulti ? canGenerateMulti : canGenerate;
  const canTryOn = !!selectedGarment && fabricsReady && !actionBusy;

  const actionHint = !selectedGarment
    ? "Pick a style to continue"
    : !fabricsReady
      ? isMulti
        ? `Add the ${requiredSlot?.label ?? "first"} fabric to continue`
        : "Add the fabric to continue"
      : !heroReady
        ? "Add a model photo for this style to continue"
        : null;

  useEffect(() => {
    if (!fabricPreviewUrl?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(fabricPreviewUrl);
  }, [fabricPreviewUrl]);

  // The phone's Back button closes the "My Fabrics" picker instead of leaving Generate:
  // while it is open there is one extra history entry (same URL); Back pops it. Closing
  // it any other way removes that entry again. Runs once per open (GeneratePage is
  // already mounted then), so StrictMode's double mount does not add a second entry.
  const fabricPickerOpen = !!fabricPickerTarget;
  useEffect(() => {
    if (!fabricPickerOpen) return;
    let poppedByBack = false;
    try {
      window.history.pushState({ ...(window.history.state ?? {}), aivastraFabricPicker: true }, "");
    } catch {
      return;
    }
    function handlePopState() {
      poppedByBack = true;
      setFabricPickerTarget(null);
    }
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (!poppedByBack && window.history.state?.aivastraFabricPicker) window.history.back();
    };
  }, [fabricPickerOpen]);

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

        const signed = await signFabricPreviewUrl(row.storage_path);
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

    const handleStatusRow = (row: {
      id: string;
      status: string;
      error: string | null;
      error_code?: string | null;
    }) => {
      if (cancelled) return;

      if (row.status === "done" || row.status === "failed") {
        // A failed look may have been refunded.
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      }

      if (row.status === "done") {
        // Opened right away, so it is not offered again as "Your look is ready".
        forgetLook(shopId, row.id);
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
        console.error("[generate] generation failed", row.error, row.error_code ?? "");
        forgetLook(shopId, row.id);
        setVisualizingGenerationId(null);
        setStatusText("");
        showGenerationError(errorCodeMessage(row.error_code, "look") ?? GENERIC_ERROR_MESSAGE, failureRefRef.current);
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
  }, [accessToken, navigate, queryClient, visualizingGenerationId, shopId]);

  function showGenerationError(message: string, ref: string | null) {
    setErrorText(message);
    setErrorRef(ref ? { forText: message, ref } : null);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Waiting limit: after 6 minutes (counted from when the look was made) the page is no
  // longer blocked; the look keeps being checked quietly so the banner can still appear.
  useEffect(() => {
    if (!visualizingGenerationId) return;
    const id = visualizingGenerationId;
    const createdAt = pendingLookCreatedAt(shopId, id) ?? Date.now();
    const timer = window.setTimeout(() => {
      if (visualizingIdRef.current !== id) return;
      slowNotedRef.current.add(id);
      setVisualizingGenerationId(null);
      setStatusText("");
      setSlowLookNote(true);
    }, Math.max(0, createdAt + SEW_WAIT_LIMIT_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [visualizingGenerationId, shopId]);

  /**
   * Looks this phone made in the last 30 minutes that nobody is waiting on: still
   * running -> the normal waiting state again (or quietly, past the waiting limit);
   * done -> "Your look is ready" banner; failed -> its message, once.
   */
  async function checkRememberedLooks() {
    if (!accessToken || !shopId || checkingLooksRef.current) return;
    const looks = listPendingLooks(shopId).filter(
      (look) => look.id !== visualizingIdRef.current && !readyLookIdsRef.current.includes(look.id)
    );
    if (!looks.length) return;
    checkingLooksRef.current = true;
    try {
      // Newest first: the newest look still running is the one waited on.
      for (const look of looks) {
        let row: GenerationRow;
        try {
          row = await apiFetch<GenerationRow>(`/generations/${encodeURIComponent(look.id)}`, accessToken, {
            method: "GET"
          });
        } catch (err) {
          // Gone (deleted): nothing to wait for. Anything else: try again later.
          if (err instanceof ApiError && err.status === 404) forgetLook(shopId, look.id);
          else console.warn("[generate] remembered look check failed", look.id, err);
          continue;
        }
        if (!mountedRef.current) return;
        if (row.id !== look.id) continue;

        if (row.status === "done") {
          setReadyLookIds((prev) => (prev.includes(row.id) ? prev : [...prev, row.id]));
          setSlowLookNote(false);
          void queryClient.invalidateQueries({ queryKey: ["me"] });
        } else if (row.status === "failed") {
          forgetLook(shopId, row.id);
          console.error("[generate] remembered look failed", row.id, row.error, row.error_code ?? "");
          setSlowLookNote(false);
          showGenerationError(errorCodeMessage(row.error_code, "look") ?? GENERIC_ERROR_MESSAGE, null);
          // A failed look may have been refunded.
          void queryClient.invalidateQueries({ queryKey: ["me"] });
        } else if (isPendingStatus(row.status)) {
          const waitedMs = Date.now() - look.createdAt;
          if (waitedMs < SEW_WAIT_LIMIT_MS) {
            if (!visualizingIdRef.current && !sewBusyRef.current) {
              // As if it had just been created.
              failureRefRef.current = null;
              visualizingIdRef.current = row.id;
              setVisualizingGenerationId(row.id);
              setStatusText("Generating look...");
            }
          } else if (!slowNotedRef.current.has(row.id)) {
            slowNotedRef.current.add(row.id);
            setSlowLookNote(true);
          }
        }
      }
    } finally {
      checkingLooksRef.current = false;
    }
  }
  const checkLooksRef = useRef(checkRememberedLooks);
  checkLooksRef.current = checkRememberedLooks;

  // When Generate opens, when the app comes back to the front, and quietly every
  // 15 s while a remembered look is not being waited on.
  useEffect(() => {
    if (!accessToken || !shopId) return;
    void checkLooksRef.current();
    function handleVisible() {
      if (document.visibilityState === "visible") void checkLooksRef.current();
    }
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("pageshow", handleVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (listPendingLooks(shopId).some((look) => look.id !== visualizingIdRef.current)) void checkLooksRef.current();
    }, QUIET_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("pageshow", handleVisible);
      window.clearInterval(timer);
    };
  }, [accessToken, shopId]);

  function viewReadyLook(id: string) {
    forgetLook(shopId, id);
    setReadyLookIds((prev) => prev.filter((item) => item !== id));
    navigate(`/output-viewer?generationId=${encodeURIComponent(id)}`);
  }

  function dismissReadyLook(id: string) {
    forgetLook(shopId, id);
    setReadyLookIds((prev) => prev.filter((item) => item !== id));
  }

  function assignFabricToSlot(slotId: string, selection: MultiFabricSelection) {
    setMultiSelections((prev) => ({ ...prev, [slotId]: selection }));
  }

  function dismissColourCardError(card: string) {
    setColourCardError((prev) => (prev?.card === card ? null : prev));
  }

  function removeSlotFabric(slotId: string) {
    dismissColourCardError(slotId);
    setMultiSelections((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
    // The White / Black row comes back with White selected.
    setSlotDefaults((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  }

  /** {apply_to: "white" | "black"} for each optional slot with no fabric; null when there are none. */
  function buildDefaultFabrics(selections: Record<string, MultiFabricSelection>) {
    const defaults: Record<string, DefaultFabricChoice> = {};
    sortedFabricSlots.slice(1).forEach((slot) => {
      if (isSlotFilled(selections[slot.id])) return;
      defaults[slot.apply_to] = slotDefaults[slot.id] ?? "white";
    });
    return Object.keys(defaults).length ? defaults : null;
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
            const signed = await signFabricPreviewUrl(row.storage_path);
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
        const signed = await signFabricPreviewUrl(row.storage_path);
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

  /**
   * A saved fabric picked in the "My Fabrics" picker. It is used by its id (never
   * uploaded again), exactly like a fabric returned from /fabric-silo.
   */
  async function handleSavedFabricPicked(row: FabricImageRow) {
    const target = fabricPickerTarget;
    setFabricPickerTarget(null);
    if (!target) return;

    dismissColourCardError(colourCardKey(target));
    // The tile already signed this link, so this is normally instant.
    const previewUrl = await signFabricPreviewUrl(row.storage_path);
    if (target.kind === "single") {
      setExistingFabricImage(row);
      setFabricFile(null);
      setFabricColourAdjusted(false);
      setFabricPreviewUrl(previewUrl);
      setPhotoError((prev) => (prev?.picker === "fabric" ? null : prev));
    } else {
      assignFabricToSlot(target.slotId, { fabricImageId: row.id, previewUrl, label: getFabricLabel(row) });
      if (photoSlotId === target.slotId) setPhotoError((prev) => (prev?.picker === "multi" ? null : prev));
    }
    setErrorText(null);
  }

  function clearFabricSelection() {
    dismissColourCardError("single");
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
    setSlotDefaults({});
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
    dismissColourCardError("single");
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

    await uploadFabricPhoto(storagePath, file);

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

  /** The chosen fabric's saved row; a new photo is uploaded once and then reused. */
  async function ensureFabricImage(options: { showStatus?: boolean } = {}) {
    if (existingFabricImage?.id) return existingFabricImage;
    if (fabricFile) {
      const saved = uploadedFabricRef.current;
      if (saved && saved.file === fabricFile) return saved.row;
      if (options.showStatus) setStatusText("Uploading fabric image...");
      const row = await uploadFabricImage(fabricFile);
      uploadedFabricRef.current = { file: fabricFile, row };
      return row;
    }
    throw new MissingFabricError("Select a fabric image first.");
  }

  async function ensureHeroImageId(garment: GarmentType) {
    if (heroReplacementFile) {
      const saved = uploadedHeroRef.current;
      if (saved && saved.file === heroReplacementFile) return saved.id;
      const row = await uploadHeroReplacement(heroReplacementFile, garment);
      uploadedHeroRef.current = { file: heroReplacementFile, id: row.id };
      return row.id;
    }

    if (garment.default_hero_image_id) return garment.default_hero_image_id;

    throw new Error("This garment type has no default hero image.");
  }

  /**
   * POST /generations with one ticket per unchanged request (same garment, fabrics,
   * default fabric choices and product details = same body = same ticket). No answer
   * or 503: sent again with the same ticket after 2 s and 5 s. A "duplicate": true
   * answer is the look already made for this ticket, not charged again.
   */
  async function postGeneration(garmentId: string, body: Record<string, unknown>) {
    if (!accessToken) throw new Error("Not authenticated");
    const tickets = sewTicketsRef.current;
    const attempt = newAttempt("look", garmentId, tickets.ticketFor(JSON.stringify([garmentId, body])));
    setStatusText("Creating generation job...");
    try {
      const response = await withSewRetries(
        () =>
          apiFetch<GenerationCreateResponse>(
            "/generations",
            accessToken,
            { method: "POST", body: JSON.stringify(body) },
            attempt
          ),
        { onRetry: () => setStatusText("Connection slow, trying again...") }
      );
      tickets.finish();
      return { response, attempt };
    } catch (err) {
      // No answer / 503 keeps the ticket, so a manual retry can never be charged twice.
      tickets.finish(err);
      throw err;
    }
  }

  /** A look was created (or found again for this ticket): remember it and wait for it. */
  function startWaitingForLook(response: GenerationCreateResponse, attempt: Attempt) {
    void queryClient.invalidateQueries({ queryKey: ["generations"] });

    if (!response.duplicate && Number.isFinite(response.balance_after)) {
      queryClient.setQueryData(["me"], (prev: typeof me) =>
        prev ? { ...prev, credits_balance: response.balance_after } : prev
      );
    }
    void queryClient.invalidateQueries({ queryKey: ["me"] });

    rememberLook(shopId, response.id);
    failureRefRef.current = refFromId(response.request_id ?? attempt.requestId);
    visualizingIdRef.current = response.id;
    setVisualizingGenerationId(response.id);
    setStatusText("Generating look...");
  }

  async function handleCreateGeneration() {
    if (!accessToken || !selectedGarment || sewBusyRef.current) return;
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

    const fabricMessage = fabricLookError(selectedGarment.name, 0);
    sewBusyRef.current = true;
    setSlowLookNote(false);
    setCreatingGeneration(true);
    try {
      const fabricImage = await ensureFabricImage({ showStatus: true });
      const heroImageId = await ensureHeroImageId(selectedGarment);

      const fabricAssignment: GenerationFabricAssignmentPayload = {
        fabric_image_id: fabricImage.id,
        apply_to: mapGarmentToApplyTo(selectedGarment),
        fabric_code: "unknown",
        fabric_color: null
      };

      const { response, attempt } = await postGeneration(selectedGarment.id, {
        hero_image_id: heroImageId,
        fabric_image_id: fabricImage.id,
        fabrics: [fabricAssignment],
        ...productDetails
      });
      startWaitingForLook(response, attempt);
    } catch (err) {
      console.error("[generate] create failed", err);
      setStatusText("");
      const message = friendlyError(err, fabricMessage);
      reportNoResponse(accessToken, err, message);
      showGenerationError(message, attemptRef(err));
      // Credits may have been taken and refunded.
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setCreatingGeneration(false);
      sewBusyRef.current = false;
    }
  }

  async function handleQuickTryOnSubmit(customerPhotoFile: File, attempt: Attempt): Promise<string> {
    if (!accessToken) throw new Error("Not authenticated");
    if (!selectedFabricImageId && !fabricFile) {
      throw new MissingFabricError("Please select a fabric first");
    }
    if (!selectedGarmentId) {
      throw new Error("Please select a garment type first");
    }
    if (!shopContext) {
      throw new Error("Shop context is still loading.");
    }

    let fabricImageId = selectedFabricImageId;

    if (!fabricImageId && fabricFile) {
      // Uploaded once: a retry or the next try-on (or Sew) reuses the saved fabric.
      const uploaded = await ensureFabricImage();
      fabricImageId = uploaded.id;
    }

    if (!fabricImageId) {
      throw new MissingFabricError("Could not resolve fabric image");
    }

    const compressedPhoto = await compressImage(customerPhotoFile, 1280);

    const formData = new FormData();
    formData.set("fabric_image_id", fabricImageId);
    formData.set("folder_id", selectedGarmentId);
    formData.set("consent_confirmed", "true");
    formData.set("customer_photo", compressedPhoto);

    const blob = await sendTryOn("/tryon/quick/v2", accessToken, formData, attempt);
    return URL.createObjectURL(blob);
  }

  async function uploadMultiFabricImage(file: File) {
    if (!accessToken || !shopContext) throw new Error("Shop context is still loading.");

    const ext = guessFileExtension(file.name, file.type);
    const filename = `${Date.now()}-${makeRandomSuffix()}.${ext}`;
    const storagePath = `${shopContext.shop_id}/${filename}`;

    await uploadFabricPhoto(storagePath, file);

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
    dismissColourCardError(slotId);
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

  /** A saved fabric's full photo (not the small copy) as a Blob for the colour studio. */
  async function downloadFabricPhoto(storagePath: string): Promise<Blob> {
    // Second try re-signs, in case the cached link has expired.
    for (const bypassCache of [false, true]) {
      const urls = await signUrlsBatch("fabric-images", [storagePath], undefined, { bypassCache });
      const url = urls[storagePath];
      // No link means the file is not there; signing again would not help.
      if (!url) break;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.size > 0) return blob;
      } catch (err) {
        console.warn("[generate] fabric photo download failed", err);
      }
    }
    throw new Error("Fabric photo could not be downloaded");
  }

  /** Opens the colour studio on a saved fabric's full photo. On failure only a message is shown. */
  async function openSavedFabricColour(target: ColourTarget, fabricImageId: string, storagePath?: string) {
    if (colourBusyCard) return;
    const card = colourCardKey(target);
    setColourCardError(null);
    setColourBusyCard(card);
    try {
      let path = storagePath;
      if (!path) {
        if (!accessToken) throw new Error("Not authenticated");
        const row = await apiFetch<FabricImageRow>(`/fabric-images/${encodeURIComponent(fabricImageId)}`, accessToken, {
          method: "GET"
        });
        path = row.storage_path;
      }
      const source = await downloadFabricPhoto(path);
      setSavedColour({ target, fabricImageId, source });
    } catch (err) {
      console.error("[generate] couldn't open saved fabric for Match colour", fabricImageId, err);
      setColourCardError({ card, message: SAVED_FABRIC_LOAD_ERROR });
    } finally {
      setColourBusyCard(null);
    }
  }

  /**
   * Saves a colour-corrected saved fabric: uploads the new photo (plus small copy)
   * and points the same fabric at it, so its id stays the same. Without the
   * replace-photo endpoint (404/405) the corrected picture becomes this card's
   * fresh photo instead. Any other failure leaves the saved fabric as it was;
   * the thrown message is shown in the studio, which stays open for another try.
   */
  async function handleSavedFabricColourSaved(blob: Blob) {
    const session = savedColour;
    if (!session) return;
    const card = colourCardKey(session.target);
    setColourBusyCard(card);
    setColourCardError(null);
    try {
      if (!accessToken || !shopContext) throw new Error("Shop context is still loading.");
      const corrected = await compressImage(new File([blob], "fabric.jpg", { type: "image/jpeg" }), 1600);
      const ext = guessFileExtension(corrected.name, corrected.type);
      const storagePath = `${shopContext.shop_id}/${Date.now()}-${makeRandomSuffix()}.${ext}`;
      await uploadFabricPhoto(storagePath, corrected);

      let updated: FabricImageRow | null;
      try {
        updated = await apiFetch<FabricImageRow | null>(
          `/fabric-images/${encodeURIComponent(session.fabricImageId)}/replace-photo`,
          accessToken,
          {
            method: "POST",
            body: JSON.stringify({
              storage_path: storagePath,
              mime_type: corrected.type || "image/jpeg",
              file_size_bytes: corrected.size
            })
          }
        );
      } catch (err) {
        if (!isMissingReplaceEndpoint(err)) throw err;
        // Older backend: use the corrected picture as this card's fresh photo, as if just captured.
        const previewUrl = URL.createObjectURL(corrected);
        if (session.target.kind === "single") {
          setExistingFabricImage(null);
          setFabricFile(corrected);
          setFabricPreviewUrl(previewUrl);
          setFabricColourAdjusted(true);
        } else {
          assignFabricToSlot(session.target.slotId, {
            fabricImageId: "",
            previewUrl,
            label: "New fabric",
            pendingFile: corrected,
            colourAdjusted: true
          });
        }
        setSavedColour(null);
        return;
      }

      // Same fabric id, new photo.
      const fabricImageId = session.fabricImageId;
      const previewUrl = URL.createObjectURL(corrected);
      if (session.target.kind === "single") {
        setExistingFabricImage((prev) =>
          prev && prev.id === fabricImageId
            ? { ...prev, ...(updated ?? {}), id: fabricImageId, storage_path: updated?.storage_path ?? storagePath }
            : prev
        );
        setFabricPreviewUrl(previewUrl);
        setFabricColourAdjusted(true);
      } else {
        const slotId = session.target.slotId;
        setMultiSelections((prev) => {
          const selection = prev[slotId];
          if (!selection || selection.fabricImageId !== fabricImageId) return prev;
          return { ...prev, [slotId]: { ...selection, previewUrl, colourAdjusted: true } };
        });
      }
      // My Fabrics shows the corrected picture (the fabric is still listed once).
      void queryClient.invalidateQueries({ queryKey: FABRIC_IMAGES_QUERY_KEY });
      setSavedColour(null);
    } catch (err) {
      console.error("[generate] saving colour change for saved fabric failed", session.fabricImageId, err);
      setColourCardError({ card, message: SAVED_FABRIC_SAVE_ERROR });
      throw new Error(SAVED_FABRIC_SAVE_ERROR);
    } finally {
      setColourBusyCard(null);
    }
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
    if (!accessToken || !selectedGarment || !requiredSlotFilled || sewBusyRef.current) return;
    sewBusyRef.current = true;
    setErrorText(null);
    setSlowLookNote(false);

    const fabricMessage = fabricLookError(selectedGarment.name, sortedFabricSlots.length);
    setCreatingGeneration(true);
    try {
      const selections = await uploadPendingMultiFabrics();
      const heroImageId = await ensureHeroImageId(selectedGarment);

      // Empty optional slots are not sent here; they go in default_fabrics instead.
      const fabrics: GenerationFabricAssignmentPayload[] = sortedFabricSlots
        .filter((slot, index) => index === 0 || isSlotFilled(selections[slot.id]))
        .map((slot) => {
          const selection = selections[slot.id];
          if (!selection?.fabricImageId) throw new MissingFabricError(`Missing fabric selection for ${slot.label}.`);

          return {
            fabric_image_id: selection.fabricImageId,
            apply_to: slot.apply_to as ApplyToTarget,
            fabric_code: selection.label !== "New fabric" ? selection.label : "unknown",
            fabric_color: null
          };
        });
      const defaultFabrics = buildDefaultFabrics(selections);

      const { response, attempt } = await postGeneration(selectedGarment.id, {
        hero_image_id: heroImageId,
        fabrics,
        ...(defaultFabrics ? { default_fabrics: defaultFabrics } : {})
      });
      startWaitingForLook(response, attempt);
    } catch (err) {
      console.error("[generate] create failed", err);
      setStatusText("");
      const message = friendlyError(err, fabricMessage);
      reportNoResponse(accessToken, err, message);
      showGenerationError(message, attemptRef(err));
      // Credits may have been taken and refunded.
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setCreatingGeneration(false);
      sewBusyRef.current = false;
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
    const headers: Record<string, string> = {};
    if (tryOnRequestIdRef.current) headers["X-Client-Request-Id"] = tryOnRequestIdRef.current;
    await apiFetch("/tryon/push-to-screen", accessToken, { method: "POST", body: fd, headers });
  }

  async function handleShowCarousel(): Promise<void> {
    if (!me?.shop_id) return;
    const { error } = await supabase.rpc("set_screen_mode", { p_shop_id: me.shop_id, p_mode: "catalog" });
    if (error) throw new Error(error.message);
  }

  async function handleMultiTryOnSubmit(customerPhotoFile: File, attempt: Attempt): Promise<string> {
    if (!accessToken) throw new Error("Not authenticated");
    if (!selectedGarment) throw new Error("Select a garment type first.");
    if (!requiredSlotFilled) throw new MissingFabricError("Add the first fabric first.");
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
    const defaultFabrics = buildDefaultFabrics(selections);
    if (defaultFabrics) formData.set("default_fabrics", JSON.stringify(defaultFabrics));

    const blob = await sendTryOn("/tryon/multi/v2", accessToken, formData, attempt);
    return URL.createObjectURL(blob);
  }

  /** Try-on errors shown in the flow are plain text; the raw error goes to the console. */
  async function handleTryOnSubmit(customerPhotoFile: File, ticket: string): Promise<string> {
    // One ticket per try-on (TryOnFlow keeps it for a retry of the same photo and selection).
    const attempt = newAttempt("tryon", isMulti ? selectedGarment?.id : selectedGarmentId, ticket);
    tryOnRequestIdRef.current = attempt.requestId;
    try {
      return await (isMulti
        ? handleMultiTryOnSubmit(customerPhotoFile, attempt)
        : handleQuickTryOnSubmit(customerPhotoFile, attempt));
    } catch (err) {
      console.error("[try-on] failed", err);
      if (err instanceof Error && err.message === PHOTO_READ_ERROR) throw err;
      throw tryOnFailure(err, accessToken, () =>
        friendlyError(
          err,
          `Couldn't create the try-on for ${selectedGarment?.name ?? "this style"}. Check the fabrics and try again.`
        )
      );
    }
  }

  function renderFabricCard(card: {
    key: string;
    title: string;
    optional?: boolean;
    tag?: string;
    previewUrl: string | null;
    previewAlt: string;
    onRemove: (() => void) | null;
    onCapture: () => void;
    onGallery: () => void;
    /** Opens the saved-fabric picker for this card. */
    onMyFabrics: () => void;
    onMatchColour: (() => void) | null;
    colourAdjusted: boolean;
    /** Shown beside the picture (the White / Black choice of an empty optional slot). */
    belowActions?: ReactNode;
    status: ReactNode;
  }) {
    // A saved fabric being opened in / saved from the colour studio locks this card only.
    const colourBusy = colourBusyCard === card.key;
    const cardBusy = actionBusy || colourBusy;
    const colourError = colourCardError?.card === card.key ? colourCardError.message : null;
    return (
      <div key={card.key} className="fabric-card">
        <div className="fabric-card-head">
          <span className="fabric-card-title">
            {card.title}
            {card.optional ? <span className="fabric-card-optional"> (optional)</span> : null}
          </span>
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
                disabled={cardBusy}
                aria-label="Remove fabric"
              >
                &times;
              </button>
            ) : null}
          </div>

          <div className="fabric-card-actions">
            {card.onMatchColour || card.colourAdjusted ? (
              <div className="row">
                {card.onMatchColour ? (
                  <button
                    className="btn btn-light"
                    type="button"
                    style={{ minHeight: "36px", padding: "0 12px", fontSize: "12px" }}
                    onClick={card.onMatchColour}
                    disabled={cardBusy}
                  >
                    🎨 Match colour
                  </button>
                ) : null}
                {card.colourAdjusted ? <span className="chip">Colour adjusted</span> : null}
              </div>
            ) : null}
            {card.belowActions}
          </div>
        </div>

        {/* Full card width, so all three fit on one line even on a 320 px phone. */}
        <div className="fabric-card-pick-row">
          <button className="btn btn-light" type="button" onClick={card.onCapture} disabled={cardBusy}>
            Capture
          </button>
          <button className="btn btn-light" type="button" onClick={card.onGallery} disabled={cardBusy}>
            Gallery
          </button>
          <button className="btn btn-light" type="button" onClick={card.onMyFabrics} disabled={cardBusy}>
            My Fabrics
          </button>
        </div>

        {colourBusy ? (
          <div className="photo-pick-status" role="status">
            <div className="spinner spinner-small" />
            <span>{savedColour ? "Saving colour…" : "Loading fabric…"}</span>
          </div>
        ) : null}
        {colourError ? (
          <p className="error-text" role="alert">
            {colourError}
          </p>
        ) : null}
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

        {readyLookIds[0] ? (
          <div className="look-ready-banner" role="status">
            <span className="look-ready-text">Your look is ready</span>
            <button className="look-ready-view" type="button" onClick={() => viewReadyLook(readyLookIds[0] as string)}>
              View
            </button>
            <button
              className="look-ready-dismiss"
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissReadyLook(readyLookIds[0] as string)}
            >
              ×
            </button>
          </div>
        ) : null}

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
              {/* A garment with no hero of its own asks for a model photo here. */}
              {heroChangeOpen || !garmentHasHero ? (
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
              {!garmentHasHero && heroReplacementFile ? <p className="tiny muted">Model photo added ✓</p> : null}
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
                  const optional = index > 0;
                  const defaultChoice = slotDefaults[slot.id] ?? "white";
                  return renderFabricCard({
                    key: slot.id,
                    title: `${index + 1}. ${slot.label}`,
                    optional,
                    tag: slot.apply_to,
                    previewUrl: selection?.previewUrl ?? null,
                    previewAlt: selection?.label ?? slot.label,
                    onRemove: selection ? () => removeSlotFabric(slot.id) : null,
                    onCapture: () => openMultiPicker(slot.id, "camera"),
                    onGallery: () => openMultiPicker(slot.id, "gallery"),
                    onMyFabrics: () => setFabricPickerTarget({ kind: "multi", slotId: slot.id }),
                    onMatchColour: selection?.pendingFile
                      ? () => setColourTarget({ kind: "multi", slotId: slot.id })
                      : selection?.fabricImageId
                        ? () => void openSavedFabricColour({ kind: "multi", slotId: slot.id }, selection.fabricImageId)
                        : null,
                    colourAdjusted: !!selection?.colourAdjusted,
                    belowActions:
                      optional && !isSlotFilled(selection) ? (
                        <div className="default-fabric-row">
                          <span className="default-fabric-label">No fabric? Use:</span>
                          <div className="default-fabric-options" role="group" aria-label={`Plain fabric for ${slot.label}`}>
                            {DEFAULT_FABRIC_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={`default-fabric-toggle ${defaultChoice === option.value ? "selected" : ""}`}
                                aria-pressed={defaultChoice === option.value}
                                onClick={() => setSlotDefaults((prev) => ({ ...prev, [slot.id]: option.value }))}
                                disabled={actionBusy}
                              >
                                <span className={`default-fabric-swatch ${option.value}`} aria-hidden />
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null,
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
                  onMyFabrics: () => setFabricPickerTarget({ kind: "single" }),
                  onMatchColour: fabricFile
                    ? () => setColourTarget({ kind: "single" })
                    : existingFabricImage
                      ? () =>
                          void openSavedFabricColour(
                            { kind: "single" },
                            existingFabricImage.id,
                            existingFabricImage.storage_path
                          )
                      : null,
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
          <p className="credit-cost-hint">Uses 50 credits</p>
          <button className="text-link-btn" type="button" onClick={() => navigate("/recent-tryons")}>
            Recent try-ons
          </button>

          {actionBusy && !loadingGarmentTypes ? (
            <div className="loading-box">
              <div className="spinner" />
              <p className="tiny muted">{statusText || "Working..."}</p>
            </div>
          ) : null}

          {slowLookNote && !actionBusy ? (
            <p className="info-box" role="status">
              {SLOW_LOOK_MESSAGE}
            </p>
          ) : null}

          {errorText ? (
            <p className="error-box" role="alert">
              {errorText}
            </p>
          ) : null}
          {errorText && errorRef?.forText === errorText ? <p className="tiny muted">Ref: {errorRef.ref}</p> : null}
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

      {savedColour ? (
        <ColorStudio
          source={savedColour.source}
          allowSegment
          defaultSegment={false}
          onSave={handleSavedFabricColourSaved}
          onClose={() => setSavedColour(null)}
        />
      ) : null}

      {fabricPickerTarget ? (
        <FabricPickerOverlay
          onSelect={(row) => void handleSavedFabricPicked(row)}
          onClose={() => setFabricPickerTarget(null)}
        />
      ) : null}

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
