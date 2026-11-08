import { hexToRgb, rgbToHex } from '../core/color';
import type { Canvas, RGB } from '../core/types';
import { formatLength, lengthFrom } from '../core/scale';

/**
 * The control vocabulary.
 *
 * Every widget reads its value through a getter rather than being handed one,
 * and registers a sync function that re-reads it. That indirection is what lets
 * the whole sidebar refresh on every document change without rebuilding any of
 * it — which matters because rebuilding a slider while it is being dragged
 * drops the pointer capture, and the controls worth dragging are exactly the
 * ones worth getting right.
 */

export type SyncHost = { onSync(fn: () => void): void };

export class Panel implements SyncHost {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private syncers: (() => void)[] = [];

  constructor(title: string, opts: { collapsed?: boolean; id?: string; info?: string } = {}) {
    this.el = el('section', 'panel');
    if (opts.id) this.el.id = opts.id;
    const row = el('div', 'panel-head-row');
    const head = el('button', 'panel-head');
    head.type = 'button';
    head.innerHTML = `<span class="chev"></span><span>${escapeHtml(title)}</span>`;
    this.body = el('div', 'panel-body');
    head.addEventListener('click', () => {
      this.el.classList.toggle('collapsed');
    });
    if (opts.collapsed) this.el.classList.add('collapsed');
    row.append(head);
    this.el.append(row, this.body);

    // The explanations are behind an (i), as in Stipple: always there for
    // whoever wants them, never in the way of whoever does not, and reachable
    // on a phone, which has no tooltips. The button only appears on a panel
    // that has something to explain, which is known once the panel is filled.
    if (opts.info) {
      const p = el('p', 'help panel-info');
      p.textContent = opts.info;
      this.body.append(p);
    }
    queueMicrotask(() => {
      if (!this.body.querySelector('.help')) return;
      const info = el('button', 'info-btn');
      info.type = 'button';
      info.textContent = 'i';
      info.title = `What is ${title}?`;
      info.setAttribute('aria-expanded', 'false');
      info.addEventListener('click', () => {
        const on = this.el.classList.toggle('explain');
        info.classList.toggle('on', on);
        info.setAttribute('aria-expanded', String(on));
        if (on) this.el.classList.remove('collapsed');
      });
      row.append(info);
    });
  }

  onSync(fn: () => void): void {
    this.syncers.push(fn);
    fn();
  }

  add(...nodes: (HTMLElement | null)[]): void {
    for (const n of nodes) if (n) this.body.append(n);
  }

  sync(): void {
    for (const fn of this.syncers) fn();
  }

  /** A caption under a control, for the units a fraction resolves to. */
  note(text: string): HTMLElement {
    const n = el('p', 'note');
    n.textContent = text;
    this.body.append(n);
    return n;
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Repaint when an element is resized, where the host can tell us.
 *
 * `ResizeObserver` is missing from older web views and from every headless
 * environment, and a bare `new ResizeObserver(...)` in a control's constructor
 * takes the whole panel down with it when it is not there. The canvases all
 * repaint on every document sync anyway, so losing this costs a redraw on
 * resize rather than a working sidebar.
 */
export function onResize(target: Element, fn: () => void): void {
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (!RO) return;
  new RO(fn).observe(target);
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// -- slider ------------------------------------------------------------------

export type SliderOptions = {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  /** Printed after the number. */
  unit?: string;
  /** Overrides the default formatting entirely. */
  format?: (v: number) => string;
  /** Extra line under the control — what the value means in real units. */
  hint?: () => string;
  disabled?: () => boolean;
  /** Reads the text box, for values shown in another unit than they are stored in. */
  parse?: (text: string) => number | null;
};

export function slider(host: SyncHost, o: SliderOptions): HTMLElement {
  const wrap = el('div', 'ctrl slider');
  const head = el('div', 'ctrl-head');
  const name = el('label', 'ctrl-label');
  name.textContent = o.label;
  const value = el('input', 'ctrl-value');
  value.type = 'text';
  value.spellcheck = false;
  head.append(name, value);

  const input = el('input', 'range');
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);

  const hint = o.hint ? el('p', 'note') : null;
  wrap.append(head, input);
  if (hint) wrap.append(hint);

  const fmt = (v: number): string =>
    o.format ? o.format(v) : `${trim(v)}${o.unit ?? ''}`;

  // `dragging` suppresses the sync that would otherwise write the value back
  // into the input mid-drag and drop the pointer. It has to be cleared even
  // when the release lands somewhere else — a pointerup listener on the input
  // alone leaves the flag latched if the cursor left the track first, and the
  // slider then silently stops following the document for the rest of the
  // session.
  let dragging = false;
  input.addEventListener('pointerdown', () => { dragging = true; });
  const endDrag = () => { dragging = false; };
  input.addEventListener('blur', endDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.value = fmt(v);
    paintFill(input);
    o.set(v);
  });

  // The text box is a way in for a value the slider's range cannot reach —
  // a blur of 40 on a huge image, say — so it is not clamped to min and max.
  const commit = () => {
    const parsed = o.parse
      ? o.parse(value.value)
      : Number.parseFloat(value.value.replace(/[^\d.eE+-]/g, ''));
    if (parsed !== null && Number.isFinite(parsed)) o.set(parsed);
    sync();
  };
  value.addEventListener('change', commit);
  value.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); value.blur(); }
  });

  const sync = () => {
    const v = o.get();
    if (!dragging) input.value = String(v);
    paintFill(input);
    if (document.activeElement !== value) value.value = fmt(v);
    const off = o.disabled?.() ?? false;
    wrap.classList.toggle('disabled', off);
    input.disabled = off;
    value.disabled = off;
    if (hint && o.hint) hint.textContent = o.hint();
  };
  host.onSync(sync);
  return wrap;
}

