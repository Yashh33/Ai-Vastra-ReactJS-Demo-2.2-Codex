import { useEffect, useRef, useState } from "react";

import { useMe } from "../lib/queries";
import {
  fetchBrowseGarmentTypes,
  fetchBrowseLooks,
  type BrowseGarmentType,
  type BrowseLookRow
} from "../lib/screenData";
import { createSignedUrl } from "../lib/storage";
import { supabase } from "../lib/supabase";

// Mirrors the TV's browse mode (ScreenPage) using the same shared queries, but is driven by
// local state only: it never reads or writes shop_screen_state, so it can't change the TV.

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

function sortBrowseLooks(rows: BrowseLookRow[]): BrowseLookRow[] {
  return [...rows].sort((a, b) => {
    if (a.is_hero !== b.is_hero) return a.is_hero ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
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
        console.error("BrowsePage: failed to sign browse tile", look.id, err);
      }
    }

    void sign();

    return () => {
      cancelled = true;
    };
  }, [look.id, look.output_path, url, urlMapRef]);

  return (
    <button type="button" className="mt-browse-tile" onClick={() => url && onOpen(look, url)}>
      {url ? <img src={url} alt="Look" /> : <div className="mt-browse-tile-placeholder" />}
      {look.is_hero ? (
        <span className="mt-browse-hero-badge" aria-label="Hero look">
          ★
        </span>
      ) : null}
    </button>
  );
}

