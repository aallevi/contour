import { cssRgb } from '../core/color';
import type { Paint, Scene, SceneNode } from '../core/types';

/**
 * SVG output.
 *
 * The same function serves the preview and the saved file, which is the point:
 * what is on screen is not a rendering of the export, it *is* the export, put
 * into the DOM instead of onto disk. There is no second renderer to drift.
 */

export type SVGOptions = {
  /** Leave the paper out, for placing the drawing over something else. */
  transparent?: boolean;
  /** Omit the XML declaration — a document destined for `innerHTML`. */
  inline?: boolean;
  /**
   * State the root size in user units rather than inches.
   *
   * Only the rasteriser wants this. A file destined for an editor has to carry
   * its physical size or it opens at the wrong scale; a file about to be drawn
   * into a canvas has to carry its pixel size, because the browser rasterises
   * an SVG at its intrinsic size and then scales the bitmap — so a 3.33in
   * drawing exported to a 1000px PNG came out rendered at 320px and blown up.
   */
  pixelUnits?: boolean;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function paintRef(paint: Paint, id: string, defs: string[]): string {
  if (paint.kind === 'solid') return cssRgb(paint.rgb);
  const stops = paint.stops
    .map((s) => `<stop offset="${round(s.offset)}" stop-color="${cssRgb(s.rgb)}"${
      s.alpha !== undefined && s.alpha < 1 ? ` stop-opacity="${round(s.alpha)}"` : ''
    }/>`)
    .join('');
  // userSpaceOnUse throughout: the coordinates were computed from the region's
  // real extent in canvas units, and objectBoundingBox would re-map them to the
  // path's bounds and undo that.
  if (paint.kind === 'linear') {
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
      `x1="${round(paint.x1)}" y1="${round(paint.y1)}" x2="${round(paint.x2)}" y2="${round(paint.y2)}">` +
      `${stops}</linearGradient>`,
    );
  } else {
    defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
      `cx="${round(paint.cx)}" cy="${round(paint.cy)}" r="${round(paint.r)}">${stops}</radialGradient>`,
    );
  }
  return `url(#${id})`;
}

const round = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * Geometry a node shares with others, hoisted into `<defs>` and referenced.
 *
 * A freeform gradient is one region path painted once per colour point, and a
 * hatch with a base wash paints its region twice. Writing the same few thousand
 * Bézier coordinates out four times over is both a large file and a slow one to
 * open. `<use>` says it once. Repeats are found by value rather than declared,
 * so nothing upstream has to know this is happening.
 */
type Shared = { ids: Map<string, string>; defs: string[] };

function shareId(shared: Shared, d: string): string | null {
  return shared.ids.get(d) ?? null;
}

function nodeToSVG(node: SceneNode, id: string, defs: string[], shared: Shared): string {
  const ref = shareId(shared, node.d);
  // `<use>` carries its own presentation attributes, so a shared outline can
  // still be filled differently by each node that references it.
  const geometry = ref
    ? `<use href="#${ref}" xlink:href="#${ref}"`
    : `<path d="${node.d}"`;

  if (node.kind === 'stroke') {
    return (
      `${geometry} fill="none" stroke="${cssRgb(node.rgb)}" ` +
      `stroke-width="${round(node.width)}" stroke-linecap="${node.cap}" stroke-linejoin="round"` +
      `${node.opacity < 1 ? ` stroke-opacity="${round(node.opacity)}"` : ''}/>`
    );
  }
  const fill = paintRef(node.paint, id, defs);
  return (
    `${geometry} fill="${fill}"` +
    `${node.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}` +
    `${node.opacity < 1 ? ` fill-opacity="${round(node.opacity)}"` : ''}/>`
  );
}

/**
 * Path data used by more than one node, with an id each.
 *
 * Only worth doing for geometry long enough that a reference is smaller than a
 * repeat; below that the `<defs>` entry and the `href` cost more than they save.
 */
function findShared(scene: Scene): Shared {
  const counts = new Map<string, number>();
  for (const g of scene.groups) {
    for (const n of g.nodes) counts.set(n.d, (counts.get(n.d) ?? 0) + 1);
  }
  const shared: Shared = { ids: new Map(), defs: [] };
  let i = 0;
  for (const [d, count] of counts) {
    if (count < 2 || d.length < worthSharing(count)) continue;
    const id = `s${i++}`;
    shared.ids.set(d, id);
    shared.defs.push(`<path id="${id}" d="${d}"/>`);
  }
  return shared;
}

/**
 * The shortest path data worth hoisting, given how many nodes repeat it.
 *
 * Writing `d` out k times costs roughly `k(N + 10)`; hoisting it costs the
 * definition, `N + 23`, plus about 32 for each reference. Setting the two equal
 * and solving for N gives this. At two repeats a path has to be fairly long
 * before a reference is smaller than saying it again; at six it barely has to
 * be a path at all.
 */
const worthSharing = (count: number): number => (23 + 22 * count) / (count - 1);

export function exportSVG(scene: Scene, opts: SVGOptions = {}): string {
  const shared = findShared(scene);
  const defs: string[] = [...shared.defs];
  const body: string[] = [];

  let n = 0;
  for (const group of scene.groups) {
    const inner = group.nodes
      .map((node) => nodeToSVG(node, `g${n++}`, defs, shared))
      .join('');
    if (!inner) continue;
    body.push(
      `<g id="${esc(group.name.replace(/[^\w-]+/g, '-'))}" ` +
      `inkscape:label="${esc(group.name)}" inkscape:groupmode="layer"` +
      `${group.opacity < 1 ? ` opacity="${round(group.opacity)}"` : ''}>${inner}</g>`,
    );
  }

  // Physical units on the root, user units in the viewBox.
  //
  // A bare width="1000" is 1000 CSS pixels, which an editor reads as 10.4in —
  // but a canvas pixel here is 1/dpi of an inch, so at 300 dpi the same drawing
  // is 3.33in. Stating the size in inches is what makes the file open at the
  // size the document panel promised, and what makes a hatch spacing of 4px
  // actually come out at 4/300 of an inch on paper.
  const inches = (px: number): string => (px / Math.max(1, scene.dpi)).toFixed(4);
  const size = (px: number): string =>
    (opts.pixelUnits ? round(px) : `${inches(px)}in`);

  const out: string[] = [];
  if (!opts.inline) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${size(scene.width)}" height="${size(scene.height)}" ` +
    `viewBox="0 0 ${round(scene.width)} ${round(scene.height)}">`,
  );
  if (defs.length) out.push(`<defs>${defs.join('')}</defs>`);
  if (scene.background && !opts.transparent) {
    out.push(
      `<rect x="0" y="0" width="${round(scene.width)}" height="${round(scene.height)}" ` +
      `fill="${cssRgb(scene.background)}"/>`,
    );
  }
  out.push(...body);
  out.push('</svg>');
  return out.join('\n');
}
