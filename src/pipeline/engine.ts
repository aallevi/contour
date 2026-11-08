import { Adjuster, workingSize, type AdjustedImage } from '../image/adjust';
import { decodeSource, type LoadedImage } from '../image/loader';
import { shapeMask, type Mask } from '../band/mask';
import { buildMatte, histogram, lumaField, maskAtLevel } from '../band/posterize';
import { colourIndex, nearestPaletteIndex, quantize } from '../band/quantize';
import { traceFallback } from '../trace/fallback';
import { probeTools, traceNative, workingToCanvas, type Tools } from '../trace/potrace';
import { Dirty, type Change } from '../core/store';
import type {
  Band, FreePoint, GradientStop, Project, RGB, Scene, TraceParams, Tracer,
} from '../core/types';
import { pathBBox, type BBox, type PathCmd } from '../trace/path';
import { buildScene, type Derived } from '../render/scene';
import {
  gradientStopsFor, sampleFreePoints, scatterFreePoints, type FillContext,
} from '../fill';
import { ID } from '../core/defaults';
import { isTauri } from '../platform';

/**
 * The pipeline.
 *
 * Its whole job is doing as little as possible. Every change arrives labelled
 * with how far up the chain it reaches, and the engine starts from there: a
 * hatch angle touches nothing but the scene, a corner threshold re-runs potrace
 * on one band, a curve handle re-runs everything. Getting that right is what
 * makes the difference between a tool you can drag a slider in and one you
 * press a button in and wait.
 */

export type Resolved = {
  /** Tone mode: the thresholds actually in use, whether chosen or computed. */
  thresholds: number[];
  /** Colour mode: the palette actually in use, dark to light. */
  palette: RGB[];
};

/** Which tracer actually ran, which is not always the one that was asked for. */
export type RanTracer = Tracer | 'builtin';

export type UpdateResult = {
  /** Bands that failed to trace, by band id. */
  errors: Map<string, string>;
  /** The tracer that produced these paths. */
  engine: RanTracer;
  /** Why the chosen tracer was not used, when it was expected to be. */
  fallbackReason: string | null;
  /** Milliseconds spent inside potrace, summed across bands. */
  traceMillis: number;
  /** Superseded by a newer update — the caller should ignore the result. */
  stale: boolean;
};

/** The next level below `level`, or -1 when this is the darkest band. */
function lowerLevel(levels: number[], level: number): number {
  let best = -1;
  for (const l of levels) if (l < level && l > best) best = l;
  return best;
}

/** The short edge the Blur slider is measured against. */
export const BLUR_REFERENCE = 1000;

/**
 * Blur as a share of the picture rather than a count of its pixels.
 *
 * Two pixels of blur is a light softening on a 1400-pixel photograph and a
 * smear across a 300-pixel one, where it can be a whole eyelid. So the slider
 * means pixels on a picture whose short edge is 1000, and a smaller picture
 * gets proportionally less — the same rule every length in Contour follows,
 * so a preset softens a thumbnail and a scan by the same visible amount.
 */
export function blurFor(blur: number, width: number, height: number): number {
  return blur * (Math.min(width, height) / BLUR_REFERENCE);
}

export class Engine {
  /**
   * Built on first use, not in the constructor.
   *
   * `new Adjuster()` asks for a WebGL2 context and throws when it cannot have
   * one. Doing that in a field initialiser meant the throw happened inside
   * `new App(...)`, which runs before anything is on screen and before the
   * `catch` around `start()` — so a machine without WebGL2 got a blank window
   * and a message in a console nobody had open. Deferring it moves the failure
   * somewhere that can be reported.
   */
  private adjuster: Adjuster | null = null;
  private source: LoadedImage | null = null;
  private adjusted: AdjustedImage | null = null;
  private hist: Uint32Array = new Uint32Array(256);
  private field: Uint8Array | null = null;
  /** 1 where the source is opaque enough to draw; null for an opaque image. */
  private matte: Uint8Array | null = null;
  private masks = new Map<string, Mask>();
  private paths = new Map<string, PathCmd[]>();
  private errors = new Map<string, string>();
  private resolved: Resolved = { thresholds: [], palette: [] };

