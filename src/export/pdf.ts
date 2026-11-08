import type { Paint, Scene, SceneNode, Stop } from '../core/types';
import { parsePath } from '../trace/path';

/**
 * Vector PDF, written directly.
 *
 * Everything the scene can express has a PDF equivalent, which is why the scene
 * was designed the way it was. Solid fills and strokes are ordinary path
 * painting. Gradients are the one place PDF works differently from SVG: there
 * is no such thing as filling a path with a gradient, so the path becomes a
 * clip and the shading is painted through it.
 */

/**
 * Points per canvas pixel.
 *
 * A canvas pixel is 1/dpi of an inch — that is what the document panel says and
 * what hatch spacing and dot size are measured in. Using the CSS constant 72/96
 * here instead would make every PDF come out 3.125 times too large at the
 * default 300 dpi.
 */
const ptPerPx = (dpi: number): number => 72 / Math.max(1, dpi);

const f = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const col = (rgb: [number, number, number]): string =>
  `${f(clamp01(rgb[0]))} ${f(clamp01(rgb[1]))} ${f(clamp01(rgb[2]))}`;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** SVG path data to PDF path operators. Coordinates pass through unchanged. */
function pathOps(d: string): string {
  const out: string[] = [];
  for (const c of parsePath(d)) {
    if (c.t === 'M') out.push(`${f(c.x)} ${f(c.y)} m`);
    else if (c.t === 'L') out.push(`${f(c.x)} ${f(c.y)} l`);
    else if (c.t === 'C') out.push(`${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)} c`);
    else out.push('h');
  }
  return out.join('\n');
}

type Obj = { dict: string; stream?: Uint8Array };

/**
 * A stitched exponential function: the PDF way to say "three or more stops".
 *
 * The stops' own offsets set the boundaries, including the first and the last.
 * Reading only the intermediate ones — which is the obvious way to build the
 * `/Bounds` array and the way this used to do it — stretches the ramp across
 * the whole domain and quietly ignores where the ends were put, so a gradient
 * running from 0.2 to 0.8 came out of SVG with flat margins and out of PDF
 * without them. A constant piece at each end is how SVG's `pad` spread is
 * said in PDF.
 */
function stopsFunction(stops: Stop[], components = 3): string {
  // One component for a soft mask's grey, three for colour. The stop list is
  // the same shape either way, so the only difference is how much of each
  // colour triple is written out.
  const out = (c: [number, number, number]): string =>
    (components === 1 ? f(clamp01(c[0])) : col(c));

  const sorted = [...stops]
    .map((s) => ({ offset: clamp01(s.offset), rgb: s.rgb }))
    .sort((a, b) => a.offset - b.offset);
  if (sorted.length < 2) {
    const c = sorted[0]?.rgb ?? [0, 0, 0];
    return `<< /FunctionType 2 /Domain [0 1] /C0 [${out(c)}] /C1 [${out(c)}] /N 1 >>`;
  }

  const pieces: string[] = [];
  const bounds: number[] = [];
  const encode: string[] = [];
  const constant = (c: [number, number, number]): string =>
    `<< /FunctionType 2 /Domain [0 1] /C0 [${out(c)}] /C1 [${out(c)}] /N 1 >>`;

  if (sorted[0].offset > 0) {
    pieces.push(constant(sorted[0].rgb));
    encode.push('0 1');
    bounds.push(sorted[0].offset);
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    pieces.push(
      `<< /FunctionType 2 /Domain [0 1] /C0 [${out(sorted[i].rgb)}] ` +
      `/C1 [${out(sorted[i + 1].rgb)}] /N 1 >>`,
    );
    encode.push('0 1');
    if (i < sorted.length - 2) bounds.push(sorted[i + 1].offset);
  }
  const last = sorted[sorted.length - 1];
  if (last.offset < 1) {
    bounds.push(last.offset);
    pieces.push(constant(last.rgb));
    encode.push('0 1');
  }
  if (pieces.length === 1) return pieces[0];

  // `/Bounds` has to be strictly increasing: two stops sharing an offset are a
  // hard edge, which is legitimate, and a repeated bound is not. The gap has to
  // be at least one step of the number format, or the separation is real in the
  // arithmetic here and gone by the time it is written out.
  const STEP = 0.001;
  const tidy: string[] = [];
  let prev = 0;
  for (const b of bounds) {
    const v = Math.min(1 - STEP, Math.max(prev + STEP, b));
    tidy.push(f(v));
    prev = v;
  }

  return (
    `<< /FunctionType 3 /Domain [0 1] /Functions [${pieces.join(' ')}] ` +
    `/Bounds [${tidy.join(' ')}] /Encode [${encode.join(' ')}] >>`
  );
}

