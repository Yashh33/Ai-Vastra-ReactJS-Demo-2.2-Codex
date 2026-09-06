import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { supabase } from "../lib/supabase";
import { createSignedUrl } from "../lib/storage";
import {
  subscribeToShopGenerations,
  subscribeToShopScreenState,
  type ShopScreenGenerationRow,
  type ShopScreenStateRow
} from "../lib/realtime";

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;
const CAROUSEL_LIMIT = 30;
const CAROUSEL_INTERVAL_MS = 6000;
const POLL_INTERVAL_MS = 5000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CarouselItem = {
  id: string;
  url: string;
};

type CarouselRow = {
  id: string;
  output_path: string;
  created_at: string;
};

type BrowseGarmentType = {
  id: string;
  name: string;
};

type BrowseLookRow = {
  id: string;
  output_path: string;
  created_at: string;
  is_hero: boolean;
  folder_id: string;
};

type ScreenMode = "idle" | "catalog" | "live" | "browse";

type ScreenState = "loading" | "live" | "carousel" | "idle" | "browse" | "not-found";

function normalizeMode(rawMode: string | null | undefined): ScreenMode {
  if (rawMode === "idle" || rawMode === "live" || rawMode === "browse") return rawMode;
  return "catalog";
}

function sortBrowseLooks(rows: BrowseLookRow[]): BrowseLookRow[] {
  return [...rows].sort((a, b) => {
    if (a.is_hero !== b.is_hero) return a.is_hero ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

function carouselRowsEqual(a: CarouselRow[], b: CarouselRow[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.id !== y.id) return false;
  }
  return true;
}

function useStageSize() {
  const [size, setSize] = useState(() => ({ width: window.innerHeight, height: window.innerWidth }));

  useEffect(() => {
    function handleResize() {
      setSize({ width: window.innerHeight, height: window.innerWidth });
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return size;
}

function BrowseTile({
  look,
  urlMapRef,
  onOpen
}: {
  look: BrowseLookRow;
  urlMapRef: { current: Map<string, string> };
  onOpen: (look: BrowseLookRow, url: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(() => urlMapRef.current.get(look.id) ?? null);

  useEffect(() => {
    if (url) return;
    let cancelled = false;

    async function sign() {
      try {
        const signedUrl = await createSignedUrl("generated-outputs", look.output_path, SIGNED_URL_TTL_SECONDS);
        urlMapRef.current.set(look.id, signedUrl);
        if (!cancelled) setUrl(signedUrl);
      } catch (err) {
        console.error("ScreenPage: failed to sign browse tile", look.id, err);
      }
    }

    void sign();

    return () => {
      cancelled = true;
    };
  }, [look.id, look.output_path, url, urlMapRef]);

  return (
    <button
      type="button"
      className="tv-browse-tile"
      tabIndex={0}
      onClick={() => url && onOpen(look, url)}
    >
      {url ? <img src={url} alt="Look" /> : <div className="tv-browse-tile-placeholder" />}
      {look.is_hero ? (
        <span className="tv-browse-hero-badge" aria-label="Hero look">
          ★
        </span>
      ) : null}
    </button>
  );
}

export function ScreenPage() {
  const { shopId } = useParams<{ shopId: string }>();
  const stageSize = useStageSize();

  const [screenState, setScreenState] = useState<ScreenState>("loading");
  const [mode, setMode] = useState<ScreenMode | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [liveHasBanner, setLiveHasBanner] = useState(false);
  const [carouselRows, setCarouselRows] = useState<CarouselRow[]>([]);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [currentCarouselImage, setCurrentCarouselImage] = useState<CarouselItem | null>(null);
  const [resolvedShopId, setResolvedShopId] = useState<string | null>(null);
  const [browseGarmentTypes, setBrowseGarmentTypes] = useState<BrowseGarmentType[]>([]);
  const [browseSelectedGarmentTypeId, setBrowseSelectedGarmentTypeId] = useState<string | null>(null);
  const [browseLooks, setBrowseLooks] = useState<BrowseLookRow[]>([]);
  const [browseDetailLook, setBrowseDetailLook] = useState<BrowseLookRow | null>(null);
  const [browseDetailUrl, setBrowseDetailUrl] = useState<string | null>(null);
  const [browseHeroPending, setBrowseHeroPending] = useState(false);
  const [browseHeroError, setBrowseHeroError] = useState<string | null>(null);
  const [browseRefreshKey, setBrowseRefreshKey] = useState(0);
  const [browseRefreshing, setBrowseRefreshing] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  const liveGenerationIdRef = useRef<string | null>(null);
  const liveIsRealRef = useRef(false);
  const carouselUrlMapRef = useRef<Map<string, string>>(new Map());
  const carouselRowsRef = useRef<CarouselRow[]>([]);
  const browseUrlMapRef = useRef<Map<string, string>>(new Map());
  const appliedModeRef = useRef<ScreenMode | null>(null);
  const loadInitialRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!shopId) return;
    const routeParam = shopId;
    let cancelled = false;
    setResolvedShopId(null);
    setMode(null);
    setScreenState("loading");

    async function resolveShopId() {
      if (UUID_REGEX.test(routeParam)) {
        if (!cancelled) setResolvedShopId(routeParam);
        return;
      }

      const { data, error } = await supabase.rpc("resolve_shop_by_slug", { p_slug: routeParam });

      if (cancelled) return;

      if (error || !data) {
        setScreenState("not-found");
        return;
      }

      setResolvedShopId(data);
    }

    void resolveShopId();

    return () => {
      cancelled = true;
    };
  }, [shopId]);

  useEffect(() => {
    if (!resolvedShopId) return;
    let cancelled = false;

    liveGenerationIdRef.current = null;
    liveIsRealRef.current = false;
    carouselUrlMapRef.current = new Map();
    carouselRowsRef.current = [];
    browseUrlMapRef.current = new Map();
    appliedModeRef.current = null;

    function clearLiveTracking() {
      if (liveGenerationIdRef.current !== null) {
        liveGenerationIdRef.current = null;
        liveIsRealRef.current = false;
        setLiveUrl(null);
        setLiveHasBanner(false);
      }
    }

    async function activateLiveFallback() {
      const newest = carouselRowsRef.current[0];

      if (!newest) {
        clearLiveTracking();
        setScreenState("loading");
        return;
      }

      if (liveGenerationIdRef.current === newest.id && !liveIsRealRef.current) return;

      let url = carouselUrlMapRef.current.get(newest.id);
      if (!url) {
        try {
          url = await createSignedUrl("generated-outputs", newest.output_path, SIGNED_URL_TTL_SECONDS);
          carouselUrlMapRef.current.set(newest.id, url);
        } catch (err) {
          console.error("ScreenPage: failed to sign fallback live image", newest.id, err);
          return;
        }
      }

      if (cancelled) return;

      liveGenerationIdRef.current = newest.id;
      liveIsRealRef.current = false;
      setLiveUrl(url);
      setLiveHasBanner(false);
      setScreenState("live");
    }

    async function activateLive(generationId: string) {
      if (liveGenerationIdRef.current === generationId && liveIsRealRef.current) return;

      const { data: genRow } = await supabase
        .from("generations")
        .select("id,output_path")
        .eq("id", generationId)
        .maybeSingle();

      if (cancelled) return;

      if (!genRow?.output_path) {
        await activateLiveFallback();
        return;
      }

      try {
        const url = await createSignedUrl("generated-outputs", genRow.output_path, SIGNED_URL_TTL_SECONDS);
        if (cancelled) return;
        liveGenerationIdRef.current = generationId;
        liveIsRealRef.current = true;
        setLiveUrl(url);
        setLiveHasBanner(true);
        setScreenState("live");
      } catch (err) {
        console.error("ScreenPage: failed to sign live generation URL", err);
      }
    }

    function applyState(rawMode: string | null | undefined, liveGenId: string | null) {
      const normalizedMode = normalizeMode(rawMode);
      const modeChanged = appliedModeRef.current !== normalizedMode;
      appliedModeRef.current = normalizedMode;
      setMode(normalizedMode);

      if (normalizedMode !== "live") {
        clearLiveTracking();
      }

      if (normalizedMode === "idle") {
        setScreenState("idle");
        return;
      }

      if (normalizedMode === "live") {
        if (modeChanged) setScreenState("loading");
        if (liveGenId) {
          void activateLive(liveGenId);
        } else {
          void activateLiveFallback();
        }
        return;
      }

      if (normalizedMode === "browse") {
        if (modeChanged) {
          setBrowseDetailLook(null);
          setBrowseDetailUrl(null);
          setBrowseHeroError(null);
        }
        setScreenState("browse");
        return;
      }

      if (modeChanged) {
        setCarouselIndex(0);
        setScreenState("loading");
      }
    }

    async function loadInitial() {
      const { data: approvedRows } = await supabase
        .from("generations")
        .select("id,output_path,created_at")
        .eq("shop_id", resolvedShopId)
        .eq("generation_type", "look")
        .order("created_at", { ascending: false })
        .limit(CAROUSEL_LIMIT);

      if (cancelled) return;

      const rows: CarouselRow[] = (approvedRows ?? [])
        .filter((row: { output_path: string | null }) => !!row.output_path)
        .map((row: { id: string; output_path: string; created_at: string }) => row);

      const currentIds = new Set(rows.map((row) => row.id));
      for (const id of Array.from(carouselUrlMapRef.current.keys())) {
        if (!currentIds.has(id)) carouselUrlMapRef.current.delete(id);
      }

      carouselRowsRef.current = rows;
      setCarouselRows((prev) => (carouselRowsEqual(prev, rows) ? prev : rows));

      const { data: stateRow } = await supabase
        .from("shop_screen_state")
        .select("mode,live_generation_id")
        .eq("shop_id", resolvedShopId)
        .maybeSingle();

      if (cancelled) return;

      applyState(stateRow?.mode ?? null, stateRow?.live_generation_id ?? null);
    }

    loadInitialRef.current = loadInitial;
    void loadInitial();

    const pollTimer = window.setInterval(() => {
      void loadInitial();
    }, POLL_INTERVAL_MS);

    const unsubscribeState = subscribeToShopScreenState(resolvedShopId, (row: ShopScreenStateRow) => {
      if (cancelled) return;
      applyState(row.mode, row.live_generation_id);
    });

    const unsubscribeGenerations = subscribeToShopGenerations(resolvedShopId, (row: ShopScreenGenerationRow) => {
      if (cancelled || !row.output_path || row.generation_type !== "look") return;
      const outputPath = row.output_path;
      setCarouselRows((prev) => {
        if (prev.some((item) => item.id === row.id)) return prev;
        const next = [{ id: row.id, output_path: outputPath, created_at: row.created_at }, ...prev];
        carouselRowsRef.current = next;
        return next;
      });
    });

    return () => {
      cancelled = true;
      loadInitialRef.current = null;
      window.clearInterval(pollTimer);
      unsubscribeState();
      unsubscribeGenerations();
    };
  }, [resolvedShopId]);

  useEffect(() => {
    if (mode !== "catalog") return;

    if (!carouselRows.length) {
      setCurrentCarouselImage(null);
      return;
    }

    let cancelled = false;
    let skipTimer: number | undefined;
    const length = carouselRows.length;
    const idx = ((carouselIndex % length) + length) % length;
    const row = carouselRows[idx];
    if (!row) return;

    async function showFrame() {
      if (!row) return;
      let resolvedUrl = carouselUrlMapRef.current.get(row.id);

      if (!resolvedUrl) {
        try {
          resolvedUrl = await createSignedUrl("generated-outputs", row.output_path, SIGNED_URL_TTL_SECONDS);
          carouselUrlMapRef.current.set(row.id, resolvedUrl);
        } catch (err) {
          console.error("ScreenPage: failed to sign carousel item", row.id, err);
          if (!cancelled) {
            // Don't let one bad frame hold the screen for a full interval — hop past it quickly.
            skipTimer = window.setTimeout(() => {
              setCarouselIndex((prev) => (prev + 1) % length);
            }, 1500);
          }
          return;
        }
      }

      if (cancelled) return;

      const url = resolvedUrl;
      const rowId = row.id;
      setCurrentCarouselImage((prev) => (prev && prev.id === rowId && prev.url === url ? prev : { id: rowId, url }));
      setScreenState("carousel");

      const nextRow = carouselRows[(idx + 1) % length];
      if (nextRow && nextRow.id !== row.id && !carouselUrlMapRef.current.has(nextRow.id)) {
        try {
          const nextUrl = await createSignedUrl("generated-outputs", nextRow.output_path, SIGNED_URL_TTL_SECONDS);
          if (!cancelled) carouselUrlMapRef.current.set(nextRow.id, nextUrl);
        } catch (err) {
          console.error("ScreenPage: failed to prefetch carousel item", nextRow.id, err);
        }
      }
    }

    void showFrame();

    return () => {
      cancelled = true;
      if (skipTimer !== undefined) window.clearTimeout(skipTimer);
    };
  }, [mode, carouselRows, carouselIndex]);

  useEffect(() => {
    if (mode !== "catalog" || carouselRows.length <= 1) return;
    const timer = window.setInterval(() => {
      setCarouselIndex((prev) => (prev + 1) % carouselRows.length);
    }, CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [mode, carouselRows.length]);

  useEffect(() => {
    if (mode !== "browse" || !resolvedShopId) return;
    let cancelled = false;
    setBrowseRefreshing(true);

    async function loadBrowseTabs() {
      try {
        const { data: lookRows } = await supabase
          .from("generations")
          .select("folder_id,output_path")
          .eq("shop_id", resolvedShopId)
          .eq("generation_type", "look")
          .eq("status", "done");

        if (cancelled) return;

        const folderIdsWithLooks = new Set(
          (lookRows ?? [])
            .filter((row: { output_path: string | null }) => !!row.output_path)
            .map((row: { folder_id: string }) => row.folder_id)
        );

        if (folderIdsWithLooks.size === 0) {
          setBrowseGarmentTypes([]);
          setBrowseSelectedGarmentTypeId(null);
          return;
        }

        const { data: garmentTypeRows } = await supabase
          .from("garment_types")
          .select("id,name")
          .eq("shop_id", resolvedShopId);

        if (cancelled) return;

        const tabs: BrowseGarmentType[] = (garmentTypeRows ?? []).filter((row: { id: string }) =>
          folderIdsWithLooks.has(row.id)
        );

        setBrowseGarmentTypes(tabs);
        setBrowseSelectedGarmentTypeId((prev) => (prev && tabs.some((tab) => tab.id === prev) ? prev : tabs[0]?.id ?? null));
      } finally {
        if (!cancelled) setBrowseRefreshing(false);
      }
    }

    void loadBrowseTabs();

    return () => {
      cancelled = true;
    };
  }, [mode, resolvedShopId, browseRefreshKey]);

  useEffect(() => {
    if (mode !== "browse" || !resolvedShopId || !browseSelectedGarmentTypeId) {
      setBrowseLooks([]);
      return;
    }

    let cancelled = false;

    async function loadBrowseLooks() {
      const { data } = await supabase
        .from("generations")
        .select("id,output_path,created_at,is_hero,folder_id")
        .eq("shop_id", resolvedShopId)
        .eq("generation_type", "look")
        .eq("status", "done")
        .eq("folder_id", browseSelectedGarmentTypeId)
        .order("is_hero", { ascending: false })
        .order("created_at", { ascending: false });

      if (cancelled) return;

      const rows: BrowseLookRow[] = (data ?? []).filter(
        (row: { output_path: string | null }) => !!row.output_path
      );

      setBrowseLooks(rows);
    }

    void loadBrowseLooks();

    return () => {
      cancelled = true;
    };
  }, [mode, resolvedShopId, browseSelectedGarmentTypeId, browseRefreshKey]);

  function handleBrowseRefresh() {
    setBrowseRefreshKey((prev) => prev + 1);
  }

  function handleRefresh() {
    if (mode === "browse") {
      handleBrowseRefresh();
    } else {
      void loadInitialRef.current?.();
    }
  }

  useEffect(() => {
    if (!browseDetailLook) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        void navigateBrowseDetail(1);
      } else if (event.key === "ArrowLeft") {
        void navigateBrowseDetail(-1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [browseDetailLook, browseLooks]);

  async function navigateBrowseDetail(direction: 1 | -1) {
    if (!browseDetailLook || browseLooks.length <= 1) return;

    const currentIndex = browseLooks.findIndex((look) => look.id === browseDetailLook.id);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + direction + browseLooks.length) % browseLooks.length;
    const nextLook = browseLooks[nextIndex];
    if (!nextLook) return;

    let url = browseUrlMapRef.current.get(nextLook.id);
    if (!url) {
      try {
        url = await createSignedUrl("generated-outputs", nextLook.output_path, SIGNED_URL_TTL_SECONDS);
        browseUrlMapRef.current.set(nextLook.id, url);
      } catch (err) {
        console.error("ScreenPage: failed to sign browse detail navigation image", nextLook.id, err);
        return;
      }
    }

    setBrowseHeroError(null);
    setBrowseDetailLook(nextLook);
    setBrowseDetailUrl(url);
  }

  async function toggleHero(look: BrowseLookRow) {
    if (browseHeroPending) return;

    const previousIsHero = look.is_hero;
    const nextIsHero = !previousIsHero;

    setBrowseHeroError(null);
    setBrowseHeroPending(true);
    setBrowseDetailLook((prev) => (prev && prev.id === look.id ? { ...prev, is_hero: nextIsHero } : prev));
    setBrowseLooks((prev) =>
      sortBrowseLooks(prev.map((row) => (row.id === look.id ? { ...row, is_hero: nextIsHero } : row)))
    );

    try {
      const { error } = await supabase.rpc("set_generation_hero", {
        p_generation_id: look.id,
        p_is_hero: nextIsHero
      });
      if (error) throw error;
    } catch (err) {
      console.error("ScreenPage: failed to update hero flag", look.id, err);
      setBrowseDetailLook((prev) => (prev && prev.id === look.id ? { ...prev, is_hero: previousIsHero } : prev));
      setBrowseLooks((prev) =>
        sortBrowseLooks(prev.map((row) => (row.id === look.id ? { ...row, is_hero: previousIsHero } : row)))
      );
      setBrowseHeroError("Couldn't update hero. Try again.");
    } finally {
      setBrowseHeroPending(false);
    }
  }

  async function setScreenMode(nextMode: ScreenMode) {
    if (!resolvedShopId) return;
    try {
      const { error } = await supabase.rpc("set_screen_mode", { p_shop_id: resolvedShopId, p_mode: nextMode });
      if (error) console.error("ScreenPage: failed to set screen mode", error);
    } catch (err) {
      console.error("ScreenPage: failed to set screen mode", err);
    }
  }

  function navButtonClass(target: ScreenMode) {
    return `tv-nav-btn${mode === target ? " tv-nav-btn-active" : ""}`;
  }

  const stageStyle = {
    width: `${stageSize.width}px`,
    height: `${stageSize.height}px`
  };

  return (
    <main className="tv-screen">
      <style>{`
        :root {
          --navy: #1B1B2F;
          --gold: #C9A84C;
          --page: #F5F4F1;
          --card: #FFFFFF;
          --border: #E6E4DE;
          --muted: #6B6B72;
        }

        .tv-screen { background: var(--page); }
        .tv-stage { background: var(--page); }
        .tv-media { background: var(--page); }
        .tv-idle { color: var(--navy); }
        .tv-banner {
          left: 50%;
          right: auto;
          bottom: 6%;
          transform: translateX(-50%);
          text-align: center;
          color: var(--navy);
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid var(--border);
          font-size: clamp(1.1rem, 2.6vw, 2rem);
          font-weight: 700;
          text-shadow: none;
          padding: clamp(10px, 1.5vw, 18px) clamp(20px, 3vw, 36px);
          border-radius: 999px;
          box-shadow: 0 10px 30px rgba(27, 27, 47, 0.18);
          white-space: nowrap;
        }

        .tv-shell { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--page); color: var(--navy); overflow: hidden; }

        .tv-mode-nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
          flex-wrap: wrap;
          gap: clamp(12px, 2vw, 24px);
          padding: clamp(12px, 1.8vw, 22px) clamp(16px, 2.5vw, 32px);
          background: var(--card);
          border-bottom: 1px solid var(--border);
        }
        .tv-wordmark { font-size: clamp(1.1rem, 2vw, 1.75rem); font-weight: 800; letter-spacing: 0.02em; white-space: nowrap; }
        .tv-wordmark-primary { color: var(--navy); }
        .tv-wordmark-accent { color: var(--gold); }
        .tv-nav-btn {
          font: inherit;
          font-size: clamp(0.85rem, 1.3vw, 1.15rem);
          font-weight: 700;
          color: var(--navy);
          background: var(--page);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 8px 18px;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .tv-nav-btn:hover { background: #EFEDE8; }
        .tv-nav-btn:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
        .tv-nav-btn-active { background: var(--navy); color: var(--gold); border-color: var(--navy); }

        .tv-header-refresh-btn {
          flex-shrink: 0;
          width: clamp(38px, 5vw, 52px);
          height: clamp(38px, 5vw, 52px);
          border-radius: 50%;
          border: 1px solid var(--border);
          background: var(--page);
          color: var(--navy);
          font-size: clamp(1.1rem, 2vw, 1.5rem);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .tv-header-refresh-btn:hover { background: #EFEDE8; }
        .tv-header-refresh-btn:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
        .tv-header-refresh-btn:disabled { opacity: 0.6; cursor: default; }
        .tv-refresh-icon { display: inline-block; }
        .tv-refresh-icon-spinning { animation: tv-spin 0.8s linear infinite; }
        @keyframes tv-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .tv-mode-content { position: relative; flex: 1; overflow: hidden; }

        .tv-mode-fab-wrap { position: absolute; bottom: clamp(16px, 3vw, 32px); right: clamp(16px, 3vw, 32px); z-index: 20; display: flex; flex-direction: column; align-items: flex-end; }
        .tv-mode-fab {
          width: clamp(44px, 6vw, 64px);
          height: clamp(44px, 6vw, 64px);
          flex-shrink: 0;
          border-radius: 50%;
          border: none;
          background: var(--navy);
          color: var(--gold);
          font-size: clamp(1.25rem, 2.5vw, 1.75rem);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(27, 27, 47, 0.35);
          transition: transform 0.15s ease;
        }
        .tv-mode-fab:hover { transform: scale(1.05); }
        .tv-mode-fab:focus-visible { outline: 3px solid var(--gold); outline-offset: 3px; }
        .tv-mode-popover {
          position: absolute;
          bottom: calc(100% + 12px);
          right: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 12px;
          box-shadow: 0 12px 32px rgba(27, 27, 47, 0.22);
          min-width: clamp(140px, 20vw, 200px);
        }
        .tv-mode-popover .tv-nav-btn { width: 100%; }

        .tv-chooser { flex-direction: column; gap: clamp(24px, 4vw, 48px); }
        .tv-chooser-title { font-size: clamp(1.75rem, 4vw, 3rem); font-weight: 800; letter-spacing: 0.04em; }
        .tv-chooser-buttons { display: flex; gap: clamp(16px, 3vw, 32px); }
        .tv-choice-btn {
          font: inherit;
          font-size: clamp(1.25rem, 2.4vw, 2rem);
          font-weight: 700;
          letter-spacing: 0.02em;
          color: var(--navy);
          background: var(--gold);
          border: none;
          border-radius: 18px;
          padding: clamp(20px, 3vw, 36px) clamp(36px, 5vw, 64px);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .tv-choice-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(201, 168, 76, 0.35); }
        .tv-choice-btn:focus-visible { outline: 4px solid var(--navy); outline-offset: 4px; }

        .tv-browse { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--page); color: var(--navy); overflow: hidden; }

        .tv-browse-body { flex: 1; display: flex; min-height: 0; }
        .tv-browse-rail {
          width: clamp(120px, 16vw, 200px);
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow-y: auto;
          padding: clamp(14px, 1.8vw, 22px) 10px;
          background: var(--card);
          border-right: 1px solid var(--border);
        }
        .tv-browse-rail-list { display: flex; flex-direction: column; gap: 8px; }
        .tv-browse-rail-item {
          width: 100%;
          text-align: left;
          font: inherit;
          font-size: clamp(0.95rem, 1.4vw, 1.2rem);
          font-weight: 600;
          color: var(--navy);
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 14px 16px;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .tv-browse-rail-item:hover { background: #EFEDE8; }
        .tv-browse-rail-item:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
        .tv-browse-rail-item-active { background: var(--navy); color: var(--gold); border-color: var(--navy); }

        .tv-browse-grid {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: clamp(16px, 2vw, 28px);
          padding: clamp(16px, 2.5vw, 32px);
          align-content: start;
        }
        .tv-browse-tile {
          position: relative;
          aspect-ratio: 3 / 4;
          border: 1px solid var(--border);
          border-radius: 14px;
          overflow: hidden;
          padding: 0;
          cursor: pointer;
          background: var(--card);
        }
        .tv-browse-tile img { width: 100%; height: 100%; object-fit: cover; display: block; animation: tv-fade-in 0.4s ease; }
        .tv-browse-tile-placeholder { width: 100%; height: 100%; background: linear-gradient(135deg, var(--page), #EFEDE8); }
        .tv-browse-tile:hover { outline: 3px solid var(--gold); outline-offset: -3px; }
        .tv-browse-tile:focus-visible { outline: 4px solid var(--gold); outline-offset: -4px; }

        .tv-browse-hero-badge {
          position: absolute;
          top: 8px;
          right: 8px;
          width: clamp(22px, 2.5vw, 32px);
          height: clamp(22px, 2.5vw, 32px);
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--gold);
          color: var(--navy);
          border-radius: 50%;
          font-size: clamp(0.75rem, 1.4vw, 1.1rem);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        }
        .tv-browse-hero-badge-lg { top: 5%; right: 5%; width: clamp(36px, 4vw, 56px); height: clamp(36px, 4vw, 56px); font-size: clamp(1.1rem, 2vw, 1.6rem); }

        .tv-browse-empty { display: flex; align-items: center; justify-content: center; flex: 1; font-size: clamp(1.25rem, 2.5vw, 2rem); color: var(--muted); }

        .tv-browse-detail { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--page); }
        .tv-browse-detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: clamp(12px, 2vw, 24px);
          padding: clamp(16px, 2.5vw, 32px) clamp(16px, 2.5vw, 32px) 0;
        }
        .tv-browse-back {
          font: inherit;
          font-size: clamp(1rem, 1.8vw, 1.5rem);
          font-weight: 700;
          color: var(--navy);
          background: var(--gold);
          border: none;
          border-radius: 12px;
          padding: 10px 24px;
          cursor: pointer;
          transition: transform 0.15s ease;
        }
        .tv-browse-back:hover { transform: translateY(-2px); }
        .tv-browse-back:focus-visible { outline: 4px solid var(--navy); outline-offset: 2px; }
        .tv-browse-hero-toggle {
          font: inherit;
          font-size: clamp(1rem, 1.8vw, 1.5rem);
          font-weight: 700;
          color: var(--navy);
          background: var(--card);
          border: 2px solid var(--gold);
          border-radius: 12px;
          padding: 10px 24px;
          cursor: pointer;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .tv-browse-hero-toggle:hover { background: #EFEDE8; transform: translateY(-2px); }
        .tv-browse-hero-toggle:focus-visible { outline: 4px solid var(--gold); outline-offset: 2px; }
        .tv-browse-hero-toggle:disabled { opacity: 0.6; cursor: default; transform: none; }
        .tv-browse-hero-toggle-active { background: var(--gold); color: var(--navy); border-color: var(--gold); }
        .tv-browse-hero-error {
          text-align: center;
          color: #B3261E;
          font-size: clamp(0.9rem, 1.4vw, 1.1rem);
          padding: 8px clamp(16px, 2.5vw, 32px) 0;
        }
        .tv-browse-detail-media { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; }
        .tv-browse-detail-media img { max-width: 92%; max-height: 92%; object-fit: contain; animation: tv-fade-in 0.4s ease; border-radius: 8px; }
        .tv-browse-nav-btn {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: clamp(40px, 5vw, 56px);
          height: clamp(40px, 5vw, 56px);
          flex-shrink: 0;
          border-radius: 50%;
          border: none;
          background: rgba(255, 255, 255, 0.7);
          color: var(--navy);
          font-size: clamp(1.25rem, 2.4vw, 1.75rem);
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 6px 18px rgba(27, 27, 47, 0.18);
          transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
        }
        .tv-browse-nav-btn:hover { background: var(--gold); color: var(--navy); transform: translateY(-50%) scale(1.08); }
        .tv-browse-nav-btn:focus-visible { outline: 3px solid var(--gold); outline-offset: 3px; }
        .tv-browse-nav-prev { left: clamp(8px, 2vw, 20px); }
        .tv-browse-nav-next { right: clamp(8px, 2vw, 20px); }
      `}</style>
      <div id="stage" className="tv-stage" style={stageStyle}>
        {screenState === "not-found" ? (
          <div className="tv-idle">Shop not found</div>
        ) : (
          <div className="tv-shell">
            <nav className="tv-mode-nav">
              <div className="tv-wordmark">
                <span className="tv-wordmark-primary">MyTryon</span>
                <span className="tv-wordmark-accent">Ai</span>
              </div>
              <button
                type="button"
                className="tv-header-refresh-btn"
                tabIndex={0}
                aria-label="Refresh"
                disabled={mode === "browse" && browseRefreshing}
                onClick={handleRefresh}
              >
                <span className={`tv-refresh-icon${mode === "browse" && browseRefreshing ? " tv-refresh-icon-spinning" : ""}`}>
                  ↻
                </span>
              </button>
            </nav>
            <div className="tv-mode-content">
              {screenState === "idle" ? (
                <div className="tv-idle tv-chooser">
                  <div className="tv-chooser-title">
                    <span className="tv-wordmark-primary">MyTryon</span>
                    <span className="tv-wordmark-accent">Ai</span>
                  </div>
                  <div className="tv-chooser-buttons">
                    <button
                      type="button"
                      className="tv-choice-btn"
                      tabIndex={0}
                      onClick={() => void setScreenMode("catalog")}
                    >
                      Catalog
                    </button>
                    <button
                      type="button"
                      className="tv-choice-btn"
                      tabIndex={0}
                      onClick={() => void setScreenMode("live")}
                    >
                      Live TV
                    </button>
                  </div>
                </div>
              ) : screenState === "live" && liveUrl ? (
                <div className="tv-media">
                  <img key={liveUrl} src={liveUrl} alt="Your generated look" />
                  {liveHasBanner ? <div className="tv-banner">Looks good on you! 😍</div> : null}
                </div>
              ) : screenState === "carousel" && currentCarouselImage ? (
                <div className="tv-media">
                  <img key={currentCarouselImage.id} src={currentCarouselImage.url} alt="Approved look" />
                </div>
              ) : screenState === "browse" ? (
                <div className="tv-browse">
                  {browseDetailLook && browseDetailUrl ? (
                    <div className="tv-browse-detail">
                      <div className="tv-browse-detail-header">
                        <button
                          type="button"
                          className="tv-browse-back"
                          tabIndex={0}
                          onClick={() => {
                            setBrowseDetailLook(null);
                            setBrowseDetailUrl(null);
                            setBrowseHeroError(null);
                          }}
                        >
                          ← Back
                        </button>
                        <button
                          type="button"
                          className={`tv-browse-hero-toggle${
                            browseDetailLook.is_hero ? " tv-browse-hero-toggle-active" : ""
                          }`}
                          tabIndex={0}
                          disabled={browseHeroPending}
                          onClick={() => void toggleHero(browseDetailLook)}
                        >
                          {browseDetailLook.is_hero ? "★ Hero — tap to remove" : "★ Mark as Hero"}
                        </button>
                      </div>
                      {browseHeroError ? <div className="tv-browse-hero-error">{browseHeroError}</div> : null}
                      <div className="tv-browse-detail-media">
                        {browseLooks.length > 1 ? (
                          <button
                            type="button"
                            className="tv-browse-nav-btn tv-browse-nav-prev"
                            tabIndex={0}
                            aria-label="Previous look"
                            onClick={() => void navigateBrowseDetail(-1)}
                          >
                            ‹
                          </button>
                        ) : null}
                        <img src={browseDetailUrl} alt="Look detail" />
                        {browseDetailLook.is_hero ? (
                          <span className="tv-browse-hero-badge tv-browse-hero-badge-lg" aria-label="Hero look">
                            ★
                          </span>
                        ) : null}
                        {browseLooks.length > 1 ? (
                          <button
                            type="button"
                            className="tv-browse-nav-btn tv-browse-nav-next"
                            tabIndex={0}
                            aria-label="Next look"
                            onClick={() => void navigateBrowseDetail(1)}
                          >
                            ›
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="tv-browse-body">
                      <div className="tv-browse-rail">
                        <div className="tv-browse-rail-list" role="tablist">
                          {browseGarmentTypes.map((garmentType) => (
                            <button
                              key={garmentType.id}
                              type="button"
                              role="tab"
                              aria-selected={garmentType.id === browseSelectedGarmentTypeId}
                              className={`tv-browse-rail-item${
                                garmentType.id === browseSelectedGarmentTypeId ? " tv-browse-rail-item-active" : ""
                              }`}
                              tabIndex={0}
                              onClick={() => setBrowseSelectedGarmentTypeId(garmentType.id)}
                            >
                              {garmentType.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="tv-browse-grid">
                        {browseLooks.length === 0 ? (
                          <div className="tv-browse-empty">No looks yet</div>
                        ) : (
                          browseLooks.map((look) => (
                            <BrowseTile
                              key={look.id}
                              look={look}
                              urlMapRef={browseUrlMapRef}
                              onOpen={(openedLook, url) => {
                                setBrowseHeroError(null);
                                setBrowseDetailLook(openedLook);
                                setBrowseDetailUrl(url);
                              }}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="tv-idle">MyTryonAi</div>
              )}
            </div>
            <div className="tv-mode-fab-wrap">
              {modeMenuOpen ? (
                <div className="tv-mode-popover" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={navButtonClass("catalog")}
                    tabIndex={0}
                    onClick={() => {
                      void setScreenMode("catalog");
                      setModeMenuOpen(false);
                    }}
                  >
                    Carousel
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={navButtonClass("browse")}
                    tabIndex={0}
                    onClick={() => {
                      void setScreenMode("browse");
                      setModeMenuOpen(false);
                    }}
                  >
                    Browse
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={navButtonClass("live")}
                    tabIndex={0}
                    onClick={() => {
                      void setScreenMode("live");
                      setModeMenuOpen(false);
                    }}
                  >
                    Live
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={navButtonClass("idle")}
                    tabIndex={0}
                    onClick={() => {
                      void setScreenMode("idle");
                      setModeMenuOpen(false);
                    }}
                  >
                    Home
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className="tv-mode-fab"
                tabIndex={0}
                aria-label="Screen mode menu"
                aria-expanded={modeMenuOpen}
                onClick={() => setModeMenuOpen((prev) => !prev)}
              >
                ⚙
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
