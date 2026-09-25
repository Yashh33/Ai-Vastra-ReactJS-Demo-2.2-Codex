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
};

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
  return (data ?? []) as BrowseLookRow[];
}
