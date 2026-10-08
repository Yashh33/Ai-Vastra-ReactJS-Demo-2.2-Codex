// Mask building for ColorStudio: brush, eraser, tap-grow, fit-to-edges, cleanup.
// The mask is a Uint8Array alpha map (0..255) at preview size. Everything here is
// plain typed-array maths with no DOM access, so it also runs inside the worker.

/** Pixel rectangle; x1/y1 are exclusive. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

// Lightness counts for less than chroma when comparing colours, so folds and
// soft shadows on a garment stay inside the selection.
const L_WEIGHT = 0.5;

const FEATHER_PAD = 4;
const MAX_CLUSTERS = 5;
const MAX_SAMPLES = 6000;
const KMEANS_ITERATIONS = 8;
// A new cluster is only seeded if some sample is at least this far from every centroid.
const MIN_CLUSTER_SPLIT = 10;
// Clusters holding less than this share of the samples are treated as spill.
const MIN_CLUSTER_SHARE = 0.08;
const MIN_COMPONENT_SHARE = 0.02;

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1)
  };
}

function expandRect(rect: Rect, by: number, width: number, height: number): Rect {
  return {
    x0: Math.max(0, rect.x0 - by),
    y0: Math.max(0, rect.y0 - by),
    x1: Math.min(width, rect.x1 + by),
    y1: Math.min(height, rect.y1 + by)
  };
}

/* ---------- brush / eraser ---------- */

/** Stamps an anti-aliased disc into the mask. Returns the touched rect. */
export function stampDisc(
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  erase: boolean
): Rect | null {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const x1 = Math.min(width, Math.ceil(cx + radius + 1));
  const y1 = Math.min(height, Math.ceil(cy + radius + 1));
  if (x1 <= x0 || y1 <= y0) return null;

  const inner = Math.max(0, radius - 0.5);
  const inner2 = inner * inner;
  const outer = radius + 0.5;
  const outer2 = outer * outer;

  for (let y = y0; y < y1; y += 1) {
    const dy = y + 0.5 - cy;
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= outer2) continue;
      const value = d2 <= inner2 ? 255 : Math.round((outer - Math.sqrt(d2)) * 255);
      const i = row + x;
      if (erase) {
        const keep = 255 - value;
        if (mask[i]! > keep) mask[i] = keep;
      } else if (mask[i]! < value) {
        mask[i] = value;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/** Stamps discs along a segment (the start point is assumed to be stamped already). */
export function strokeSegment(
  mask: Uint8Array,
  width: number,
  height: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  erase: boolean
): Rect | null {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.35)));
  let rect: Rect | null = null;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    rect = unionRect(
      rect,
      stampDisc(mask, width, height, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, radius, erase)
    );
  }
  return rect;
}

/* ---------- undo snapshots (run-length encoded) ---------- */

/** Run-length encodes a mask; each entry is (runLength << 8) | value. */
export function encodeMask(mask: Uint8Array): Uint32Array {
  const runs: number[] = [];
  let value = mask[0] ?? 0;
  let run = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const current = mask[i]!;
    if (current === value && run < 0xffffff) {
      run += 1;
    } else {
      runs.push(run * 256 + value);
      value = current;
      run = 1;
    }
  }
  if (run > 0) runs.push(run * 256 + value);
  return Uint32Array.from(runs);
}

export function decodeMask(encoded: Uint32Array, target: Uint8Array) {
  let offset = 0;
  for (let i = 0; i < encoded.length; i += 1) {
    const entry = encoded[i]!;
    const run = entry >>> 8;
    target.fill(entry & 0xff, offset, offset + run);
    offset += run;
  }
}

/* ---------- window helpers (operate on a window-local 0/1 buffer) ---------- */

type Components = { labels: Int32Array; areas: number[]; touchesBorder: boolean[] };

