import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toPBM, type Mask } from '../src/band/mask';
import { parsePath, pathBBox, toPathData, transformPath } from '../src/trace/path';
import {
  buildPayload, parsePotraceSVG, parseVtracerSVG, traceArgs, vtraceConfig, workingToCanvas,
} from '../src/trace/potrace';
import { traceFallback } from '../src/trace/fallback';
import { defaultTrace, defaultVtrace } from '../src/core/defaults';

const POTRACE = ['/opt/homebrew/bin/potrace', '/usr/local/bin/potrace', '/usr/bin/potrace']
  .find((p) => existsSync(p));

function disc(w: number, h: number, cx: number, cy: number, r: number, into?: Mask): Mask {
  const mask = into ?? { width: w, height: h, bits: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask.bits[y * w + x] = 1;
    }
  }
  return mask;
}

/** A ring: tests that holes survive the round trip with the right winding. */
function ring(w: number, h: number, outer: number, inner: number): Mask {
  const mask = disc(w, h, w / 2, h / 2, outer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x - w / 2) ** 2 + (y - h / 2) ** 2 <= inner * inner) mask.bits[y * w + x] = 0;
    }
  }
  return mask;
}

describe('path parsing', () => {
  it('turns relative commands into absolute ones', () => {
    const cmds = parsePath('M10 10 l5 0 l0 5 z');
    expect(cmds).toEqual([
      { t: 'M', x: 10, y: 10 },
      { t: 'L', x: 15, y: 10 },
      { t: 'L', x: 15, y: 15 },
      { t: 'Z' },
    ]);
  });

  it('treats a repeated pair after M as an implicit lineto', () => {
    const cmds = parsePath('M0 0 3 4 6 8');
    expect(cmds).toEqual([
      { t: 'M', x: 0, y: 0 },
      { t: 'L', x: 3, y: 4 },
      { t: 'L', x: 6, y: 8 },
    ]);
  });

  it('raises quadratics to cubics exactly', () => {
    // The midpoint of a quadratic and of its exact cubic elevation must agree.
    const q = parsePath('M0 0 Q10 20 20 0');
    expect(q[1].t).toBe('C');
    const c = q[1] as { x1: number; y1: number; x2: number; y2: number };
    expect(c.y1).toBeCloseTo((2 / 3) * 20, 6);
    expect(c.y2).toBeCloseTo((2 / 3) * 20, 6);
  });

  it('handles H and V', () => {
    expect(parsePath('M2 3 H8 V9')).toEqual([
      { t: 'M', x: 2, y: 3 },
      { t: 'L', x: 8, y: 3 },
      { t: 'L', x: 8, y: 9 },
    ]);
  });

  it('applies an affine transform to every coordinate', () => {
    const m = { a: 2, b: 0, c: 0, d: -2, e: 5, f: 100 };
    const out = transformPath(parsePath('M1 1 L3 4'), m);
    expect(out[0]).toEqual({ t: 'M', x: 7, y: 98 });
    expect(out[1]).toEqual({ t: 'L', x: 11, y: 92 });
  });

  it('round-trips through the serialiser', () => {
    const d = 'M1.5 2.25C3 4 5 6 7 8L9 10Z';
    expect(toPathData(parsePath(d))).toBe(d);
  });
});

