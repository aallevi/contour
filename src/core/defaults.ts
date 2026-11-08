import { mixLab, ramp, shade } from './color';
import { bandFromPixels } from './scale';
import type {
  Adjust, Band, Banding, Curves, Fill, FreeformFill, FreePoint, GradientFill, GradientStop,
  Project, RGB, TraceParams, Tracer, VtraceParams,
} from './types';

export const ID = (): string => Math.random().toString(36).slice(2, 10);

/** The identity curve: two points, corner to corner. */
export const identityCurve = (): { x: number; y: number }[] => [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const identityCurves = (): Curves => ({
  rgb: identityCurve(),
  r: identityCurve(),
  g: identityCurve(),
  b: identityCurve(),
});

export const defaultAdjust = (): Adjust => ({
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 1,
  hue: 0,
  levels: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 },
  curves: identityCurves(),
  // A touch of blur by default. Tracing a photograph with none of it is the
  // single most common way to end up with a file full of noise-shaped contours,
  // and the first thing anyone is told to do about it is exactly this.
  blur: 1.2,
  sharpen: 0,
  denoise: 0,
  invert: false,
});

export const defaultTrace = (): TraceParams => ({
  turdsize: 4,
  alphamax: 1,
  opttolerance: 0.2,
  longcurve: false,
  turnpolicy: 'minority',
  unit: 10,
});

/**
 * vtracer's defaults, adjusted for what it is being fed here.
 *
 * The crate's own defaults are tuned for tracing a whole photograph in colour
 * mode. These masks arrive already posterised, already smoothed and already
 * speckle-free, so the corner threshold can be tighter — 60 degrees rounds off
 * the deliberate corners a blurred mask still has — and the speckle filter can
 * be gentler than it would need to be on raw pixels.
 */
export const defaultVtrace = (): VtraceParams => ({
  speckle: 4,
  mode: 'spline',
  cornerThreshold: 75,
  lengthThreshold: 4,
  spliceThreshold: 45,
  precision: 3,
});

export const defaultFill = (): Fill => ({ kind: 'flat' });

/**
 * A gradient that can be seen the moment it is switched on.
 *
 * The old default put the band's own colour at both ends, so choosing Gradient
 * changed precisely nothing on screen and the only way to find out the feature
 * worked was to go and pick two colours first. A four-stop ramp a third of the
 * lightness range wide is both immediately visible and close to what the
 * illustration style this app serves actually uses.
 */
export const defaultGradient = (colour: RGB): GradientFill => ({
  kind: 'gradient',
  shape: 'linear',
  angle: 'auto',
  sampled: false,
  stops: gradientRamp(colour),
  start: 0,
  end: 1,
  radius: 1,
  cx: 0.5,
  cy: 0.5,
});

/**
 * Four colour points, already placed, already different from each other.
 *
 * Same reasoning as the gradient default: an empty freeform fill is a flat fill
 * wearing a different name, so switching to it would appear to do nothing and
 * the feature would look broken before it had been tried. Four points in a
 * loose diamond with a light-to-dark spread across them is a plausible opening
 * shape for almost any region, and `Scatter` replaces it properly in one press.
 */
export const defaultFreeform = (colour: RGB, spread = 0.16): FreeformFill => ({
  kind: 'freeform',
  base: colour,
  points: [
    { id: ID(), x: 0.34, y: 0.3, rgb: shade(colour, spread), radius: 0.55 },
    { id: ID(), x: 0.7, y: 0.36, rgb: shade(colour, spread * 0.25), radius: 0.55 },
    { id: ID(), x: 0.36, y: 0.7, rgb: shade(colour, -spread * 0.45), radius: 0.55 },
    { id: ID(), x: 0.72, y: 0.74, rgb: shade(colour, -spread), radius: 0.55 },
  ],
});

/** Four stops from a light edge to a dark one, centred on `colour`. */
export function gradientRamp(colour: RGB, spread = 0.18): GradientStop[] {
  return [
    { offset: 0, rgb: shade(colour, spread) },
    { offset: 0.38, rgb: shade(colour, spread * 0.3) },
    { offset: 0.74, rgb: shade(colour, -spread * 0.55) },
    { offset: 1, rgb: shade(colour, -spread) },
  ];
}

