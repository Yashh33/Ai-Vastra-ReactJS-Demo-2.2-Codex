// Adjustment maths for ColorStudio plus the renderers that apply it:
// a WebGL fragment shader for live preview / export, and a CPU fallback.
// Both paths run the same pipeline:
//   sRGB -> linear -> channel gains (temperature, tint, exposure)
//        -> Lab -> chroma scale / hue-directed chroma add / lightness -> back to sRGB
// and blend the result over the source by mask alpha.
import {
  SRGB_TO_LINEAR,
  WHITE_X,
  WHITE_Z,
  labF,
  labFInv,
  labToSrgb8,
  linearToSrgb8,
  srgb8ToLab
} from "./lab";
import type { Rect } from "./selection";

/* ---------- parameters ---------- */

/** Slider positions, each -1..1 with 0 = original. */
export type Adjustments = {
  temperature: number;
  tint: number;
  exposure: number;
  saturation: number;
  shade: number;
};

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  saturation: 0,
  shade: 0
};

const TEMPERATURE_RANGE = 0.3; // R and B gain, +-30%
const TINT_RANGE = 0.2; // G gain, +-20%
const EXPOSURE_STOPS = 1;
const SATURATION_RANGE = 0.6;

/** Below this Lab chroma the measured colour has no usable hue. */
export const NEUTRAL_CHROMA = 6;

export type MaskStats = {
  /** Share of the image that is selected (0..1). */
  coverage: number;
  /** Mean Lab colour of the selection, ignoring the brightest 5% and near-white pixels. */
  L: number;
  a: number;
  b: number;
  chroma: number;
  /** Share of selected pixels that are blown out to near pure white. */
  blownFraction: number;
};

/** Unit vector in the Lab a/b plane; (0, 0) means "stay grey". */
export type ShadeHue = { a: number; b: number };

export type AdjustUniforms = {
  active: boolean;
  gain: [number, number, number];
  chromaScale: number;
  chromaAdd: [number, number];
  /** Moves lightness towards white by this fraction. */
  lightnessLift: number;
  lightnessScale: number;
};

export const IDENTITY_UNIFORMS: AdjustUniforms = {
  active: false,
  gain: [1, 1, 1],
  chromaScale: 1,
  chromaAdd: [0, 0],
  lightnessLift: 0,
  lightnessScale: 1
};

function clampUnit(value: number) {
  return Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));
}

export function isNeutralStats(stats: MaskStats | null) {
  return !stats || stats.chroma < NEUTRAL_CHROMA;
}

/** Hue the Shade slider works along: the measured one, or the user's pick when neutral. */
export function resolveShadeHue(stats: MaskStats | null, pick: ShadeHue | null): ShadeHue | null {
  if (stats && stats.chroma >= NEUTRAL_CHROMA) {
    return { a: stats.a / stats.chroma, b: stats.b / stats.chroma };
  }
  return pick;
}

export function hueFromSrgb(r: number, g: number, b: number): ShadeHue {
  const lab = [0, 0, 0];
  srgb8ToLab(r, g, b, lab, 0);
  const chroma = Math.hypot(lab[1]!, lab[2]!);
  if (chroma < 1) return { a: 0, b: 0 };
  return { a: lab[1]! / chroma, b: lab[2]! / chroma };
}

/** CSS colours for the two ends of the Shade slider track. */
export function shadeTrackColors(stats: MaskStats | null, pick: ShadeHue | null): [string, string] | null {
  const hue = resolveShadeHue(stats, pick);
  if (!hue) return null;
  const css = (L: number, chroma: number) => {
    const [r, g, b] = labToSrgb8(L, hue.a * chroma, hue.b * chroma);
    return `rgb(${r}, ${g}, ${b})`;
  };
  if (hue.a === 0 && hue.b === 0) return [css(94, 0), css(52, 0)];
  return [css(94, 7), css(58, 48)];
}

