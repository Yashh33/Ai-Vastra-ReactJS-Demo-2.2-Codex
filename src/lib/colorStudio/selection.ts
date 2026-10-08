// Mask post-processing for ColorStudio. Selection itself comes from the backend
// (SAM 3 via /segment); this file only tidies the returned mask: drop stray
// islands, fill pinholes, feather the edge.
// The mask is a Uint8Array alpha map (0..255) at preview size. Everything here is
// plain typed-array maths with no DOM access, so it also runs inside the worker.

/** Pixel rectangle; x1/y1 are exclusive. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

// Islands smaller than this share of the selected area are dropped.
const MIN_COMPONENT_SHARE = 0.02;
// Enclosed gaps up to this share of the selected area (or 64px) are filled.
const MAX_HOLE_SHARE = 0.01;

type Components = { labels: Int32Array; areas: number[]; touchesBorder: boolean[] };

/** 4-connected labelling of all pixels equal to `target`. Label ids start at 1. */
function labelComponents(bin: Uint8Array, width: number, height: number, target: number): Components {
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
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
      const x = i % width;
      const y = (i - x) / width;
      area += 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;

      if (x > 0 && bin[i - 1] === target && labels[i - 1] === 0) {
        labels[i - 1] = id;
        stack[sp++] = i - 1;
      }
      if (x < width - 1 && bin[i + 1] === target && labels[i + 1] === 0) {
        labels[i + 1] = id;
        stack[sp++] = i + 1;
      }
      if (y > 0 && bin[i - width] === target && labels[i - width] === 0) {
        labels[i - width] = id;
        stack[sp++] = i - width;
      }
      if (y < height - 1 && bin[i + width] === target && labels[i + width] === 0) {
        labels[i + width] = id;
        stack[sp++] = i + width;
      }
    }

    areas.push(area);
    touchesBorder.push(border);
  }

  return { labels, areas, touchesBorder };
}

/** Removes islands below MIN_COMPONENT_SHARE of the selected area; the largest always stays. */
function dropSmallIslands(bin: Uint8Array, width: number, height: number, totalArea: number) {
  const { labels, areas } = labelComponents(bin, width, height, 1);
  let largest = 0;
  for (let id = 1; id < areas.length; id += 1) {
    if (largest === 0 || areas[id]! > areas[largest]!) largest = id;
  }
  const minArea = totalArea * MIN_COMPONENT_SHARE;
  for (let i = 0; i < bin.length; i += 1) {
    const id = labels[i]!;
    if (id !== 0 && id !== largest && areas[id]! < minArea) bin[i] = 0;
  }
}

/** Fills enclosed background regions no larger than maxArea. */
function fillSmallHoles(bin: Uint8Array, width: number, height: number, maxArea: number) {
  const { labels, areas, touchesBorder } = labelComponents(bin, width, height, 0);
  for (let i = 0; i < bin.length; i += 1) {
    const id = labels[i]!;
    if (id !== 0 && !touchesBorder[id] && areas[id]! <= maxArea) bin[i] = 1;
  }
}

function boxSum3(src: Uint8Array, tmp: Uint8Array, dst: Uint8Array, width: number, height: number) {
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = x > 0 ? x - 1 : x;
      const right = x < width - 1 ? x + 1 : x;
      tmp[row + x] = src[row + left]! + src[row + x]! + src[row + right]!;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const up = (y > 0 ? y - 1 : y) * width;
    const down = (y < height - 1 ? y + 1 : y) * width;
    for (let x = 0; x < width; x += 1) {
      dst[row + x] = tmp[up + x]! + tmp[row + x]! + tmp[down + x]!;
    }
  }
}

/**
 * Turns decoded mask-image pixels into a 0/255 alpha map. Works for a grey
 * (white = selected) mask as well as one that carries the selection in alpha.
 */
export function maskFromRgba(rgba: Uint8ClampedArray, width: number, height: number) {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    mask[i] = (rgba[p]! * rgba[p + 3]!) / 255 > 127 ? 255 : 0;
  }
  return mask;
}

/**
 * Cleans a mask in place: drops islands under 2% of the selected area, fills
 * small holes, then feathers the edge (two 3x3 box blurs, roughly 2-3px).
 * Returns the number of selected pixels before feathering (0 = nothing selected).
 */
export function cleanupMask(mask: Uint8Array, width: number, height: number) {
  const size = width * height;
  const bin = new Uint8Array(size);
  let totalArea = 0;
  for (let i = 0; i < size; i += 1) {
    if (mask[i]! > 127) {
      bin[i] = 1;
      totalArea += 1;
    }
  }
  if (totalArea === 0) {
    mask.fill(0);
    return 0;
  }

  dropSmallIslands(bin, width, height, totalArea);
  fillSmallHoles(bin, width, height, Math.max(64, Math.round(totalArea * MAX_HOLE_SHARE)));

  let kept = 0;
  for (let i = 0; i < size; i += 1) kept += bin[i]!;

  const tmp = new Uint8Array(size);
  const pass1 = new Uint8Array(size);
  boxSum3(bin, tmp, pass1, width, height);
  // Reuse `bin` as the second-pass output: sums reach 81 (9 x 9).
  boxSum3(pass1, tmp, bin, width, height);
  for (let i = 0; i < size; i += 1) {
    mask[i] = Math.round((bin[i]! * 255) / 81);
  }
  return kept;
}
