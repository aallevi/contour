import { describe, expect, it } from 'vitest';
import {
  adjustOnCpu, blur, gaussianWeights, median3, resample, sharpen, tone,
} from '../src/image/adjust-cpu';
import { workingSize } from '../src/image/adjust';
import { defaultAdjust } from '../src/core/defaults';
import { luma } from '../src/core/color';
import { histogram } from '../src/band/posterize';

/**
 * The adjustment stack.
 *
 * Until the GPU path stopped throwing when there was no WebGL2, none of this
 * could be tested at all: every test that touched it died in a constructor
 * asking for a graphics context. The CPU path exists partly so the app runs on
 * a machine without WebGL2 and partly so the arithmetic that decides what a
 * photograph's tones become has something checking it.
 */

const W = 32;
const H = 24;

/** A left-to-right grey ramp, fully opaque. */
function ramp(w = W, h = H): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}

/** A mid-grey field with a single white speck in it. */
function speck(): Float32Array {
  const p = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    p[i * 4] = 0.5; p[i * 4 + 1] = 0.5; p[i * 4 + 2] = 0.5; p[i * 4 + 3] = 1;
  }
  const o = ((H / 2) * W + W / 2) * 4;
  p[o] = 1; p[o + 1] = 1; p[o + 2] = 1;
  return p;
}

const at = (p: Float32Array, w: number, x: number, y: number): number => p[(y * w + x) * 4];

