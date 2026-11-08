import { hexToRgb, lumaOf, rgbToHex } from '../core/color';
import { nearestPaletteIndex } from '../band/quantize';
import { Dirty } from '../core/store';
import { defaultAdjust, identityCurves } from '../core/defaults';
import type { BandMode, Tracer, TurnPolicy, VtraceParams } from '../core/types';
import {
  button, buttonRow, colourField, el, field, help, numberInput, Panel,
  segmented, select, slider, toggle,
} from './controls';
import { curveEditor, thresholdStrip } from './curves';
import type { Ctx } from './context';

/**
 * The sidebar, top to bottom, in the order the pipeline runs.
 *
 * Panels are laid out to match the chain — document, image, regions, trace,
 * bands — so where a control sits is a reliable guide to what it will cost. The
 * two above Trace re-run everything; the ones below it only redraw.
 */

/** A length in canvas pixels, said in the units a printer would use. */
const physical = (px: number, dpi: number): string => {
  const inches = px / Math.max(1, dpi);
  const mm = inches * 25.4;
  return mm < 10 ? `${mm.toFixed(2)} mm` : `${mm.toFixed(1)} mm (${inches.toFixed(2)} in)`;
};

/**
 * Size, resolution and paper.
 *
 * Each edge is shown twice, in canvas pixels and in print length, because they
 * answer different questions: pixels are how detailed the file is, millimetres
 * how big the print is, and resolution is the exchange rate between them. So
 * changing resolution keeps the print size and moves the pixel count, the way an
 * image editor resamples. Every band length is a fraction of the picture, so a
 * bigger document is a true upscale — the same drawing, each line and dot
 * drawn with more pixels — and 2x / 1/2x do that in one press.
 */
