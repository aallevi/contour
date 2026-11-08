import type { Scene } from '../core/types';
import { exportSVG } from './svg';

/**
 * PNG output, by way of the SVG.
 *
 * Rasterising the vector file the browser already knows how to draw is both
 * less code and more faithful than a second renderer would be — the PNG is
 * guaranteed to agree with the SVG because it *is* the SVG.
 */
export async function exportPNG(scene: Scene, scale = 1): Promise<Uint8Array> {
  // Pixel units on the root, not inches: the browser rasterises an SVG at its
  // intrinsic size and then scales the bitmap, so a 300 dpi drawing declared as
  // 3.33 inches would be drawn at 320 pixels and blown up to the size asked
  // for. Stating the size in user units makes the intrinsic size the right one.
  const svg = exportSVG(scene, { pixelUnits: true });
  const width = Math.max(1, Math.round(scene.width * scale));
  const height = Math.max(1, Math.round(scene.height * scale));

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d')!;
    // A transparent document has to stay transparent; a papered one already
    // carries its background inside the SVG.
    g.drawImage(img, 0, 0, width, height);

    const out: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
