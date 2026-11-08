import { luma } from '../core/color';
import type {
  Band, FreeformFill, FreePoint, GradientFill, GradientStop, HatchFill, Paint, RGB, SceneNode,
  StippleFill, Stop,
} from '../core/types';
import type { Mask } from '../band/mask';
import type { AdjustedImage } from '../image/adjust';
import { pathBBox, toPathData, type BBox, type PathCmd } from '../trace/path';

/**
 * Fills: what goes *inside* a traced region.
 *
 * All four read the band's own mask rather than its outline. The mask is
 * already in hand, it answers "is this point inside?" in one array lookup, and
 * it is the same answer the contour was fitted to — so a hatch line stops
 * exactly where the drawn edge is, without anyone having to intersect a ray
 * with a few thousand cubic Béziers.
 *
 * The cost is that a line end lands on the mask grid rather than on the curve.
 * At the trace resolutions this app works at that is a fraction of an output
 * pixel, and the ends are refined against a bilinearly interpolated mask to
 * halve it again.
 */

export type FillContext = {
  /** Shaped mask, at working resolution. */
  mask: Mask;
  /** The adjusted image, same resolution as the mask. */
  image: AdjustedImage;
  /** The traced contour, in canvas coordinates. */
  path: PathCmd[];
  /** Canvas pixels per working pixel. */
  scale: number;
  band: Band;
};

const solid = (rgb: RGB): Paint => ({ kind: 'solid', rgb });

// -- sampling ----------------------------------------------------------------

/** Region test, in working pixels. Outside the image counts as outside. */
function inside(mask: Mask, x: number, y: number): boolean {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return false;
  return mask.bits[iy * mask.width + ix] === 1;
}

/** Bilinear mask coverage, 0..1, for refining where an edge actually falls. */
function coverageAt(mask: Mask, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const get = (ix: number, iy: number): number =>
    ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height ? 0 : mask.bits[iy * mask.width + ix];
  return (
    get(x0, y0) * (1 - fx) * (1 - fy) +
    get(x0 + 1, y0) * fx * (1 - fy) +
    get(x0, y0 + 1) * (1 - fx) * fy +
    get(x0 + 1, y0 + 1) * fx * fy
  );
}

/** Ink amount at a point, 0 (paper) to 1 (black), from the adjusted image. */
function toneAt(image: AdjustedImage, x: number, y: number): number {
  const ix = Math.min(image.width - 1, Math.max(0, Math.round(x)));
  const iy = Math.min(image.height - 1, Math.max(0, Math.round(y)));
  const i = (iy * image.width + ix) * 4;
  return 1 - luma(image.rgba[i] / 255, image.rgba[i + 1] / 255, image.rgba[i + 2] / 255);
}

function colourAt(image: AdjustedImage, x: number, y: number): RGB {
  const ix = Math.min(image.width - 1, Math.max(0, Math.round(x)));
  const iy = Math.min(image.height - 1, Math.max(0, Math.round(y)));
  const i = (iy * image.width + ix) * 4;
  return [image.rgba[i] / 255, image.rgba[i + 1] / 255, image.rgba[i + 2] / 255];
}

/** Deterministic hash, so a stipple pattern is the same every time it is drawn. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// -- flat --------------------------------------------------------------------

function flatNode(ctx: FillContext, paint: Paint): SceneNode {
  return {
    kind: 'fill',
    d: toPathData(ctx.path),
    paint,
    rule: 'nonzero',
    opacity: 1,
  };
}

// -- gradient ----------------------------------------------------------------

/**
 * Where a region's own shading points.
 *
 * A least-squares plane through the region's tone: the gradient of the best
 * fitting `tone = ax + by + c` is the direction the region gets darker in. It
 * costs one pass of accumulation and it is the difference between a gradient
 * that follows the light in the photograph and one the user has to aim by hand
 * for every band.
 */