  private workW = 0;
  private workH = 0;
  private scale = 1;

  private tools: Tools = { potrace: null, magick: null, vtracer: null };
  private toolOverride: { potrace?: string } = {};

  /**
   * Quantisation is the one expensive step that does not depend on the band
   * stack, only on the image and the level count — so it is cached against
   * exactly those, and dragging a band's opacity does not re-solve k-means.
   */
  private paletteKey = '';

  /** Bumped on every update; a result from an older generation is discarded. */
  private generation = 0;

  async detectTools(override?: { potrace?: string }): Promise<Tools> {
    this.toolOverride = override ?? {};
    this.tools = await probeTools(override);
    return this.tools;
  }

  toolStatus(): Tools {
    return this.tools;
  }

  /** The adjustment stack, built on demand. */
  private gpu(): Adjuster {
    if (!this.adjuster) this.adjuster = new Adjuster();
    return this.adjuster;
  }

  async setSource(project: Project): Promise<void> {
    if (!project.source) {
      this.source = null;
      this.adjusted = null;
      return;
    }
    this.source = await decodeSource(project.source);
    this.gpu().setSource(this.source.bitmap, this.source.width, this.source.height);
  }

  hasImage(): boolean {
    return this.source !== null;
  }

  histogram(): Uint32Array {
    return this.hist;
  }

  /** The matte in use, for the UI to say whether transparency is in play. */
  sourceMatte(): Uint8Array | null {
    return this.matte;
  }

  adjustedImage(): AdjustedImage | null {
    return this.adjusted;
  }

  resolvedBanding(): Resolved {
    return this.resolved;
  }

  traceErrors(): Map<string, string> {
    return this.errors;
  }

  /**
   * Bring derived state up to date.
   *
   * `change.global` is the level to restart from; per-band entries below
   * `Dirty.Band` narrow a retrace to just the bands that moved.
   */
  async update(project: Project, change: Change): Promise<UpdateResult> {
    const generation = ++this.generation;
    const level = change.global;
    const result: UpdateResult = {
      errors: this.errors,
      engine: 'builtin',
      fallbackReason: null,
      traceMillis: 0,
      stale: false,
    };
    if (!this.source || !this.adjuster?.hasSource()) return result;

    if (level >= Dirty.Adjust) this.runAdjust(project);
    if (level >= Dirty.Band) this.runBanding(project);

    // Which bands need potrace run on them.
    let toTrace: string[];
    if (level >= Dirty.Trace) {
      toTrace = project.bands.map((b) => b.id);
    } else {
      toTrace = [...change.bands.entries()]
        .filter(([, d]) => d >= Dirty.Trace)
        .map(([id]) => id);
      // Shaping changed for these bands only, so their masks are restated here
      // rather than in `runBanding`, which would redo every band's.
      for (const id of toTrace) this.reshape(project, id);
    }
    // A band with no traced path yet — freshly added, or the first run — always
    // needs one, whatever the change said.
    for (const b of project.bands) {
      if (!this.paths.has(b.id) && !toTrace.includes(b.id)) toTrace.push(b.id);
    }

    if (toTrace.length) {
      const traced = await this.trace(project, toTrace, generation);
      if (traced.stale) return { ...result, stale: true };
      result.engine = traced.engine;
      result.fallbackReason = traced.fallbackReason;
      result.traceMillis = traced.millis;
    }

    // Bands that were deleted should not keep their derived state alive.
    const live = new Set(project.bands.map((b) => b.id));
    for (const key of [...this.masks.keys()]) if (!live.has(key)) this.masks.delete(key);
    for (const key of [...this.paths.keys()]) if (!live.has(key)) this.paths.delete(key);
    for (const key of [...this.rawMasks.keys()]) if (!live.has(key)) this.rawMasks.delete(key);

    return result;
  }

