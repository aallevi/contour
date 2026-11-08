import type { Units } from './scale';
/**
 * The document model.
 *
 * A Contour document is one source image, one adjustment stack, a rule for
 * cutting it into regions, and a band per region. Everything downstream —
 * masks, traced paths, fills, the SVG on screen, the PDF on disk — is derived,
 * and none of it is stored.
 */

export type RGB = [number, number, number];

// -- adjustment --------------------------------------------------------------

/** A curve control point, both axes 0..1, sorted by `x`. */
export type CurvePoint = { x: number; y: number };

/**
 * Four independent curves. `rgb` is applied to all three channels after the
 * per-channel ones, which is the order Photoshop uses and the one people's
 * hands already know.
 */
export type Curves = {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
};

export type Levels = {
  /** Input black and white points, 0..1. Everything outside clips. */
  inBlack: number;
  inWhite: number;
  /** Midtone gamma, 0.1..10. 1 is neutral. */
  gamma: number;
  outBlack: number;
  outWhite: number;
};

export type Adjust = {
  exposure: number;
  brightness: number;
  contrast: number;
  saturation: number;
  /** Rotates hue before anything else looks at colour, in degrees. */
  hue: number;
  levels: Levels;
  curves: Curves;
  /**
   * Gaussian blur in source pixels, applied before banding.
   *
   * This is the most important control in the panel and it is easy to
   * under-use: potrace traces exactly what it is given, so a photograph's grain
   * becomes a thousand extra contour points. Blurring before posterising is how
   * you get shapes with a drawn quality rather than a photocopied one.
   */
  blur: number;
  /** Unsharp amount applied after blur, for pulling edges back afterwards. */
  sharpen: number;
  /** Median filter radius. Kills speckle without softening edges the way blur does. */
  denoise: number;
  invert: boolean;
};

// -- banding -----------------------------------------------------------------

export type BandMode = 'tone' | 'colour';

export type Banding = {
  mode: BandMode;
  /** How many regions to cut the image into, including the paper. */
  levels: number;
  /**
   * Tone mode: where the thresholds sit between black and white.
   *
   * `even` spaces them uniformly, `equal-area` puts the same number of pixels in
   * each band (the histogram-equalised choice), `balanced` goes halfway from
   * equal-area towards even spacing over the picture's own tonal range — the
   * default, because pure equal-area crowds every cut into the tones a picture
   * has most of, where texture flips pixels between bands — and `manual` uses
   * whatever the user dragged them to.
   */
  spacing: Spacing;
  /** Tone mode, `manual`: upper tone limit per band, ascending. */
  thresholds: number[];
  /** Colour mode: the quantised palette, ordered dark to light. */
  palette: RGB[];
  /** Colour mode: palette entries the user has pinned against requantisation. */
  locked: boolean[];
  /**
   * Stack regions cumulatively rather than cutting them out of each other.
   *
   * On: a band's mask is itself *plus everything darker*, so bands nest and paint
   * over one another back to front. Off: each region is traced alone. Nesting
   * costs nothing and removes the hairline paper-coloured gaps you otherwise get
   * along every boundary, because two independently fitted curves never agree to
   * the last hundredth of a pixel. Turn it off only when you want to pull the
   * shapes apart as separate objects in an editor.
   */
  nested: boolean;
  /**
   * Source alpha below this is not part of the drawing at all, 0..1.
   *
   * A photograph has no transparency and this never fires. A cut-out PNG does,
   * and without this every transparent pixel arrives as RGB black — so the
   * subject you wanted alone on the page comes out sitting on a solid black
   * plate, in the darkest band, where it is both wrong and hard to diagnose.
   * Gating every mask on the matte is what makes cut-out assets work at all.
   */
  alphaCut: number;
  /**
   * Long edge, in pixels, at which masks are built and traced.
   *
   * Not a quality setting so much as a character one. Tracing a 6000px photo
   * follows sensor noise around; 1200-2000px is where contours start to read as
   * drawn lines.
   */
  resolution: number;
};

// -- tracing -----------------------------------------------------------------

export type TurnPolicy = 'black' | 'white' | 'left' | 'right' | 'minority' | 'majority' | 'random';

/** potrace's own parameters, one to one. */
export type TraceParams = {
  /** `-t`: drop speckles up to this many pixels in area. */
  turdsize: number;
  /** `-a`: corner threshold. 0 is all corners, 1.334 is all smooth. */
  alphamax: number;
  /** `-O`: how far a fitted curve may stray before it is split. */
  opttolerance: number;
  /** `-n`: skip curve optimisation and keep the raw polygon-fitted Béziers. */
  longcurve: boolean;
  /** `-z`: how to resolve ambiguous crossings. */
  turnpolicy: TurnPolicy;
  /** `-u`: output quantisation, in units per pixel. */
  unit: number;
};

