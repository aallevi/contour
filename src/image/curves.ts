import type { CurvePoint, Curves, Levels } from '../core/types';
import { clamp01 } from '../core/color';

/**
 * Curves and levels, as lookup tables.
 *
 * Kept pure and away from the GL code on purpose: this is the arithmetic that
 * decides what a photograph's tones become, so it is the part worth being able
 * to test without a graphics context.
 */

export const LUT_SIZE = 256;

/**
 * Monotone cubic interpolation through the control points (Fritsch–Carlson).
 *
 * A natural cubic spline is the obvious choice and the wrong one: between two
 * close control points it overshoots, so dragging a curve handle down can make
 * the region just before it get *brighter*. Clamping the tangents removes the
 * overshoot entirely, which is why every curves dialog worth using behaves this
 * way — the drawn curve never leaves the box the handles put it in.
 */
export function monotoneSpline(points: CurvePoint[]): (x: number) => number {
  const pts = [...points]
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) return (x) => x;
  if (pts.length === 1) return () => clamp01(pts[0].y);

  const n = pts.length;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);

  // Secant slopes between neighbours.
  const dx: number[] = [];
  const dy: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    // Two handles dragged onto the same x would divide by zero; treat the pair
    // as a step and let the later one win.
    dx.push(h);
    dy.push(ys[i + 1] - ys[i]);
    slope.push(h === 0 ? 0 : dy[i] / h);
  }

  // Tangents: one-sided at the ends, averaged in the middle.
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Fritsch–Carlson: pull tangents back inside the circle of radius 3 so no
  // segment can leave the interval its endpoints define.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    // Points are few; a scan is faster than a binary search and simpler to read.
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i];
    if (h === 0) return ys[i + 1];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

/** Sample a curve into a 256-entry table. */
export function curveLUT(points: CurvePoint[]): Float32Array {
  const f = monotoneSpline(points);
  const out = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) out[i] = clamp01(f(i / (LUT_SIZE - 1)));
  return out;
}

/** True when a curve does nothing, so the pass can be skipped. */
export function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.length === 2
    && points[0].x === 0 && points[0].y === 0
    && points[1].x === 1 && points[1].y === 1;
}

/**
 * Levels as a function, matching the classic dialog exactly: clip to the input
 * range, apply gamma, then remap into the output range.
 */
export function levelsFn(l: Levels): (v: number) => number {
  const inB = l.inBlack;
  const span = Math.max(1e-4, l.inWhite - inB);
  const g = Math.max(0.01, l.gamma);
  const outSpan = l.outWhite - l.outBlack;
  return (v: number): number => {
    const t = clamp01((v - inB) / span);
    // Gamma > 1 should brighten, matching the slider's direction of travel.
    return clamp01(l.outBlack + t ** (1 / g) * outSpan);
  };
}

/**
 * The whole tone chain as one table per channel.
 *
 * Levels, per-channel curve and master curve collapse into a single 256-entry
 * lookup — three composed functions cost exactly as much as one. The shader
 * uploads this as a 256x4 texture and never evaluates a spline itself.
 */
export function buildLUTs(curves: Curves, levels: Levels): Float32Array {
  const lv = levelsFn(levels);
  const master = monotoneSpline(curves.rgb);
  const per = [curves.r, curves.g, curves.b].map((c) => monotoneSpline(c));
  // Layout: [r0..r255, g0..g255, b0..b255], one row per channel.
  const out = new Float32Array(LUT_SIZE * 3);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < LUT_SIZE; i++) {
      const v = i / (LUT_SIZE - 1);
      out[c * LUT_SIZE + i] = clamp01(master(clamp01(per[c](lv(v)))));
    }
  }
  return out;
}

/** Insert a point, keeping the list sorted and free of duplicate x values. */
export function addCurvePoint(points: CurvePoint[], p: CurvePoint): CurvePoint[] {
  const next = points.filter((q) => Math.abs(q.x - p.x) > 0.008);
  next.push({ x: clamp01(p.x), y: clamp01(p.y) });
  return next.sort((a, b) => a.x - b.x);
}

/**
 * Move a point, with the ends pinned to their edges.
 *
 * The first and last handle keep their x so the curve always spans the full
 * range; letting them slide inwards would leave the tones beyond them
 * undefined, and every implementation resolves that differently.
 */
export function moveCurvePoint(points: CurvePoint[], index: number, p: CurvePoint): CurvePoint[] {
  const next = points.map((q) => ({ ...q }));
  if (index < 0 || index >= next.length) return next;
  const isFirst = index === 0;
  const isLast = index === next.length - 1;
  next[index].y = clamp01(p.y);
  if (!isFirst && !isLast) {
    // Keep a sliver of room either side so neighbouring handles cannot swap.
    const lo = next[index - 1].x + 0.008;
    const hi = next[index + 1].x - 0.008;
    next[index].x = Math.min(Math.max(clamp01(p.x), lo), hi);
  }
  return next;
}

export function removeCurvePoint(points: CurvePoint[], index: number): CurvePoint[] {
  if (points.length <= 2 || index <= 0 || index >= points.length - 1) return points;
  return points.filter((_, i) => i !== index);
}
