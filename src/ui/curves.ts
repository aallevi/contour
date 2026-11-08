import { addCurvePoint, levelsFn, monotoneSpline, moveCurvePoint, removeCurvePoint } from '../image/curves';
import type { CurvePoint, Levels } from '../core/types';
import { el, onResize, type SyncHost } from './controls';

/**
 * The curve editor, and the threshold strip below it.
 *
 * Both draw over the same histogram, and that is the point of putting them next
 * to each other: the curve moves the tones and the strip shows where they get
 * cut. Watching a shadow band empty out as you lift the curve's foot is the
 * fastest way to understand what this pipeline does.
 *
 * The levels handles sit on this canvas too, on a rail under the x axis, and
 * they are the same document fields the Levels sliders write. Levels is a curve
 * — a clip, a gamma and a remap — so having it live somewhere the curve cannot
 * see it means every adjustment is made half blind. Here the black point is a
 * marker you can see the curve's foot sitting behind, and the second, dimmer
 * line is what the two of them actually do together, which is the only line the
 * image ever sees.
 */

const CHANNELS = ['rgb', 'r', 'g', 'b'] as const;
export type Channel = (typeof CHANNELS)[number];

const CHANNEL_INK: Record<Channel, string> = {
  rgb: '#e8e4dc',
  r: '#ff6b6b',
  g: '#5fd47a',
  b: '#6aa8ff',
};

export type CurveEditorOptions = {
  get: (channel: Channel) => CurvePoint[];
  set: (channel: Channel, points: CurvePoint[], historyKey?: string) => void;
  histogram: () => Uint32Array;
  /** The levels the curve composes with, drawn on the rail and draggable there. */
  levels?: { get: () => Levels; set: (patch: Partial<Levels>, historyKey?: string) => void };
};

/** Height of the levels rail below the plot, in CSS pixels. */
const RAIL = 16;