/** 4-connected labelling of all pixels equal to `target`. Label ids start at 1. */
function labelComponents(bin: Uint8Array, ww: number, wh: number, target: number): Components {
  const labels = new Int32Array(ww * wh);
  const stack = new Int32Array(ww * wh);
  const areas: number[] = [0];
  const touchesBorder: boolean[] = [false];

  for (let start = 0; start < bin.length; start += 1) {
    if (bin[start] !== target || labels[start] !== 0) continue;
    const id = areas.length;
    let area = 0;
    let border = false;
    let sp = 0;
    labels[start] = id;
    stack[sp++] = start;

    while (sp > 0) {
      const i = stack[--sp]!;
      const x = i % ww;
      const y = (i - x) / ww;
      area += 1;
      if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) border = true;

      if (x > 0 && bin[i - 1] === target && labels[i - 1] === 0) {
        labels[i - 1] = id;
        stack[sp++] = i - 1;
      }
      if (x < ww - 1 && bin[i + 1] === target && labels[i + 1] === 0) {
        labels[i + 1] = id;
        stack[sp++] = i + 1;
      }
      if (y > 0 && bin[i - ww] === target && labels[i - ww] === 0) {
        labels[i - ww] = id;
        stack[sp++] = i - ww;
      }
      if (y < wh - 1 && bin[i + ww] === target && labels[i + ww] === 0) {
        labels[i + ww] = id;
        stack[sp++] = i + ww;
      }
    }

    areas.push(area);
    touchesBorder.push(border);
  }

  return { labels, areas, touchesBorder };
}

/** Fills enclosed background regions no larger than maxArea. */
function fillSmallHoles(bin: Uint8Array, ww: number, wh: number, maxArea: number) {
  const { labels, areas, touchesBorder } = labelComponents(bin, ww, wh, 0);
  for (let i = 0; i < bin.length; i += 1) {
    const id = labels[i]!;
    if (id !== 0 && !touchesBorder[id] && areas[id]! <= maxArea) bin[i] = 1;
  }
}

function boxSum3(src: Uint8Array, tmp: Uint8Array, dst: Uint8Array, ww: number, wh: number) {
  for (let y = 0; y < wh; y += 1) {
    const row = y * ww;
    for (let x = 0; x < ww; x += 1) {
      const left = x > 0 ? x - 1 : x;
      const right = x < ww - 1 ? x + 1 : x;
      tmp[row + x] = src[row + left]! + src[row + x]! + src[row + right]!;
    }
  }
  for (let y = 0; y < wh; y += 1) {
    const row = y * ww;
    const up = (y > 0 ? y - 1 : y) * ww;
    const down = (y < wh - 1 ? y + 1 : y) * ww;
    for (let x = 0; x < ww; x += 1) {
      dst[row + x] = tmp[up + x]! + tmp[row + x]! + tmp[down + x]!;
    }
  }
}

/**
 * Writes the window's 0/1 buffer back into the mask with a soft edge (two 3x3
 * box blurs, roughly a 2-3px feather). The outer 2px ring of the window is left
 * untouched unless it lies on the image border, so the blur never reads past data
 * it knows about. Callers pad their window by FEATHER_PAD to allow for this.
 */
function writeFeathered(mask: Uint8Array, width: number, height: number, bin: Uint8Array, win: Rect) {
  const ww = win.x1 - win.x0;
  const wh = win.y1 - win.y0;
  const tmp = new Uint8Array(ww * wh);
  const pass1 = new Uint8Array(ww * wh);
  const pass2 = new Uint8Array(ww * wh);
  boxSum3(bin, tmp, pass1, ww, wh);
  boxSum3(pass1, tmp, pass2, ww, wh);

  const xStart = win.x0 === 0 ? 0 : 2;
  const yStart = win.y0 === 0 ? 0 : 2;
  const xEnd = win.x1 === width ? ww : ww - 2;
  const yEnd = win.y1 === height ? wh : wh - 2;
  for (let y = yStart; y < yEnd; y += 1) {
    const src = y * ww;
    const dst = (win.y0 + y) * width + win.x0;
    for (let x = xStart; x < xEnd; x += 1) {
      mask[dst + x] = Math.round((pass2[src + x]! * 255) / 81);
    }
  }
}

function binarizeWindow(mask: Uint8Array, width: number, win: Rect) {
  const ww = win.x1 - win.x0;
  const wh = win.y1 - win.y0;
  const bin = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y += 1) {
    const src = (win.y0 + y) * width + win.x0;
    const dst = y * ww;
    for (let x = 0; x < ww; x += 1) {
      if (mask[src + x]! > 127) bin[dst + x] = 1;
    }
  }
  return bin;
}

