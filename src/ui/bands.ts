import { contrastInk, cssRgb, hexToRgb, lumaOf, rgbToHex } from '../core/color';
import { paperChoices } from './panels';
import { defaultBand, defaultFreeform, defaultGradient, gradientRamp, ID } from '../core/defaults';
import { Dirty } from '../core/store';
import { balancedThresholds, equalAreaThresholds, evenThresholds } from '../band/posterize';
import type { Band, Fill, FreeformFill, Project, FreePoint, GradientFill, GradientStop, RGB, Spacing } from '../core/types';
import {
  button, buttonRow, colourField, el, help, lengthSlider, Panel, segmented, slider, toggle,
} from './controls';
import { gradientBar } from './gradient';
import { hatchSpacing, stipplePitch } from '../fill';
import type { Ctx } from './context';
import { formatLength, shortEdge } from '../core/scale';

/**
 * The band stack, and the editor for whichever band is selected.
 *
 * A band is an object, not a slot: it owns the tone it cuts at, so duplicating
 * one gives a second pass over the same region with a different fill — a flat
 * wash under a hatch, or two hatches crossed at different weights — and
 * deleting one leaves the rest exactly where they were.
 */

export function bandsPanel(ctx: Ctx): Panel {
  const p = new Panel('Bands');
  const list = el('div', 'band-list');
  p.body.append(list);
  // The paper is the bottom layer of every drawing, so it sits at the foot of
  // the stack as one: a colour you can change here, or None.
  const paperRow = el('div', 'band-row paper-row');
  const paperSwatch = el('input', 'band-swatch paper-swatch');
  paperSwatch.type = 'color';
  paperSwatch.title = 'Paper colour';
  paperSwatch.addEventListener('input', () =>
    ctx.store.updateCanvas({ paper: hexToRgb(paperSwatch.value) }, 'canvas:paper'));
  const paperName = el('span', 'band-name');
  const paperNote = el('span', 'band-meta');
  paperRow.append(el('span', 'band-eye'), paperSwatch, paperName, paperNote);
  list.after(paperRow);
  p.body.append(paperChoices(ctx));

  p.add(buttonRow(
    button('+ Add band', () => addBand(ctx), {
      title: 'One more region: another tone step, or another colour solved from the picture',
    }),
    button('+ Add colour from picture', () => ctx.pickColour((rgb) => addPickedColour(ctx, rgb)), {
      title: 'Click the picture: that colour becomes a band of its own',
    }),
  ));
  p.add(buttonRow(
    button('Duplicate', () => {
      const id = ctx.selectedBand();
      const bands = ctx.store.get().bands;
      const i = bands.findIndex((b) => b.id === id);
      if (i < 0) return;
      const copy: Band = { ...structuredClone(bands[i]), id: ID(), name: `${bands[i].name} copy` };
      const next = [...bands];
      next.splice(i, 0, copy);
      ctx.store.replaceBands(next, Dirty.Band, 'band:duplicate');
      ctx.selectBand(copy.id);
    }),
    button('Delete', () => {
      const id = ctx.selectedBand();
      const bands = ctx.store.get().bands;
      if (bands.length <= 1 || !id) return;
      const next = bands.filter((b) => b.id !== id);
      ctx.store.replaceBands(next, Dirty.Fill, 'band:delete');
      ctx.selectBand(next[0].id);
    }),
  ));
  p.add(help('Bands paint back to front: the last one in this list goes down first and the first one lands on top.'));

  p.onSync(() => {
    const project = ctx.store.get();
    const selected = ctx.selectedBand();
    list.replaceChildren();
    const shares = ctx.engine.bandShares(project as Project);
    const paper = project.canvas.paper;
    paperRow.classList.toggle('none', paper === null);
    paperSwatch.value = rgbToHex(paper ?? [1, 1, 1]);
    paperName.textContent = paper === null ? 'Paper: none (transparent)' : 'Paper';
    paperNote.textContent = shares.shares.size ? `${Math.round(shares.paper * 100)}%` : '';
    paperNote.title = 'Share of the sheet where the paper shows';

    project.bands.forEach((band, index) => {
      const row = el('div', 'band-row');
      if (band.id === selected) row.classList.add('selected');
      row.draggable = true;

      const eye = el('button', 'band-eye');
      eye.type = 'button';
      eye.textContent = band.visible ? '◉' : '○';
      eye.title = band.visible ? 'Hide this band' : 'Show this band';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.store.updateBand(band.id, { visible: !band.visible });
      });

      const swatch = el('span', 'band-swatch');
      swatch.style.background = cssRgb(band.colour);
      swatch.style.color = cssRgb(contrastInk(band.colour));
      swatch.textContent = fillGlyph(band.fill);
      swatch.title = fillName(band.fill);

      const name = el('span', 'band-name');
      name.textContent = band.name;

      const meta = el('span', 'band-meta');
      const err = ctx.engine.traceErrors().get(band.id);
      // What share of the sheet this band prints, the number a printer asks
      // about; what it cuts at is one hover away.
      const share = shares.shares.get(band.id);
      meta.textContent = err
        ? '!'
        : share !== undefined ? `${Math.round(share * 100)}%` : '';
      meta.title = project.banding.mode === 'tone'
        ? `Prints ${share !== undefined ? Math.round(share * 100) : '?'}% of the sheet \u00b7 cuts at tone ${band.threshold.toFixed(2)}`
        : `Prints ${share !== undefined ? Math.round(share * 100) : '?'}% of the sheet \u00b7 ${rgbToHex(band.source)}`;
      if (err) {
        meta.classList.add('error');
        meta.title = err;
      }

      row.append(eye, swatch, name, meta);
      row.addEventListener('click', () => ctx.selectBand(band.id));

      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(index));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        const from = Number(e.dataTransfer?.getData('text/plain'));
        if (Number.isFinite(from)) ctx.store.moveBand(project.bands[from].id, index);
      });

      list.append(row);
    });
  });

  return p;
}

