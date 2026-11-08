import { defaultProject, normaliseProject } from './defaults';
import type { Band, Project } from './types';

/**
 * How much work a change forces the pipeline to redo. Higher subsumes lower.
 *
 * The whole point of the ladder is that `potrace` sits at `Trace` and above.
 * Tracing is a subprocess per band and the only step measured in hundreds of
 * milliseconds, so the thing that matters most about any given control is
 * whether it lands below that line. Colour, opacity, hatch angle, gradient
 * stops, dot size — all `Fill`, all free, all live under the cursor. Only the
 * handful of settings that genuinely change the *shape* of a region pay for a
 * retrace.
 */
export enum Dirty {
  None = 0,
  /** Rebuild the scene from paths already traced. */
  Fill = 1,
  /** Re-run potrace on the affected bands. */
  Trace = 2,
  /** Recut the image into regions, then trace. */
  Band = 3,
  /** Re-run the adjustment stack, then band, then trace. */
  Adjust = 4,
  /** New source image — nothing survives. */
  All = 5,
}

/** Which level each band field implies when it changes. */
const BAND_DIRTY: Record<keyof Band, Dirty> = {
  id: Dirty.None,
  name: Dirty.None,
  visible: Dirty.Fill,
  colour: Dirty.Fill,
  opacity: Dirty.Fill,
  fill: Dirty.Fill,
  outline: Dirty.Fill,
  // Shaping is morphology on the mask, so the contour itself moves.
  shaping: Dirty.Trace,
  trace: Dirty.Trace,
  threshold: Dirty.Band,
  source: Dirty.Band,
};

export type Change = {
  /** Bands that changed, with the worst level seen for each. */
  bands: Map<string, Dirty>;
  /** The band list itself changed: added, removed, reordered. */
  structural: boolean;
  /** Document-wide level. */
  global: Dirty;
};

type Listener = (project: Project, change: Change) => void;

const emptyChange = (): Change => ({ bands: new Map(), structural: false, global: Dirty.None });

const worst = (a: Dirty, b: Dirty): Dirty => (a > b ? a : b);

/**
 * Holds the project and broadcasts precise invalidation.
 *
 * Every mutation goes through a `mutate` helper so nothing can change the
 * document without the pipeline hearing about it at the right granularity.
 */
export class Store {
  private project: Project;
  private listeners = new Set<Listener>();
  private pending = emptyChange();
  private flushScheduled = false;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /**
   * The source image's pixels, held out of the history.
   *
   * A source is a base64 PNG measured in megabytes. Snapshotting it on every
   * undo step would make a hundred slider drags cost a gigabyte, and it never
   * changes except when the whole document is replaced.
   */
  private sourceBlob: string | null = null;
  private lastKey = '';
  private lastTime = 0;
  /** Slider drags produce hundreds of changes; collapse them into one undo step. */
  private static readonly COALESCE_MS = 500;
  private static readonly MAX_HISTORY = 120;

  constructor(project: Project = defaultProject()) {
    this.project = project;
  }

  get(): Readonly<Project> {
    return this.project;
  }

