import type { Adjust } from '../core/types';
import { buildLUTs, LUT_SIZE } from './curves';
import { adjustOnCpu, gaussianWeights } from './adjust-cpu';

/**
 * The adjustment stack, on the GPU.
 *
 * Order is denoise, blur, sharpen, tone — spatial operations first, tonal
 * mapping last. That is not the order a photo editor uses, and the reason is
 * the histogram: banding reads the very last thing this produces, so putting
 * the curve at the end means the histogram under the curve editor is literally
 * the distribution the thresholds will be chosen from. Adjust the tone first
 * and blur afterwards and the two quietly disagree.
 *
 * Everything runs at the working resolution rather than the source's, because
 * the working resolution is what gets traced. A 6000px photograph is resampled
 * once on upload and never touched at full size again.
 *
 * Alpha survives the whole chain, and everything in between is carried
 * *premultiplied*. That is not a detail: resampling or blurring straight RGBA
 * mixes the colour of fully transparent pixels — which in a cut-out PNG is
 * black, or whatever the encoder felt like leaving there — into every edge, so
 * a figure on a transparent ground comes out with a dark fringe all the way
 * round it and the tracer faithfully turns that fringe into a band. The tone
 * pass unpremultiplies once, at the end, and hands back straight RGBA because
 * that is what `ImageData` and the banding code read.
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // No flip anywhere in this pipeline: texture row 0 is the image's top row,
  // v_uv.y = 0 samples it, and readPixels hands row 0 back first.
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_BLIT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 o;
void main() { o = texture(u_src, v_uv); }`;

/**
 * McGuire's 3x3 median, applied per channel.
 *
 * A median is the right tool for photographic speckle because it removes
 * isolated outliers without moving an edge — which is precisely what matters
 * when the next step is going to look for edges and turn them into curves.
 * Blur would soften the edge along with the speckle.
 */
const FRAG_MEDIAN = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
out vec4 o;
#define s2(a, b) { vec3 t = min(a, b); b = max(a, b); a = t; }
#define mn3(a, b, c) s2(a, b); s2(a, c);
#define mx3(a, b, c) s2(b, c); s2(a, c);
#define mnmx3(a, b, c) mx3(a, b, c); s2(a, b);
#define mnmx4(a, b, c, d) s2(a, b); s2(c, d); s2(a, c); s2(b, d);
#define mnmx5(a, b, c, d, e) s2(a, b); s2(c, d); s2(a, c); s2(a, e); s2(d, e);
#define mnmx6(a, b, c, d, e, f) s2(a, d); s2(b, e); s2(c, f); s2(a, b); s2(a, c); s2(e, f); s2(d, f);
void main() {
  vec3 v[9];
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      v[(dy + 1) * 3 + (dx + 1)] = texture(u_src, v_uv + vec2(float(dx), float(dy)) * u_texel).rgb;
    }
  }
  mnmx6(v[0], v[1], v[2], v[3], v[4], v[5]);
  mnmx5(v[1], v[2], v[3], v[4], v[6]);
  mnmx4(v[2], v[3], v[4], v[7]);
  mnmx3(v[3], v[4], v[8]);
  // The matte comes through untouched: a median of nine alphas would chew the
  // corners off a cut-out, and speckle in a matte is not the problem a median
  // filter was reached for.
  o = vec4(v[4], texture(u_src, v_uv).a);
}`;

/** Separable Gaussian. Weights arrive precomputed; the shader just sums them. */
const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_step;
uniform int u_taps;
uniform float u_w[64];
out vec4 o;
void main() {
  // All four channels, because the data is premultiplied: blurring colour and
  // matte together is what keeps an edge the colour of the thing it belongs to.
  vec4 sum = texture(u_src, v_uv) * u_w[0];
  for (int i = 1; i < 64; i++) {
    if (i >= u_taps) break;
    vec2 d = u_step * float(i);
    sum += (texture(u_src, v_uv + d) + texture(u_src, v_uv - d)) * u_w[i];
  }
  o = sum;
}`;