const fillGlyph = (fill: Fill): string =>
  fill.kind === 'hatch' ? '≡'
    : fill.kind === 'stipple' ? '⁙'
      : fill.kind === 'gradient' ? '◧'
        : fill.kind === 'freeform' ? '⁘' : '';

const fillName = (fill: Fill): string =>
  fill.kind === 'flat' ? 'Flat' : fill.kind[0].toUpperCase() + fill.kind.slice(1);

// -- the selected band -------------------------------------------------------

const HATCH_DEFAULT = {
  kind: 'hatch' as const,
  // Lengths as fractions of the short edge: 0.006 is 6 px on a 1000 px sheet.
  angle: 45, spacing: 0.006, weight: 0.0014, cross: false, crossAngle: 90,
  toneWeight: 0, wave: 0, waveLength: 0.04, base: 0,
};
const STIPPLE_DEFAULT = {
  kind: 'stipple' as const,
  spacing: 0.005, size: 0.0024, jitter: 0.7, toneSize: 0.6, toneDrop: 0.3, base: 0, seed: 1,
};
const GRADIENT_DEFAULT = (colour: RGB): GradientFill => defaultGradient(colour);

export function bandEditorPanel(ctx: Ctx): Panel {
  const p = new Panel('Band');
  const s = ctx.store;
  const band = (): Band | undefined => s.get().bands.find((b) => b.id === ctx.selectedBand());
  const patch = (v: Partial<Band>, key?: string) => {
    const b = band();
    if (b) s.updateBand(b.id, v, key);
  };
  const patchFill = (v: Record<string, unknown>, key?: string) => {
    const b = band();
    if (b) s.updateBand(b.id, { fill: { ...b.fill, ...v } as Fill }, key ?? `fill:${b.id}`);
  };
  const canvas = () => s.get().canvas;

  const title = el('p', 'source-name');
  p.add(title);
  p.onSync(() => {
    const b = band();
    title.textContent = b ? b.name : 'No band selected';
  });

  p.add(colourField(p, {
    label: 'Colour',
    get: () => band()?.colour ?? [0, 0, 0],
    set: (v) => patch({ colour: v }, `band:colour`),
  }));
  p.add(slider(p, {
    label: 'Opacity', min: 0, max: 1, step: 0.01,
    get: () => band()?.opacity ?? 1,
    set: (v) => patch({ opacity: v }, 'band:opacity'),
  }));

  p.add(segmented(p, {
    label: 'Fill',
    options: [
      { value: 'flat', label: 'Flat' },
      { value: 'gradient', label: 'Ramp' },
      { value: 'freeform', label: 'Freeform' },
      { value: 'hatch', label: 'Hatch' },
      { value: 'stipple', label: 'Stipple' },
    ],
    get: () => band()?.fill.kind ?? 'flat',
    set: (kind) => {
      const b = band();
      if (!b || b.fill.kind === kind) return;
      const next: Fill =
        kind === 'hatch' ? { ...HATCH_DEFAULT }
          : kind === 'stipple' ? { ...STIPPLE_DEFAULT, seed: Math.floor(Math.random() * 1e6) }
            : kind === 'gradient' ? GRADIENT_DEFAULT(b.colour)
              : kind === 'freeform' ? defaultFreeform(b.colour)
                : { kind: 'flat' };
      s.updateBand(b.id, { fill: next });
      if (kind === 'freeform') ctx.selectFreePoint(null);
    },
  }));

  // -- gradient
  const gfill = (): GradientFill | null => {
    const f = band()?.fill;
    return f && f.kind === 'gradient' ? f : null;
  };
  const grad = el('div', 'subgroup');
  grad.append(segmented(p, {
    label: 'Shape',
    options: [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }],
    get: () => gfill()?.shape ?? 'linear',
    set: (v) => patchFill({ shape: v }),
  }));

  const bar = gradientBar(p, {
    get: () => gfill()?.stops ?? [],
    set: (stops: GradientStop[], key?: string) => patchFill({ stops }, key ?? 'fill:stops'),
  });
  grad.append(bar.el);

  grad.append(buttonRow(
    button('Take colours', () => {
      // Bake what sampling is currently showing into real stops and switch it
      // off, so the ramp becomes one the stop editor can edit. Without this a
      // sampled gradient is a black box: the bar shows colours the drawing does
      // not use, and nudging one of them does nothing at all.
      const b = band();
      const f = gfill();
      if (!b || !f) return;
      const taken = ctx.sampleGradient(b.id);
      s.updateBand(b.id, {
        fill: { ...f, sampled: false, stops: taken ?? f.stops },
      }, 'fill:bake');
    }, { title: 'Read the photograph at each stop and keep the result as editable colours' }),
    button('Reset ramp', () => {
      const b = band();
      if (b) patchFill({ stops: gradientRamp(b.colour) }, 'fill:ramp');
    }, { title: "A fresh light-to-dark ramp around the band's own colour" }),
  ));
  grad.append(toggle(p, {
    label: 'Read colours from the photograph',
    get: () => !!gfill()?.sampled,
    set: (v) => patchFill({ sampled: v }),
    hint: 'Every stop takes the region’s mean colour at its own position on the ramp',
  }));

  grad.append(toggle(p, {
    label: 'Aim from the photograph',
    get: () => gfill()?.angle === 'auto',
    set: (v) => patchFill({ angle: v ? 'auto' : 90 }),
    hint: 'Fits a plane to the region’s tone and points the gradient down its slope',
  }));
  grad.append(slider(p, {
    label: 'Angle', min: -180, max: 180, step: 1, unit: '°',
    get: () => {
      const a = gfill()?.angle;
      return typeof a === 'number' ? a : 90;
    },
    set: (v) => patchFill({ angle: v }, 'fill:angle'),
    disabled: () => gfill()?.angle === 'auto',
  }));

  grad.append(slider(p, {
    label: 'Ramp start', min: -1, max: 2, step: 0.01,
    get: () => gfill()?.start ?? 0,
    set: (v) => patchFill({ start: v }, 'fill:start'),
    hint: () => 'Where the first stop lands on the region. 0 is its near edge.',
  }));
  grad.append(slider(p, {
    label: 'Ramp end', min: -1, max: 2, step: 0.01,
    get: () => gfill()?.end ?? 1,
    set: (v) => patchFill({ end: v }, 'fill:end'),
    hint: () => {
      const f = gfill();
      if (!f) return '';
      if (f.end < f.start) return 'Below the start, so the ramp runs backwards';
      if (Math.abs(f.end - f.start) < 0.02) return 'A hard edge rather than a blend';
      return 'Past 1 pushes the last stop off the region, so only part of the ramp shows';
    },
  }));
  grad.append(buttonRow(
    button('Fill region', () => patchFill({ start: 0, end: 1 }, 'fill:extent')),
    button('Reverse', () => {
      const f = gfill();
      if (f) patchFill({ start: f.end, end: f.start }, 'fill:extent');
    }),
  ));

  const radial = el('div', 'subgroup');
  radial.append(slider(p, {
    label: 'Radius', min: 0.05, max: 3, step: 0.01,
    get: () => gfill()?.radius ?? 1,
    set: (v) => patchFill({ radius: v }, 'fill:radius'),
    hint: () => 'As a multiple of the region’s half-diagonal',
  }));
  radial.append(slider(p, {
    label: 'Centre across', min: -0.5, max: 1.5, step: 0.01,
    get: () => gfill()?.cx ?? 0.5,
    set: (v) => patchFill({ cx: v }, 'fill:cx'),
  }));
  radial.append(slider(p, {
    label: 'Centre down', min: -0.5, max: 1.5, step: 0.01,
    get: () => gfill()?.cy ?? 0.5,
    set: (v) => patchFill({ cy: v }, 'fill:cy'),
  }));
  grad.append(radial);
  p.onSync(() => {
    radial.style.display = gfill()?.shape === 'radial' ? '' : 'none';
  });

  grad.append(help(
    'Bands nest, so a light band is mostly covered by the darker ones on top of ' +
    'it and only its outer margin shows. If a gradient looks like it is doing ' +
    'nothing, that is usually why — put it on the darkest band, or turn off ' +
    'Nest regions, to see the whole ramp.',
  ));
  p.body.append(grad);

  // -- freeform
  const ffill = (): FreeformFill | null => {
    const f = band()?.fill;
    return f && f.kind === 'freeform' ? f : null;
  };
  const point = (): FreePoint | null => {
    const f = ffill();
    const id = ctx.selectedFreePoint();
    return (f && id && f.points.find((p) => p.id === id)) || null;
  };
  const setPoints = (points: FreePoint[], key?: string) => patchFill({ points }, key);
  const patchPoint = (patch: Partial<FreePoint>, key?: string) => {
    const f = ffill();
    const p = point();
    if (!f || !p) return;
    setPoints(f.points.map((q) => (q.id === p.id ? { ...q, ...patch } : q)), key);
  };

  const free = el('div', 'subgroup');
  free.append(help(
    'Drop colours where the light puts them. Drag a handle on the drawing to ' +
    'move one, double-click the drawing to add one, alt-click a handle to ' +
    'remove it, and alt-scroll over a handle to change how far it reaches.',
  ));
  free.append(buttonRow(
    button('Scatter', () => {
      // The one-press version: cover the region with points and read the
      // photograph under each. Everything else here is refinement.
      const b = band();
      if (!b) return;
      const points = ctx.scatterFreePoints(b.id, 7);
      if (!points) {
        ctx.status('Nothing traced yet to scatter points over', 'warn');
        return;
      }
      setPoints(points, 'free:scatter');
      ctx.selectFreePoint(null);
    }, { title: 'Cover the region with colours taken from the photograph' }),
    button('Take colours', () => {
      const b = band();
      if (!b) return;
      const points = ctx.sampleFreePoints(b.id);
      if (points) setPoints(points, 'free:sample');
    }, { title: 'Re-read the photograph under the points that are already there' }),
  ));
  free.append(colourField(p, {
    label: 'Ground',
    get: () => ffill()?.base ?? [0, 0, 0],
    set: (v) => patchFill({ base: v }, 'free:base'),
  }));

  const pointBox = el('div', 'subgroup free-point');
  const pointTitle = el('h4');
  pointTitle.textContent = 'Point';
  pointBox.append(pointTitle);
  pointBox.append(colourField(p, {
    label: 'Colour',
    get: () => point()?.rgb ?? [0, 0, 0],
    set: (v) => patchPoint({ rgb: v }, 'free:colour'),
  }));
  pointBox.append(slider(p, {
    label: 'Reach', min: 0.02, max: 2, step: 0.01,
    get: () => point()?.radius ?? 0.5,
    set: (v) => patchPoint({ radius: v }, 'free:radius'),
    hint: () => 'As a fraction of the region\u2019s diagonal. Overlap the neighbours '
      + 'or the ground shows through between them.',
  }));
  pointBox.append(buttonRow(
    button('Remove point', () => {
      const f = ffill();
      const sel = point();
      if (!f || !sel || f.points.length <= 1) return;
      setPoints(f.points.filter((q) => q.id !== sel.id));
      ctx.selectFreePoint(null);
    }),
  ));
  free.append(pointBox);
  p.body.append(free);

  p.onSync(() => {
    const f = ffill();
    const sel = point();
    pointBox.style.display = f && sel ? '' : 'none';
    if (sel && f) {
      pointTitle.textContent = `Point ${f.points.indexOf(sel) + 1} of ${f.points.length}`;
    }
  });

  // -- hatch
  const hatch = el('div', 'subgroup');
  hatch.append(slider(p, {
    label: 'Angle', min: -180, max: 180, step: 1, unit: '°',
    get: () => (band()?.fill as { angle?: number })?.angle ?? 45,
    set: (v) => patchFill({ angle: v }, 'fill:hangle'),
  }));
  hatch.append(lengthSlider(p, {
    label: 'Spacing', min: 0.0008, max: 0.06, canvas,
    get: () => (band()?.fill as { spacing?: number })?.spacing ?? 0.006,
    set: (v) => patchFill({ spacing: v }, 'fill:spacing'),
    hint: () => {
      const c = s.get().canvas;
      const asked = ((band()?.fill as { spacing?: number })?.spacing ?? 0.006) * shortEdge(c);
      // The cap is per band and depends on how far the sweep has to run; the
      // canvas diagonal is the worst case, which is the honest thing to warn
      // against. Saying nothing and quietly drawing something else is what the
      // old behaviour did.
      const capped = hatchSpacing(asked, Math.hypot(c.width, c.height));
      return capped > asked + 1e-6
        ? `too fine for this sheet \u2014 drawing at ${formatLength(capped / shortEdge(c), c)} instead`
        : `${asked.toFixed(1)} px at this size`;
    },
  }));
  hatch.append(lengthSlider(p, {
    label: 'Weight', min: 0.00005, max: 0.02, canvas,
    get: () => (band()?.fill as { weight?: number })?.weight ?? 0.0014,
    set: (v) => patchFill({ weight: v }, 'fill:weight'),
  }));
  hatch.append(slider(p, {
    label: 'Weight follows tone', min: 0, max: 1, step: 0.01,
    get: () => (band()?.fill as { toneWeight?: number })?.toneWeight ?? 0,
    set: (v) => patchFill({ toneWeight: v }, 'fill:toneweight'),
    hint: () => ((band()?.fill as { toneWeight?: number })?.toneWeight ?? 0) > 0.001
      ? 'Lines become filled ribbons that swell in shadow — the engraving look'
      : 'Lines are constant-width strokes',
  }));
  hatch.append(toggle(p, {
    label: 'Cross-hatch',
    get: () => !!(band()?.fill as { cross?: boolean })?.cross,
    set: (v) => patchFill({ cross: v }),
  }));
  hatch.append(slider(p, {
    label: 'Cross angle', min: 5, max: 175, step: 1, unit: '°',
    get: () => (band()?.fill as { crossAngle?: number })?.crossAngle ?? 90,
    set: (v) => patchFill({ crossAngle: v }, 'fill:cross'),
    disabled: () => !(band()?.fill as { cross?: boolean })?.cross,
  }));
  hatch.append(lengthSlider(p, {
    label: 'Wave', min: 0, max: 0.02, canvas,
    get: () => (band()?.fill as { wave?: number })?.wave ?? 0,
    set: (v) => patchFill({ wave: v }, 'fill:wave'),
  }));
  hatch.append(lengthSlider(p, {
    label: 'Wavelength', min: 0.004, max: 0.3, canvas,
    get: () => (band()?.fill as { waveLength?: number })?.waveLength ?? 0.04,
    set: (v) => patchFill({ waveLength: v }, 'fill:wavelen'),
    disabled: () => ((band()?.fill as { wave?: number })?.wave ?? 0) < 1e-5,
  }));
  p.body.append(hatch);

  // -- stipple
  const stip = el('div', 'subgroup');
  stip.append(lengthSlider(p, {
    label: 'Spacing', min: 0.001, max: 0.04, canvas,
    get: () => (band()?.fill as { spacing?: number })?.spacing ?? 0.005,
    set: (v) => patchFill({ spacing: v }, 'fill:sspacing'),
    hint: () => {
      const c = s.get().canvas;
      const asked = ((band()?.fill as { spacing?: number })?.spacing ?? 0.005) * shortEdge(c);
      const capped = stipplePitch(asked, c.width * c.height);
      return capped > asked + 1e-6
        ? `too fine for this sheet \u2014 drawing at ${formatLength(capped / shortEdge(c), c)} instead`
        : `${asked.toFixed(1)} px at this size`;
    },
  }));
  stip.append(lengthSlider(p, {
    label: 'Dot size', min: 0.0001, max: 0.02, canvas,
    get: () => (band()?.fill as { size?: number })?.size ?? 0.0024,
    set: (v) => patchFill({ size: v }, 'fill:size'),
  }));
  stip.append(slider(p, {
    label: 'Jitter', min: 0, max: 1, step: 0.01,
    get: () => (band()?.fill as { jitter?: number })?.jitter ?? 0.7,
    set: (v) => patchFill({ jitter: v }, 'fill:jitter'),
    hint: () => 'At zero the dots are a visible grid; above about 0.6 they read as scattered',
  }));
  stip.append(slider(p, {
    label: 'Size follows tone', min: 0, max: 1, step: 0.01,
    get: () => (band()?.fill as { toneSize?: number })?.toneSize ?? 0.6,
    set: (v) => patchFill({ toneSize: v }, 'fill:tonesize'),
  }));
  stip.append(slider(p, {
    label: 'Thinning', min: 0, max: 1, step: 0.01,
    get: () => (band()?.fill as { toneDrop?: number })?.toneDrop ?? 0.3,
    set: (v) => patchFill({ toneDrop: v }, 'fill:tonedrop'),
    hint: () => 'Drops dots where the photograph is light, rather than shrinking them',
  }));
  stip.append(buttonRow(button('Reseed', () =>
    patchFill({ seed: Math.floor(Math.random() * 1e6) }))));
  p.body.append(stip);

  // -- base wash, shared by hatch and stipple
  const base = el('div', 'subgroup');
  base.append(slider(p, {
    label: 'Base wash', min: 0, max: 1, step: 0.01,
    get: () => (band()?.fill as { base?: number })?.base ?? 0,
    set: (v) => patchFill({ base: v }, 'fill:base'),
    hint: () => 'A flat layer of the band colour under the marks',
  }));
  p.body.append(base);

  // -- outline
  const outline = el('div', 'subgroup');
  const olab = el('h4');
  olab.textContent = 'Outline';
  outline.append(olab);
  outline.append(toggle(p, {
    label: 'Draw the contour',
    get: () => !!band()?.outline.on,
    set: (v) => {
      const b = band();
      if (b) s.updateBand(b.id, { outline: { ...b.outline, on: v } });
    },
  }));
  outline.append(colourField(p, {
    label: 'Colour',
    get: () => band()?.outline.colour ?? [0, 0, 0],
    set: (v) => {
      const b = band();
      if (b) s.updateBand(b.id, { outline: { ...b.outline, colour: v } }, 'outline:colour');
    },
  }));
  outline.append(lengthSlider(p, {
    label: 'Width', min: 0.00005, max: 0.02, canvas,
    get: () => band()?.outline.width ?? 0.001,
    set: (v) => {
      const b = band();
      if (b) s.updateBand(b.id, { outline: { ...b.outline, width: v } }, 'outline:width');
    },
  }));
  p.body.append(outline);

  // -- shaping, which is the one group here that costs a retrace
  const shaping = el('div', 'subgroup retrace');
  const shlab = el('h4');
  shlab.textContent = 'Region shape';
  shaping.append(shlab, help('These two re-run potrace on this band. Everything above only redraws.'));
  shaping.append(slider(p, {
    label: 'Grow', min: -12, max: 12, step: 0.1, unit: ' px',
    get: () => band()?.shaping.grow ?? 0,
    set: (v) => {
      const b = band();
      if (b) s.updateBand(b.id, { shaping: { ...b.shaping, grow: v } }, 'shape:grow');
    },
    hint: () => 'Spreads or chokes the region — the printer’s trapping trick',
  }));
  shaping.append(slider(p, {
    label: 'Smooth', min: 0, max: 12, step: 0.1, unit: ' px',
    get: () => band()?.shaping.smooth ?? 0,
    set: (v) => {
      const b = band();
      if (b) s.updateBand(b.id, { shaping: { ...b.shaping, smooth: v } }, 'shape:smooth');
    },
    hint: () => 'Rounds off staircase edges before they are traced',
  }));
  p.body.append(shaping);

  p.onSync(() => {
    const b = band();
    const kind = b?.fill.kind ?? 'flat';
    grad.style.display = kind === 'gradient' ? '' : 'none';
    free.style.display = kind === 'freeform' ? '' : 'none';
    hatch.style.display = kind === 'hatch' ? '' : 'none';
    stip.style.display = kind === 'stipple' ? '' : 'none';
    base.style.display = kind === 'hatch' || kind === 'stipple' ? '' : 'none';
    p.body.classList.toggle('empty', !b);
  });

  return p;
}

