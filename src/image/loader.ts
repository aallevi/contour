import { decodeNative, isTauri } from '../platform';
import type { Source } from '../core/types';
import { decodeJXL, isJXL } from './jxl';

/**
 * Getting pixels out of a file.
 *
 * The web view decodes the common formats faster than anything we could hand
 * it, so it gets first refusal; only when it declines does the request go to
 * the native side, which has the `image` crate and, behind that, ImageMagick.
 */

export type LoadedImage = { bitmap: ImageBitmap; width: number; height: number };

/**
 * Bitmap options used everywhere an image enters the app.
 *
 * `premultiply` is stated rather than left at `default`, which is
 * implementation-defined — and the adjustment stack is built on knowing which
 * of the two it got. `colorSpaceConversion: 'none'` keeps an embedded profile
 * from being applied twice, once by the decoder and once by the display.
 */
const BITMAP_OPTS: ImageBitmapOptions = {
  premultiplyAlpha: 'premultiply',
  colorSpaceConversion: 'none',
};

async function fromBytes(bytes: Uint8Array, type?: string): Promise<LoadedImage | null> {
  try {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], type ? { type } : undefined);
    const bitmap = await createImageBitmap(blob, BITMAP_OPTS);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    return null;
  }
}

export async function loadImage(
  bytes: Uint8Array,
  path?: string,
): Promise<LoadedImage> {
  // Judged by content, never by name: a `.JXL` off a phone can be a JPEG, and
  // a JXL can arrive under any name or none (a drop from another app).
  const jxl = isJXL(bytes);
  const direct = await fromBytes(bytes, jxl ? 'image/jxl' : undefined);
  if (direct) return direct;

  if (jxl) {
    const data = await decodeJXL(bytes);
    const bitmap = await createImageBitmap(data, BITMAP_OPTS);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  }

  if (isTauri() && path) {
    const native = await decodeNative(path);
    if (native) {
      const data = new ImageData(new Uint8ClampedArray(native.rgba), native.width, native.height);
      const bitmap = await createImageBitmap(data, BITMAP_OPTS);
      return { bitmap, width: native.width, height: native.height };
    }
  }
  throw new Error('That file could not be decoded as an image.');
}

/**
 * Freeze an image into the document.
 *
 * A `.contour` file that only referenced a path would break the moment the
 * photograph moved, and the whole point of the format is that it survives being
 * handed to someone else. The source is re-encoded as PNG at a bounded size:
 * nothing downstream ever looks at more than the working resolution, so storing
 * a 60 megapixel original would cost a great deal for no visible difference.
 */
export const EMBED_LONG_EDGE = 2600;

export async function embedSource(
  img: LoadedImage,
  name: string,
): Promise<Source> {
  const longest = Math.max(img.width, img.height);
  const scale = Math.min(1, EMBED_LONG_EDGE / Math.max(1, longest));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img.bitmap, 0, 0, w, h);
  return {
    name,
    width: w,
    height: h,
    data: c.toDataURL('image/png'),
    transparent: hasTransparency(g.getImageData(0, 0, w, h).data),
  };
}

/** Turn an embedded source back into something the GPU can take. */
export async function decodeSource(source: Source): Promise<LoadedImage> {
  const img = new Image();
  img.src = source.data;
  await img.decode();
  const bitmap = await createImageBitmap(img, BITMAP_OPTS);
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

/** Wrap a canvas (the test card) as if it had been opened from disk. */
export async function sourceFromCanvas(c: HTMLCanvasElement, name: string): Promise<Source> {
  const g = c.getContext('2d');
  const pixels = g?.getImageData(0, 0, c.width, c.height).data;
  return {
    name,
    width: c.width,
    height: c.height,
    data: c.toDataURL('image/png'),
    transparent: pixels ? hasTransparency(pixels) : false,
  };
}

/**
 * Does this image have a matte worth honouring?
 *
 * One transparent pixel in a corner is a JPEG artefact or a rounding error, not
 * an intention. A twentieth of the frame is a cut-out, and a cut-out is what
 * flips the document to a transparent ground on open.
 */
export function hasTransparency(rgba: Uint8ClampedArray | Uint8Array): boolean {
  const pixels = rgba.length / 4;
  if (pixels === 0) return false;
  // Every 7th pixel: enough to find a background, cheap on a 2600px image, and
  // a stride that cannot line up with a repeating pattern.
  let clear = 0;
  let seen = 0;
  for (let p = 0; p < pixels; p += 7) {
    if (rgba[p * 4 + 3] < 250) clear++;
    seen++;
  }
  return seen > 0 && clear / seen > 0.02;
}
