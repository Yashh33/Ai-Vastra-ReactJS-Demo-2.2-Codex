import type { HSL01 } from "./matchColor";

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;

uniform sampler2D u_image;
uniform vec3 u_target_hsl;
uniform float u_hue_shift;
uniform float u_sat_delta;
uniform float u_light_delta;
uniform float u_hue_tol;
uniform float u_sat_tol;
uniform float u_light_tol;
uniform float u_feather;

varying vec2 v_uv;

float hueDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

vec3 rgb2hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float delta = maxC - minC;

  float h = 0.0;
  float s = 0.0;
  float l = (maxC + minC) * 0.5;

  if (delta > 0.00001) {
    if (maxC == c.r) {
      h = mod(((c.g - c.b) / delta), 6.0);
    } else if (maxC == c.g) {
      h = ((c.b - c.r) / delta) + 2.0;
    } else {
      h = ((c.r - c.g) / delta) + 4.0;
    }
    h = h / 6.0;
    if (h < 0.0) {
      h += 1.0;
    }

    s = delta / max(1.0 - abs(2.0 * l - 1.0), 0.00001);
  }

  return vec3(h, clamp(s, 0.0, 1.0), clamp(l, 0.0, 1.0));
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x;
  float s = clamp(hsl.y, 0.0, 1.0);
  float l = clamp(hsl.z, 0.0, 1.0);

  if (s <= 0.00001) {
    return vec3(l, l, l);
  }

  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;

  return vec3(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0)
  );
}

