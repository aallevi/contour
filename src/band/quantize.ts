import { labToRgb, lumaOf, rgbToLab } from '../core/color';
import type { RGB } from '../core/types';

/**
 * Colour quantisation: k-means in CIE Lab.
 *
 * Lab rather than RGB because the clusters have to land where the eye would put
 * them. In RGB, the distance from a mid skin tone to its own shadow is larger
 * than the distance from that shadow to a dark green, so an RGB quantiser
 * reliably splits a face in two and merges the darker half with the background.
 */

type LabPoint = { L: number; a: number; b: number };

/**
 * At most this many pixels feed the solver.
 *
 * k-means is linear in points per iteration and a two-megapixel image would
 * make the whole thing take seconds for an answer that a stratified sample of
 * forty thousand gets to within a rounding error. The stride is deliberately
 * not a round number so it does not land on a repeating pattern in the image.
 */
const MAX_SAMPLES = 40_000;

function sample(rgba: Uint8ClampedArray, matte: Uint8Array | null): LabPoint[] {
  const pixels = rgba.length / 4;
  const stride = Math.max(1, Math.floor(pixels / MAX_SAMPLES));
  const out: LabPoint[] = [];
  for (let p = 0; p < pixels; p += stride) {
    const i = p * 4;
    // Transparent pixels are not a colour and would drag a cluster to wherever
    // the file happens to store them. The matte is the document's own answer to
    // "is this pixel part of the drawing"; the alpha test is the floor for an
    // image that has no matte at all.
    if (matte && !matte[p]) continue;
    if (rgba[i + 3] < 8) continue;
    const [L, a, b] = rgbToLab(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    out.push({ L, a, b });
  }
  return out;
}

const dist2 = (p: LabPoint, q: LabPoint): number =>
  (p.L - q.L) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;

/**
 * k-means++ seeding: spread the initial centres out in proportion to how far
 * each candidate is from the nearest one already chosen. Random seeding on a
 * photograph puts most centres in whatever dominates the frame and leaves the
 * subject sharing one cluster with the background.
 */
function seed(points: LabPoint[], k: number, fixed: LabPoint[], rand: () => number): LabPoint[] {
  const centres = [...fixed];
  if (centres.length === 0) centres.push(points[(rand() * points.length) | 0]);
  const d2 = new Float64Array(points.length).fill(Infinity);
  const absorb = (c: LabPoint) => {
    for (let i = 0; i < points.length; i++) d2[i] = Math.min(d2[i], dist2(points[i], c));
  };
  for (const c of centres) absorb(c);

  while (centres.length < k) {
    let total = 0;
    for (const v of d2) total += v;
    let target = rand() * total;
    let pick = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      target -= d2[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    const c = points[pick];
    centres.push(c);
    absorb(c);
  }
  return centres;
}

function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type QuantizeOptions = {
  /** Palette entries the user has pinned; these are centres that never move. */
  locked?: RGB[];
  iterations?: number;
  /** Fixed so that re-quantising without changing anything gives the same answer. */
  seed?: number;
  /** 1 where a pixel is part of the drawing; null when the image is opaque. */
  matte?: Uint8Array | null;
};

/**
 * Quantise to `k` colours, returned dark to light.
 *
 * Ordering by lightness is not cosmetic: the band stack paints back to front and
 * nests each region inside the next lighter one, so the order *is* the drawing.
 */
export function quantize(
  rgba: Uint8ClampedArray,
  k: number,
  opts: QuantizeOptions = {},
): RGB[] {
  const want = Math.max(2, Math.min(24, Math.round(k)));
  const points = sample(rgba, opts.matte ?? null);
  if (points.length === 0) return Array.from({ length: want }, () => [0.5, 0.5, 0.5] as RGB);

  const locked = (opts.locked ?? []).slice(0, want);
  const fixed = locked.map((c) => {
    const [L, a, b] = rgbToLab(c[0], c[1], c[2]);
    return { L, a, b };
  });

  const rand = mulberry32(opts.seed ?? 0x9e3779b9);
  let centres = seed(points, want, fixed, rand);
  const assign = new Int32Array(points.length);
  const iterations = opts.iterations ?? 24;

  for (let iter = 0; iter < iterations; iter++) {
    let moved = 0;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = dist2(points[i], centres[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
    }

    const sums = centres.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]];
      s.L += points[i].L;
      s.a += points[i].a;
      s.b += points[i].b;
      s.n++;
    }
    centres = centres.map((_, idx) => {
      // A locked centre is the user's decision and outranks the data.
      if (idx < fixed.length) return fixed[idx];
      const s = sums[idx];
      // An abandoned cluster is re-seeded onto the point furthest from anything,
      // which is how a palette entry earns its place back rather than collapsing
      // onto a neighbour and quietly reducing the palette by one.
      if (s.n === 0) {
        let far = 0;
        let farD = -1;
        for (let i = 0; i < points.length; i++) {
          const d = dist2(points[i], centres[assign[i]]);
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        return points[far];
      }
      return { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
    });

    if (moved === 0 && iter > 0) break;
  }

  return centres
    .map((c) => labToRgb(c.L, c.a, c.b))
    .sort((x, y) => lumaOf(x) - lumaOf(y));
}

/**
 * Assign every pixel to its nearest palette entry, in Lab.
 *
 * The palette is small and the image is not, so the Lab conversion is done once
 * per palette entry and the inner loop is a handful of subtractions — which is
 * what keeps a full reassignment of a two-megapixel image inside a frame or two
 * rather than a visible pause every time a swatch is nudged.
 */
export function colourIndex(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: RGB[],
): Uint8Array {
  const labs = palette.map((c) => rgbToLab(c[0], c[1], c[2]));
  const out = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const [L, a, b] = rgbToLab(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < labs.length; c++) {
      const d = (L - labs[c][0]) ** 2 + (a - labs[c][1]) ** 2 + (b - labs[c][2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    out[p] = best;
  }
  return out;
}

/**
 * The palette entry a colour belongs to.
 *
 * A band remembers the colour it stands for rather than a position, so that
 * reordering or duplicating bands cannot renumber them. This is how that colour
 * is turned back into the index the masks are cut on — and it degrades sensibly
 * when the user has edited a band's source to something not in the palette.
 */
export function nearestPaletteIndex(palette: RGB[], colour: RGB): number {
  const [L, a, b] = rgbToLab(colour[0], colour[1], colour[2]);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const [pl, pa, pb] = rgbToLab(p[0], p[1], p[2]);
    const d = (L - pl) ** 2 + (a - pa) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
