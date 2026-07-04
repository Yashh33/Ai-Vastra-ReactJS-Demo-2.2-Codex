async function loadBitmapSource(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; cleanup: () => void }> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close()
    };
  } catch {
    const objectUrl = URL.createObjectURL(file);
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
  }
}

function replaceExtensionWithJpg(filename: string) {
  const withoutExt = filename.includes(".") ? filename.slice(0, filename.lastIndexOf(".")) : filename;
  return `${withoutExt || "image"}.jpg`;
}

export async function compressImage(file: File, maxDimension: number, quality = 0.8): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  let cleanup: (() => void) | null = null;
  try {
    const { source, width, height, cleanup: cleanupSource } = await loadBitmapSource(file);
    cleanup = cleanupSource;

    if (width <= maxDimension && height <= maxDimension && file.size < 500_000) {
      return file;
    }

    const scale = maxDimension / Math.max(width, height);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");

    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/jpeg", quality);
    });
    if (!blob) throw new Error("Canvas toBlob failed");

    return new File([blob], replaceExtensionWithJpg(file.name || "image.jpg"), { type: "image/jpeg" });
  } catch (err) {
    console.warn("compressImage failed, using original file", err);
    return file;
  } finally {
    cleanup?.();
  }
}
