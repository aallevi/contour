import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { exportPDF } from '../src/export/pdf';
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

const text = (bytes: Uint8Array): string =>
  new TextDecoder('latin1').decode(bytes);

describe('PDF export', () => {
  it('is a PDF with a correct cross-reference table', async () => {
    const bytes = await exportPDF(scene());
    const raw = text(bytes);
    expect(raw.startsWith('%PDF-1.7')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);

    const startxref = Number(/startxref\s+(\d+)/.exec(raw)![1]);
    expect(raw.slice(startxref, startxref + 4)).toBe('xref');

    // Every offset in the table must actually land on that object's header.
    const table = raw.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(3);
    entries.forEach((offset, i) => {
      expect(raw.slice(offset, offset + 8)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
  });

  it('sizes the page from the dpi, not from CSS pixels', async () => {
    const raw = text(await exportPDF(scene()));
    // 600 x 400 canvas pixels at 300 ppi is 2 x 1.333 inches, so 144 x 96 points.
    expect(raw).toContain('/MediaBox [0 0 144 96]');
  });

  it('compresses the content stream and it inflates back', async () => {
    const bytes = await exportPDF(gradientScene());
    const raw = text(bytes);
    expect(raw).toContain('/Filter /FlateDecode');

    const start = raw.indexOf('stream\n') + 'stream\n'.length;
    const end = raw.indexOf('\nendstream', start);
    // Inflated with Node's zlib rather than the API that wrote it: PDF's
    // FlateDecode is RFC 1950, and this is what a reader will actually do.
    const content = inflateSync(bytes.slice(start, end)).toString('latin1');

    // The whole page is drawn under one flipping transform, so coordinates in
    // the content stream are canvas pixels with y running down.
    expect(content).toContain('cm');
    expect(content).toContain('0.24 0 0 -0.24 0 96 cm');
  });

  it('paints a gradient by clipping the path and shading through it', async () => {
    const bytes = await exportPDF(gradientScene());
    const raw = text(bytes);
    expect(raw).toContain('/ShadingType 2');
    expect(raw).toContain('/FunctionType 3');
    expect(raw).toContain('/Extend [true true]');

    const start = raw.indexOf('stream\n') + 'stream\n'.length;
    const end = raw.indexOf('\nendstream', start);
    const content = inflateSync(bytes.slice(start, end)).toString('latin1');
    expect(content).toMatch(/W n\s*\/Sh0 sh/);
  });

  it('records each distinct opacity once as a graphics state', async () => {
    const raw = text(await exportPDF(gradientScene()));
    expect(raw).toContain('/ExtGState');
    // Group opacity 0.6 and the stroke's own 0.5 x 0.6 = 0.3.
    expect(raw).toContain('/ca 0.6');
    expect(raw).toContain('/ca 0.3');
  });

  it('draws the paper only when there is paper', async () => {
    expect(text(await exportPDF(scene()))).toBeTruthy();
    const transparent = await exportPDF(scene({ background: null }));
    const raw = text(transparent);
    expect(raw).not.toContain(' re f');
  });

  /**
   * Where the end stops sit has to survive into the PDF.
   *
   * A stitching function's `/Bounds` holds only the *interior* boundaries, so
   * building it from the intermediate offsets alone silently stretches the ramp
   * across the whole domain — the SVG pads the margins with the end colours and
   * the PDF does not, and the two files stop agreeing. A constant piece at each
   * end is how SVG's `pad` spread is said in PDF.
   */
  const rampScene = (stops: { offset: number; rgb: [number, number, number] }[]): Scene =>
    scene({
      groups: [{
        name: 'Ramp',
        opacity: 1,
        nodes: [{
          kind: 'fill',
          d: 'M0 0L200 0L200 200L0 200Z',
          paint: { kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0, stops },
          rule: 'nonzero',
          opacity: 1,
        }],
      }],
    });

  it('keeps the flat margins of a ramp that does not start at 0', async () => {
    const raw = text(await exportPDF(rampScene([
      { offset: 0.25, rgb: [0, 0, 0] },
      { offset: 0.75, rgb: [1, 1, 1] },
    ])));
    // Three pieces: a constant black, the blend, a constant white — with the
    // two stop positions as the boundaries between them.
    expect(raw).toMatch(/\/Bounds \[0\.25 0\.75\]/);
    expect(raw).toMatch(/\/Encode \[0 1 0 1 0 1\]/);
  });

  it('uses a plain blend when the ramp already spans the domain', async () => {
    const raw = text(await exportPDF(rampScene([
      { offset: 0, rgb: [0, 0, 0] },
      { offset: 1, rgb: [1, 1, 1] },
    ])));
    // One piece, so no stitching function at all.
    expect(raw).not.toContain('/FunctionType 3');
    expect(raw).toContain('/FunctionType 2');
  });

  it('keeps Bounds strictly increasing when two stops share an offset', async () => {
    const raw = text(await exportPDF(rampScene([
      { offset: 0, rgb: [0, 0, 0] },
      { offset: 0.5, rgb: [1, 0, 0] },
      { offset: 0.5, rgb: [0, 0, 1] },
      { offset: 1, rgb: [1, 1, 1] },
    ])));
    const bounds = /\/Bounds \[([^\]]*)\]/.exec(raw)?.[1].split(' ').map(Number) ?? [];
    expect(bounds.length).toBeGreaterThan(0);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    }
  });
});
