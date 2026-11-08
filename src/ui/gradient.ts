import { cssRgb, hexToRgb, mixLab, rgbToHex } from '../core/color';
import type { GradientStop, RGB } from '../core/types';
import { el, type SyncHost } from './controls';

/**
 * The gradient ramp editor.
 *
 * A gradient with two colours and a midpoint is a control, not a tool: there
 * are exactly two decisions in it, and the illustration style this app exists
 * to serve — flat vector figures shaded with per-shape ramps — routinely wants
 * four stops, because a form turning away from a light does not darken in a
 * straight line. So the ramp is edited the way every drawing program edits one:
 * a bar you click to add a stop, drag to move it, and alt-click to remove it.
 *
 * The bar draws the ramp with the same stops the exporter will use, so what is
 * under the cursor is what lands in the file.
 */

export type GradientBarOptions = {
  get: () => GradientStop[];
  set: (stops: GradientStop[], historyKey?: string) => void;
  /** Called when the selection changes, so a panel can re-sync its fields. */
  onSelect?: (index: number) => void;
};

export type GradientBar = {
  el: HTMLElement;
  /** The stop the colour field and offset box are editing. */
  selected: () => number;
  select: (index: number) => void;
};

/** Ascending, de-duplicated, and never fewer than two. */
export function tidyStops(stops: GradientStop[]): GradientStop[] {
  const out = [...stops]
    .map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), rgb: s.rgb }))
    .sort((a, b) => a.offset - b.offset);
  if (out.length < 2) {
    const c = out[0]?.rgb ?? ([0, 0, 0] as RGB);
    return [{ offset: 0, rgb: c }, { offset: 1, rgb: c }];
  }
  return out;
}

/** The colour the ramp already has at `offset`, for a stop added by clicking. */
export function colourAtOffset(stops: GradientStop[], offset: number): RGB {
  const s = tidyStops(stops);
  if (offset <= s[0].offset) return s[0].rgb;
  if (offset >= s[s.length - 1].offset) return s[s.length - 1].rgb;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (offset >= a.offset && offset <= b.offset) {
      const span = b.offset - a.offset;
      // Lab, to match what the eye reads between the two neighbours. The
      // exported gradient interpolates in sRGB because that is what SVG and PDF
      // both do, so this is a guess at a pleasing colour, not a claim about the
      // ramp — which is why the new stop is a real stop the user can move.
      return span < 1e-6 ? a.rgb : mixLab(a.rgb, b.rgb, (offset - a.offset) / span);
    }
  }
  return s[s.length - 1].rgb;
}

