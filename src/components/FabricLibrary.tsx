import { useMemo, type ReactNode } from "react";

import { useFabricImagePages } from "../lib/queries";
import type { FabricImageRow } from "../lib/types";
import { FabricImage } from "./FabricImage";

// The saved-fabric library, shared by the My Fabrics page (/fabric-silo) and the
// "My Fabrics" picker on the Generate page: same query, same small pictures, same paging.

export function getFabricLabel(row: FabricImageRow) {
  const label = row.original_filename?.trim();
  return label || "Fabric";
}

/** The loaded fabrics (newest first, each listed once) plus paging state. */
export function useFabricLibrary() {
  const query = useFabricImagePages();
  const rows = useMemo(() => {
    // A fabric can show up on two pages when one was added meanwhile; list it once.
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flat().filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  }, [query.data]);
  return { ...query, rows, hasMore: !!query.hasNextPage };
}

// Tiles show the fabric's small copy (the full photo when it has none). Their links are
// signed together: tiles mounting at the same time share one request.
function SiloTile({ row, onSelect }: { row: FabricImageRow; onSelect?: (row: FabricImageRow) => void }) {
  return (
    <article className="catalog-tile">
      <button className="catalog-image-btn" type="button" onClick={onSelect ? () => onSelect(row) : undefined}>
        <FabricImage className="catalog-image" storagePath={row.storage_path} alt="fabric" />
      </button>

      <div className="catalog-meta-row">
        <p className="catalog-garment-label">{getFabricLabel(row)}</p>
        {onSelect ? (
          <button className="catalog-chip-btn catalog-chip-download" type="button" onClick={() => onSelect(row)}>
            Select
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Picker tile: the whole tile is one button. */
function PickTile({ row, onSelect }: { row: FabricImageRow; onSelect: (row: FabricImageRow) => void }) {
  const label = getFabricLabel(row);
  return (
    <button type="button" className="catalog-tile fabric-pick-tile" onClick={() => onSelect(row)} aria-label={`Use ${label}`}>
      <FabricImage className="catalog-image" storagePath={row.storage_path} alt="" />
      <span className="catalog-meta-row">
        <span className="catalog-garment-label">{label}</span>
      </span>
    </button>
  );
}

type GridProps = {
  /** "silo": the My Fabrics page tiles (a Select chip when `onSelect` is given). "picker": whole tile tappable. */
  variant: "silo" | "picker";
  onSelect?: (row: FabricImageRow) => void;
  emptyText: ReactNode;
  /** Shown instead of `emptyText` when the list failed to load (left out: the empty text is shown). */
  errorText?: ReactNode;
};

/** Loading spinner, empty message, or the fabric grid with "Load more". */
export function FabricLibraryGrid({ variant, onSelect, emptyText, errorText }: GridProps) {
  const { rows, isLoading, isError, refetch, hasMore, fetchNextPage, isFetchingNextPage } = useFabricLibrary();

  if (isLoading) {
    return (
      <div className="loading-box">
        <div className="spinner" />
      </div>
    );
  }
  if (rows.length === 0) {
    if (isError && errorText) {
      return (
        <div className="empty-box stack-sm">
          <span>{errorText}</span>
          <button className="btn btn-light" type="button" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      );
    }
    return <div className="empty-box">{emptyText}</div>;
  }

  return (
    <>
      <section className="catalog-grid">
        {rows.map((row) =>
          variant === "picker" && onSelect ? (
            <PickTile key={row.id} row={row} onSelect={onSelect} />
          ) : (
            <SiloTile key={row.id} row={row} onSelect={onSelect} />
          )
        )}
      </section>
      {hasMore ? (
        <button className="btn btn-light" type="button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? "Loading..." : "Load more"}
        </button>
      ) : null}
    </>
  );
}

/**
 * Full-screen "Select a fabric" picker shown over the Generate page (same overlay
 * style as the customer try-on). It is not a route, so Generate stays mounted.
 */
export function FabricPickerOverlay({
  onSelect,
  onClose
}: {
  onSelect: (row: FabricImageRow) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select a fabric"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column"
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          background: "var(--white)",
          borderBottom: "0.5px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }}
      >
        <h2 style={{ fontSize: "17px", fontWeight: 700, color: "var(--navy)", margin: 0 }}>Select a fabric</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: "none",
            fontSize: "22px",
            cursor: "pointer",
            color: "var(--text-muted)",
            lineHeight: 1,
            padding: "4px"
          }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "16px", display: "grid", gap: "14px", alignContent: "start" }}>
        <FabricLibraryGrid
          variant="picker"
          onSelect={onSelect}
          emptyText="No saved fabrics yet. Use Capture or Gallery first."
          errorText="Couldn't load your fabrics."
        />
      </div>
    </div>
  );
}