  private runAdjust(project: Project): void {
    const { width, height } = workingSize(
      this.source!.width,
      this.source!.height,
      project.banding.resolution,
    );
    this.workW = width;
    this.workH = height;
    this.adjusted = this.gpu().run(
      { ...project.adjust, blur: blurFor(project.adjust.blur, width, height) },
      width,
      height,
    );
    // The matte is cut before the histogram is taken, because the histogram is
    // what the spacing rules read and a cut-out's empty ground is not a tone.
    this.matte = buildMatte(this.adjusted.rgba, project.banding.alphaCut);
    this.hist = histogram(this.adjusted.rgba, this.matte);
    // Force a requantise: the pixels the palette was solved from have changed.
    this.paletteKey = '';
  }

  private runBanding(project: Project): void {
    if (!this.adjusted) return;
    const { banding, canvas, bands } = project;
    // The canvas takes the source's aspect ratio on open, so this is the same
    // number in both axes — but only the x one is used downstream, and an
    // aspect mismatch (a hand-edited height, say) would otherwise put hatch
    // spacing and dot size silently out by that ratio in one direction.
    this.scale = canvas.width / Math.max(1, this.workW);
    const levels = Math.max(2, banding.levels);

    if (banding.mode === 'tone') {
      // The bands' own thresholds are the truth, always.
      //
      // Deriving them here from the spacing rule instead was the obvious
      // design and the wrong one: the rule depends on the histogram, the
      // histogram moves every time a curve handle does, and a band's stored
      // cut would drift out of agreement with the mask it was given. Spacing
      // is an action that writes thresholds into the bands (see `respace`), so
      // what the strip shows and what gets traced cannot disagree.
      this.resolved = { thresholds: bands.map((b) => b.threshold), palette: [] };
      this.field = lumaField(this.adjusted.rgba, this.workW, this.workH);
    } else {
      const locked = banding.palette.filter((_, i) => banding.locked[i]);
      const key = `${levels}|${JSON.stringify(locked)}|${banding.alphaCut}`;
      const supplied = banding.palette.length === levels;
      let palette: RGB[];
      if (supplied && key === this.paletteKey) {
        palette = banding.palette;
      } else {
        palette = quantize(this.adjusted.rgba, levels, { locked, matte: this.matte });
        this.paletteKey = key;
      }
      this.resolved = { thresholds: [], palette };

      // The field is the palette index itself, one byte per pixel, so a band's
      // region is every pixel assigned to its own entry or to a darker one.
      this.field = colourIndex(this.adjusted.rgba, this.workW, this.workH, palette);
    }

    this.rawMasks.clear();
    // Each band's cut, in whatever units the field is measured in.
    const levelOf = (b: Band): number =>
      banding.mode === 'tone'
        ? Math.round(Math.min(1, Math.max(0, b.threshold)) * 255)
        : nearestPaletteIndex(this.resolved.palette, b.source);
    const levels_ = bands.map(levelOf);

    for (let i = 0; i < bands.length; i++) {
      const raw = maskAtLevel(
        this.field!,
        this.workW,
        this.workH,
        levels_[i],
        lowerLevel(levels_, levels_[i]),
        banding.nested,
        this.matte,
      );
      this.rawMasks.set(bands[i].id, raw);
      this.masks.set(bands[i].id, this.shape(raw, bands[i]));
    }
  }

  /** Masks before morphology, so a shaping change need not recut the image. */
  private rawMasks = new Map<string, Mask>();

  /** Redo one band's morphology, for a shaping change that touched only it. */
  private reshape(project: Project, bandId: string): void {
    const raw = this.rawMasks.get(bandId);
    const band = project.bands.find((b) => b.id === bandId);
    if (!raw || !band) return;
    this.masks.set(bandId, this.shape(raw, band));
  }