/** Paints the filled portion of a range track up to its current value. */
function paintFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const t = (Number(input.value) - min) / (max - min || 1);
  input.style.setProperty('--fill', `${Math.min(1, Math.max(0, t)) * 100}%`);
}

/**
 * A slider over a length stored as a fraction of the picture, shown and typed
 * in the document's unit. The track runs over fractions, so its range means the
 * same share of the picture at any document size.
 */
export function lengthSlider(
  host: SyncHost,
  o: Omit<SliderOptions, 'step' | 'unit' | 'format' | 'parse'> & { canvas: () => Canvas },
): HTMLElement {
  return slider(host, {
    ...o,
    step: (o.max - o.min) / 2000,
    format: (v) => formatLength(v, o.canvas()),
    parse: (text) => {
      const n = Number.parseFloat(text.replace(/[^\d.eE+-]/g, ''));
      return Number.isFinite(n) ? lengthFrom(n, o.canvas()) : null;
    },
  });
}

const trim = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
};

// -- toggle ------------------------------------------------------------------

export function toggle(
  host: SyncHost,
  o: { label: string; get: () => boolean; set: (v: boolean) => void; hint?: string },
): HTMLElement {
  const wrap = el('label', 'ctrl check');
  const input = el('input');
  input.type = 'checkbox';
  const text = el('span');
  text.textContent = o.label;
  wrap.append(input, text);
  input.addEventListener('change', () => o.set(input.checked));
  if (o.hint) wrap.title = o.hint;
  host.onSync(() => { input.checked = o.get(); });
  return wrap;
}

// -- select ------------------------------------------------------------------

export function select<T extends string>(
  host: SyncHost,
  o: {
    label: string;
    options: { value: T; label: string }[];
    get: () => T;
    set: (v: T) => void;
  },
): HTMLElement {
  const wrap = el('div', 'ctrl');
  const head = el('div', 'ctrl-head');
  const name = el('label', 'ctrl-label');
  name.textContent = o.label;
  head.append(name);
  const sel = el('select', 'select');
  for (const opt of o.options) {
    const node = el('option');
    node.value = opt.value;
    node.textContent = opt.label;
    sel.append(node);
  }
  sel.addEventListener('change', () => o.set(sel.value as T));
  wrap.append(head, sel);
  host.onSync(() => { sel.value = o.get(); });
  return wrap;
}

/** A row of mutually exclusive buttons, for two or three short choices. */
export function segmented<T extends string>(
  host: SyncHost,
  o: {
    label?: string;
    options: { value: T; label: string; title?: string }[];
    get: () => T;
    set: (v: T) => void;
  },
): HTMLElement {
  const wrap = el('div', 'ctrl');
  if (o.label) {
    const head = el('div', 'ctrl-head');
    const name = el('label', 'ctrl-label');
    name.textContent = o.label;
    head.append(name);
    wrap.append(head);
  }
  const group = el('div', 'segmented');
  const buttons = o.options.map((opt) => {
    const b = el('button', 'seg');
    b.type = 'button';
    b.textContent = opt.label;
    if (opt.title) b.title = opt.title;
    b.addEventListener('click', () => o.set(opt.value));
    group.append(b);
    return { b, value: opt.value };
  });
  wrap.append(group);
  host.onSync(() => {
    const v = o.get();
    for (const { b, value } of buttons) b.classList.toggle('on', value === v);
  });
  return wrap;
}

// -- colour ------------------------------------------------------------------