/**
 * Rebuild the stack for a new level count, keeping what can be kept.
 *
 * Fill, shaping and opacity are carried over by position, because changing
 * four levels to five should add a band rather than throw away the hatching on
 * the other four. Colours are re-taken from the ramp or the palette, since the
 * whole point of the change is that the tonal steps are different now.
 */
export function rebuildBands(ctx: Ctx): void {
  const s = ctx.store;
  const project = s.get();
  const { banding } = project;
  const levels = Math.max(2, banding.levels);
  const resolved = ctx.engine.resolvedBanding();
  const count = levels - 1;

  // Thresholds come from the spacing rule, applied against the histogram as it
  // stands now — not from whatever the previous, differently sized stack held.
  const thresholds = banding.mode === 'tone'
    ? thresholdsFor(banding.spacing, ctx.engine.histogram(), levels)
    : [];

  const old = project.bands.filter(isCut);
  const keptHighlights = project.bands.find((b) => !isCut(b));
  const next: Band[] = [];
  for (let i = 0; i < count; i++) {
    const threshold = thresholds[i] ?? (i + 1) / levels;
    const source: RGB = banding.mode === 'colour'
      ? resolved.palette[i] ?? [0, 0, 0]
      : [1 - threshold, 1 - threshold, 1 - threshold];
    const prev = old[i];
    const fresh = defaultBand(`Level ${i + 1}`, source, threshold);
    next.push(prev
      ? { ...prev, name: prev.name, threshold, source, colour: source }
      : fresh);
  }
  s.replaceBands(next, Dirty.Band, 'bands:rebuild');
  ensureHighlights(ctx, keptHighlights);
  adoptLightestAsPaper(ctx);
  if (!next.some((b) => b.id === ctx.selectedBand())) ctx.selectBand(next[0]?.id ?? '');
}

