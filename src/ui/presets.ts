import { defaultAdjust, defaultGradient, defaultTrace, makeBands } from '../core/defaults';
import type { Band, RGB } from '../core/types';
import type { Ctx } from './context';

/**
 * Starting points, by name, the way Stipple offers them: a menu of finished
 * looks, each one a complete recipe from image adjustment through to fill. A
 * preset keeps the picture and the document and replaces everything about how
 * the picture is drawn, so it is a place to begin rather than a filter on top
 * of whatever was there.
 *
 * Every length here is a fraction of the picture's short edge (see
 * core/scale.ts), so a preset looks the same on any size of document.
 */

export type Preset = { name: string; about: string; apply: (ctx: Ctx) => void };

const tone = (ctx: Ctx, levels: number, bands: Band[], adjust: Partial<ReturnType<typeof defaultAdjust>>): void => {
  const s = ctx.store;
  s.updateAdjust({ ...defaultAdjust(), ...adjust }, 'preset');
  s.updateBanding({ mode: 'tone', levels, spacing: 'equal-area', nested: true });
  s.updateTrace(defaultTrace());
  s.replaceBands(bands);
};

const colour = (ctx: Ctx, levels: number, adjust: Partial<ReturnType<typeof defaultAdjust>>, after?: (b: Band[]) => void): void => {
  const s = ctx.store;
  s.updateAdjust({ ...defaultAdjust(), ...adjust }, 'preset');
  s.updateBanding({ mode: 'colour', levels, nested: true, palette: [], locked: [] });
  s.updateTrace(defaultTrace());
  // The palette is solved inside the trace this sets off, so the bands are
  // built from it once that trace has landed, not from the stale one in hand.
  ctx.afterTrace(() => {
    ctx.rebuildBands();
    ctx.takePaletteIntoBands();
    if (after) {
      const bands = s.get().bands.map((b) => ({ ...b, fill: { ...b.fill } })) as Band[];
      after(bands);
      s.replaceBands(bands);
    }
  });
};

const INK: RGB = [0.07, 0.07, 0.08];
const WARM_INK: RGB = [0.1, 0.08, 0.07];

export const PRESETS: Preset[] = [
  {
    name: 'Flat colour',
    about: 'Six flat colour regions, the field-guide look',
    apply: (ctx) => colour(ctx, 6, { blur: 1.8, saturation: 1.1 }),
  },
  {
    name: 'Symbol library',
    about: 'Five colour regions, each shaded with a gradient read from the photograph',
    apply: (ctx) => colour(ctx, 5, { blur: 2.2, saturation: 1.1 }, (bands) => {
      for (const b of bands) b.fill = { ...defaultGradient(b.colour), sampled: true };
    }),
  },
  {
    name: 'Two-ink poster',
    about: 'Two inks on paper, cut on tone: the cheapest screen print',
    apply: (ctx) => {
      const bands = makeBands(3);
      bands[0].colour = WARM_INK;
      bands[1].colour = [0.86, 0.36, 0.22];
      tone(ctx, 3, bands, { blur: 2, contrast: 0.3 });
    },
  },
  {
    name: 'Three-tone poster',
    about: 'Three greys and paper, cut on tone',
    apply: (ctx) => tone(ctx, 4, makeBands(4, [0.06, 0.05, 0.07], [1, 1, 1]), { blur: 1.6, contrast: 0.25 }),
  },
  {
    name: 'Ink drawing',
    about: 'Solid black and one grey, with small specks dropped',
    apply: (ctx) => {
      tone(ctx, 3, makeBands(3, INK, [1, 1, 1]), { blur: 2.2, contrast: 0.45 });
      ctx.store.updateTrace({ turdsize: 12, alphamax: 1.1 });
    },
  },
  {
    name: 'Contour lines',
    about: 'Only the edges of the tone bands, drawn as lines, like a map',
    apply: (ctx) => {
      const bands = makeBands(6, INK, [0.6, 0.6, 0.6]);
      bands.forEach((b) => {
        // Each band paints paper over the inside of the one below it, so only
        // the lines between bands are left showing.
        b.outline = { on: true, colour: b.colour, width: 0.0012 };
        b.colour = [1, 1, 1];
      });
      tone(ctx, 6, bands, { blur: 3, contrast: 0.1 });
    },
  },
  {
    name: 'Engraving',
    about: 'Hatched lines that swell with tone, each band at its own angle',
    apply: (ctx) => {
      const bands = makeBands(4, [0.07, 0.06, 0.08], [1, 1, 1]);
      bands.forEach((band, i) => {
        band.fill = {
          kind: 'hatch',
          // Rotating each band's screen keeps the layers legible where they
          // overlap, the same reason a four-colour job puts its screens at
          // different angles rather than stacking them all at 45.
          angle: 45 - i * 30,
          spacing: 0.005 + i * 0.0025,
          weight: 0.0016,
          cross: i === 0,
          crossAngle: 90,
          toneWeight: 0.85,
          wave: 0,
          waveLength: 0.04,
          base: i === 0 ? 0.15 : 0,
        };
      });
      tone(ctx, 4, bands, { blur: 2.6, contrast: 0.2 });
    },
  },
  {
    name: 'Stippled shading',
    about: 'Dots that grow and thin with tone, Stipple’s look inside traced shapes',
    apply: (ctx) => {
      const bands = makeBands(3, [0.08, 0.07, 0.09], [1, 1, 1]);
      bands.forEach((band, i) => {
        band.fill = {
          kind: 'stipple',
          spacing: 0.004 + i * 0.002,
          size: 0.0024,
          jitter: 0.75,
          toneSize: 0.7,
          toneDrop: 0.35,
          base: 0,
          seed: 1 + i,
        };
      });
      tone(ctx, 3, bands, { blur: 2 });
    },
  },
  {
    name: 'Soft gradients',
    about: 'Five tone bands, each a ramp that bends where the light does',
    apply: (ctx) => {
      const bands = makeBands(5, [0.1, 0.09, 0.12], [0.98, 0.97, 0.94]);
      // Reading the photograph at every stop, rather than at two ends: the ramp
      // then bends where the light does instead of being a straight line
      // between two averages.
      for (const band of bands) band.fill = { ...defaultGradient(band.colour), sampled: true };
      tone(ctx, 5, bands, { blur: 2.4 });
    },
  },
];