export function BrowsePage() {
  const { data: me, isLoading: meLoading, isError: meError } = useMe();
  const shopId = me?.shop_id ?? null;

  const [garmentTypes, setGarmentTypes] = useState<BrowseGarmentType[]>([]);
  const [selectedGarmentTypeId, setSelectedGarmentTypeId] = useState<string | null>(null);
  const [looks, setLooks] = useState<BrowseLookRow[]>([]);
  const [tabsLoading, setTabsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [detailLook, setDetailLook] = useState<BrowseLookRow | null>(null);
  const [detailUrl, setDetailUrl] = useState<string | null>(null);
  const [heroPending, setHeroPending] = useState(false);
  const [heroError, setHeroError] = useState<string | null>(null);

  const urlMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!shopId) return;
    const currentShopId = shopId;
    let cancelled = false;
    setRefreshing(true);

    async function loadTabs() {
      try {
        const tabs = await fetchBrowseGarmentTypes(supabase, currentShopId);
        if (cancelled) return;
        setGarmentTypes(tabs);
        setSelectedGarmentTypeId((prev) => (prev && tabs.some((tab) => tab.id === prev) ? prev : tabs[0]?.id ?? null));
      } catch (err) {
        console.error("BrowsePage: failed to load garment types", err);
      } finally {
        if (!cancelled) {
          setRefreshing(false);
          setTabsLoading(false);
        }
      }
    }

    void loadTabs();

    return () => {
      cancelled = true;
    };
  }, [shopId, refreshKey]);

  useEffect(() => {
    if (!shopId || !selectedGarmentTypeId) {
      setLooks([]);
      return;
    }

    const currentShopId = shopId;
    const folderId = selectedGarmentTypeId;
    let cancelled = false;

    async function loadLooks() {
      try {
        const rows = await fetchBrowseLooks(supabase, currentShopId, folderId);
        if (!cancelled) setLooks(rows);
      } catch (err) {
        console.error("BrowsePage: failed to load looks", err);
      }
    }

    void loadLooks();

    return () => {
      cancelled = true;
    };
  }, [shopId, selectedGarmentTypeId, refreshKey]);

  useEffect(() => {
    if (!detailLook) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        void navigateDetail(1);
      } else if (event.key === "ArrowLeft") {
        void navigateDetail(-1);
      } else if (event.key === "Escape") {
        closeDetail();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailLook, looks]);

  function closeDetail() {
    setDetailLook(null);
    setDetailUrl(null);
    setHeroError(null);
  }

  async function navigateDetail(direction: 1 | -1) {
    if (!detailLook || looks.length <= 1) return;

    const currentIndex = looks.findIndex((look) => look.id === detailLook.id);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + direction + looks.length) % looks.length;
    const nextLook = looks[nextIndex];
    if (!nextLook) return;

    let url = urlMapRef.current.get(nextLook.id);
    if (!url) {
      try {
        url = await createSignedUrl("generated-outputs", nextLook.output_path, SIGNED_URL_TTL_SECONDS);
        urlMapRef.current.set(nextLook.id, url);
      } catch (err) {
        console.error("BrowsePage: failed to sign detail navigation image", nextLook.id, err);
        return;
      }
    }

    setHeroError(null);
    setDetailLook(nextLook);
    setDetailUrl(url);
  }

  async function toggleHero(look: BrowseLookRow) {
    if (heroPending) return;

    const previousIsHero = look.is_hero;
    const nextIsHero = !previousIsHero;

    setHeroError(null);
    setHeroPending(true);
    setDetailLook((prev) => (prev && prev.id === look.id ? { ...prev, is_hero: nextIsHero } : prev));
    setLooks((prev) => sortBrowseLooks(prev.map((row) => (row.id === look.id ? { ...row, is_hero: nextIsHero } : row))));

    try {
      const { error } = await supabase.rpc("set_generation_hero", {
        p_generation_id: look.id,
        p_is_hero: nextIsHero
      });
      if (error) throw error;
    } catch (err) {
      console.error("BrowsePage: failed to update hero flag", look.id, err);
      setDetailLook((prev) => (prev && prev.id === look.id ? { ...prev, is_hero: previousIsHero } : prev));
      setLooks((prev) =>
        sortBrowseLooks(prev.map((row) => (row.id === look.id ? { ...row, is_hero: previousIsHero } : row)))
      );
      setHeroError("Couldn't update hero. Try again.");
    } finally {
      setHeroPending(false);
    }
  }

  let body: JSX.Element;

  if (meLoading || (shopId && tabsLoading)) {
    body = (
      <div className="mt-browse-center">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  } else if (meError || !shopId) {
    body = <div className="mt-browse-center mt-browse-empty">Couldn't load your shop. Please try again.</div>;
  } else if (detailLook && detailUrl) {
    body = (
      <div className="mt-browse-detail">
        <div className="mt-browse-detail-header">
          <button type="button" className="mt-browse-back" onClick={closeDetail}>
            ← Back
          </button>
          <button
            type="button"
            className={`mt-browse-hero-toggle${detailLook.is_hero ? " mt-browse-hero-toggle-active" : ""}`}
            disabled={heroPending}
            onClick={() => void toggleHero(detailLook)}
          >
            {detailLook.is_hero ? "★ Hero — tap to remove" : "★ Mark as Hero"}
          </button>
        </div>
        {heroError ? <div className="mt-browse-hero-error">{heroError}</div> : null}
        <div className="mt-browse-detail-media">
          {looks.length > 1 ? (
            <button
              type="button"
              className="mt-browse-nav-btn mt-browse-nav-prev"
              aria-label="Previous look"
              onClick={() => void navigateDetail(-1)}
            >
              ‹
            </button>
          ) : null}
          <div className="mt-browse-detail-frame">
            <img src={detailUrl} alt="Look detail" />
            {detailLook.is_hero ? (
              <span className="mt-browse-hero-badge mt-browse-hero-badge-lg" aria-label="Hero look">
                ★
              </span>
            ) : null}
          </div>
          {looks.length > 1 ? (
            <button
              type="button"
              className="mt-browse-nav-btn mt-browse-nav-next"
              aria-label="Next look"
              onClick={() => void navigateDetail(1)}
            >
              ›
            </button>
          ) : null}
        </div>
      </div>
    );
  } else if (garmentTypes.length === 0) {
    body = <div className="mt-browse-center mt-browse-empty">No looks yet</div>;
  } else {
    body = (
      <div className="mt-browse-body">
        <div className="mt-browse-rail">
          <div className="mt-browse-rail-list" role="tablist">
            {garmentTypes.map((garmentType) => (
              <button
                key={garmentType.id}
                type="button"
                role="tab"
                aria-selected={garmentType.id === selectedGarmentTypeId}
                className={`mt-browse-rail-item${
                  garmentType.id === selectedGarmentTypeId ? " mt-browse-rail-item-active" : ""
                }`}
                onClick={() => setSelectedGarmentTypeId(garmentType.id)}
              >
                {garmentType.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mt-browse-refresh"
            onClick={() => setRefreshKey((prev) => prev + 1)}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>
        <div className="mt-browse-grid">
          {looks.length === 0 ? (
            <div className="mt-browse-empty mt-browse-grid-empty">No looks yet</div>
          ) : (
            looks.map((look) => (
              <BrowseTile
                key={look.id}
                look={look}
                urlMapRef={urlMapRef}
                onOpen={(openedLook, url) => {
                  setHeroError(null);
                  setDetailLook(openedLook);
                  setDetailUrl(url);
                }}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-browse">
      <style>{`
        .mt-browse {
          --navy: var(--mt-navy);
          --gold: var(--mt-gold);
          --page: var(--mt-page);
          --card: var(--mt-card);
          --border: var(--mt-border);
          --muted: var(--mt-muted);
          height: 100%;
          min-height: calc(100svh - 130px);
          display: flex;
          flex-direction: column;
          background: var(--page);
          color: var(--navy);
        }

        .mt-browse-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }

        .mt-browse-body { flex: 1; display: flex; min-height: 0; }
        .mt-browse-rail {
          width: clamp(120px, 16vw, 200px);
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 8px;
          padding: clamp(14px, 1.8vw, 22px) 10px;
          background: var(--card);
          border-right: 1px solid var(--border);
        }
        .mt-browse-rail-list { display: flex; flex-direction: column; gap: 8px; position: sticky; top: 72px; }
        .mt-browse-rail-item {
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
        .mt-browse-rail-item:hover { background: #EFEDE8; }
        .mt-browse-rail-item:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
        .mt-browse-rail-item-active,
        .mt-browse-rail-item-active:hover { background: var(--navy); color: var(--gold); border-color: var(--navy); }

        .mt-browse-refresh {
          font: inherit;
          font-size: 0.8rem;
          font-weight: 700;
          color: var(--navy);
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 12px;
          cursor: pointer;
          position: sticky;
          bottom: 84px;
        }
        .mt-browse-refresh:hover { background: #EFEDE8; }
        .mt-browse-refresh:disabled { opacity: 0.6; cursor: default; }

        .mt-browse-grid {
          flex: 1;
          min-width: 0;
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: clamp(12px, 2vw, 28px);
          padding: clamp(12px, 2.5vw, 32px);
          align-content: start;
        }
        .mt-browse-tile {
          position: relative;
          aspect-ratio: 3 / 4;
          border: 1px solid var(--border);
          border-radius: 14px;
          overflow: hidden;
          padding: 0;
          cursor: pointer;
          background: var(--card);
        }
        .mt-browse-tile img { width: 100%; height: 100%; object-fit: cover; display: block; animation: mt-browse-fade-in 0.4s ease; }
        .mt-browse-tile-placeholder { width: 100%; height: 100%; background: linear-gradient(135deg, var(--page), #EFEDE8); }
        .mt-browse-tile:hover { outline: 3px solid var(--gold); outline-offset: -3px; }
        .mt-browse-tile:focus-visible { outline: 4px solid var(--gold); outline-offset: -4px; }

        .mt-browse-hero-badge {
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
        .mt-browse-hero-badge-lg { top: 12px; right: 12px; width: clamp(36px, 4vw, 56px); height: clamp(36px, 4vw, 56px); font-size: clamp(1.1rem, 2vw, 1.6rem); }

        .mt-browse-empty { font-size: clamp(1.1rem, 2.5vw, 2rem); color: var(--muted); }
        .mt-browse-grid-empty { grid-column: 1 / -1; text-align: center; padding: 48px 0; }

        .mt-browse-detail { flex: 1; display: flex; flex-direction: column; background: var(--page); }
        .mt-browse-detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: clamp(12px, 2vw, 24px);
          padding: clamp(16px, 2.5vw, 32px) clamp(16px, 2.5vw, 32px) 0;
        }
        .mt-browse-back {
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
        .mt-browse-back:hover { transform: translateY(-2px); }
        .mt-browse-back:focus-visible { outline: 4px solid var(--navy); outline-offset: 2px; }
        .mt-browse-hero-toggle {
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
        .mt-browse-hero-toggle:hover { background: #EFEDE8; transform: translateY(-2px); }
        .mt-browse-hero-toggle:focus-visible { outline: 4px solid var(--gold); outline-offset: 2px; }
        .mt-browse-hero-toggle:disabled { opacity: 0.6; cursor: default; transform: none; }
        .mt-browse-hero-toggle-active,
        .mt-browse-hero-toggle-active:hover { background: var(--gold); color: var(--navy); border-color: var(--gold); }
        .mt-browse-hero-error {
          text-align: center;
          color: #B3261E;
          font-size: clamp(0.9rem, 1.4vw, 1.1rem);
          padding: 8px clamp(16px, 2.5vw, 32px) 0;
        }
        .mt-browse-detail-media {
          position: relative;
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .mt-browse-detail-frame { position: relative; display: flex; max-width: 92%; }
        .mt-browse-detail-frame img {
          max-width: 100%;
          max-height: calc(100svh - 240px);
          object-fit: contain;
          animation: mt-browse-fade-in 0.4s ease;
          border-radius: 8px;
        }
        .mt-browse-nav-btn {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          z-index: 1;
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
        .mt-browse-nav-btn:hover { background: var(--gold); color: var(--navy); transform: translateY(-50%) scale(1.08); }
        .mt-browse-nav-btn:focus-visible { outline: 3px solid var(--gold); outline-offset: 3px; }
        .mt-browse-nav-prev { left: clamp(8px, 2vw, 20px); }
        .mt-browse-nav-next { right: clamp(8px, 2vw, 20px); }

        @keyframes mt-browse-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
      {body}
    </div>
  );
}
