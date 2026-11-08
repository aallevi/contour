import type { Adjust } from '../core/types';
import { buildLUTs, LUT_SIZE } from './curves';
// Type-only, so this does not import `adjust.ts` at runtime: `adjust.ts` imports
// *this* module for its fallback, and a cycle between the two would work only
// by accident of hoisting.
import type { AdjustedImage } from './adjust';

/**
 * The adjustment stack again, on the CPU.
 *
 * Two jobs. It is what runs when WebGL2 is not available — an old web view, a
 * machine whose driver has been blocklisted, a headless run — so the app works
 * rather than refusing to start. And it is the only version of this arithmetic
 * that can be tested, because the GPU one needs a graphics context that no test
 * runner has; the shaders were consequently the single largest untested surface
 * in the project.
 *
 * It mirrors the shaders step for step, in the same order, on premultiplied
 * RGBA, and unpremultiplies once at the end. Where the two could drift they are
 * pinned together by `tests/adjust.test.ts`, which checks the properties both
 * have to satisfy rather than comparing pixel for pixel — a bilinear resample
 * and a box-filtered one differ in the last bit and neither is wrong.
 */

/**
 * Gaussian weights out to 3 sigma, normalised over the full symmetric kernel.
 *
 * Shared with the shader, which uploads them as a uniform array rather than
 * evaluating the exponential per tap.
 */
export function gaussianWeights(sigma: number, maxTaps = 64): Float32Array {
  const taps = Math.min(maxTaps, Math.max(1, Math.ceil(sigma * 3) + 1));
  const w = new Float32Array(maxTaps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    w[i] = v;
    sum += i === 0 ? v : 2 * v;
  }
  for (let i = 0; i < taps; i++) w[i] /= sum;
  return w;
}

const idx = (w: number, x: number, y: number): number => (y * w + x) * 4;

/**
 * Resample to the working size, averaging every source pixel that lands in a
 * destination one.
 *
 * A box filter rather than bilinear sampling, for the reason the GPU path
 * builds mipmaps: picking one sample per destination pixel out of a 6000px
 * photograph skips most of it and turns fine detail into noise, which is the
 * one thing the tracer downstream copes with worst.
 */
export function resample(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh * 4);
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yScale);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * yScale)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xScale);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * xScale)));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = idx(sw, sx, sy);
          // Premultiply on the way in, so the average of an edge pixel and a
          // transparent one is the edge's colour at half coverage rather than
          // the edge's colour mixed with whatever is stored under the matte.
          const alpha = src[i + 3] / 255;
          r += (src[i] / 255) * alpha;
          g += (src[i + 1] / 255) * alpha;
          b += (src[i + 2] / 255) * alpha;
          a += alpha;
          n++;
        }
      }
      const o = idx(dw, x, y);
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** 3x3 median per colour channel, alpha carried through from the centre. */
export function median3(p: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(p.length);
  const window = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(w, x, y);
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = Math.min(w - 1, Math.max(0, x + dx));
            const sy = Math.min(h - 1, Math.max(0, y + dy));
            window[n++] = p[idx(w, sx, sy) + c];
          }
        }
        // Nine values: a sort is shorter than a selection network and the
        // difference does not show up next to the rest of this pass.
        out[o + c] = window.slice(0, n).sort()[4];
      }
      out[o + 3] = p[o + 3];
    }
  }
  return out;
}

/** Separable Gaussian over all four channels, with the same weights as the shader. */
export function blur(p: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const weights = gaussianWeights(sigma);
  let taps = weights.length;
  while (taps > 1 && weights[taps - 1] <= 0) taps--;

  const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = idx(w, x, y);
        let r = 0; let g = 0; let b = 0; let a = 0;
        for (let i = 0; i < taps; i++) {
          const spread = i === 0 ? [0] : [i, -i];
          for (const d of spread) {
            // Edges are clamped, matching CLAMP_TO_EDGE on the GPU: a zeroed
            // border would darken every side of the frame.
            const sx = horizontal ? Math.min(w - 1, Math.max(0, x + d)) : x;
            const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + d));
            const s = idx(w, sx, sy);
            r += src[s] * weights[i];
            g += src[s + 1] * weights[i];
            b += src[s + 2] * weights[i];
            a += src[s + 3] * weights[i];
          }
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      }
    }
    return out;
  };

  return pass(pass(p, true), false);
}

