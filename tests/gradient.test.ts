import { describe, expect, it } from 'vitest';
import { buildBandNodes, gradientStopsFor, normaliseStops, rampExtent, type FillContext } from '../src/fill';
import { defaultBand, defaultGradient, gradientRamp, normaliseFill } from '../src/core/defaults';
import { colourAtOffset, tidyStops } from '../src/ui/gradient';
import { lumaOf } from '../src/core/color';
import { parsePath } from '../src/trace/path';
import type { Band, GradientFill, Paint, RGB } from '../src/core/types';
import type { Mask } from '../src/band/mask';
import type { AdjustedImage } from '../src/image/adjust';

/**
 * Gradients, which is where most of the "it does nothing" reports came from.
 *
 * Three separate faults produced that impression and each has a test here: the
 * default ramp was two copies of one colour, the extent was welded to the
 * region's bounding box, and sampling only ever read the two ends.
 */

const W = 100;

function square(): { mask: Mask; path: ReturnType<typeof parsePath> } {
  const bits = new Uint8Array(W * W);
  for (let y = 25; y < 75; y++) for (let x = 25; x < 75; x++) bits[y * W + x] = 1;
  return {
    mask: { width: W, height: W, bits },
    path: parsePath('M25 25L75 25L75 75L25 75Z'),
  };
}

/** Dark on the left, light on the right, so a sampled ramp has something to find. */
function rampImage(): AdjustedImage {
  const rgba = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.round((x / (W - 1)) * 255);
      const i = (y * W + x) * 4;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  return { width: W, height: W, rgba };
}

function ctx(fill: GradientFill, patch: Partial<Band> = {}): FillContext {
  const { mask, path } = square();
  const band: Band = { ...defaultBand('test', [0.4, 0.3, 0.2], 0.5), fill, ...patch };
  return { mask, image: rampImage(), path, scale: 1, band };
}

const paintOf = (fill: GradientFill): Paint =>
  (buildBandNodes(ctx(fill))[0] as { paint: Paint }).paint;

describe('the default gradient', () => {
  it('is visible the moment it is switched on', () => {
    // The old default put the band colour at both ends, so choosing Gradient
    // changed nothing on screen and the feature looked broken.
    const stops = defaultGradient([0.4, 0.3, 0.2]).stops;
    const lightest = Math.max(...stops.map((s) => lumaOf(s.rgb)));
    const darkest = Math.min(...stops.map((s) => lumaOf(s.rgb)));
    expect(lightest - darkest).toBeGreaterThan(0.15);
  });

  it('keeps the hue of the colour it was built from', () => {
    const stops = gradientRamp([0.55, 0.36, 0.12]);
    for (const s of stops) {
      // Ochre stays ochre: red above green above blue, at every stop.
      expect(s.rgb[0]).toBeGreaterThan(s.rgb[1]);
      expect(s.rgb[1]).toBeGreaterThan(s.rgb[2]);
    }
  });

  it('runs light to dark, which is the direction a form turns away in', () => {
    const stops = gradientRamp([0.4, 0.4, 0.4]);
    expect(lumaOf(stops[0].rgb)).toBeGreaterThan(lumaOf(stops[stops.length - 1].rgb));
  });
});

describe('ramp extent', () => {
  it('spans the region exactly at 0 and 1', () => {
    expect(rampExtent(10, 60, 0, 1)).toEqual({ a: 10, b: 60 });
  });

  it('pushes the ramp off the region past 1', () => {
    const { a, b } = rampExtent(0, 100, 0, 2);
    expect(a).toBe(0);
    expect(b).toBe(200);
  });

  it('reverses when the end is below the start', () => {
    const { a, b } = rampExtent(0, 100, 1, 0);
    expect(a).toBeGreaterThan(b);
  });

  it('never collapses to zero length, which SVG draws as nothing', () => {
    const { a, b } = rampExtent(0, 100, 0.5, 0.5);
    expect(b).not.toBe(a);
  });
});

describe('gradient geometry', () => {
  const base = defaultGradient([0.4, 0.3, 0.2]);

  it('follows the region’s own tone when aimed automatically', () => {
    const p = paintOf({ ...base, angle: 'auto' }) as Extract<Paint, { kind: 'linear' }>;
    expect(p.kind).toBe('linear');
    // The image lightens to the right, so the axis is mostly horizontal.
    expect(Math.abs(p.x2 - p.x1)).toBeGreaterThan(Math.abs(p.y2 - p.y1));
  });

  it('covers more ground when the ramp is widened', () => {
    const tight = paintOf({ ...base, angle: 0, start: 0, end: 1 }) as Extract<Paint, { kind: 'linear' }>;
    const wide = paintOf({ ...base, angle: 0, start: -0.5, end: 1.5 }) as Extract<Paint, { kind: 'linear' }>;
    const span = (p: Extract<Paint, { kind: 'linear' }>) => Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    expect(span(wide)).toBeGreaterThan(span(tight) * 1.9);
  });

  it('scales the radial radius rather than pinning it to the bounding box', () => {
    const small = paintOf({ ...base, shape: 'radial', radius: 0.5 }) as Extract<Paint, { kind: 'radial' }>;
    const large = paintOf({ ...base, shape: 'radial', radius: 2 }) as Extract<Paint, { kind: 'radial' }>;
    expect(large.r).toBeCloseTo(small.r * 4, 4);
  });

  it('moves the radial centre within the region', () => {
    const left = paintOf({ ...base, shape: 'radial', cx: 0 }) as Extract<Paint, { kind: 'radial' }>;
    const right = paintOf({ ...base, shape: 'radial', cx: 1 }) as Extract<Paint, { kind: 'radial' }>;
    expect(left.cx).toBeCloseTo(25, 3);
    expect(right.cx).toBeCloseTo(75, 3);
  });
});