export const defaultBanding = (): Banding => ({
  mode: 'tone',
  levels: 4,
  spacing: 'equal-area',
  thresholds: [],
  palette: [],
  locked: [],
  nested: true,
  alphaCut: 0.5,
  resolution: 1400,
});

export const defaultShaping = () => ({ grow: 0, smooth: 0.6 });

export const defaultOutline = () => ({ on: false, colour: [0, 0, 0] as RGB, width: 0.001 });

export function defaultBand(name: string, colour: RGB, threshold: number): Band {
  return {
    id: ID(),
    name,
    visible: true,
    colour,
    opacity: 1,
    fill: defaultFill(),
    outline: defaultOutline(),
    shaping: defaultShaping(),
    trace: {},
    threshold,
    source: colour,
  };
}

/**
 * Build a fresh band stack for `n` levels.
 *
 * Band 0 is the darkest and sits at the top of the drawing; the paper is the
 * lightest level and is not a band at all, which is why the ramp is built with
 * `n + 1` steps and the last one is dropped. A four-level posterisation is
 * therefore three bands of ink on paper, not four — the same arithmetic a
 * screen printer does.
 */
export function makeBands(n: number, dark: RGB = [0.08, 0.07, 0.09], light: RGB = [1, 1, 1]): Band[] {
  const levels = Math.max(2, Math.min(16, Math.round(n)));
  const colours = ramp(dark, light, levels);
  const bands: Band[] = [];
  for (let i = 0; i < levels - 1; i++) {
    // Thresholds sit at the top of each band's tone range.
    const threshold = (i + 1) / levels;
    bands.push(defaultBand(`Level ${i + 1}`, colours[i], threshold));
  }
  return bands;
}

export const defaultCanvas = () => ({
  width: 1000,
  height: 1000,
  dpi: 300,
  paper: [1, 1, 1] as RGB,
  units: 'mm' as const,
});

export function defaultProject(): Project {
  return {
    version: 2,
    canvas: defaultCanvas(),
    source: null,
    adjust: defaultAdjust(),
    banding: defaultBanding(),
    // potrace when it is there. The UI switches this to vtracer on its own if
    // potrace turns out to be missing, so the first run traces properly rather
    // than dropping to the built-in fallback and looking coarse.
    tracer: 'potrace',
    trace: defaultTrace(),
    vtrace: defaultVtrace(),
    bands: makeBands(4),
  };
}

/**
 * Repair a fill read from disk, including gradients written by older builds.
 *
 * Gradients used to be a `from`/`to` pair with a midpoint. They are a stop list
 * now, and a document saved against the old shape has to keep drawing the same
 * picture rather than silently becoming two copies of the band colour — so the
 * old three fields are read and turned into the three stops they described.
 */
