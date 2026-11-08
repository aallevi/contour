import type { Scene } from '../core/types';
import { isTauri } from '../platform';
import { renderRGBA } from './png';
import { exportSVG } from './svg';

/**
 * The light formats: the same drawing in fewer bytes.
 *
 * - Compact SVG is the SVG with its coordinates rounded to a tenth of a canvas
 *   pixel (at 300 ppi, under a hundredth of a millimetre), colours written as
 *   short hex and the space between tags taken out. Still an ordinary SVG.
 * - SVGZ is that, gzipped: the standard compressed SVG, which Illustrator and
 *   Inkscape open directly.
 * - WebP is the drawing as pixels, lossless, so flat colour stays flat with no
 *   JPEG smudge around every edge, at a fraction of a PNG's size.
 */

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Shorten an SVG without changing what it draws. */
export function compactSVG(svg: string): string {
  // Numbers inside geometry: path data, gradient ends, sizes.
  const tenth = (s: string): string => s.replace(/-?\d*\.\d+(?:e-?\d+)?/gi, (m) => {
    const v = Math.round(parseFloat(m) * 10) / 10;
    return Object.is(v, -0) ? '0' : String(v).replace(/^(-?)0\./, '$1.');
  });
  let out = svg.replace(/\s(d|points|x1|y1|x2|y2|cx|cy|r|stroke-width)="([^"]*)"/g,
    (_, k: string, v: string) => ` ${k}="${tenth(v)}"`);
  // Path commands need no space after a letter or before a minus sign.
  out = out.replace(/\sd="([^"]*)"/g, (_, d: string) =>
    ` d="${d.replace(/([A-Za-z])\s+/g, '$1').replace(/\s+([A-Za-z])/g, '$1').replace(/\s+-/g, '-').replace(/\s{2,}/g, ' ')}"`);
  // rgb(…) to #rrggbb, and #aabbcc to #abc where it can be.
  out = out.replace(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g, (_, r, g, b) => `#${hex2(+r)}${hex2(+g)}${hex2(+b)}`);
  out = out.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/gi, '#$1$2$3');
  return out.replace(/>\s+</g, '><').trim();
}

export function exportCompactSVG(scene: Scene): string {
  return compactSVG(exportSVG(scene));
}

/** Compact SVG, gzipped. */
export async function exportSVGZ(scene: Scene): Promise<Uint8Array> {
  const text = new TextEncoder().encode(exportCompactSVG(scene));
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Lossless WebP at the document's pixel size.
 *
 * Chrome and Firefox encode WebP from a canvas; Safari, and so the desktop
 * app's web view, quietly hands back a PNG instead. The desktop app then
 * encodes it natively, and a browser without an encoder says so rather than
 * saving a PNG under a .webp name.
 */
export async function exportWebP(scene: Scene): Promise<Uint8Array> {
  const { canvas, width, height } = await renderRGBA(scene, 1);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 1));
  if (blob && blob.type === 'image/webp') return new Uint8Array(await blob.arrayBuffer());
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const rgba = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    const out = await invoke<ArrayBuffer>('encode_webp', new Uint8Array(rgba.buffer), {
      headers: { 'x-size': `${width} ${height}` },
    });
    return new Uint8Array(out);
  }
  throw new Error('this browser cannot write WebP — try Chrome, Firefox or the desktop app');
}