export function documentPanel(ctx: Ctx): Panel {
  const p = new Panel('Document', {
    info: 'Pixels are how detailed the file is, millimetres how big it prints, and resolution ' +
      'is the exchange rate between them. Changing resolution keeps the print size. Every ' +
      'length in a band is a share of the picture, so resizing keeps the drawing the same.',
  });
  const s = ctx.store;
  let locked = true;
  const c = () => s.get().canvas;
  const physicalUnit = (): 'mm' | 'in' => (c().units === 'in' ? 'in' : 'mm');
  const toLen = (px: number): number =>
    physicalUnit() === 'in' ? px / c().dpi : (px / c().dpi) * 25.4;
  const fromLen = (len: number): number =>
    physicalUnit() === 'in' ? len * c().dpi : (len / 25.4) * c().dpi;
  const clampPx = (v: number): number => Math.round(Math.min(12000, Math.max(16, v)));

  const resize = (edge: 'width' | 'height', px: number): void => {
    const cur = c();
    const next = clampPx(px);
    if (!locked) {
      s.updateCanvas({ [edge]: next }, 'canvas:size');
      return;
    }
    const k = next / cur[edge];
    s.updateCanvas({ width: clampPx(cur.width * k), height: clampPx(cur.height * k) }, 'canvas:size');
  };

  const edgeRow = (label: string, edge: 'width' | 'height'): HTMLElement => {
    const row = el('div', 'ctrl size-row');
    const name = el('label', 'ctrl-label');
    name.textContent = label;
    const pxIn = el('input', 'ctrl-value');
    pxIn.type = 'text';
    const pxUnit = el('span', 'unit');
    pxUnit.textContent = 'px';
    const lenIn = el('input', 'ctrl-value');
    lenIn.type = 'text';
    const lenUnit = el('span', 'unit');
    const read = (input: HTMLInputElement): number => Number.parseFloat(input.value.replace(',', '.'));
    const commit = (input: HTMLInputElement, toPx: (v: number) => number): void => {
      const v = read(input);
      if (Number.isFinite(v) && v > 0) resize(edge, toPx(v));
      sync();
    };
    for (const [input, toPx] of [[pxIn, (v: number) => v], [lenIn, fromLen]] as const) {
      input.addEventListener('change', () => commit(input, toPx));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(input, toPx); input.blur(); }
      });
    }
    const sync = (): void => {
      const px = c()[edge];
      if (document.activeElement !== pxIn) pxIn.value = String(px);
      if (document.activeElement !== lenIn) lenIn.value = toLen(px).toFixed(physicalUnit() === 'in' ? 2 : 1);
      lenUnit.textContent = physicalUnit();
    };
    p.onSync(sync);
    row.append(name, pxIn, pxUnit, lenIn, lenUnit);
    return row;
  };
  p.add(edgeRow('Width', 'width'), edgeRow('Height', 'height'));

  p.add(toggle(p, {
    label: 'Keep proportions',
    get: () => locked,
    set: (v) => { locked = v; p.sync(); },
  }));

  p.add(field('Resolution (ppi)', numberInput(p, {
    get: () => c().dpi,
    // Keep the print size: more pixels per inch is a finer file on the same sheet.
    set: (v) => {
      const dpi = Math.max(1, Math.round(v));
      const k = dpi / c().dpi;
      s.updateCanvas({ dpi, width: clampPx(c().width * k), height: clampPx(c().height * k) }, 'canvas:dpi');
    },
    min: 1, step: 1,
  })));

  const scaleBy = (k: number): void => {
    const cur = c();
    s.updateCanvas({
      width: clampPx(cur.width * k), height: clampPx(cur.height * k), dpi: Math.max(1, Math.round(cur.dpi * k)),
    }, 'canvas:scale');
  };
  p.add(buttonRow(
    button('\u00bd\u00d7', () => scaleBy(0.5), { title: 'The same print with half the pixels' }),
    button('2\u00d7', () => scaleBy(2), { title: 'The same print with twice the pixels \u2014 the upscale for a small source' }),
    button('Match image', () => {
      const src = s.get().source;
      if (!src) return;
      // Keep the long edge and take the aspect from the photograph, so framing
      // decided in the camera survives into the document.
      const cur = c();
      const longEdge = Math.max(cur.width, cur.height);
      const scale = longEdge / Math.max(src.width, src.height);
      s.updateCanvas({ width: Math.round(src.width * scale), height: Math.round(src.height * scale) });
    }, { title: 'Set the canvas aspect ratio from the source image' }),
  ));

  p.add(segmented(p, {
    label: 'Show lengths in',
    options: [
      { value: 'mm', label: 'mm' }, { value: 'in', label: 'in' },
      { value: '%', label: '%', title: 'Per cent of the short edge' }, { value: 'px', label: 'px' },
    ],
    get: () => c().units,
    set: (v) => s.setUnits(v),
  }));

  p.add(colourField(p, {
    label: 'Paper',
    get: () => s.get().canvas.paper ?? [1, 1, 1],
    set: (v) => s.updateCanvas({ paper: v }),
    nullable: {
      label: 'Transparent',
      get: () => s.get().canvas.paper === null,
      set: (v) => s.updateCanvas({ paper: v ? null : [1, 1, 1] }),
    },
  }));

  return p;
}

