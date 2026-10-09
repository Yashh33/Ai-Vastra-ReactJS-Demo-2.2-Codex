import { useEffect, useState } from "react";

import { useMe } from "../lib/queries";
import { fetchCarouselLooks, type CarouselRow } from "../lib/screenData";
import { supabase } from "../lib/supabase";
import { useCarouselSlides } from "../lib/useCarouselSlides";

// Mirrors the TV's catalog carousel (ScreenPage) using the same shared query, limit and
// interval, but with local state only: it never reads or writes shop_screen_state.

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;
const CAROUSEL_LIMIT = 30;
const CAROUSEL_INTERVAL_MS = 6000;
const POLL_INTERVAL_MS = 5000;

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
  const slide = useCarouselSlides(rows, true, CAROUSEL_INTERVAL_MS, SIGNED_URL_TTL_SECONDS);

  useEffect(() => {
    if (!shopId) return;
    const currentShopId = shopId;
    let cancelled = false;

    async function loadLooks() {
      try {
        const nextRows = await fetchCarouselLooks(supabase, currentShopId, CAROUSEL_LIMIT);
        if (cancelled) return;

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
  } else if (slide) {
    body = (
      <>
        <img key={slide.id} className="mt-carousel-image" src={slide.url} alt="Approved look" />
        {rows.length > 1 ? (
          <span className="mt-carousel-counter">
            {slide.index + 1} / {rows.length}
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
