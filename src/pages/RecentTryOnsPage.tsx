import { useEffect, useState } from "react";

import { TryOnFlow } from "../components/TryOnFlow";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMe, useRecentTryOns } from "../lib/queries";
import { supabase } from "../lib/supabase";
import type { RecentTryOn } from "../lib/types";

const KEPT_NOTE = "Try-ons are kept here for 24 hours, then deleted automatically.";
const EMPTY_TEXT = "No try-ons in the last 24 hours.";

/** "just now", "5 min ago", "3 h ago". */
function timeAgo(value: string, now: number) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function isExpired(row: RecentTryOn, now: number) {
  if (!row.expires_at) return false;
  const time = new Date(row.expires_at).getTime();
  return !Number.isNaN(time) && time <= now;
}

/** Small picture; falls back to the full picture, then to a plain tile. */
function TryOnThumb({ row }: { row: RecentTryOn }) {
  const sources = [row.thumb_url, row.image_url].filter((url): url is string => !!url);
  const [index, setIndex] = useState(0);
  const src = sources[index];
  if (!src) return <span className="catalog-image" aria-hidden />;
  return <img className="catalog-image" src={src} alt="" loading="lazy" onError={() => setIndex((i) => i + 1)} />;
}

export function RecentTryOnsPage() {
  const { accessToken } = useAuth();
  const { data: me } = useMe();
  const { data, isLoading, isError, refetch } = useRecentTryOns();
  const [openRow, setOpenRow] = useState<RecentTryOn | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Keeps "how long ago" current on a page left open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = (data ?? []).filter((row) => !!row.image_url && !isExpired(row, now));

  /** Same as after a try-on: the picture goes to the TV, linked to that try-on by its request_id. */
  async function pushToScreen(row: RecentTryOn, blob: Blob) {
    if (!accessToken) throw new Error("Not authenticated");
    if (!row.garment_type_id) throw new Error("Select a garment type first.");
    const formData = new FormData();
    formData.set("result_image", blob, "tryon.jpg");
    formData.set("folder_id", row.garment_type_id);
    await apiFetch("/tryon/push-to-screen", accessToken, {
      method: "POST",
      body: formData,
      headers: { "X-Client-Request-Id": row.request_id }
    });
  }

  async function showCarouselOnTv() {
    if (!me?.shop_id) return;
    const { error } = await supabase.rpc("set_screen_mode", { p_shop_id: me.shop_id, p_mode: "catalog" });
    if (error) throw new Error(error.message);
  }

  let body;
  if (isLoading) {
    body = (
      <div className="loading-box">
        <div className="spinner" />
      </div>
    );
  } else if (isError && !rows.length) {
    body = (
      <div className="empty-box stack-sm">
        <span>Couldn't load recent try-ons.</span>
        <button className="btn btn-light" type="button" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  } else if (!rows.length) {
    body = <div className="empty-box">{EMPTY_TEXT}</div>;
  } else {
    body = (
      <section className="catalog-grid">
        {rows.map((row) => {
          const name = row.garment_type_name?.trim() || "Try-on";
          return (
            <button
              key={row.request_id}
              type="button"
              className="catalog-tile fabric-pick-tile"
              onClick={() => setOpenRow(row)}
              aria-label={`Open ${name} try-on`}
            >
              <TryOnThumb row={row} />
              <span className="catalog-meta-row">
                <span className="catalog-garment-label">{name}</span>
                <span className="recent-tryon-time">{timeAgo(row.created_at, now)}</span>
              </span>
            </button>
          );
        })}
      </section>
    );
  }

  return (
    <main className="screen">
      <section className="page-shell">
        <header className="page-header">
          <div>
            <h1>Recent try-ons</h1>
          </div>
        </header>
        <p className="recent-tryon-note">{KEPT_NOTE}</p>
        {body}
      </section>

      {openRow?.image_url ? (
        <TryOnFlow
          key={openRow.request_id}
          initialResultUrl={openRow.image_url}
          onClose={() => setOpenRow(null)}
          onPushToScreen={openRow.garment_type_id ? (blob) => pushToScreen(openRow, blob) : undefined}
          onShowCarousel={showCarouselOnTv}
        />
      ) : null}
    </main>
  );
}
