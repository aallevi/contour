// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exportSVG } from '../src/export/svg';
import type { Scene } from '../src/core/types';

const scene = (over: Partial<Scene> = {}): Scene => ({
  width: 600,
  height: 400,
  dpi: 300,
  background: [1, 1, 1],
  groups: [
    {
      name: 'Level 1',
      opacity: 1,
      nodes: [{
        kind: 'fill',
        d: 'M10 10L100 10L100 100L10 100Z',
        paint: { kind: 'solid', rgb: [0.1, 0.2, 0.3] },
        rule: 'nonzero',
        opacity: 1,
      }],
    },
  ],
  ...over,
});

const gradientScene = (): Scene => scene({
  groups: [{
    name: 'Shaded',
    opacity: 0.6,
    nodes: [
      {
        kind: 'fill',
        d: 'M0 0L200 0L200 200L0 200Z',
        paint: {
          kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 200,
          stops: [
            { offset: 0, rgb: [0, 0, 0] },
            { offset: 0.5, rgb: [0.5, 0.4, 0.3] },
            { offset: 1, rgb: [1, 1, 1] },
          ],
        },
        rule: 'nonzero',
        opacity: 1,
      },
      {
        kind: 'stroke',
        d: 'M0 0L50 50',
        rgb: [1, 0, 0],
        width: 2,
        opacity: 0.5,
        cap: 'round',
      },
    ],
  }],
});

describe('SVG export', () => {
  it('states its size in inches and its coordinates in canvas units', () => {
    const svg = exportSVG(scene());
    // 600 canvas pixels at 300 ppi is two inches. A bare width="600" would be
    // read as 6.25in and the drawing would print at three times the size.
    expect(svg).toContain('width="2.0000in"');
    expect(svg).toContain('height="1.3333in"');
    expect(svg).toContain('viewBox="0 0 600 400"');
  });

  it('parses as XML', () => {
    const doc = new DOMParser().parseFromString(exportSVG(scene()), 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.tagName).toBe('svg');
  });

  it('writes one group per band, named as the band is', () => {
    const doc = new DOMParser().parseFromString(exportSVG(scene()), 'image/svg+xml');
    const g = doc.querySelector('g');
    expect(g?.getAttribute('inkscape:label')).toBe('Level 1');
  });

  it('omits the paper when asked for a transparent document', () => {
    expect(exportSVG(scene())).toContain('<rect');
    expect(exportSVG(scene(), { transparent: true })).not.toContain('<rect');
    expect(exportSVG(scene({ background: null }))).not.toContain('<rect');
  });

  it('puts gradients in defs and refers to them', () => {
    const svg = exportSVG(gradientScene());
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const grad = doc.querySelector('linearGradient');
    expect(grad).not.toBeNull();
    expect(grad!.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
    expect(grad!.querySelectorAll('stop')).toHaveLength(3);
    const path = doc.querySelector('g > path');
    expect(path!.getAttribute('fill')).toBe(`url(#${grad!.id})`);
  });

  it('carries group opacity and stroke attributes through', () => {
    const doc = new DOMParser().parseFromString(exportSVG(gradientScene()), 'image/svg+xml');
    expect(doc.querySelector('g')!.getAttribute('opacity')).toBe('0.6');
    const stroke = doc.querySelectorAll('path')[1];
    expect(stroke.getAttribute('stroke-width')).toBe('2');
    expect(stroke.getAttribute('stroke-linecap')).toBe('round');
    expect(stroke.getAttribute('stroke-opacity')).toBe('0.5');
  });

  it('omits the XML declaration when it is destined for innerHTML', () => {
    expect(exportSVG(scene(), { inline: true }).startsWith('<svg')).toBe(true);
    expect(exportSVG(scene()).startsWith('<?xml')).toBe(true);
  });
});