export function curveEditor(host: SyncHost, o: CurveEditorOptions): HTMLElement {
  const wrap = el('div', 'curve-editor');

  const tabs = el('div', 'segmented');
  let channel: Channel = 'rgb';
  const tabButtons = CHANNELS.map((c) => {
    const b = el('button', 'seg');
    b.type = 'button';
    b.textContent = c === 'rgb' ? 'RGB' : c.toUpperCase();
    b.addEventListener('click', () => {
      channel = c;
      selected = -1;
      paint();
      updateTabs();
    });
    tabs.append(b);
    return { b, c };
  });
  const updateTabs = () => {
    for (const { b, c } of tabButtons) b.classList.toggle('on', c === channel);
  };

  const canvas = el('canvas', 'curve-canvas');
  canvas.tabIndex = 0;

  const actions = el('div', 'btn-row');
  const reset = el('button', 'link-btn');
  reset.type = 'button';
  reset.textContent = 'Reset channel';
  reset.addEventListener('click', () => {
    o.set(channel, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    selected = -1;
    paint();
  });
  const resetAll = el('button', 'link-btn');
  resetAll.type = 'button';
  resetAll.textContent = 'Reset all';
  resetAll.title = 'Straighten every channel and neutralise the levels';
  resetAll.addEventListener('click', () => {
    for (const c of CHANNELS) o.set(c, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'curves:reset-all');
    o.levels?.set(
      { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 },
      'curves:reset-all',
    );
    selected = -1;
    paint();
  });
  actions.append(reset, resetAll);

  const readout = el('p', 'note curve-readout');
  const helpLine = el('p', 'note');
  helpLine.textContent =
    'Click to add, drag to move, alt-click to remove. Arrows nudge the selected '
    + 'point, shift for ten times; Backspace removes it.';
  wrap.append(tabs, canvas, actions, readout, helpLine);

  const dpr = () => Math.min(3, window.devicePixelRatio || 1);

  /**
   * The point being dragged, held as the object rather than its index.
   *
   * `moveCurvePoint` returns a fresh, re-sorted array. An index captured on
   * pointerdown survives that only while the point keeps its place in the
   * order — so dragging one handle across another used to silently transfer
   * the drag to its neighbour, and the two would swap back and forth under the
   * cursor. Matching on x is what keeps hold of the right one.
   */
  let dragX = NaN;
  let selected = -1;
  let hovered = -1;
  /** Which levels handle is being dragged: 'black' | 'white' | 'gamma'. */
  let dragRail: 'black' | 'white' | 'gamma' | null = null;
  /** Cursor position in curve coordinates, for the readout. */
  let cursor: CurvePoint | null = null;

  const plotHeight = (h: number, ratio: number): number => h - RAIL * ratio;

  const fromEvent = (e: PointerEvent): CurvePoint => {
    const rect = canvas.getBoundingClientRect();
    const plot = Math.max(1, rect.height - RAIL);
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / plot)),
    };
  };

  const onRail = (e: PointerEvent): boolean => {
    const rect = canvas.getBoundingClientRect();
    return e.clientY - rect.top > rect.height - RAIL;
  };

  /**
   * Nearest handle within reach, in screen distance rather than curve distance.
   *
   * The plot is square in CSS pixels but the two axes mean different things, so
   * a radius measured in curve units is a radius that changes size as the panel
   * is resized. Ten CSS pixels is ten CSS pixels.
   */
  const hitTest = (p: CurvePoint): number => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height - RAIL);
    const points = o.get(channel);
    let best = -1;
    let bestD = 11 ** 2;
    for (let i = 0; i < points.length; i++) {
      const dx = (points[i].x - p.x) * w;
      const dy = (points[i].y - p.y) * h;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const railHit = (x: number): 'black' | 'white' | 'gamma' | null => {
    if (!o.levels) return null;
    const l = o.levels.get();
    const mid = l.inBlack + (l.inWhite - l.inBlack) * gammaToPosition(l.gamma);
    const candidates: [typeof dragRail, number][] = [
      ['black', l.inBlack],
      ['gamma', mid],
      ['white', l.inWhite],
    ];
    let best: typeof dragRail = null;
    let bestD = 0.04;
    for (const [name, at] of candidates) {
      const d = Math.abs(at - x);
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const p = fromEvent(e);

    if (onRail(e)) {
      dragRail = railHit(p.x);
      if (dragRail) canvas.setPointerCapture(e.pointerId);
      return;
    }

    let i = hitTest(p);
    if (e.altKey || e.button === 2) {
      // Alt-click removes, which is the one gesture that has to be explicit:
      // dragging a handle off the edge is how most editors do it and it makes
      // an accidental removal indistinguishable from a clumsy drag.
      if (i > 0) {
        o.set(channel, removeCurvePoint(o.get(channel), i));
        selected = -1;
      }
      paint();
      return;
    }
    if (i < 0) {
      const next = addCurvePoint(o.get(channel), p);
      o.set(channel, next);
      i = next.findIndex((q) => Math.abs(q.x - p.x) < 1e-6);
    }
    selected = i;
    dragX = o.get(channel)[i]?.x ?? p.x;
    canvas.setPointerCapture(e.pointerId);
    paint();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = fromEvent(e);
    cursor = p;

    if (dragRail && o.levels) {
      const l = o.levels.get();
      if (dragRail === 'black') {
        o.levels.set({ inBlack: Math.min(p.x, l.inWhite - 0.01) }, 'levels:in');
      } else if (dragRail === 'white') {
        o.levels.set({ inWhite: Math.max(p.x, l.inBlack + 0.01) }, 'levels:in');
      } else {
        const span = Math.max(1e-4, l.inWhite - l.inBlack);
        const t = Math.min(0.98, Math.max(0.02, (p.x - l.inBlack) / span));
        o.levels.set({ gamma: positionToGamma(t) }, 'levels:gamma');
      }
      paint();
      return;
    }

    if (Number.isNaN(dragX)) {
      const next = hitTest(p);
      if (next !== hovered) {
        hovered = next;
        paint();
      } else {
        paintReadout();
      }
      return;
    }

    const points = o.get(channel);
    const index = nearestByX(points, dragX);
    const moved = moveCurvePoint(points, index, p);
    o.set(channel, moved, `curves:${channel}:drag`);
    dragX = moved[index]?.x ?? dragX;
    selected = index;
    paint();
  });

  const release = () => {
    dragX = NaN;
    dragRail = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { cursor = null; hovered = -1; paint(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('keydown', (e) => {
    const points = o.get(channel);
    if (selected < 0 || selected >= points.length) return;
    const step = (e.shiftKey ? 10 : 1) / 255;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = step;
    else if (e.key === 'ArrowDown') dy = -step;
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      o.set(channel, removeCurvePoint(points, selected));
      selected = -1;
      paint();
      return;
    } else {
      return;
    }
    e.preventDefault();
    const cur = points[selected];
    const moved = moveCurvePoint(points, selected, { x: cur.x + dx, y: cur.y + dy });
    // One history entry per key, not per burst: a nudge is a decision, and
    // holding an arrow key down should be undoable in the steps it was made.
    o.set(channel, moved, `curves:${channel}:nudge:${Date.now()}`);
    paint();
  });

  function paintReadout(): void {
    const points = o.get(channel);
    const f = monotoneSpline(points);
    const parts: string[] = [];
    if (selected >= 0 && selected < points.length) {
      const p = points[selected];
      parts.push(`point ${selected + 1} of ${points.length}  in ${b255(p.x)} → out ${b255(p.y)}`);
    } else {
      parts.push(`${points.length} point${points.length === 1 ? '' : 's'}`);
    }
    if (cursor) parts.push(`cursor ${b255(cursor.x)} → ${b255(clamp01(f(cursor.x)))}`);
    readout.textContent = parts.join('   ·   ');
  }

  function paint(): void {
    const ratio = dpr();
    const cssW = canvas.clientWidth || 260;
    const w = Math.round(cssW * ratio);
    const h = Math.round((cssW + RAIL) * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // `getContext` returns null often enough to matter: a browser under memory
    // pressure, a canvas with no layout yet, a headless run. The `!` that used
    // to be here turned that into a crash that took the whole sidebar with it,
    // which is a much worse outcome than one control failing to draw.
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const ph = plotHeight(h, ratio);

    // Histogram behind everything, on a square root scale: a linear one is all
    // spike and no shoulder on any real photograph, and the shoulder is the
    // part you are aiming at.
    const hist = o.histogram();
    let peak = 0;
    for (const v of hist) peak = Math.max(peak, v);
    if (peak > 0) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      const bw = w / hist.length;
      for (let i = 0; i < hist.length; i++) {
        const v = Math.sqrt(hist[i] / peak) * ph;
        g.fillRect(i * bw, ph - v, Math.ceil(bw), v);
      }
    }

    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1 * ratio;
    for (let i = 1; i < 4; i++) {
      const x = (i / 4) * w;
      const y = (i / 4) * ph;
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x, ph);
      g.moveTo(0, y); g.lineTo(w, y);
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.beginPath();
    g.moveTo(0, ph); g.lineTo(w, 0);
    g.stroke();

    const points = o.get(channel);
    const f = monotoneSpline(points);

    // What the image actually gets: levels first, then this channel's curve.
    // Drawn dimmer and behind, because it is a readout rather than something
    // you can grab — but it is the honest answer to "what is this doing", and
    // without it a curve that looks gentle can be sitting on a levels clip that
    // has already thrown half the range away.
    if (o.levels) {
      const lv = levelsFn(o.levels.get());
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = 1.2 * ratio;
      g.setLineDash([4 * ratio, 4 * ratio]);
      g.beginPath();
      for (let i = 0; i <= 160; i++) {
        const x = i / 160;
        const y = clamp01(f(lv(x)));
        const px = x * w;
        const py = (1 - y) * ph;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      g.setLineDash([]);
    }

    g.strokeStyle = CHANNEL_INK[channel];
    g.lineWidth = 1.8 * ratio;
    g.beginPath();
    for (let i = 0; i <= 160; i++) {
      const x = i / 160;
      const y = clamp01(f(x));
      const px = x * w;
      const py = (1 - y) * ph;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();

    for (let i = 0; i < points.length; i++) {
      const px = points[i].x * w;
      const py = (1 - points[i].y) * ph;
      const on = i === selected;
      const near = i === hovered;
      g.beginPath();
      g.arc(px, py, (on ? 6 : near ? 5.5 : 4.5) * ratio, 0, Math.PI * 2);
      g.fillStyle = on ? '#ffffff' : CHANNEL_INK[channel];
      g.fill();
      g.strokeStyle = on ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.55)';
      g.lineWidth = (on ? 1.6 : 1) * ratio;
      g.stroke();
    }

    paintRail(g, w, ph, h, ratio);
    paintReadout();
  }

  function paintRail(
    g: CanvasRenderingContext2D,
    w: number,
    ph: number,
    h: number,
    ratio: number,
  ): void {
    if (!o.levels) return;
    const l = o.levels.get();
    const top = ph + 2 * ratio;
    const height = h - top;

    // A black-to-white strip, clipped to the input range, so the rail shows the
    // range being kept rather than only where the two ends sit.
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#000');
    grad.addColorStop(1, '#fff');
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, top, w, height);
    g.fillStyle = grad;
    g.fillRect(l.inBlack * w, top, Math.max(1, (l.inWhite - l.inBlack) * w), height);

    const mid = l.inBlack + (l.inWhite - l.inBlack) * gammaToPosition(l.gamma);
    const marker = (at: number, fill: string, size: number) => {
      const x = at * w;
      const cy = top + height / 2;
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x + size * ratio, cy);
      g.lineTo(x, top + height);
      g.lineTo(x - size * ratio, cy);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1 * ratio;
      g.stroke();
    };
    marker(l.inBlack, '#1b1c1f', 4.5);
    marker(mid, '#9aa0a9', 4);
    marker(l.inWhite, '#f2efe8', 4.5);
  }

  host.onSync(() => { updateTabs(); paint(); });
  // The canvas is laid out by CSS, so its pixel size is only known once it is
  // in the document and has been measured.
  requestAnimationFrame(paint);
  onResize(canvas, paint);
  return wrap;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const b255 = (v: number): string => String(Math.round(clamp01(v) * 255));

/** The point in `points` whose x is closest to `x`, for re-finding a dragged handle. */
function nearestByX(points: CurvePoint[], x: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].x - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Gamma as a position between the black and white points, and back.
 *
 * The marker sits on the *input* that comes out as mid grey, not on where mid
 * grey ends up. Levels maps `t` to `t ** (1 / gamma)`, so the input that lands
 * on 0.5 is `0.5 ** gamma` — and a gamma above 1, which brightens, puts the
 * marker to the left, exactly as dragging the midtone slider left does in every
 * levels dialog. Reading it the other way round puts the handle on the wrong
 * side of centre and makes the drag feel inverted.
 */
export const gammaToPosition = (gamma: number): number =>
  clamp01(0.5 ** Math.max(0.01, gamma));

export const positionToGamma = (t: number): number => {
  const p = Math.min(0.999, Math.max(0.001, t));
  return Math.min(10, Math.max(0.1, Math.log(p) / Math.log(0.5)));
};

// -- threshold strip ---------------------------------------------------------

export type ThresholdStripOptions = {
  /** The thresholds in use, whether chosen by hand or computed. */
  get: () => number[];
  /** Called on drag, which is also what switches spacing to manual. */
  set: (thresholds: number[]) => void;
  histogram: () => Uint32Array;
  /** Band colours, so the strip reads as the drawing rather than as a graph. */
  colours: () => string[];
  enabled: () => boolean;
};

/**
 * The tone axis with the cuts marked on it.
 *
 * This is the one control that shows the posterisation as a decision rather
 * than a number: the bands are drawn in their own colours, so a stack that is
 * spending three levels on a sky is visible at a glance instead of being
 * something you deduce from the canvas.
 */
export function thresholdStrip(host: SyncHost, o: ThresholdStripOptions): HTMLElement {
  const wrap = el('div', 'threshold-strip');
  const canvas = el('canvas', 'strip-canvas');
  const note = el('p', 'note');
  wrap.append(canvas, note);

  let drag = -1;
  const dpr = () => Math.min(3, window.devicePixelRatio || 1);

  const xOf = (e: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!o.enabled()) return;
    const x = xOf(e);
    const ts = o.get();
    let best = -1;
    let bestD = 0.05;
    for (let i = 0; i < ts.length; i++) {
      const d = Math.abs(ts[i] - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    drag = best;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const ts = [...o.get()];
    // Neighbours pen each handle in, so a band can be made thin but never
    // inverted — an out-of-order threshold list has no meaning downstream.
    const lo = drag === 0 ? 0.002 : ts[drag - 1] + 0.004;
    const hi = drag === ts.length - 1 ? 0.998 : ts[drag + 1] - 0.004;
    ts[drag] = Math.min(hi, Math.max(lo, xOf(e)));
    o.set(ts);
    paint();
  });

  const release = () => { drag = -1; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  function paint(): void {
    const ratio = dpr();
    const cssW = canvas.clientWidth || 260;
    const w = Math.round(cssW * ratio);
    const h = Math.round(64 * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);

    const ts = o.get();
    const colours = o.colours();
    const edges = [0, ...ts, 1];
    for (let i = 0; i < edges.length - 1; i++) {
      g.fillStyle = colours[i] ?? '#888';
      g.fillRect(edges[i] * w, 0, (edges[i + 1] - edges[i]) * w, h);
    }

    const hist = o.histogram();
    let peak = 0;
    for (const v of hist) peak = Math.max(peak, v);
    if (peak > 0) {
      g.fillStyle = 'rgba(0,0,0,0.30)';
      const bw = w / hist.length;
      for (let i = 0; i < hist.length; i++) {
        const v = Math.sqrt(hist[i] / peak) * h;
        g.fillRect(i * bw, h - v, Math.ceil(bw), v);
      }
    }

    const on = o.enabled();
    for (const t of ts) {
      g.strokeStyle = on ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
      g.lineWidth = 1.5 * ratio;
      g.beginPath();
      g.moveTo(t * w, 0);
      g.lineTo(t * w, h);
      g.stroke();
      if (on) {
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(t * w, h - 5 * ratio, 3.5 * ratio, 0, Math.PI * 2);
        g.fill();
      }
    }

    note.textContent = on
      ? 'Drag a divider to move a threshold'
      : 'Thresholds are set by the spacing rule';
  }

  host.onSync(paint);
  requestAnimationFrame(paint);
  onResize(canvas, paint);
  return wrap;
}
