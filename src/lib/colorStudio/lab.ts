// sRGB <-> linear <-> CIE Lab (D65) primitives shared by selection and adjustment code.
// Kept free of DOM access so the selection worker can import it.

export const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

const LINEAR_TO_SRGB8_SIZE = 4096;
const LINEAR_TO_SRGB8 = (() => {
  const table = new Uint8Array(LINEAR_TO_SRGB8_SIZE + 1);
  for (let i = 0; i <= LINEAR_TO_SRGB8_SIZE; i += 1) {
    const c = i / LINEAR_TO_SRGB8_SIZE;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    table[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
  }
  return table;
})();

export function linearToSrgb8(value: number) {
  const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return LINEAR_TO_SRGB8[Math.round(clamped * LINEAR_TO_SRGB8_SIZE)]!;
}

export const WHITE_X = 0.95047;
export const WHITE_Z = 1.08883;

export function labF(t: number) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function labFInv(f: number) {
  return f > 0.206893 ? f * f * f : (f - 16 / 116) / 7.787;
}

/** Linear RGB (0..1, may exceed 1) -> Lab, written to out[o..o+2]. */
export function linearToLab(r: number, g: number, b: number, out: Float32Array | number[], o: number) {
  const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE_X);
  const fy = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE_Z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

/** Lab -> linear RGB (unclamped), written to out[o..o+2]. */
export function labToLinear(L: number, a: number, b: number, out: Float32Array | number[], o: number) {
  const fy = (L + 16) / 116;
  const x = WHITE_X * labFInv(fy + a / 500);
  const y = labFInv(fy);
  const z = WHITE_Z * labFInv(fy - b / 200);
  out[o] = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  out[o + 1] = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  out[o + 2] = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
}

export function srgb8ToLab(r: number, g: number, b: number, out: Float32Array | number[], o: number) {
  linearToLab(SRGB_TO_LINEAR[r]!, SRGB_TO_LINEAR[g]!, SRGB_TO_LINEAR[b]!, out, o);
}

export function labToSrgb8(L: number, a: number, b: number): [number, number, number] {
  const lin = [0, 0, 0];
  labToLinear(L, a, b, lin, 0);
  return [linearToSrgb8(lin[0]!), linearToSrgb8(lin[1]!), linearToSrgb8(lin[2]!)];
}

/** Whole RGBA buffer -> Float32 Lab triplets (L, a, b per pixel). */
export function rgbaToLab(rgba: Uint8ClampedArray, width: number, height: number) {
  const count = width * height;
  const lab = new Float32Array(count * 3);
  for (let i = 0, p = 0, q = 0; i < count; i += 1, p += 4, q += 3) {
    linearToLab(SRGB_TO_LINEAR[rgba[p]!]!, SRGB_TO_LINEAR[rgba[p + 1]!]!, SRGB_TO_LINEAR[rgba[p + 2]!]!, lab, q);
  }
  return lab;
}