/**
 * Which tracer turns masks into curves.
 *
 * potrace is a subprocess and has to be installed; vtracer is linked into the
 * app and is always there. They are not interchangeable in character: potrace
 * fits long, confident curves and is the better choice for an organic subject,
 * while vtracer's polygon mode gives the flat, cut-paper edges that flat-vector
 * illustration often wants, and its spline mode holds small detail that
 * potrace's corner threshold tends to smooth away.
 */
export type Tracer = 'potrace' | 'vtracer';

/** vtracer's own parameters, one to one. */
export type VtraceParams = {
  /**
   * Drop shapes and holes up to this area, in working pixels.
   *
   * Stated as an area to match potrace's `-t`, so switching tracers keeps the
   * same setting meaning the same thing. vtracer measures it as a side length
   * internally and the conversion happens on the way out.
   */
  speckle: number;
  /** `spline` fits curves, `polygon` keeps straight edges, `pixel` keeps none. */
  mode: 'spline' | 'polygon' | 'pixel';
  /** Degrees: a turn sharper than this stays a corner. */
  cornerThreshold: number;
  /** Shortest segment the fitter will consider, 3.5..10. */
  lengthThreshold: number;
  /** Degrees: how far apart two splines may point and still be joined. */
  spliceThreshold: number;
  /** Coordinate decimal places. */
  precision: number;
};

/** Morphology applied to a mask before it is traced. */
export type MaskShaping = {
  /**
   * Dilate (positive) or erode (negative) by this many pixels.
   *
   * Spreading every band slightly is the print trick of trapping, and it is
   * useful here for the same reason: it guarantees the band below is covered
   * even where the two traces disagree.
   */
  grow: number;
  /**
   * Blur the mask and re-threshold it. Rounds off staircase edges and swallows
   * one-pixel peninsulas, which potrace would otherwise faithfully preserve.
   *
   * Speckles and pinholes are not handled here: potrace's own `turdsize` already
   * drops both, measured on the traced contour rather than the bitmap, and two
   * controls for one job is one too many.
   */
  smooth: number;
};

// -- fills -------------------------------------------------------------------

export type FlatFill = { kind: 'flat' };

/** One colour stop on a gradient ramp. */
export type GradientStop = { offset: number; rgb: RGB };

export type GradientFill = {
  kind: 'gradient';
  shape: 'linear' | 'radial';
  /** Degrees, or `auto` to take the direction from the region's own shading. */
  angle: number | 'auto';
  /**
   * Take the stop colours from the photograph, live, at every stop's position.
   *
   * Each stop keeps its offset and gets the region's mean colour in a slab
   * around that point along the axis — so adding a stop adds a reading of the
   * photograph rather than a colour to pick. `Take colours` in the panel bakes
   * the current reading into `stops` and turns this off, which is how a sampled
   * gradient becomes one you can then edit by hand.
   */
  sampled: boolean;
  /**
   * The ramp itself: two or more stops, offsets 0..1, ascending.
   *
   * Two stops is a plain blend; the illustration style this app exists to serve
   * routinely wants four, because a form turning away from a light does not
   * darken linearly.
   */
  stops: GradientStop[];
  /**
   * Where the ramp starts and ends along the region's own extent.
   *
   * 0 and 1 put the two ends exactly on the region's edges, which is the only
   * behaviour a gradient tool pinned to a bounding box can offer — and it is
   * why those tools feel stuck. Values outside 0..1 slide the ramp off the
   * region so you see one part of it hard, and `end` below `start` reverses it.
   * This is the control that gives a gradient somewhere to go.
   */
  start: number;
  end: number;
  /** Radial only: radius as a multiple of the region's half-diagonal. */
  radius: number;
  /** Radial only: centre as a fraction of the region's bounding box, 0..1. */
  cx: number;
  cy: number;
};

/**
 * One colour point in a freeform gradient.
 *
 * Positions are fractions of the region's own bounding box rather than canvas
 * coordinates, which is what lets a point survive a retrace: change the blur or
 * the threshold and the region moves, but "two thirds of the way down the
 * muzzle" still means the same place.
 */
export type FreePoint = {
  id: string;
  x: number;
  y: number;
  rgb: RGB;
  /** Reach, as a fraction of the region's bounding-box diagonal. */
  radius: number;
};

/**
 * A gradient with no axis: colours dropped where you want them.
 *
 * A linear or radial ramp can only say "it gets darker that way". A face, a
 * flank, a piece of fruit all get darker several ways at once, and the usual
 * answer — three bands stacked with three separate ramps — is both more work
 * and less convincing than putting four colours roughly where the light puts
 * them. This is Illustrator's freeform gradient in points mode, and it is
 * expressible in SVG and PDF exactly: a base colour with one soft radial blob
 * per point painted over it.
 */
export type FreeformFill = {
  kind: 'freeform';
  /** What shows where no point reaches. */
  base: RGB;
  points: FreePoint[];
};

// Every length below is a fraction of the canvas short edge; core/scale.ts
// turns it into canvas pixels for the fill generators.