export function colourField(
  host: SyncHost,
  o: {
    label: string;
    get: () => RGB;
    set: (v: RGB) => void;
    /** Null means "no paper", which is not the same as white. */
    nullable?: { get: () => boolean; set: (v: boolean) => void; label: string };
  },
): HTMLElement {
  const wrap = el('div', 'ctrl');
  const head = el('div', 'ctrl-head');
  const name = el('label', 'ctrl-label');
  name.textContent = o.label;
  head.append(name);

  const row = el('div', 'colour-row');
  const swatch = el('input', 'swatch');
  swatch.type = 'color';
  const hex = el('input', 'ctrl-value hex');
  hex.type = 'text';
  hex.spellcheck = false;
  row.append(swatch, hex);
  wrap.append(head, row);

  swatch.addEventListener('input', () => o.set(hexToRgb(swatch.value)));
  const commit = () => {
    if (/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex.value.trim())) o.set(hexToRgb(hex.value));
    sync();
  };
  hex.addEventListener('change', commit);
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); hex.blur(); } });

  let none: HTMLElement | null = null;
  if (o.nullable) {
    none = toggle(host, {
      label: o.nullable.label,
      get: o.nullable.get,
      set: o.nullable.set,
    });
    wrap.append(none);
  }

  const sync = () => {
    const c = rgbToHex(o.get());
    swatch.value = c;
    if (document.activeElement !== hex) hex.value = c;
    const off = o.nullable ? o.nullable.get() : false;
    row.classList.toggle('disabled', off);
    swatch.disabled = off;
    hex.disabled = off;
  };
  host.onSync(sync);
  return wrap;
}

// -- misc --------------------------------------------------------------------

export function button(
  label: string,
  onClick: () => void,
  opts: { className?: string; title?: string } = {},
): HTMLButtonElement {
  const b = el('button', `btn ${opts.className ?? ''}`.trim());
  b.type = 'button';
  b.textContent = label;
  if (opts.title) b.title = opts.title;
  b.addEventListener('click', onClick);
  return b;
}

export function buttonRow(...nodes: HTMLElement[]): HTMLElement {
  const row = el('div', 'btn-row');
  row.append(...nodes);
  return row;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('div', 'ctrl');
  const head = el('div', 'ctrl-head');
  const name = el('label', 'ctrl-label');
  name.textContent = label;
  head.append(name);
  wrap.append(head, control);
  return wrap;
}

export function numberInput(
  host: SyncHost,
  o: { get: () => number; set: (v: number) => void; min?: number; max?: number; step?: number },
): HTMLInputElement {
  const input = el('input', 'ctrl-value wide');
  input.type = 'number';
  if (o.min !== undefined) input.min = String(o.min);
  if (o.max !== undefined) input.max = String(o.max);
  input.step = String(o.step ?? 1);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) o.set(v);
  });
  host.onSync(() => {
    if (document.activeElement !== input) input.value = String(o.get());
  });
  return input;
}

/** An inline explanation, for the one or two places a control needs a sentence. */
export function help(text: string): HTMLElement {
  const p = el('p', 'help');
  p.textContent = text;
  return p;
}

/**
 * Sliders under a finger, for touch screens — Stipple's, unchanged in intent.
 *
 * A native range input takes a touch on its track as "jump here", so on a phone,
 * where the sidebar is wall-to-wall sliders, every attempt to scroll the panel
 * lands on one and silently changes a setting on the way. Under a coarse pointer
 * the stylesheet makes range inputs pointer-transparent and this takes over: a
 * gesture that goes vertical first is left to the browser and scrolls, and one
 * that goes sideways first drags the slider relative to where it was, a full
 * track width for the full range. A tap does nothing, as on iOS. The slider
 * never knows: it receives the same events a mouse drag would produce.
 */
export function installTouchSliders(root: HTMLElement): void {
  // Missing in headless hosts; without it there is no touch screen to handle.
  if (typeof window.matchMedia !== 'function') return;
  const coarse = window.matchMedia('(pointer: coarse)');
  const SLOP = 8;

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !coarse.matches) return;
    const row = (e.target as HTMLElement).closest('.ctrl.slider');
    const input = row?.querySelector<HTMLInputElement>('input[type=range]');
    if (!input || input.disabled) return;
    const track = input.getBoundingClientRect();
    // The label and the number field keep their own behaviour.
    if (e.clientX < track.left - SLOP || e.clientX > track.right + SLOP) return;

    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    let start = 0;
    const min = Number.parseFloat(input.min) || 0;
    const max = Number.parseFloat(input.max) || 100;
    const step = Number.parseFloat(input.step) || 0;

    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - x0;
      if (!dragging) {
        if (Math.abs(ev.clientY - y0) > SLOP) return finish();
        if (Math.abs(dx) <= SLOP) return;
        dragging = true;
        start = Number.parseFloat(input.value);
        input.dispatchEvent(new PointerEvent('pointerdown'));
      }
      let v = start + (dx / Math.max(1, track.width)) * (max - min);
      if (step > 0) v = min + Math.round((v - min) / step) * step;
      v = Math.min(max, Math.max(min, v));
      if (String(v) !== input.value) {
        input.value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    const finish = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      dragging = false;
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === id) finish();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
