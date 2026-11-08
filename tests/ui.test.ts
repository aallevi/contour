// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/app';
import { Store } from '../src/core/store';
import { defaultFreeform, defaultGradient, defaultProject, makeBands } from '../src/core/defaults';
import { Engine } from '../src/pipeline/engine';
import { bandEditorPanel, bandsPanel } from '../src/ui/bands';
import { documentPanel, regionsPanel } from '../src/ui/panels';
import { gradientBar } from '../src/ui/gradient';
import { slider } from '../src/ui/controls';
import { gammaToPosition, positionToGamma } from '../src/ui/curves';
import type { Ctx } from '../src/ui/context';
import type { FreeformFill, GradientFill, GradientStop } from '../src/core/types';
import { Panel } from '../src/ui/controls';

/**
 * The sidebar, built for real.
 *
 * None of this could be tested before: the engine asked for a WebGL2 context in
 * its field initialiser, so constructing anything that held one threw in jsdom
 * — and that same eagerness is why a machine without WebGL2 got a blank window
 * instead of a message. With the context deferred, the panels can be built and
 * driven here, which is where the "nothing happens when I click it" class of
 * bug actually lives.
 */

function context(): Ctx {
  const store = new Store(defaultProject());
  const engine = new Engine();
  let selected: string | null = store.get().bands[0]?.id ?? null;
  let point: string | null = null;
  return {
    store,
    engine,
    selectedBand: () => selected,
    selectBand: (id) => { selected = id; },
    refresh: () => {},
    status: () => {},
    openImage: async () => {},
    pickColour: () => {},
    ensureHighlights: () => {},
    afterTrace: () => {},
    rebuildBands: () => {},
    takePaletteIntoBands: () => {},
    respace: () => {},
    sampleGradient: () => null,
    selectedFreePoint: () => point,
    selectFreePoint: (id) => { point = id; },
    sampleFreePoints: () => null,
    scatterFreePoints: () => null,
  };
}

describe('the whole shell', () => {
  it('builds without a graphics context of any kind', () => {
    // The closest a test can get to launching the app: every panel, the
    // toolbar, the stage, the split divider and the colour-point overlay, all
    // wired together. jsdom provides neither WebGL2 nor a 2D context, which is
    // exactly the environment this has to survive.
    const root = document.createElement('div');
    document.body.append(root);
    const app = new App(root);
    (app as unknown as { build(): void }).build();

    expect(root.querySelector('.toolbar')).toBeTruthy();
    expect(root.querySelector('.stage')).toBeTruthy();
    expect(root.querySelector('.split-handle')).toBeTruthy();
    expect(root.querySelector('.freeform-overlay')).toBeTruthy();
    // Document, Image, Regions, Trace, Bands, Band.
    expect(root.querySelectorAll('.panel')).toHaveLength(6);
  });

  it('offers both tracers', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const app = new App(root);
    (app as unknown as { build(): void }).build();

    const labels = [...root.querySelectorAll('button.seg')].map((b) => b.textContent);
    expect(labels).toContain('potrace');
    expect(labels).toContain('vtracer');
  });
});

describe('building the sidebar', () => {
  it('constructs every panel without a graphics context', () => {
    const ctx = context();
    for (const make of [documentPanel, regionsPanel, bandsPanel, bandEditorPanel]) {
      const panel = make(ctx);
      expect(panel.el).toBeTruthy();
      // A second sync is what happens on every document change; it must not
      // throw on a document that has no image yet.
      panel.sync();
    }
  });

  it('shows the transparency controls only for an image with a matte', () => {
    const ctx = context();
    const panel = regionsPanel(ctx);
    document.body.append(panel.el);
    const matteBox = [...panel.el.querySelectorAll('.subgroup')]
      .find((n) => n.querySelector('h4')?.textContent === 'Transparency') as HTMLElement;
    expect(matteBox).toBeTruthy();
    expect(matteBox.style.display).toBe('none');
  });
});

describe('the gradient stop editor', () => {
  let stops: GradientStop[];
  const host = () => {
    const p = new Panel('t');
    return p;
  };

  beforeEach(() => {
    stops = defaultGradient([0.4, 0.3, 0.2]).stops;
  });

  it('draws the ramp from the stops it is given', () => {
    const p = host();
    const bar = gradientBar(p, { get: () => stops, set: (next) => { stops = next; } });
    document.body.append(bar.el);
    const ramp = bar.el.querySelector('.grad-ramp') as HTMLElement;
    expect(ramp.style.background).toContain('linear-gradient');
    expect(bar.el.querySelectorAll('.grad-handle')).toHaveLength(stops.length);
  });

  it('adds a stop where the bar is clicked', () => {
    const p = host();
    const bar = gradientBar(p, { get: () => stops, set: (next) => { stops = next; p.sync(); } });
    document.body.append(bar.el);
    const el = bar.el.querySelector('.grad-bar') as HTMLElement;
    // jsdom lays nothing out, so the bar has to be told how wide it is before a
    // click position means anything.
    el.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 40 }) as DOMRect;

    const before = stops.length;
    // A default ramp has stops at 0, 0.38, 0.74 and 1; 0.17 is clear of all of
    // them, so this is a click on bare bar rather than on a handle.
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 34, clientY: 10 }));
    expect(stops.length).toBe(before + 1);
    expect(stops.some((s) => Math.abs(s.offset - 0.17) < 1e-6)).toBe(true);
    // Ascending, always.
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].offset).toBeGreaterThanOrEqual(stops[i - 1].offset);
    }
  });

  it('selects an existing stop rather than stacking a new one on it', () => {
    const p = host();
    const bar = gradientBar(p, { get: () => stops, set: (next) => { stops = next; p.sync(); } });
    document.body.append(bar.el);
    const el = bar.el.querySelector('.grad-bar') as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 40 }) as DOMRect;

    const before = stops.length;
    // Right on the stop at 0.38.
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 76, clientY: 10 }));
    expect(stops.length).toBe(before);
    expect(bar.selected()).toBe(1);
  });

  it('refuses to go below two stops', () => {
    let two: GradientStop[] = [
      { offset: 0, rgb: [0, 0, 0] },
      { offset: 1, rgb: [1, 1, 1] },
    ];
    const p = host();
    const bar = gradientBar(p, { get: () => two, set: (next) => { two = next; p.sync(); } });
    document.body.append(bar.el);
    const remove = [...bar.el.querySelectorAll('button')]
      .find((b) => b.textContent === 'Remove') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    remove.click();
    expect(two).toHaveLength(2);
  });
});

