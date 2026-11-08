import { describe, expect, it } from 'vitest';
import { buildBandNodes, type FillContext } from '../src/fill';
import { defaultBand } from '../src/core/defaults';
import { parsePath, pathBBox } from '../src/trace/path';
import type { Band, Fill } from '../src/core/types';
import type { Mask } from '../src/band/mask';
import type { AdjustedImage } from '../src/image/adjust';

const W = 100;

/** A centred square region, and a matching square path in canvas coordinates. */
function square(scale = 1): { mask: Mask; path: ReturnType<typeof parsePath> } {
  const bits = new Uint8Array(W * W);
  for (let y = 25; y < 75; y++) for (let x = 25; x < 75; x++) bits[y * W + x] = 1;
  const s = scale;
  const path = parsePath(
    `M${25 * s} ${25 * s}L${75 * s} ${25 * s}L${75 * s} ${75 * s}L${25 * s} ${75 * s}Z`,
  );
  return { mask: { width: W, height: W, bits }, path };
}

/** A left-to-right dark-to-light ramp, so tone-driven fills have something to read. */
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

function ctx(fill: Fill, scale = 1, patch: Partial<Band> = {}): FillContext {
  const { mask, path } = square(scale);
  const band: Band = { ...defaultBand('test', [0.1, 0.1, 0.1], 0.5), fill, ...patch };
  return { mask, image: rampImage(), path, scale, band };
}

describe('flat fill', () => {
  it('is one filled path of the band colour', () => {
    const nodes = buildBandNodes(ctx({ kind: 'flat' }));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('fill');
    expect(nodes[0]).toMatchObject({ rule: 'nonzero' });
  });

  it('contributes nothing when the band is hidden', () => {
    expect(buildBandNodes(ctx({ kind: 'flat' }, 1, { visible: false }))).toHaveLength(0);
  });
});

describe('gradient fill', () => {
  const base = {
    kind: 'gradient' as const, shape: 'linear' as const, sampled: false,
    stops: [
      { offset: 0, rgb: [0, 0, 0] as [number, number, number] },
      { offset: 1, rgb: [1, 1, 1] as [number, number, number] },
    ],
    start: 0, end: 1, radius: 1, cx: 0.5, cy: 0.5,
  };

  it('aims itself down the region’s own tone when set to auto', () => {
    const nodes = buildBandNodes(ctx({ ...base, angle: 'auto' }));
    const paint = (nodes[0] as { paint: { kind: string; x1: number; x2: number; y1: number; y2: number } }).paint;
    expect(paint.kind).toBe('linear');
    // The image gets lighter to the right, so the axis should be mostly
    // horizontal rather than vertical.
    expect(Math.abs(paint.x2 - paint.x1)).toBeGreaterThan(Math.abs(paint.y2 - paint.y1));
  });

  it('samples its end colours from the photograph when asked', () => {
    const nodes = buildBandNodes(ctx({ ...base, angle: 'auto', sampled: true }));
    const paint = (nodes[0] as { paint: { stops: { rgb: number[] }[] } }).paint;
    const first = paint.stops[0].rgb[0];
    const last = paint.stops[paint.stops.length - 1].rgb[0];
    // Dark end and light end, taken from the ramp itself.
    expect(Math.abs(last - first)).toBeGreaterThan(0.2);
  });

  it('produces a radial paint centred inside the region', () => {
    const nodes = buildBandNodes(ctx({ ...base, shape: 'radial', angle: 'auto' }));
    const paint = (nodes[0] as { paint: { kind: string; cx: number; cy: number; r: number } }).paint;
    expect(paint.kind).toBe('radial');
    expect(paint.cx).toBeGreaterThan(25);
    expect(paint.cx).toBeLessThan(75);
    expect(paint.r).toBeGreaterThan(0);
  });
});