function toneAxis(ctx: FillContext): { dir: [number, number]; centroid: [number, number] } {
  const { mask, image } = ctx;
  let n = 0;
  let sx = 0; let sy = 0; let st = 0;
  let sxx = 0; let sxy = 0; let syy = 0; let sxt = 0; let syt = 0;
  // Every fourth pixel in each direction: the fit is over thousands of samples
  // either way, and the answer is a direction, not a measurement.
  const step = 4;
  for (let y = 0; y < mask.height; y += step) {
    for (let x = 0; x < mask.width; x += step) {
      if (!mask.bits[y * mask.width + x]) continue;
      const t = toneAt(image, x, y);
      n++;
      sx += x; sy += y; st += t;
      sxx += x * x; sxy += x * y; syy += y * y;
      sxt += x * t; syt += y * t;
    }
  }
  if (n < 8) return { dir: [0, 1], centroid: [mask.width / 2, mask.height / 2] };

  const mx = sx / n;
  const my = sy / n;
  const mt = st / n;
  const cxx = sxx / n - mx * mx;
  const cxy = sxy / n - mx * my;
  const cyy = syy / n - my * my;
  const cxt = sxt / n - mx * mt;
  const cyt = syt / n - my * mt;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-9) return { dir: [0, 1], centroid: [mx, my] };
  const a = (cyt * cxy - cxt * cyy) / det * -1;
  const b = (cxt * cxy - cyt * cxx) / det * -1;
  const len = Math.hypot(a, b);
  // A region of flat tone has no direction to offer; top-to-bottom is the
  // convention everything else in the panel assumes.
  if (len < 1e-7) return { dir: [0, 1], centroid: [mx, my] };
  return { dir: [a / len, b / len], centroid: [mx, my] };
}

/** Mean colour of the region within a band of projections, for sampled stops. */
function meanColourInSlab(
  ctx: FillContext,
  dir: [number, number],
  lo: number,
  hi: number,
): RGB | null {
  const { mask, image } = ctx;
  let n = 0;
  let r = 0; let g = 0; let b = 0;
  const step = 3;
  for (let y = 0; y < mask.height; y += step) {
    for (let x = 0; x < mask.width; x += step) {
      if (!mask.bits[y * mask.width + x]) continue;
      const proj = x * dir[0] + y * dir[1];
      if (proj < lo || proj > hi) continue;
      const c = colourAt(image, x, y);
      r += c[0]; g += c[1]; b += c[2];
      n++;
    }
  }
  return n === 0 ? null : [r / n, g / n, b / n];
}

/** The stop list, cleaned: at least two, ascending, offsets inside 0..1. */
export function normaliseStops(stops: GradientStop[] | undefined, fallback: RGB): GradientStop[] {
  const clean = (stops ?? [])
    .filter((s) => s && Array.isArray(s.rgb) && Number.isFinite(s.offset))
    .map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), rgb: s.rgb }))
    .sort((a, b) => a.offset - b.offset);
  if (clean.length === 0) {
    return [{ offset: 0, rgb: fallback }, { offset: 1, rgb: fallback }];
  }
  if (clean.length === 1) {
    return [{ offset: 0, rgb: clean[0].rgb }, { offset: 1, rgb: clean[0].rgb }];
  }
  return clean;
}

/**
 * Where the ramp's two ends sit, in projection units along the axis.
 *
 * The region's own extent sets the scale and `start`/`end` say where the ramp
 * lands on it. Pinning the ends to the extent — which is what this did before,
 * with no way to say otherwise — means every gradient on every band shows
 * exactly one full sweep of the ramp, and the only thing left to vary is the
 * two colours. Letting the ends run outside 0..1 is what turns a gradient from
 * a fact about the region into something you can aim.
 */
export function rampExtent(
  lo: number,
  hi: number,
  start: number,
  end: number,
): { a: number; b: number } {
  const span = hi - lo;
  const a = lo + span * start;
  const b = lo + span * end;
  // A zero-length ramp has no direction and SVG draws it as nothing at all.
  // Half a working pixel apart is a hard edge, which is a legitimate thing to
  // ask for and still a gradient.
  if (Math.abs(b - a) < 1e-4) return { a, b: a + 1e-4 };
  return { a, b };
}