/** Unsharp mask against a fixed 3x3 tent — a local contrast lift, not a blur undo. */
const FRAG_SHARPEN = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_amount;
out vec4 o;
void main() {
  vec4 s = texture(u_src, v_uv);
  vec3 c = s.rgb;
  vec3 blur = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float w = (dx == 0 && dy == 0) ? 4.0 : ((dx == 0 || dy == 0) ? 2.0 : 1.0);
      blur += texture(u_src, v_uv + vec2(float(dx), float(dy)) * u_texel).rgb * w;
      wsum += w;
    }
  }
  blur /= wsum;
  // Still premultiplied, so the result cannot exceed the matte it sits behind.
  o = vec4(clamp(c + (c - blur) * u_amount, vec3(0.0), vec3(s.a)), s.a);
}`;

const FRAG_TONE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_lut;   // 256 x 3, one row per channel
uniform float u_exposure;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue;
uniform float u_invert;
out vec4 o;

vec3 hueRotate(vec3 c, float a) {
  // Rotation about the grey axis, the cheap YIQ-style form. Exact enough for a
  // control whose whole job is "try it and look".
  float s = sin(a), co = cos(a);
  mat3 m = mat3(
    0.299 + 0.701 * co + 0.168 * s, 0.587 - 0.587 * co + 0.330 * s, 0.114 - 0.114 * co - 0.497 * s,
    0.299 - 0.299 * co - 0.328 * s, 0.587 + 0.413 * co + 0.035 * s, 0.114 - 0.114 * co + 0.292 * s,
    0.299 - 0.300 * co + 1.250 * s, 0.587 - 0.588 * co - 1.050 * s, 0.114 + 0.886 * co - 0.203 * s);
  return c * m;
}

float lut(float v, float row) {
  // Half-texel inset: sampling a 256-wide table at 0 and 1 exactly would land
  // on the texel borders and, with CLAMP_TO_EDGE, quietly flatten both ends.
  float x = clamp(v, 0.0, 1.0) * (255.0 / 256.0) + (0.5 / 256.0);
  return texture(u_lut, vec2(x, (row + 0.5) / 3.0)).r;
}

void main() {
  vec4 s = texture(u_src, v_uv);
  // Unpremultiply: every tonal operation below is defined on the colour of the
  // pixel, not on the colour times how much of it there is.
  vec3 c = s.a > 0.0031 ? s.rgb / s.a : vec3(0.0);
  if (abs(u_hue) > 0.0001) c = hueRotate(c, u_hue);
  c *= exp2(u_exposure);
  c += u_brightness;
  // Contrast pivots on mid grey, so it opens the image out rather than sliding it.
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5;
  float grey = dot(clamp(c, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(grey), c, u_saturation);
  c = clamp(c, 0.0, 1.0);
  c = vec3(lut(c.r, 0.0), lut(c.g, 1.0), lut(c.b, 2.0));
  c = mix(c, 1.0 - c, u_invert);
  // Straight alpha out: this is the buffer readPixels hands to ImageData and to
  // the banding code, and both of them want the colour, not the product.
  o = vec4(c, s.a);
}`;

type Program = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

function compile(gl: WebGL2RenderingContext, src: string, type: number): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, frag: string, names: string[]): Program {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, VERT, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(gl, frag, gl.FRAGMENT_SHADER));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

// The buffer type is pinned rather than left as the default `ArrayBufferLike`:
// `new ImageData(...)` will not accept a view that might be over a
// SharedArrayBuffer, and the photo view hands it these pixels directly.
export type AdjustedImage = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
};

export class Adjuster {
  /**
   * Null when the host has no WebGL2, in which case every pass runs on the CPU.
   *
   * This used to throw. Refusing to start at all was a harsh answer to a
   * driver blocklist or an old web view, and it was also what made the whole
   * adjustment stack impossible to test — any test that constructed one of
   * these died in the constructor. See `adjust-cpu.ts`.
   */
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private progs: Record<string, Program> = {};
  private lutTex: WebGLTexture | null = null;
  private srcTex: WebGLTexture | null = null;
  /** The source pixels, kept only when there is no GL to hold them. */
  private cpuSource: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  private srcW = 0;
  private srcH = 0;
  private fbos: { tex: WebGLTexture; fb: WebGLFramebuffer }[] = [];
  private fboW = 0;
  private fboH = 0;

  constructor() {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const gl = canvas?.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) ?? null;
    if (!gl) return;
    this.canvas = canvas;
    this.gl = gl;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.progs = {
      blit: program(gl, FRAG_BLIT, ['u_src']),
      median: program(gl, FRAG_MEDIAN, ['u_src', 'u_texel']),
      blur: program(gl, FRAG_BLUR, ['u_src', 'u_step', 'u_taps', 'u_w']),
      sharpen: program(gl, FRAG_SHARPEN, ['u_src', 'u_texel', 'u_amount']),
      tone: program(gl, FRAG_TONE, [
        'u_src', 'u_lut', 'u_exposure', 'u_brightness', 'u_contrast',
        'u_saturation', 'u_hue', 'u_invert',
      ]),
    };

    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Hand over the source pixels.
   *
   * Mipmaps are built here and used by the first pass, because the working
   * resolution is usually a long way below the source's: sampling a 6000px
   * photograph down to 1400 with plain bilinear filtering skips most of the
   * pixels and aliases everything fine-grained into noise, which is the one
   * thing the pipeline downstream is least able to cope with.
   */
  /** True when the GPU path is unavailable and the CPU one is doing the work. */
  get onCpu(): boolean {
    return this.gl === null;
  }

  setSource(bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement, w: number, h: number): void {
    const gl = this.gl;
    if (!gl) {
      this.cpuSource = readPixels(bitmap, w, h);
      this.srcW = w;
      this.srcH = h;
      return;
    }
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.srcW = w;
    this.srcH = h;
  }

  hasSource(): boolean {
    return this.srcTex !== null || this.cpuSource !== null;
  }

