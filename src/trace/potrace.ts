import type { TraceParams, Tracer, VtraceParams } from '../core/types';
import { toPBM, type Mask } from '../band/mask';
import { isTauri } from '../platform';
import { concat, parsePath, scaleTranslate, transformPath, type Matrix, type PathCmd } from './path';

/**
 * The bridge to the native tracers.
 *
 * Two of them. potrace is a command line program, so the whole exchange happens
 * through one native call: every band's bitmap in, every band's SVG back,
 * traced in parallel on the other side. Batching is not an optimisation detail
 * — a per-band round trip would put the IPC latency in series with itself once
 * per level, which is most of the cost at four levels and all of it at twelve.
 * vtracer is linked into the app rather than installed, but goes through the
 * same call for the same reason and because the two then share one code path
 * that can be switched with a segmented control.
 *
 * Both are handed exactly the same masks, so the choice between them is a
 * choice about curve fitting and nothing else.
 */

export type Tool = { path: string; version: string };
export type Tools = {
  potrace: Tool | null;
  magick: Tool | null;
  /** Compiled into the app, so never missing when running natively. */
  vtracer: Tool | null;
};

const NO_TOOLS: Tools = { potrace: null, magick: null, vtracer: null };

export async function probeTools(override?: { potrace?: string; magick?: string }): Promise<Tools> {
  if (!isTauri()) return NO_TOOLS;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<Tools>('probe_tools', {
      potracePath: override?.potrace ?? null,
      magickPath: override?.magick ?? null,
    });
  } catch {
    return NO_TOOLS;
  }
}

/** potrace's command line for one band. */
export function traceArgs(p: TraceParams): string[] {
  const args = [
    '-t', String(Math.max(0, Math.round(p.turdsize))),
    '-a', String(clampNum(p.alphamax, 0, 1.334)),
    '-O', String(clampNum(p.opttolerance, 0.01, 5)),
    '-z', p.turnpolicy,
    '-u', String(Math.max(1, Math.round(p.unit))),
  ];
  if (p.longcurve) args.push('-n');
  return args;
}

const clampNum = (v: number, lo: number, hi: number): number =>
  Math.round(Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo)) * 1000) / 1000;

/**
 * vtracer's settings, as the native side wants them.
 *
 * `speckle` is carried through the app as an area so that it means the same
 * thing whichever tracer is running; vtracer squares its own value, so the side
 * length is what goes over the wire.
 */
export function vtraceConfig(p: VtraceParams): Record<string, unknown> {
  return {
    filter_speckle: Math.max(0, Math.round(Math.sqrt(Math.max(0, p.speckle)))),
    mode: p.mode === 'polygon' || p.mode === 'pixel' ? p.mode : 'spline',
    corner_threshold: Math.round(clampNum(p.cornerThreshold, 0, 180)),
    length_threshold: clampNum(p.lengthThreshold, 3.5, 10),
    splice_threshold: Math.round(clampNum(p.spliceThreshold, 0, 180)),
    precision: Math.round(clampNum(p.precision, 1, 8)),
  };
}

export type TraceJobResult = {
  /** Absolute path commands, already in canvas coordinates. */
  cmds: PathCmd[];
  error: string | null;
  millis: number;
};

/**
 * Build the raw IPC payload: `[u32 header length][header JSON][bitmaps]`.
 *
 * Tauri serialises ordinary command arguments as JSON, which would turn a
 * half-megabyte bitmap into an array of five hundred thousand decimal numbers
 * and its own weight again in quotes and commas. A raw body moves the bytes as
 * bytes; the header rides in front of them so there is still exactly one call.
 */