/* ---------- tap: region grow ---------- */

/**
 * Flood-fills from (px, py) over 4-connected pixels whose colour is within
 * `tolerance` (deltaE in Lab) of the tapped colour, and adds the region to the mask.
 */
export function tapGrow(
  lab: Float32Array,
  width: number,
  height: number,
  mask: Uint8Array,
  px: number,
  py: number,
  tolerance: number
): Rect | null {
  const sx = Math.min(width - 1, Math.max(0, Math.floor(px)));
  const sy = Math.min(height - 1, Math.max(0, Math.floor(py)));

  // Seed colour = mean of the 3x3 neighbourhood, so a single noisy pixel does not decide.
  let seedL = 0;
  let seedA = 0;
  let seedB = 0;
  let seedCount = 0;
  for (let y = Math.max(0, sy - 1); y <= Math.min(height - 1, sy + 1); y += 1) {
    for (let x = Math.max(0, sx - 1); x <= Math.min(width - 1, sx + 1); x += 1) {
      const q = (y * width + x) * 3;
      seedL += lab[q]!;
      seedA += lab[q + 1]!;
      seedB += lab[q + 2]!;
      seedCount += 1;
    }
  }
  seedL /= seedCount;
  seedA /= seedCount;
  seedB /= seedCount;

  const tol2 = tolerance * tolerance;
  const within = (i: number) => {
    const q = i * 3;
    const dL = (lab[q]! - seedL) * L_WEIGHT;
    const da = lab[q + 1]! - seedA;
    const db = lab[q + 2]! - seedB;
    return dL * dL + da * da + db * db <= tol2;
  };

  const region = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let sp = 0;
  const seed = sy * width + sx;
  region[seed] = 1;
  stack[sp++] = seed;

  let x0 = sx;
  let x1 = sx;
  let y0 = sy;
  let y1 = sy;
  let area = 0;

  while (sp > 0) {
    const i = stack[--sp]!;
    const x = i % width;
    const y = (i - x) / width;
    area += 1;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;

    if (x > 0 && region[i - 1] === 0 && within(i - 1)) {
      region[i - 1] = 1;
      stack[sp++] = i - 1;
    }
    if (x < width - 1 && region[i + 1] === 0 && within(i + 1)) {
      region[i + 1] = 1;
      stack[sp++] = i + 1;
    }
    if (y > 0 && region[i - width] === 0 && within(i - width)) {
      region[i - width] = 1;
      stack[sp++] = i - width;
    }
    if (y < height - 1 && region[i + width] === 0 && within(i + width)) {
      region[i + width] = 1;
      stack[sp++] = i + width;
    }
  }

  const win = expandRect({ x0, y0, x1: x1 + 1, y1: y1 + 1 }, FEATHER_PAD, width, height);
  const ww = win.x1 - win.x0;
  const wh = win.y1 - win.y0;
  const grown = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y += 1) {
    const src = (win.y0 + y) * width + win.x0;
    grown.set(region.subarray(src, src + ww), y * ww);
  }
  // Weave, print specks and noise leave pinholes in a colour fill.
  fillSmallHoles(grown, ww, wh, Math.max(64, Math.round(area * 0.01)));

  const bin = binarizeWindow(mask, width, win);
  for (let i = 0; i < bin.length; i += 1) {
    if (grown[i] === 1) bin[i] = 1;
  }
  writeFeathered(mask, width, height, bin, win);
  return win;
}

/* ---------- fit to edges ---------- */

type Clusters = {
  k: number;
  /** Centroids in weighted space (L * L_WEIGHT, a, b). */
  centroids: Float32Array;
  counts: Int32Array;
  /** Root-mean-square distance of members to their centroid. */
  spread: Float32Array;
};

