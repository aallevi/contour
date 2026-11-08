import type { TraceParams } from '../core/types';
import type { Mask } from '../band/mask';
import { transformPath, type Matrix, type PathCmd } from './path';

/**
 * A tracer for when potrace is not there.
 *
 * `npm run dev` runs in a browser tab with no subprocesses at all, and a
 * bundled app can find itself on a machine where nobody has run
 * `brew install potrace` yet. Neither should leave a blank canvas, so this
 * follows the same three steps potrace does — extract the boundary, simplify
 * it, fit curves to it — with the simplest honest method for each.
 *
 * It is not a reimplementation and does not pretend to be: potrace's polygon
 * stage solves for the globally optimal polygon and its curve stage fits
 * corner-aware Béziers with an adjustable corner threshold. This is
 * Douglas–Peucker and Catmull–Rom. The shapes are recognisably the same and the
 * difference shows in the details, which is exactly where it should.
 */

type Point = [number, number];

/**
 * The staircase boundary of a region, as closed loops.
 *
 * Every unit edge between a foreground pixel and a background one is emitted
 * directed so the region lies to its left, then the edges are chained. Getting
 * the direction from that rule rather than fixing it up afterwards is what
 * makes outer contours and holes come out wound oppositely, which is what
 * nonzero filling needs to put holes in shapes.
 */
export function boundaryLoops(mask: Mask): Point[][] {
  const { width: w, height: h, bits } = mask;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : bits[y * w + x];

  // Keyed by start vertex on the (w+1) x (h+1) lattice.
  const outgoing = new Map<number, number[]>();
  const key = (x: number, y: number): number => y * (w + 1) + x;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = outgoing.get(k);
    if (list) list.push(key(x1, y1));
    else outgoing.set(k, [key(x1, y1)]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x + 1, y, x, y);         // top, walked leftwards
      if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1); // bottom, rightwards
      if (!at(x - 1, y)) add(x, y, x, y + 1);         // left, downwards
      if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y); // right, upwards
    }
  }

  const loops: Point[][] = [];
  for (const start of [...outgoing.keys()]) {
    while ((outgoing.get(start)?.length ?? 0) > 0) {
      const loop: Point[] = [];
      let cur = start;
      // A lattice vertex where two diagonal corners touch has two ways out.
      // Taking either one still closes a valid loop, so pop and move on rather
      // than trying to disambiguate a case the bitmap itself leaves ambiguous.
      for (let guard = 0; guard < w * h * 4 + 8; guard++) {
        const list = outgoing.get(cur);
        if (!list || list.length === 0) break;
        const next = list.pop()!;
        if (list.length === 0) outgoing.delete(cur);
        loop.push([cur % (w + 1), Math.floor(cur / (w + 1))]);
        cur = next;
        if (cur === start) break;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 4 || tolerance <= 0) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // An explicit stack: a photograph's largest region can run to a hundred
  // thousand boundary points, which recursion does not survive.
  const stack: [number, number][] = [[0, points.length - 1]];
  const t2 = tolerance * tolerance;

  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const [ax, ay] = points[lo];
    const [bx, by] = points[hi];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = points[i];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const cross = (px - ax) * dy - (py - ay) * dx;
        d2 = (cross * cross) / len2;
      }
      if (d2 > worst) {
        worst = d2;
        worstAt = i;
      }
    }
    if (worst > t2 && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Catmull–Rom through the simplified points, converted to cubics, with sharp
 * turns left sharp.
 *
 * `alphamax` is read the way potrace reads it: 0 keeps every vertex a corner,
 * and higher values let more of them round off. The mapping is not potrace's —
 * there is no smooth-curve optimisation stage here for it to feed — but the
 * slider moves the result in the same direction, which is what matters when
 * the two tracers have to share one control.
 */
function fitCurves(points: Point[], alphamax: number): PathCmd[] {
  const n = points.length;
  if (n < 3) return [];
  const out: PathCmd[] = [{ t: 'M', x: points[0][0], y: points[0][1] }];
  // Above this turn, the vertex stays a corner.
  //
  // The curve is cubed rather than linear so that the two tracers agree at the
  // setting that matters. Fed a rectangle, potrace keeps the corners perfectly
  // square at alphamax 0, 0.5 and 1, and only rounds them at its maximum of
  // 1.334 — so a right angle has to fall on the corner side of this threshold
  // at the default and on the smooth side only at the very top of the range.
  const threshold = Math.PI * 0.989 * Math.min(1, alphamax / 1.334) ** 3;
  const cornerCos = Math.cos(threshold);

  const at = (i: number): Point => points[((i % n) + n) % n];
  const isCorner = (i: number): boolean => {
    const [px, py] = at(i - 1);
    const [cx, cy] = at(i);
    const [nx, ny] = at(i + 1);
    const ax = cx - px;
    const ay = cy - py;
    const bx = nx - cx;
    const by = ny - cy;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) return true;
    return (ax * bx + ay * by) / (la * lb) < cornerCos;
  };

  const corner = points.map((_, i) => isCorner(i));

  /**
   * The unit tangent at a vertex, or null where it is a corner.
   *
   * Scaling comes later, from the length of the segment being drawn. Taking the
   * tangent as `(next - prev) / 6` the way plain Catmull-Rom does is what
   * breaks on traced boundaries: after simplification the points are wildly
   * unevenly spaced, so a one-pixel segment sitting next to a fifty-pixel one
   * gets a tangent fifty pixels long and the curve bulges right out of the
   * shape it is supposed to describe.
   */
  const tangent = (i: number): [number, number] | null => {
    if (corner[((i % n) + n) % n]) return null;
    const [px, py] = at(i - 1);
    const [nx, ny] = at(i + 1);
    const dx = nx - px;
    const dy = ny - py;
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : [dx / len, dy / len];
  };

  for (let i = 0; i < n; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    if (corner[i % n] && corner[(i + 1) % n]) {
      out.push({ t: 'L', x: p2[0], y: p2[1] });
      continue;
    }
    const t1 = tangent(i);
    const t2 = tangent(i + 1);
    // A third of the chord is the standard scaling: it reproduces a straight
    // line exactly and keeps the curve inside the hull of its own endpoints.
    const third = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 3;
    out.push({
      t: 'C',
      x1: p1[0] + (t1 ? t1[0] * third : 0),
      y1: p1[1] + (t1 ? t1[1] * third : 0),
      x2: p2[0] - (t2 ? t2[0] * third : 0),
      y2: p2[1] - (t2 ? t2[1] * third : 0),
      x: p2[0], y: p2[1],
    });
  }
  out.push({ t: 'Z' });
  return out;
}

/** Shoelace area, for dropping speckles the way `turdsize` does. */
function loopArea(points: Point[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(a) / 2;
}

export function traceFallback(mask: Mask, params: TraceParams, toCanvas: Matrix): PathCmd[] {
  // Tolerance tracks the optimisation tolerance, so the two tracers respond to
  // the same slider in the same direction.
  const tolerance = Math.max(0.35, params.opttolerance * 3.2);
  const minArea = Math.max(0, params.turdsize);
  const cmds: PathCmd[] = [];
  for (const loop of boundaryLoops(mask)) {
    if (loopArea(loop) < minArea) continue;
    const simplified = simplify(loop, tolerance);
    if (simplified.length < 3) continue;
    cmds.push(...fitCurves(simplified, params.alphamax));
  }
  return transformPath(cmds, toCanvas);
}