export function buildPayload(
  bitmaps: Uint8Array[],
  args: string[][],
  potracePath?: string,
  engine: Tracer = 'potrace',
  vt?: Record<string, unknown>,
): Uint8Array {
  const header = JSON.stringify({
    engine,
    jobs: bitmaps.map((b, i) => ({ len: b.length, args: args[i] ?? [], vt: vt ?? null })),
    potrace: potracePath ?? null,
  });
  const headerBytes = new TextEncoder().encode(header);
  const total = 4 + headerBytes.length + bitmaps.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  let o = 4 + headerBytes.length;
  for (const b of bitmaps) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/**
 * Read potrace's SVG back into path commands.
 *
 * potrace emits its geometry ten times life size and upside down, under a
 * `<g transform>` that puts it right — the scale is its `-u` quantisation and
 * the flip is because it counts rows from the bottom. The transform is read off
 * the group rather than assumed, so changing the precision setting cannot
 * silently move every path by a factor of ten.
 */
export function parsePotraceSVG(svg: string, toCanvas: Matrix): PathCmd[] {
  const g = /<g\s+transform="translate\(([^)]*)\)\s*scale\(([^)]*)\)"/.exec(svg);
  let m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (g) {
    const [tx, ty] = g[1].split(/[,\s]+/).map(Number);
    const s = g[2].split(/[,\s]+/).map(Number);
    const sx = s[0];
    const sy = s.length > 1 ? s[1] : s[0];
    if ([tx, ty, sx, sy].every(Number.isFinite)) m = scaleTranslate(sx, sy, tx, ty);
  }
  const full = concat(m, toCanvas);

  // Every path in the document is one connected region with its own holes, all
  // filled nonzero. Concatenating them into a single command list is exact —
  // the regions are disjoint components of a bilevel mask, so no two of them
  // can overlap and contribute to the same winding number — and it leaves the
  // band as one node in the SVG rather than several thousand.
  const out: PathCmd[] = [];
  const re = /<path\b[^>]*\bd="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(svg))) {
    out.push(...transformPath(parsePath(match[1]), full));
  }
  return out;
}

/**
 * Read vtracer's SVG back into path commands.
 *
 * Different in shape from potrace's, and the difference is not cosmetic.
 * potrace puts one transform on a group and everything under it; vtracer emits
 * absolute coordinates per path with a `translate` of its own on each, because
 * each cluster is traced in its own cropped frame. Reading the group transform
 * and applying it to everything — which is what the potrace reader does — would
 * silently stack every band's shapes on the first one's origin.
 *
 * Holes come back as extra subpaths inside the same `d`, wound the other way,
 * so the nonzero fill rule the scene already uses is the right one.
 */
export function parseVtracerSVG(svg: string, toCanvas: Matrix): PathCmd[] {
  const out: PathCmd[] = [];
  const tag = /<path\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(svg))) {
    const el = match[0];
    const d = /\bd="([^"]*)"/.exec(el)?.[1];
    if (!d) continue;
    const t = /\btransform="translate\(([^)]*)\)"/.exec(el);
    let m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    if (t) {
      const [tx, ty] = t[1].split(/[,\s]+/).map(Number);
      if (Number.isFinite(tx) && Number.isFinite(ty)) m = scaleTranslate(1, 1, tx, ty);
    }
    out.push(...transformPath(parsePath(d), concat(m, toCanvas)));
  }
  return out;
}

/**
 * The matrix taking working-resolution pixels to canvas coordinates.
 *
 * Masks are built at the trace resolution, which is usually well below the
 * output size, so everything potrace returns has to be scaled up. Doing it here
 * rather than with an SVG `transform` on the group means stroke widths, hatch
 * spacing and dot sizes are all in the same units as the paths they sit on.
 */
export const workingToCanvas = (
  workW: number,
  workH: number,
  canvasW: number,
  canvasH: number,
): Matrix => scaleTranslate(canvasW / Math.max(1, workW), canvasH / Math.max(1, workH), 0, 0);

export type TraceRequest = {
  masks: Mask[];
  params: TraceParams[];
  canvasWidth: number;
  canvasHeight: number;
  potracePath?: string;
  /** Defaults to potrace, which is what every earlier caller meant. */
  engine?: Tracer;
  /** Required when `engine` is `vtracer`. Document-wide rather than per band. */
  vtrace?: VtraceParams;
};

/** Trace a whole band stack in one native call, with whichever tracer is chosen. */
export async function traceNative(req: TraceRequest): Promise<TraceJobResult[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const engine: Tracer = req.engine ?? 'potrace';
  const bitmaps = req.masks.map(toPBM);
  const payload = buildPayload(
    bitmaps,
    req.params.map(traceArgs),
    req.potracePath,
    engine,
    engine === 'vtracer' && req.vtrace ? vtraceConfig(req.vtrace) : undefined,
  );

  const results = await invoke<{ svg: string; error: string | null; millis: number }[]>(
    'trace_bands',
    payload,
  );

  const read = engine === 'vtracer' ? parseVtracerSVG : parsePotraceSVG;
  return results.map((r, i) => {
    if (r.error) return { cmds: [], error: r.error, millis: r.millis };
    const m = workingToCanvas(
      req.masks[i].width,
      req.masks[i].height,
      req.canvasWidth,
      req.canvasHeight,
    );
    return { cmds: read(r.svg, m), error: null, millis: r.millis };
  });
}