export function imagePanel(ctx: Ctx): Panel {
  const p = new Panel('Image');
  const s = ctx.store;
  const a = () => s.get().adjust;

  const name = el('p', 'source-name');
  p.add(name);
  p.onSync(() => {
    const src = s.get().source;
    name.textContent = src ? `${src.name} · ${src.width} x ${src.height}` : 'No image';
  });

  p.add(buttonRow(
    // Plain, not yellow: the toolbar's Open image is the one call to action.
    // The test card is not offered here at all; it lives behind ?testcard.
    button('Open another image…', () => void ctx.openImage()),
  ));

  p.add(slider(p, {
    label: 'Exposure', min: -3, max: 3, step: 0.01, unit: ' EV',
    get: () => a().exposure,
    set: (v) => s.updateAdjust({ exposure: v }, 'adjust:exposure'),
  }));
  p.add(slider(p, {
    label: 'Brightness', min: -0.5, max: 0.5, step: 0.005,
    get: () => a().brightness,
    set: (v) => s.updateAdjust({ brightness: v }, 'adjust:brightness'),
  }));
  p.add(slider(p, {
    label: 'Contrast', min: -1, max: 2, step: 0.01,
    get: () => a().contrast,
    set: (v) => s.updateAdjust({ contrast: v }, 'adjust:contrast'),
  }));
  p.add(slider(p, {
    label: 'Saturation', min: 0, max: 2, step: 0.01,
    get: () => a().saturation,
    set: (v) => s.updateAdjust({ saturation: v }, 'adjust:saturation'),
    hint: () => (a().saturation === 0 ? 'Grey — colour banding will have nothing to find' : ''),
  }));
  p.add(slider(p, {
    label: 'Hue', min: -180, max: 180, step: 1, unit: '°',
    get: () => a().hue,
    set: (v) => s.updateAdjust({ hue: v }, 'adjust:hue'),
  }));

  const levels = el('div', 'subgroup');
  const lab = el('h4');
  lab.textContent = 'Levels';
  levels.append(lab);
  p.body.append(levels);
  const intoLevels = (node: HTMLElement) => levels.append(node);

  intoLevels(slider(p, {
    label: 'Black point', min: 0, max: 1, step: 0.002,
    get: () => a().levels.inBlack,
    set: (v) => s.updateAdjustField('levels', { inBlack: Math.min(v, a().levels.inWhite - 0.01) }, 'levels:in'),
  }));
  intoLevels(slider(p, {
    label: 'White point', min: 0, max: 1, step: 0.002,
    get: () => a().levels.inWhite,
    set: (v) => s.updateAdjustField('levels', { inWhite: Math.max(v, a().levels.inBlack + 0.01) }, 'levels:in'),
  }));
  intoLevels(slider(p, {
    label: 'Gamma', min: 0.1, max: 4, step: 0.01,
    get: () => a().levels.gamma,
    set: (v) => s.updateAdjustField('levels', { gamma: v }, 'levels:gamma'),
  }));
  intoLevels(slider(p, {
    label: 'Output black', min: 0, max: 1, step: 0.002,
    get: () => a().levels.outBlack,
    set: (v) => s.updateAdjustField('levels', { outBlack: v }, 'levels:out'),
  }));
  intoLevels(slider(p, {
    label: 'Output white', min: 0, max: 1, step: 0.002,
    get: () => a().levels.outWhite,
    set: (v) => s.updateAdjustField('levels', { outWhite: v }, 'levels:out'),
  }));

  const curves = el('div', 'subgroup');
  const clab = el('h4');
  clab.textContent = 'Curves';
  curves.append(clab, curveEditor(p, {
    get: (channel) => s.get().adjust.curves[channel],
    set: (channel, points, historyKey) =>
      s.updateAdjustField('curves', { [channel]: points }, historyKey ?? `curves:${channel}`),
    histogram: () => ctx.engine.histogram(),
    // The same fields the Levels sliders above write. Two views of one set of
    // numbers, not two settings that have to be kept in step.
    levels: {
      get: () => s.get().adjust.levels,
      set: (patch, historyKey) => s.updateAdjustField('levels', patch, historyKey),
    },
  }));
  curves.append(help(
    'The dashed line is levels and this curve together — what the image ' +
    'actually gets. The rail underneath carries the black point, the midtone ' +
    'and the white point, and dragging one of them is the same edit as moving ' +
    'the matching slider above.',
  ));
  p.body.append(curves);

  const shape = el('div', 'subgroup');
  const slab = el('h4');
  slab.textContent = 'Before tracing';
  shape.append(slab);
  p.body.append(shape);

  shape.append(help(
    'Blur is the most important control here. potrace traces exactly what it is ' +
    'given, so film grain and sensor noise become thousands of extra contour ' +
    'points. Soften first and the shapes come out drawn rather than photocopied.',
  ));
  shape.append(slider(p, {
    label: 'Blur', min: 0, max: 24, step: 0.1, unit: ' px',
    get: () => a().blur,
    set: (v) => s.updateAdjust({ blur: v }, 'adjust:blur'),
  }));
  shape.append(slider(p, {
    label: 'Denoise', min: 0, max: 4, step: 1,
    get: () => a().denoise,
    set: (v) => s.updateAdjust({ denoise: Math.round(v) }, 'adjust:denoise'),
    format: (v) => (v === 0 ? 'off' : `${v} pass${v === 1 ? '' : 'es'}`),
    hint: () => 'Median filter — removes speckle without softening edges',
  }));
  shape.append(slider(p, {
    label: 'Sharpen', min: 0, max: 3, step: 0.01,
    get: () => a().sharpen,
    set: (v) => s.updateAdjust({ sharpen: v }, 'adjust:sharpen'),
  }));
  shape.append(toggle(p, {
    label: 'Invert',
    get: () => a().invert,
    set: (v) => s.updateAdjust({ invert: v }),
  }));

  p.add(buttonRow(button('Reset image adjustments', () => {
    s.updateAdjust({ ...defaultAdjust(), curves: identityCurves() }, 'adjust:reset');
  })));

  return p;
}

