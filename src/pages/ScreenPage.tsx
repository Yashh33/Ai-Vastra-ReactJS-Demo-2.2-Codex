import { useEffect, useMemo, useState } from "react";
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
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CarouselItem = {
  id: string;
  url: string;
};

type ScreenState = "loading" | "live" | "carousel" | "not-found";

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
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [carousel, setCarousel] = useState<CarouselItem[]>([]);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [resolvedShopId, setResolvedShopId] = useState<string | null>(null);

  useEffect(() => {
    if (!shopId) return;
    const routeParam = shopId;
    let cancelled = false;
    setResolvedShopId(null);
    setScreenState("loading");

    async function resolveShopId() {
      if (UUID_REGEX.test(routeParam)) {
        if (!cancelled) setResolvedShopId(routeParam);
        return;
      }

      const { data, error } = await supabase.from("shops").select("id").eq("screen_slug", routeParam).single();

      if (cancelled) return;

      if (error || !data?.id) {
        setScreenState("not-found");
        return;
      }

      setResolvedShopId(data.id);
    }

    void resolveShopId();

    return () => {
      cancelled = true;
    };
  }, [shopId]);

  useEffect(() => {
    if (!resolvedShopId) return;
    let cancelled = false;

    async function activateLive(generationId: string) {
      const { data: genRow } = await supabase
        .from("generations")
        .select("id,output_path")
        .eq("id", generationId)
        .maybeSingle();

      if (cancelled) return;

      if (!genRow?.output_path) {
        setLiveUrl(null);
        setScreenState("carousel");
        return;
      }

      try {
        const url = await createSignedUrl("generated-outputs", genRow.output_path, SIGNED_URL_TTL_SECONDS);
        if (cancelled) return;
        setLiveUrl(url);
        setScreenState("live");
      } catch (err) {
        console.error("ScreenPage: failed to sign live generation URL", err);
        if (!cancelled) setScreenState("carousel");
      }
    }

    async function loadInitial() {
      const { data: approvedRows } = await supabase
        .from("generations")
        .select("id,output_path,created_at")
        .eq("shop_id", resolvedShopId)
        .eq("show_on_screen", true)
        .eq("generation_type", "look")
        .order("created_at", { ascending: false })
        .limit(CAROUSEL_LIMIT);

      if (cancelled) return;

      const signed = await Promise.all(
        (approvedRows ?? [])
          .filter((row: { output_path: string | null }) => !!row.output_path)
          .map(async (row: { id: string; output_path: string }) => {
            try {
              return { id: row.id, url: await createSignedUrl("generated-outputs", row.output_path, SIGNED_URL_TTL_SECONDS) };
            } catch (err) {
              console.error("ScreenPage: failed to sign carousel item", row.id, err);
              return null;
            }
          })
      );

      if (cancelled) return;
      setCarousel(signed.filter((item): item is CarouselItem => item !== null));

      const { data: stateRow } = await supabase
        .from("shop_screen_state")
        .select("live_generation_id")
        .eq("shop_id", resolvedShopId)
        .maybeSingle();

      if (cancelled) return;

      if (stateRow?.live_generation_id) {
        await activateLive(stateRow.live_generation_id);
      } else {
        setScreenState("carousel");
      }
    }

    void loadInitial();

    const pollTimer = window.setInterval(() => {
      void loadInitial();
    }, 20000);

    const unsubscribeState = subscribeToShopScreenState(resolvedShopId, (row: ShopScreenStateRow) => {
      if (cancelled) return;
      if (row.live_generation_id) {
        void activateLive(row.live_generation_id);
      } else {
        setLiveUrl(null);
        setScreenState("carousel");
      }
    });

    const unsubscribeGenerations = subscribeToShopGenerations(resolvedShopId, (row: ShopScreenGenerationRow) => {
      if (cancelled || !row.show_on_screen || !row.output_path || row.generation_type !== "look") return;
      const outputPath = row.output_path;
      void (async () => {
        try {
          const url = await createSignedUrl("generated-outputs", outputPath, SIGNED_URL_TTL_SECONDS);
          if (cancelled) return;
          setCarousel((prev) => (prev.some((item) => item.id === row.id) ? prev : [{ id: row.id, url }, ...prev]));
        } catch (err) {
          console.error("ScreenPage: failed to sign realtime generation", row.id, err);
        }
      })();
    });

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      unsubscribeState();
      unsubscribeGenerations();
    };
  }, [resolvedShopId]);

  useEffect(() => {
    if (screenState !== "carousel" || carousel.length <= 1) return;
    const timer = window.setInterval(() => {
      setCarouselIndex((prev) => (prev + 1) % carousel.length);
    }, CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [screenState, carousel.length]);

  const currentCarouselItem = useMemo(() => {
    if (!carousel.length) return null;
    return carousel[carouselIndex % carousel.length] ?? null;
  }, [carousel, carouselIndex]);

  const stageStyle = {
    width: `${stageSize.width}px`,
    height: `${stageSize.height}px`
  };

  return (
    <main className="tv-screen">
      <div id="stage" className="tv-stage" style={stageStyle}>
        {screenState === "not-found" ? (
          <div className="tv-idle">Shop not found</div>
        ) : screenState === "live" && liveUrl ? (
          <div className="tv-media">
            <img key={liveUrl} src={liveUrl} alt="Your generated look" />
            <div className="tv-banner">Looks good on you! 😍</div>
          </div>
        ) : currentCarouselItem ? (
          <div className="tv-media">
            <img key={currentCarouselItem.id} src={currentCarouselItem.url} alt="Approved look" />
          </div>
        ) : (
          <div className="tv-idle">AI Vastra</div>
        )}
      </div>
    </main>
  );
}
