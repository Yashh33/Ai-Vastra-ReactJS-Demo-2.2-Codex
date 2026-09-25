import { useEffect, useRef, useState } from "react";

import { useMe } from "../lib/queries";
import { fetchCarouselLooks, type CarouselRow } from "../lib/screenData";
import { createSignedUrl } from "../lib/storage";
import { supabase } from "../lib/supabase";

// Mirrors the TV's catalog carousel (ScreenPage) using the same shared query, limit and
// interval, but with local state only: it never reads or writes shop_screen_state.

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;
const CAROUSEL_LIMIT = 30;
const CAROUSEL_INTERVAL_MS = 6000;
const POLL_INTERVAL_MS = 5000;

type CarouselItem = {
  id: string;
  url: string;
};

function carouselRowsEqual(a: CarouselRow[], b: CarouselRow[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.id === b[i]?.id && row.output_path === b[i]?.output_path);
}

export function CarouselPage() {
  const { data: me, isLoading: meLoading, isError: meError } = useMe();
  const shopId = me?.shop_id ?? null;

  const [rows, setRows] = useState<CarouselRow[]>([]);
  const [rowsLoaded, setRowsLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [currentImage, setCurrentImage] = useState<CarouselItem | null>(null);

  const urlMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!shopId) return;
    const currentShopId = shopId;
    let cancelled = false;

    async function loadLooks() {
      try {
        const nextRows = await fetchCarouselLooks(supabase, currentShopId, CAROUSEL_LIMIT);
        if (cancelled) return;

        const currentIds = new Set(nextRows.map((row) => row.id));
        for (const id of Array.from(urlMapRef.current.keys())) {
          if (!currentIds.has(id)) urlMapRef.current.delete(id);
        }

        setRows((prev) => (carouselRowsEqual(prev, nextRows) ? prev : nextRows));
      } catch (err) {
        console.error("CarouselPage: failed to load carousel looks", err);
      } finally {
        if (!cancelled) setRowsLoaded(true);
      }
    }

    void loadLooks();
    const pollTimer = window.setInterval(() => {
      void loadLooks();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [shopId]);

  useEffect(() => {
    if (!rows.length) {
      setCurrentImage(null);
      return;
    }

    let cancelled = false;
    let skipTimer: number | undefined;
    const length = rows.length;
    const idx = ((index % length) + length) % length;
    const row = rows[idx];
    if (!row) return;

    async function showFrame() {
      if (!row) return;
      let resolvedUrl = urlMapRef.current.get(row.id);

      if (!resolvedUrl) {
        try {
          resolvedUrl = await createSignedUrl("generated-outputs", row.output_path, SIGNED_URL_TTL_SECONDS);
          urlMapRef.current.set(row.id, resolvedUrl);
        } catch (err) {
          console.error("CarouselPage: failed to sign carousel item", row.id, err);
          if (!cancelled) {
            // Don't let one bad frame hold the screen for a full interval — hop past it quickly.
            skipTimer = window.setTimeout(() => {
              setIndex((prev) => (prev + 1) % length);
            }, 1500);
          }
          return;
        }
      }

      if (cancelled) return;

      const url = resolvedUrl;
      const rowId = row.id;
      setCurrentImage((prev) => (prev && prev.id === rowId && prev.url === url ? prev : { id: rowId, url }));

      const nextRow = rows[(idx + 1) % length];
      if (nextRow && nextRow.id !== row.id && !urlMapRef.current.has(nextRow.id)) {
        try {
          const nextUrl = await createSignedUrl("generated-outputs", nextRow.output_path, SIGNED_URL_TTL_SECONDS);
          if (!cancelled) urlMapRef.current.set(nextRow.id, nextUrl);
        } catch (err) {
          console.error("CarouselPage: failed to prefetch carousel item", nextRow.id, err);
        }
      }
    }

    void showFrame();

    return () => {
      cancelled = true;
      if (skipTimer !== undefined) window.clearTimeout(skipTimer);
    };
  }, [rows, index]);

  useEffect(() => {
    if (rows.length <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % rows.length);
    }, CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [rows.length]);

  const position = rows.length ? (((index % rows.length) + rows.length) % rows.length) + 1 : 0;

  let body: JSX.Element;
  if (meLoading || (shopId && !rowsLoaded)) {
    body = <div className="spinner" aria-label="Loading" />;
  } else if (meError || !shopId) {
    body = <div className="mt-carousel-empty">Couldn't load your shop. Please try again.</div>;
  } else if (!rows.length) {
    body = (
      <div className="mt-carousel-empty">
        <span className="mt-carousel-wordmark">
          <span className="mt-carousel-wordmark-primary">MyTryon</span>
          <span className="mt-carousel-wordmark-accent">Ai</span>
        </span>
        <span>No looks yet</span>
      </div>
    );
  } else if (currentImage) {
    body = (
      <>
        <img key={currentImage.id} className="mt-carousel-image" src={currentImage.url} alt="Approved look" />
        {rows.length > 1 ? (
          <span className="mt-carousel-counter">
            {position} / {rows.length}
          </span>
        ) : null}
      </>
    );
  } else {
    body = <div className="spinner" aria-label="Loading" />;
  }

  return (
    <div className="mt-carousel">
      <style>{`
        .mt-carousel {
          position: relative;
          height: 100%;
          min-height: calc(100svh - 130px);
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--mt-page);
          color: var(--mt-navy);
          overflow: hidden;
        }
        .mt-carousel-image {
          width: 100%;
          height: calc(100svh - 130px);
          object-fit: contain;
          display: block;
          animation: mt-carousel-fade-in 0.6s ease;
        }
        .mt-carousel-counter {
          position: absolute;
          bottom: 16px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 12px;
          font-weight: 700;
          color: var(--mt-navy);
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid var(--mt-border);
          border-radius: 999px;
          padding: 6px 14px;
          box-shadow: 0 6px 18px rgba(27, 27, 47, 0.12);
        }
        .mt-carousel-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          padding: 24px;
          text-align: center;
          font-size: 1.1rem;
          font-weight: 600;
          color: var(--mt-muted);
        }
        .mt-carousel-wordmark { font-size: 1.75rem; font-weight: 800; letter-spacing: 0.02em; }
        .mt-carousel-wordmark-primary { color: var(--mt-navy); }
        .mt-carousel-wordmark-accent { color: var(--mt-gold); }

        @keyframes mt-carousel-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
      {body}
    </div>
  );
}
