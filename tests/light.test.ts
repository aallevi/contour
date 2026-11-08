import { describe, expect, it } from 'vitest';
import { compactSVG } from '../src/export/light';
import { blurFor } from '../src/pipeline/engine';

describe('compact SVG', () => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="a">
    <path d="M 10.123456 20.987654 C 30.55555 40.44444 50.0001 60.9999 -70.25 80.75 Z" fill="rgb(255, 255, 255)"/>
    <path d="M1 2L3 4" fill="rgb(18, 52, 86)" stroke-width="1.23456"/>
  </g>
</svg>`;
  const out = compactSVG(svg);

  it('is smaller', () => {
    expect(out.length).toBeLessThan(svg.length * 0.8);
  });

  it('keeps every coordinate to a tenth of a pixel', () => {
    const nums = (s: string) => (s.match(/d="([^"]*)"/)![1].match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const a = nums(svg), b = nums(out);
    expect(b).toHaveLength(a.length);
    a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(0.05 + 1e-9));
  });

  it('writes colours as short hex and drops the space between tags', () => {
    expect(out).toContain('fill="#fff"');
    expect(out).toContain('fill="#123456"');
    expect(out).not.toMatch(/>\s+</);
  });
});

describe('relative blur', () => {
  it('is the slider value on a 1000 px picture and less on a smaller one', () => {
    expect(blurFor(2, 1400, 1000)).toBeCloseTo(2);
    expect(blurFor(2, 300, 400)).toBeCloseTo(0.6);
  });
});
