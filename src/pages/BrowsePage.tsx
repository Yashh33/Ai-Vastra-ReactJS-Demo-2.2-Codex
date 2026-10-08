import { useEffect, useRef, useState } from "react";

import { ColorStudio } from "../components/ColorStudio";
import { LookDetails } from "../components/LookDetails";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { restoreOriginalColor, saveColorCorrected } from "../lib/colorStudio/saveCorrected";
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
const DESCRIPTION_MAX_LENGTH = 300;

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
  const { accessToken } = useAuth();
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
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [editBarcode, setEditBarcode] = useState("");
  const [editMrp, setEditMrp] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [colourStudioOpen, setColourStudioOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [colourNote, setColourNote] = useState<string | null>(null);
  const [colourError, setColourError] = useState<string | null>(null);

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
      // The Match colour modal sits on top and owns the keyboard (its sliders use the arrows).
      if (colourStudioOpen) return;
      // While the details form is open the arrow keys belong to its inputs.
      if (editingDetails) {
        if (event.key === "Escape" && !detailsSaving) cancelEditDetails();
        return;
      }
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
  }, [detailLook, looks, editingDetails, detailsSaving, colourStudioOpen]);

  function cancelEditDetails() {
    setEditingDetails(false);
    setDetailsError(null);
  }

  function startEditDetails(look: BrowseLookRow) {
    setEditBarcode(look.barcode ?? "");
    setEditMrp(look.mrp !== null ? String(look.mrp) : "");
    setEditDescription(look.description ?? "");
    setDetailsError(null);
    setEditingDetails(true);
  }

  async function saveDetails(look: BrowseLookRow) {
    if (detailsSaving) return;

    const barcode = editBarcode.trim();
    const description = editDescription.trim();
    const mrpRaw = editMrp.trim();
    const mrp = mrpRaw === "" ? null : Number(mrpRaw);
    if (mrp !== null && (!Number.isFinite(mrp) || mrp < 0)) {
      setDetailsError("Enter a valid MRP.");
      return;
    }

    setDetailsError(null);
    setDetailsSaving(true);
    try {
      if (!accessToken) throw new Error("Not authenticated");
      // The backend turns empty strings into null, which is how a field gets cleared.
      await apiFetch(`/generations/${look.id}/details`, accessToken, {
        method: "PATCH",
        body: JSON.stringify({ barcode, mrp: mrp ?? "", description })
      });
      const patch = { barcode: barcode || null, mrp, description: description || null };
      setDetailLook((prev) => (prev && prev.id === look.id ? { ...prev, ...patch } : prev));
      setLooks((prev) => prev.map((row) => (row.id === look.id ? { ...row, ...patch } : row)));
      setEditingDetails(false);
    } catch (err) {
      console.error("BrowsePage: failed to save look details", look.id, err);
      setDetailsError(err instanceof Error ? err.message : "Couldn't save details. Try again.");
    } finally {
      setDetailsSaving(false);
    }
  }

  function clearColourMessages() {
    setColourNote(null);
    setColourError(null);
  }

  function closeDetail() {
    setDetailLook(null);
    setDetailUrl(null);
    setHeroError(null);
    setDeleteError(null);
    clearColourMessages();
    cancelEditDetails();
  }

  // Points the detail view and the grid tile at a look's new image.
  async function applyNewOutputPath(lookId: string, outputPath: string) {
    const url = await createSignedUrl("generated-outputs", outputPath, SIGNED_URL_TTL_SECONDS);
    urlMapRef.current.set(lookId, url);
    setLooks((prev) => prev.map((row) => (row.id === lookId ? { ...row, output_path: outputPath } : row)));
    setDetailLook((prev) => (prev && prev.id === lookId ? { ...prev, output_path: outputPath } : prev));
    if (detailLook?.id === lookId) setDetailUrl(url);
  }

  async function handleColourSaved(look: BrowseLookRow, blob: Blob) {
    if (!accessToken) throw new Error("Not authenticated");
    const saved = await saveColorCorrected(accessToken, look.id, blob);
    await applyNewOutputPath(look.id, saved.output_path);
    setColourError(null);
    setColourNote("Colour updated");
    setColourStudioOpen(false);
  }

  async function restoreOriginal(look: BrowseLookRow) {
    if (restoring) return;
    clearColourMessages();
    setRestoring(true);
    try {
      if (!accessToken) throw new Error("Not authenticated");
      const restored = await restoreOriginalColor(accessToken, look.id);
      await applyNewOutputPath(look.id, restored.output_path);
      setColourNote("Original restored");
    } catch (err) {
      console.error("BrowsePage: failed to restore original", look.id, err);
      setColourError(err instanceof Error ? err.message : "Couldn't restore the original. Try again.");
    } finally {
      setRestoring(false);
    }
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
    setDeleteError(null);
    clearColourMessages();
    cancelEditDetails();
    setDetailLook(nextLook);
    setDetailUrl(url);
  }

  async function deleteLook(look: BrowseLookRow) {
    if (deleting) return;
    const confirmed = window.confirm(
      "Delete this look permanently? This removes it from Browse, the Carousel, and the TV."
    );
    if (!confirmed) return;

    setDeleteError(null);
    setDeleting(true);
    try {
      if (!accessToken) throw new Error("Not authenticated");
      await apiFetch(`/generations/${look.id}`, accessToken, { method: "DELETE" });
      urlMapRef.current.delete(look.id);
      const remaining = looks.filter((row) => row.id !== look.id);
      setLooks(remaining);
      closeDetail();
      // An emptied category should drop out of the rail, so re-run the tab query.
      if (remaining.length === 0) setRefreshKey((prev) => prev + 1);
    } catch (err) {
      console.error("BrowsePage: failed to delete look", look.id, err);
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete this look. Try again.");
    } finally {
      setDeleting(false);
    }
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
        <div className="mt-browse-detail-info">
          {editingDetails ? (
            <form
              className="mt-browse-edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveDetails(detailLook);
              }}
            >
              <label className="mt-browse-edit-field">
                <span>Barcode</span>
                <input
                  type="text"
                  value={editBarcode}
                  onChange={(event) => setEditBarcode(event.target.value)}
                  disabled={detailsSaving}
                />
              </label>
              <label className="mt-browse-edit-field">
                <span>MRP (₹)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={editMrp}
                  onChange={(event) => setEditMrp(event.target.value)}
                  disabled={detailsSaving}
                />
              </label>
              <label className="mt-browse-edit-field">
                <span>
                  Description ({editDescription.length}/{DESCRIPTION_MAX_LENGTH})
                </span>
                <textarea
                  rows={3}
                  maxLength={DESCRIPTION_MAX_LENGTH}
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  disabled={detailsSaving}
                />
              </label>
              {detailsError ? <div className="mt-browse-edit-error">{detailsError}</div> : null}
              <div className="mt-browse-edit-actions">
                <button type="submit" className="mt-browse-edit-save" disabled={detailsSaving}>
                  {detailsSaving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="mt-browse-edit-cancel"
                  disabled={detailsSaving}
                  onClick={cancelEditDetails}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <LookDetails barcode={detailLook.barcode} mrp={detailLook.mrp} description={detailLook.description} />
              <div className="mt-browse-detail-actions">
                <button type="button" className="mt-browse-edit-btn" onClick={() => startEditDetails(detailLook)}>
                  Edit details
                </button>
                <button
                  type="button"
                  className="mt-browse-edit-btn"
                  onClick={() => {
                    clearColourMessages();
                    setColourStudioOpen(true);
                  }}
                >
                  🎨 Match colour
                </button>
              </div>
              <button
                type="button"
                className="mt-browse-restore"
                disabled={restoring}
                onClick={() => void restoreOriginal(detailLook)}
              >
                {restoring ? "Restoring…" : "Restore original"}
              </button>
              {colourNote ? <div className="mt-browse-colour-note">{colourNote}</div> : null}
              {colourError ? <div className="mt-browse-edit-error">{colourError}</div> : null}
            </>
          )}
        </div>
        <div className="mt-browse-detail-footer">
          {deleteError ? <div className="mt-browse-hero-error">{deleteError}</div> : null}
          <button
            type="button"
            className="mt-browse-delete"
            disabled={deleting}
            onClick={() => void deleteLook(detailLook)}
          >
            {deleting ? "Deleting…" : "Delete look"}
          </button>
        </div>
        {colourStudioOpen ? (
          <ColorStudio
            source={detailUrl}
            generationId={detailLook.id}
            garmentTypeName={garmentTypes.find((garmentType) => garmentType.id === selectedGarmentTypeId)?.name}
            allowSegment
            defaultSegment
            onSave={(blob) => handleColourSaved(detailLook, blob)}
            onClose={() => setColourStudioOpen(false)}
          />
        ) : null}
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
                // A corrected / restored look gets a new output_path; remount to pick up its new URL.
                key={`${look.id}:${look.output_path}`}
                look={look}
                urlMapRef={urlMapRef}
                onOpen={(openedLook, url) => {
                  setHeroError(null);
                  clearColourMessages();
                  cancelEditDetails();
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
          max-height: calc(100svh - 310px);
          object-fit: contain;
          animation: mt-browse-fade-in 0.4s ease;
          border-radius: 8px;
        }
        .mt-browse-detail-info {
          width: 100%;
          max-width: 560px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
          padding: 0 clamp(16px, 2.5vw, 32px) 16px;
        }
        .mt-browse-edit-btn,
        .mt-browse-edit-save,
        .mt-browse-edit-cancel {
          font: inherit;
          font-size: clamp(0.9rem, 1.4vw, 1.1rem);
          font-weight: 700;
          color: var(--navy);
          background: var(--card);
          border: 1.5px solid var(--navy);
          border-radius: 12px;
          padding: 8px 22px;
          cursor: pointer;
          transition: background 0.15s ease;
        }
        .mt-browse-edit-btn:hover,
        .mt-browse-edit-cancel:hover { background: #EFEDE8; }
        .mt-browse-edit-save { background: var(--gold); border-color: var(--gold); }
        .mt-browse-edit-btn:focus-visible,
        .mt-browse-edit-save:focus-visible,
        .mt-browse-edit-cancel:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
        .mt-browse-edit-save:disabled,
        .mt-browse-edit-cancel:disabled { opacity: 0.6; cursor: default; }
        .mt-browse-edit-form {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 14px 16px;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 14px;
        }
        .mt-browse-edit-field { display: flex; flex-direction: column; gap: 4px; }
        .mt-browse-edit-field span {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .mt-browse-edit-field input,
        .mt-browse-edit-field textarea {
          font: inherit;
          font-size: 1rem;
          color: var(--navy);
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 12px;
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
        }
        .mt-browse-edit-field input:focus-visible,
        .mt-browse-edit-field textarea:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
        .mt-browse-edit-error { color: #B3261E; font-size: 0.9rem; }
        .mt-browse-detail-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
        .mt-browse-restore {
          font: inherit;
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--muted);
          background: transparent;
          border: none;
          padding: 4px 8px;
          text-decoration: underline;
          cursor: pointer;
        }
        .mt-browse-restore:disabled { opacity: 0.6; cursor: default; }
        .mt-browse-colour-note { color: var(--navy); font-size: 0.9rem; font-weight: 600; }
        .mt-browse-edit-actions { display: flex; gap: 10px; }
        .mt-browse-detail-footer {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 0 clamp(16px, 2.5vw, 32px) clamp(16px, 2.5vw, 32px);
        }
        .mt-browse-delete {
          font: inherit;
          font-size: clamp(0.9rem, 1.4vw, 1.1rem);
          font-weight: 700;
          color: #B3261E;
          background: var(--card);
          border: 1.5px solid #B3261E;
          border-radius: 12px;
          padding: 8px 22px;
          cursor: pointer;
          transition: background 0.15s ease;
        }
        .mt-browse-delete:hover { background: #FEF2F2; }
        .mt-browse-delete:focus-visible { outline: 3px solid #B3261E; outline-offset: 2px; }
        .mt-browse-delete:disabled { opacity: 0.6; cursor: default; }

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