describe('resampling', () => {
  it('averages every source pixel rather than picking one', () => {
    // A one-pixel checker halved: every destination pixel must land on the mean
    // rather than on whichever sample the grid happened to hit.
    const src = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      const v = i % 2 === 0 ? 0 : 255;
      src[i * 4] = v; src[i * 4 + 1] = v; src[i * 4 + 2] = v; src[i * 4 + 3] = 255;
    }
    const out = resample(src, 4, 4, 2, 2);
    for (let i = 0; i < 4; i++) expect(out[i * 4]).toBeCloseTo(0.5, 5);
  });

  it('premultiplies, so a transparent neighbour does not darken an edge', () => {
    // Two pixels: one opaque white, one fully transparent with black left in
    // its colour channels — which is exactly what a cut-out PNG carries.
    const src = new Uint8ClampedArray(8);
    src[0] = 255; src[1] = 255; src[2] = 255; src[3] = 255;
    src[4] = 0; src[5] = 0; src[6] = 0; src[7] = 0;

    const out = resample(src, 2, 1, 1, 1);
    // Premultiplied: colour 0.5 at alpha 0.5, which unpremultiplies back to
    // white. Averaging straight RGBA would give mid grey at half alpha, and the
    // edge of every cut-out would come back dirty.
    expect(out[3]).toBeCloseTo(0.5, 5);
    expect(out[0] / out[3]).toBeCloseTo(1, 5);
  });

  it('never divides by an empty sample box', () => {
    // Upscaling asks for destination pixels narrower than one source pixel.
    const out = resample(ramp(4, 4), 4, 4, 9, 9);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('denoise', () => {
  it('removes an isolated speck', () => {
    const out = median3(speck(), W, H);
    expect(at(out, W, W / 2, H / 2)).toBeCloseTo(0.5, 5);
  });

  it('leaves an edge where it was, which is the reason to use a median', () => {
    const p = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const v = x < W / 2 ? 0 : 1;
        p[o] = v; p[o + 1] = v; p[o + 2] = v; p[o + 3] = 1;
      }
    }
    const out = median3(p, W, H);
    expect(at(out, W, W / 2 - 1, 5)).toBe(0);
    expect(at(out, W, W / 2, 5)).toBe(1);
  });

  it('carries the matte through untouched', () => {
    const p = speck();
    p[3] = 0.25;
    expect(median3(p, W, H)[3]).toBe(0.25);
  });
});

describe('blur', () => {
  it('conserves the total, so nothing gets darker overall', () => {
    const p = speck();
    const before = sum(p);
    const after = sum(blur(p, W, H, 2));
    // Clamped edges rather than a zero border: a zeroed one loses light at
    // every side of the frame.
    expect(after).toBeCloseTo(before, 2);
  });

  it('spreads a speck into its neighbours', () => {
    const out = blur(speck(), W, H, 2);
    expect(at(out, W, W / 2, H / 2)).toBeLessThan(1);
    expect(at(out, W, W / 2 + 1, H / 2)).toBeGreaterThan(0.5);
  });

  it('uses weights that sum to one', () => {
    for (const sigma of [0.5, 1.2, 4, 12]) {
      const w = gaussianWeights(sigma);
      let total = w[0];
      for (let i = 1; i < w.length; i++) total += 2 * w[i];
      expect(total).toBeCloseTo(1, 6);
    }
  });
});

describe('sharpen', () => {
  it('lifts local contrast without exceeding the matte', () => {
    const p = speck();
    for (let i = 0; i < W * H; i++) p[i * 4 + 3] = 0.5;
    // Premultiplied: colour can never exceed alpha, or unpremultiplying gives
    // a value above 1 and the pixel blows out.
    const out = sharpen(p, W, H, 2);
    for (let i = 0; i < W * H; i++) {
      expect(out[i * 4]).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(out[i * 4]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('tone', () => {
  const flat = (v: number, alpha = 1): Float32Array => {
    const p = new Float32Array(4);
    p[0] = v * alpha; p[1] = v * alpha; p[2] = v * alpha; p[3] = alpha;
    return p;
  };

  it('passes a neutral stack through unchanged', () => {
    const out = tone(flat(0.5), 1, 1, defaultAdjust());
    expect(out[0]).toBe(128);
    expect(out[3]).toBe(255);
  });

  it('unpremultiplies before doing anything tonal', () => {
    // The same colour at half coverage has to come out the same colour.
    const full = tone(flat(0.8, 1), 1, 1, defaultAdjust());
    const half = tone(flat(0.8, 0.5), 1, 1, defaultAdjust());
    expect(half[0]).toBe(full[0]);
    expect(half[3]).toBe(128);
  });

  it('pivots contrast on mid grey rather than sliding the image', () => {
    const a = { ...defaultAdjust(), contrast: 1 };
    expect(tone(flat(0.5), 1, 1, a)[0]).toBe(128);
    expect(tone(flat(0.75), 1, 1, a)[0]).toBeGreaterThan(190);
    expect(tone(flat(0.25), 1, 1, a)[0]).toBeLessThan(65);
  });

  it('takes saturation to grey', () => {
    const p = new Float32Array([1, 0, 0, 1]);
    const out = tone(p, 1, 1, { ...defaultAdjust(), saturation: 0 });
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
    expect(out[0]).toBeCloseTo(Math.round(0.2126 * 255), -1);
  });

  it('applies levels and curves through the same table', () => {
    const a = defaultAdjust();
    a.levels = { ...a.levels, inBlack: 0.25, inWhite: 0.75 };
    // A quarter tone is below the black point and clips.
    expect(tone(flat(0.2), 1, 1, a)[0]).toBe(0);
    expect(tone(flat(0.8), 1, 1, a)[0]).toBe(255);
    expect(tone(flat(0.5), 1, 1, a)[0]).toBeCloseTo(128, -1);
  });

  it('inverts last, after everything else has landed', () => {
    const out = tone(flat(0.25), 1, 1, { ...defaultAdjust(), invert: true });
    expect(out[0]).toBeCloseTo(191, -1);
  });

  it('keeps alpha out of the tonal chain entirely', () => {
    const out = tone(flat(0.5, 0.4), 1, 1, { ...defaultAdjust(), exposure: 2, invert: true });
    expect(out[3]).toBe(102);
  });
});

describe('the whole stack', () => {
  it('lands at the working size and keeps the picture', () => {
    const { width, height } = workingSize(W, H, 16);
    const out = adjustOnCpu(ramp(), W, H, defaultAdjust(), width, height);
    expect(out.width).toBe(width);
    expect(out.height).toBe(height);
    // Still a ramp: dark on the left, light on the right.
    const left = luma(out.rgba[0] / 255, out.rgba[1] / 255, out.rgba[2] / 255);
    const rightAt = (out.width - 1) * 4;
    const right = luma(
      out.rgba[rightAt] / 255, out.rgba[rightAt + 1] / 255, out.rgba[rightAt + 2] / 255,
    );
    expect(right - left).toBeGreaterThan(0.5);
  });

  it('produces the histogram the thresholds are chosen from', () => {
    // Tone runs last precisely so that this is true: the histogram under the
    // curve editor is the distribution of the very last thing produced.
    const a = { ...defaultAdjust(), blur: 0, invert: true };
    const out = adjustOnCpu(ramp(), W, H, a, W, H);
    const hist = histogram(out.rgba);
    let total = 0;
    for (const v of hist) total += v;
    expect(total).toBe(W * H);
  });

  it('carries a matte all the way through', () => {
    const src = ramp();
    for (let i = 0; i < W * H; i++) if (i % 2 === 0) src[i * 4 + 3] = 0;
    const out = adjustOnCpu(src, W, H, { ...defaultAdjust(), blur: 0 }, W, H);
    let clear = 0;
    for (let i = 0; i < out.width * out.height; i++) if (out.rgba[i * 4 + 3] < 128) clear++;
    expect(clear).toBeGreaterThan(0);
  });
});

function sum(p: Float32Array): number {
  let total = 0;
  for (let i = 0; i < p.length; i += 4) total += p[i];
  return total;
}
