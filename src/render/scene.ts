import { buildBandNodes } from '../fill';
import { resolveBand } from '../core/scale';
import type { Mask } from '../band/mask';
import type { AdjustedImage } from '../image/adjust';
import type { Project, Scene, SceneGroup } from '../core/types';
import type { PathCmd } from '../trace/path';

/**
 * Assembling the drawing.
 *
 * Bands are painted in reverse: the last band holds the largest, lightest
 * region and goes down first, and band zero — the darkest core — lands on top.
 * That order is the whole reason nesting works. Each band completely covers the
 * one after it in the list, so the bands overlap rather than abut and there is
 * no seam for the paper to show through.
 *
 * Dragging a band in the list reorders the painting and nothing else; the mask
 * belongs to the band, which is why the derived data is keyed by band id rather
 * than by position.
 */

export type Derived = {
  masks: Map<string, Mask>;
  paths: Map<string, PathCmd[]>;
  image: AdjustedImage | null;
  /** Canvas pixels per working pixel. */
  scale: number;
};

export function buildScene(project: Project, derived: Derived): Scene {
  const { canvas } = project;
  const groups: SceneGroup[] = [];

  if (derived.image) {
    for (let i = project.bands.length - 1; i >= 0; i--) {
      // Lengths are stored as fractions of the picture; the generators want pixels.
      const band = resolveBand(project.bands[i], canvas);
      const mask = derived.masks.get(band.id);
      const path = derived.paths.get(band.id);
      if (!mask || !path) continue;
      const nodes = buildBandNodes({
        mask,
        image: derived.image,
        path,
        scale: derived.scale,
        band,
      });
      if (nodes.length) groups.push({ name: band.name, opacity: band.opacity, nodes });
    }
  }

  return {
    width: canvas.width,
    height: canvas.height,
    dpi: canvas.dpi,
    background: canvas.paper,
    groups,
  };
}

/** Rough node and byte counts, for warning before an export gets unwieldy. */
export function sceneWeight(scene: Scene): { nodes: number; bytes: number } {
  let nodes = 0;
  let bytes = 0;
  for (const g of scene.groups) {
    for (const n of g.nodes) {
      nodes++;
      bytes += n.d.length;
    }
  }
  return { nodes, bytes };
}