export type HatchFill = {
  kind: 'hatch';
  angle: number;
  /** Centre-to-centre distance between lines. */
  spacing: number;
  /** Line width. */
  weight: number;
  cross: boolean;
  /** Second set's angle, relative to the first. */
  crossAngle: number;
  /**
   * How much the underlying tone modulates line width, 0..1.
   *
   * Above zero the lines stop being strokes and become filled ribbons that swell
   * in shadow and thin to nothing in light — the engraving move. It costs more
   * geometry, which is why it is a dial rather than always on.
   */
  toneWeight: number;
  /** Sine displacement across the line, amplitude. */
  wave: number;
  waveLength: number;
  /**
   * A flat wash of the band colour under the lines, 0..1.
   *
   * Hatching on bare paper is the engraving look; hatching over a light wash of
   * the same ink is the one most illustrations actually want, because it lets a
   * band read as a tone at a distance and as line work up close.
   */
  base: number;
};

export type StippleFill = {
  kind: 'stipple';
  /** Grid pitch. */
  spacing: number;
  /** Dot radius at full tone. */
  size: number;
  /** Random displacement as a fraction of the pitch, 0..1. */
  jitter: number;
  /** How much tone drives dot size, 0..1. */
  toneSize: number;
  /** How much tone drives whether a dot appears at all, 0..1. */
  toneDrop: number;
  /** A flat wash of the band colour under the dots, 0..1. */
  base: number;
  seed: number;
};

export type Fill = FlatFill | GradientFill | FreeformFill | HatchFill | StippleFill;

// -- bands -------------------------------------------------------------------

export type Band = {
  id: string;
  name: string;
  visible: boolean;
  colour: RGB;
  opacity: number;
  fill: Fill;
  /** Draw the region's contour as a line as well as (or instead of) filling it. */
  outline: { on: boolean; colour: RGB; width: number };
  shaping: MaskShaping;
  /** Per-band overrides of the document's trace parameters. */
  trace: Partial<TraceParams>;
  /** Tone mode: this band's upper tone limit, 0..1. */
  threshold: number;
  /** Colour mode: the quantised colour this band stands for. */
  source: RGB;
};

// -- document ----------------------------------------------------------------

/** How tone thresholds are placed; see `Banding.spacing`. */
export type Spacing = 'balanced' | 'even' | 'equal-area' | 'manual';

export type Canvas = {
  /** Output size in canvas pixels. */
  width: number;
  height: number;
  /** Canvas pixels per inch, which is what makes exports land at a real size. */
  dpi: number;
  /** Paper. Null leaves the background transparent. */
  paper: RGB | null;
  /** How lengths are written in the panel. Changes nothing but the display. */
  units: Units;
};

export type Source = {
  name: string;
  width: number;
  height: number;
  /** Base64 PNG. Held in the document so a `.contour` file opens standalone. */
  data: string;
  /** The image arrived with a matte — a cut-out rather than a photograph. */
  transparent?: boolean;
  /**
   * The picture as it was opened, when its background has since been cut away
   * in Contour (see cutout/). `data` then holds the cut, with the background
   * in its alpha; this is what Restore puts back and what Vision looks at.
   */
  original?: string;
};

export type Project = {
  /** 2: lengths are fractions of the short edge. 1: they were canvas pixels. */
  version: 2;
  canvas: Canvas;
  source: Source | null;
  adjust: Adjust;
  banding: Banding;
  /** Which tracer runs. Both read the same masks and the same mask shaping. */
  tracer: Tracer;
  trace: TraceParams;
  vtrace: VtraceParams;
  bands: Band[];
};

// -- the rendered scene ------------------------------------------------------

/**
 * What a serialiser is handed.
 *
 * The preview, the SVG file and the PDF file are all built from this one
 * structure, so what is on screen is the export rather than an impression of
 * it. Anything a backend cannot express has to be expressible here first.
 */
export type Stop = { offset: number; rgb: RGB; alpha?: number };

export type Paint =
  | { kind: 'solid'; rgb: RGB }
  | { kind: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: Stop[] }
  | { kind: 'radial'; cx: number; cy: number; r: number; stops: Stop[] };

export type FillRule = 'nonzero' | 'evenodd';

/**
 * There is no clip node, and that is the design.
 *
 * Hatching and stippling are confined to their region by being *generated*
 * inside it — every line is walked against the band's own mask and every dot is
 * tested against it — rather than by drawing across the bounding box and
 * clipping the overflow away. So the file contains only marks that are visible,
 * which is the difference between a hatched portrait of a few thousand line
 * segments and one of a few hundred thousand, and it spares the PDF backend a
 * clipping implementation it would otherwise need for parity with SVG.
 */
export type SceneNode =
  | { kind: 'fill'; d: string; paint: Paint; rule: FillRule; opacity: number }
  | { kind: 'stroke'; d: string; rgb: RGB; width: number; opacity: number; cap: 'butt' | 'round' };

export type SceneGroup = {
  name: string;
  opacity: number;
  nodes: SceneNode[];
};

export type Scene = {
  width: number;
  height: number;
  dpi: number;
  background: RGB | null;
  groups: SceneGroup[];
};
