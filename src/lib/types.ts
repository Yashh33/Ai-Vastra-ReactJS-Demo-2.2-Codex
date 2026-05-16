export type ShopContext = {
  auth_user_id: string;
  email: string | null;
  shop_id: string;
  role: string;
};

export type FolderRow = {
  id: string;
  shop_id: string;
  name: string;
  prompt_template: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type GarmentType = {
  id: string;
  name: string;
  prompt_template: string;
  default_hero_image_id: string | null;
  hero_image_signed_url: string | null;
};

export type HeroImageRow = {
  id: string;
  shop_id: string;
  folder_id: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
};

export type FabricImageRow = {
  id: string;
  shop_id: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
};

export type GenerationStatus = "queued" | "processing" | "done" | "failed" | string;

export type ApplyToTarget = "shirt" | "pant" | "suit_full_body" | "suit_upper" | "koti";

export type GenerationFabricAssignmentPayload = {
  fabric_image_id: string;
  apply_to: ApplyToTarget;
  fabric_code: string;
  fabric_color?: string | null;
};

export type GenerationFabricSnapshot = {
  generation_id: string;
  apply_to: ApplyToTarget | string;
  sort_order: number;
  fabric_code: string | null;
  fabric_color: string | null;
};

export type GenerationRow = {
  id: string;
  shop_id: string;
  hero_image_id: string;
  fabric_image_id: string;
  folder_id: string;
  status: GenerationStatus;
  prompt_used: string | null;
  nano_request_id: string | null;
  output_path: string | null;
  error: string | null;
  credits_used: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  fabric_summary_label?: string;
  generation_fabrics?: GenerationFabricSnapshot[];
};

export type GenerationCreateResponse = {
  id: string;
  status: string;
  credits_used: number;
  balance_before: number;
  balance_after: number;
  prompt_saved: boolean;
  warning?: string;
};

export type DownloadUrlResponse = {
  generation_id: string;
  download_url: string;
  expires_in_seconds: number;
};

export type MatchColorSaveResponse = {
  generation_id: string;
  output_path: string;
  edited: boolean;
  applied_edits?: number;
};

export type CatalogImageRow = {
  id: string;
  shop_id: string;
  folder_id: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CatalogImageDownloadUrlResponse = {
  catalog_image_id: string;
  download_url: string;
  expires_in_seconds: number;
};

export type MatchColorEditPayload = {
  selected_hex: string;
  hue_shift_degrees: number;
  saturation_delta_percent: number;
  lightness_delta_percent: number;
};


