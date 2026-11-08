import { el } from './controls';

/**
 * Interface colours: the chrome recoloured from three choices — the fill of
 * the panels, the lines between things, and the text — picked the way Apple's
 * colour panel does it: a grid of little squares to start from, then a field
 * for saturation and brightness, a hue strip, and a Vivid slider that reaches
 * past ordinary screen colour into Display P3 on screens that have it.
 *
 * Every other token is derived from those three with `color-mix`, so the value
 * steps between stage, header, panel, button and field survive any choice:
 * pick a pink fill and the stage is a darker pink, the fields a lighter one.
 * Yellow stays the one accent. The choice is this viewer's, kept in local
 * storage, and never part of a document.
 */

type Target = 'fill' | 'lines' | 'text';
export type Pick = { h: number; s: number; v: number; vivid: number };
type Choices = Partial<Record<Target, Pick>>;

const KEY = 'contour.gui-colours';
const TARGETS: { value: Target; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'lines', label: 'Lines' },
  { value: 'text', label: 'Text' },
];

/** The workshop green, as HSV, so the picker opens on what is showing. */
const DEFAULTS: Record<Target, Pick> = {
  fill: { h: 135, s: 0.114, v: 0.722, vivid: 0 }, // #a3b8a8
  lines: { h: 138, s: 0.207, v: 0.455, vivid: 0 }, // #5d7464
  text: { h: 135, s: 0.423, v: 0.102, vivid: 0 }, // #0f1a12
};

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

const hex = (rgb: number[]): string =>
  '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');

function hexToHsv(text: string): Pick | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max, vivid: 0 };
}

/**
 * A pick as CSS. Vivid reads the same numbers as Display P3 instead of sRGB,
 * which is the same colour pushed out to P3's wider primaries; in between is a
 * mix of the two. A screen without P3 shows the nearest colour it has.
 */
export function css(p: Pick): string {
  const [r, g, b] = hsvToRgb(p.h, p.s, p.v);
  const srgb = hex([r, g, b]);
  if (p.vivid <= 0) return srgb;
  const p3 = `color(display-p3 ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)})`;
  return `color-mix(in display-p3, ${srgb}, ${p3} ${Math.round(p.vivid * 100)}%)`;
}

const luma = (p: Pick): number => {
  const [r, g, b] = hsvToRgb(p.h, p.s, p.v);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function load(): Choices {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as Choices : {};
  } catch {
    return {};
  }
}

function save(c: Choices): void {
  try {
    if (Object.keys(c).length) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch { /* a private window: the colours last as long as the page */ }
}

const TOKENS = [
  '--stage', '--panel', '--panel-2', '--panel-3', '--field', '--hover',
  '--line', '--line-soft', '--track', '--text', '--text-dim', '--text-faint',
];

/** Write the tokens for a set of choices; an empty set puts the green back. */
export function applyGuiColours(c: Choices): void {
  const root = document.documentElement.style;
  for (const t of TOKENS) root.removeProperty(t);
  const set = (k: string, v: string) => root.setProperty(k, v);

  if (c.fill) {
    const f = css(c.fill);
    set('--panel', f);
    set('--stage', `color-mix(in oklab, ${f}, #000 46%)`);
    set('--panel-2', `color-mix(in oklab, ${f}, #000 9%)`);
    set('--panel-3', `color-mix(in oklab, ${f}, #fff 16%)`);
    set('--field', `color-mix(in oklab, ${f}, #fff 32%)`);
    set('--hover', `color-mix(in oklab, ${f}, #fff 24%)`);
  }
  // Text left alone on a fill dark enough to lose it turns light by itself;
  // a text colour someone chose is theirs, legible or not.
  const text = c.text ? css(c.text) : c.fill && luma(c.fill) < 0.42 ? '#f2f2ee' : null;
  if (text) {
    set('--text', text);
    set('--text-dim', `color-mix(in oklab, ${text}, var(--panel) 16%)`);
    set('--text-faint', `color-mix(in oklab, ${text}, var(--panel) 36%)`);
  }
  // Lines left alone follow the fill, a darker shade of it, so a new fill
  // does not come with green rules drawn on it.
  const lines = c.lines ? css(c.lines) : c.fill ? `color-mix(in oklab, ${css(c.fill)}, #000 42%)` : null;
  if (lines) {
    const l = lines;
    set('--line', l);
    set('--line-soft', `color-mix(in oklab, ${l}, var(--panel) 42%)`);
    set('--track', `color-mix(in oklab, ${l}, var(--panel) 42%)`);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', c.fill ? hex(hsvToRgb(c.fill.h, c.fill.s, c.fill.v * 0.91)) : '#91a897');
}

/** Put the saved colours on before the first paint. */
export function restoreGuiColours(): void {
  applyGuiColours(load());
  applyGround(loadGround());
}

/**
 * What a sheet with no paper shows behind the drawing: the marbled check, or
 * the plain one every other program uses. A viewing preference, like the
 * colours, and never part of a document.
 */
export type Ground = 'marbled' | 'check';
const GROUND_KEY = 'contour.ground';

function loadGround(): Ground {
  try {
    return localStorage.getItem(GROUND_KEY) === 'check' ? 'check' : 'marbled';
  } catch {
    return 'marbled';
  }
}

function applyGround(g: Ground): void {
  document.documentElement.dataset.ground = g;
  try {
    if (g === 'marbled') localStorage.removeItem(GROUND_KEY);
    else localStorage.setItem(GROUND_KEY, g);
  } catch { /* lasts as long as the page */ }
}

/** The little squares: hue across, light to dark down, a grey row at the top. */
function gridColours(): Pick[][] {
  const hues = [0, 25, 45, 60, 90, 135, 165, 190, 215, 245, 275, 310];
  const rows: Pick[][] = [];
  rows.push(hues.map((_, i) => ({ h: 0, s: 0, v: 1 - i / (hues.length - 1), vivid: 0 })));
  const shades: [number, number][] = [
    [0.12, 0.96], [0.25, 0.92], [0.45, 0.88], [0.7, 0.85], [0.95, 0.9],
    [0.85, 0.68], [0.75, 0.5], [0.65, 0.34], [0.3, 0.6], [0.2, 0.4],
  ];
  for (const [s, v] of shades) rows.push(hues.map((h) => ({ h, s, v, vivid: 0 })));
  return rows;
}

/**
 * A 2D slider: press and drag anywhere in it. The press is kept from starting a
 * text selection, which otherwise highlights the page as the pointer leaves.
 */
function drag2d(area: HTMLElement, move: (e: PointerEvent) => void): void {
  let dragging: number | null = null;
  area.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    move(e);
    dragging = e.pointerId;
    try { area.setPointerCapture(e.pointerId); } catch { /* the move still follows while over the area */ }
  });
  area.addEventListener('pointermove', (e) => { if (dragging === e.pointerId) move(e); });
  const end = (e: PointerEvent) => { if (dragging === e.pointerId) dragging = null; };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  area.addEventListener('lostpointercapture', end);
}