/**
 * The same ramp again, as greyscale alpha rather than colour.
 *
 * PDF has no such thing as a transparent gradient stop. What it has is a soft
 * mask: a second shading, painted in DeviceGray into a transparency group,
 * whose *luminosity* is read as the alpha of everything drawn under it. So a
 * freeform gradient's soft blobs come out as a pair — the colour shading, and
 * this, its shadow in grey.
 */
function alphaFunction(stops: Stop[]): string {
  const grey = stops.map((s) => {
    const a = s.alpha === undefined ? 1 : clamp01(s.alpha);
    return { offset: s.offset, rgb: [a, a, a] as [number, number, number] };
  });
  return stopsFunction(grey, 1);
}

/** True when any stop is less than fully opaque, so a soft mask is needed. */
export const needsSoftMask = (paint: Paint): boolean =>
  paint.kind !== 'solid' && paint.stops.some((s) => s.alpha !== undefined && s.alpha < 1);

function shadingDict(
  paint: Exclude<Paint, { kind: 'solid' }>,
  opts: { alpha?: boolean } = {},
): string {
  const fn = opts.alpha ? alphaFunction(paint.stops) : stopsFunction(paint.stops);
  const space = opts.alpha ? '/DeviceGray' : '/DeviceRGB';
  if (paint.kind === 'linear') {
    return (
      `<< /ShadingType 2 /ColorSpace ${space} ` +
      `/Coords [${f(paint.x1)} ${f(paint.y1)} ${f(paint.x2)} ${f(paint.y2)}] ` +
      `/Function ${fn} /Extend [true true] >>`
    );
  }
  // r0 = 0: a point source expanding to the rim, which is what the SVG
  // radialGradient with no focal point means.
  return (
    `<< /ShadingType 3 /ColorSpace ${space} ` +
    `/Coords [${f(paint.cx)} ${f(paint.cy)} 0 ${f(paint.cx)} ${f(paint.cy)} ${f(Math.max(0.001, paint.r))}] ` +
    `/Function ${fn} /Extend [true true] >>`
  );
}