/**
 * A cut-out's lightest tones, as a band.
 *
 * Without paper the lightest level is the paper, and on a photograph that is
 * right: the sheet shows there. On a cut-out it is wrong — the subject's
 * highlights are part of the subject, and leaving them out punches holes in it
 * wherever the light falls, the background showing through a white shirt. So
 * when the source has a matte the stack gets one more band, Highlights, which
 * takes everything inside the matte that no darker band has (a tone cut at 1,
 * or the lightest palette colour) and leaves only the true background clear.
 * It is an ordinary band — recolour it, hide it, delete it — and it comes back
 * only when the bands are rebuilt.
 */
export function ensureHighlights(ctx: Ctx, keep?: Band): void {
  const s = ctx.store;
  const project = s.get();
  const cutout = !!ctx.engine.sourceMatte();
  const has = project.bands.some((b) => !isCut(b));
  if (cutout === has) return;
  if (!cutout) {
    s.replaceBands(project.bands.filter(isCut), Dirty.Band, 'bands:highlights');
    return;
  }
  let colour: RGB;
  if (project.banding.mode === 'colour') {
    const palette = ctx.engine.resolvedBanding().palette;
    colour = palette[project.bands.length] ?? palette[palette.length - 1] ?? [0.95, 0.95, 0.95];
  } else {
    // One more step of the ramp the bands are already on.
    const n = project.bands.length;
    const a = project.bands[n - 1]?.colour ?? [0.6, 0.6, 0.6];
    const b = project.bands[n - 2]?.colour ?? [0.3, 0.3, 0.3];
    colour = a.map((v, i) => Math.min(0.97, Math.max(v, v + (v - b[i])))) as RGB;
  }
  const band: Band = keep
    ? { ...keep, threshold: 1 }
    : { ...defaultBand('Highlights', colour, 1), colour, source: colour };
  s.replaceBands([...project.bands, band], Dirty.Band, 'bands:highlights');
}

