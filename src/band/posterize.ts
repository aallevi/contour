import { luma } from '../core/color';
import type { Mask } from './mask';

/**
 * Tone banding.
 *
 * Reduce the adjusted image to luminance, pick `levels - 1` thresholds, and cut
 * one mask per threshold. The lightest level is not a band: it is the paper.
 */

export const HIST_BINS = 256;

/**
 * Luminance histogram of the adjusted image, for the curve editor and for spacing.
 *
 * Transparent pixels are left out. They are not tones — on a cut-out they are
 * most of the frame, and counting them would hand equal-area spacing a picture
 * that is three-quarters one value and send every threshold into a corner.
 */
export function histogram(rgba: Uint8ClampedArray, matte: Uint8Array | null = null): Uint32Array {
  const hist = new Uint32Array(HIST_BINS);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (matte && !matte[p]) continue;
    const y = luma(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    hist[Math.min(HIST_BINS - 1, (y * (HIST_BINS - 1)) | 0)]++;
  }
  return hist;
}

/**
 * The matte: 1 where the source is opaque enough to be part of the drawing.
 *
 * Null when the image has no meaningful transparency at all, so a photograph
 * pays nothing for the feature and every `matte &&` below short-circuits.
 */
export function buildMatte(
  rgba: Uint8ClampedArray,
  alphaCut: number,
): Uint8Array | null {
  const cut = Math.round(Math.min(1, Math.max(0, alphaCut)) * 255);
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  let clear = 0;
  for (let p = 0; p < n; p++) {
    const on = rgba[p * 4 + 3] >= cut ? 1 : 0;
    out[p] = on;
    if (!on) clear++;
  }
  return clear === 0 ? null : out;
}

/** Thresholds spaced uniformly across the tone range. */
export function evenThresholds(levels: number): number[] {
  const n = Math.max(2, Math.round(levels));
  return Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
}

/**
 * Thresholds that put the same number of pixels in every band.
 *
 * Almost always the better opening move. A photograph's tones are never
 * uniformly distributed, so evenly spaced thresholds routinely hand three of
 * four bands to a sky and leave the subject as one flat shape. Equal-area
 * spacing spends the levels where the pixels actually are, which is what makes
 * the first result look considered rather than accidental.
 */
export function equalAreaThresholds(hist: Uint32Array, levels: number): number[] {
  const n = Math.max(2, Math.round(levels));
  let total = 0;
  for (const v of hist) total += v;
  if (total === 0) return evenThresholds(n);

  const out: number[] = [];
  let cumulative = 0;
  let bin = 0;
  for (let k = 1; k < n; k++) {
    const want = (total * k) / n;
    while (bin < HIST_BINS - 1 && cumulative + hist[bin] < want) {
      cumulative += hist[bin];
      bin++;
    }
    out.push(bin / (HIST_BINS - 1));
  }

  // Separate any ties.
  //
  // An image with only a few distinct tones puts several quantiles in the same
  // histogram bin, and duplicate thresholds mean empty bands — two traces of
  // the identical region, one of which can never be seen. Spreading them by a
  // bin apiece keeps every level a sliver of tone to itself.
  const eps = 1 / (HIST_BINS - 1);
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1]) out[i] = out[i - 1] + eps;
  }
  // Keep every threshold strictly below white, and walk the stack back down if
  // separating ties pushed it up there.
  //
  // A threshold at exactly 1 is degenerate: it puts every pixel in the image at
  // or below it, so the band takes the whole canvas and the level above it —
  // the paper — gets nothing. On a cutout or a studio shot, where half the
  // frame can be pure white, the plain quantile lands there routinely and the
  // result is a drawing with its own background painted over the paper. Capping
  // one bin below white sends pure white to the paper, where it belongs.
  for (let i = out.length - 1; i >= 0; i--) {
    const ceiling = 1 - eps * (out.length - i);
    if (out[i] > ceiling) out[i] = ceiling;
  }
  return out;
}

/**
 * Luminance as a byte per pixel — the field every mask is cut out of.
 *
 * Both modes reduce to this. Tone banding uses the image's own luminance;
 * colour banding uses the luminance of the palette entry each pixel was
 * assigned, which is what lets one piece of code cut masks for both.
 */
export function lumaField(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = Math.round(luma(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255) * 255);
  }
  return out;
}

/**
 * Cut one band's mask out of the field.
 *
 * A band owns a `cut` — the tone at its light edge — and that, rather than its
 * position in the list, is what decides its shape. Bands are therefore ordinary
 * objects: duplicating one gives you a second band over the same region with
 * its own fill, and deleting one leaves the others exactly where they were.
 *
 * `nested` is the default and matters more than it looks. Traced independently,
 * two adjacent regions produce two curves fitted to the same edge from opposite
 * sides, agreeing only to within a fraction of a pixel — so the paper shows
 * through along every shared boundary as a hairline. Nesting makes each band
 * everything up to its cut, so the bands overlap completely and paint over one
 * another back to front. There is nothing left to leak through, and the extra
 * covered area costs nothing because it is covered.
 */
export function maskAtCut(
  field: Uint8Array,
  width: number,
  height: number,
  cut: number,
  lowerCut: number,
  nested: boolean,
  matte: Uint8Array | null = null,
): Mask {
  // A negative `lowerCut` means there is nothing below this band, and it has to
  // stay negative: clamping it to 0 would make the test `v > lo` exclude pure
  // black, quietly dropping the darkest pixels out of the darkest band.
  return maskAtLevel(
    field,
    width,
    height,
    Math.round(Math.min(1, Math.max(0, cut)) * 255),
    nested || lowerCut < 0 ? -1 : Math.round(Math.min(1, lowerCut) * 255),
    nested,
    matte,
  );
}

/**
 * The same cut, in the field's own units.
 *
 * Tone banding measures its field in luminance; colour banding measures it in
 * palette index, and the two must not be conflated. Two palette entries can sit
 * nine luminance steps apart and be entirely different colours — a tan and a
 * grey, say — and cutting those by lightness merges them into one band and
 * leaves the other drawing nothing. Nesting by index cannot collapse, because
 * the indices are distinct by construction.
 */
export function maskAtLevel(
  field: Uint8Array,
  width: number,
  height: number,
  hi: number,
  lo: number,
  nested: boolean,
  matte: Uint8Array | null = null,
): Mask {
  const floor = nested ? -1 : lo;
  const bits = new Uint8Array(width * height);
  for (let p = 0; p < bits.length; p++) {
    if (matte && !matte[p]) continue;
    const v = field[p];
    bits[p] = v <= hi && v > floor ? 1 : 0;
  }
  return { width, height, bits };
}

/**
 * The next cut below `cut`, or -1 when there is none.
 *
 * Only consulted when nesting is off, to give a band a floor as well as a
 * ceiling. Taken from the cuts actually present rather than from the threshold
 * list, so a hand-added band still gets a sensible lower edge.
 */
export function lowerCutOf(cuts: number[], cut: number): number {
  let best = -1;
  for (const c of cuts) if (c < cut - 1e-6 && c > best) best = c;
  return best;
}

/**
 * The tone at the middle of each band, for naming and for default colours.
 * Band `i` spans `thresholds[i-1]` to `thresholds[i]`.
 */
export function bandMidTones(thresholds: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < thresholds.length; i++) {
    const lo = i === 0 ? 0 : thresholds[i - 1];
    out.push((lo + thresholds[i]) / 2);
  }
  return out;
}
