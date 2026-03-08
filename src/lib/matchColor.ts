export type SwatchAdjustment = {
  hueShiftDeg: number;
  satDeltaPct: number;
  lightDeltaPct: number;
};

const HUE_TOL = 18 / 360;
const SAT_TOL = 0.28;
const LIGHT_TOL = 0.28;
const FEATHER = 0.08;

type RGB = { r: number; g: number; b: number };
export type HSL01 = { h: number; s: number; l: number };

export function emptySwatchAdjustment(): SwatchAdjustment {
  return {
    hueShiftDeg: 0,
    satDeltaPct: 0,
    lightDeltaPct: 0
  };
}

export function isZeroAdjustment(value?: SwatchAdjustment | null) {
  if (!value) return true;
  return value.hueShiftDeg === 0 && value.satDeltaPct === 0 && value.lightDeltaPct === 0;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mod(value: number, base: number) {
  return ((value % base) + base) % base;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const denom = Math.max(edge1 - edge0, 1e-8);
  const t = clamp((value - edge0) / denom, 0, 1);
  return t * t * (3 - 2 * t);
}

export function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw.startsWith("#")) return null;
  const hex = raw.slice(1);

  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [r, g, b] = hex.split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex}`.toUpperCase();
  }

  if (/^[0-9a-fA-F]{8}$/.test(hex)) {
    return `#${hex.slice(2)}`.toUpperCase();
  }

  return null;
}

export function hexToRgb(hex: string): RGB | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const raw = normalized.slice(1);
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16)
  };
}

function rgb01ToHsl(rgb01: RGB): HSL01 {
  const r = clamp(rgb01.r, 0, 1);
  const g = clamp(rgb01.g, 0, 1);
  const b = clamp(rgb01.b, 0, 1);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta > 1e-8) {
    s = delta / Math.max(1 - Math.abs(2 * l - 1), 1e-8);
    if (max === r) h = mod((g - b) / delta, 6) / 6;
    else if (max === g) h = ((b - r) / delta + 2) / 6;
    else h = ((r - g) / delta + 4) / 6;
  }

  return {
    h: mod(h, 1),
    s: clamp(s, 0, 1),
    l: clamp(l, 0, 1)
  };
}

export function hexToHsl01(hex: string): HSL01 | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgb01ToHsl({
    r: rgb.r / 255,
    g: rgb.g / 255,
    b: rgb.b / 255
  });
}

function hslToRgb01(hsl: HSL01): RGB {
  const h = mod(hsl.h, 1);
  const s = clamp(hsl.s, 0, 1);
  const l = clamp(hsl.l, 0, 1);

  if (s <= 1e-8) {
    return { r: l, g: l, b: l };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const hue2rgb = (t: number) => {
    const tt = mod(t, 1);
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  return {
    r: clamp(hue2rgb(h + 1 / 3), 0, 1),
    g: clamp(hue2rgb(h), 0, 1),
    b: clamp(hue2rgb(h - 1 / 3), 0, 1)
  };
}

function rgb255ToHex(rgb: RGB) {
  const to2 = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`.toUpperCase();
}

function rgbDistance(a: RGB, b: RGB) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function uniqueSwatches(candidates: RGB[], maxSwatches: number) {
  const output: RGB[] = [];
  for (const rgb of candidates) {
    const duplicate = output.some((existing) => rgbDistance(existing, rgb) < 36);
    if (duplicate) continue;
    output.push(rgb);
    if (output.length >= maxSwatches) break;
  }
  return output;
}

export function extractProminentSwatches(
  imageData: ImageData,
  maxSwatches = 8
): string[] {
  const counts = new Map<number, number>();
  const data = imageData.data;
  const sampleStride = 4; // sample every 4th pixel

  for (let i = 0; i < data.length; i += 4 * sampleStride) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 0;
    if (a < 220) continue;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const topBuckets = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([key]) => {
      const r = ((key >> 8) & 0x0f) * 16 + 8;
      const g = ((key >> 4) & 0x0f) * 16 + 8;
      const b = (key & 0x0f) * 16 + 8;
      return { r, g, b };
    });

  const swatches = uniqueSwatches(topBuckets, maxSwatches).map(rgb255ToHex);
  return swatches;
}

export function resizeImageToCanvas(
  image: HTMLImageElement,
  maxDimension = 680
): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas context unavailable");
  }
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

export function applyLivePreviewAdjustment(
  source: ImageData,
  targetHex: string | null,
  adjustment: SwatchAdjustment | null
) {
  const targetRgb = targetHex ? hexToRgb(targetHex) : null;
  if (!targetRgb || isZeroAdjustment(adjustment)) {
    return new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  }

  const targetHsl = rgb01ToHsl({
    r: targetRgb.r / 255,
    g: targetRgb.g / 255,
    b: targetRgb.b / 255
  });

  const hueShift = (adjustment?.hueShiftDeg ?? 0) / 360;
  const satDelta = (adjustment?.satDeltaPct ?? 0) / 100;
  const lightDelta = (adjustment?.lightDeltaPct ?? 0) / 100;

  const src = source.data;
  const out = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    const r255 = src[i] ?? 0;
    const g255 = src[i + 1] ?? 0;
    const b255 = src[i + 2] ?? 0;
    const a255 = src[i + 3] ?? 0;

    const r = r255 / 255;
    const g = g255 / 255;
    const b = b255 / 255;

    const hsl = rgb01ToHsl({ r, g, b });

    const hueDiff = Math.abs(mod(hsl.h - targetHsl.h + 0.5, 1) - 0.5);
    const satDiff = Math.abs(hsl.s - targetHsl.s);
    const lightDiff = Math.abs(hsl.l - targetHsl.l);

    const hMask = 1 - smoothstep(HUE_TOL, HUE_TOL + FEATHER, hueDiff);
    const sMask = 1 - smoothstep(SAT_TOL, SAT_TOL + FEATHER, satDiff);
    const lMask = 1 - smoothstep(LIGHT_TOL, LIGHT_TOL + FEATHER, lightDiff);
    const mask = clamp(hMask * sMask * lMask, 0, 1);

    const shiftedHsl: HSL01 = {
      h: mod(hsl.h + hueShift * mask, 1),
      s: clamp(hsl.s + satDelta * mask, 0, 1),
      l: clamp(hsl.l + lightDelta * mask, 0, 1)
    };
    const shiftedRgb = hslToRgb01(shiftedHsl);

    const outR = clamp(r * (1 - mask) + shiftedRgb.r * mask, 0, 1);
    const outG = clamp(g * (1 - mask) + shiftedRgb.g * mask, 0, 1);
    const outB = clamp(b * (1 - mask) + shiftedRgb.b * mask, 0, 1);

    out[i] = Math.round(outR * 255);
    out[i + 1] = Math.round(outG * 255);
    out[i + 2] = Math.round(outB * 255);
    out[i + 3] = a255;
  }

  return new ImageData(out, source.width, source.height);
}
