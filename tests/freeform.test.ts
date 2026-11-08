import { describe, expect, it } from 'vitest';
import {
  buildBandNodes, freePointGeometry, hatchSpacing, MAX_HATCH_LINES, MAX_STIPPLE_DOTS,
  sampleFreePoints, scatterFreePoints, stipplePitch, type FillContext,
} from '../src/fill';
import { defaultBand, defaultFreeform, normaliseFill } from '../src/core/defaults';
import { exportSVG } from '../src/export/svg';
import { exportPDF } from '../src/export/pdf';
import { lumaOf } from '../src/core/color';
import { parsePath } from '../src/trace/path';
import type { Band, FreeformFill, Paint, Scene } from '../src/core/types';
import type { Mask } from '../src/band/mask';
import type { AdjustedImage } from '../src/image/adjust';

/**
 * Freeform gradients: colours dropped where the light puts them.
 *
 * A linear ramp can only say "it gets darker that way". The interesting
 * properties here are that the points are stored relative to the region (so a
 * retrace does not scatter them), that both backends can express the soft
 * falloff exactly, and that the file does not grow by a whole region outline
 * for every point added.
 */

const W = 100;

function square(): { mask: Mask; path: ReturnType<typeof parsePath> } {
  const bits = new Uint8Array(W * W);
  for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) bits[y * W + x] = 1;
  return {
    mask: { width: W, height: W, bits },
    path: parsePath('M20 20L80 20L80 80L20 80Z'),
  };
}

/** Dark on the left, light on the right. */
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

function ctx(fill: FreeformFill, patch: Partial<Band> = {}): FillContext {
  const { mask, path } = square();
  const band: Band = { ...defaultBand('test', [0.4, 0.3, 0.2], 0.5), fill, ...patch };
  return { mask, image: rampImage(), path, scale: 1, band };
}

let seq = 0;
const ids = () => `p${seq++}`;

describe('the default freeform fill', () => {
  it('is visible the moment it is switched on', () => {
    const fill = defaultFreeform([0.4, 0.3, 0.2]);
    expect(fill.points.length).toBeGreaterThanOrEqual(3);
    const lightest = Math.max(...fill.points.map((p) => lumaOf(p.rgb)));
    const darkest = Math.min(...fill.points.map((p) => lumaOf(p.rgb)));
    expect(lightest - darkest).toBeGreaterThan(0.1);
  });

  it('gives every point an id, because a point without one cannot be dragged', () => {
    const ids0 = defaultFreeform([0, 0, 0]).points.map((p) => p.id);
    expect(new Set(ids0).size).toBe(ids0.length);
    expect(ids0.every(Boolean)).toBe(true);
  });
});

describe('point geometry', () => {
  it('places a point by fraction of the region, not by canvas position', () => {
    const box = { x: 100, y: 200, w: 40, h: 80 };
    const g = freePointGeometry(
      { id: 'a', x: 0.5, y: 0.25, rgb: [0, 0, 0], radius: 0.5 },
      box,
    );
    expect(g.cx).toBe(120);
    expect(g.cy).toBe(220);
    // Radius is a share of the diagonal, so it scales with the region's size
    // rather than with one of its axes.
    expect(g.r).toBeCloseTo(Math.hypot(40, 80) * 0.5, 6);
  });

  it('never returns a radius of zero, which SVG treats as undefined', () => {
    const g = freePointGeometry(
      { id: 'a', x: 0.5, y: 0.5, rgb: [0, 0, 0], radius: 0 },
      { x: 0, y: 0, w: 10, h: 10 },
    );
    expect(g.r).toBeGreaterThan(0);
  });
});

describe('rendering', () => {
  it('lays a ground down and one soft blob per point', () => {
    const fill = defaultFreeform([0.4, 0.3, 0.2]);
    const nodes = buildBandNodes(ctx(fill));
    expect(nodes).toHaveLength(1 + fill.points.length);
    expect((nodes[0] as { paint: Paint }).paint.kind).toBe('solid');
    for (let i = 1; i < nodes.length; i++) {
      expect((nodes[i] as { paint: Paint }).paint.kind).toBe('radial');
    }
  });

  it('fades each blob out rather than ending it in a ring', () => {
    const nodes = buildBandNodes(ctx(defaultFreeform([0.4, 0.3, 0.2])));
    const paint = (nodes[1] as { paint: Extract<Paint, { kind: 'radial' }> }).paint;
    expect(paint.stops[0].alpha).toBe(1);
    expect(paint.stops[paint.stops.length - 1].alpha).toBe(0);
    // More than two stops, or the falloff is a straight ramp and the eye finds
    // the break in its slope.
    expect(paint.stops.length).toBeGreaterThan(2);
  });

  it('shares the region outline between every node rather than repeating it', () => {
    const fill = defaultFreeform([0.4, 0.3, 0.2]);
    const nodes = buildBandNodes(ctx(fill));
    const ds = new Set(nodes.map((n) => n.d));
    expect(ds.size).toBe(1);
  });
});

