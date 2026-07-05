import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./api";
import { useAuth } from "./auth";
import type { FabricImageRow, GarmentType, GenerationRow, ShopContext } from "./types";

export type MeResponse = ShopContext & {
  shop_name?: string | null;
  header_display_text?: string | null;
  credits_balance?: number | null;
};

export function useMe() {
  const { accessToken } = useAuth();

  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/me", accessToken as string, { method: "GET" }),
    enabled: !!accessToken
  });
}

export function useGarmentTypes() {
  const { accessToken } = useAuth();

  return useQuery({
    queryKey: ["garment-types"],
    queryFn: () => apiFetch<GarmentType[]>("/garment-types", accessToken as string, { method: "GET" }),
    enabled: !!accessToken
  });
}

export function useFabricImages() {
  const { accessToken } = useAuth();

  return useQuery({
    queryKey: ["fabric-images"],
    queryFn: () => apiFetch<FabricImageRow[]>("/fabric-images?limit=100", accessToken as string, { method: "GET" }),
    enabled: !!accessToken
  });
}

export type GenerationsParams = {
  status?: string;
  folder_id?: string;
  fabric_code?: string;
  fabric_color?: string;
  limit?: number;
  include_urls?: boolean;
};

function buildGenerationsQueryString(params: GenerationsParams) {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.folder_id) search.set("folder_id", params.folder_id);
  if (params.fabric_code) search.set("fabric_code", params.fabric_code);
  if (params.fabric_color) search.set("fabric_color", params.fabric_color);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.include_urls !== undefined) search.set("include_urls", String(params.include_urls));
  return search.toString();
}

export function useGenerations(params: GenerationsParams, options?: { enabled?: boolean }) {
  const { accessToken } = useAuth();

  return useQuery({
    queryKey: ["generations", params],
    queryFn: () =>
      apiFetch<GenerationRow[]>(`/generations?${buildGenerationsQueryString(params)}`, accessToken as string, {
        method: "GET"
      }),
    enabled: !!accessToken && (options?.enabled ?? true)
  });
}
