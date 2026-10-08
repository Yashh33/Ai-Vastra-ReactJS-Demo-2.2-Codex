// Front for the selection maths: uses a Web Worker when one can be started and
// quietly falls back to running the same functions on the main thread.
import { rgbaToLab } from "./lab";
import { fitToEdges, tapGrow, type Rect } from "./selection";

export type MaskResult = {
  /** A new mask; identical to the input outside `rect`. */
  mask: Uint8Array;
  /** Area that changed, or null when nothing did. */
  rect: Rect | null;
  ms: number;
};

export type EngineRequest =
  | { type: "init"; rgba: Uint8ClampedArray; width: number; height: number }
  | { type: "tap"; id: number; mask: Uint8Array; x: number; y: number; tolerance: number }
  | { type: "refine"; id: number; pre: Uint8Array; post: Uint8Array; margin: number; inset: number };

export type EngineResponse =
  | { id: number; mask: Uint8Array; rect: Rect | null; ms: number }
  | { id: number; error: string };

type Pending = {
  resolve: (result: MaskResult) => void;
  reject: (error: Error) => void;
  runLocally: () => MaskResult;
};

export class SelectionEngine {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private lab: Float32Array | null = null;
  private nextId = 1;

  constructor(
    private readonly rgba: Uint8ClampedArray,
    private readonly width: number,
    private readonly height: number
  ) {
    try {
      const worker = new Worker(new URL("./selection.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<EngineResponse>) => this.handleResponse(event.data);
      worker.onerror = () => this.failOver();
      // Structured clone: the worker gets its own copy of the pixels.
      worker.postMessage({ type: "init", rgba, width, height } satisfies EngineRequest);
      this.worker = worker;
    } catch {
      this.worker = null;
    }
  }

  get usesWorker() {
    return this.worker !== null;
  }

  /** Region-grow from (x, y); the result mask is `mask` plus the grown region. */
  tap(mask: Uint8Array, x: number, y: number, tolerance: number): Promise<MaskResult> {
    const runLocally = () => {
      const started = performance.now();
      const out = mask.slice();
      const rect = tapGrow(this.localLab(), this.width, this.height, out, x, y, tolerance);
      return { mask: out, rect, ms: performance.now() - started };
    };
    return this.dispatch((id) => ({ type: "tap", id, mask, x, y, tolerance }), runLocally);
  }

  /** Fit-to-edges for whatever was painted between `pre` and `post`. */
  refine(pre: Uint8Array, post: Uint8Array, margin: number, inset: number): Promise<MaskResult> {
    const runLocally = () => {
      const started = performance.now();
      const out = post.slice();
      const rect = fitToEdges(this.localLab(), this.width, this.height, pre, out, { margin, inset });
      return { mask: out, rect, ms: performance.now() - started };
    };
    return this.dispatch((id) => ({ type: "refine", id, pre, post, margin, inset }), runLocally);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) entry.reject(new Error("Selection engine disposed"));
    this.pending.clear();
    this.lab = null;
  }

  private dispatch(build: (id: number) => EngineRequest, runLocally: () => MaskResult): Promise<MaskResult> {
    if (!this.worker) {
      try {
        return Promise.resolve(runLocally());
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const id = this.nextId++;
    return new Promise<MaskResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, runLocally });
      // No transfer list: the masks are copied, the caller keeps painting on its own.
      this.worker?.postMessage(build(id));
    });
  }

  private handleResponse(response: EngineResponse) {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if ("error" in response) entry.reject(new Error(response.error));
    else entry.resolve({ mask: response.mask, rect: response.rect, ms: response.ms });
  }

  /** The worker failed to load or crashed: finish outstanding work on this thread. */
  private failOver() {
    this.worker?.terminate();
    this.worker = null;
    const outstanding = [...this.pending.values()];
    this.pending.clear();
    for (const entry of outstanding) {
      try {
        entry.resolve(entry.runLocally());
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error("Selection failed"));
      }
    }
  }

  private localLab() {
    if (!this.lab) this.lab = rgbaToLab(this.rgba, this.width, this.height);
    return this.lab;
  }
}