describe('sampling from the photograph', () => {
  it('reads every stop, not just the two ends', () => {
    const fill: GradientFill = {
      ...defaultGradient([0.4, 0.4, 0.4]),
      angle: 0,
      sampled: true,
      stops: [
        { offset: 0, rgb: [1, 0, 0] },
        { offset: 0.5, rgb: [0, 1, 0] },
        { offset: 1, rgb: [0, 0, 1] },
      ],
    };
    const p = paintOf(fill) as Extract<Paint, { kind: 'linear' }>;
    // The image is a grey ramp, so every sampled stop must come back grey —
    // including the middle one, which the old two-end sampler left untouched.
    for (const s of p.stops) {
      expect(s.rgb[0]).toBeCloseTo(s.rgb[1], 2);
      expect(s.rgb[1]).toBeCloseTo(s.rgb[2], 2);
    }
    expect(lumaOf(p.stops[0].rgb)).toBeLessThan(lumaOf(p.stops[2].rgb));
  });

  it('hands back stops the document can keep', () => {
    const fill: GradientFill = { ...defaultGradient([0.4, 0.4, 0.4]), angle: 0, sampled: true };
    const baked = gradientStopsFor(ctx(fill), fill);
    expect(baked).not.toBeNull();
    expect(baked).toHaveLength(fill.stops.length);
    // Drawing the baked stops without sampling gives the same picture, which is
    // the whole promise of the Take colours button.
    const live = paintOf(fill) as Extract<Paint, { kind: 'linear' }>;
    const frozen = paintOf({ ...fill, sampled: false, stops: baked! }) as Extract<Paint, { kind: 'linear' }>;
    live.stops.forEach((s, i) => {
      expect(frozen.stops[i].rgb[0]).toBeCloseTo(s.rgb[0], 5);
    });
  });

  it('returns null for a band with no gradient', () => {
    const flat = { ...defaultBand('t', [0, 0, 0], 0.5), fill: { kind: 'flat' as const } };
    const c = { ...ctx(defaultGradient([0, 0, 0])), band: flat };
    expect(gradientStopsFor(c, defaultGradient([0, 0, 0]))).not.toBeNull();
    // An empty mask has no axis to sample along.
    const empty = { ...c, mask: { width: W, height: W, bits: new Uint8Array(W * W) } };
    expect(gradientStopsFor(empty, defaultGradient([0, 0, 0]))).toBeNull();
  });
});

describe('stop hygiene', () => {
  it('sorts and clamps whatever it is handed', () => {
    const out = normaliseStops([
      { offset: 2, rgb: [1, 1, 1] },
      { offset: -1, rgb: [0, 0, 0] },
    ], [0.5, 0.5, 0.5]);
    expect(out.map((s) => s.offset)).toEqual([0, 1]);
  });

  it('never returns fewer than two stops', () => {
    expect(normaliseStops([], [0.2, 0.2, 0.2])).toHaveLength(2);
    expect(normaliseStops([{ offset: 0.5, rgb: [1, 0, 0] }], [0, 0, 0])).toHaveLength(2);
    expect(tidyStops([])).toHaveLength(2);
  });

  it('reads the colour already on the ramp at a point, for a stop added by clicking', () => {
    const stops = [
      { offset: 0, rgb: [0, 0, 0] as RGB },
      { offset: 1, rgb: [1, 1, 1] as RGB },
    ];
    const mid = colourAtOffset(stops, 0.5);
    expect(lumaOf(mid)).toBeGreaterThan(0.2);
    expect(lumaOf(mid)).toBeLessThan(0.8);
    expect(colourAtOffset(stops, -1)).toEqual([0, 0, 0]);
    expect(colourAtOffset(stops, 5)).toEqual([1, 1, 1]);
  });
});

describe('documents written by older builds', () => {
  it('turns a from/to/midpoint gradient into the stops it described', () => {
    const migrated = normaliseFill(
      { kind: 'gradient', shape: 'linear', angle: 'auto', sampled: false,
        from: [0, 0, 0], to: [1, 1, 1], midpoint: 0.3 },
      [0.5, 0.5, 0.5],
    ) as GradientFill;
    expect(migrated.stops).toHaveLength(3);
    expect(migrated.stops[0].rgb).toEqual([0, 0, 0]);
    expect(migrated.stops[1].offset).toBeCloseTo(0.3, 6);
    expect(migrated.stops[2].rgb).toEqual([1, 1, 1]);
    expect(migrated.start).toBe(0);
    expect(migrated.end).toBe(1);
  });

  it('leaves other fills exactly as they were', () => {
    const hatch = { kind: 'hatch', angle: 45, spacing: 6 };
    expect(normaliseFill(hatch, [0, 0, 0])).toBe(hatch);
  });

  it('falls back to flat for something it cannot read at all', () => {
    expect(normaliseFill(null, [0, 0, 0])).toEqual({ kind: 'flat' });
    expect(normaliseFill({ nonsense: 1 }, [0, 0, 0])).toEqual({ kind: 'flat' });
  });
});
