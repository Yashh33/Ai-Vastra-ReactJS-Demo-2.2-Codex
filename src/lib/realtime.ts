import { supabase } from "./supabase";

export type GenerationRealtimeRow = {
  id: string;
  status: string;
  error: string | null;
  output_path: string | null;
};

export function subscribeToGeneration(
  generationId: string,
  onUpdate: (row: GenerationRealtimeRow) => void
) {
  const channel = supabase
    .channel(`gen-${generationId}`)
    .on<GenerationRealtimeRow>(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "generations",
        filter: `id=eq.${generationId}`
      },
      (payload) => onUpdate(payload.new)
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export type ShopScreenStateRow = {
  shop_id: string;
  mode: string;
  live_generation_id: string | null;
  updated_at: string;
};

export type ShopScreenGenerationRow = {
  id: string;
  shop_id: string;
  output_path: string | null;
  status: string;
  show_on_screen: boolean;
  generation_type: string;
  created_at: string;
};

export function subscribeToShopScreenState(
  shopId: string,
  onChange: (row: ShopScreenStateRow) => void
) {
  const channel = supabase
    .channel(`shop-screen-state-${shopId}`)
    .on<ShopScreenStateRow>(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "shop_screen_state",
        filter: `shop_id=eq.${shopId}`
      },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        onChange(payload.new);
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}

export function subscribeToShopGenerations(
  shopId: string,
  onChange: (row: ShopScreenGenerationRow) => void
) {
  const channel = supabase
    .channel(`shop-generations-${shopId}`)
    .on<ShopScreenGenerationRow>(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "generations",
        filter: `shop_id=eq.${shopId}`
      },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        onChange(payload.new);
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