export function gradientBar(host: SyncHost, o: GradientBarOptions): GradientBar {
  const wrap = el('div', 'gradient-editor');

  const bar = el('div', 'grad-bar');
  const ramp = el('div', 'grad-ramp');
  const handles = el('div', 'grad-handles');
  bar.append(ramp, handles);

  const row = el('div', 'grad-row');
  const swatch = el('input', 'swatch');
  swatch.type = 'color';
  const hex = el('input', 'ctrl-value hex');
  hex.type = 'text';
  hex.spellcheck = false;
  const pos = el('input', 'ctrl-value pos');
  pos.type = 'text';
  pos.spellcheck = false;
  pos.title = 'Where this stop sits on the ramp, 0 to 1';
  const remove = el('button', 'btn small');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.title = 'Remove the selected stop (alt-click a handle does the same)';
  row.append(swatch, hex, pos, remove);

  const note = el('p', 'note');
  wrap.append(bar, row, note);

  let selected = 0;
  let dragging = -1;

  const commitSelection = (index: number) => {
    selected = index;
    o.onSelect?.(index);
    paint();
  };

  const offsetFromEvent = (e: PointerEvent | MouseEvent): number => {
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
  };

  // A stop is identified while dragging by the object it is, not by where it
  // sits in the list: moving one past its neighbour re-sorts the array, and an
  // index captured on pointerdown would silently start dragging the other one.
  let draggingStop: GradientStop | null = null;

  bar.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const stops = tidyStops(o.get());
    const x = offsetFromEvent(e);

    let hit = -1;
    let best = 0.035;
    for (let i = 0; i < stops.length; i++) {
      const d = Math.abs(stops[i].offset - x);
      if (d < best) { best = d; hit = i; }
    }

    if (hit >= 0 && (e.altKey || e.button === 2)) {
      if (stops.length > 2) {
        const next = stops.filter((_, i) => i !== hit);
        o.set(next);
        commitSelection(Math.min(hit, next.length - 1));
      }
      return;
    }

    if (hit < 0) {
      const added: GradientStop = { offset: x, rgb: colourAtOffset(stops, x) };
      const next = tidyStops([...stops, added]);
      o.set(next);
      hit = next.indexOf(added);
      draggingStop = added;
    } else {
      draggingStop = stops[hit];
    }
    dragging = hit;
    // Not every host implements pointer capture, and losing it is not a reason
    // to lose the click that came with it.
    bar.setPointerCapture?.(e.pointerId);
    commitSelection(hit);
  });

  bar.addEventListener('pointermove', (e) => {
    if (dragging < 0 || !draggingStop) return;
    const stops = tidyStops(o.get());
    const i = stops.findIndex((s) => s === draggingStop);
    const target = i >= 0 ? i : Math.min(dragging, stops.length - 1);
    const moved = stops.map((s, j) =>
      (j === target ? { offset: offsetFromEvent(e), rgb: s.rgb } : s));
    const next = tidyStops(moved);
    o.set(next, 'grad:stop-move');
    dragging = next.indexOf(moved[target]);
    draggingStop = moved[target];
    commitSelection(dragging);
  });

  const release = () => { dragging = -1; draggingStop = null; };
  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', release);
  bar.addEventListener('contextmenu', (e) => e.preventDefault());

  const patchSelected = (patch: Partial<GradientStop>, key?: string) => {
    const stops = tidyStops(o.get());
    if (selected < 0 || selected >= stops.length) return;
    const next = tidyStops(stops.map((s, i) => (i === selected ? { ...s, ...patch } : s)));
    o.set(next, key);
  };

  swatch.addEventListener('input', () => patchSelected({ rgb: hexToRgb(swatch.value) }, 'grad:colour'));
  const commitHex = () => {
    if (/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex.value.trim())) {
      patchSelected({ rgb: hexToRgb(hex.value) });
    }
    paint();
  };
  hex.addEventListener('change', commitHex);
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitHex(); hex.blur(); } });

  const commitPos = () => {
    const v = Number.parseFloat(pos.value);
    if (Number.isFinite(v)) {
      const stops = tidyStops(o.get());
      const moved = stops.map((s, i) => (i === selected ? { ...s, offset: v } : s));
      const next = tidyStops(moved);
      o.set(next);
      selected = next.indexOf(moved[selected] ?? next[selected]);
      if (selected < 0) selected = 0;
    }
    paint();
  };
  pos.addEventListener('change', commitPos);
  pos.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitPos(); pos.blur(); } });

  remove.addEventListener('click', () => {
    const stops = tidyStops(o.get());
    if (stops.length <= 2) return;
    const next = stops.filter((_, i) => i !== selected);
    o.set(next);
    commitSelection(Math.min(selected, next.length - 1));
  });

  function paint(): void {
    const stops = tidyStops(o.get());
    if (selected >= stops.length) selected = stops.length - 1;
    if (selected < 0) selected = 0;

    ramp.style.background = `linear-gradient(to right, ${
      stops.map((s) => `${cssRgb(s.rgb)} ${(s.offset * 100).toFixed(2)}%`).join(', ')
    })`;

    handles.replaceChildren();
    stops.forEach((s, i) => {
      const h = el('span', 'grad-handle');
      if (i === selected) h.classList.add('on');
      h.style.left = `${s.offset * 100}%`;
      h.style.background = cssRgb(s.rgb);
      h.title = `${rgbToHex(s.rgb)} at ${s.offset.toFixed(3)}`;
      handles.append(h);
    });

    const cur = stops[selected];
    if (cur) {
      const c = rgbToHex(cur.rgb);
      swatch.value = c;
      if (document.activeElement !== hex) hex.value = c;
      if (document.activeElement !== pos) pos.value = cur.offset.toFixed(3);
    }
    remove.disabled = stops.length <= 2;
    note.textContent =
      `${stops.length} stops · click the bar to add, drag to move, alt-click to remove`;
  }

  host.onSync(paint);
  return { el: wrap, selected: () => selected, select: commitSelection };
}
