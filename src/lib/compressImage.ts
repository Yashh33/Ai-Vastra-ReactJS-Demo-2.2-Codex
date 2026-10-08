/** Shown to the user whenever a picked photo cannot be decoded. */
export const PHOTO_READ_ERROR =
  "Couldn't read this photo. Please try another photo or take a screenshot of it.";

// Canvases above roughly this edge start failing on iOS (memory limits), so nothing is drawn larger.
const MAX_DECODE_EDGE = 2048;
// A JPEG already this small is passed through untouched instead of being re-encoded.
const PASS_THROUGH_BYTES = 500_000;

type Decoded = { source: CanvasImageSource; width: number; height: number; cleanup: () => void };

async function decodeImage(file: File): Promise<Decoded> {
  // "from-image" applies the EXIF rotation, so phone photos come out upright.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() };
    } catch {
      // Older Safari rejects the options argument, and some formats only decode
      // through <img>. An <img> also applies EXIF rotation, so fall through to it.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Image load failed"));
      element.src = objectUrl;
    });
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

function replaceExtensionWithJpg(filename: string) {
  const withoutExt = filename.includes(".") ? filename.slice(0, filename.lastIndexOf(".")) : filename;
  return `${withoutExt || "image"}.jpg`;
}

/**
 * Turns any picked photo (JPEG, PNG, HEIC, ...) into a JPEG File no larger than
 * `maxDimension` on its longest edge. Throws an Error carrying PHOTO_READ_ERROR
 * if the photo cannot be decoded - it never hands back an unreadable original.
 */
export async function compressImage(file: File, maxDimension: number, quality = 0.8): Promise<File> {
  let decoded: Decoded;
  try {
    decoded = await decodeImage(file);
  } catch (err) {
    console.warn("compressImage: could not decode", file.name, file.type, err);
    throw new Error(PHOTO_READ_ERROR);
  }

  try {
    const { source, width, height } = decoded;
    if (!width || !height) throw new Error("Image has no size");

    const maxEdge = Math.min(maxDimension, MAX_DECODE_EDGE);
    if (file.type === "image/jpeg" && width <= maxEdge && height <= maxEdge && file.size < PASS_THROUGH_BYTES) {
      return file;
    }

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");

    // JPEG has no transparency; flatten onto white rather than black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/jpeg", quality);
    });
    if (!blob || blob.size === 0) throw new Error("Canvas toBlob failed");

    return new File([blob], replaceExtensionWithJpg(file.name || "image.jpg"), { type: "image/jpeg" });
  } catch (err) {
    console.warn("compressImage: could not convert", file.name, file.type, err);
    throw new Error(PHOTO_READ_ERROR);
  } finally {
    decoded.cleanup();
  }
}