/** Turns slider positions into the numbers the shader / CPU loop consume. */
export function compileAdjustments(
  adjustments: Adjustments,
  stats: MaskStats | null,
  pick: ShadeHue | null
): AdjustUniforms {
  const temperature = clampUnit(adjustments.temperature);
  const tint = clampUnit(adjustments.tint);
  const exposure = clampUnit(adjustments.exposure);
  const saturation = clampUnit(adjustments.saturation);
  const shade = clampUnit(adjustments.shade);

  // Warmer = more red, less blue. Pinker = less green, a little more red and blue.
  let gainR = (1 + TEMPERATURE_RANGE * temperature) * (1 + TINT_RANGE * 0.5 * tint);
  let gainG = 1 - TINT_RANGE * tint;
  let gainB = (1 - TEMPERATURE_RANGE * temperature) * (1 + TINT_RANGE * 0.5 * tint);
  // Renormalise so a neutral grey keeps its brightness; only the colour balance moves.
  const balance = 0.2126729 * gainR + 0.7151522 * gainG + 0.072175 * gainB;
  const exposureGain = Math.pow(2, EXPOSURE_STOPS * exposure) / balance;
  gainR *= exposureGain;
  gainG *= exposureGain;
  gainB *= exposureGain;

  let chromaScale = 1 + SATURATION_RANGE * saturation;
  let addA = 0;
  let addB = 0;
  let lightnessLift = 0;
  let lightnessScale = 1;

  const hue = shade !== 0 ? resolveShadeHue(stats, pick) : null;
  if (hue) {
    const strength = Math.abs(shade);
    const measured = !isNeutralStats(stats);
    if (hue.a === 0 && hue.b === 0) {
      // Grey direction: drain any cast, then go paler or deeper.
      chromaScale *= 1 - 0.8 * strength;
      if (shade > 0) lightnessScale = 1 - 0.25 * strength;
      else lightnessLift = 0.4 * strength;
    } else if (measured) {
      if (shade > 0) {
        // Stronger: multiply existing chroma and push further along the measured hue.
        chromaScale *= 1 + 1.2 * strength;
        addA = hue.a * 12 * strength;
        addB = hue.b * 12 * strength;
        lightnessScale = 1 - 0.08 * strength;
      } else {
        chromaScale *= 1 - 0.85 * strength;
        lightnessLift = 0.3 * strength;
      }
    } else if (shade > 0) {
      // Near-neutral fabric: there is no chroma to multiply, so add it along the picked hue.
      addA = hue.a * 30 * strength;
      addB = hue.b * 30 * strength;
      lightnessScale = 1 - 0.06 * strength;
    } else {
      addA = hue.a * 7 * strength;
      addB = hue.b * 7 * strength;
      lightnessLift = 0.35 * strength;
    }
  }

  const active =
    Math.abs(gainR - 1) > 1e-5 ||
    Math.abs(gainG - 1) > 1e-5 ||
    Math.abs(gainB - 1) > 1e-5 ||
    Math.abs(chromaScale - 1) > 1e-5 ||
    addA !== 0 ||
    addB !== 0 ||
    lightnessLift !== 0 ||
    lightnessScale !== 1;

  return {
    active,
    gain: [gainR, gainG, gainB],
    chromaScale,
    chromaAdd: [addA, addB],
    lightnessLift,
    lightnessScale
  };
}

/* ---------- measurement ---------- */

const MEASURE_SAMPLES = 60000;
const NEAR_WHITE = 240;
const BLOWN_OUT = 250;

/**
 * Average colour of the selected area. `mask` null means the whole photo.
 * Works on a regular sub-sample, so it is cheap enough to run after every edit.
 */