describe('the band editor', () => {
  it('switches a band to a freeform fill with colours already in it', () => {
    const ctx = context();
    ctx.store.replaceBands(makeBands(4));
    ctx.selectBand(ctx.store.get().bands[0].id);

    const panel = bandEditorPanel(ctx);
    document.body.append(panel.el);
    panel.sync();

    const freeform = [...panel.el.querySelectorAll('button.seg')]
      .find((b) => b.textContent === 'Freeform') as HTMLButtonElement;
    freeform.click();

    const fill = ctx.store.get().bands[0].fill as FreeformFill;
    expect(fill.kind).toBe('freeform');
    expect(fill.points.length).toBeGreaterThanOrEqual(3);
    // Every point needs an id, or the overlay cannot tell them apart.
    expect(new Set(fill.points.map((p) => p.id)).size).toBe(fill.points.length);
  });

  it('shows the point editor only once a point is selected', () => {
    const ctx = context();
    ctx.store.replaceBands(makeBands(3));
    const id = ctx.store.get().bands[0].id;
    ctx.selectBand(id);
    ctx.store.updateBand(id, { fill: defaultFreeform([0.4, 0.4, 0.4]) });

    const panel = bandEditorPanel(ctx);
    document.body.append(panel.el);
    panel.sync();

    const box = panel.el.querySelector('.free-point') as HTMLElement;
    expect(box.style.display).toBe('none');

    const fill = ctx.store.get().bands[0].fill as FreeformFill;
    ctx.selectFreePoint(fill.points[1].id);
    panel.sync();
    expect(box.style.display).toBe('');
    expect(box.querySelector('h4')?.textContent).toBe('Point 2 of 4');
  });

  it('switches a band to a gradient that is actually visible', () => {
    const ctx = context();
    ctx.store.replaceBands(makeBands(4));
    const first = ctx.store.get().bands[0];
    ctx.selectBand(first.id);

    const panel = bandEditorPanel(ctx);
    document.body.append(panel.el);
    panel.sync();

    const gradientButton = [...panel.el.querySelectorAll('button.seg')]
      .find((b) => b.textContent === 'Ramp') as HTMLButtonElement;
    gradientButton.click();

    const fill = ctx.store.get().bands[0].fill as GradientFill;
    expect(fill.kind).toBe('gradient');
    expect(fill.stops.length).toBeGreaterThanOrEqual(2);
    // The two ends must differ, or turning the gradient on changes nothing.
    expect(fill.stops[0].rgb).not.toEqual(fill.stops[fill.stops.length - 1].rgb);
  });

  it('hides the radial controls while the gradient is linear', () => {
    const ctx = context();
    ctx.store.replaceBands(makeBands(3));
    const id = ctx.store.get().bands[0].id;
    ctx.selectBand(id);
    ctx.store.updateBand(id, { fill: defaultGradient([0.3, 0.3, 0.3]) });

    const panel = bandEditorPanel(ctx);
    document.body.append(panel.el);
    panel.sync();

    const radial = [...panel.el.querySelectorAll('.subgroup .subgroup')][0] as HTMLElement;
    expect(radial.style.display).toBe('none');
  });
});

describe('sliders', () => {
  it('keep following the document after a release that lands elsewhere', () => {
    const p = new Panel('t');
    let value = 1;
    const wrap = slider(p, {
      label: 'Opacity', min: 0, max: 1, step: 0.01,
      get: () => value, set: (v) => { value = v; },
    });
    document.body.append(wrap);
    const input = wrap.querySelector('input.range') as HTMLInputElement;

    input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    // Release over some other part of the page, as happens on any quick drag.
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    value = 0.25;
    p.sync();
    expect(input.value).toBe('0.25');
  });
});

describe('the levels rail', () => {
  it('puts the midtone marker on the input that comes out as mid grey', () => {
    // Neutral gamma sits in the middle. A gamma above 1 brightens, so the input
    // that lands on mid grey is darker and the marker goes left — the same
    // direction the midtone slider moves in every levels dialog.
    expect(gammaToPosition(1)).toBeCloseTo(0.5, 6);
    expect(gammaToPosition(2)).toBeLessThan(0.5);
    expect(gammaToPosition(0.5)).toBeGreaterThan(0.5);
  });

  it('round-trips a drag back to a gamma', () => {
    for (const g of [0.4, 1, 1.8, 3]) {
      expect(positionToGamma(gammaToPosition(g))).toBeCloseTo(g, 4);
    }
  });

  it('stays inside the range the slider offers', () => {
    expect(positionToGamma(0)).toBeGreaterThanOrEqual(0.1);
    expect(positionToGamma(1)).toBeLessThanOrEqual(10);
  });
});
