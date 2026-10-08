// Client for the /segment endpoint (SAM 3) plus decoding of the mask it returns.
//
// HARD RULE: /segment must never receive a try-on result or any image that
// contains the customer's photo. ColorStudio only calls this when its
// `allowSegment` prop is true, and try-on callers always pass false.
import { apiFetch } from "../api";
import type { GarmentPart } from "./garmentParts";
import { cleanupMask, maskFromRgba } from "./selection";

/** A correction tap, in 0..1 image coordinates. label 1 = include, 0 = leave out. */
export type SegmentPoint = { x: number; y: number; label: 0 | 1 };

export type SegmentResponse = {
  mask_png_base64: string;
  width: number;
  height: number;
  cached: boolean;
  part_key: string;
};

export type SegmentRequest = {
  /** Segment a stored look by id... */
  generationId?: string;
  /** ...or an image sent inline (a not-yet-uploaded fabric / garment photo). */
  imageDataUrl?: string;
  part: GarmentPart;
  points?: SegmentPoint[];
  useCache: boolean;
};

export function requestSegment(accessToken: string, request: SegmentRequest) {
  const body: Record<string, unknown> = {
    source: request.generationId ? "generation" : "upload",
    part_key: request.part.key,
    prompt: request.part.prompt,
    use_cache: request.useCache
  };
  if (request.generationId) body.generation_id = request.generationId;
  else body.image_data_url = request.imageDataUrl;
  if (request.points && request.points.length > 0) body.points = request.points;

  return apiFetch<SegmentResponse>("/segment", accessToken, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

const UPLOAD_MAX_EDGE = 1536;
const UPLOAD_QUALITY = 0.85;

/** JPEG data URL of the image for an "upload" segment request (longest edge <= 1536). */
export function buildSegmentUpload(image: HTMLImageElement) {
  const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", UPLOAD_QUALITY);
}

/* ---------- mask decoding ---------- */

export type MaskDecodeRequest = { id: number; dataUrl: string; width: number; height: number };
export type MaskDecodeResponse =
  | { id: number; mask: Uint8Array; selected: number }
  | { id: number; error: string };

export type DecodedMask = {
  /** Cleaned, feathered alpha map at the requested size. */
  mask: Uint8Array;
  /** Selected pixel count; 0 means the model found nothing. */
  selected: number;
};

async function decodeOnMainThread(dataUrl: string, width: number, height: number): Promise<DecodedMask> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The selection could not be read"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.drawImage(image, 0, 0, width, height);
  const mask = maskFromRgba(ctx.getImageData(0, 0, width, height).data, width, height);
  const selected = cleanupMask(mask, width, height);
  return { mask, selected };
}

/**
 * Decodes mask PNGs to preview-size alpha maps. Uses a worker (decode + cleanup
 * is well over a frame at 1280px) and falls back to the main thread where
 * workers or OffscreenCanvas are missing.
 */
export class MaskDecoder {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: DecodedMask) => void; reject: (error: Error) => void }
  >();

  decode(maskPngBase64: string, width: number, height: number): Promise<DecodedMask> {
    const dataUrl = maskPngBase64.startsWith("data:") ? maskPngBase64 : `data:image/png;base64,${maskPngBase64}`;
    const worker = this.ensureWorker();
    if (!worker) return decodeOnMainThread(dataUrl, width, height);

    const id = this.nextId++;
    return new Promise<DecodedMask>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, dataUrl, width, height } satisfies MaskDecodeRequest);
    }).catch(() => {
      // Whatever went wrong in the worker, the main thread can still do it.
      this.workerBroken = true;
      return decodeOnMainThread(dataUrl, width, height);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) entry.reject(new Error("Mask decoder disposed"));
    this.pending.clear();
  }

  private ensureWorker() {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL("./mask.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<MaskDecodeResponse>) => {
        const response = event.data;
        const entry = this.pending.get(response.id);
        if (!entry) return;
        this.pending.delete(response.id);
        if ("error" in response) entry.reject(new Error(response.error));
        else entry.resolve({ mask: response.mask, selected: response.selected });
      };
      worker.onerror = () => {
        this.workerBroken = true;
        const outstanding = [...this.pending.values()];
        this.pending.clear();
        for (const entry of outstanding) entry.reject(new Error("Mask worker failed"));
      };
      this.worker = worker;
    } catch {
      this.workerBroken = true;
    }
    return this.worker;
  }
}