/**
 * Colour mode: the lightest quantised colour becomes the paper.
 *
 * It is the level the bands are printed on, exactly as in tone mode, and a
 * photograph quantised to six colours whose lightest is a warm cream should not
 * come out on a white ground with the cream missing entirely.
 */
function adoptLightestAsPaper(ctx: Ctx): void {
  const project = ctx.store.get();
  if (project.banding.mode !== 'colour') return;
  // No paper is a decision, not a missing colour. Someone who opened a cut-out
  // and switched to colour regions should not find the ground they were keeping
  // clear filled in with whatever the quantiser called lightest.
  if (project.canvas.paper === null) return;
  const palette = ctx.engine.resolvedBanding().palette;
  const lightest = palette[palette.length - 1];
  if (lightest) ctx.store.updateCanvas({ paper: lightest }, 'canvas:paper');
}

/** Colour mode: push the resolved palette onto the bands' own colours. */
export function takePaletteIntoBands(ctx: Ctx): void {
  const s = ctx.store;
  const { palette } = ctx.engine.resolvedBanding();
  if (!palette.length) return;
  const next = s.get().bands.map((b, i) => ({
    ...b,
    source: palette[i] ?? b.source,
    colour: palette[i] ?? b.colour,
  }));
  s.replaceBands(next, Dirty.Fill, 'bands:palette');
  adoptLightestAsPaper(ctx);
}