export function normaliseFill(fill: unknown, colour: RGB): Fill {
  const f = fill as Partial<GradientFill> & Partial<FreeformFill>
    & { kind?: string; from?: RGB; to?: RGB; midpoint?: number };
  if (!f || typeof f.kind !== 'string') return defaultFill();

  if (f.kind === 'freeform') {
    // A point with no id cannot be selected or dragged, and a hand-edited file
    // is the usual way one arrives without one.
    const points: FreePoint[] = (Array.isArray(f.points) ? f.points : [])
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Array.isArray(p.rgb))
      .map((p) => ({
        id: p.id || ID(),
        x: p.x,
        y: p.y,
        rgb: p.rgb,
        radius: Number.isFinite(p.radius) ? p.radius : 0.5,
      }));
    return {
      kind: 'freeform',
      base: Array.isArray(f.base) ? (f.base as RGB) : colour,
      points: points.length ? points : defaultFreeform(colour).points,
    };
  }

  if (f.kind !== 'gradient') return f as Fill;

  const base = defaultGradient(colour);
  let stops: GradientStop[] | undefined =
    Array.isArray(f.stops) && f.stops.length >= 2 ? f.stops : undefined;
  if (!stops && Array.isArray(f.from) && Array.isArray(f.to)) {
    const mid = Math.min(0.95, Math.max(0.05, Number(f.midpoint) || 0.5));
    stops = [
      { offset: 0, rgb: f.from as RGB },
      { offset: mid, rgb: mixLab(f.from as RGB, f.to as RGB, 0.5) },
      { offset: 1, rgb: f.to as RGB },
    ];
  }
  return {
    ...base,
    shape: f.shape === 'radial' ? 'radial' : 'linear',
    angle: f.angle === 'auto' || typeof f.angle === 'number' ? f.angle : base.angle,
    sampled: !!f.sampled,
    stops: stops ?? base.stops,
    start: Number.isFinite(f.start) ? (f.start as number) : base.start,
    end: Number.isFinite(f.end) ? (f.end as number) : base.end,
    radius: Number.isFinite(f.radius) ? (f.radius as number) : base.radius,
    cx: Number.isFinite(f.cx) ? (f.cx as number) : base.cx,
    cy: Number.isFinite(f.cy) ? (f.cy as number) : base.cy,
  };
}

/**
 * Repair a project read from disk.
 *
 * Files outlive the code that wrote them, so every field is replaced rather
 * than trusted: a document from an older build is missing whole objects, and a
 * hand-edited one can be missing anything at all. The cost is one pass over a
 * small structure; the alternative is a crash three modules downstream with no
 * clue where the undefined came from.
 */
export function normaliseProject(p: Partial<Project>): Project {
  const base = defaultProject();
  const adjust: Adjust = { ...base.adjust, ...(p.adjust ?? {}) };
  adjust.levels = { ...base.adjust.levels, ...(p.adjust?.levels ?? {}) };
  adjust.curves = { ...identityCurves(), ...(p.adjust?.curves ?? {}) };
  for (const k of ['rgb', 'r', 'g', 'b'] as const) {
    const pts = adjust.curves[k];
    adjust.curves[k] = Array.isArray(pts) && pts.length >= 2 ? pts : identityCurve();
  }

  const banding: Banding = { ...base.banding, ...(p.banding ?? {}) };
  banding.alphaCut = Number.isFinite(banding.alphaCut) ? banding.alphaCut : base.banding.alphaCut;
  banding.thresholds = Array.isArray(banding.thresholds) ? banding.thresholds : [];
  banding.palette = Array.isArray(banding.palette) ? banding.palette : [];
  banding.locked = Array.isArray(banding.locked) ? banding.locked : [];

  const bands: Band[] = (Array.isArray(p.bands) && p.bands.length ? p.bands : base.bands).map(
    (b, i) => ({
      ...defaultBand(`Level ${i + 1}`, [0, 0, 0], (i + 1) / (banding.levels || 4)),
      ...b,
      id: b.id || ID(),
      shaping: { ...defaultShaping(), ...(b.shaping ?? {}) },
      outline: { ...defaultOutline(), ...(b.outline ?? {}) },
      fill: normaliseFill(b.fill, (b.colour as RGB) ?? [0, 0, 0]),
      trace: b.trace ?? {},
    }),
  );

  // Version 1 stored every length in canvas pixels. Convert against the canvas
  // the file was saved with, so it reopens as exactly the drawing it was.
  const canvas = { ...base.canvas, ...(p.canvas ?? {}) };
  if (!['mm', 'in', '%', 'px'].includes(canvas.units)) canvas.units = 'mm';
  const fromV1 = Array.isArray(p.bands) && p.bands.length > 0 && p.version !== 2;

  return {
    version: 2,
    canvas,
    source: p.source ?? null,
    adjust,
    banding,
    tracer: (p.tracer === 'vtracer' ? 'vtracer' : 'potrace') as Tracer,
    trace: { ...base.trace, ...(p.trace ?? {}) },
    vtrace: { ...base.vtrace, ...(p.vtrace ?? {}) },
    bands: fromV1 ? bands.map((b) => bandFromPixels(b, canvas)) : bands,
  };
}