describe('parsing potrace output', () => {
  it('reads the scale and flip off the group transform', () => {
    // A single point at potrace coordinates (100, 360) in a 48-tall bitmap
    // lands at (10, 12) once the group's transform is applied.
    const svg = `<svg><g transform="translate(0.000000,48.000000) scale(0.100000,-0.100000)"
      fill="#000000" stroke="none"><path d="M100 360 l0 0 z"/></g></svg>`;
    const cmds = parsePotraceSVG(svg, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(cmds[0]).toMatchObject({ t: 'M', x: 10 });
    expect((cmds[0] as { y: number }).y).toBeCloseTo(12, 6);
  });

  it('composes the flip with the working-to-canvas scale', () => {
    const svg = `<svg><g transform="translate(0.000000,48.000000) scale(0.100000,-0.100000)"
      ><path d="M100 360 z"/></g></svg>`;
    // 64x48 working, 640x480 canvas: everything ten times larger.
    const cmds = parsePotraceSVG(svg, workingToCanvas(64, 48, 640, 480));
    expect((cmds[0] as { x: number }).x).toBeCloseTo(100, 6);
    expect((cmds[0] as { y: number }).y).toBeCloseTo(120, 6);
  });

  it('merges every path in the document into one command list', () => {
    const svg = `<g transform="translate(0,10) scale(1,-1)">
      <path d="M0 0 L1 1 z"/><path d="M2 2 L3 3 z"/></g>`;
    const cmds = parsePotraceSVG(svg, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(cmds.filter((c) => c.t === 'M')).toHaveLength(2);
  });
});

/**
 * vtracer writes its SVG differently from potrace, and the difference matters.
 *
 * potrace puts one transform on a group and everything under it; vtracer traces
 * each cluster in its own cropped frame and gives every path a `translate` of
 * its own. Reading it the potrace way stacks every shape on the first one's
 * origin, which looks like a tracing failure rather than a parsing one.
 */
describe('parsing vtracer output', () => {
  it('applies each path\u2019s own translate', () => {
    const svg = `<svg width="64" height="48">
      <path d="M0,0 L1,0 L1,1 Z " fill="#000000" transform="translate(10,20)"/>
      <path d="M0,0 L2,0 L2,2 Z " fill="#000000" transform="translate(30,5)"/>
    </svg>`;
    const cmds = parseVtracerSVG(svg, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(cmds[0]).toEqual({ t: 'M', x: 10, y: 20 });
    // The second path keeps its own origin rather than inheriting the first's.
    const moves = cmds.filter((c) => c.t === 'M');
    expect(moves).toHaveLength(2);
    expect(moves[1]).toEqual({ t: 'M', x: 30, y: 5 });
  });

  it('composes the translate with the working-to-canvas scale', () => {
    const svg = '<path d="M0,0 L1,1 Z" transform="translate(4,3)"/>';
    const cmds = parseVtracerSVG(svg, workingToCanvas(64, 48, 640, 480));
    expect(cmds[0]).toEqual({ t: 'M', x: 40, y: 30 });
  });

  it('keeps holes, which arrive as extra subpaths in the same d', () => {
    const svg = '<path d="M0,0 L9,0 L9,9 Z M3,3 L6,3 L6,6 Z" transform="translate(0,0)"/>';
    const cmds = parseVtracerSVG(svg, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(cmds.filter((c) => c.t === 'M')).toHaveLength(2);
  });

  it('survives a path with no transform at all', () => {
    const cmds = parseVtracerSVG('<path d="M1,2 L3,4"/>', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(cmds[0]).toEqual({ t: 'M', x: 1, y: 2 });
  });
});

describe('the trace request payload', () => {
  it('lays out the header and the bitmaps so Rust can slice them apart', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const payload = buildPayload([a, b], [['-t', '2'], ['-t', '9']], '/bin/potrace');

    const headerLen = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(payload.slice(4, 4 + headerLen)));
    expect(header.jobs).toEqual([
      { len: 3, args: ['-t', '2'], vt: null },
      { len: 2, args: ['-t', '9'], vt: null },
    ]);
    expect(header.engine).toBe('potrace');
    expect(header.potrace).toBe('/bin/potrace');
    expect([...payload.slice(4 + headerLen)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('carries vtracer\u2019s settings instead of potrace\u2019s flags', () => {
    const vt = vtraceConfig({ ...defaultVtrace(), speckle: 16, mode: 'polygon' });
    const payload = buildPayload([new Uint8Array([1])], [[]], undefined, 'vtracer', vt);
    const headerLen = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(payload.slice(4, 4 + headerLen)));

    expect(header.engine).toBe('vtracer');
    expect(header.jobs[0].vt.mode).toBe('polygon');
    // Carried as an area so it means the same thing as potrace's -t; vtracer
    // squares its own value, so the side length is what goes over the wire.
    expect(header.jobs[0].vt.filter_speckle).toBe(4);
  });

  it('builds potrace flags from the parameters', () => {
    const args = traceArgs({ ...defaultTrace(), turdsize: 7, alphamax: 0.5, longcurve: true });
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('7');
    expect(args[args.indexOf('-a') + 1]).toBe('0.5');
    expect(args).toContain('-n');
  });

  it('clamps alphamax into the range potrace accepts', () => {
    expect(traceArgs({ ...defaultTrace(), alphamax: 99 })[3]).toBe('1.334');
    expect(traceArgs({ ...defaultTrace(), alphamax: -4 })[3]).toBe('0');
  });
});

describe.runIf(POTRACE)('end to end, through the real potrace', () => {
  const run = (mask: Mask, params = defaultTrace()): string =>
    execFileSync(POTRACE!, [...traceArgs(params), '-s', '-o', '-'], {
      input: Buffer.from(toPBM(mask)),
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });

  it('traces a disc into a closed path of about the right size', () => {
    const mask = disc(200, 200, 100, 100, 60);
    const cmds = parsePotraceSVG(run(mask), workingToCanvas(200, 200, 200, 200));
    expect(cmds.length).toBeGreaterThan(4);
    expect(cmds.some((c) => c.t === 'Z')).toBe(true);

    const box = pathBBox(cmds);
    // Pixels 40..160 are set, so the region is 121 units across.
    expect(box.w).toBeGreaterThan(118);
    expect(box.w).toBeLessThan(124);
    expect(box.x + box.w / 2).toBeCloseTo(100.5, 0);
    expect(box.y + box.h / 2).toBeCloseTo(100.5, 0);
  });

  it('keeps a hole as a second subpath', () => {
    const mask = ring(200, 200, 70, 35);
    const cmds = parsePotraceSVG(run(mask), workingToCanvas(200, 200, 200, 200));
    // Outer contour and hole: two movetos in the merged list.
    expect(cmds.filter((c) => c.t === 'M').length).toBe(2);
  });

  it('suppresses speckles at or below turdsize', () => {
    const mask = disc(200, 200, 100, 100, 60);
    disc(200, 200, 20, 20, 2, mask); // a tiny blob, area about 13 px
    const kept = parsePotraceSVG(run(mask, { ...defaultTrace(), turdsize: 2 }),
      workingToCanvas(200, 200, 200, 200));
    const dropped = parsePotraceSVG(run(mask, { ...defaultTrace(), turdsize: 40 }),
      workingToCanvas(200, 200, 200, 200));
    expect(kept.filter((c) => c.t === 'M').length).toBe(2);
    expect(dropped.filter((c) => c.t === 'M').length).toBe(1);
  });

  it('scales the trace into canvas coordinates', () => {
    const mask = disc(100, 100, 50, 50, 30);
    const cmds = parsePotraceSVG(run(mask), workingToCanvas(100, 100, 1000, 1000));
    const box = pathBBox(cmds);
    expect(box.x + box.w / 2).toBeCloseTo(505, -1);
    // Pixels 20..80 are set, so the region is 610 canvas units across; potrace
    // fits a smooth circle just inside that staircase.
    expect(box.w).toBeGreaterThan(585);
    expect(box.w).toBeLessThan(615);
  });
});

describe('the fallback tracer', () => {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  it('finds a disc and closes it', () => {
    const cmds = traceFallback(disc(120, 120, 60, 60, 40), defaultTrace(), identity);
    expect(cmds.length).toBeGreaterThan(4);
    const box = pathBBox(cmds);
    expect(box.w).toBeGreaterThan(70);
    expect(box.w).toBeLessThan(90);
  });

  it('finds the hole in a ring as a separate loop', () => {
    const cmds = traceFallback(ring(160, 160, 60, 28), defaultTrace(), identity);
    expect(cmds.filter((c) => c.t === 'M').length).toBe(2);
  });

  it('drops speckles below turdsize', () => {
    const mask = disc(160, 160, 80, 80, 50);
    disc(160, 160, 15, 15, 2, mask);
    const kept = traceFallback(mask, { ...defaultTrace(), turdsize: 1 }, identity);
    const dropped = traceFallback(mask, { ...defaultTrace(), turdsize: 60 }, identity);
    expect(kept.filter((c) => c.t === 'M').length).toBe(2);
    expect(dropped.filter((c) => c.t === 'M').length).toBe(1);
  });

  it('traces a rectangle with square corners', () => {
    const w = 100;
    const bits = new Uint8Array(w * w);
    for (let y = 20; y < 80; y++) for (let x = 25; x < 75; x++) bits[y * w + x] = 1;
    const cmds = traceFallback({ width: w, height: w, bits }, defaultTrace(), identity);
    const box = pathBBox(cmds);
    expect(box.x).toBeCloseTo(25, 0);
    expect(box.w).toBeCloseTo(50, 0);
    expect(box.h).toBeCloseTo(60, 0);
  });
});