/**
 * The axis and extent a gradient is drawn along, in working-pixel projections.
 *
 * Shared by the renderer and by `Take colours` in the panel, so the colours the
 * button bakes are the ones that were on screen rather than a second, slightly
 * different reading.
 */
function gradientAxis(
  ctx: FillContext,
  fill: GradientFill,
): { dir: [number, number]; lo: number; hi: number } | null {
  const auto = fill.angle === 'auto';
  const dir: [number, number] = auto
    ? toneAxis(ctx).dir
    : [Math.cos(((fill.angle as number) * Math.PI) / 180), Math.sin(((fill.angle as number) * Math.PI) / 180)];

  const { mask } = ctx;
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < mask.height; y += 2) {
    for (let x = 0; x < mask.width; x += 2) {
      if (!mask.bits[y * mask.width + x]) continue;
      const proj = x * dir[0] + y * dir[1];
      if (proj < lo) lo = proj;
      if (proj > hi) hi = proj;
    }
  }
  if (!Number.isFinite(lo)) return null;
  return { dir, lo, hi: hi - lo < 1e-6 ? lo + 1 : hi };
}

/** What `sampled` would draw right now, as a stop list the document can keep. */
export function gradientStopsFor(ctx: FillContext, fill: GradientFill): GradientStop[] | null {
  const axis = gradientAxis(ctx, fill);
  if (!axis) return null;
  const base = normaliseStops(fill.stops, ctx.band.colour);
  const { a, b } = rampExtent(axis.lo, axis.hi, fill.start ?? 0, fill.end ?? 1);
  return sampleStops(ctx, axis.dir, a, b, base).map((s) => ({ offset: s.offset, rgb: s.rgb }));
}

function gradientPaint(ctx: FillContext, fill: GradientFill, bbox: BBox): Paint {
  const { scale } = ctx;
  const axis = gradientAxis(ctx, fill);
  if (!axis) return solid(ctx.band.colour);
  const { dir, lo, hi } = axis;

  const base = normaliseStops(fill.stops, ctx.band.colour);
  const { a, b } = rampExtent(lo, hi, fill.start ?? 0, fill.end ?? 1);
  const stops: Stop[] = fill.sampled
    ? sampleStops(ctx, dir, a, b, base)
    : base.map((s) => ({ offset: s.offset, rgb: s.rgb }));

  if (fill.shape === 'radial') {
    // The centre is given in the region's own bounding box, so moving it means
    // the same thing on every band regardless of where the band sits.
    const cx = bbox.x + bbox.w * (fill.cx ?? 0.5);
    const cy = bbox.y + bbox.h * (fill.cy ?? 0.5);
    const half = Math.hypot(bbox.w, bbox.h) / 2;
    return {
      kind: 'radial',
      cx,
      cy,
      r: Math.max(1e-3, half * (fill.radius ?? 1)),
      stops,
    };
  }
  return {
    kind: 'linear',
    x1: a * dir[0] * scale,
    y1: a * dir[1] * scale,
    x2: b * dir[0] * scale,
    y2: b * dir[1] * scale,
    stops,
  };
}

/**
 * Read each stop's colour off the photograph at its own position on the ramp.
 *
 * The old version sampled the two ends and interpolated, which gave a gradient
 * that agreed with the photograph in exactly two places. Reading every stop
 * means the ramp bends where the light does, and adding a stop is how you ask
 * for more fidelity rather than another colour to choose.
 */
