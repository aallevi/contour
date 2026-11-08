import { describe, expect, it } from 'vitest';
import {
  equalAreaThresholds, evenThresholds, histogram, lowerCutOf, lumaField, maskAtCut, maskAtLevel,
} from '../src/band/posterize';
import { colourIndex, nearestPaletteIndex, quantize } from '../src/band/quantize';
import { lumaOf, rgbToHex } from '../src/core/color';
import type { RGB } from '../src/core/types';

/** A greyscale ramp: every tone equally represented. */
function ramp(w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}

/** Three flat colour fields, in unequal proportions. */
function patches(w: number, h: number, colours: RGB[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = colours[Math.min(colours.length - 1, Math.floor((x / w) * colours.length))];
      const i = (y * w + x) * 4;
      out[i] = c[0] * 255; out[i + 1] = c[1] * 255; out[i + 2] = c[2] * 255; out[i + 3] = 255;
    }
  }
  return out;
}

describe('thresholds', () => {
  it('spaces evenly with one fewer threshold than levels', () => {
    expect(evenThresholds(4)).toEqual([0.25, 0.5, 0.75]);
    expect(evenThresholds(2)).toEqual([0.5]);
  });

  it('equal-area on a flat ramp lands close to even', () => {
    const hist = histogram(ramp(256, 4));
    const eq = equalAreaThresholds(hist, 4);
    expect(eq).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(eq[i]).toBeCloseTo((i + 1) / 4, 1);
  });

  it('equal-area puts the thresholds where the pixels are', () => {
    // Nine tenths of the image is dark; even spacing would give the shadows one
    // band, and equal-area should give them most of them.
    const w = 200;
    const rgba = new Uint8ClampedArray(w * 4 * 4);
    for (let p = 0; p < w * 4; p++) {
      const v = p < w * 4 * 0.9 ? 20 + (p % 12) : 240;
      rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255;
    }
    // Every quartile boundary falls inside the shadows, which is the point:
    // the levels get spent where the pixels are rather than on an empty range.
    const eq = equalAreaThresholds(histogram(rgba), 4);
    expect(eq.filter((t) => t < 0.3)).toHaveLength(3);
  });

  it('never returns two thresholds in the same place', () => {
    // A pure two-tone image: most of the histogram is empty.
    const rgba = new Uint8ClampedArray(64 * 4);
    for (let p = 0; p < 64; p++) {
      const v = p < 32 ? 0 : 255;
      rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255;
    }
    const eq = equalAreaThresholds(histogram(rgba), 6);
    for (let i = 1; i < eq.length; i++) expect(eq[i]).toBeGreaterThan(eq[i - 1]);
  });
});

describe('cutting masks', () => {
  const w = 100;
  const h = 1;
  const field = lumaField(ramp(w, h), w, h);

  it('nested masks are strictly nested', () => {
    const a = maskAtCut(field, w, h, 0.25, -1, true);
    const b = maskAtCut(field, w, h, 0.5, -1, true);
    const c = maskAtCut(field, w, h, 0.75, -1, true);
    for (let i = 0; i < w; i++) {
      if (a.bits[i]) expect(b.bits[i]).toBe(1);
      if (b.bits[i]) expect(c.bits[i]).toBe(1);
    }
    const count = (m: { bits: Uint8Array }) => m.bits.reduce((n, v) => n + v, 0);
    expect(count(a)).toBeLessThan(count(b));
    expect(count(b)).toBeLessThan(count(c));
  });

  it('unnested masks are disjoint and together cover everything', () => {
    const cuts = [0.25, 0.5, 0.75, 1];
    const masks = cuts.map((c) => maskAtCut(field, w, h, c, lowerCutOf(cuts, c), false));
    for (let i = 0; i < w; i++) {
      const hits = masks.reduce((n, m) => n + m.bits[i], 0);
      expect(hits).toBe(1);
    }
  });

  it('finds the next cut down, and reports none below the darkest', () => {
    expect(lowerCutOf([0.25, 0.5, 0.75], 0.75)).toBe(0.5);
    expect(lowerCutOf([0.25, 0.5, 0.75], 0.25)).toBe(-1);
  });

  it('a cut at 1 covers the whole image', () => {
    const m = maskAtCut(field, w, h, 1, -1, true);
    expect([...m.bits].every((v) => v === 1)).toBe(true);
  });
});