  private ensureFbos(w: number, h: number): void {
    const gl = this.gl!;
    if (this.fboW === w && this.fboH === h && this.fbos.length === 2) return;
    for (const f of this.fbos) {
      gl.deleteTexture(f.tex);
      gl.deleteFramebuffer(f.fb);
    }
    this.fbos = [];
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.fbos.push({ tex, fb });
    }
    this.fboW = w;
    this.fboH = h;
  }

  /** Run the stack and read the result back. */
  run(adjust: Adjust, workW: number, workH: number): AdjustedImage {
    const gl = this.gl;
    if (!gl) {
      if (!this.cpuSource) throw new Error('no source image');
      const src = this.cpuSource;
      return adjustOnCpu(src.data, src.width, src.height, adjust, workW, workH);
    }
    if (!this.srcTex) throw new Error('no source image');
    const w = Math.max(1, Math.round(workW));
    const h = Math.max(1, Math.round(workH));
    this.ensureFbos(w, h);
    (this.canvas as HTMLCanvasElement).width = w;
    (this.canvas as HTMLCanvasElement).height = h;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);

    let read = 0;
    const target = (i: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[i].fb);
      gl.viewport(0, 0, w, h);
    };
    const bindSrc = (tex: WebGLTexture, unit = 0) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 1. Resample into the working buffer.
    target(read);
    gl.useProgram(this.progs.blit.p);
    bindSrc(this.srcTex);
    gl.uniform1i(this.progs.blit.u.u_src, 0);
    draw();

    const swap = () => {
      const from = this.fbos[read].tex;
      read = 1 - read;
      target(read);
      return from;
    };
    const texel = [1 / w, 1 / h];

    // 2. Denoise.
    const passes = Math.round(Math.max(0, Math.min(4, adjust.denoise)));
    for (let i = 0; i < passes; i++) {
      const from = swap();
      gl.useProgram(this.progs.median.p);
      bindSrc(from);
      gl.uniform1i(this.progs.median.u.u_src, 0);
      gl.uniform2f(this.progs.median.u.u_texel, texel[0], texel[1]);
      draw();
    }

    // 3. Blur, horizontally then vertically.
    if (adjust.blur > 0.05) {
      const weights = gaussianWeights(adjust.blur);
      let taps = weights.length;
      while (taps > 1 && weights[taps - 1] <= 0) taps--;
      for (const dir of [[texel[0], 0], [0, texel[1]]]) {
        const from = swap();
        gl.useProgram(this.progs.blur.p);
        bindSrc(from);
        gl.uniform1i(this.progs.blur.u.u_src, 0);
        gl.uniform2f(this.progs.blur.u.u_step, dir[0], dir[1]);
        gl.uniform1i(this.progs.blur.u.u_taps, taps);
        gl.uniform1fv(this.progs.blur.u.u_w, weights);
        draw();
      }
    }

    // 4. Sharpen.
    if (adjust.sharpen > 0.01) {
      const from = swap();
      gl.useProgram(this.progs.sharpen.p);
      bindSrc(from);
      gl.uniform1i(this.progs.sharpen.u.u_src, 0);
      gl.uniform2f(this.progs.sharpen.u.u_texel, texel[0], texel[1]);
      gl.uniform1f(this.progs.sharpen.u.u_amount, adjust.sharpen);
      draw();
    }

    // 5. Tone: levels and curves collapsed into one table, plus the scalars.
    {
      const luts = buildLUTs(adjust.curves, adjust.levels);
      const bytes = new Uint8Array(LUT_SIZE * 3);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(luts[i] * 255);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, LUT_SIZE, 3, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);

      const from = swap();
      const t = this.progs.tone;
      gl.useProgram(t.p);
      bindSrc(from, 0);
      gl.uniform1i(t.u.u_src, 0);
      gl.uniform1i(t.u.u_lut, 1);
      gl.uniform1f(t.u.u_exposure, adjust.exposure);
      gl.uniform1f(t.u.u_brightness, adjust.brightness);
      gl.uniform1f(t.u.u_contrast, adjust.contrast);
      gl.uniform1f(t.u.u_saturation, adjust.saturation);
      gl.uniform1f(t.u.u_hue, (adjust.hue * Math.PI) / 180);
      gl.uniform1f(t.u.u_invert, adjust.invert ? 1 : 0);
      draw();
    }

    const rgba = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[read].fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: w, height: h, rgba };
  }

  /** The source's own dimensions, for choosing a working size. */
  sourceSize(): { width: number; height: number } {
    return { width: this.srcW, height: this.srcH };
  }
}

/** Pull RGBA out of a decoded image, for the CPU path. */
function readPixels(
  bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  w: number,
  h: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const g = c.getContext('2d');
  if (!g) throw new Error('This browser provided neither WebGL2 nor a 2D canvas.');
  g.drawImage(bitmap as CanvasImageSource, 0, 0, c.width, c.height);
  const { data } = g.getImageData(0, 0, c.width, c.height);
  return { data, width: c.width, height: c.height };
}

/** Fit a source into a long-edge budget without ever upscaling it. */
export function workingSize(
  srcW: number,
  srcH: number,
  longEdge: number,
): { width: number; height: number } {
  const longest = Math.max(srcW, srcH);
  if (longest <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, longEdge / longest);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}
