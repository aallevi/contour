import type { Band, Canvas, Fill } from './types';

/**
 * Every length a band carries is a fraction of the picture.
 *
 * Hatch spacing, line weight, wave, dot pitch and size, outline width — all of
 * them are stored as a fraction of the canvas's short edge, not in canvas
 * pixels. A document three times the size is then the same drawing three times
 * the size: the same number of lines, each the same share of the picture. In
 * pixels, enlarging the sheet for print quietly turned an engraving into a fine
 * grey, and halving it turned it to a few heavy bars.
 *
 * This is the one place those fractions become pixels. The fill generators and
 * the exporters go on working in canvas pixels and never know about it, exactly
 * as in Stipple, whose `core/scale.ts` this mirrors.
 */

export type Units = 'mm' | 'in' | '%' | 'px';

export const shortEdge = (c: Pick<Canvas, 'width' | 'height'>): number =>
  Math.max(1, Math.min(c.width, c.height));

/** The fields of each fill kind that are lengths. */
const FILL_LENGTHS: Partial<Record<Fill['kind'], string[]>> = {
  hatch: ['spacing', 'weight', 'wave', 'waveLength'],
  stipple: ['spacing', 'size'],
};

function scaleBand(band: Band, k: number): Band {
  const keys = FILL_LENGTHS[band.fill.kind];
  let fill = band.fill;
  if (keys) {
    const f = { ...band.fill } as Record<string, unknown>;
    for (const key of keys) if (typeof f[key] === 'number') f[key] = (f[key] as number) * k;
    fill = f as Fill;
  }
  return { ...band, fill, outline: { ...band.outline, width: band.outline.width * k } };
}

/** A band with its lengths in canvas pixels, for the fill generators. */
export const resolveBand = (band: Band, canvas: Pick<Canvas, 'width' | 'height'>): Band =>
  scaleBand(band, shortEdge(canvas));

/** The reverse, for converting a version 1 document whose lengths were pixels. */
export const bandFromPixels = (band: Band, canvas: Pick<Canvas, 'width' | 'height'>): Band =>
  scaleBand(band, 1 / shortEdge(canvas));

/** Decimals per unit, fixed so "0.40 mm → 1.20 mm" reads as one quantity. */
const DECIMALS: Record<Units, number> = { mm: 2, in: 3, '%': 2, px: 1 };

/** A fraction of the short edge, in the document's display unit. */
export function lengthIn(frac: number, canvas: Canvas): number {
  const px = frac * shortEdge(canvas);
  switch (canvas.units) {
    case 'px': return px;
    case '%': return frac * 100;
    case 'in': return px / Math.max(1, canvas.dpi);
    default: return (px / Math.max(1, canvas.dpi)) * 25.4;
  }
}

/** The display unit back to a fraction of the short edge. */
export function lengthFrom(value: number, canvas: Canvas): number {
  const short = shortEdge(canvas);
  switch (canvas.units) {
    case 'px': return value / short;
    case '%': return value / 100;
    case 'in': return (value * Math.max(1, canvas.dpi)) / short;
    default: return ((value / 25.4) * Math.max(1, canvas.dpi)) / short;
  }
}

export function formatLength(frac: number, canvas: Canvas): string {
  const u = canvas.units ?? 'mm';
  return `${lengthIn(frac, canvas).toFixed(DECIMALS[u])} ${u}`;
}