/** k-means over weighted-Lab samples; k adapts between 1 and kMax. */
function kmeans(samples: Float32Array, count: number, kMax: number): Clusters {
  const centroids = new Float32Array(kMax * 3);

  // First centroid: the sample nearest the overall mean. Further centroids are
  // seeded farthest-point-first, which is deterministic and pulls outliers
  // (brush spill) into their own small clusters where they can be discarded.
  let meanL = 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < count; i += 1) {
    meanL += samples[i * 3]!;
    meanA += samples[i * 3 + 1]!;
    meanB += samples[i * 3 + 2]!;
  }
  meanL /= count;
  meanA /= count;
  meanB /= count;

  let nearest = 0;
  let nearestD = Infinity;
  for (let i = 0; i < count; i += 1) {
    const dL = samples[i * 3]! - meanL;
    const da = samples[i * 3 + 1]! - meanA;
    const db = samples[i * 3 + 2]! - meanB;
    const d = dL * dL + da * da + db * db;
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
  }
  centroids[0] = samples[nearest * 3]!;
  centroids[1] = samples[nearest * 3 + 1]!;
  centroids[2] = samples[nearest * 3 + 2]!;

  let k = 1;
  const minDist = new Float32Array(count).fill(Infinity);
  while (k < kMax) {
    const cL = centroids[(k - 1) * 3]!;
    const cA = centroids[(k - 1) * 3 + 1]!;
    const cB = centroids[(k - 1) * 3 + 2]!;
    let far = 0;
    let farD = -1;
    for (let i = 0; i < count; i += 1) {
      const dL = samples[i * 3]! - cL;
      const da = samples[i * 3 + 1]! - cA;
      const db = samples[i * 3 + 2]! - cB;
      const d = dL * dL + da * da + db * db;
      if (d < minDist[i]!) minDist[i] = d;
      if (minDist[i]! > farD) {
        farD = minDist[i]!;
        far = i;
      }
    }
    if (farD < MIN_CLUSTER_SPLIT * MIN_CLUSTER_SPLIT) break;
    centroids[k * 3] = samples[far * 3]!;
    centroids[k * 3 + 1] = samples[far * 3 + 1]!;
    centroids[k * 3 + 2] = samples[far * 3 + 2]!;
    k += 1;
  }

  const assignment = new Uint8Array(count);
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  const spread = new Float32Array(k);
  const sumD = new Float64Array(k);

  for (let iteration = 0; iteration <= KMEANS_ITERATIONS; iteration += 1) {
    sums.fill(0);
    counts.fill(0);
    sumD.fill(0);
    for (let i = 0; i < count; i += 1) {
      const sL = samples[i * 3]!;
      const sA = samples[i * 3 + 1]!;
      const sB = samples[i * 3 + 2]!;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const dL = sL - centroids[c * 3]!;
        const da = sA - centroids[c * 3 + 1]!;
        const db = sB - centroids[c * 3 + 2]!;
        const d = dL * dL + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assignment[i] = best;
      counts[best] = counts[best]! + 1;
      sumD[best] = sumD[best]! + bestD;
      sums[best * 3] = sums[best * 3]! + sL;
      sums[best * 3 + 1] = sums[best * 3 + 1]! + sA;
      sums[best * 3 + 2] = sums[best * 3 + 2]! + sB;
    }
    // The last pass only measures; centroids stay as they were for it.
    if (iteration === KMEANS_ITERATIONS) break;
    for (let c = 0; c < k; c += 1) {
      const n = counts[c]!;
      if (n === 0) continue;
      centroids[c * 3] = sums[c * 3]! / n;
      centroids[c * 3 + 1] = sums[c * 3 + 1]! / n;
      centroids[c * 3 + 2] = sums[c * 3 + 2]! / n;
    }
  }

  for (let c = 0; c < k; c += 1) {
    spread[c] = counts[c]! > 0 ? Math.sqrt(sumD[c]! / counts[c]!) : 0;
  }
  return { k, centroids, counts, spread };
}

