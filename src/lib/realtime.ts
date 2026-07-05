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
