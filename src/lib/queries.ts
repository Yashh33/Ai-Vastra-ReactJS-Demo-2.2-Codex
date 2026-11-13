import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { apiFetch } from "./api";
import { ApiError } from "./apiError";
import { useAuth } from "./auth";
import type { FabricImageRow, GarmentType, GenerationRow, RecentTryOn, ShopContext } from "./types";

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
    enabled: !!accessToken,
    // The rows carry signed hero URLs that expire; keep them fresh on a screen left open.
    refetchInterval: 40 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true
  });
}

export const FABRIC_PAGE_SIZE = 60;
export const FABRIC_IMAGES_QUERY_KEY = ["fabric-images", "pages"] as const;

/** The fabric library, newest first, loaded FABRIC_PAGE_SIZE at a time (GET /fabric-images limit + offset). */
export function useFabricImagePages() {
  const { accessToken } = useAuth();

  return useInfiniteQuery({
    queryKey: FABRIC_IMAGES_QUERY_KEY,
    queryFn: ({ pageParam }) =>
      apiFetch<FabricImageRow[]>(
        `/fabric-images?limit=${FABRIC_PAGE_SIZE}&offset=${pageParam}`,
        accessToken as string,
        { method: "GET" }
      ),
    initialPageParam: 0,
    // A full page means there may be more; the next one starts after everything loaded so far.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length >= FABRIC_PAGE_SIZE ? allPages.reduce((total, page) => total + page.length, 0) : undefined,
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

export const RECENT_TRYONS_QUERY_KEY = ["tryon-recent"] as const;

/** The list from GET /tryon/recent (a bare array, or wrapped in items / tryons). */
function toRecentTryOns(payload: unknown): RecentTryOn[] {
  const box = payload as { items?: unknown; tryons?: unknown } | null;
  const list = Array.isArray(payload) ? payload : Array.isArray(box?.items) ? box.items : Array.isArray(box?.tryons) ? box.tryons : [];
  return (list as RecentTryOn[]).filter((row) => !!row && typeof row.request_id === "string" && !!row.request_id);
}

/** This shop's try-ons of the last 24 hours. A backend without the endpoint (404/405) gives an empty list. */
export function useRecentTryOns() {
  const { accessToken } = useAuth();

  return useQuery({
    queryKey: RECENT_TRYONS_QUERY_KEY,
    queryFn: async () => {
      try {
        return toRecentTryOns(await apiFetch<unknown>("/tryon/recent", accessToken as string, { method: "GET" }));
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return [];
        throw err;
      }
    },
    enabled: !!accessToken,
    // The picture links are signed and expire; a list left open is refreshed now and then.
    refetchInterval: 10 * 60 * 1000,
    refetchOnWindowFocus: true
  });
}
