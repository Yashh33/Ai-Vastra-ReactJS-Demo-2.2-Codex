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

type ScreenMode = "idle" | "catalog" | "live";

type ScreenState = "loading" | "live" | "carousel" | "idle" | "not-found";

function normalizeMode(rawMode: string | null | undefined): ScreenMode {
  return rawMode === "idle" || rawMode === "live" ? rawMode : "catalog";
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

  const liveGenerationIdRef = useRef<string | null>(null);
  const liveIsRealRef = useRef(false);
  const carouselUrlMapRef = useRef<Map<string, string>>(new Map());
  const carouselRowsRef = useRef<CarouselRow[]>([]);
  const appliedModeRef = useRef<ScreenMode | null>(null);

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
    };
  }, [mode, carouselRows, carouselIndex]);

  useEffect(() => {
    if (mode !== "catalog" || carouselRows.length <= 1) return;
    const timer = window.setInterval(() => {
      setCarouselIndex((prev) => (prev + 1) % carouselRows.length);
    }, CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [mode, carouselRows.length]);

  async function setScreenMode(nextMode: "catalog" | "live") {
    if (!resolvedShopId) return;
    try {
      const { error } = await supabase.rpc("set_screen_mode", { p_shop_id: resolvedShopId, p_mode: nextMode });
      if (error) console.error("ScreenPage: failed to set screen mode", error);
    } catch (err) {
      console.error("ScreenPage: failed to set screen mode", err);
    }
  }

  const stageStyle = {
    width: `${stageSize.width}px`,
    height: `${stageSize.height}px`
  };

  return (
    <main className="tv-screen">
      <style>{`
        .tv-chooser { flex-direction: column; gap: clamp(24px, 4vw, 48px); }
        .tv-chooser-title { font-size: clamp(1.75rem, 4vw, 3rem); font-weight: 700; letter-spacing: 0.04em; color: #f8fafc; }
        .tv-chooser-buttons { display: flex; gap: clamp(16px, 3vw, 32px); }
        .tv-choice-btn {
          font: inherit;
          font-size: clamp(1.25rem, 2.4vw, 2rem);
          font-weight: 700;
          letter-spacing: 0.02em;
          color: #1B1B2F;
          background: #C9A84C;
          border: none;
          border-radius: 18px;
          padding: clamp(20px, 3vw, 36px) clamp(36px, 5vw, 64px);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .tv-choice-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(201, 168, 76, 0.35); }
        .tv-choice-btn:focus-visible { outline: 4px solid #f8fafc; outline-offset: 4px; }
      `}</style>
      <div id="stage" className="tv-stage" style={stageStyle}>
        {screenState === "not-found" ? (
          <div className="tv-idle">Shop not found</div>
        ) : screenState === "idle" ? (
          <div className="tv-idle tv-chooser">
            <div className="tv-chooser-title">AI Vastra</div>
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
        ) : (
          <div className="tv-idle">AI Vastra</div>
        )}
      </div>
    </main>
  );
}
