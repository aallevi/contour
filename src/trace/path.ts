/**
 * Path geometry.
 *
 * Everything that arrives from potrace and everything that leaves for SVG or
 * PDF passes through this normalised form: absolute coordinates, and only four
 * commands. Quadratics, shorthands and relative coordinates are all collapsed on
 * the way in, so no consumer downstream has to carry a parser of its own.
 */

export type PathCmd =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'Z' };

export type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

export const identity = (): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const scaleTranslate = (sx: number, sy: number, tx: number, ty: number): Matrix => ({
  a: sx, b: 0, c: 0, d: sy, e: tx, f: ty,
});

/** `m` then `n`, in that order, as one matrix. */
export function concat(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.b * n.c,
    b: m.a * n.b + m.b * n.d,
    c: m.c * n.a + m.d * n.c,
    d: m.c * n.b + m.d * n.d,
    e: m.e * n.a + m.f * n.c + n.e,
    f: m.e * n.b + m.f * n.d + n.f,
  };
}

/**
 * Parse an SVG path into absolute `M`/`L`/`C`/`Z`.
 *
 * Handles rather more than potrace emits, because the shape library accepts
 * imported SVG too and an illustrator's file is not a generator's. Elliptical
 * arcs are the one omission: potrace never produces them, and approximating
 * them properly is a page of code for a case that has not come up.
 */