function sampleStops(
  ctx: FillContext,
  dir: [number, number],
  a: number,
  b: number,
  base: GradientStop[],
): Stop[] {
  const span = b - a;
  // A slab rather than a line: one row of pixels on a photograph is as likely
  // to be a speck of noise as it is the tone. An eighth of the ramp either side
  // averages enough to be stable without flattening the ends into each other.
  const half = Math.abs(span) * 0.125 + 1;
  return base.map((s) => {
    const centre = a + span * s.offset;
    const lo = Math.min(centre - half, centre + half);
    const hi = Math.max(centre - half, centre + half);
    return { offset: s.offset, rgb: meanColourInSlab(ctx, dir, lo, hi) ?? s.rgb };
  });
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// -- freeform ----------------------------------------------------------------

/**
 * The alpha falloff of one colour point, as four stops.
 *
 * A straight ramp from opaque to clear leaves a visible ring where the blob
 * ends, because the eye is good at finding the discontinuity in the *slope* of
 * a gradient even when the value is continuous. These four offsets trace a
 * smoothstep, whose slope is zero at both ends, and that is the difference
 * between a soft light and a bullseye.
 */
const FALLOFF: [number, number][] = [
  [0, 1],
  [0.4, 0.648],
  [0.75, 0.156],
  [1, 0],
];

/** Where a freeform point lands, in canvas units, given the region's box. */
export function freePointGeometry(
  p: FreePoint,
  bbox: BBox,
): { cx: number; cy: number; r: number } {
  const diagonal = Math.hypot(bbox.w, bbox.h);
  return {
    cx: bbox.x + bbox.w * p.x,
    cy: bbox.y + bbox.h * p.y,
    // A point with no reach is a point nobody can see, and a radial gradient of
    // radius zero is undefined in SVG rather than merely invisible.
    r: Math.max(1e-3, diagonal * Math.max(0.001, p.radius)),
  };
}

/**
 * One node for the ground, then one per colour point, painted in list order.
 *
 * Every node carries the region's own path rather than a clip, which is the
 * same choice the rest of this module makes. The path string is shared by
 * reference in memory, the SVG writer emits it once and references it, and the
 * PDF content stream repeats it into a deflate that eats the repetition — so
 * the cost of the Nth point is the gradient, not the geometry.
 */
function freeformNodes(ctx: FillContext, fill: FreeformFill, bbox: BBox): SceneNode[] {
  const d = toPathData(ctx.path);
  const nodes: SceneNode[] = [{
    kind: 'fill',
    d,
    paint: solid(fill.base ?? ctx.band.colour),
    rule: 'nonzero',
    opacity: 1,
  }];

  for (const p of fill.points ?? []) {
    const { cx, cy, r } = freePointGeometry(p, bbox);
    nodes.push({
      kind: 'fill',
      d,
      paint: {
        kind: 'radial',
        cx,
        cy,
        r,
        stops: FALLOFF.map(([offset, alpha]) => ({ offset, rgb: p.rgb, alpha })),
      },
      rule: 'nonzero',
      opacity: 1,
    });
  }
  return nodes;
}

/**
 * Read the photograph under each point, so a scattered set becomes a likeness.
 *
 * This is the whole workflow: drop a handful of points on the drawing, press
 * the button, and the region is shaded the way the photograph is. Each point
 * takes the mean colour of the region within its own reach rather than the one
 * pixel underneath it, because a single pixel on a photograph is as likely to
 * be noise as it is the tone.
 */
export function sampleFreePoints(ctx: FillContext, fill: FreeformFill): FreePoint[] {
  const bbox = pathBBox(ctx.path);
  const inv = 1 / ctx.scale;
  return (fill.points ?? []).map((p) => {
    const { cx, cy, r } = freePointGeometry(p, bbox);
    const mean = meanColourInDisc(ctx, cx * inv, cy * inv, Math.max(1, r * inv * 0.6));
    return mean ? { ...p, rgb: mean } : p;
  });
}

/**
 * Scatter colour points over the region and read the photograph under each.
 *
 * The one-press version of the whole freeform workflow. Candidates come from a
 * jittered grid rather than pure randomness — random points on a small region
 * clump, and a clump of four colour blobs in one corner is worse than nothing —
 * and only those that land inside the mask are kept, so a crescent-shaped band
 * gets its points along the crescent instead of in the hole.
 */
export function scatterFreePoints(
  ctx: FillContext,
  count: number,
  ids: () => string,
): FreePoint[] {
  const bbox = pathBBox(ctx.path);
  if (bbox.w <= 0 || bbox.h <= 0) return [];
  const want = Math.max(1, Math.min(48, Math.round(count)));
  const inv = 1 / ctx.scale;

  // A grid shaped like the region, sized so that roughly half the cells landing
  // inside still leaves enough points to choose from.
  const aspect = bbox.w / bbox.h;
  const cols = Math.max(1, Math.round(Math.sqrt(want * 2 * aspect)));
  const rows = Math.max(1, Math.ceil((want * 2) / cols));

  const inside: { x: number; y: number }[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // Deterministic jitter: the same region scatters the same way twice, so
      // pressing the button again is a refinement rather than a dice roll.
      const jx = (hash2(i, j, 7) - 0.5) * 0.7;
      const jy = (hash2(i, j, 91) - 0.5) * 0.7;
      const fx = (i + 0.5 + jx) / cols;
      const fy = (j + 0.5 + jy) / rows;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
      const cx = bbox.x + bbox.w * fx;
      const cy = bbox.y + bbox.h * fy;
      if (!inside0(ctx, cx * inv, cy * inv)) continue;
      inside.push({ x: fx, y: fy });
    }
  }
  if (inside.length === 0) return [];

  // Evenly thin the survivors down to the number asked for, rather than taking
  // the first N, which would all come from the top of the region.
  const step = inside.length / Math.min(want, inside.length);
  const chosen: FreePoint[] = [];
  for (let k = 0; k < Math.min(want, inside.length); k++) {
    const { x, y } = inside[Math.floor(k * step)];
    chosen.push({
      id: ids(),
      x,
      y,
      rgb: ctx.band.colour,
      // Reach enough to overlap its neighbours: gaps between blobs show the
      // base colour through and read as blotches rather than as shading.
      radius: Math.max(0.18, 0.9 / Math.sqrt(Math.min(want, inside.length))),
    });
  }
  return sampleFreePoints(ctx, { kind: 'freeform', base: ctx.band.colour, points: chosen });
}

