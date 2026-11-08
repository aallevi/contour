import type { Source } from '../core/types';
import { hasTransparency } from '../image/loader';
import { isTauri } from '../platform';

/**
 * Taking the background out of the picture.
 *
 * Every tool here produces a mask — 255 for subject, 0 for background — and
 * the mask goes into the source picture's own alpha. That is the matte a PNG
 * with its background removed already brings, so everything downstream (the
 * histogram, the bands, the lightest band, a sheet with no paper, the exports)
 * treats the result exactly as if a cut-out had been opened; there is no second
 * notion of "background" to keep in step.
 *
 * The picture as it was opened is kept beside it, so a cut can always be
 * undone back to the original, and so Vision always looks at the whole photo
 * rather than at an earlier cut of it.
 */

export type Point = [number, number];
export type Box = [number, number, number, number];
/** What a mask does to what is already there. */
export type CutOp = 'keep' | 'remove';

type Pixels = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };

async function pixelsOf(dataUrl: string): Promise<Pixels> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  return { width: c.width, height: c.height, rgba: g.getImageData(0, 0, c.width, c.height).data };
}

/** The original picture, before any cut. */
export const originalOf = (s: Source): string => s.original ?? s.data;

/**
 * Put a mask into the picture's alpha. `keep` keeps what is inside it, `remove`
 * takes it away; either way only ever removes, so cuts add up.
 */
export async function applyMask(source: Source, mask: Uint8Array, op: CutOp): Promise<Source> {
  const px = await pixelsOf(source.data);
  const a = px.rgba;
  for (let p = 0, i = 3; p < mask.length; p++, i += 4) {
    const m = op === 'keep' ? mask[p] : 255 - mask[p];
    a[i] = Math.round((a[i] * m) / 255);
  }
  const c = document.createElement('canvas');
  c.width = px.width;
  c.height = px.height;
  c.getContext('2d')!.putImageData(new ImageData(a, px.width, px.height), 0, 0);
  return {
    ...source,
    data: c.toDataURL('image/png'),
    transparent: hasTransparency(a),
    original: originalOf(source),
  };
}

/** The picture as it was opened. */
export async function restoreOriginal(source: Source): Promise<Source> {
  if (!source.original) return source;
  const px = await pixelsOf(source.original);
  const { original: _, ...rest } = source;
  return { ...rest, data: source.original, transparent: hasTransparency(px.rgba) };
}

/** A filled polygon, in source pixels, softened by a pixel at the edge. */
export function polygonMask(width: number, height: number, points: Point[]): Uint8Array {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.beginPath();
  points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
  const d = g.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let p = 0; p < out.length; p++) out[p] = d[p * 4 + 3];
  return out;
}

// -- Vision (desktop) ---------------------------------------------------------