void main() {
  vec4 src = texture2D(u_image, v_uv);
  vec3 srcRgb = src.rgb;
  vec3 hsl = rgb2hsl(srcRgb);

  float hueDiff = hueDistance(hsl.x, u_target_hsl.x);
  float satDiff = abs(hsl.y - u_target_hsl.y);
  float lightDiff = abs(hsl.z - u_target_hsl.z);

  float hMask = 1.0 - smoothstep(u_hue_tol, u_hue_tol + u_feather, hueDiff);
  float sMask = 1.0 - smoothstep(u_sat_tol, u_sat_tol + u_feather, satDiff);
  float lMask = 1.0 - smoothstep(u_light_tol, u_light_tol + u_feather, lightDiff);
  float mask = clamp(hMask * sMask * lMask, 0.0, 1.0);

  vec3 shifted = hsl;
  shifted.x = fract(shifted.x + u_hue_shift * mask + 1.0);
  shifted.y = clamp(shifted.y + u_sat_delta * mask, 0.0, 1.0);
  shifted.z = clamp(shifted.z + u_light_delta * mask, 0.0, 1.0);

  vec3 outRgb = mix(srcRgb, hsl2rgb(shifted), mask);
  gl_FragColor = vec4(outRgb, src.a);
}
`;

const DEFAULT_TOLERANCE = {
  hueTol: 18 / 360,
  satTol: 0.28,
  lightTol: 0.28,
  feather: 0.08
};

type UniformLocations = {
  image: WebGLUniformLocation;
  targetHsl: WebGLUniformLocation;
  hueShift: WebGLUniformLocation;
  satDelta: WebGLUniformLocation;
  lightDelta: WebGLUniformLocation;
  hueTol: WebGLUniformLocation;
  satTol: WebGLUniformLocation;
  lightTol: WebGLUniformLocation;
  feather: WebGLUniformLocation;
};

export type MatchColorDrawOptions = {
  targetHsl: HSL01;
  hueShift: number;
  satDelta: number;
  lightDelta: number;
  hueTol?: number;
  satTol?: number;
  lightTol?: number;
  feather?: number;
};

function requireContext(
  canvas: HTMLCanvasElement
): WebGLRenderingContext {
  const gl =
    canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false
    }) ??
    canvas.getContext("experimental-webgl", {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false
    });

  if (!gl) {
    throw new Error("WebGL is not available");
  }

  return gl as WebGLRenderingContext;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) || "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(error);
  }

  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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

function getUniform(gl: WebGLRenderingContext, program: WebGLProgram, name: string) {
  const uniform = gl.getUniformLocation(program, name);
  if (!uniform) {
    throw new Error(`Missing shader uniform: ${name}`);
  }
  return uniform;
}

export class MatchColorWebGLRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly positionBuffer: WebGLBuffer;
  private readonly uniforms: UniformLocations;
  private readonly positionLocation: number;
  private sourceWidth = 1;
  private sourceHeight = 1;
  private outputScale = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = requireContext(canvas);
    this.program = linkProgram(this.gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);

    const texture = this.gl.createTexture();
    const buffer = this.gl.createBuffer();
    if (!texture || !buffer) {
      throw new Error("Failed to create WebGL resources");
    }
    this.texture = texture;
    this.positionBuffer = buffer;

    this.positionLocation = this.gl.getAttribLocation(this.program, "a_position");
    if (this.positionLocation < 0) {
      throw new Error("Missing shader attribute: a_position");
    }

    this.uniforms = {
      image: getUniform(this.gl, this.program, "u_image"),
      targetHsl: getUniform(this.gl, this.program, "u_target_hsl"),
      hueShift: getUniform(this.gl, this.program, "u_hue_shift"),
      satDelta: getUniform(this.gl, this.program, "u_sat_delta"),
      lightDelta: getUniform(this.gl, this.program, "u_light_delta"),
      hueTol: getUniform(this.gl, this.program, "u_hue_tol"),
      satTol: getUniform(this.gl, this.program, "u_sat_tol"),
      lightTol: getUniform(this.gl, this.program, "u_light_tol"),
      feather: getUniform(this.gl, this.program, "u_feather")
    };

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1
      ]),
      this.gl.STATIC_DRAW
    );

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
  }

  setSource(source: TexImageSource, width: number, height: number) {
    this.ensureActive();

    this.sourceWidth = Math.max(1, Math.round(width));
    this.sourceHeight = Math.max(1, Math.round(height));

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, 1);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      source
    );

    this.resizeCanvas();
  }

  setOutputScale(scale: number) {
    this.ensureActive();
    const nextScale = Math.max(0.35, Math.min(1, scale));
    if (Math.abs(nextScale - this.outputScale) < 1e-4) return;
    this.outputScale = nextScale;
    this.resizeCanvas();
  }

  draw(options: MatchColorDrawOptions) {
    this.ensureActive();

    this.gl.useProgram(this.program);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.enableVertexAttribArray(this.positionLocation);
    this.gl.vertexAttribPointer(this.positionLocation, 2, this.gl.FLOAT, false, 0, 0);

    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.uniform1i(this.uniforms.image, 0);

    this.gl.uniform3f(
      this.uniforms.targetHsl,
      options.targetHsl.h,
      options.targetHsl.s,
      options.targetHsl.l
    );
    this.gl.uniform1f(this.uniforms.hueShift, options.hueShift);
    this.gl.uniform1f(this.uniforms.satDelta, options.satDelta);
    this.gl.uniform1f(this.uniforms.lightDelta, options.lightDelta);
    this.gl.uniform1f(this.uniforms.hueTol, options.hueTol ?? DEFAULT_TOLERANCE.hueTol);
    this.gl.uniform1f(this.uniforms.satTol, options.satTol ?? DEFAULT_TOLERANCE.satTol);
    this.gl.uniform1f(this.uniforms.lightTol, options.lightTol ?? DEFAULT_TOLERANCE.lightTol);
    this.gl.uniform1f(this.uniforms.feather, options.feather ?? DEFAULT_TOLERANCE.feather);

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteBuffer(this.positionBuffer);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
  }

  private resizeCanvas() {
    const renderDpr = 1; // keep GPU workload predictable on phones
    this.canvas.width = Math.max(1, Math.round(this.sourceWidth * this.outputScale * renderDpr));
    this.canvas.height = Math.max(1, Math.round(this.sourceHeight * this.outputScale * renderDpr));
  }

  private ensureActive() {
    if (this.disposed) {
      throw new Error("Renderer already disposed");
    }
  }
}
