import { contrastInk, cssRgb } from '../core/color';
import { freePointGeometry } from '../fill';
import type { FreeformFill, FreePoint } from '../core/types';
import type { BBox } from '../trace/path';
import { el } from './controls';

/**
 * Editing a freeform gradient on the picture itself.
 *
 * A colour point has a position, and a position is a thing you point at. Put
 * the same control in the sidebar and it becomes two numbers you adjust and
 * then look up to check — which is how a feature meant to save work ends up
 * costing more of it. So the handles live on the stage, over the drawing, and
 * the panel is left with the parts that genuinely are numbers.
 *
 * The handles sit on the *stage* rather than inside the zoomed surface, and
 * their positions are converted on every pan and zoom. The alternative — an
 * overlay inside the transform — scales the handles with the drawing, so they
 * are dots at 8x and dinner plates at 0.1x.
 */

export type OverlayHost = {
  /** The freeform fill being edited, or null when nothing applies. */
  fill(): FreeformFill | null;
  /** The selected band's traced bounds, in canvas units. */
  bbox(): BBox | null;
  /** Canvas coordinates to stage pixels. */
  toStage(x: number, y: number): [number, number];
  /** Stage pixels back to canvas coordinates. */
  toCanvas(sx: number, sy: number): [number, number];
  /** Write a new point list. `key` groups a drag into one undo step. */
  setPoints(points: FreePoint[], key?: string): void;
  selected(): string | null;
  select(id: string | null): void;
};

type Handle = { handle: HTMLElement; reach: HTMLElement };

export class FreeformOverlay {
  readonly el: HTMLElement;
  private host: OverlayHost;
  private dragging: string | null = null;
  /**
   * The elements already on screen, by point id.
   *
   * Kept so that a drag can move a handle rather than replace it. Rebuilding
   * the overlay on every pointermove — which is what redrawing from scratch
   * amounts to — destroys the element holding the pointer capture, and the drag
   * ends on the first frame.
   */
  private handles = new Map<string, Handle>();

  constructor(host: OverlayHost) {
    this.host = host;
    this.el = el('div', 'freeform-overlay');
  }

  /**
   * Double-click on bare canvas adds a point where the cursor is.
   *
   * Wired to the stage rather than to the overlay, because the overlay has to
   * let pans and wheel events through to the stage underneath and an element
   * that ignores pointer events does not receive clicks either. Single click is
   * left alone: it pans, and a gradient you cannot pan around while editing is
   * worse than one more click.
   */
  addPointAt(clientX: number, clientY: number): boolean {
    const fill = this.host.fill();
    const box = this.host.bbox();
    if (!fill || !box) return false;
    const rect = this.el.getBoundingClientRect();
    const [cx, cy] = this.host.toCanvas(clientX - rect.left, clientY - rect.top);
    const point: FreePoint = {
      id: newId(),
      x: box.w === 0 ? 0.5 : (cx - box.x) / box.w,
      y: box.h === 0 ? 0.5 : (cy - box.y) / box.h,
      // The colour already there, so adding a point moves nothing until it is
      // asked to — the same rule the gradient bar follows.
      rgb: nearestColour(fill, box, cx, cy),
      radius: 0.45,
    };
    this.host.setPoints([...fill.points, point]);
    this.host.select(point.id);
    this.render();
    return true;
  }

  render(): void {
    const fill = this.host.fill();
    const box = this.host.bbox();
    if (!fill || !box) {
      this.el.classList.remove('on');
      this.el.replaceChildren();
      this.handles.clear();
      return;
    }
    this.el.classList.add('on');

    const live = new Set(fill.points.map((p) => p.id));
    for (const [id, h] of this.handles) {
      if (live.has(id)) continue;
      h.handle.remove();
      h.reach.remove();
      this.handles.delete(id);
    }

    const selected = this.host.selected();
    for (const p of fill.points) {
      let entry = this.handles.get(p.id);
      if (!entry) {
        // The reach ring goes in first so it sits behind every handle, not just
        // behind its own.
        const reach = el('span', 'free-reach');
        const handle = el('button', 'free-handle');
        handle.type = 'button';
        handle.dataset.id = p.id;
        handle.title = 'Drag to move \u00b7 alt-click to remove \u00b7 alt-scroll to resize';
        this.wireHandle(handle, p.id);
        this.el.prepend(reach);
        this.el.append(handle);
        entry = { handle, reach };
        this.handles.set(p.id, entry);
      }

      const { cx, cy, r } = freePointGeometry(p, box);
      const [sx, sy] = this.host.toStage(cx, cy);
      const [ex] = this.host.toStage(cx + r, cy);
      const radius = Math.max(4, Math.abs(ex - sx));

      entry.reach.style.left = `${sx - radius}px`;
      entry.reach.style.top = `${sy - radius}px`;
      entry.reach.style.width = `${radius * 2}px`;
      entry.reach.style.height = `${radius * 2}px`;
      entry.reach.classList.toggle('on', p.id === selected);

      entry.handle.style.left = `${sx}px`;
      entry.handle.style.top = `${sy}px`;
      entry.handle.style.background = cssRgb(p.rgb);
      entry.handle.style.borderColor = cssRgb(contrastInk(p.rgb));
      entry.handle.classList.toggle('on', p.id === selected);
    }
  }

  private wireHandle(handle: HTMLElement, id: string): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fill = this.host.fill();
      if (!fill) return;

      if (e.altKey) {
        // Never down to nothing: an empty freeform fill is a flat one, and a
        // fill that silently changes kind under the cursor is a surprise.
        if (fill.points.length > 1) {
          this.host.setPoints(fill.points.filter((p) => p.id !== id));
          this.host.select(null);
          this.render();
        }
        return;
      }

      this.dragging = id;
      this.host.select(id);
      handle.setPointerCapture?.(e.pointerId);
      this.render();
    });

    handle.addEventListener('pointermove', (e) => {
      if (this.dragging !== id) return;
      const fill = this.host.fill();
      const box = this.host.bbox();
      if (!fill || !box) return;
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const [cx, cy] = this.host.toCanvas(e.clientX - rect.left, e.clientY - rect.top);
      const next = fill.points.map((p) => (p.id === id
        ? {
          ...p,
          x: box.w === 0 ? p.x : (cx - box.x) / box.w,
          y: box.h === 0 ? p.y : (cy - box.y) / box.h,
        }
        : p));
      this.host.setPoints(next, `free:move:${id}`);
      this.render();
    });

    const release = () => {
      if (this.dragging === id) this.dragging = null;
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);

    // Alt-scroll resizes the point's reach, which is the other thing about a
    // blob you want to adjust while looking at it rather than at a slider.
    handle.addEventListener('wheel', (e) => {
      if (!e.altKey) return;
      const fill = this.host.fill();
      if (!fill) return;
      e.preventDefault();
      e.stopPropagation();
      const factor = Math.exp(-e.deltaY * 0.002);
      this.host.setPoints(
        fill.points.map((p) => (p.id === id
          ? { ...p, radius: Math.min(4, Math.max(0.02, p.radius * factor)) }
          : p)),
        `free:radius:${id}`,
      );
      this.render();
    }, { passive: false });
  }
}

/** The colour of whichever existing point is nearest, for a newly added one. */
function nearestColour(fill: FreeformFill, box: BBox, cx: number, cy: number) {
  let best = fill.base;
  let bestD = Infinity;
  for (const p of fill.points) {
    const g = freePointGeometry(p, box);
    const d = (g.cx - cx) ** 2 + (g.cy - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p.rgb;
    }
  }
  return best;
}

const newId = (): string => Math.random().toString(36).slice(2, 10);
