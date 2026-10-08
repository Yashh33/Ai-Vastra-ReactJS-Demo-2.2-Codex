// Decodes a segmentation mask PNG and cleans it up off the main thread, so a
// large mask never stalls the sliders.
import type { MaskDecodeRequest, MaskDecodeResponse } from "./segment";
import { cleanupMask, maskFromRgba } from "./selection";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MaskDecodeRequest>) => void) | null;
  postMessage(message: MaskDecodeResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, dataUrl, width, height } = event.data;
  void (async () => {
    try {
      if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas unavailable");
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const mask = maskFromRgba(ctx.getImageData(0, 0, width, height).data, width, height);
      const selected = cleanupMask(mask, width, height);
      scope.postMessage({ id, mask, selected }, [mask.buffer]);
    } catch (err) {
      scope.postMessage({ id, error: err instanceof Error ? err.message : "Mask decode failed" });
    }
  })();
};