export function parsePath(d: string): PathCmd[] {
  const out: PathCmd[] = [];
  let x = 0;
  let y = 0;
  // Where the current subpath began, which is where `Z` returns to.
  let sx = 0;
  let sy = 0;
  // Reflected control point, for the `S` and `T` shorthands.
  let px = 0;
  let py = 0;
  let prev = '';

  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  const num = (): number => Number(tokens[i++]);
  const quadToCubic = (qx: number, qy: number, ex: number, ey: number) => {
    const c1x = x + (2 / 3) * (qx - x);
    const c1y = y + (2 / 3) * (qy - y);
    const c2x = ex + (2 / 3) * (qx - ex);
    const c2y = ey + (2 / 3) * (qy - ey);
    out.push({ t: 'C', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: ex, y: ey });
    px = qx;
    py = qy;
    x = ex;
    y = ey;
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok;
      i++;
    } else if (cmd === 'M') {
      // A repeated coordinate pair after M is an implicit L, per the spec.
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    if (i >= tokens.length && !/[Zz]/.test(cmd)) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case 'M': {
        const nx = num();
        const ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        sx = x;
        sy = y;
        out.push({ t: 'M', x, y });
        break;
      }
      case 'L': {
        const nx = num();
        const ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'H': {
        const nx = num();
        x = rel ? x + nx : nx;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'V': {
        const ny = num();
        y = rel ? y + ny : ny;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'C': {
        const a1 = num(); const b1 = num();
        const a2 = num(); const b2 = num();
        const a3 = num(); const b3 = num();
        const x1 = rel ? x + a1 : a1;
        const y1 = rel ? y + b1 : b1;
        const x2 = rel ? x + a2 : a2;
        const y2 = rel ? y + b2 : b2;
        const ex = rel ? x + a3 : a3;
        const ey = rel ? y + b3 : b3;
        out.push({ t: 'C', x1, y1, x2, y2, x: ex, y: ey });
        px = x2;
        py = y2;
        x = ex;
        y = ey;
        break;
      }
      case 'S': {
        const a2 = num(); const b2 = num();
        const a3 = num(); const b3 = num();
        const x2 = rel ? x + a2 : a2;
        const y2 = rel ? y + b2 : b2;
        const ex = rel ? x + a3 : a3;
        const ey = rel ? y + b3 : b3;
        // Reflect the previous control point, or sit on the current point when
        // the previous command was not a cubic.
        const smooth = /[CS]/.test(prev.toUpperCase());
        const x1 = smooth ? 2 * x - px : x;
        const y1 = smooth ? 2 * y - py : y;
        out.push({ t: 'C', x1, y1, x2, y2, x: ex, y: ey });
        px = x2;
        py = y2;
        x = ex;
        y = ey;
        break;
      }
      case 'Q': {
        const a1 = num(); const b1 = num();
        const a3 = num(); const b3 = num();
        quadToCubic(rel ? x + a1 : a1, rel ? y + b1 : b1, rel ? x + a3 : a3, rel ? y + b3 : b3);
        break;
      }
      case 'T': {
        const a3 = num(); const b3 = num();
        const smooth = /[QT]/.test(prev.toUpperCase());
        const qx = smooth ? 2 * x - px : x;
        const qy = smooth ? 2 * y - py : y;
        quadToCubic(qx, qy, rel ? x + a3 : a3, rel ? y + b3 : b3);
        break;
      }
      case 'A': {
        // Consume the seven parameters and draw the chord. Never hit by potrace.
        num(); num(); num(); num(); num();
        const a3 = num(); const b3 = num();
        x = rel ? x + a3 : a3;
        y = rel ? y + b3 : b3;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'Z': {
        out.push({ t: 'Z' });
        x = sx;
        y = sy;
        break;
      }
      default:
        i++;
        break;
    }
    prev = C;
  }
  return out;
}

export function transformPath(cmds: PathCmd[], m: Matrix): PathCmd[] {
  const tx = (x: number, y: number): [number, number] => [
    m.a * x + m.c * y + m.e,
    m.b * x + m.d * y + m.f,
  ];
  return cmds.map((c) => {
    if (c.t === 'Z') return c;
    if (c.t === 'C') {
      const [x1, y1] = tx(c.x1, c.y1);
      const [x2, y2] = tx(c.x2, c.y2);
      const [x, y] = tx(c.x, c.y);
      return { t: 'C', x1, y1, x2, y2, x, y };
    }
    const [x, y] = tx(c.x, c.y);
    return { t: c.t, x, y };
  });
}

/**
 * Serialise back to an SVG `d` string.
 *
 * Rounding is the single biggest lever on file size here: a six-band trace of a
 * detailed photograph runs to tens of thousands of curves, and three decimals
 * rather than the full float is most of the difference between a two megabyte
 * file and a twelve megabyte one. Three decimals of a canvas pixel is far below
 * anything a printer resolves.
 */
export function toPathData(cmds: PathCmd[], precision = 3): string {
  const p = 10 ** precision;
  const f = (v: number): string => {
    const r = Math.round(v * p) / p;
    return Object.is(r, -0) ? '0' : String(r);
  };
  const parts: string[] = [];
  for (const c of cmds) {
    if (c.t === 'M') parts.push(`M${f(c.x)} ${f(c.y)}`);
    else if (c.t === 'L') parts.push(`L${f(c.x)} ${f(c.y)}`);
    else if (c.t === 'C') parts.push(`C${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)}`);
    else parts.push('Z');
  }
  return parts.join('');
}

export type BBox = { x: number; y: number; w: number; h: number };

/** Where a cubic turns back on one axis, as values of that coordinate. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t)/3 = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  const at = (t: number): number => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  const consider = (t: number) => {
    if (t > 0 && t < 1) out.push(at(t));
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) consider(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      consider((-b + root) / (2 * a));
      consider((-b - root) / (2 * a));
    }
  }
  return out;
}

/**
 * Tight bounds — the curve's own extent, not its control hull.
 *
 * The hull is the tempting shortcut and it is badly wrong here. potrace fits
 * long Béziers, and on a small shape their control points sit a long way
 * outside it: a 60 pixel disc comes back with a hull about thirty per cent too
 * wide, and lopsided, because the control points are not placed symmetrically.
 * Anything aimed with that — a radial gradient's radius above all — would be
 * aimed at a box the drawing does not occupy. Solving the derivative is one
 * quadratic per curve per axis, which is nothing next to having it right.
 */
export function pathBBox(cmds: PathCmd[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  let cx = 0;
  let cy = 0;
  for (const c of cmds) {
    if (c.t === 'Z') continue;
    if (c.t === 'C') {
      see(cx, cy);
      see(c.x, c.y);
      for (const v of cubicExtrema(cx, c.x1, c.x2, c.x)) see(v, cy);
      for (const v of cubicExtrema(cy, c.y1, c.y2, c.y)) see(cx, v);
    } else {
      see(c.x, c.y);
    }
    cx = c.x;
    cy = c.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