export function measureMaskedColor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array | null
): MaskStats {
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / MEASURE_SAMPLES)));
  const histogram = new Uint32Array(256);
  let visited = 0;
  let selected = 0;
  let blown = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      visited += 1;
      const i = y * width + x;
      if (mask && mask[i]! <= 127) continue;
      selected += 1;
      const p = i * 4;
      const r = rgba[p]!;
      const g = rgba[p + 1]!;
      const b = rgba[p + 2]!;
      if (Math.min(r, g, b) >= BLOWN_OUT) blown += 1;
      const luma = (r * 54 + g * 183 + b * 19) >> 8;
      histogram[luma] = histogram[luma]! + 1;
    }
  }

  const empty: MaskStats = { coverage: 0, L: 0, a: 0, b: 0, chroma: 0, blownFraction: 0 };
  if (selected === 0) return empty;

  // Luma level above which the brightest 5% of the selection sits.
  let cutoff = 255;
  let above = 0;
  const limit = selected * 0.05;
  while (cutoff > 0 && above + histogram[cutoff]! <= limit) {
    above += histogram[cutoff]!;
    cutoff -= 1;
  }

  const lab = [0, 0, 0];
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let used = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x;
      if (mask && mask[i]! <= 127) continue;
      const p = i * 4;
      const r = rgba[p]!;
      const g = rgba[p + 1]!;
      const b = rgba[p + 2]!;
      if (Math.min(r, g, b) >= NEAR_WHITE) continue;
      if ((r * 54 + g * 183 + b * 19) >> 8 > cutoff) continue;
      srgb8ToLab(r, g, b, lab, 0);
      sumL += lab[0]!;
      sumA += lab[1]!;
      sumB += lab[2]!;
      used += 1;
    }
  }

  const stats: MaskStats = {
    coverage: selected / visited,
    L: 100,
    a: 0,
    b: 0,
    chroma: 0,
    blownFraction: blown / selected
  };
  if (used > 0) {
    stats.L = sumL / used;
    stats.a = sumA / used;
    stats.b = sumB / used;
    stats.chroma = Math.hypot(stats.a, stats.b);
  }
  return stats;
}

/* ---------- shared view description ---------- */

export type RenderView = {
  /** Treat the whole image as selected (the mask texture is ignored). */
  whole: boolean;
  /** 0..1 strength of the gold selection overlay. */
  overlay: number;
  /** Show the untouched source (before / after compare). */
  original: boolean;
  /**
   * Part of the mask this image covers, in mask UV space: [offsetX, offsetY, scaleX, scaleY].
   * Defaults to the full mask. Used when exporting the full-size image in tiles.
   */
  maskRect?: [number, number, number, number];
};

const OVERLAY_RGB: [number, number, number] = [201, 168, 76]; // --mt-gold
const OVERLAY_ALPHA = 0.45;

export interface AdjustRenderer {
  readonly kind: "webgl" | "cpu";
  setImage(source: HTMLCanvasElement): void;
  setMask(mask: Uint8Array, width: number, height: number): void;
  /** Re-uploads only `rect` of a mask previously given to setMask. */
  updateMask(mask: Uint8Array, rect: Rect): void;
  render(uniforms: AdjustUniforms, view: RenderView): void;
  dispose(): void;
}

/* ---------- WebGL ---------- */

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  // Texture row 0 is the top of the image, so no UNPACK_FLIP_Y is needed anywhere.
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_image;
uniform sampler2D u_mask;
uniform vec4 u_mask_rect;
uniform float u_whole;
uniform float u_active;
uniform float u_overlay;
uniform vec3 u_overlay_color;
uniform vec3 u_gain;
uniform float u_chroma_scale;
uniform vec2 u_chroma_add;
uniform float u_l_lift;
uniform float u_l_scale;

varying vec2 v_uv;

vec3 toLinear(vec3 c) {
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), c));
}

vec3 toSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

vec3 labF(vec3 t) {
  vec3 low = 7.787 * t + 16.0 / 116.0;
  vec3 high = pow(max(t, vec3(0.000001)), vec3(1.0 / 3.0));
  return mix(low, high, step(vec3(0.008856), t));
}

vec3 labFInv(vec3 f) {
  vec3 low = (f - 16.0 / 116.0) / 7.787;
  vec3 high = f * f * f;
  return mix(low, high, step(vec3(0.206893), f));
}