/**
 * One more band. In tone mode that is one more level, re-spaced by the rule in
 * force; in colour mode one more colour, solved around the pinned ones once the
 * trace it sets off has landed.
 */
export function addBand(ctx: Ctx): void {
  const s = ctx.store;
  const { banding } = s.get();
  if (banding.levels >= 16) {
    ctx.status('Sixteen levels is the most there can be', 'warn');
    return;
  }
  const levels = banding.levels + 1;
  if (banding.mode === 'tone') {
    s.updateBanding({ levels, spacing: banding.spacing === 'manual' ? 'balanced' : banding.spacing }, 'banding:levels');
    rebuildBands(ctx);
    return;
  }
  const keep = banding.palette.filter((_, i) => banding.locked[i]);
  s.updateBanding({ levels, palette: keep, locked: keep.map(() => true) }, 'banding:levels');
  ctx.afterTrace(() => { rebuildBands(ctx); takePaletteIntoBands(ctx); });
}

/**
 * A colour taken from the picture, as a band of its own.
 *
 * Colour mode: it joins the palette pinned, and the solver fits the others
 * round it. Tone mode: a new cut at the picked colour's tone, painted in that
 * colour, slotted into the stack where its tone puts it.
 */
export function addPickedColour(ctx: Ctx, rgb: RGB): void {
  const s = ctx.store;
  const project = s.get();
  const { banding } = project;
  if (banding.levels >= 16) {
    ctx.status('Sixteen levels is the most there can be', 'warn');
    return;
  }
  if (banding.mode === 'colour') {
    const keep = banding.palette.filter((_, i) => banding.locked[i]);
    const palette = [...keep, rgb].sort((a, b) => lumaOf(a) - lumaOf(b));
    s.updateBanding({ levels: banding.levels + 1, palette, locked: palette.map(() => true) }, 'banding:pick');
    ctx.afterTrace(() => {
      rebuildBands(ctx);
      takePaletteIntoBands(ctx);
      const added = s.get().bands.find((b) => rgbToHex(b.colour) === rgbToHex(rgb));
      if (added) ctx.selectBand(added.id);
    });
    ctx.status(`Added ${rgbToHex(rgb)} as a band`);
    return;
  }
  const threshold = Math.min(0.99, Math.max(0.01, lumaOf(rgb) + 0.02));
  const band = { ...defaultBand('Picked', rgb, threshold), colour: rgb };
  const bands = [...project.bands, band].sort((a, b) => a.threshold - b.threshold);
  s.updateBanding({ levels: bands.length + 1, spacing: 'manual', thresholds: bands.map((b) => b.threshold) }, 'banding:pick');
  s.replaceBands(bands, Dirty.Band, 'band:add');
  ctx.selectBand(band.id);
  ctx.status(`Added ${rgbToHex(rgb)} as a band at tone ${threshold.toFixed(2)}`);
}