  /**
   * Morphology, then the matte again.
   *
   * Growing a band spreads it in every direction, including out past the edge
   * of a cut-out — so trapping a figure by two pixels would put a two-pixel
   * halo of ink on the transparent ground it was meant to be floating on. The
   * matte is the last word on where the drawing is allowed to be.
   */
  private shape(raw: Mask, band: Band): Mask {
    const shaped = shapeMask(raw, band.shaping);
    if (!this.matte) return shaped;
    const bits = shaped.bits === raw.bits ? new Uint8Array(shaped.bits) : shaped.bits;
    for (let p = 0; p < bits.length; p++) if (!this.matte[p]) bits[p] = 0;
    return { width: shaped.width, height: shaped.height, bits };
  }

  private paramsFor(project: Project, bandId: string): TraceParams {
    const band = project.bands.find((b) => b.id === bandId);
    return { ...project.trace, ...(band?.trace ?? {}) };
  }

  private async trace(
    project: Project,
    ids: string[],
    generation: number,
  ): Promise<{
    engine: RanTracer; millis: number; stale: boolean; fallbackReason: string | null;
  }> {
    const masks = ids.map((id) => this.masks.get(id)).filter(Boolean) as Mask[];
    const valid = ids.filter((id) => this.masks.has(id));
    if (!masks.length) {
      return { engine: 'builtin', millis: 0, stale: false, fallbackReason: null };
    }
    let fallbackReason: string | null = null;

    const params = valid.map((id) => this.paramsFor(project, id));
    const { width: cw, height: ch } = project.canvas;

    // vtracer is compiled in, so it needs nothing found on disk; potrace needs
    // a binary, and its absence is the one case that falls back.
    const engine = project.tracer === 'vtracer' ? 'vtracer' : 'potrace';
    const nativeReady = isTauri() && (engine === 'vtracer' || !!this.tools.potrace);

    if (nativeReady) {
      try {
        const results = await traceNative({
          masks,
          params,
          canvasWidth: cw,
          canvasHeight: ch,
          engine,
          vtrace: project.vtrace,
          potracePath: this.toolOverride.potrace ?? this.tools.potrace?.path,
        });
        // A trace started before a newer edit must not overwrite that edit's
        // results, which may already be on screen.
        if (generation !== this.generation) {
          return { engine, millis: 0, stale: true, fallbackReason: null };
        }
        let millis = 0;
        for (let i = 0; i < valid.length; i++) {
          const r = results[i];
          if (!r) continue;
          millis += r.millis;
          if (r.error) {
            this.errors.set(valid[i], r.error);
            this.paths.set(valid[i], []);
          } else {
            this.errors.delete(valid[i]);
            this.paths.set(valid[i], r.cmds);
          }
        }
        return { engine, millis, stale: false, fallbackReason: null };
      } catch (err) {
        // Fall through to the built-in tracer rather than leaving a blank
        // canvas: a missing or broken potrace should degrade, not stop.
        //
        // The reason travels back with the result rather than being written
        // into `errors` — the fallback pass below clears every band's error as
        // it succeeds, so recording it there meant the one useful sentence
        // about why potrace did not run was erased microseconds later and the
        // status line said only "built-in tracer", with no hint why.
        fallbackReason = (err as Error).message;
      }
    }

    const started = performance.now();
    for (let i = 0; i < valid.length; i++) {
      const m = workingToCanvas(masks[i].width, masks[i].height, cw, ch);
      this.paths.set(valid[i], traceFallback(masks[i], params[i], m));
      this.errors.delete(valid[i]);
    }
    if (generation !== this.generation) {
      return { engine: 'builtin', millis: 0, stale: true, fallbackReason };
    }
    return {
      engine: 'builtin',
      millis: performance.now() - started,
      stale: false,
      fallbackReason,
    };
  }