export const visionAvailable = (): boolean => isTauri();

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Apple Vision's subject mask; with a box (fractions), only what is in it. */
async function visionMask(source: Source, box?: Box): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core');
  const headers: Record<string, string> = {};
  if (box) headers['x-box'] = box.map((v) => v.toFixed(5)).join(' ');
  let png = originalOf(source);
  // Vision reads PNG; a picture held as anything else is redrawn as one.
  if (!png.startsWith('data:image/png')) {
    const px = await pixelsOf(png);
    const c = document.createElement('canvas');
    c.width = px.width;
    c.height = px.height;
    c.getContext('2d')!.putImageData(new ImageData(px.rgba, px.width, px.height), 0, 0);
    png = c.toDataURL('image/png');
  }
  const out = await invoke<ArrayBuffer>('vision_subject', dataUrlBytes(png), { headers });
  const blob = new Blob([out], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const px = await pixelsOf(url);
    const mask = new Uint8Array(px.width * px.height);
    for (let p = 0; p < mask.length; p++) mask[p] = px.rgba[p * 4];
    return mask;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// -- colour model (anywhere) ---------------------------------------------------

/**
 * The subject by colour, for where Vision is not: a browser, an older Mac.
 *
 * Everything outside the box (or a strip round the frame, with no box) is
 * taken as background and the middle of the box as subject. Each side gets a
 * colour histogram, every pixel in the box goes to whichever side its colour is
 * likelier on, and the split is smoothed and the subject's histogram re-taken
 * from what was kept, a few times over — GrabCut's idea without its graph cut.
 * Then only the largest connected piece is kept, so stray specks of subject
 * colour in the background do not come along. It works on a plain or studio
 * ground and fails gracefully on a busy one; the polygon is there for the rest.
 */
export function colourSubject(px: Pixels, box?: Box): Uint8Array {
  const { width: w, height: h, rgba } = px;
  const b: Box = box ?? [0.04, 0.04, 0.96, 0.96];
  const x0 = Math.max(0, Math.floor(b[0] * w)), x1 = Math.min(w, Math.ceil(b[2] * w));
  const y0 = Math.max(0, Math.floor(b[1] * h)), y1 = Math.min(h, Math.ceil(b[3] * h));
  const BITS = 4;
  const bin = (i: number): number =>
    ((rgba[i] >> (8 - BITS)) << (2 * BITS)) | ((rgba[i + 1] >> (8 - BITS)) << BITS) | (rgba[i + 2] >> (8 - BITS));
  const N = 1 << (3 * BITS);
  const inBox = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

  const bg = new Float32Array(N);
  let bgN = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inBox(x, y) || rgba[(y * w + x) * 4 + 3] < 128) continue;
    bg[bin((y * w + x) * 4)]++;
    bgN++;
  }
  // With the box at the frame edge there may be nothing outside it: use the
  // box's own border instead.
  if (bgN < 50) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x > x0 + 3 && x < x1 - 4 && y > y0 + 3 && y < y1 - 4) continue;
      bg[bin((y * w + x) * 4)]++;
      bgN++;
    }
  }
  let mask = new Uint8Array(w * h);
  const cx0 = x0 + (x1 - x0) * 0.25, cx1 = x0 + (x1 - x0) * 0.75;
  const cy0 = y0 + (y1 - y0) * 0.25, cy1 = y0 + (y1 - y0) * 0.75;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) mask[y * w + x] = 1;
  }
  const blurBox = (src: Float32Array, r: number): Float32Array => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) acc += src[y * w + x + r];
        if (x - r - 1 >= 0) acc -= src[y * w + x - r - 1];
        if (x >= 0) tmp[y * w + x] = acc / (2 * r + 1);
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) acc += tmp[(y + r) * w + x];
        if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * w + x];
        if (y >= 0) out[y * w + x] = acc / (2 * r + 1);
      }
    }
    return out;
  };
  const r = Math.max(1, Math.round(Math.min(w, h) / 200));
  for (let iter = 0; iter < 4; iter++) {
    const fg = new Float32Array(N);
    let fgN = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p]) { fg[bin(p * 4)]++; fgN++; }
    const score = new Float32Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = y * w + x;
      const k = bin(p * 4);
      const pf = (fg[k] + 0.5) / (fgN + 1), pb = (bg[k] + 0.5) / (bgN + 1);
      score[p] = pf / (pf + pb);
    }
    const smooth = blurBox(score, r);
    const next = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) next[y * w + x] = smooth[y * w + x] > 0.5 ? 1 : 0;
    mask = next;
  }
  // Largest connected piece, holes inside it filled.
  const label = new Int32Array(w * h);
  let best = 0, bestSize = 0, n = 0;
  const stack: number[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || label[p]) continue;
    n++;
    let size = 0;
    stack.push(p);
    label[p] = n;
    while (stack.length) {
      const q = stack.pop()!;
      size++;
      const x = q % w, y = (q - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const t = yy * w + xx;
        if (mask[t] && !label[t]) { label[t] = n; stack.push(t); }
      }
    }
    if (size > bestSize) { bestSize = size; best = n; }
  }
  // Fill holes: background reachable from the frame stays background.
  const outside = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (label[y * w + x] !== best) { outside[y * w + x] = 1; stack.push(y * w + x); }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (label[y * w + x] !== best && !outside[y * w + x]) { outside[y * w + x] = 1; stack.push(y * w + x); }
  while (stack.length) {
    const q = stack.pop()!;
    const x = q % w, y = (q - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const t = yy * w + xx;
      if (!outside[t] && label[t] !== best) { outside[t] = 1; stack.push(t); }
    }
  }
  const hard = new Float32Array(w * h);
  for (let p = 0; p < hard.length; p++) hard[p] = outside[p] ? 0 : 1;
  const soft = blurBox(hard, 1);
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p++) out[p] = Math.round(soft[p] * 255);
  return out;
}

/**
 * The subject, by the best means to hand: Vision on the desktop, the colour
 * model elsewhere or if Vision finds nothing. Says which it used.
 */
export async function findSubject(source: Source, box?: Box): Promise<{ mask: Uint8Array; by: 'vision' | 'colour' }> {
  if (visionAvailable()) {
    try {
      return { mask: await visionMask(source, box), by: 'vision' };
    } catch (err) {
      // An older Mac, a placeholder helper, or no subject Vision recognises:
      // fall through to the colour model rather than fail outright.
      console.warn('Vision:', err);
    }
  }
  return { mask: colourSubject(await pixelsOf(originalOf(source)), box), by: 'colour' };
}
