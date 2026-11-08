import type { Store } from '../core/store';
import type { Engine } from '../pipeline/engine';
import type { FreePoint, GradientStop } from '../core/types';

/**
 * What every panel is handed.
 *
 * Panels never reach for the app object; they get this, which is the store,
 * the derived state, and the handful of operations that span more than one
 * panel. Keeping the surface this small is what stops the sidebar growing
 * mutual dependencies between its sections.
 */
export type Ctx = {
  store: Store;
  engine: Engine;
  selectedBand(): string | null;
  selectBand(id: string): void;
  /** Re-read every control from the document. */
  refresh(): void;
  status(message: string, kind?: 'info' | 'warn' | 'error'): void;

  openImage(): Promise<void>;
  /** The next click on the picture samples it there and hands the colour over. */
  pickColour(done: (rgb: [number, number, number]) => void): void;
  /**
   * Run once the next trace has landed. A colour palette is solved inside the
   * trace, so anything built from it has to wait for one.
   */
  afterTrace(fn: () => void): void;

  /**
   * Rebuild the band stack for the current level count and mode, keeping each
   * band's fill, shaping and opacity where one is still there to keep.
   */
  rebuildBands(): void;
  /** Colour mode: copy the resolved palette onto the bands. */
  takePaletteIntoBands(): void;
  /**
   * Tone mode: write thresholds into the bands according to a spacing rule.
   *
   * Spacing is an action rather than a standing mode. Re-deriving it on every
   * run would make the bands shuffle under the cursor while the curve is being
   * adjusted, which is maddening; applying it on request keeps the thresholds
   * stable and visible, and the button is there when they want redoing.
   */
  respace(rule?: 'even' | 'equal-area'): void;
  /**
   * Read the photograph at each of a band's gradient stops.
   *
   * Null when the band has no gradient or nothing has been traced yet. Used by
   * `Take colours` to turn a live sampled ramp into stops the user owns.
   */
  sampleGradient(bandId: string): GradientStop[] | null;

  /**
   * Which freeform colour point the panel is editing.
   *
   * The selection lives in the shell rather than in the document: it is a thing
   * about the session, not about the drawing, and putting it in the project
   * would make every click on a handle an undo step.
   */
  selectedFreePoint(): string | null;
  selectFreePoint(id: string | null): void;
  /** Read the photograph under every colour point of a band. */
  sampleFreePoints(bandId: string): FreePoint[] | null;
  /** Lay a fresh set of colour points over a band, taken from the photograph. */
  scatterFreePoints(bandId: string, count: number): FreePoint[] | null;
};