describe('colour quantisation', () => {
  const RED: RGB = [0.8, 0.1, 0.1];
  const GREEN: RGB = [0.1, 0.6, 0.2];
  const CREAM: RGB = [0.93, 0.9, 0.82];

  it('recovers flat colour fields', () => {
    const palette = quantize(patches(90, 30, [RED, GREEN, CREAM]), 3);
    expect(palette).toHaveLength(3);
    // Every source colour should have a palette entry close to it.
    for (const want of [RED, GREEN, CREAM]) {
      const best = Math.min(...palette.map((c) =>
        Math.hypot(c[0] - want[0], c[1] - want[1], c[2] - want[2])));
      expect(best).toBeLessThan(0.06);
    }
  });

  it('returns the palette ordered dark to light', () => {
    const palette = quantize(patches(90, 30, [RED, GREEN, CREAM]), 3);
    for (let i = 1; i < palette.length; i++) {
      expect(lumaOf(palette[i])).toBeGreaterThanOrEqual(lumaOf(palette[i - 1]));
    }
  });

  it('is deterministic', () => {
    const rgba = patches(120, 20, [RED, GREEN, CREAM]);
    expect(quantize(rgba, 4).map(rgbToHex)).toEqual(quantize(rgba, 4).map(rgbToHex));
  });

  it('keeps a locked colour exactly', () => {
    const locked: RGB = [0, 0, 1];
    const palette = quantize(patches(90, 30, [RED, GREEN, CREAM]), 3, { locked: [locked] });
    const kept = palette.find((c) =>
      Math.abs(c[0]) < 1e-6 && Math.abs(c[1]) < 1e-6 && Math.abs(c[2] - 1) < 1e-6);
    expect(kept).toBeDefined();
  });

  it('assigns every pixel to its nearest entry', () => {
    const palette: RGB[] = [[0, 0, 0], [1, 1, 1]];
    const rgba = new Uint8ClampedArray([10, 10, 10, 255, 245, 245, 245, 255]);
    const idx = colourIndex(rgba, 2, 1, palette);
    expect([...idx]).toEqual([0, 1]);
  });

  it('spends every slot on a continuous image', () => {
    // The realistic case: a ramp has tones everywhere, so all six entries
    // should land somewhere different rather than piling up.
    const w = 256;
    const rgba = new Uint8ClampedArray(w * 4 * 4);
    for (let p = 0; p < w * 4; p++) {
      const v = Math.round((p % w) / (w - 1) * 255);
      rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255;
    }
    const palette = quantize(rgba, 6);
    expect(new Set(palette.map(rgbToHex)).size).toBe(6);
  });

  it('still returns the requested count when the image has fewer colours', () => {
    // Nothing is invented: a two-colour image gives two colours, repeated to
    // fill the palette, and both of them are present.
    const palette = quantize(patches(60, 10, [RED, CREAM]), 6);
    expect(palette).toHaveLength(6);
    for (const want of [RED, CREAM]) {
      const best = Math.min(...palette.map((c) =>
        Math.hypot(c[0] - want[0], c[1] - want[1], c[2] - want[2])));
      expect(best).toBeLessThan(0.06);
    }
  });
});

describe('thresholds never reach white', () => {
  it('sends pure white to the paper even when most of the image is white', () => {
    // A cutout on a white ground: more than half the pixels are exactly 255.
    const n = 1000;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      const v = p < n * 0.55 ? 255 : Math.round((p / n) * 200);
      rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255;
    }
    const eq = equalAreaThresholds(histogram(rgba), 5);
    expect(Math.max(...eq)).toBeLessThan(1);

    // The lightest band must therefore leave the white ground alone.
    const field = lumaField(rgba, n, 1);
    const top = maskAtCut(field, n, 1, Math.max(...eq), -1, true);
    const covered = [...top.bits].reduce((a, b) => a + b, 0);
    expect(covered).toBeLessThan(n * 0.5);
  });
});

describe('colour bands nest by palette index, not by lightness', () => {
  // The palette a real photograph produced: a tan and a grey nine luminance
  // steps apart. Cutting those by lightness merged them into one band and left
  // the other drawing nothing at all.
  const PALETTE: RGB[] = [
    [0x3a / 255, 0x2c / 255, 0x22 / 255],
    [0xa7 / 255, 0x88 / 255, 0x4c / 255],
    [0xa0 / 255, 0x91 / 255, 0x82 / 255],
    [0xec / 255, 0xcd / 255, 0x8d / 255],
  ];

  /** One pixel of each palette colour, in order. */
  const image = (): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(PALETTE.length * 4);
    PALETTE.forEach((c, i) => {
      out[i * 4] = c[0] * 255;
      out[i * 4 + 1] = c[1] * 255;
      out[i * 4 + 2] = c[2] * 255;
      out[i * 4 + 3] = 255;
    });
    return out;
  };

  it('two entries of near-identical lightness stay separate bands', () => {
    expect(Math.abs(lumaOf(PALETTE[1]) - lumaOf(PALETTE[2])) * 255).toBeLessThan(12);

    const n = PALETTE.length;
    const field = colourIndex(image(), n, 1, PALETTE);
    expect([...field]).toEqual([0, 1, 2, 3]);

    // Each band nests one entry further up the palette, so the masks grow by
    // exactly one pixel each and no two of them are the same.
    const sizes = [0, 1, 2].map((level) => {
      const m = maskAtLevel(field, n, 1, level, -1, true);
      return [...m.bits].reduce((a, b) => a + b, 0);
    });
    expect(sizes).toEqual([1, 2, 3]);
  });

  it('a band keeps its own entry after the bands are reordered', () => {
    // Bands remember the colour they stand for, so their index survives being
    // shuffled in the list.
    expect(nearestPaletteIndex(PALETTE, PALETTE[2])).toBe(2);
    expect(nearestPaletteIndex(PALETTE, PALETTE[1])).toBe(1);
    // And an edited colour falls back to whichever entry is nearest in Lab.
    expect(nearestPaletteIndex(PALETTE, [0xa5 / 255, 0x95 / 255, 0x86 / 255])).toBe(2);
  });
});
