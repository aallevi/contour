import type { Paint, RGB, Scene, SceneGroup, SceneNode } from '../core/types';
import { exportSVG } from './svg';

/**
 * Films for screen printing: one black-on-white SVG per band, plus a colour
 * proof, every one with the same registration marks in a margin outside the
 * artwork — Stipple's Plates, for traced shapes.
 *
 * A film is the drawing itself with its colours replaced, so it goes through
 * the same `exportSVG` as the preview and the file and cannot disagree with
 * either. The band being filmed is painted black. Every band painted over it is
 * painted white where it is opaque, which knocks the film out wherever another
 * ink will cover the paper — the bands nest, so without that each film would
 * carry the whole of every darker band under its own. Bands that paint over it
 * with marks rather than a solid (hatching, stipple) overprint instead, as
 * marks do.
 *
 * A band whose fill is not one ink — a gradient, a freeform blend — cannot be a
 * film. It is left out and named, rather than thresholded into something that
 * only looks like what was on screen.
 */

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [1, 1, 1];

export type PlatePlan = { films: string[]; skipped: string[] };

const isOneInk = (g: SceneGroup): boolean =>
  g.nodes.every((n) => n.kind === 'stroke' || n.paint.kind === 'solid');

const isOpaque = (n: SceneNode): boolean =>
  n.kind === 'fill' && n.paint.kind === 'solid' && n.opacity >= 0.999;

const recolour = (n: SceneNode, rgb: RGB): SceneNode =>
  n.kind === 'stroke' ? { ...n, rgb, opacity: 1 } : { ...n, paint: { kind: 'solid', rgb } as Paint, opacity: 1 };

export function planPlates(scene: Scene): PlatePlan {
  const films: string[] = [];
  const skipped: string[] = [];
  for (const g of scene.groups) (isOneInk(g) ? films : skipped).push(g.name);
  return { films, skipped };
}

/** The scene as the film for group `index` in paint order. */
export function filmScene(scene: Scene, index: number): Scene {
  const groups: SceneGroup[] = [];
  const own = scene.groups[index];
  groups.push({ name: own.name, opacity: 1, nodes: own.nodes.map((n) => recolour(n, BLACK)) });
  for (let i = index + 1; i < scene.groups.length; i++) {
    const over = scene.groups[i].nodes.filter(isOpaque).map((n) => recolour(n, WHITE));
    if (over.length) groups.push({ name: `${scene.groups[i].name} knockout`, opacity: 1, nodes: over });
  }
  return { ...scene, background: WHITE, groups };
}

/**
 * Put a sheet in a margin with registration marks at the four corners and a
 * label, the same on every film so they line up on the press.
 */
function onSheet(scene: Scene, label: string): string {
  const inner = exportSVG(scene, { inline: true, pixelUnits: true });
  const m = Math.round(Math.min(scene.width, scene.height) * 0.08);
  const W = scene.width + 2 * m;
  const H = scene.height + 2 * m;
  const r = m * 0.28;
  const sw = Math.max(1, scene.dpi / 300);
  const mark = (x: number, y: number): string =>
    `<g stroke="#000" stroke-width="${sw}" fill="none">` +
    `<circle cx="${x}" cy="${y}" r="${r}"/>` +
    `<path d="M${x - r * 1.6},${y} H${x + r * 1.6} M${x},${y - r * 1.6} V${y + r * 1.6}"/></g>`;
  const inch = (px: number): string => (px / Math.max(1, scene.dpi)).toFixed(4);
  const marks = [
    mark(m / 2, m / 2), mark(W - m / 2, m / 2), mark(m / 2, H - m / 2), mark(W - m / 2, H - m / 2),
  ].join('');
  const esc = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${inch(W)}in" height="${inch(H)}in" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>` +
    `<svg x="${m}" y="${m}" width="${scene.width}" height="${scene.height}" ` +
    `viewBox="0 0 ${scene.width} ${scene.height}">${inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</svg>` +
    marks +
    `<text x="${W / 2}" y="${H - m / 2 + r * 0.4}" font-family="sans-serif" font-size="${r * 1.1}" ` +
    `text-anchor="middle">${esc}</text></svg>`;
}

const slug = (s: string): string => s.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'band';

/** Every film and the colour proof, ready to write. */
export function exportPlates(scene: Scene, base = 'drawing'): { files: { name: string; data: string }[]; skipped: string[] } {
  const files: { name: string; data: string }[] = [];
  const skipped: string[] = [];
  scene.groups.forEach((g, i) => {
    if (!isOneInk(g)) {
      skipped.push(g.name);
      return;
    }
    const n = String(files.length + 1).padStart(2, '0');
    files.push({ name: `${base}-plate-${n}-${slug(g.name)}.svg`, data: onSheet(filmScene(scene, i), `${n} ${g.name}`) });
  });
  files.push({ name: `${base}-proof.svg`, data: onSheet(scene, 'Proof') });
  return { files, skipped };
}
