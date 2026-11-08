import { describe, expect, it } from 'vitest';
import { defaultBand, normaliseProject } from '../src/core/defaults';
import { formatLength, lengthFrom, lengthIn, resolveBand } from '../src/core/scale';
import { exportPlates, filmScene, planPlates } from '../src/export/plates';
import type { Band, Project, Scene } from '../src/core/types';

/** The pieces carried over from Stipple that can be held without a browser. */

describe('lengths as a share of the picture', () => {
  const canvas = { width: 2000, height: 1000, dpi: 300, paper: [1, 1, 1] as [number, number, number], units: 'mm' as const };

  it('resolves against the short edge', () => {
    const band: Band = { ...defaultBand('a', [0, 0, 0], 0.5), fill: {
      kind: 'hatch', angle: 0, spacing: 0.01, weight: 0.002, cross: false, crossAngle: 90,
      toneWeight: 0, wave: 0, waveLength: 0.04, base: 0,
    } };
    const px = resolveBand(band, canvas);
    expect((px.fill as { spacing: number }).spacing).toBeCloseTo(10);
    expect((px.fill as { weight: number }).weight).toBeCloseTo(2);
    expect(px.outline.width).toBeCloseTo(band.outline.width * 1000);
  });

  it('round-trips every display unit', () => {
    for (const units of ['mm', 'in', '%', 'px'] as const) {
      const c = { ...canvas, units };
      expect(lengthFrom(lengthIn(0.0123, c), c)).toBeCloseTo(0.0123, 9);
    }
    expect(formatLength(0.01, canvas)).toBe('0.85 mm');
  });

  it('converts a version 1 document from pixels, against the canvas it was saved with', () => {
    const v1 = {
      version: 1,
      canvas: { width: 800, height: 500, dpi: 300, paper: [1, 1, 1] },
      bands: [{ ...defaultBand('a', [0, 0, 0], 0.5), outline: { on: true, colour: [0, 0, 0], width: 5 },
        fill: { kind: 'stipple', spacing: 10, size: 2.5, jitter: 0.5, toneSize: 0.5, toneDrop: 0, base: 0, seed: 1 } }],
    } as unknown as Partial<Project>;
    const p = normaliseProject(v1);
    expect(p.version).toBe(2);
    expect(p.canvas.units).toBe('mm');
    expect((p.bands[0].fill as { spacing: number }).spacing).toBeCloseTo(10 / 500);
    expect(p.bands[0].outline.width).toBeCloseTo(5 / 500);
    // And a version 2 document is left alone.
    expect(normaliseProject(p).bands[0].outline.width).toBeCloseTo(5 / 500);
  });
});

describe('plates', () => {
  const sq = (x: number) => `M${x},0 L${x + 10},0 L${x + 10},10 Z`;
  const scene: Scene = {
    width: 100, height: 100, dpi: 300, background: [1, 1, 1],
    groups: [
      { name: 'Light', opacity: 1, nodes: [{ kind: 'fill', d: sq(0), paint: { kind: 'solid', rgb: [0.8, 0.7, 0.5] }, rule: 'nonzero', opacity: 1 }] },
      { name: 'Ramp', opacity: 1, nodes: [{ kind: 'fill', d: sq(20), rule: 'nonzero', opacity: 1,
        paint: { kind: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, rgb: [0, 0, 0] }, { offset: 1, rgb: [1, 1, 1] }] } }] },
      { name: 'Dark', opacity: 0.8, nodes: [{ kind: 'fill', d: sq(40), paint: { kind: 'solid', rgb: [0.1, 0.1, 0.1] }, rule: 'nonzero', opacity: 1 }] },
    ],
  };

  it('plans a film per one-ink band and names the rest', () => {
    expect(planPlates(scene)).toEqual({ films: ['Light', 'Dark'], skipped: ['Ramp'], paper: [] });
  });

  it('gives no film to a band in the paper’s own colour', () => {
    const onPaper = { ...scene, background: scene.groups[0].nodes[0].kind === 'fill' && scene.groups[0].nodes[0].paint.kind === 'solid' ? scene.groups[0].nodes[0].paint.rgb : null };
    const plan = planPlates(onPaper as typeof scene);
    expect(plan.paper).toEqual(['Light']);
    expect(plan.films).toEqual(['Dark']);
  });

  it('paints its own band black and knocks out the opaque bands painted over it', () => {
    const film = filmScene(scene, 0);
    expect(film.background).toEqual([1, 1, 1]);
    expect(film.groups[0].nodes[0]).toMatchObject({ paint: { kind: 'solid', rgb: [0, 0, 0] }, opacity: 1 });
    // Dark is painted over Light, so it is white on Light's film; Ramp is not
    // solid, so it overprints and is not knocked out.
    expect(film.groups.slice(1).map((g) => g.name)).toEqual(['Dark knockout']);
    expect(film.groups[1].nodes[0]).toMatchObject({ paint: { rgb: [1, 1, 1] } });
  });

  it('writes the films and a proof, every one with the same registration marks', () => {
    const { files, skipped } = exportPlates(scene, 'job');
    expect(files.map((f) => f.name)).toEqual(['job-plate-01-light.svg', 'job-plate-02-dark.svg', 'job-proof.svg']);
    expect(skipped).toEqual(['Ramp']);
    const marks = files.map((f) => f.data.match(/<circle[^>]*>/g)?.join(''));
    expect(new Set(marks).size).toBe(1);
  });
});
