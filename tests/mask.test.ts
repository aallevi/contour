import { describe, expect, it } from 'vitest';
import { coverage, shapeMask, toPBM, type Mask } from '../src/band/mask';

function disc(w: number, h: number, r: number): Mask {
  const bits = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) bits[y * w + x] = 1;
    }
  }
  return { width: w, height: h, bits };
}

describe('PBM packing', () => {
  it('writes a P4 header and pads rows to a byte', () => {
    const mask: Mask = { width: 12, height: 2, bits: new Uint8Array(24) };
    mask.bits[0] = 1;   // top-left
    mask.bits[11] = 1;  // top-right
    const pbm = toPBM(mask);
    const header = new TextDecoder().decode(pbm.slice(0, 8));
    expect(header).toBe('P4\n12 2\n');
    const body = pbm.slice(8);
    // 12 pixels is two bytes per row, four bytes in total.
    expect(body).toHaveLength(4);
    expect(body[0]).toBe(0b10000000);      // leftmost pixel is the high bit
    expect(body[1]).toBe(0b00010000);      // pixel 11 is bit 3 of the second byte
    expect(body[2]).toBe(0);
  });

  it('round-trips a known pattern', () => {
    const mask: Mask = { width: 8, height: 1, bits: Uint8Array.from([1, 0, 1, 0, 0, 0, 1, 1]) };
    const pbm = toPBM(mask);
    expect(pbm[pbm.length - 1]).toBe(0b10100011);
  });
});

describe('shaping', () => {
  it('leaves a mask alone when both controls are zero', () => {
    const m = disc(40, 40, 12);
    expect(shapeMask(m, { grow: 0, smooth: 0 })).toBe(m);
  });

  it('grows and shrinks a disc by about the requested radius', () => {
    const r = 18;
    const m = disc(90, 90, r);
    const base = coverage(m) * 90 * 90;

    const grown = coverage(shapeMask(m, { grow: 4, smooth: 0 })) * 90 * 90;
    const shrunk = coverage(shapeMask(m, { grow: -4, smooth: 0 })) * 90 * 90;

    // Area of a disc of radius r+4 and r-4, to within the discretisation.
    expect(grown / (Math.PI * (r + 4) ** 2)).toBeGreaterThan(0.9);
    expect(grown / (Math.PI * (r + 4) ** 2)).toBeLessThan(1.1);
    expect(shrunk / (Math.PI * (r - 4) ** 2)).toBeGreaterThan(0.9);
    expect(shrunk / (Math.PI * (r - 4) ** 2)).toBeLessThan(1.1);
    expect(grown).toBeGreaterThan(base);
    expect(shrunk).toBeLessThan(base);
  });

  it('smoothing alone barely changes the area of a round region', () => {
    const m = disc(90, 90, 20);
    const before = coverage(m);
    const after = coverage(shapeMask(m, { grow: 0, smooth: 3 }));
    expect(Math.abs(after - before) / before).toBeLessThan(0.06);
  });

  it('smoothing removes a one-pixel spike', () => {
    const w = 60;
    const m = disc(w, w, 18);
    // A single pixel far outside the disc: exactly the speckle that becomes an
    // unwanted contour.
    m.bits[3 * w + 3] = 1;
    const out = shapeMask(m, { grow: 0, smooth: 2 });
    expect(out.bits[3 * w + 3]).toBe(0);
  });
});
