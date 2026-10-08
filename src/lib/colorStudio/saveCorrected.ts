// Backend calls that store / undo a colour-corrected look image.
import { apiFetch } from "../api";

export type ColorCorrectedResponse = { id: string; output_path: string };

/** Uploads the corrected JPEG as the look's new output image. */
export function saveColorCorrected(accessToken: string, generationId: string, blob: Blob) {
  const form = new FormData();
  form.set("file", blob, "color-corrected.jpg");
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
