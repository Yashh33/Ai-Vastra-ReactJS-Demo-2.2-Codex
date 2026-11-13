// Shared Browse/Carousel queries. The TV screen (anonymous client) and the web app
// (authenticated client) must both go through these so their data never drifts.

export type CarouselRow = { id: string; output_path: string; created_at: string };
export type BrowseGarmentType = { id: string; name: string };
export type BrowseLookRow = {
  id: string;
  output_path: string;
  created_at: string;
  is_hero: boolean;
  folder_id: string;
  barcode: string | null;
  mrp: number | null;
  description: string | null;
};

// Postgres numeric can arrive as a string; normalise to a number (or null when absent/invalid).
function toMrpNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Loosely typed so both the anon and authenticated supabase-js clients are accepted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = any;

export async function fetchCarouselLooks(
  supabase: AnySupabaseClient,
  shopId: string,
  limit = 30
): Promise<CarouselRow[]> {
  // Security-definer RPC: filters look + non-null output_path, newest first, bypassing anon RLS.
  const { data, error } = await supabase.rpc("get_carousel_looks", { p_shop_id: shopId, p_limit: limit });
  if (error) console.error("[screenData] get_carousel_looks error", error);
  return (data ?? []) as CarouselRow[];
}

export async function fetchBrowseGarmentTypes(
  supabase: AnySupabaseClient,
  shopId: string
): Promise<BrowseGarmentType[]> {
  // Security-definer RPC: returns only active garment types with at least one done look that
  // has an output_path, bypassing anon RLS on garment_types (the TV runs unauthenticated).
  const { data, error } = await supabase.rpc("get_browse_garment_types", { p_shop_id: shopId });
  if (error) console.error("[screenData] get_browse_garment_types error", error);
  return (data ?? []).map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }));
}

export async function fetchBrowseLooks(
  supabase: AnySupabaseClient,
  shopId: string,
  folderId: string
): Promise<BrowseLookRow[]> {
  // Security-definer RPC: filters look/done/output_path and orders is_hero desc, created_at desc.
  const { data, error } = await supabase.rpc("get_browse_looks", { p_shop_id: shopId, p_folder_id: folderId });
  if (error) console.error("[screenData] get_browse_looks error", error);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => ({
    id: r.id,
    output_path: r.output_path,
    created_at: r.created_at,
    is_hero: r.is_hero,
    folder_id: r.folder_id,
    barcode: r.barcode ?? null,
    mrp: toMrpNumber(r.mrp),
    description: r.description ?? null
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBrowseLookRow(r: any): BrowseLookRow {
  return {
    id: r.id,
    output_path: r.output_path,
    created_at: r.created_at,
    is_hero: r.is_hero,
    folder_id: r.folder_id,
    barcode: r.barcode ?? null,
    mrp: toMrpNumber(r.mrp),
    description: r.description ?? null
  };
}

export const BROWSE_PAGE_SIZE = 30;

export type BrowseLooksPage = {
  rows: BrowseLookRow[];
  /** More looks may follow this page. */
  hasMore: boolean;
};

// Set once get_browse_looks_page turns out not to exist on this database, so it is not asked again.
let browsePageRpcMissing = false;

// PostgREST "function not found" (PGRST202) / Postgres "undefined function" (42883).
function isMissingFunctionError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

/**
 * One page of a garment type's looks for the web app's Browse (same order as
 * fetchBrowseLooks: hero first, then newest). Uses get_browse_looks_page; on a
 * database without it, the first page is the whole list from get_browse_looks
 * and there are no further pages. Throws on any other error.
 * The TV screen keeps using fetchBrowseLooks.
 */
export async function fetchBrowseLooksPage(
  supabase: AnySupabaseClient,
  shopId: string,
  folderId: string,
  offset: number,
  limit = BROWSE_PAGE_SIZE
): Promise<BrowseLooksPage> {
  if (!browsePageRpcMissing) {
    const { data, error } = await supabase.rpc("get_browse_looks_page", {
      p_shop_id: shopId,
      p_folder_id: folderId,
      p_limit: limit,
      p_offset: offset
    });
    if (!error) {
      const raw = (data ?? []) as unknown[];
      return { rows: raw.map(toBrowseLookRow), hasMore: raw.length >= limit };
    }
    if (!isMissingFunctionError(error)) {
      console.error("[screenData] get_browse_looks_page error", error);
      throw new Error(error.message ?? "Couldn't load looks");
    }
    console.warn("[screenData] get_browse_looks_page missing; loading all looks with get_browse_looks");
    browsePageRpcMissing = true;
  }

  // Fallback: the whole list arrives as the first page.
  if (offset > 0) return { rows: [], hasMore: false };
  const { data, error } = await supabase.rpc("get_browse_looks", { p_shop_id: shopId, p_folder_id: folderId });
  if (error) {
    console.error("[screenData] get_browse_looks error", error);
    throw new Error(error.message ?? "Couldn't load looks");
  }
  return { rows: (data ?? []).map(toBrowseLookRow), hasMore: false };
}