  /**
   * The colours a band's gradient is currently reading off the photograph.
   *
   * Runs the same sampling the renderer does, so `Take colours` in the panel
   * hands back exactly what was on screen a moment earlier rather than a second
   * opinion about it.
   */
  sampledGradientStops(project: Project, bandId: string): GradientStop[] | null {
    const ctx = this.fillContext(project, bandId);
    if (!ctx || ctx.band.fill.kind !== 'gradient') return null;
    return gradientStopsFor(ctx, ctx.band.fill);
  }

  /** Everything a fill needs to look at the photograph inside one band. */
  private fillContext(project: Project, bandId: string): FillContext | null {
    const band = project.bands.find((b) => b.id === bandId);
    const mask = this.masks.get(bandId);
    const path = this.paths.get(bandId);
    if (!band || !mask || !path || !path.length || !this.adjusted) return null;
    return { mask, image: this.adjusted, path, scale: this.scale, band };
  }

  /** Re-read the photograph under every freeform colour point. */
  sampledFreePoints(project: Project, bandId: string): FreePoint[] | null {
    const ctx = this.fillContext(project, bandId);
    if (!ctx || ctx.band.fill.kind !== 'freeform') return null;
    return sampleFreePoints(ctx, ctx.band.fill);
  }

  /** Lay a fresh set of colour points over a band, taken from the photograph. */
  scatterFreePoints(project: Project, bandId: string, count: number): FreePoint[] | null {
    const ctx = this.fillContext(project, bandId);
    if (!ctx) return null;
    const points = scatterFreePoints(ctx, count, ID);
    return points.length ? points : null;
  }

  /**
   * A band's traced bounds, in canvas units.
   *
   * Freeform colour points are stored as fractions of this box, so the overlay
   * needs it to put a handle on screen and the fill needs it to put a blob in
   * the file. Both read it from here rather than recomputing it, so a handle
   * cannot land somewhere the paint does not.
   */
  private shareCache: { key: unknown[]; shares: Map<string, number>; paper: number } | null = null;

  /**
   * How much of the sheet each band actually prints, and how much is left as
   * paper — Stipple's ink shares, for bands. A pixel belongs to the topmost
   * visible band whose mask holds it, which is what the eye sees, since bands
   * nest and the darker ones paint over the lighter.
   *
   * Recounted only when a mask or the stack changes: dragging a colour or a
   * hatch angle reaches here on every frame and must not pay for a full pass.
   */
  bandShares(project: Project): { shares: Map<string, number>; paper: number } {
    const masks = project.bands.map((b) => (b.visible ? this.masks.get(b.id) ?? null : null));
    const key = [...masks, ...project.bands.map((b) => b.id)];
    const c = this.shareCache;
    if (c && c.key.length === key.length && c.key.every((k, i) => k === key[i])) return c;
    const shares = new Map<string, number>();
    const first = masks.find(Boolean);
    if (!first) return { shares, paper: 1 };
    const n = first.width * first.height;
    const counts = new Array<number>(masks.length).fill(0);
    let paper = 0;
    for (let p = 0; p < n; p++) {
      let owner = -1;
      for (let i = 0; i < masks.length; i++) {
        const m = masks[i];
        if (m && m.width === first.width && m.bits[p]) { owner = i; break; }
      }
      if (owner < 0) paper++;
      else counts[owner]++;
    }
    project.bands.forEach((b, i) => shares.set(b.id, counts[i] / n));
    this.shareCache = { key, shares, paper: paper / n };
    return this.shareCache;
  }

  bandBBox(bandId: string): BBox | null {
    const path = this.paths.get(bandId);
    return path && path.length ? pathBBox(path) : null;
  }

  derived(): Derived {
    return {
      masks: this.masks,
      paths: this.paths,
      image: this.adjusted,
      scale: this.scale,
    };
  }

  scene(project: Project): Scene {
    return buildScene(project, this.derived());
  }

  /** Working resolution actually in use, for the status line. */
  workingSize(): { width: number; height: number } {
    return { width: this.workW, height: this.workH };
  }
}