/**
 * Thresholds for a spacing rule. `manual` keeps whatever equal-area would give,
 * because a stack that has just changed size has no manual positions to keep.
 */
export function thresholdsFor(
  spacing: Spacing,
  hist: Uint32Array,
  levels: number,
): number[] {
  return spacing === 'even' ? evenThresholds(levels)
    : spacing === 'equal-area' ? equalAreaThresholds(hist, levels)
      : balancedThresholds(hist, levels);
}

/** The bands that cut at a tone, as opposed to a cut-out's Highlights band. */
const isCut = (b: Band): boolean => b.threshold < 1;

/** Apply a spacing rule to the bands that exist now. */
export function respace(ctx: Ctx, rule?: Exclude<Spacing, 'manual'>): void {
  const s = ctx.store;
  const project = s.get();
  if (project.banding.mode !== 'tone' || project.bands.length === 0) return;

  const spacing = rule ?? (project.banding.spacing === 'manual' ? 'balanced' : project.banding.spacing);
  // The lightest level is the paper (or a cut-out's Highlights band, which
  // takes everything left), so N cutting bands means N + 1 levels.
  const cuts = project.bands.filter(isCut).length;
  const thresholds = thresholdsFor(spacing, ctx.engine.histogram(), cuts + 1);
  let k = 0;
  const bands = project.bands.map((b) => (isCut(b) ? { ...b, threshold: thresholds[k++] ?? b.threshold } : b));

  s.updateBanding({ spacing, thresholds }, 'banding:spacing');
  s.replaceBands(bands, Dirty.Band, 'bands:respace');
}

/**
 * True when the bands already sit where the rule would put them.
 *
 * Used to decide whether opening an image needs a respace at all, which keeps
 * the load from costing two traces when the first one already landed right.
 */
export function needsRespace(ctx: Ctx): boolean {
  const project = ctx.store.get();
  if (project.banding.mode !== 'tone' || project.banding.spacing === 'manual') return false;
  const cuts = project.bands.filter(isCut);
  const want = thresholdsFor(project.banding.spacing, ctx.engine.histogram(), cuts.length + 1);
  return cuts.some((b, i) => Math.abs(b.threshold - (want[i] ?? b.threshold)) > 0.004);
}