const inside0 = (ctx: FillContext, x: number, y: number): boolean => inside(ctx.mask, x, y);

/** Mean colour of the region inside a disc, in working pixels. */
function meanColourInDisc(
  ctx: FillContext,
  cx: number,
  cy: number,
  radius: number,
): RGB | null {
  const { mask, image } = ctx;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(mask.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(mask.height - 1, Math.ceil(cy + radius));

  let n = 0;
  let r = 0; let g = 0; let b = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!mask.bits[y * mask.width + x]) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      const c = colourAt(image, x, y);
      r += c[0]; g += c[1]; b += c[2];
      n++;
    }
  }
  // A point dropped outside the region, or on a sliver too thin to hold its
  // disc, keeps the colour it had rather than jumping to black.
  return n === 0 ? null : [r / n, g / n, b / n];
}

// -- hatch -------------------------------------------------------------------

type Run = { t0: number; t1: number };

/**
 * Where one hatch line crosses the region.
 *
 * Marched in working-pixel steps and then refined: once a run's end is bracketed
 * between an inside sample and an outside one, four bisections on the
 * interpolated mask put it within a sixteenth of a working pixel, which is well
 * under an output pixel at any sensible trace resolution. Without that step the
 * ends of every line land on the sample grid and a field of hatching visibly
 * frays along its edge.
 */