export function regionsPanel(ctx: Ctx): Panel {
  const p = new Panel('Regions');
  const s = ctx.store;
  const b = () => s.get().banding;

  p.add(segmented(p, {
    label: 'Cut by',
    options: [
      { value: 'tone', label: 'Tone', title: 'Posterise luminance into levels' },
      { value: 'colour', label: 'Colour', title: 'Quantise into flat colour regions' },
    ],
    get: () => b().mode as BandMode,
    set: (v) => {
      s.updateBanding({ mode: v });
      ctx.rebuildBands();
    },
  }));

  p.add(slider(p, {
    label: 'Levels', min: 2, max: 16, step: 1,
    get: () => b().levels,
    set: (v) => {
      const levels = Math.round(v);
      if (levels === b().levels) return;
      s.updateBanding({ levels }, 'banding:levels');
      ctx.rebuildBands();
    },
    hint: () => `${Math.max(1, b().levels - 1)} band${b().levels === 2 ? '' : 's'} of ink on paper`,
  }));

  p.add(help(
    'The lightest level is the paper, not a band — so four levels is three ' +
    'inks printed on a ground, which is the same arithmetic a screen printer does.',
  ));

  const toneBox = el('div', 'subgroup');
  toneBox.append(segmented(p, {
    label: 'Threshold spacing',
    options: [
      { value: 'equal-area', label: 'Equal area' },
      { value: 'even', label: 'Even' },
      { value: 'manual', label: 'Manual' },
    ],
    get: () => b().spacing,
    set: (v) => {
      // Picking a rule applies it once, here and now. Manual is simply the
      // state you are left in after dragging a divider, so choosing it changes
      // nothing about the thresholds — only the label on them.
      if (v === 'manual') s.updateBanding({ spacing: v });
      else ctx.respace(v);
    },
  }));
  toneBox.append(thresholdStrip(p, {
    get: () => ctx.engine.resolvedBanding().thresholds,
    set: (thresholds) => {
      const bands = s.get().bands.map((band, i) => ({
        ...band,
        threshold: thresholds[i] ?? band.threshold,
      }));
      s.updateBanding({ spacing: 'manual', thresholds }, 'banding:thresholds');
      s.replaceBands(bands, Dirty.Band, 'bands:thresholds');
    },
    histogram: () => ctx.engine.histogram(),
    colours: () => {
      const bands = s.get().bands;
      // Bands are ordered dark to light and the strip runs the same way; the
      // paper colour closes it off at the light end.
      const cols = bands.map((band) => rgbToHex(band.colour));
      cols.push(rgbToHex(s.get().canvas.paper ?? [1, 1, 1]));
      return cols;
    },
    enabled: () => true,
  }));
  p.body.append(toneBox);

  const colourBox = el('div', 'subgroup');
  const clab = el('h4');
  clab.textContent = 'Palette';
  const swatches = el('div', 'palette');
  colourBox.append(clab, swatches, help(
    'Each swatch is a colour you can set. Change one and it is pinned: the ' +
    'solver has to work around it, so you can fix the two that matter — a skin ' +
    'tone, a background — and let it rearrange the rest. The padlock pins a ' +
    'colour you have not changed; clicking it again lets the solver move it.',
  ));
  colourBox.append(buttonRow(
    button('Requantise', () => {
      // Drops the palette *and* the locks: this is the "start again" button,
      // and leaving the locks behind made it look broken on a fully pinned
      // palette, where every centre was fixed and nothing could move.
      s.updateBanding({ palette: [], locked: [] }, 'banding:requantise');
    }, { title: 'Solve the palette again from scratch, discarding every pin' }),
    button('Re-solve the rest', () => {
      // Keeps the pins, drops everything else.
      const stored = s.get().banding;
      const keep = stored.palette.filter((_, i) => stored.locked[i]);
      s.updateBanding(
        { palette: keep, locked: keep.map(() => true) },
        'banding:resolve',
      );
    }, { title: 'Keep the pinned colours and let the solver redo the others' }),
  ));
  colourBox.append(buttonRow(
    button('Pick a colour from the picture', () => ctx.pickColour((rgb) => {
      // The pick takes the place of the nearest colour the solver owns, and is
      // pinned, so Re-solve the rest works around it — the same as an ink
      // picked in Stipple surviving a re-sample.
      const palette = ctx.engine.resolvedBanding().palette;
      const stored = s.get().banding;
      const lockedColours = stored.palette.filter((_, i) => stored.locked[i]);
      const locks = palette.map(() => false);
      for (const c of lockedColours) if (palette.length) locks[nearestPaletteIndex(palette, c)] = true;
      const free = palette.map((c, i) => ({ c, i })).filter((e) => !locks[e.i]);
      if (!free.length) {
        ctx.status('Every colour is pinned \u2014 unpin one to make room for the pick', 'warn');
        return;
      }
      const at = free[nearestPaletteIndex(free.map((e) => e.c), rgb)].i;
      const next = palette.map((c, i) => (i === at ? rgb : c));
      locks[at] = true;
      const sorted = next.map((colour, j) => ({ colour, lock: locks[j] }))
        .sort((x, y) => lumaOf(x.colour) - lumaOf(y.colour));
      s.updateBanding({ palette: sorted.map((e) => e.colour), locked: sorted.map((e) => e.lock) }, 'banding:pick');
      ctx.status(`Picked ${rgbToHex(rgb)} and pinned it`);
    }), { title: 'Click the picture to take a colour from it' }),
  ));
  colourBox.append(buttonRow(
    button('Take colours into bands', () => ctx.takePaletteIntoBands()),
  ));
  p.body.append(colourBox);

  p.onSync(() => {
    const tone = b().mode === 'tone';
    toneBox.style.display = tone ? '' : 'none';
    colourBox.style.display = tone ? 'none' : '';
    if (tone) return;

    const palette = ctx.engine.resolvedBanding().palette;
    // Locks follow the colour, not the slot.
    //
    // The solver returns its palette sorted light to dark, so an entry's
    // position changes every time it is requantised — and a lock stored as a
    // flag beside a position ends up decorating whichever colour happens to
    // have landed there. Re-deriving it by finding each locked colour in the
    // palette it came back in keeps the padlock on the swatch the user pinned.
    const stored = b();
    const lockedColours = stored.palette.filter((_, i) => stored.locked[i]);
    const isLocked = palette.map(() => false);
    for (const c of lockedColours) {
      if (palette.length) isLocked[nearestPaletteIndex(palette, c)] = true;
    }

    swatches.replaceChildren();
    palette.forEach((c, i) => {
      const cell = el('div', 'pal-cell');
      if (isLocked[i]) cell.classList.add('locked');

      // A real colour input over the swatch. A palette you can only pin is a
      // palette the solver owns; being able to say "this one is exactly this
      // ochre" is the whole difference between posterising a photograph and
      // drawing with it.
      const sw = el('input', 'pal-swatch');
      sw.type = 'color';
      sw.value = rgbToHex(c);
      sw.title = `${rgbToHex(c)} — click to choose this colour`;
      sw.addEventListener('input', () => {
        // Setting a colour pins it. Anything else and the next requantise would
        // throw the choice away, which reads as the picker not working.
        const next = palette.map((p, j) => (j === i ? hexToRgb(sw.value) : p));
        const locks = isLocked.map((v, j) => (j === i ? true : v));
        const sorted = next
          .map((colour, j) => ({ colour, lock: locks[j] }))
          .sort((x, y) => lumaOf(x.colour) - lumaOf(y.colour));
        s.updateBanding(
          { palette: sorted.map((e) => e.colour), locked: sorted.map((e) => e.lock) },
          'banding:pick',
        );
      });

      const lock = el('button', 'pal-lock');
      lock.type = 'button';
      lock.textContent = isLocked[i] ? '◉' : '○';
      lock.title = isLocked[i] ? 'Let the solver move this colour' : 'Pin this colour';
      lock.addEventListener('click', () => {
        const next = isLocked.map((v, j) => (j === i ? !v : v));
        s.updateBanding({ palette: [...palette], locked: next }, 'banding:lock');
      });

      cell.append(sw, lock);
      swatches.append(cell);
    });
  });

  // -- transparency
  //
  // Shown only when the source actually has a matte. On a photograph there is
  // nothing here to decide, and a control that never does anything is worse
  // than no control at all.
  const matteBox = el('div', 'subgroup');
  const mlab = el('h4');
  mlab.textContent = 'Transparency';
  matteBox.append(mlab, help(
    'This image came in with a matte, so it is being treated as a cut-out: ' +
    'nothing is drawn where the source is transparent, and the empty ground is ' +
    'left out of the histogram so the thresholds are chosen from the subject ' +
    'alone. Set the paper to Transparent in Document to export it as an asset.',
  ));
  matteBox.append(slider(p, {
    label: 'Matte cut', min: 0, max: 1, step: 0.01,
    get: () => b().alphaCut,
    set: (v) => s.updateBanding({ alphaCut: v }, 'banding:alpha'),
    hint: () => 'Source alpha below this is not part of the drawing at all',
  }));
  matteBox.append(buttonRow(
    button('Transparent paper', () => s.updateCanvas({ paper: null }, 'canvas:paper'),
      { title: 'Export with nothing behind the drawing' }),
  ));
  p.body.append(matteBox);
  p.onSync(() => {
    matteBox.style.display = ctx.engine.sourceMatte() ? '' : 'none';
  });

  p.add(toggle(p, {
    label: 'Nest regions',
    get: () => b().nested,
    set: (v) => s.updateBanding({ nested: v }),
    hint: 'Each band includes everything darker, so bands overlap instead of abutting',
  }));
  p.add(help(
    'Nesting removes the hairline gaps you otherwise get along every shared ' +
    'edge, because two curves fitted to the same boundary from opposite sides ' +
    'never agree exactly. Turn it off to get regions you can pull apart in an editor.',
  ));

  p.add(slider(p, {
    label: 'Trace detail', min: 400, max: 3000, step: 50, unit: ' px',
    get: () => b().resolution,
    set: (v) => s.updateBanding({ resolution: Math.round(v) }, 'banding:res'),
    hint: () => {
      const size = ctx.engine.workingSize();
      return `working at ${size.width} x ${size.height}`;
    },
  }));
  p.add(help(
    'Not a quality setting so much as a character one. Tracing a 6000 pixel ' +
    'photograph follows sensor noise around; between 1200 and 2000 is where ' +
    'contours start to read as drawn lines. Blur, denoise and mask shaping are ' +
    'all measured in these pixels.',
  ));

  return p;
}