/** Unsharp mask against a 3x3 tent, clamped to the matte. */
export function sharpen(p: Float32Array, w: number, h: number, amount: number): Float32Array {
  const out = new Float32Array(p);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(w, x, y);
      const a = p[o + 3];
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let wsum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const weight = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
            const sx = Math.min(w - 1, Math.max(0, x + dx));
            const sy = Math.min(h - 1, Math.max(0, y + dy));
            sum += p[idx(w, sx, sy) + c] * weight;
            wsum += weight;
          }
        }
        const soft = sum / wsum;
        out[o + c] = Math.min(a, Math.max(0, p[o + c] + (p[o + c] - soft) * amount));
      }
    }
  }
  return out;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Hue rotation about the grey axis, the same cheap YIQ-style matrix the shader
 * uses. Exact enough for a control whose whole job is "try it and look".
 */
function hueRotate(r: number, g: number, b: number, a: number): [number, number, number] {
  const s = Math.sin(a);
  const co = Math.cos(a);
  const m = [
    0.299 + 0.701 * co + 0.168 * s, 0.587 - 0.587 * co + 0.330 * s, 0.114 - 0.114 * co - 0.497 * s,
    0.299 - 0.299 * co - 0.328 * s, 0.587 + 0.413 * co + 0.035 * s, 0.114 - 0.114 * co + 0.292 * s,
    0.299 - 0.300 * co + 1.250 * s, 0.587 - 0.588 * co - 1.050 * s, 0.114 + 0.886 * co - 0.203 * s,
  ];
  // GLSL's `c * m` is a row-vector product, which is a dot with each column.
  return [
    r * m[0] + g * m[3] + b * m[6],
    r * m[1] + g * m[4] + b * m[7],
    r * m[2] + g * m[5] + b * m[8],
  ];
}

/** Exposure, brightness, contrast, saturation, hue, the LUTs and invert. */
export function tone(
  p: Float32Array,
  w: number,
  h: number,
  adjust: Adjust,
): Uint8ClampedArray<ArrayBuffer> {
  const luts = buildLUTs(adjust.curves, adjust.levels);
  const lut = (v: number, channel: number): number => {
    const i = Math.round(clamp01(v) * (LUT_SIZE - 1));
    return luts[channel * LUT_SIZE + i];
  };
  const exposure = 2 ** adjust.exposure;
  const hue = (adjust.hue * Math.PI) / 180;
  const out = new Uint8ClampedArray(w * h * 4);

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = p[o + 3];
    // Unpremultiply: every operation below is defined on the colour of the
    // pixel, not on the colour times how much of it there is.
    let r = a > 0.0031 ? p[o] / a : 0;
    let g = a > 0.0031 ? p[o + 1] / a : 0;
    let b = a > 0.0031 ? p[o + 2] / a : 0;

    if (Math.abs(hue) > 0.0001) [r, g, b] = hueRotate(r, g, b, hue);
    r = r * exposure + adjust.brightness;
    g = g * exposure + adjust.brightness;
    b = b * exposure + adjust.brightness;
    const k = 1 + adjust.contrast;
    r = (r - 0.5) * k + 0.5;
    g = (g - 0.5) * k + 0.5;
    b = (b - 0.5) * k + 0.5;

    const grey = 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);
    r = grey + (r - grey) * adjust.saturation;
    g = grey + (g - grey) * adjust.saturation;
    b = grey + (b - grey) * adjust.saturation;

    r = lut(clamp01(r), 0);
    g = lut(clamp01(g), 1);
    b = lut(clamp01(b), 2);
    if (adjust.invert) {
      r = 1 - r;
      g = 1 - g;
      b = 1 - b;
    }

    out[o] = Math.round(clamp01(r) * 255);
    out[o + 1] = Math.round(clamp01(g) * 255);
    out[o + 2] = Math.round(clamp01(b) * 255);
    out[o + 3] = Math.round(clamp01(a) * 255);
  }
  return out;
}

/**
 * The whole stack: resample, denoise, blur, sharpen, tone.
 *
 * Same order as the GPU path, for the same reason — the histogram the band
 * thresholds are chosen from has to be the distribution of the very last thing
 * produced here, so the tonal mapping goes at the end.
 */
export function adjustOnCpu(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  adjust: Adjust,
  workW: number,
  workH: number,
): AdjustedImage {
  const w = Math.max(1, Math.round(workW));
  const h = Math.max(1, Math.round(workH));
  let p = resample(src, sw, sh, w, h);

  const passes = Math.round(Math.max(0, Math.min(4, adjust.denoise)));
  for (let i = 0; i < passes; i++) p = median3(p, w, h);
  if (adjust.blur > 0.05) p = blur(p, w, h, adjust.blur);
  if (adjust.sharpen > 0.01) p = sharpen(p, w, h, adjust.sharpen);

  return { width: w, height: h, rgba: tone(p, w, h, adjust) };
}