function runsAlongLine(
  mask: Mask,
  ox: number,
  oy: number,
  ux: number,
  uy: number,
  tMin: number,
  tMax: number,
  step: number,
): Run[] {
  const runs: Run[] = [];
  const isIn = (t: number): boolean => inside(mask, ox + ux * t, oy + uy * t);
  const refine = (a: number, b: number): number => {
    // `a` is inside, `b` is outside.
    for (let i = 0; i < 4; i++) {
      const m = (a + b) / 2;
      if (coverageAt(mask, ox + ux * m, oy + uy * m) >= 0.5) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };

  let openAt = NaN;
  let prev = false;
  let prevT = tMin;
  for (let t = tMin; t <= tMax; t += step) {
    const cur = isIn(t);
    if (cur && !prev) openAt = refine(t, prevT);
    else if (!cur && prev) runs.push({ t0: openAt, t1: refine(prevT, t) });
    prev = cur;
    prevT = t;
  }
  if (prev) runs.push({ t0: openAt, t1: tMax });
  return runs;
}

function hatchNodes(ctx: FillContext, fill: HatchFill, bbox: BBox): SceneNode[] {
  const nodes: SceneNode[] = [];
  const band = ctx.band;
  if (fill.base > 0.001) {
    nodes.push({
      kind: 'fill',
      d: toPathData(ctx.path),
      paint: solid(band.colour),
      rule: 'nonzero',
      opacity: fill.base,
    });
  }

  const angles = [fill.angle];
  if (fill.cross) angles.push(fill.angle + fill.crossAngle);

  const strokeParts: string[] = [];
  const ribbonParts: string[] = [];

  for (const deg of angles) {
    const a = (deg * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const nx = -uy;
    const ny = ux;

    // Project the region's bounds onto both axes to bracket the sweep.
    const corners: [number, number][] = [
      [bbox.x, bbox.y],
      [bbox.x + bbox.w, bbox.y],
      [bbox.x, bbox.y + bbox.h],
      [bbox.x + bbox.w, bbox.y + bbox.h],
    ];
    let nMin = Infinity; let nMax = -Infinity;
    let uMin = Infinity; let uMax = -Infinity;
    for (const [cx, cy] of corners) {
      const pn = cx * nx + cy * ny;
      const pu = cx * ux + cy * uy;
      nMin = Math.min(nMin, pn); nMax = Math.max(nMax, pn);
      uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu);
    }

    // Cap the sweep: a spacing slider dragged to its minimum on a large canvas
    // could otherwise ask for hundreds of thousands of lines and lock the UI
    // for the several seconds it takes to generate marks nobody can see.
    //
    // The cap widens the spacing rather than skipping lines. Skipping was the
    // first way round it and the wrong one: the drawing came back with the
    // spacing the panel said, but a random half of its lines missing, so
    // dragging the slider past the limit made the hatching thin out instead of
    // tighten. Widening keeps the field even, and `hatchSpacing` is exported so
    // the panel can say what it actually used.
    const spacing = hatchSpacing(fill.spacing, nMax - nMin);
    // March in steps of one working pixel, expressed in canvas units. The mask
    // has no detail finer than that, so a smaller step buys nothing.
    const step = Math.max(0.25, ctx.scale);

    for (let k = Math.ceil(nMin / spacing); k * spacing <= nMax; k++) {
      const off = k * spacing;
      const ox = nx * off;
      const oy = ny * off;
      // Runs are found in working pixels; the line itself lives in canvas ones.
      const inv = 1 / ctx.scale;
      // The line is parameterised in canvas units; the mask is sampled in
      // working ones. Scaling the origin and the direction by `inv` converts
      // the whole ray once, so `t` keeps meaning canvas distance throughout.
      const runs = runsAlongLine(
        ctx.mask,
        ox * inv, oy * inv,
        ux * inv, uy * inv,
        uMin, uMax, step,
      );

      for (const run of runs) {
        if (run.t1 - run.t0 < spacing * 0.15) continue;
        if (fill.toneWeight > 0.001) {
          ribbonParts.push(ribbon(ctx, fill, ox, oy, ux, uy, nx, ny, run));
        } else {
          strokeParts.push(straightOrWavy(fill, ox, oy, ux, uy, nx, ny, run));
        }
      }
    }
  }

  if (strokeParts.length) {
    nodes.push({
      kind: 'stroke',
      d: strokeParts.join(''),
      rgb: band.colour,
      width: Math.max(0.05, fill.weight),
      opacity: 1,
      cap: 'round',
    });
  }
  if (ribbonParts.length) {
    nodes.push({
      kind: 'fill',
      d: ribbonParts.join(''),
      paint: solid(band.colour),
      rule: 'nonzero',
      opacity: 1,
    });
  }
  return nodes;
}

/** The most marks either shading fill will generate in one band. */
export const MAX_HATCH_LINES = 4000;
export const MAX_STIPPLE_DOTS = 200_000;

/**
 * The spacing hatching will actually use, given how far it has to sweep.
 *
 * Never tighter than the cap allows, so the count stays bounded — and never
 * looser than asked for, so the control is honest everywhere it can be.
 */
export function hatchSpacing(asked: number, span: number): number {
  const wanted = Math.max(0.4, asked);
  if (!(span > 0)) return wanted;
  return Math.max(wanted, span / MAX_HATCH_LINES);
}

/**
 * The stipple pitch actually used, for the same reason.
 *
 * The dot count grows with the *square* of the pitch, so a slider at its
 * minimum over a large region is tens of millions of candidates. Opening the
 * pitch up keeps the scatter even; thinning it out by skipping cells, which is
 * what this used to do, silently turned the density slider into a random one.
 */
export function stipplePitch(asked: number, area: number): number {
  const wanted = Math.max(0.6, asked);
  if (!(area > 0)) return wanted;
  return Math.max(wanted, Math.sqrt(area / MAX_STIPPLE_DOTS));
}

const f3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/** One hatch line as a stroked segment, straight or waved. */
function straightOrWavy(
  fill: HatchFill,
  ox: number, oy: number,
  ux: number, uy: number,
  nx: number, ny: number,
  run: Run,
): string {
  if (fill.wave < 0.01) {
    return `M${f3(ox + ux * run.t0)} ${f3(oy + uy * run.t0)}L${f3(ox + ux * run.t1)} ${f3(oy + uy * run.t1)}`;
  }
  const len = run.t1 - run.t0;
  const wl = Math.max(2, fill.waveLength);
  const steps = Math.max(2, Math.min(400, Math.ceil(len / (wl / 8))));
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = run.t0 + (len * i) / steps;
    const d = Math.sin((t / wl) * Math.PI * 2) * fill.wave;
    parts.push(`${i === 0 ? 'M' : 'L'}${f3(ox + ux * t + nx * d)} ${f3(oy + uy * t + ny * d)}`);
  }
  return parts.join('');
}

