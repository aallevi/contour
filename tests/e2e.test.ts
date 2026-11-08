import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { lumaOf } from '../src/core/color';
import {
  defaultBand, defaultFreeform, defaultTrace, defaultVtrace, makeBands,
} from '../src/core/defaults';
import { shapeMask, toPBM } from '../src/band/mask';
import {
  equalAreaThresholds, histogram, lowerCutOf, lumaField, maskAtCut, maskAtLevel,
} from '../src/band/posterize';
import { colourIndex, nearestPaletteIndex, quantize } from '../src/band/quantize';
import { parsePotraceSVG, traceArgs, workingToCanvas } from '../src/trace/potrace';
import { buildScene } from '../src/render/scene';
import { exportSVG } from '../src/export/svg';
import { exportPDF } from '../src/export/pdf';
import type { Band, Fill, Project } from '../src/core/types';
import type { Mask } from '../src/band/mask';
import type { PathCmd } from '../src/trace/path';
import type { AdjustedImage } from '../src/image/adjust';

/**
 * The whole pipeline, on a real picture, writing real files.
 *
 * Everything here except the GPU adjustment pass runs exactly as it does in the
 * app — the same banding, the same potrace binary, the same fill generators and
 * the same two serialisers. The outputs land in `artifacts/` so they can be
 * opened and looked at, which is the only way to check the part no assertion
 * covers: whether it produces a drawing worth having.
 */

const POTRACE = ['/opt/homebrew/bin/potrace', '/usr/local/bin/potrace']
  .find((p) => existsSync(p));
const MAGICK = ['/opt/homebrew/bin/magick', '/usr/local/bin/magick']
  .find((p) => existsSync(p));
const PNG = 'artifacts/source-cheetah.png';
const SOURCE = 'artifacts/source-cheetah.rgba';
const W = 880;
const H = 900;

const have = POTRACE && MAGICK && existsSync(PNG);

/**
 * The source, as raw pixels.
 *
 * Decoded by ImageMagick rather than checked in: Node has no image decoder, the
 * raw buffer is three megabytes, and the repository already holds the PNG it
 * comes from. Regenerating it here keeps the test self-sufficient without
 * carrying the same picture twice.
 */
function loadImage(): AdjustedImage {
  if (!existsSync(SOURCE)) {
    execFileSync(MAGICK!, [PNG, '-depth', '8', '-colorspace', 'sRGB', `RGBA:${SOURCE}`]);
  }
  const raw = readFileSync(SOURCE);
  return { width: W, height: H, rgba: new Uint8ClampedArray(raw.buffer, raw.byteOffset, W * H * 4) };
}