void main() {
  vec3 src = texture2D(u_image, v_uv).rgb;
  float mask = max(u_whole, texture2D(u_mask, u_mask_rect.xy + v_uv * u_mask_rect.zw).r);
  vec3 color = src;

  if (u_active > 0.5) {
    vec3 lin = max(toLinear(src) * u_gain, vec3(0.0));

    vec3 xyz = vec3(
      dot(lin, vec3(0.4124564, 0.3575761, 0.1804375)) / ${WHITE_X},
      dot(lin, vec3(0.2126729, 0.7151522, 0.0721750)),
      dot(lin, vec3(0.0193339, 0.1191920, 0.9503041)) / ${WHITE_Z}
    );
    vec3 f = labF(xyz);
    float L = clamp(116.0 * f.y - 16.0, 0.0, 100.0);
    vec2 ab = vec2(500.0 * (f.x - f.y), 200.0 * (f.y - f.z));

    // Added chroma fades out in deep shadow, where it would only look like noise.
    ab = ab * u_chroma_scale + u_chroma_add * smoothstep(0.0, 30.0, L);
    L = L * u_l_scale;
    L = L + u_l_lift * (100.0 - L);

    float fy = (L + 16.0) / 116.0;
    vec3 back = labFInv(vec3(fy + ab.x / 500.0, fy, fy - ab.y / 200.0)) * vec3(${WHITE_X}, 1.0, ${WHITE_Z});
    vec3 outLin = vec3(
      dot(back, vec3(3.2404542, -1.5371385, -0.4985314)),
      dot(back, vec3(-0.9692660, 1.8760108, 0.0415560)),
      dot(back, vec3(0.0556434, -0.2040259, 1.0572252))
    );
    color = mix(src, toSrgb(clamp(outLin, 0.0, 1.0)), mask);
  }

  color = mix(color, u_overlay_color, u_overlay * mask);
  gl_FragColor = vec4(color, 1.0);
}
`;

const UNIFORM_NAMES = [
  "u_image",
  "u_mask",
  "u_mask_rect",
  "u_whole",
  "u_active",
  "u_overlay",
  "u_overlay_color",
  "u_gain",
  "u_chroma_scale",
  "u_chroma_add",
  "u_l_lift",
  "u_l_scale"
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) || "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(error);
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Failed to create program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program) || "Unknown program link error";
    gl.deleteProgram(program);
    throw new Error(error);
  }
  return program;
}

function createTexture(gl: WebGLRenderingContext, filter: number) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Failed to create WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return texture;
}

export function isWebGLAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

export class WebGLAdjustRenderer implements AdjustRenderer {
  readonly kind = "webgl" as const;
  readonly maxTextureSize: number;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly imageTexture: WebGLTexture;
  private readonly maskTexture: WebGLTexture;
  private readonly positionBuffer: WebGLBuffer;
  private readonly positionLocation: number;
  private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
  private maskWidth = 0;
  private scratch = new Uint8Array(0);
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const options: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false
    };
    const gl = (canvas.getContext("webgl", options) ??
      canvas.getContext("experimental-webgl", options)) as WebGLRenderingContext | null;
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.program = linkProgram(gl);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Failed to create WebGL buffer");
    this.positionBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.positionLocation = gl.getAttribLocation(this.program, "a_position");
    if (this.positionLocation < 0) throw new Error("Missing shader attribute: a_position");

    const uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(this.program, name);
    this.uniforms = uniforms;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.imageTexture = createTexture(gl, gl.LINEAR);
    this.maskTexture = createTexture(gl, gl.LINEAR);
    // A 1x1 empty mask so the sampler is always complete.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  }

  get contextLost() {
    return this.gl.isContextLost();
  }

  setImage(source: HTMLCanvasElement) {
    const gl = this.gl;
    if (this.canvas.width !== source.width) this.canvas.width = source.width;
    if (this.canvas.height !== source.height) this.canvas.height = source.height;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
  }

  setMask(mask: Uint8Array, width: number, height: number) {
    const gl = this.gl;
    this.maskWidth = width;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, mask);
  }

  updateMask(mask: Uint8Array, rect: Rect) {
    const gl = this.gl;
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    if (width <= 0 || height <= 0 || this.maskWidth === 0) return;

    // texSubImage2D needs the rows of the changed box packed together.
    if (this.scratch.length < width * height) this.scratch = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const start = (rect.y0 + y) * this.maskWidth + rect.x0;
      this.scratch.set(mask.subarray(start, start + width), y * width);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      rect.x0,
      rect.y0,
      width,
      height,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      this.scratch.subarray(0, width * height)
    );
  }

  render(uniforms: AdjustUniforms, view: RenderView) {
    if (this.disposed) return;
    const gl = this.gl;
    const u = this.uniforms;
    const maskRect = view.maskRect ?? [0, 0, 1, 1];

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.uniform1i(u.u_image, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(u.u_mask, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform4f(u.u_mask_rect, maskRect[0], maskRect[1], maskRect[2], maskRect[3]);
    gl.uniform1f(u.u_whole, view.whole ? 1 : 0);
    gl.uniform1f(u.u_active, uniforms.active && !view.original ? 1 : 0);
    gl.uniform1f(u.u_overlay, view.original ? 0 : view.overlay * OVERLAY_ALPHA);
    gl.uniform3f(u.u_overlay_color, OVERLAY_RGB[0] / 255, OVERLAY_RGB[1] / 255, OVERLAY_RGB[2] / 255);
    gl.uniform3f(u.u_gain, uniforms.gain[0], uniforms.gain[1], uniforms.gain[2]);
    gl.uniform1f(u.u_chroma_scale, uniforms.chromaScale);
    gl.uniform2f(u.u_chroma_add, uniforms.chromaAdd[0], uniforms.chromaAdd[1]);
    gl.uniform1f(u.u_l_lift, uniforms.lightnessLift);
    gl.uniform1f(u.u_l_scale, uniforms.lightnessScale);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** `releaseContext` also drops the GL context; use it for throwaway canvases only. */
  dispose(releaseContext = false) {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.maskTexture);
    gl.deleteProgram(this.program);
    if (releaseContext) gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/* ---------- CPU ---------- */

type MaskSource = { data: Uint8Array; width: number; height: number };

/**
 * Same pipeline as the fragment shader, on an RGBA buffer. `mask` null = whole image.
 * `src` and `dst` may be the same buffer.
 */
export function applyAdjustCPU(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  uniforms: AdjustUniforms,
  view: RenderView,
  mask: MaskSource | null
) {
  const active = uniforms.active && !view.original;
  const overlay = view.original ? 0 : view.overlay * OVERLAY_ALPHA;
  const whole = view.whole || !mask;
  const [gainR, gainG, gainB] = uniforms.gain;
  const [addA, addB] = uniforms.chromaAdd;
  const { chromaScale, lightnessLift, lightnessScale } = uniforms;
  const rect = view.maskRect ?? [0, 0, 1, 1];
  const direct = Boolean(mask) && !view.maskRect && mask!.width === width && mask!.height === height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const r8 = src[p]!;
      const g8 = src[p + 1]!;
      const b8 = src[p + 2]!;

      let alpha = 1;
      if (!whole && mask) {
        if (direct) {
          alpha = mask.data[y * width + x]! / 255;
        } else {
          // Bilinear sample, matching the GPU's LINEAR filter on the mask texture.
          const mx = (rect[0] + ((x + 0.5) / width) * rect[2]) * mask.width - 0.5;
          const my = (rect[1] + ((y + 0.5) / height) * rect[3]) * mask.height - 0.5;
          const fx0 = Math.floor(mx);
          const fy0 = Math.floor(my);
          const tx = mx - fx0;
          const ty = my - fy0;
          const xa = Math.min(mask.width - 1, Math.max(0, fx0));
          const xb = Math.min(mask.width - 1, Math.max(0, fx0 + 1));
          const ya = Math.min(mask.height - 1, Math.max(0, fy0)) * mask.width;
          const yb = Math.min(mask.height - 1, Math.max(0, fy0 + 1)) * mask.width;
          const top = mask.data[ya + xa]! * (1 - tx) + mask.data[ya + xb]! * tx;
          const bottom = mask.data[yb + xa]! * (1 - tx) + mask.data[yb + xb]! * tx;
          alpha = (top * (1 - ty) + bottom * ty) / 255;
        }
      }

      let outR = r8;
      let outG = g8;
      let outB = b8;

      if (active && alpha > 0) {
        const lr = SRGB_TO_LINEAR[r8]! * gainR;
        const lg = SRGB_TO_LINEAR[g8]! * gainG;
        const lb = SRGB_TO_LINEAR[b8]! * gainB;

        const fx = labF((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE_X);
        const fyIn = labF(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
        const fz = labF((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / WHITE_Z);
        let L = Math.min(100, Math.max(0, 116 * fyIn - 16));
        let a = 500 * (fx - fyIn);
        let b = 200 * (fyIn - fz);

        const t = Math.min(1, L / 30);
        const addWeight = t * t * (3 - 2 * t);
        a = a * chromaScale + addA * addWeight;
        b = b * chromaScale + addB * addWeight;
        L *= lightnessScale;
        L += lightnessLift * (100 - L);

        const fy = (L + 16) / 116;
        const X = WHITE_X * labFInv(fy + a / 500);
        const Y = labFInv(fy);
        const Z = WHITE_Z * labFInv(fy - b / 200);
        const adjR = linearToSrgb8(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
        const adjG = linearToSrgb8(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z);
        const adjB = linearToSrgb8(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);

        outR = r8 + (adjR - r8) * alpha;
        outG = g8 + (adjG - g8) * alpha;
        outB = b8 + (adjB - b8) * alpha;
      }

      if (overlay > 0 && alpha > 0) {
        const mix = overlay * alpha;
        outR += (OVERLAY_RGB[0] - outR) * mix;
        outG += (OVERLAY_RGB[1] - outG) * mix;
        outB += (OVERLAY_RGB[2] - outB) * mix;
      }

      dst[p] = outR;
      dst[p + 1] = outG;
      dst[p + 2] = outB;
      dst[p + 3] = 255;
    }
  }
}

/** Preview renderer used only when WebGL cannot be created. */
export class CPUAdjustRenderer implements AdjustRenderer {
  readonly kind = "cpu" as const;
  private readonly ctx: CanvasRenderingContext2D;
  private source: ImageData | null = null;
  private output: ImageData | null = null;
  private mask: MaskSource | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");
    this.ctx = ctx;
  }

  setImage(source: HTMLCanvasElement) {
    const sourceCtx = source.getContext("2d");
    if (!sourceCtx) throw new Error("Canvas context unavailable");
    this.canvas.width = source.width;
    this.canvas.height = source.height;
    this.source = sourceCtx.getImageData(0, 0, source.width, source.height);
    this.output = this.ctx.createImageData(source.width, source.height);
  }

  setMask(mask: Uint8Array, width: number, height: number) {
    // Held by reference, so edits show up on the next render.
    this.mask = { data: mask, width, height };
  }

  updateMask() {
    // Nothing to upload.
  }

  render(uniforms: AdjustUniforms, view: RenderView) {
    if (!this.source || !this.output) return;
    applyAdjustCPU(
      this.source.data,
      this.output.data,
      this.source.width,
      this.source.height,
      uniforms,
      view,
      this.mask
    );
    this.ctx.putImageData(this.output, 0, 0);
  }

  dispose() {
    this.source = null;
    this.output = null;
    this.mask = null;
  }
}

export function createPreviewRenderer(canvas: HTMLCanvasElement): AdjustRenderer {
  try {
    return new WebGLAdjustRenderer(canvas);
  } catch {
    return new CPUAdjustRenderer(canvas);
  }
}

/* ---------- full-resolution export ---------- */

/** Stays under the smallest common canvas area limit (iOS Safari: 16.7M pixels). */
export const MAX_EXPORT_PIXELS = 16_000_000;
const EXPORT_TILE = 2048;

export type ExportOptions = {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Preview-size mask; null = whole photo. It is upscaled bilinearly, so the feather survives. */
  mask: MaskSource | null;
  uniforms: AdjustUniforms;
  quality?: number;
};

function nextTask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Applies the adjustments to the full-size image and encodes a JPEG.
 * Renders tile by tile through WebGL; falls back to the CPU loop if WebGL fails.
 */
export async function exportAdjusted(options: ExportOptions): Promise<Blob> {
  const scale = Math.min(1, Math.sqrt(MAX_EXPORT_PIXELS / (options.width * options.height)));
  const width = Math.max(1, Math.round(options.width * scale));
  const height = Math.max(1, Math.round(options.height * scale));

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");

  const drawSource = () => {
    // JPEG has no alpha: flatten transparent images onto white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(options.image, 0, 0, width, height);
  };
  drawSource();

  const view: RenderView = { whole: !options.mask, overlay: 0, original: false };
  const tileRects: Rect[] = [];

  if (options.uniforms.active) {
    let tileSize = EXPORT_TILE;
    let renderer: WebGLAdjustRenderer | null = null;
    const glCanvas = document.createElement("canvas");
    const tile = document.createElement("canvas");
    const tileCtx = tile.getContext("2d");
    if (!tileCtx) throw new Error("Canvas context unavailable");

    try {
      renderer = new WebGLAdjustRenderer(glCanvas);
      tileSize = Math.min(EXPORT_TILE, renderer.maxTextureSize);
      if (options.mask) renderer.setMask(options.mask.data, options.mask.width, options.mask.height);
    } catch {
      renderer = null;
    }

    for (let y = 0; y < height; y += tileSize) {
      for (let x = 0; x < width; x += tileSize) {
        tileRects.push({ x0: x, y0: y, x1: Math.min(width, x + tileSize), y1: Math.min(height, y + tileSize) });
      }
    }

    const maskRectFor = (rect: Rect): [number, number, number, number] => [
      rect.x0 / width,
      rect.y0 / height,
      (rect.x1 - rect.x0) / width,
      (rect.y1 - rect.y0) / height
    ];

    if (renderer) {
      try {
        for (const rect of tileRects) {
          const tw = rect.x1 - rect.x0;
          const th = rect.y1 - rect.y0;
          tile.width = tw;
          tile.height = th;
          tileCtx.drawImage(out, rect.x0, rect.y0, tw, th, 0, 0, tw, th);
          renderer.setImage(tile);
          renderer.render(options.uniforms, { ...view, maskRect: maskRectFor(rect) });
          if (renderer.contextLost) throw new Error("WebGL context lost during export");
          // Copy out in the same task as the draw, before the browser may clear the buffer.
          ctx.drawImage(glCanvas, rect.x0, rect.y0);
          await nextTask();
        }
      } catch (err) {
        console.warn("ColorStudio: WebGL export failed, using CPU", err);
        renderer.dispose(true);
        renderer = null;
        drawSource();
      }
      renderer?.dispose(true);
    }

    if (!renderer) {
      for (const rect of tileRects) {
        const tw = rect.x1 - rect.x0;
        const th = rect.y1 - rect.y0;
        const pixels = ctx.getImageData(rect.x0, rect.y0, tw, th);
        applyAdjustCPU(
          pixels.data,
          pixels.data,
          tw,
          th,
          options.uniforms,
          { ...view, maskRect: maskRectFor(rect) },
          options.mask
        );
        ctx.putImageData(pixels, rect.x0, rect.y0);
        await nextTask();
      }
    }
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    out.toBlob((result) => resolve(result), "image/jpeg", options.quality ?? 0.9);
  });
  if (!blob) throw new Error("Could not encode the image");
  return blob;
}