/**
 * One hatch line as a filled ribbon whose width follows the tone underneath.
 *
 * This is the engraving move, and it is why the fill reads as shading rather
 * than as texture: a line that swells in the shadow and tapers out in the light
 * carries tone the way a burin does, with no change in spacing. It is emitted as
 * a closed polygon — one edge out, the other back — because SVG and PDF both
 * have variable-width strokes in exactly the same place, which is nowhere.
 */
function ribbon(
  ctx: FillContext,
  fill: HatchFill,
  ox: number, oy: number,
  ux: number, uy: number,
  nx: number, ny: number,
  run: Run,
): string {
  const len = run.t1 - run.t0;
  const sampleEvery = Math.max(1.5, fill.spacing * 0.5);
  const steps = Math.max(2, Math.min(600, Math.ceil(len / sampleEvery)));
  const inv = 1 / ctx.scale;
  const half: number[] = [];
  const px: number[] = [];
  const py: number[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = run.t0 + (len * i) / steps;
    const wobble = fill.wave < 0.01 ? 0 : Math.sin((t / Math.max(2, fill.waveLength)) * Math.PI * 2) * fill.wave;
    const x = ox + ux * t + nx * wobble;
    const y = oy + uy * t + ny * wobble;
    const tone = toneAt(ctx.image, x * inv, y * inv);
    // Taper the last sample at each end to a point, so a ribbon ends like a
    // stroke rather than stopping square.
    const endFade = Math.min(1, Math.min(i, steps - i) / 1.5);
    const w = fill.weight * (1 - fill.toneWeight + fill.toneWeight * tone) * endFade;
    px.push(x);
    py.push(y);
    half.push(Math.max(0, w) / 2);
  }

  const out: string[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push(`${i === 0 ? 'M' : 'L'}${f3(px[i] + nx * half[i])} ${f3(py[i] + ny * half[i])}`);
  }
  for (let i = steps; i >= 0; i--) {
    out.push(`L${f3(px[i] - nx * half[i])} ${f3(py[i] - ny * half[i])}`);
  }
  out.push('Z');
  return out.join('');
}

// -- stipple -----------------------------------------------------------------

