// Backend calls that store / undo a colour-corrected look image.
import { apiFetch } from "../api";
import { compressImage } from "../compressImage";

export type ColorCorrectedResponse = { id: string; output_path: string };

/** Uploads the corrected JPEG as the look's new output image. */
export async function saveColorCorrected(accessToken: string, generationId: string, blob: Blob) {
  // Same size limit as every other upload, so the save works on mobile data.
  const file = await compressImage(new File([blob], "color-corrected.jpg", { type: "image/jpeg" }), 1600);
  const form = new FormData();
  form.set("file", file, "color-corrected.jpg");
  return apiFetch<ColorCorrectedResponse>(
    `/generations/${encodeURIComponent(generationId)}/color-corrected`,
    accessToken,
    { method: "POST", body: form }
  );
}

/** Puts the look back to its original image (a no-op on the backend if it was never corrected). */
export function restoreOriginalColor(accessToken: string, generationId: string) {
  return apiFetch<ColorCorrectedResponse>(
    `/generations/${encodeURIComponent(generationId)}/restore-original`,
    accessToken,
    { method: "POST" }
  );
}