export function tracePanel(ctx: Ctx): Panel {
  const p = new Panel('Trace');
  const s = ctx.store;
  const t = () => s.get().trace;
  const v = () => s.get().vtrace;
  const engine = (): Tracer => s.get().tracer;
  const patchV = (patch: Partial<VtraceParams>, key?: string) =>
    s.updateVtrace(patch, key);

  p.add(segmented(p, {
    label: 'Tracer',
    options: [
      { value: 'potrace', label: 'potrace', title: 'Long, confident curves. Needs to be installed.' },
      { value: 'vtracer', label: 'vtracer', title: 'Built in. Holds small detail, and can cut straight edges.' },
    ],
    get: engine,
    set: (value) => s.updateTracer(value),
  }));

  const status = el('p', 'tool-status');
  p.add(status);
  p.onSync(() => {
    const tools = ctx.engine.toolStatus();
    if (engine() === 'vtracer') {
      status.className = 'tool-status ok';
      status.textContent = tools.vtracer?.version ?? 'vtracer (built in)';
      status.title = 'Compiled into the app — nothing to install';
    } else if (tools.potrace) {
      status.className = 'tool-status ok';
      status.textContent = `${tools.potrace.version}`;
      status.title = tools.potrace.path;
    } else {
      status.className = 'tool-status warn';
      status.textContent = 'potrace not found — switch to vtracer, or brew install potrace';
      status.title = 'Install it with: brew install potrace';
    }
  });

  p.add(help(
    'Both tracers read exactly the same masks, so switching between them changes ' +
    'the curve fitting and nothing else. potrace fits long, confident curves and ' +
    'suits an organic subject; vtracer holds small detail that potrace\u2019s corner ' +
    'threshold smooths away, and its polygon mode gives the flat, cut-paper edges ' +
    'that flat-vector illustration often wants.',
  ));

  // -- vtracer
  const vbox = el('div', 'subgroup');
  vbox.append(segmented(p, {
    label: 'Edges',
    options: [
      { value: 'spline', label: 'Curves' },
      { value: 'polygon', label: 'Straight' },
      { value: 'pixel', label: 'Pixels' },
    ],
    get: () => v().mode,
    set: (mode) => patchV({ mode }),
  }));
  vbox.append(help(
    'Straight keeps every fitted segment a line — the cut-paper look — and ' +
    'Pixels keeps the mask\u2019s own staircase, which is occasionally what a ' +
    'low-resolution trace wants.',
  ));
  vbox.append(slider(p, {
    label: 'Speckle', min: 0, max: 100, step: 1, unit: ' px²',
    get: () => v().speckle,
    set: (value) => patchV({ speckle: Math.round(value) }, 'vtrace:speckle'),
    hint: () => 'Drops any shape or hole smaller than this, the same as potrace\u2019s -t',
  }));
  vbox.append(slider(p, {
    label: 'Corner threshold', min: 0, max: 180, step: 1, unit: '°',
    get: () => v().cornerThreshold,
    set: (value) => patchV({ cornerThreshold: Math.round(value) }, 'vtrace:corner'),
    hint: () => 'A turn sharper than this stays a corner. Low keeps everything round.',
    disabled: () => v().mode !== 'spline',
  }));
  vbox.append(slider(p, {
    label: 'Segment length', min: 3.5, max: 10, step: 0.1, unit: ' px',
    get: () => v().lengthThreshold,
    set: (value) => patchV({ lengthThreshold: value }, 'vtrace:length'),
    hint: () => 'The shortest run of pixels the fitter will treat as a segment',
    disabled: () => v().mode !== 'spline',
  }));
  vbox.append(slider(p, {
    label: 'Splice threshold', min: 0, max: 180, step: 1, unit: '°',
    get: () => v().spliceThreshold,
    set: (value) => patchV({ spliceThreshold: Math.round(value) }, 'vtrace:splice'),
    hint: () => 'How far apart two curves may point and still be joined into one',
    disabled: () => v().mode !== 'spline',
  }));
  vbox.append(slider(p, {
    label: 'Precision', min: 1, max: 8, step: 1,
    get: () => v().precision,
    set: (value) => patchV({ precision: Math.round(value) }, 'vtrace:precision'),
    hint: () => `coordinates to ${Math.round(v().precision)} decimal place${v().precision === 1 ? '' : 's'}`,
  }));
  p.body.append(vbox);

  // -- potrace
  const pbox = el('div', 'subgroup');
  p.onSync(() => {
    const vt = engine() === 'vtracer';
    vbox.style.display = vt ? '' : 'none';
    pbox.style.display = vt ? 'none' : '';
  });
  const intoPotrace = (node: HTMLElement) => pbox.append(node);
  p.body.append(pbox);

  intoPotrace(slider(p, {
    label: 'Speckle', min: 0, max: 100, step: 1, unit: ' px²',
    get: () => t().turdsize,
    set: (v) => s.updateTrace({ turdsize: Math.round(v) }, 'trace:turdsize'),
    hint: () => 'potrace -t · drops any shape or hole smaller than this',
  }));
  intoPotrace(slider(p, {
    label: 'Corner threshold', min: 0, max: 1.334, step: 0.001,
    get: () => t().alphamax,
    set: (v) => s.updateTrace({ alphamax: v }, 'trace:alphamax'),
    hint: () => {
      const v = t().alphamax;
      if (v <= 0.01) return 'potrace -a · every vertex stays a corner';
      if (v >= 1.33) return 'potrace -a · nothing stays a corner';
      return 'potrace -a · 0 is all corners, 1.334 is all curve';
    },
  }));
  intoPotrace(slider(p, {
    label: 'Optimisation', min: 0.01, max: 2, step: 0.01,
    get: () => t().opttolerance,
    set: (v) => s.updateTrace({ opttolerance: v }, 'trace:opt'),
    hint: () => 'potrace -O · how far a fitted curve may stray before it is split',
  }));
  intoPotrace(select(p, {
    label: 'Turn policy',
    options: ([
      'minority', 'majority', 'black', 'white', 'left', 'right', 'random',
    ] as TurnPolicy[]).map((v) => ({ value: v, label: v })),
    get: () => t().turnpolicy,
    set: (v) => s.updateTrace({ turnpolicy: v }),
  }));
  intoPotrace(help('How an ambiguous diagonal crossing is resolved. Minority is potrace\'s own default and rarely wants changing.'));

  intoPotrace(slider(p, {
    label: 'Precision', min: 1, max: 100, step: 1,
    get: () => t().unit,
    set: (v) => s.updateTrace({ unit: Math.round(v) }, 'trace:unit'),
    hint: () => `potrace -u · coordinates quantised to 1/${Math.round(t().unit)} px`,
  }));
  intoPotrace(toggle(p, {
    label: 'Polygon only',
    get: () => t().longcurve,
    set: (v) => s.updateTrace({ longcurve: v }),
    hint: 'potrace -n · skip curve optimisation, keeping the raw fitted Béziers',
  }));

  return p;
}

/** Everything the presets row offers, as whole-document patches. */

export { physical };