/** Square dilation of a window-local 0/1 buffer by `radius` pixels. */
function dilate(src: Uint8Array, ww: number, wh: number, radius: number) {
  const horizontal = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y += 1) {
    const row = y * ww;
    let last = -Infinity;
    for (let x = 0; x < ww; x += 1) {
      if (src[row + x] === 1) last = x;
      if (x - last <= radius) horizontal[row + x] = 1;
    }
    last = Infinity;
    for (let x = ww - 1; x >= 0; x -= 1) {
      if (src[row + x] === 1) last = x;
      if (last - x <= radius) horizontal[row + x] = 1;
    }
  }

  const out = new Uint8Array(ww * wh);
  for (let x = 0; x < ww; x += 1) {
    let last = -Infinity;
    for (let y = 0; y < wh; y += 1) {
      if (horizontal[y * ww + x] === 1) last = y;
      if (y - last <= radius) out[y * ww + x] = 1;
    }
    last = Infinity;
    for (let y = wh - 1; y >= 0; y -= 1) {
      if (horizontal[y * ww + x] === 1) last = y;
      if (last - y <= radius) out[y * ww + x] = 1;
    }
  }
  return out;
}

export type FitOptions = {
  /** How far (px) past the painted area the selection may grow to reach the real edge. */
  margin: number;
  /**
   * How far (px) from the selection's rim a pixel must sit to be used as a colour
   * sample. Pass roughly half the brush radius: spill lives in the outer part of a stroke.
   */
  inset?: number;
  /** Multiplier on the colour-match threshold; 1 = default. */
  sensitivity?: number;
};

/**
 * Snaps freshly painted strokes to the garment's colour edges.
 *
 * `pre` is the mask before the stroke(s), `post` the mask after; `post` is
 * rewritten in place. Only pixels the strokes added (plus `margin` around them)
 * are reconsidered - everything that was already selected is kept as it was.
 */