function trace(mask: Mask, canvasW: number, canvasH: number): PathCmd[] {
  const svg = execFileSync(POTRACE!, [...traceArgs(defaultTrace()), '-s', '-o', '-'], {
    input: Buffer.from(toPBM(mask)),
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  return parsePotraceSVG(svg, workingToCanvas(mask.width, mask.height, canvasW, canvasH));
}

/** Everything the engine does between an adjusted image and a scene. */
function run(image: AdjustedImage, bands: Band[], project: Project) {
  const masks = new Map<string, Mask>();
  const paths = new Map<string, PathCmd[]>();
  const tone = project.banding.mode === 'tone';

  const palette = project.banding.palette;
  const field = tone
    ? lumaField(image.rgba, image.width, image.height)
    : colourIndex(image.rgba, image.width, image.height, palette);

  const levels = bands.map((b) => (tone
    ? Math.round(b.threshold * 255)
    : nearestPaletteIndex(palette, b.source)));
  const lower = (l: number): number => {
    let best = -1;
    for (const v of levels) if (v < l && v > best) best = v;
    return best;
  };

  for (let i = 0; i < bands.length; i++) {
    const raw = maskAtLevel(field, image.width, image.height, levels[i],
      lower(levels[i]), project.banding.nested);
    const mask = shapeMask(raw, bands[i].shaping);
    masks.set(bands[i].id, mask);
    paths.set(bands[i].id, trace(mask, project.canvas.width, project.canvas.height));
  }

  return buildScene({ ...project, bands }, {
    masks, paths, image, scale: project.canvas.width / image.width,
  });
}

const baseProject = (over: Partial<Project> = {}): Project => ({
  version: 2,
  canvas: { width: 880, height: 900, dpi: 300, paper: [0.97, 0.96, 0.93], units: 'mm' },
  source: null,
  adjust: {} as Project['adjust'],
  banding: {
    mode: 'tone', levels: 5, spacing: 'equal-area', thresholds: [],
    palette: [], locked: [], nested: true, alphaCut: 0.5, resolution: 900,
  },
  tracer: 'potrace',
  trace: defaultTrace(),
  vtrace: defaultVtrace(),
  bands: [],
  ...over,
});

describe.runIf(have)('the whole pipeline, on a real picture', () => {
  // A skipped describe still runs its body to collect the tests, so the
  // picture is read only once a test asks for it — a fresh clone has no
  // artifacts/ and must skip cleanly rather than fail on the missing file.
  let loaded: AdjustedImage | null = null;
  const lazy = (): AdjustedImage => {
    if (!loaded) {
      mkdirSync('artifacts', { recursive: true });
      loaded = loadImage();
    }
    return loaded;
  };
  const image = new Proxy({} as AdjustedImage, { get: (_, k) => lazy()[k as keyof AdjustedImage] });

  it('posterises into nested tone bands and exports both formats', async () => {
    const project = baseProject();
    const thresholds = equalAreaThresholds(histogram(image.rgba), project.banding.levels);
    const bands = makeBands(project.banding.levels, [0.09, 0.06, 0.05], [0.99, 0.98, 0.95]);
    bands.forEach((b, i) => { b.threshold = thresholds[i]; });

    const scene = run(image, bands, project);
    expect(scene.groups).toHaveLength(bands.length);
    // No band may come back empty. A band can legitimately be simple — this
    // picture is more than half pure white, so the top equal-area threshold
    // lands on white and that band traces to the canvas rectangle — but a band
    // with nothing in it means a level was spent on a tone that is not there.
    for (const g of scene.groups) expect(g.nodes[0].d.length).toBeGreaterThan(20);
    // The darker bands are where the drawing is, and they must carry real detail.
    const detailed = scene.groups.filter((g) => g.nodes[0].d.length > 2000);
    expect(detailed.length).toBeGreaterThanOrEqual(3);

    const svg = exportSVG(scene);
    writeFileSync('artifacts/tone-bands.svg', svg);
    const pdf = await exportPDF(scene);
    writeFileSync('artifacts/tone-bands.pdf', pdf);

    expect(svg).toContain('viewBox="0 0 880 900"');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('quantises into colour regions that recover the source palette', async () => {
    const palette = quantize(image.rgba, 6);
    const project = baseProject({
      banding: {
        mode: 'colour', levels: 6, spacing: 'equal-area', thresholds: [],
        palette, locked: [], nested: true, alphaCut: 0.5, resolution: 900,
      },
    });
    // The lightest entry is the paper; the rest become bands.
    const bands = palette.slice(0, -1).map((c, i) =>
      defaultBand(`Colour ${i + 1}`, c, 0));
    bands.forEach((b, i) => { b.source = palette[i]; });
    project.canvas.paper = palette[palette.length - 1];

    const scene = run(image, bands, project);
    const svg = exportSVG(scene);
    writeFileSync('artifacts/colour-regions.svg', svg);
    writeFileSync('artifacts/colour-regions.pdf', await exportPDF(scene));

    // The cheetah is a dark-on-tan illustration, so the palette should hold a
    // near-black and a light tan.
    expect(Math.min(...palette.map(lumaOf))).toBeLessThan(0.2);
    expect(Math.max(...palette.map(lumaOf))).toBeGreaterThan(0.75);
    expect(scene.groups.length).toBe(bands.length);
  });

  it('shades the bands with hatching, gradients, stipple and freeform', async () => {
    const project = baseProject();
    const thresholds = equalAreaThresholds(histogram(image.rgba), 6);
    // Lengths are fractions of the short edge; these were tuned in pixels on this
    // 880-pixel-wide canvas.
    const px = (v: number): number => v / 880;
    const fills: Fill[] = [
      { kind: 'hatch', angle: 45, spacing: px(5), weight: px(1.6), cross: true, crossAngle: 80,
        toneWeight: 0.85, wave: 0, waveLength: px(40), base: 0.12 },
      { kind: 'hatch', angle: -20, spacing: px(7), weight: px(1.4), cross: false, crossAngle: 90,
        toneWeight: 0.6, wave: 0, waveLength: px(40), base: 0 },
      { kind: 'stipple', spacing: px(5), size: px(2.6), jitter: 0.8, toneSize: 0.7,
        toneDrop: 0.4, base: 0, seed: 3 },
      { kind: 'gradient', shape: 'linear', angle: 'auto', sampled: true,
        stops: [
          { offset: 0, rgb: [0, 0, 0] },
          { offset: 0.45, rgb: [0.4, 0.4, 0.4] },
          { offset: 1, rgb: [1, 1, 1] },
        ],
        start: 0, end: 1, radius: 1, cx: 0.5, cy: 0.5 },
      defaultFreeform([0.55, 0.42, 0.2], 0.28),
    ];
    const bands = makeBands(6, [0.08, 0.06, 0.05], [0.99, 0.98, 0.95]);
    bands.forEach((b, i) => {
      b.threshold = thresholds[i];
      b.fill = fills[i];
    });

    const scene = run(image, bands, project);
    const svg = exportSVG(scene);
    writeFileSync('artifacts/shaded.svg', svg);
    writeFileSync('artifacts/shaded.pdf', await exportPDF(scene));

    const kinds = scene.groups.flatMap((g) => g.nodes.map((n) => n.kind));
    expect(kinds).toContain('fill');
    // Each shading kind must have produced the paint it promises.
    const paints = scene.groups.flatMap((g) => g.nodes
      .filter((n) => n.kind === 'fill')
      .map((n) => (n as { paint: { kind: string } }).paint.kind));
    expect(paints).toContain('linear');
    expect(paints).toContain('radial');
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('<radialGradient');
    // The freeform band paints its outline once and references it after that.
    expect(svg).toContain('<use href=');

    // And the PDF carries the freeform blobs' transparency as soft masks,
    // because a PDF shading has no such thing as a transparent stop.
    const pdf = new TextDecoder('latin1').decode(await exportPDF(scene));
    expect(pdf).toContain('/S /Luminosity');
  });

  it('nesting leaves no gaps where unnested banding does', () => {
    const thresholds = equalAreaThresholds(histogram(image.rgba), 4);
    const field = lumaField(image.rgba, image.width, image.height);
    const cuts = thresholds;

    // Nested: the union of all bands is the lightest band's own mask.
    const nested = cuts.map((c) =>
      maskAtCut(field, image.width, image.height, c, lowerCutOf(cuts, c), true));
    for (let i = 1; i < nested.length; i++) {
      for (let p = 0; p < field.length; p += 997) {
        if (nested[i - 1].bits[p]) expect(nested[i].bits[p]).toBe(1);
      }
    }

    // Unnested: each pixel belongs to exactly one band, or to the paper.
    const flat = cuts.map((c) =>
      maskAtCut(field, image.width, image.height, c, lowerCutOf(cuts, c), false));
    for (let p = 0; p < field.length; p += 997) {
      const hits = flat.reduce((n, m) => n + m.bits[p], 0);
      expect(hits).toBeLessThanOrEqual(1);
    }
  });
});