describe('hatch fill', () => {
  const base = {
    kind: 'hatch' as const, angle: 0, spacing: 6, weight: 1.4, cross: false,
    crossAngle: 90, toneWeight: 0, wave: 0, waveLength: 40, base: 0,
  };

  it('emits strokes that stay inside the region', () => {
    const nodes = buildBandNodes(ctx(base));
    const stroke = nodes.find((n) => n.kind === 'stroke');
    expect(stroke).toBeDefined();
    const box = pathBBox(parsePath(stroke!.d));
    expect(box.x).toBeGreaterThanOrEqual(24);
    expect(box.x + box.w).toBeLessThanOrEqual(76);
    expect(box.y).toBeGreaterThanOrEqual(24);
    expect(box.y + box.h).toBeLessThanOrEqual(76);
  });

  it('lays down about as many lines as the spacing asks for', () => {
    const nodes = buildBandNodes(ctx({ ...base, angle: 90, spacing: 10 }));
    const stroke = nodes.find((n) => n.kind === 'stroke')!;
    // A 50 unit tall region at 10 unit spacing is five lines, give or take one.
    const lines = (stroke.d.match(/M/g) ?? []).length;
    expect(lines).toBeGreaterThanOrEqual(4);
    expect(lines).toBeLessThanOrEqual(6);
  });

  it('halving the spacing roughly doubles the line count', () => {
    const count = (spacing: number): number => {
      const nodes = buildBandNodes(ctx({ ...base, spacing }));
      const stroke = nodes.find((n) => n.kind === 'stroke')!;
      return (stroke.d.match(/M/g) ?? []).length;
    };
    const coarse = count(10);
    const fine = count(5);
    expect(fine).toBeGreaterThan(coarse * 1.6);
  });

  it('cross-hatching adds a second set of lines', () => {
    const one = buildBandNodes(ctx(base)).find((n) => n.kind === 'stroke')!;
    const two = buildBandNodes(ctx({ ...base, cross: true })).find((n) => n.kind === 'stroke')!;
    expect((two.d.match(/M/g) ?? []).length).toBeGreaterThan((one.d.match(/M/g) ?? []).length * 1.5);
  });

  it('becomes filled ribbons once weight follows tone', () => {
    const nodes = buildBandNodes(ctx({ ...base, toneWeight: 0.9 }));
    expect(nodes.some((n) => n.kind === 'stroke')).toBe(false);
    const fill = nodes.find((n) => n.kind === 'fill');
    expect(fill).toBeDefined();
    expect(fill!.d).toContain('Z');
  });

  it('adds a base wash under the lines when asked', () => {
    const plain = buildBandNodes(ctx(base));
    const washed = buildBandNodes(ctx({ ...base, base: 0.3 }));
    expect(washed.length).toBe(plain.length + 1);
    expect(washed[0]).toMatchObject({ kind: 'fill', opacity: 0.3 });
  });

  it('respects the canvas scale', () => {
    // The same region on a canvas twice the size hatches across twice the
    // distance. Spacing is in canvas units, so the line count doubles too —
    // what must not happen is the hatching staying the same size on the page.
    const spread = (scale: number): number => {
      const nodes = buildBandNodes(ctx({ ...base, angle: 90 }, scale));
      const stroke = nodes.find((n) => n.kind === 'stroke')!;
      return pathBBox(parsePath(stroke.d)).w;
    };
    expect(spread(2)).toBeGreaterThan(spread(1) * 1.9);
  });
});

describe('stipple fill', () => {
  const base = {
    kind: 'stipple' as const, spacing: 5, size: 2.4, jitter: 0,
    toneSize: 0, toneDrop: 0, base: 0, seed: 7,
  };

  it('puts every dot inside the region', () => {
    const nodes = buildBandNodes(ctx(base));
    const fill = nodes.find((n) => n.kind === 'fill')!;
    const box = pathBBox(parsePath(fill.d));
    expect(box.x).toBeGreaterThan(22);
    expect(box.x + box.w).toBeLessThan(78);
  });

  it('is deterministic for a given seed, and changes with it', () => {
    const a = buildBandNodes(ctx(base)).find((n) => n.kind === 'fill')!.d;
    const b = buildBandNodes(ctx(base)).find((n) => n.kind === 'fill')!.d;
    const c = buildBandNodes(ctx({ ...base, jitter: 0.8 })).find((n) => n.kind === 'fill')!.d;
    const d = buildBandNodes(ctx({ ...base, jitter: 0.8, seed: 99 })).find((n) => n.kind === 'fill')!.d;
    expect(a).toBe(b);
    expect(c).not.toBe(d);
  });

  it('thins the dots out where the photograph is light', () => {
    const count = (fill: Fill): number => {
      const nodes = buildBandNodes(ctx(fill));
      const node = nodes.find((n) => n.kind === 'fill');
      return node ? (node.d.match(/M/g) ?? []).length : 0;
    };
    expect(count({ ...base, toneDrop: 0.9 })).toBeLessThan(count(base) * 0.8);
  });
});

describe('outline', () => {
  it('adds a stroke of the traced contour', () => {
    const nodes = buildBandNodes(ctx({ kind: 'flat' }, 1, {
      outline: { on: true, colour: [1, 0, 0], width: 2 },
    }));
    const stroke = nodes.find((n) => n.kind === 'stroke');
    expect(stroke).toMatchObject({ width: 2, rgb: [1, 0, 0] });
  });
});