export function fitToEdges(
  lab: Float32Array,
  width: number,
  height: number,
  pre: Uint8Array,
  post: Uint8Array,
  options: FitOptions
): Rect | null {
  const margin = Math.max(1, Math.round(options.margin));
  const sensitivity = options.sensitivity ?? 1;

  // 1. Bounding box of the newly painted pixels, and the total selected area.
  let bx0 = width;
  let by0 = height;
  let bx1 = -1;
  let by1 = -1;
  let totalArea = 0;
  let paintedCount = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      if (post[i]! <= 127) continue;
      totalArea += 1;
      if (pre[i]! > 127) continue;
      paintedCount += 1;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (paintedCount === 0) return null;

  const win = expandRect({ x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 }, margin + FEATHER_PAD, width, height);
  const ww = win.x1 - win.x0;
  const wh = win.y1 - win.y0;
  const size = ww * wh;

  // 2. Colour samples from the selected pixels in the window. Pixels well inside
  //    the selection are preferred: spill sits at the rim of a brush stroke.
  const inset = Math.max(2, Math.round(options.inset ?? margin * 0.4));
  const diagonal = Math.max(1, Math.round(inset * 0.7));
  const selected = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height || post[y * width + x]! > 127;
  const interior = new Int32Array(size);
  const all = new Int32Array(size);
  let interiorCount = 0;
  let allCount = 0;
  for (let y = win.y0; y < win.y1; y += 1) {
    for (let x = win.x0; x < win.x1; x += 1) {
      const i = y * width + x;
      if (post[i]! <= 127) continue;
      all[allCount++] = i;
      if (
        selected(x - inset, y) &&
        selected(x + inset, y) &&
        selected(x, y - inset) &&
        selected(x, y + inset) &&
        selected(x - diagonal, y - diagonal) &&
        selected(x + diagonal, y - diagonal) &&
        selected(x - diagonal, y + diagonal) &&
        selected(x + diagonal, y + diagonal)
      ) {
        interior[interiorCount++] = i;
      }
    }
  }
  const useInterior = interiorCount >= 150;
  const pool = useInterior ? interior : all;
  const poolCount = useInterior ? interiorCount : allCount;
  const stride = Math.max(1, Math.ceil(poolCount / MAX_SAMPLES));
  const sampleCount = Math.ceil(poolCount / stride);
  const samples = new Float32Array(sampleCount * 3);
  for (let s = 0; s < sampleCount; s += 1) {
    const q = pool[s * stride]! * 3;
    samples[s * 3] = lab[q]! * L_WEIGHT;
    samples[s * 3 + 1] = lab[q + 1]!;
    samples[s * 3 + 2] = lab[q + 2]!;
  }

  const clusters = kmeans(samples, sampleCount, MAX_CLUSTERS);
  const keptCentroids: number[] = [];
  const keptThreshold2: number[] = [];
  let largest = 0;
  for (let c = 1; c < clusters.k; c += 1) {
    if (clusters.counts[c]! > clusters.counts[largest]!) largest = c;
  }
  for (let c = 0; c < clusters.k; c += 1) {
    if (c !== largest && clusters.counts[c]! < sampleCount * MIN_CLUSTER_SHARE) continue;
    const threshold = Math.min(22, Math.max(8, clusters.spread[c]! * 2.5 + 3)) * sensitivity;
    keptCentroids.push(clusters.centroids[c * 3]!, clusters.centroids[c * 3 + 1]!, clusters.centroids[c * 3 + 2]!);
    keptThreshold2.push(threshold * threshold);
  }
  const clusterCount = keptThreshold2.length;

  // 3. Candidate area = newly painted pixels grown by the margin.
  const painted = new Uint8Array(size);
  for (let y = 0; y < wh; y += 1) {
    const src = (win.y0 + y) * width + win.x0;
    const dst = y * ww;
    for (let x = 0; x < ww; x += 1) {
      if (post[src + x]! > 127 && pre[src + x]! <= 127) painted[dst + x] = 1;
    }
  }
  const candidate = dilate(painted, ww, wh, margin);

  // 4. Keep what was selected before; in the candidate area keep colour matches only.
  const bin = new Uint8Array(size);
  let paintedKept = 0;
  for (let y = 0; y < wh; y += 1) {
    const src = (win.y0 + y) * width + win.x0;
    const dst = y * ww;
    for (let x = 0; x < ww; x += 1) {
      if (pre[src + x]! > 127) {
        // Previously selected and since erased stays erased.
        if (post[src + x]! > 127) bin[dst + x] = 1;
        continue;
      }
      if (candidate[dst + x] !== 1) continue;
      const q = (src + x) * 3;
      const pL = lab[q]! * L_WEIGHT;
      const pA = lab[q + 1]!;
      const pB = lab[q + 2]!;
      for (let c = 0; c < clusterCount; c += 1) {
        const dL = pL - keptCentroids[c * 3]!;
        const da = pA - keptCentroids[c * 3 + 1]!;
        const db = pB - keptCentroids[c * 3 + 2]!;
        if (dL * dL + da * da + db * db < keptThreshold2[c]!) {
          bin[dst + x] = 1;
          if (painted[dst + x] === 1) paintedKept += 1;
          break;
        }
      }
    }
  }

  // Busy prints can defeat the colour model. If most of what the user painted
  // would be thrown away, trust the hand-painted stroke instead.
  if (paintedKept < paintedCount * 0.3) {
    writeFeathered(post, width, height, binarizeWindow(post, width, win), win);
    return win;
  }

  // 5. Drop small stray islands. The island carrying most of the stroke always
  //    stays, as does anything attached to the earlier selection.
  const { labels, areas } = labelComponents(bin, ww, wh, 1);
  const hasPrevious = new Uint8Array(areas.length);
  const paintedIn = new Int32Array(areas.length);
  for (let y = 0; y < wh; y += 1) {
    const src = (win.y0 + y) * width + win.x0;
    const dst = y * ww;
    for (let x = 0; x < ww; x += 1) {
      const id = labels[dst + x]!;
      if (id === 0) continue;
      if (pre[src + x]! > 127) hasPrevious[id] = 1;
      if (painted[dst + x] === 1) paintedIn[id] = paintedIn[id]! + 1;
    }
  }
  let main = 0;
  for (let id = 1; id < areas.length; id += 1) {
    if (main === 0 || paintedIn[id]! > paintedIn[main]!) main = id;
  }
  const minArea = totalArea * MIN_COMPONENT_SHARE;
  for (let i = 0; i < size; i += 1) {
    const id = labels[i]!;
    if (id !== 0 && id !== main && hasPrevious[id] === 0 && areas[id]! < minArea) bin[i] = 0;
  }

  // 6. Fill pinholes, then 7. feather the edge.
  fillSmallHoles(bin, ww, wh, Math.max(64, Math.round(totalArea * 0.01)));
  writeFeathered(post, width, height, bin, win);
  return win;
}