/** A circle as four cubics — the standard approximation, exact to 2 parts in 10^4. */
const K = 0.5522847498;

function circlePath(cx: number, cy: number, r: number): string {
  const k = r * K;
  return (
    `M${f3(cx + r)} ${f3(cy)}` +
    `C${f3(cx + r)} ${f3(cy + k)} ${f3(cx + k)} ${f3(cy + r)} ${f3(cx)} ${f3(cy + r)}` +
    `C${f3(cx - k)} ${f3(cy + r)} ${f3(cx - r)} ${f3(cy + k)} ${f3(cx - r)} ${f3(cy)}` +
    `C${f3(cx - r)} ${f3(cy - k)} ${f3(cx - k)} ${f3(cy - r)} ${f3(cx)} ${f3(cy - r)}` +
    `C${f3(cx + k)} ${f3(cy - r)} ${f3(cx + r)} ${f3(cy - k)} ${f3(cx + r)} ${f3(cy)}Z`
  );
}

function stippleNodes(ctx: FillContext, fill: StippleFill, bbox: BBox): SceneNode[] {
  const nodes: SceneNode[] = [];
  if (fill.base > 0.001) {
    nodes.push({
      kind: 'fill',
      d: toPathData(ctx.path),
      paint: solid(ctx.band.colour),
      rule: 'nonzero',
      opacity: fill.base,
    });
  }

  // Same guard as hatching, and for the same reason: the pitch opens up rather
  // than the grid being sampled, so the scatter stays even.
  const pitch = stipplePitch(fill.spacing, bbox.w * bbox.h);
  const inv = 1 / ctx.scale;
  const cols = Math.ceil(bbox.w / pitch) + 2;
  const rows = Math.ceil(bbox.h / pitch) + 2;

  const parts: string[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const jx = (hash2(i, j, fill.seed) - 0.5) * fill.jitter * pitch;
      const jy = (hash2(i, j, fill.seed + 77) - 0.5) * fill.jitter * pitch;
      const x = bbox.x + i * pitch + jx;
      const y = bbox.y + j * pitch + jy;
      if (!inside(ctx.mask, x * inv, y * inv)) continue;

      const tone = toneAt(ctx.image, x * inv, y * inv);
      if (fill.toneDrop > 0.001) {
        const keep = 1 - fill.toneDrop + fill.toneDrop * tone;
        if (hash2(i, j, fill.seed + 991) > keep) continue;
      }
      const r = (fill.size * (1 - fill.toneSize + fill.toneSize * tone)) / 2;
      if (r < 0.03) continue;
      parts.push(circlePath(x, y, r));
    }
  }

  if (parts.length) {
    nodes.push({
      kind: 'fill',
      d: parts.join(''),
      paint: solid(ctx.band.colour),
      rule: 'nonzero',
      opacity: 1,
    });
  }
  return nodes;
}

// -- entry point -------------------------------------------------------------

/** Everything a band contributes to the scene, fill and outline both. */
export function buildBandNodes(ctx: FillContext): SceneNode[] {
  const band = ctx.band;
  if (!band.visible || band.opacity <= 0 || ctx.path.length === 0) return [];
  const bbox = pathBBox(ctx.path);
  const fill = band.fill;

  let nodes: SceneNode[];
  switch (fill.kind) {
    case 'gradient':
      nodes = [flatNode(ctx, gradientPaint(ctx, fill, bbox))];
      break;
    case 'freeform':
      nodes = freeformNodes(ctx, fill, bbox);
      break;
    case 'hatch':
      nodes = hatchNodes(ctx, fill, bbox);
      break;
    case 'stipple':
      nodes = stippleNodes(ctx, fill, bbox);
      break;
    default:
      nodes = [flatNode(ctx, solid(band.colour))];
      break;
  }

  if (band.outline.on && band.outline.width > 0) {
    nodes.push({
      kind: 'stroke',
      d: toPathData(ctx.path),
      rgb: band.outline.colour,
      width: band.outline.width,
      opacity: 1,
      cap: 'round',
    });
  }
  return nodes;
}
