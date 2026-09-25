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
  const { data } = await supabase
    .from("generations")
    .select("id,output_path,created_at")
    .eq("shop_id", shopId)
    .eq("generation_type", "look")
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? [])
    .filter((row: { output_path: string | null }) => !!row.output_path)
    .map((row: CarouselRow) => ({ id: row.id, output_path: row.output_path, created_at: row.created_at }));
}

export async function fetchBrowseGarmentTypes(
  supabase: AnySupabaseClient,
  shopId: string
): Promise<BrowseGarmentType[]> {
  const { data: lookRows } = await supabase
    .from("generations")
    .select("folder_id,output_path")
    .eq("shop_id", shopId)
    .eq("generation_type", "look")
    .eq("status", "done");

  const folderIdsWithLooks = new Set<string>(
    (lookRows ?? [])
      .filter((row: { output_path: string | null }) => !!row.output_path)
      .map((row: { folder_id: string }) => row.folder_id)
  );

  if (folderIdsWithLooks.size === 0) return [];

  const { data: garmentTypeRows } = await supabase
    .from("garment_types")
    .select("id,name")
    .eq("shop_id", shopId);

  return (garmentTypeRows ?? []).filter((row: BrowseGarmentType) => folderIdsWithLooks.has(row.id));
}

export async function fetchBrowseLooks(
  supabase: AnySupabaseClient,
  shopId: string,
  folderId: string
): Promise<BrowseLookRow[]> {
  const { data } = await supabase
    .from("generations")
    .select("id,output_path,created_at,is_hero,folder_id")
    .eq("shop_id", shopId)
    .eq("generation_type", "look")
    .eq("status", "done")
    .eq("folder_id", folderId)
    .order("is_hero", { ascending: false })
    .order("created_at", { ascending: false });

  return (data ?? []).filter((row: { output_path: string | null }) => !!row.output_path);
}