  band(id: string): Band | undefined {
    return this.project.bands.find((b) => b.id === id);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -- mutation ------------------------------------------------------------

  /**
   * Patch one band. The level is derived from which fields the patch touches,
   * so callers never have to reason about invalidation themselves.
   */
  updateBand(id: string, patch: Partial<Band>, historyKey?: string): void {
    const idx = this.project.bands.findIndex((b) => b.id === id);
    if (idx < 0) return;
    this.commit(historyKey ?? `band:${id}:${Object.keys(patch).join(',')}`);

    let level = Dirty.None;
    for (const key of Object.keys(patch) as (keyof Band)[]) {
      level = worst(level, BAND_DIRTY[key] ?? Dirty.Fill);
    }
    this.project.bands[idx] = { ...this.project.bands[idx], ...patch };
    this.markBand(id, level);
  }

  /** Patch a nested object on a band (`fill`, `shaping`, `trace`, `outline`). */
  updateBandField<K extends keyof Band>(
    id: string,
    field: K,
    patch: Partial<Band[K]>,
    historyKey?: string,
  ): void {
    const band = this.band(id);
    if (!band) return;
    const merged = { ...(band[field] as object), ...(patch as object) } as Band[K];
    this.updateBand(id, { [field]: merged } as Partial<Band>, historyKey ?? `band:${id}:${String(field)}`);
  }

  /** Apply the same patch to every band — "all bands get this hatch angle". */
  updateAllBands(patch: Partial<Band>, historyKey = 'bands:all'): void {
    this.commit(historyKey);
    let level = Dirty.None;
    for (const key of Object.keys(patch) as (keyof Band)[]) {
      level = worst(level, BAND_DIRTY[key] ?? Dirty.Fill);
    }
    this.project.bands = this.project.bands.map((b) => ({ ...b, ...patch }));
    for (const b of this.project.bands) this.markBand(b.id, level);
  }

  replaceBands(bands: Band[], level = Dirty.Band, historyKey = 'bands:replace'): void {
    this.commit(historyKey);
    this.project.bands = bands;
    this.pending.structural = true;
    this.pending.global = worst(this.pending.global, level);
    this.schedule();
  }

  moveBand(id: string, toIndex: number): void {
    const from = this.project.bands.findIndex((b) => b.id === id);
    if (from < 0 || from === toIndex) return;
    this.commit(`move:${id}`);
    const [band] = this.project.bands.splice(from, 1);
    this.project.bands.splice(Math.max(0, Math.min(toIndex, this.project.bands.length)), 0, band);
    this.pending.structural = true;
    // Order is paint order, so nothing needs retracing — only redrawing.
    this.pending.global = worst(this.pending.global, Dirty.Fill);
    this.schedule();
  }

  updateAdjust(patch: Partial<Project['adjust']>, historyKey = 'adjust'): void {
    this.commit(historyKey);
    this.project.adjust = { ...this.project.adjust, ...patch };
    this.pending.global = worst(this.pending.global, Dirty.Adjust);
    this.schedule();
  }

  updateAdjustField<K extends keyof Project['adjust']>(
    field: K,
    patch: Partial<Project['adjust'][K]>,
    historyKey?: string,
  ): void {
    const merged = { ...(this.project.adjust[field] as object), ...(patch as object) };
    this.updateAdjust({ [field]: merged } as Partial<Project['adjust']>, historyKey ?? `adjust:${String(field)}`);
  }

  updateBanding(patch: Partial<Project['banding']>, historyKey = 'banding'): void {
    this.commit(historyKey);
    this.project.banding = { ...this.project.banding, ...patch };
    this.pending.global = worst(this.pending.global, Dirty.Band);
    this.schedule();
  }

  updateTrace(patch: Partial<Project['trace']>, historyKey = 'trace'): void {
    this.commit(historyKey);
    this.project.trace = { ...this.project.trace, ...patch };
    this.pending.global = worst(this.pending.global, Dirty.Trace);
    this.schedule();
  }

  updateVtrace(patch: Partial<Project['vtrace']>, historyKey = 'vtrace'): void {
    this.commit(historyKey);
    this.project.vtrace = { ...this.project.vtrace, ...patch };
    this.pending.global = worst(this.pending.global, Dirty.Trace);
    this.schedule();
  }

  /** Switch tracers. Only the curve fitting changes, so only a retrace is due. */
  updateTracer(tracer: Project['tracer']): void {
    if (tracer === this.project.tracer) return;
    this.commit('tracer');
    this.project.tracer = tracer;
    this.pending.global = worst(this.pending.global, Dirty.Trace);
    this.schedule();
  }

  updateCanvas(patch: Partial<Project['canvas']>, historyKey = 'canvas'): void {
    this.commit(historyKey);
    const scaleChanged =
      ('width' in patch && patch.width !== this.project.canvas.width) ||
      ('height' in patch && patch.height !== this.project.canvas.height);
    this.project.canvas = { ...this.project.canvas, ...patch };
    // Paths live in canvas coordinates, so a resize moves every one of them.
    // Paper colour and dpi do not.
    this.pending.global = worst(this.pending.global, scaleChanged ? Dirty.Band : Dirty.Fill);
    this.schedule();
  }

  /**
   * How lengths are written in the panel. Not an edit to the drawing, so it
   * takes no undo step — stepping back through history to find the last real
   * change should not land on "showed millimetres instead of inches".
   */
  setUnits(units: Project['canvas']['units']): void {
    this.project.canvas = { ...this.project.canvas, units };
    this.schedule();
  }

  setSource(source: Project['source']): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.project.source = source;
    this.pending.global = Dirty.All;
    this.pending.structural = true;
    this.schedule();
  }

  /** Force a redraw without touching the document (viewport pan and zoom). */
  requestRedraw(): void {
    this.pending.global = worst(this.pending.global, Dirty.Fill);
    this.schedule();
  }

  invalidate(level: Dirty): void {
    this.pending.global = worst(this.pending.global, level);
    this.schedule();
  }

  private markBand(id: string, level: Dirty): void {
    if (level === Dirty.None) return;
    // Band-level changes at `Band` or above are not separable: recutting the
    // image reassigns every pixel, so every band's mask moves.
    if (level >= Dirty.Band) {
      this.pending.global = worst(this.pending.global, level);
    } else {
      const prev = this.pending.bands.get(id) ?? Dirty.None;
      this.pending.bands.set(id, worst(prev, level));
    }
    this.schedule();
  }

  /** Coalesce every mutation in a frame into one notification. */
  private schedule(): void {
    // The flag is set before the callback is registered, not after: a host that
    // ran the callback synchronously would otherwise leave it latched and wedge
    // every later notification.
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => {
      this.flushScheduled = false;
      const change = this.pending;
      this.pending = emptyChange();
      for (const fn of this.listeners) fn(this.project, change);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  // -- history -------------------------------------------------------------

  /** The project as a history entry, with the source pixels swapped for a marker. */
  private snapshot(): string {
    const { source, ...rest } = this.project;
    if (source) this.sourceBlob = source.data;
    return JSON.stringify({
      ...rest,
      source: source ? { ...source, data: '' } : null,
    });
  }

  private restore(snap: string): Project {
    const p = JSON.parse(snap) as Project;
    if (p.source && !p.source.data && this.sourceBlob) p.source.data = this.sourceBlob;
    return p;
  }

  private commit(key: string): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (key === this.lastKey && now - this.lastTime < Store.COALESCE_MS) {
      this.lastTime = now;
      return;
    }
    this.lastKey = key;
    this.lastTime = now;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > Store.MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.snapshot());
    this.project = this.restore(snap);
    this.lastKey = '';
    this.pending.structural = true;
    this.invalidate(Dirty.Adjust);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot());
    this.project = this.restore(snap);
    this.lastKey = '';
    this.pending.structural = true;
    this.invalidate(Dirty.Adjust);
  }

  /** Replace the whole document: new file, or opened from disk. */
  load(project: Partial<Project>): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.sourceBlob = null;
    this.project = normaliseProject(project);
    this.pending = emptyChange();
    this.pending.structural = true;
    this.invalidate(Dirty.All);
  }
}