describe('sampling', () => {
  it('reads the photograph under each point', () => {
    const fill: FreeformFill = {
      kind: 'freeform',
      base: [0, 0, 0],
      points: [
        { id: 'l', x: 0.1, y: 0.5, rgb: [1, 0, 0], radius: 0.15 },
        { id: 'r', x: 0.9, y: 0.5, rgb: [0, 0, 1], radius: 0.15 },
      ],
    };
    const [left, right] = sampleFreePoints(ctx(fill), fill);
    // The image is a grey ramp, so both come back grey and the right is lighter.
    expect(left.rgb[0]).toBeCloseTo(left.rgb[2], 2);
    expect(lumaOf(right.rgb)).toBeGreaterThan(lumaOf(left.rgb));
    // Positions are untouched: this reads colour, it does not move anything.
    expect(left.x).toBe(0.1);
  });

  it('leaves a point that falls outside the region alone', () => {
    const fill: FreeformFill = {
      kind: 'freeform',
      base: [0, 0, 0],
      points: [{ id: 'a', x: -4, y: -4, rgb: [1, 0, 0], radius: 0.01 }],
    };
    expect(sampleFreePoints(ctx(fill), fill)[0].rgb).toEqual([1, 0, 0]);
  });
});

describe('scatter', () => {
  it('puts every point inside the region', () => {
    const points = scatterFreePoints(ctx(defaultFreeform([0.4, 0.3, 0.2])), 8, ids);
    expect(points.length).toBeGreaterThan(2);
    // The region is the middle 60% of the frame, and the path box is its bounds,
    // so every fraction must be inside 0..1.
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('takes its colours from the photograph', () => {
    const points = scatterFreePoints(ctx(defaultFreeform([1, 0, 0])), 6, ids);
    // The band colour is pure red and the image is grey; a scattered point that
    // still has the band colour did not sample anything.
    for (const p of points) expect(p.rgb[0]).toBeCloseTo(p.rgb[1], 1);
  });

  it('is deterministic, so pressing it twice is a refinement not a dice roll', () => {
    const a = scatterFreePoints(ctx(defaultFreeform([0.4, 0.3, 0.2])), 6, () => 'x');
    const b = scatterFreePoints(ctx(defaultFreeform([0.4, 0.3, 0.2])), 6, () => 'x');
    expect(a.map((p) => [p.x, p.y])).toEqual(b.map((p) => [p.x, p.y]));
  });

  it('returns nothing rather than throwing on an empty region', () => {
    const empty = { ...ctx(defaultFreeform([0, 0, 0])) };
    empty.mask = { width: W, height: W, bits: new Uint8Array(W * W) };
    expect(scatterFreePoints(empty, 6, ids)).toEqual([]);
  });
});

describe('export', () => {
  /**
   * A realistically long outline.
   *
   * A traced band is thousands of characters of Bézier, and whether the writer
   * hoists a repeated outline depends on its length — a four-corner square is
   * genuinely cheaper repeated than referenced, and testing against one would
   * be testing the wrong thing.
   */
  const longOutline = (): ReturnType<typeof parsePath> => {
    const parts = ['M20 20'];
    for (let i = 1; i <= 60; i++) {
      const t = (i / 60) * Math.PI * 2;
      parts.push(`L${(50 + 30 * Math.cos(t)).toFixed(3)} ${(50 + 30 * Math.sin(t)).toFixed(3)}`);
    }
    parts.push('Z');
    return parsePath(parts.join(''));
  };

  const scene = (): Scene => {
    const c = ctx(defaultFreeform([0.4, 0.3, 0.2]));
    return {
      width: 200,
      height: 200,
      dpi: 300,
      background: null,
      groups: [{
        name: 'Band',
        opacity: 1,
        nodes: buildBandNodes({ ...c, path: longOutline() }),
      }],
    };
  };

  it('writes the outline once and references it', () => {
    const svg = exportSVG(scene());
    // One real path definition, and a `use` for every node after the first.
    expect((svg.match(/<path id="s\d+"/g) ?? []).length).toBe(1);
    expect((svg.match(/<use /g) ?? []).length).toBeGreaterThan(3);
    expect(svg).toContain('stop-opacity');
  });

  it('gives PDF a luminosity soft mask, since it has no transparent stops', async () => {
    const bytes = await exportPDF(scene());
    const raw = new TextDecoder('latin1').decode(bytes);
    expect(raw).toContain('/SMask');
    expect(raw).toContain('/S /Luminosity');
    // The mask is a DeviceGray transparency group, and its backdrop is black so
    // that anything outside it is transparent rather than painted.
    expect(raw).toContain('/CS /DeviceGray');
    expect(raw).toContain('/BC [0]');
  });

  it('leaves an opaque gradient without a mask it does not need', async () => {
    const flat: Scene = {
      ...scene(),
      groups: [{
        name: 'Band',
        opacity: 1,
        nodes: [{
          kind: 'fill',
          d: 'M0 0L10 0L10 10Z',
          paint: {
            kind: 'linear', x1: 0, y1: 0, x2: 10, y2: 0,
            stops: [{ offset: 0, rgb: [0, 0, 0] }, { offset: 1, rgb: [1, 1, 1] }],
          },
          rule: 'nonzero',
          opacity: 1,
        }],
      }],
    };
    const raw = new TextDecoder('latin1').decode(await exportPDF(flat));
    expect(raw).not.toContain('/SMask');
  });
});

describe('documents from disk', () => {
  it('gives an id to a point that arrived without one', () => {
    const fill = normaliseFill(
      { kind: 'freeform', base: [1, 1, 1], points: [{ x: 0.5, y: 0.5, rgb: [0, 0, 0] }] },
      [0, 0, 0],
    ) as FreeformFill;
    expect(fill.points[0].id).toBeTruthy();
    expect(fill.points[0].radius).toBeGreaterThan(0);
  });

  it('refuses to hand back an empty freeform, which is a flat fill in disguise', () => {
    const fill = normaliseFill({ kind: 'freeform', points: [] }, [0.5, 0.4, 0.3]) as FreeformFill;
    expect(fill.points.length).toBeGreaterThan(0);
  });
});

/**
 * The density caps.
 *
 * Both fills used to stay inside their budget by *skipping* marks, which kept
 * the count down and quietly turned the spacing control into a random one: past
 * the limit, dragging it tighter made the field thinner instead of denser.
 */
describe('density caps', () => {
  it('opens the hatch spacing up rather than dropping lines', () => {
    const span = 100_000;
    const used = hatchSpacing(0.4, span);
    expect(used).toBeGreaterThan(0.4);
    expect(span / used).toBeLessThanOrEqual(MAX_HATCH_LINES + 1);
  });

  it('leaves a reasonable spacing exactly as asked', () => {
    expect(hatchSpacing(6, 1000)).toBe(6);
  });

  it('opens the stipple pitch up rather than thinning the grid', () => {
    const area = 4000 * 4000;
    const used = stipplePitch(0.6, area);
    expect(used).toBeGreaterThan(0.6);
    expect(area / (used * used)).toBeLessThanOrEqual(MAX_STIPPLE_DOTS + 1);
  });

  it('never returns something below the floor either fill can draw', () => {
    expect(hatchSpacing(0, 0)).toBeGreaterThan(0);
    expect(stipplePitch(0, 0)).toBeGreaterThan(0);
  });

  it('keeps the field even under the cap', () => {
    // A hatch at an impossible spacing over a big region: every line must be
    // there, evenly spaced, rather than a random subset of the ones asked for.
    const fill = {
      kind: 'hatch' as const,
      angle: 0, spacing: 0.01, weight: 1, cross: false, crossAngle: 90,
      toneWeight: 0, wave: 0, waveLength: 40, base: 0,
    };
    const nodes = buildBandNodes(ctx(defaultFreeform([0, 0, 0]), { fill }));
    const stroke = nodes.find((n) => n.kind === 'stroke');
    expect(stroke).toBeTruthy();
    const ys = [...stroke!.d.matchAll(/M[-\d.]+ ([-\d.]+)L/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(10);
    const gaps = ys.slice(1).map((y, i) => Math.abs(y - ys[i])).filter((g) => g > 1e-6);
    const first = gaps[0];
    for (const g of gaps) expect(g).toBeCloseTo(first, 3);
  });
});
