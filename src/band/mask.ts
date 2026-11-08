import type { MaskShaping } from '../core/types';

/**
 * Bilevel masks: what potrace actually gets handed.
 *
 * Stored a byte per pixel rather than bit-packed. Morphology and component
 * walks on packed bits are fiddly to get right and the packing only earns its
 * keep at the very end, on the way into the subprocess — so it happens exactly
 * there and nowhere else.
 */
export type Mask = {
  width: number;
  height: number;
  /** 1 where the region is, 0 elsewhere. */
  bits: Uint8Array;
};

export const emptyMask = (width: number, height: number): Mask => ({
  width,
  height,
  bits: new Uint8Array(width * height),
});

/**
 * Pack a mask into a binary PBM (`P4`).
 *
 * potrace reads this on stdin. Rows are padded to a byte boundary and the most
 * significant bit is the leftmost pixel; a 1 bit is black, which is the region.
 */
export function toPBM(mask: Mask): Uint8Array {
  const { width, height, bits } = mask;
  const header = new TextEncoder().encode(`P4\n${width} ${height}\n`);
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(header.length + rowBytes * height);
  out.set(header, 0);
  let o = header.length;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (bits[row + x]) out[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
    o += rowBytes;
  }
  return out;
}

/**
 * Error function, Abramowitz & Stegun 7.1.26.
 *
 * Needed for one thing only — see `shapeMask` — and accurate to about 1e-7,
 * which is several orders of magnitude better than a threshold on a blurred
 * byte mask can tell the difference between.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/**
 * Three box blurs in a row, which is close enough to a Gaussian that nothing
 * downstream can tell, and linear in the image rather than in the radius.
 */
function blurInto(src: Float32Array, dst: Float32Array, w: number, h: number, sigma: number): void {
  // Box width that matches a Gaussian's variance over three passes.
  const boxes = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / boxes + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const radius = Math.max(1, (wl - 1) / 2);

  const a = new Float32Array(src);
  const b = new Float32Array(w * h);
  for (let pass = 0; pass < boxes; pass++) {
    boxH(a, b, w, h, radius);
    boxV(b, a, w, h, radius);
  }
  dst.set(a);
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const scale = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // Edges are extended rather than wrapped or zeroed: a zero border would
    // eat into a region that runs off the side of the image, and a region that
    // touches the frame is the normal case, not the exception.
    let sum = src[row] * (r + 1);
    for (let i = 0; i < r; i++) sum += src[row + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      sum += src[row + Math.min(x + r, w - 1)] - src[row + Math.max(x - r - 1, 0)];
      dst[row + x] = sum * scale;
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const scale = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let sum = src[x] * (r + 1);
    for (let i = 0; i < r; i++) sum += src[Math.min(i, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      sum += src[Math.min(y + r, h - 1) * w + x] - src[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = sum * scale;
    }
  }
}

/**
 * Smooth and grow a mask in one operation.
 *
 * Both controls come out of the same blur, which is the whole trick. Blur a
 * bilevel mask and a straight edge becomes a soft ramp whose value at signed
 * distance `d` from the original edge is exactly the Gaussian CDF of `d/sigma`.
 * Re-thresholding at 0.5 puts the edge back where it was, only smoother —
 * thresholding anywhere else moves it a known, uniform distance. So a dilation
 * by `grow` pixels is a threshold at `Phi(-grow/sigma)` and costs nothing extra,
 * and because it is a level set of a blurred field the result is round rather
 * than the square-cornered thing a separable min/max filter produces.
 */
export function shapeMask(mask: Mask, shaping: MaskShaping): Mask {
  const grow = shaping.grow ?? 0;
  const smooth = shaping.smooth ?? 0;
  if (Math.abs(grow) < 0.01 && smooth < 0.01) return mask;

  const { width: w, height: h, bits } = mask;
  // A pure grow still needs a ramp to slide the threshold along, and it has to
  // be wide enough to reach: a 1-pixel sigma cannot express a 4-pixel dilation,
  // because the threshold would have to go past 0 or 1 to get there.
  const sigma = Math.max(smooth, Math.abs(grow) * 0.75, 0.5);

  const src = new Float32Array(w * h);
  for (let i = 0; i < src.length; i++) src[i] = bits[i];
  const field = new Float32Array(w * h);
  blurInto(src, field, w, h, sigma);

  const t = 0.5 * (1 - erf(grow / (sigma * Math.SQRT2)));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = field[i] >= t ? 1 : 0;
  return { width: w, height: h, bits: out };
}

/** How much of the image a mask covers, 0..1. Used to skip empty bands. */
export function coverage(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.bits.length; i++) n += mask.bits[i];
  return n / Math.max(1, mask.bits.length);
}