export async function exportPDF(scene: Scene): Promise<Uint8Array> {
  const PT = ptPerPx(scene.dpi);
  const pw = scene.width * PT;
  const ph = scene.height * PT;

  const content: string[] = [];
  const shadings: string[] = [];
  /** One transparency group per gradient that carries alpha. */
  const softMasks: { shading: string }[] = [];
  const gsValues: number[] = [];
  const gsIndex = (opacity: number): number => {
    const rounded = Math.round(opacity * 100) / 100;
    let i = gsValues.indexOf(rounded);
    if (i < 0) {
      i = gsValues.length;
      gsValues.push(rounded);
    }
    return i;
  };

  // One CTM for the whole page, so every coordinate below is a canvas pixel
  // with y running down — the same numbers the SVG file carries.
  content.push('q');
  content.push(`${f(PT)} 0 0 ${f(-PT)} 0 ${f(ph)} cm`);

  if (scene.background) {
    content.push(`${col(scene.background)} rg`);
    content.push(`0 0 ${f(scene.width)} ${f(scene.height)} re f`);
  }

  const emit = (node: SceneNode, groupOpacity: number): void => {
    const alpha = node.opacity * groupOpacity;
    if (alpha <= 0.001) return;
    const ops = pathOps(node.d);
    if (!ops) return;

    content.push('q');
    if (alpha < 1) content.push(`/GS${gsIndex(alpha)} gs`);

    if (node.kind === 'stroke') {
      content.push(`${col(node.rgb)} RG`);
      content.push(`${f(node.width)} w`);
      content.push(node.cap === 'round' ? '1 J 1 j' : '0 J 1 j');
      content.push(ops);
      content.push('S');
    } else if (node.paint.kind === 'solid') {
      content.push(`${col(node.paint.rgb)} rg`);
      content.push(ops);
      content.push(node.rule === 'evenodd' ? 'f*' : 'f');
    } else {
      // No gradient fills in PDF: clip to the path, then paint the shading
      // across the clip. `W n` sets the clip without also painting the path.
      const name = `Sh${shadings.length}`;
      shadings.push(`/${name} ${shadingDict(node.paint)}`);
      if (needsSoftMask(node.paint)) {
        // A gradient with transparent stops — a freeform gradient's blobs —
        // needs its alpha painted separately as a luminosity mask. The mask is
        // applied with the page CTM already in force, so its group can use the
        // same canvas coordinates as everything else here.
        const mask = `SM${softMasks.length}`;
        softMasks.push({ shading: shadingDict(node.paint, { alpha: true }) });
        content.push(`/${mask} gs`);
      }
      content.push(ops);
      content.push(node.rule === 'evenodd' ? 'W* n' : 'W n');
      content.push(`/${name} sh`);
    }
    content.push('Q');
  };

  for (const group of scene.groups) {
    for (const node of group.nodes) emit(node, group.opacity);
  }
  content.push('Q');

  const raw = new TextEncoder().encode(content.join('\n'));
  const { bytes: streamBytes, filter } = await deflate(raw);

  const objects: Obj[] = [];
  const add = (dict: string, stream?: Uint8Array): number => {
    objects.push({ dict, stream });
    return objects.length; // object numbers are 1-based
  };

  // The mask groups come first, because the page's ExtGState entries have to
  // name them by object number and an object cannot be referenced before it
  // has one.
  const enc = new TextEncoder();
  const maskIds = softMasks.map((m) => {
    const body = enc.encode('/MSh0 sh');
    return add(
      `<< /Type /XObject /Subtype /Form /FormType 1 ` +
      `/BBox [0 0 ${f(scene.width)} ${f(scene.height)}] ` +
      `/Group << /S /Transparency /CS /DeviceGray /I false /K false >> ` +
      `/Resources << /Shading << /MSh0 ${m.shading} >> >> ` +
      `/Length ${body.length} >>`,
      body,
    );
  });

  const contentId = add(
    `<< /Length ${streamBytes.length}${filter ? ` /Filter /${filter}` : ''} >>`,
    streamBytes,
  );
  const pagesId = objects.length + 2;
  const gsRefs = [
    ...gsValues.map((v, i) => `/GS${i} << /Type /ExtGState /ca ${f(v)} /CA ${f(v)} >>`),
    // `/BC [0]` is the backdrop: black is zero luminosity, so anything outside
    // the group's own box is fully transparent rather than fully painted.
    ...maskIds.map((id, i) =>
      `/SM${i} << /Type /ExtGState /SMask << /S /Luminosity /G ${id} 0 R /BC [0] >> >>`),
  ].join(' ');
  const pageId = add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] ` +
    `/Resources << /ExtGState << ${gsRefs} >> /Shading << ${shadings.join(' ')} >> >> ` +
    `/Contents ${contentId} 0 R >>`,
  );
  const pages = add(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);

  return assemble(objects, catalog);
}

/**
 * Compress the content stream if the platform will do it for us.
 *
 * A hatched or stippled drawing is hundreds of thousands of path operators, all
 * of them short decimal strings — which is close to the best case deflate ever
 * sees, routinely five to one. `CompressionStream` is in every current web view;
 * where it is not, an uncompressed PDF is a large PDF but still a valid one.
 */
async function deflate(bytes: Uint8Array): Promise<{ bytes: Uint8Array; filter: string | null }> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return { bytes, filter: null };
  try {
    const stream = new Blob([bytes.slice().buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new CS('deflate'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return { bytes: out, filter: 'FlateDecode' };
  } catch {
    return { bytes, filter: null };
  }
}

/** Serialise the objects with a correct cross-reference table. */
function assemble(objects: Obj[], catalogId: number): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    length += b.length;
  };

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const o = objects[i];
    push(`${i + 1} 0 obj\n${o.dict}\n`);
    if (o.stream) {
      push('stream\n');
      push(o.stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  }

  const xrefStart = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  xref += `startxref\n${xrefStart}\n%%EOF\n`;
  push(xref);

  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