/** The popover, opened from the mark in the toolbar. */
export function guiColourButton(trigger: HTMLElement): void {
  let choices = load();
  let target: Target = 'fill';
  const current = (): Pick => choices[target] ?? DEFAULTS[target];

  const pop = el('div', 'gui-colours');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Interface colours');

  const head = el('div', 'gui-head');
  const title = el('span', 'gui-title');
  title.textContent = 'Interface colours';
  const reset = el('button', 'btn');
  reset.type = 'button';
  reset.textContent = 'Reset';
  reset.title = 'Back to workshop green';
  head.append(title, reset);

  const tabs = el('div', 'segmented gui-tabs');
  const tabButtons = TARGETS.map((t) => {
    const b = el('button', 'seg');
    b.type = 'button';
    const chip = el('span', 'gui-tab-chip');
    b.append(chip, document.createTextNode(t.label));
    b.addEventListener('click', () => { target = t.value; sync(); });
    tabs.append(b);
    return { b, chip, t };
  });

  const grid = el('div', 'gui-grid');
  for (const row of gridColours()) {
    for (const p of row) {
      const sq = el('button', 'gui-square');
      sq.type = 'button';
      sq.style.background = css(p);
      sq.title = hex(hsvToRgb(p.h, p.s, p.v));
      sq.addEventListener('click', () => commit({ ...p, vivid: current().vivid }));
      grid.append(sq);
    }
  }

  // The fluid swatch: every hue across, white at the top through the pure
  // colour at the middle to black at the bottom — Apple's Spectrum, one 2D
  // slider for the whole range. The field below then refines the pick.
  const spectrum = el('div', 'gui-spectrum');
  const specKnob = el('span', 'gui-knob');
  spectrum.append(specKnob);
  const dragSpectrum = (e: PointerEvent) => {
    const r = spectrum.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const h = Math.min(359.9, x * 360);
    commit(y < 0.5
      ? { h, s: y * 2, v: 1, vivid: current().vivid }
      : { h, s: 1, v: 2 - y * 2, vivid: current().vivid });
  };
  drag2d(spectrum, dragSpectrum);

  const views = el('div', 'segmented gui-views');
  let view: 'squares' | 'spectrum' = 'squares';
  try { if (localStorage.getItem('contour.gui-view') === 'spectrum') view = 'spectrum'; } catch { /* default */ }
  const viewButtons = (['squares', 'spectrum'] as const).map((v) => {
    const b = el('button', 'seg');
    b.type = 'button';
    b.textContent = v === 'squares' ? 'Squares' : 'Spectrum';
    b.addEventListener('click', () => {
      view = v;
      try { localStorage.setItem('contour.gui-view', v); } catch { /* lasts as long as the page */ }
      sync();
    });
    views.append(b);
    return { b, v };
  });

  // Saturation across, brightness up, at the current hue.
  const field = el('div', 'gui-field');
  const knob = el('span', 'gui-knob');
  field.append(knob);
  const dragField = (e: PointerEvent) => {
    const r = field.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    commit({ ...current(), s, v });
  };
  drag2d(field, dragField);

  const range = (cls: string, label: string, max: number, step: number) => {
    const row = el('label', 'gui-range');
    const name = el('span', 'gui-range-label');
    name.textContent = label;
    const input = el('input', cls);
    input.type = 'range';
    input.min = '0';
    input.max = String(max);
    input.step = String(step);
    row.append(name, input);
    return { row, input };
  };
  const hue = range('gui-hue', 'Hue', 360, 1);
  hue.input.addEventListener('input', () => commit({ ...current(), h: Number(hue.input.value) }));
  const bright = range('range gui-bright', 'Brightness', 1, 0.01);
  bright.input.addEventListener('input', () => commit({ ...current(), v: Number(bright.input.value) }));
  const vivid = range('range gui-vivid', 'Vivid (P3)', 1, 0.01);
  vivid.input.title = 'Past ordinary screen colour, on displays that can show it';
  vivid.input.addEventListener('input', () => commit({ ...current(), vivid: Number(vivid.input.value) }));

  const hexRow = el('div', 'gui-hex-row');
  const swatch = el('span', 'gui-swatch');
  const hexIn = el('input', 'ctrl-value hex');
  hexIn.type = 'text';
  hexIn.spellcheck = false;
  hexIn.addEventListener('change', () => {
    const p = hexToHsv(hexIn.value);
    if (p) commit({ ...p, vivid: current().vivid });
    else sync();
  });
  const resetOne = el('button', 'btn');
  resetOne.type = 'button';
  resetOne.textContent = 'Reset this';
  resetOne.addEventListener('click', () => {
    const next = { ...choices };
    delete next[target];
    choices = next;
    save(choices);
    applyGuiColours(choices);
    sync();
  });
  hexRow.append(swatch, hexIn, resetOne);

  const groundRow = el('div', 'gui-ground');
  const groundLabel = el('span', 'gui-range-label');
  groundLabel.textContent = 'Clear paper';
  const groundSeg = el('div', 'segmented');
  const grounds: { value: Ground; label: string; title: string }[] = [
    { value: 'marbled', label: 'Marbled', title: 'Little squares combed like marbled paper' },
    { value: 'check', label: 'Check', title: 'The plain check grid' },
  ];
  const groundButtons = grounds.map((g) => {
    const b = el('button', 'seg');
    b.type = 'button';
    b.textContent = g.label;
    b.title = g.title;
    b.addEventListener('click', () => { applyGround(g.value); sync(); });
    groundSeg.append(b);
    return { b, g };
  });
  groundRow.append(groundLabel, groundSeg);

  pop.append(head, tabs, views, grid, spectrum, field, hue.row, bright.row, vivid.row, hexRow, groundRow);
  document.body.append(pop);

  reset.addEventListener('click', () => {
    applyGround('marbled');
    choices = {};
    save(choices);
    applyGuiColours(choices);
    sync();
  });

  function commit(p: Pick): void {
    choices = { ...choices, [target]: p };
    save(choices);
    applyGuiColours(choices);
    sync();
  }

  function sync(): void {
    const p = current();
    for (const { b, chip, t } of tabButtons) {
      b.classList.toggle('on', t.value === target);
      chip.style.background = css(choices[t.value] ?? DEFAULTS[t.value]);
    }
    field.style.setProperty('--hue', css({ h: p.h, s: 1, v: 1, vivid: p.vivid }));
    knob.style.left = `${p.s * 100}%`;
    knob.style.top = `${(1 - p.v) * 100}%`;
    hue.input.value = String(p.h);
    bright.input.value = String(p.v);
    vivid.input.value = String(p.vivid);
    for (const r of [hue.input, bright.input, vivid.input]) {
      r.style.setProperty('--fill', `${(Number(r.value) / Number(r.max)) * 100}%`);
    }
    swatch.style.background = css(p);
    if (document.activeElement !== hexIn) hexIn.value = hex(hsvToRgb(p.h, p.s, p.v));
    for (const { b, v } of viewButtons) b.classList.toggle('on', v === view);
    grid.hidden = view !== 'squares';
    spectrum.hidden = view !== 'spectrum';
    specKnob.style.left = `${(p.h / 360) * 100}%`;
    specKnob.style.top = `${(p.v >= 0.999 ? p.s / 2 : 1 - p.v / 2) * 100}%`;
    resetOne.disabled = !choices[target];
    const ground = document.documentElement.dataset.ground ?? 'marbled';
    for (const { b, g } of groundButtons) b.classList.toggle('on', g.value === ground);
    reset.disabled = !Object.keys(choices).length && ground === 'marbled';
  }

  const place = () => {
    const r = trigger.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 4}px`;
  };
  const open = (on: boolean) => {
    pop.hidden = !on;
    trigger.classList.toggle('on', on);
    trigger.setAttribute('aria-expanded', String(on));
    if (on) { sync(); place(); }
  };
  trigger.addEventListener('click', () => open(pop.hidden));
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !trigger.contains(e.target as Node)) open(false);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) open(false); });
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
}
