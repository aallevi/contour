import { describe, expect, it } from 'vitest';
import { buildMatte, histogram, lumaField, maskAtCut, maskAtLevel } from '../src/band/posterize';
import { quantize } from '../src/band/quantize';
import { hasTransparency } from '../src/image/loader';
import { lumaOf } from '../src/core/color';

/**
 * Cut-outs.
 *
 * A PNG with a transparent background arrives with black in the RGB of every
 * clear pixel, because that is what the encoder had no reason not to leave
 * there. Without a matte the banding code reads that black as the darkest tone
 * in the picture, so a figure meant to float on nothing comes back sitting on a
 * solid plate — and it looks like a tracing bug rather than an alpha one.
 */

const W = 40;
const H = 40;

/**
 * A light disc on a fully transparent ground, with black left under the matte —
 * exactly the shape of the file that caused the trouble.
 */
function cutout(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = Math.hypot(x - W / 2, y - H / 2) < 12;
      if (inside) {
        // A left-to-right ramp inside the subject, all of it well above black.
        const v = 140 + Math.round((x / W) * 100);
        out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
      } else {
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      }
    }
  }
  return out;
}

const opaque = (): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    out[p * 4] = 128; out[p * 4 + 1] = 128; out[p * 4 + 2] = 128; out[p * 4 + 3] = 255;
  }
  return out;
};

describe('the matte', () => {
  it('is null for an image with no transparency, so nothing else pays for it', () => {
    expect(buildMatte(opaque(), 0.5)).toBeNull();
  });

  it('marks the subject and nothing else', () => {
    const m = buildMatte(cutout(), 0.5)!;
    expect(m).not.toBeNull();
    expect(m[0]).toBe(0);
    expect(m[(H / 2) * W + W / 2]).toBe(1);
  });

  it('moves with the cut', () => {
    const rgba = new Uint8ClampedArray(4 * 3);
    // Three pixels at 0, 128 and 255 alpha.
    rgba[3] = 0; rgba[7] = 128; rgba[11] = 255;
    expect(Array.from(buildMatte(rgba, 0.1)!)).toEqual([0, 1, 1]);
    expect(Array.from(buildMatte(rgba, 0.9)!)).toEqual([0, 0, 1]);
  });
});

describe('the histogram', () => {
  it('leaves the empty ground out', () => {
    const rgba = cutout();
    const matte = buildMatte(rgba, 0.5);
    const withGround = histogram(rgba);
    const subjectOnly = histogram(rgba, matte);

    // Without the matte the clear pixels pile into bin 0 and dominate; with it,
    // bin 0 is empty and every count comes from the disc.
    expect(withGround[0]).toBeGreaterThan(1000);
    expect(subjectOnly[0]).toBe(0);
    let total = 0;
    for (const v of subjectOnly) total += v;
    expect(total).toBeGreaterThan(300);
    expect(total).toBeLessThan(W * H);
  });
});

describe('masks', () => {
  const rgba = cutout();
  const field = lumaField(rgba, W, H);
  const matte = buildMatte(rgba, 0.5);

  it('draw nothing where the source is transparent', () => {
    // A cut at mid grey with nesting on: without the matte this takes the whole
    // empty ground, because black is below every threshold there is.
    const naive = maskAtLevel(field, W, H, 128, -1, true);
    const gated = maskAtLevel(field, W, H, 128, -1, true, matte);

    expect(naive.bits[0]).toBe(1);
    expect(gated.bits[0]).toBe(0);

    let gatedOn = 0;
    for (const b of gated.bits) gatedOn += b;
    // The disc is lighter than the cut, so the gated mask should be empty here.
    expect(gatedOn).toBe(0);
  });

  it('still cut the subject itself', () => {
    const gated = maskAtLevel(field, W, H, 255, -1, true, matte);
    let on = 0;
    for (const b of gated.bits) on += b;
    expect(on).toBeGreaterThan(300);
    expect(on).toBeLessThan(W * H);
  });

  it('carry the matte through maskAtCut too', () => {
    const gated = maskAtCut(field, W, H, 1, -1, true, matte);
    expect(gated.bits[0]).toBe(0);
    expect(gated.bits[(H / 2) * W + W / 2]).toBe(1);
  });
});

describe('quantisation', () => {
  it('does not spend a palette entry on the transparent ground', () => {
    const rgba = cutout();
    const palette = quantize(rgba, 3, { matte: buildMatte(rgba, 0.5) });
    // Every entry should come from the disc, which is light grey throughout.
    for (const c of palette) expect(lumaOf(c)).toBeGreaterThan(0.3);
  });
});

describe('spotting a cut-out on open', () => {
  it('ignores a stray near-transparent pixel', () => {
    const rgba = opaque();
    rgba[3] = 0;
    expect(hasTransparency(rgba)).toBe(false);
  });

  it('recognises a real matte', () => {
    expect(hasTransparency(cutout())).toBe(true);
  });

  it('says no to an empty buffer rather than throwing', () => {
    expect(hasTransparency(new Uint8ClampedArray(0))).toBe(false);
  });
});
