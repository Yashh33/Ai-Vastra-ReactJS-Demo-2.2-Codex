/** Shown to the user whenever a picked photo cannot be decoded. */
export const PHOTO_READ_ERROR = "Couldn't read this photo. Try another photo or take a screenshot of it.";

// Canvases above roughly this edge start failing on iOS (memory limits), so nothing is drawn larger.
const MAX_DECODE_EDGE = 2048;
// A JPEG already this small is passed through by compressImage instead of being re-encoded.
const PASS_THROUGH_BYTES = 500_000;
// A decoder that neither succeeds nor fails (seen with HEIC on iOS) must not leave
// the user staring at a spinner: after this long the next decoder is tried.
const DECODE_TIMEOUT_MS = 12_000;
const HEIC_CONVERT_TIMEOUT_MS = 45_000;

type Decoded = { source: CanvasImageSource; width: number; height: number; cleanup: () => void };

/** iPhone "High Efficiency" photos. iOS sometimes reports an empty type, so the name counts too. */
export function isHeicFile(file: File) {
  const type = file.type.toLowerCase();
  if (type === "image/heic" || type === "image/heif" || type === "image/heic-sequence" || type === "image/heif-sequence") {
    return true;
  }
  return /\.(heic|heif)$/i.test(file.name);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function decodeWithBitmap(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap !== "function") throw new Error("createImageBitmap unavailable");
  // "from-image" applies the EXIF rotation, so phone photos come out upright.
  const bitmap = await withTimeout(
    createImageBitmap(file, { imageOrientation: "from-image" }),
    DECODE_TIMEOUT_MS,
    "createImageBitmap"
  );
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    throw new Error("Bitmap has no size");
  }
  return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() };
}

/** <img> also applies EXIF rotation, and is how Safari on iOS 17+ decodes HEIC. */
async function decodeWithImage(file: Blob): Promise<Decoded> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await withTimeout(
      new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("Image load failed"));
        element.src = objectUrl;
      }),
      DECODE_TIMEOUT_MS,
      "Image decode"
    );
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Image has no size");
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl)
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

async function decodeNatively(file: Blob): Promise<Decoded> {
  try {
    return await decodeWithBitmap(file);
  } catch {
    return decodeWithImage(file);
  }
}

/** Last resort for HEIC the browser cannot decode itself. Loaded on demand: the converter is large. */
async function convertHeicToJpeg(file: File): Promise<Blob> {
  const { default: heic2any } = await import("heic2any");
  const converted = await withTimeout(
    heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 }),
    HEIC_CONVERT_TIMEOUT_MS,
    "HEIC conversion"
  );
  const blob = Array.isArray(converted) ? converted[0] : converted;
  if (!blob || blob.size === 0) throw new Error("HEIC conversion returned nothing");
  return blob;
}

async function decodeAny(file: File): Promise<Decoded> {
  try {
    return await decodeNatively(file);
  } catch (nativeError) {
    if (!isHeicFile(file)) throw nativeError;
    return decodeNatively(await convertHeicToJpeg(file));
  }
}

function replaceExtensionWithJpg(filename: string) {
  const withoutExt = filename.includes(".") ? filename.slice(0, filename.lastIndexOf(".")) : filename;
  return `${withoutExt || "image"}.jpg`;
}

async function encodeJpeg(decoded: Decoded, name: string, maxEdge: number, quality: number): Promise<File> {
  const scale = Math.min(1, Math.min(maxEdge, MAX_DECODE_EDGE) / Math.max(decoded.width, decoded.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");

  // JPEG has no transparency; flatten onto white rather than black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/jpeg", quality);
  });
  if (!blob || blob.size === 0) throw new Error("Canvas toBlob failed");
  return new File([blob], replaceExtensionWithJpg(name || "image.jpg"), { type: "image/jpeg" });
}

type NormalizeOptions = {
  /** Longest edge of the result; never above 2048. */
  maxEdge?: number;
  quality?: number;
  /** Hand a small, already-JPEG file back untouched instead of re-encoding it. */
  passThroughSmallJpeg?: boolean;
};

/**
 * Turns any picked photo - JPEG, PNG, WebP, or an iPhone HEIC/HEIF - into an
 * upright JPEG File. The original file is never returned for a non-JPEG input.
 * Tries, in order: createImageBitmap, <img>, then (HEIC only) the heic2any converter.
 * Throws an Error carrying PHOTO_READ_ERROR when nothing can read the photo.
 */
export async function normalizeToJpeg(file: File, options: NormalizeOptions = {}): Promise<File> {
  const maxEdge = Math.min(options.maxEdge ?? MAX_DECODE_EDGE, MAX_DECODE_EDGE);
  let decoded: Decoded;
  try {
    decoded = await decodeAny(file);
  } catch (err) {
    console.warn("normalizeToJpeg: could not decode", file.name, file.type || "(no type)", err);
    throw new Error(PHOTO_READ_ERROR);
  }

  try {
    if (
      options.passThroughSmallJpeg &&
      file.type === "image/jpeg" &&
      decoded.width <= maxEdge &&
      decoded.height <= maxEdge &&
      file.size < PASS_THROUGH_BYTES
    ) {
      return file;
    }
    return await encodeJpeg(decoded, file.name, maxEdge, options.quality ?? 0.9);
  } catch (err) {
    console.warn("normalizeToJpeg: could not convert", file.name, file.type || "(no type)", err);
    throw new Error(PHOTO_READ_ERROR);
  } finally {
    decoded.cleanup();
  }
}

/**
 * normalizeToJpeg plus a size limit: the result is a JPEG no larger than
 * `maxDimension` on its longest edge. This is what every photo picker calls, so
 * a picked photo is normalised and compressed in a single encode.
 */
export function compressImage(file: File, maxDimension: number, quality = 0.8): Promise<File> {
  return normalizeToJpeg(file, { maxEdge: maxDimension, quality, passThroughSmallJpeg: true });
}
