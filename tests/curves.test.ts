import { describe, expect, it } from 'vitest';
import {
  addCurvePoint, buildLUTs, curveLUT, levelsFn, monotoneSpline, moveCurvePoint, removeCurvePoint,
} from '../src/image/curves';
import { identityCurves } from '../src/core/defaults';

describe('monotone spline', () => {
  it('passes through its control points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.3, y: 0.7 }, { x: 1, y: 1 }];
    const f = monotoneSpline(pts);
    for (const p of pts) expect(f(p.x)).toBeCloseTo(p.y, 6);
  });

  it('never overshoots between close control points', () => {
    // The case a natural cubic spline gets wrong: a step followed by a plateau
    // makes it dip below the lower point before climbing.
    const f = monotoneSpline([
      { x: 0, y: 0 }, { x: 0.45, y: 0.05 }, { x: 0.55, y: 0.95 }, { x: 1, y: 1 },
    ]);
    for (let i = 0; i <= 200; i++) {
      const y = f(i / 200);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('stays monotone when its points do', () => {
    const f = monotoneSpline([
      { x: 0, y: 0 }, { x: 0.2, y: 0.1 }, { x: 0.7, y: 0.85 }, { x: 1, y: 1 },
    ]);
    let prev = -Infinity;
    for (let i = 0; i <= 300; i++) {
      const y = f(i / 300);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it('is the identity for the default two points', () => {
    const lut = curveLUT([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    for (let i = 0; i < 256; i += 17) expect(lut[i]).toBeCloseTo(i / 255, 5);
  });
});

describe('levels', () => {
  it('maps the input range onto the output range', () => {
    const f = levelsFn({ inBlack: 0.2, inWhite: 0.8, gamma: 1, outBlack: 0, outWhite: 1 });
    expect(f(0.2)).toBeCloseTo(0, 5);
    expect(f(0.8)).toBeCloseTo(1, 5);
    expect(f(0.5)).toBeCloseTo(0.5, 5);
    expect(f(0.1)).toBe(0);
    expect(f(0.9)).toBe(1);
  });

  it('brightens as gamma rises', () => {
    const base = { inBlack: 0, inWhite: 1, outBlack: 0, outWhite: 1 };
    const dim = levelsFn({ ...base, gamma: 0.5 });
    const bright = levelsFn({ ...base, gamma: 2 });
    expect(bright(0.5)).toBeGreaterThan(0.5);
    expect(dim(0.5)).toBeLessThan(0.5);
  });
});

describe('the composed lookup table', () => {
  it('is the identity when nothing is set', () => {
    const lut = buildLUTs(identityCurves(), {
      inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1,
    });
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 256; i += 25) {
        expect(lut[c * 256 + i]).toBeCloseTo(i / 255, 4);
      }
    }
  });

  it('applies the per-channel curve before the master one', () => {
    const curves = identityCurves();
    curves.r = [{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }, { x: 1, y: 1 }];
    const lut = buildLUTs(curves, { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 });
    expect(lut[128]).toBeLessThan(0.4);
    expect(lut[256 + 128]).toBeCloseTo(0.502, 2);
  });
});

describe('editing control points', () => {
  it('keeps points sorted and refuses duplicates at the same x', () => {
    let pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    pts = addCurvePoint(pts, { x: 0.5, y: 0.8 });
    pts = addCurvePoint(pts, { x: 0.502, y: 0.2 });
    expect(pts).toHaveLength(3);
    expect(pts.map((p) => p.x)).toEqual([...pts.map((p) => p.x)].sort((a, b) => a - b));
  });

  it('pins the end points to their edges', () => {
    const pts = moveCurvePoint([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, { x: 0.4, y: 0.3 });
    expect(pts[0].x).toBe(0);
    expect(pts[0].y).toBeCloseTo(0.3, 6);
  });

  it('will not remove an end point, or the last interior one below two', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(removeCurvePoint(pts, 0)).toHaveLength(2);
    expect(removeCurvePoint(pts, 1)).toHaveLength(2);
    expect(removeCurvePoint([...pts.slice(0, 1), { x: 0.5, y: 0.5 }, ...pts.slice(1)], 1))
      .toHaveLength(2);
  });
});
