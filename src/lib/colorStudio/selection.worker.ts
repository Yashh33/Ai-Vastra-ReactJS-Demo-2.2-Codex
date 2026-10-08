// Runs the heavy selection work (Lab conversion, flood fill, k-means / fit-to-edges)
// off the main thread so painting stays smooth on phones.
import type { EngineRequest, EngineResponse } from "./engine";
import { rgbaToLab } from "./lab";
import { fitToEdges, tapGrow } from "./selection";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
  postMessage(message: EngineResponse, transfer?: Transferable[]): void;
};

let lab: Float32Array | null = null;
let width = 0;
let height = 0;

scope.onmessage = (event) => {
  const request = event.data;

  if (request.type === "init") {
    width = request.width;
    height = request.height;
    lab = rgbaToLab(request.rgba, width, height);
    return;
  }

  if (!lab) {
    scope.postMessage({ id: request.id, error: "Selection worker not initialised" });
    return;
  }

  try {
    const started = performance.now();
    if (request.type === "tap") {
      const mask = request.mask;
      const rect = tapGrow(lab, width, height, mask, request.x, request.y, request.tolerance);
      scope.postMessage({ id: request.id, mask, rect, ms: performance.now() - started }, [mask.buffer]);
    } else {
      const mask = request.post;
      const rect = fitToEdges(lab, width, height, request.pre, mask, { margin: request.margin, inset: request.inset });
      scope.postMessage({ id: request.id, mask, rect, ms: performance.now() - started }, [mask.buffer]);
    }
  } catch (err) {
    scope.postMessage({ id: request.id, error: err instanceof Error ? err.message : "Selection failed" });
  }
};
