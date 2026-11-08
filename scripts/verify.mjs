#!/usr/bin/env node
/**
 * End-to-end browser checks, against `npm run dev` on port 1421.
 *
 * Each check is tagged with the row of docs/STIPPLE-PARITY.md it holds, so the
 * list of what Contour took from Stipple is checked by the same method every
 * time rather than by looking. Unit tests cover the logic; this covers what only
 * a browser can show — layout, gestures, the toolbar, real exports.
 *
 *   npm run dev            # in one terminal
 *   npm run verify         # in another
 */
import { chromium, devices } from 'playwright';

const URL = process.env.CONTOUR_URL ?? 'http://localhost:1421/';
const results = [];
const check = (row, name, ok, detail = '') => {
  results.push({ row, name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  #${row}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const errors = [];
const page = async (opts, query = '') => {
  const p = await browser.newPage(opts);
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL + query);
  await p.waitForFunction(() => window.contour);
  return p;
};
const settle = (p) => p.waitForFunction(() => !window.contour.busy() && window.contour.scene(), null, { timeout: 30000 });

// -- desktop, empty ---------------------------------------------------------
{
  const p = await page({ viewport: { width: 1440, height: 900 } });
  await p.waitForTimeout(500);
  const s = await p.evaluate(() => ({
    hasSource: !!window.contour.store.get().source,
    dropZone: !document.querySelector('.drop-zone').hidden,
    testCardButton: [...document.querySelectorAll('button')].some((b) => /test card/i.test(b.textContent)),
    toolbar: [...document.querySelectorAll('.toolbar button, .toolbar select > option:first-child')]
      .filter((n) => n.offsetParent !== null || n.tagName === 'OPTION')
      .map((n) => n.textContent.trim()),
    primary: [...document.querySelectorAll('.btn.primary')].map((b) => b.textContent.trim()),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    stage: getComputedStyle(document.documentElement).getPropertyValue('--stage').trim(),
    radius: getComputedStyle(document.querySelector('.btn')).borderRadius,
    shadow: getComputedStyle(document.querySelector('.btn')).boxShadow,
    meta: {
      viewport: document.querySelector('meta[name=viewport]').content,
      theme: !!document.querySelector('meta[name=theme-color]'),
      icon: !!document.querySelector('link[rel=icon]'),
    },
    infoButtons: document.querySelectorAll('.panel .info-btn').length,
    helpShown: [...document.querySelectorAll('.help')].filter((h) => h.offsetParent !== null).length,
    presetMenu: [...document.querySelectorAll('.preset-select option')].map((o) => o.textContent),
  }));
  check(16, 'opens on an empty sheet with a drop zone', !s.hasSource && s.dropZone);
  check(16, 'no test card offered in the interface', !s.testCardButton);
  const want = ['Open image…', 'Fit', '100%', 'Drawing', 'Original', 'Split', 'Under', 'Undo', 'Redo',
    'Presets…', 'PNG', 'SVG', 'PDF', 'Plates', 'Save', 'Load'];
  const order = want.map((w) => s.toolbar.indexOf(w));
  check(10, 'toolbar in Stipple’s order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), s.toolbar.join(' | '));
  check(10, 'Open image is the one yellow button in the app', s.primary.length === 1 && s.primary[0] === 'Open image…', s.primary.join(', '));
  check(6, 'workshop green with a yellow accent', s.accent === '#f4c430' && s.stage === '#4d6655');
  check(6, 'square corners, no shadows', s.radius === '0px' && s.shadow === 'none');
  check(33, 'viewport-fit, theme colour and favicon', s.meta.viewport.includes('viewport-fit=cover') && s.meta.theme && s.meta.icon);
  check(24, '(i) buttons on panels, explanations hidden until asked', s.infoButtons >= 4 && s.helpShown === 0, `${s.infoButtons} buttons`);
  check(15, 'presets are a menu of named looks', s.presetMenu.length >= 8, s.presetMenu.slice(1).join(', '));
  await p.close();
}

// -- desktop, with a picture -------------------------------------------------
{
  const p = await page({ viewport: { width: 1440, height: 900 } }, '?testcard');
  await settle(p);

  // 14: views are never in a file.
  const exports = await p.evaluate(async () => {
    const out = {};
    for (const v of ['drawing', 'photo', 'split', 'under']) {
      window.contour.view(v);
      out[v] = window.contour.exportSVG();
    }
    window.contour.view('drawing');
    return out;
  });
  check(14, 'SVG identical across Drawing, Original, Split and Under',
    new Set(Object.values(exports)).size === 1 && exports.drawing.length > 1000);

  // 19: one canvas pixel is 1/dpi inch in every exporter.
  const sizes = await p.evaluate(async () => {
    const c = window.contour.store.get().canvas;
    const svg = window.contour.exportSVG();
    const pdf = new TextDecoder().decode(await window.contour.exportPDF());
    const png = await window.contour.exportPNG();
    const dv = new DataView(png.buffer, png.byteOffset);
    return {
      c,
      svgW: /width="([\d.]+)in"/.exec(svg)?.[1],
      mediaBox: /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)?.slice(1),
      png: [dv.getUint32(16), dv.getUint32(20)],
    };
  });
  const inches = sizes.c.width / sizes.c.dpi;
  check(19, 'SVG states its size in inches at the document resolution', Math.abs(Number(sizes.svgW) - inches) < 1e-3, `${sizes.svgW} in`);
  check(19, 'PDF MediaBox agrees', Math.abs(Number(sizes.mediaBox?.[0]) - inches * 72) < 0.05, `${sizes.mediaBox?.join(' x ')} pt`);
  check(19, 'PNG is the document’s pixel size', sizes.png[0] === sizes.c.width && sizes.png[1] === sizes.c.height, sizes.png.join(' x '));

  // 15: every preset applies and draws.
  const names = await p.evaluate(() => window.contour.presets);
  for (const name of names) {
    await p.evaluate((n) => window.contour.applyPreset(n), name);
    await p.waitForTimeout(250);
    await settle(p);
    await p.waitForTimeout(400);
    await settle(p);
    const r = await p.evaluate(() => {
      const bands = window.contour.store.get().bands;
      // The last row is the paper, which a picture drawn whole leaves at 0%.
      const shares = [...document.querySelectorAll('.band-list .band-meta')].map((m) => parseInt(m.textContent, 10));
      return { groups: window.contour.scene().groups.length, n: bands.length,
        colours: new Set(bands.map((b) => b.colour.join())).size, shares };
    });
    // Every band prints something, and no two share a colour (unless the
    // preset paints them all paper, as Contour lines does).
    const ok = r.groups === r.n && r.shares.every((s) => s > 0) && (r.colours === r.n || name === 'Contour lines');
    check(15, `preset "${name}" draws every band`, ok, `${r.groups} bands, shares ${r.shares.join('/')}%`);
  }

  // 17: lengths are fractions of the picture, so 2x keeps the drawing.
  await p.evaluate(() => window.contour.applyPreset('Engraving'));
  await p.waitForTimeout(250);
  await settle(p);
  const marks = () => window.contour.scene().groups.flatMap((g) => g.nodes).reduce((n, node) => n + (node.d.match(/M/g) ?? []).length, 0);
  const before = await p.evaluate(`(${marks})()`);
  await p.evaluate(() => {
    const c = window.contour.store.get().canvas;
    window.contour.store.updateCanvas({ width: c.width * 2, height: c.height * 2, dpi: c.dpi * 2 });
  });
  await p.waitForTimeout(250);
  await settle(p);
  const after = await p.evaluate(`(${marks})()`);
  const ratio = after / Math.max(1, before);
  check(17, 'doubling the document keeps the same hatching', ratio > 0.9 && ratio < 1.1, `${before} → ${after} lines`);
  const unitText = await p.evaluate(() => {
    window.contour.store.selectBand?.(window.contour.store.get().bands[0].id);
    return [...document.querySelectorAll('.ctrl.slider .ctrl-value')].map((i) => i.value).filter((v) => / mm$/.test(v)).length;
  });
  check(17, 'lengths are shown in mm', unitText > 0, `${unitText} fields in mm`);

  // 20: plates.
  const flat = await p.evaluate(() => window.contour.applyPreset('Three-tone poster'));
  await p.waitForTimeout(250);
  await settle(p);
  const plates = await p.evaluate(() => {
    const r = window.contour.plates();
    return { names: r.files.map((f) => f.name), skipped: r.skipped, paper: r.paper, groups: window.contour.scene().groups.length,
      firstFilm: r.files[0]?.data ?? '' };
  });
  check(20, 'one film per band plus a proof', flat && plates.names.length === plates.groups - plates.paper.length + 1 && plates.names.at(-1).endsWith('proof.svg'), plates.names.join(', '));
  check(20, 'the band in the paper’s colour prints as paper, no film', plates.paper.length === 1, plates.paper.join(', '));
  const film = plates.firstFilm;
  const colours = new Set([...film.matchAll(/fill="(#[0-9a-f]{3,6}|rgb\([^)]*\))"/gi)].map((m) => m[1].toLowerCase()));
  check(20, 'films are black on white only', [...colours].every((c) => /^(#000|#000000|#fff|#ffffff|rgb\(0, ?0, ?0\)|rgb\(255, ?255, ?255\))$/.test(c)), [...colours].join(' '));
  check(20, 'films carry registration marks', (film.match(/<circle/g) ?? []).length >= 4);
  await p.evaluate(() => window.contour.applyPreset('Soft gradients'));
  await p.waitForTimeout(250);
  await settle(p);
  const skipped = await p.evaluate(() => window.contour.plates().skipped.length);
  check(20, 'gradient bands are named and left out of the films', skipped > 0, `${skipped} left out`);

  // 21: band shares.
  const shares = await p.evaluate(() => [...document.querySelectorAll('.band-meta')].map((m) => m.textContent));
  check(21, 'each band shows its share of the sheet', shares.length > 0 && shares.every((s) => /^\d+%$/.test(s)), shares.join(' '));

  // Every level is a band: on black paper the lightest part of the picture is
  // still painted, and no paper shows anywhere in it.
  const whole = await p.evaluate(async () => {
    window.contour.store.updateCanvas({ paper: [0.07, 0.07, 0.08] });
    await new Promise((r) => setTimeout(r, 400));
    const s = window.contour.store.get();
    const rows = [...document.querySelectorAll('.band-list .band-row')].length;
    return { bands: s.bands.length, levels: s.banding.levels, rows, groups: window.contour.scene().groups.length,
      paper: document.querySelector('.paper-row .band-meta').textContent };
  });
  check(45, 'on black paper the lightest level is still painted', whole.groups === whole.bands && whole.paper === '0%', JSON.stringify(whole));
  await p.evaluate(() => window.contour.store.updateCanvas({ paper: [1, 1, 1] }));
  await settle(p);

  // Taking the background out: by colour here (no Vision in a browser), then a
  // polygon, then Restore.
  const btn = (label) => p.evaluate((l) => [...document.querySelectorAll('button')].find((b) => b.textContent === l).click(), label);
  const src = () => p.evaluate(() => { const s = window.contour.store.get().source; return { t: !!s.transparent, o: !!s.original, len: s.data.length }; });
  await btn('Remove background');
  await p.waitForTimeout(600);
  await settle(p);
  const removed = await src();
  check(46, 'Remove background makes the picture a cut-out and keeps the original', removed.t && removed.o, JSON.stringify(removed));
  await btn('Cut away inside');
  await btn('Draw polygon');
  const sb = await p.locator('.surface').boundingBox();
  for (const [fx, fy] of [[0.2, 0.2], [0.5, 0.2], [0.35, 0.45]]) await p.mouse.click(sb.x + sb.width * fx, sb.y + sb.height * fy);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(600);
  await settle(p);
  const cut = await src();
  check(46, 'a polygon cuts into the picture', cut.t && cut.len !== removed.len);
  await btn('Restore original');
  await p.waitForTimeout(600);
  await settle(p);
  const back = await src();
  check(46, 'Restore original puts the whole picture back', !back.o && !back.t, JSON.stringify(back));
  await p.evaluate(() => window.contour.store.updateCanvas({ paper: [1, 1, 1] }));
  await settle(p);

  // Several bands at once: select a run, edit them together, group, blend.
  await p.evaluate(() => window.contour.applyPreset('Three-tone poster'));
  await p.waitForTimeout(300);
  await settle(p);
  const rows = p.locator('.band-list .band-row:not(.group-row)');
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  const run = await p.evaluate(() => window.contour.ctx.selectedBands().length);
  check(47, 'Shift-click selects a run of bands', run === 3, `${run} selected`);
  await p.evaluate(() => [...document.querySelectorAll('.panel .seg')].find((b) => b.textContent === 'Hatch').click());
  await settle(p);
  const kinds = await p.evaluate(() => window.contour.store.get().bands.slice(0, 3).map((b) => b.fill.kind).join(','));
  check(47, 'switching the fill switches every selected band', kinds === 'hatch,hatch,hatch', kinds);
  await p.evaluate(() => {
    const s = window.contour.store; const b = s.get().bands;
    s.updateBand(b[1].id, { fill: { ...b[1].fill, angle: 10 } });
    s.updateBand(b[2].id, { fill: { ...b[2].fill, angle: 80 } });
  });
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await rows.nth(0).click({ modifiers: ['Meta'] });
  await rows.nth(0).click({ modifiers: ['Meta'] });
  const fan = await p.evaluate(() => {
    const ed = window.contour.ctx;
    const ids = ed.selectedBands();
    const primary = ed.selectedBand();
    const s = window.contour.store;
    // What the editor's spacing slider does, through the editor's own store.
    const before = s.get().bands.map((b) => b.fill.angle);
    document.querySelectorAll('.panel')[0];
    return { ids: ids.length, primaryIsFirst: primary === s.get().bands[0].id, before };
  });
  // Drive a real editor control: the first range in the Band panel's hatch box.
  const changed = await p.evaluate(async () => {
    const panel = [...document.querySelectorAll('.panel')].find((x) => x.querySelector('.panel-head')?.textContent.trim().startsWith('Band') && !x.querySelector('.band-list'));
    const ranges = [...panel.querySelectorAll('.ctrl')].filter((c) => /Spacing/.test(c.textContent) && c.offsetParent);
    const input = ranges[0]?.querySelector('input[type=range]');
    if (!input) return null;
    input.value = String(Number(input.max) * 0.5);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return window.contour.store.get().bands.slice(0, 3).map((b) => [b.fill.spacing.toFixed(4), b.fill.angle]);
  });
  const sameSpacing = changed && new Set(changed.map((c) => c[0])).size === 1;
  const ownAngles = changed && new Set(changed.map((c) => c[1])).size === 3;
  check(47, 'an edit reaches every selected band and leaves each its own other settings', sameSpacing && ownAngles, JSON.stringify(changed) + ' ' + JSON.stringify(fan));
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Blend colours').click());
  await settle(p);
  const blend = await p.evaluate(() => window.contour.store.get().bands.slice(0, 3).map((b) => b.colour.map((c) => c.toFixed(2)).join(',')));
  check(47, 'Blend colours ramps the selection', new Set(blend).size === 3, blend.join(' | '));
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Group').click());
  await p.waitForTimeout(300);
  await settle(p);
  const grouped = await p.evaluate(() => ({
    groups: window.contour.store.get().bands.map((b) => b.group ?? '-').join(','),
    header: !!document.querySelector('.group-row'),
    svg: (window.contour.scene() ? (document.querySelector('.svg-host').innerHTML.match(/id="group-Group-1"/) ?? []).length : 0),
  }));
  check(48, 'Group gathers the bands under a header and one SVG layer', grouped.header && grouped.groups.startsWith('Group 1,Group 1,Group 1') && grouped.svg === 1, JSON.stringify(grouped));
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Ungroup').click());
  await p.waitForTimeout(300);
  await settle(p);
  const ungrouped = await p.evaluate(() => window.contour.store.get().bands.every((b) => !b.group) && !document.querySelector('.group-row'));
  check(48, 'Ungroup takes them out again', ungrouped);

  // 23: the loading bar.
  const bar = await p.evaluate(async () => {
    window.contour.store.updateBanding({ levels: 6 });
    await new Promise((r) => setTimeout(r, 30));
    return document.querySelector('.progress').classList.contains('on');
  });
  check(23, 'a bar is up while tracing', bar);
  await settle(p);

  // Paper and colour layers, one click each.
  const clickSeg = (label) => p.evaluate((label) => {
    const seg = [...document.querySelectorAll('.paper-choices .seg')].find((b) => b.textContent === label && b.offsetParent);
    seg.click();
  }, label);
  await p.evaluate(() => { window.contour.store.updateBanding({ mode: 'tone', levels: 4 }); window.contour.ctx.rebuildBands(); });
  await settle(p);
  await clickSeg('None');
  await settle(p);
  const none = await p.evaluate(() => window.contour.store.get().canvas.paper === null);
  await clickSeg('White');
  await settle(p);
  await p.waitForTimeout(150);
  const white = await p.evaluate(() => JSON.stringify(window.contour.store.get().canvas.paper) === '[1,1,1]'
    && [...document.querySelectorAll('.paper-choices .seg.on')].every((b) => b.textContent === 'White'));
  const dbg = await p.evaluate(() => JSON.stringify(window.contour.store.get().canvas.paper) + ' on:' + [...document.querySelectorAll('.paper-choices .seg.on')].map((b) => b.textContent).join(','));
  check(40, 'None then White: back on white paper in one click', none && white, `${none} ${dbg}`);
  await clickSeg('Kraft');
  const svgPaper = await p.evaluate(() => !!document.querySelector('.surface svg rect[fill="#c7a880"], .surface svg rect[fill="rgb(199,168,128)"]') || window.contour.store.get().canvas.paper[0] < 0.8);
  check(40, 'a stock colour paints the paper', svgPaper);

  const addClick = (label) => p.evaluate((label) => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === label).click();
  }, label);
  await p.evaluate(() => window.contour.store.updateBanding({ mode: 'tone', levels: 4 }));
  await p.evaluate(() => window.contour.ctx.rebuildBands());
  await settle(p);
  const n0 = await p.evaluate(() => window.contour.store.get().bands.length);
  await addClick('+ Add band');
  await settle(p);
  const n1 = await p.evaluate(() => window.contour.store.get().bands.length);
  check(41, '+ Add band adds a tone band', n1 === n0 + 1, `${n0} → ${n1}`);

  await p.evaluate(() => { window.contour.store.updateBanding({ mode: 'colour', levels: 4, palette: [], locked: [] }); window.contour.ctx.rebuildBands(); });
  await settle(p);
  await p.waitForTimeout(300);
  await settle(p);
  const c0 = await p.evaluate(() => window.contour.store.get().bands.length);
  await addClick('+ Add band');
  await p.waitForTimeout(300);
  await settle(p);
  await p.waitForTimeout(300);
  const c1 = await p.evaluate(() => window.contour.store.get().bands.length);
  check(41, '+ Add band adds a colour band', c1 === c0 + 1, `${c0} → ${c1}`);

  // Pick a colour from the middle of the picture into its own band.
  await addClick('+ Add colour from picture');
  const box = await p.locator('.stage').boundingBox();
  await p.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await p.waitForTimeout(300);
  await settle(p);
  await p.waitForTimeout(300);
  const picked = await p.evaluate(() => ({ n: window.contour.store.get().bands.length, groups: window.contour.scene().groups.length }));
  // Interface colours from the mark, and the marbled ground.
  const gui = await p.evaluate(async () => {
    const root = () => getComputedStyle(document.documentElement);
    document.querySelector('.brand').click();
    const open = !document.querySelector('.gui-colours').hidden;
    const squares = document.querySelectorAll('.gui-square').length;
    const before = root().getPropertyValue('--panel').trim();
    document.querySelectorAll('.gui-square')[60].click();
    const fill = root().getPropertyValue('--panel').trim();
    const stage = root().getPropertyValue('--stage').trim();
    document.querySelectorAll('.gui-tabs .seg')[2].click();
    document.querySelectorAll('.gui-square')[11].click();
    const text = root().getPropertyValue('--text').trim();
    const saved = !!localStorage.getItem('contour.gui-colours');
    [...document.querySelectorAll('.gui-head .btn')].find((b) => b.textContent === 'Reset').click();
    const back = root().getPropertyValue('--panel').trim();
    const cleared = !localStorage.getItem('contour.gui-colours');
    const segs = [...document.querySelectorAll('.gui-ground .seg')];
    const stageEl = document.querySelector('.stage');
    const surface = document.querySelector('.surface');
    const bgOf = (label) => { segs.find((b) => b.textContent === label).click(); return getComputedStyle(stageEl).backgroundImage; };
    const squaresBg = bgOf('Squares');
    const squaresSaved = localStorage.getItem('contour.ground') === 'squares';
    const marbledBg = bgOf('Marbled');
    const gridBg = bgOf('Grid');
    const hadClass = surface.classList.contains('transparent');
    surface.classList.add('transparent');
    const sheet = getComputedStyle(surface);
    const clear = { bg: sheet.backgroundColor, outline: sheet.outlineStyle + ' ' + sheet.outlineWidth };
    surface.classList.toggle('transparent', hadClass);
    var ground = {
      squares: squaresSaved && squaresBg.includes('conic'), marbled: marbledBg.includes('url('),
      grid: gridBg.includes('linear-gradient') && !localStorage.getItem('contour.ground'), clear,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    return { ground, open, squares, before, fill, stage, text, saved, back, cleared,
      marble: root().getPropertyValue('--marble').startsWith('url(data:image/png') };
  });
  check(42, 'the mark opens interface colours with a grid of little squares', gui.open && gui.squares >= 100, `${gui.squares} squares`);
  check(42, 'a fill square recolours the panels and the stage follows', gui.fill !== gui.before && gui.stage.includes('color-mix'), gui.fill);
  check(42, 'a text square recolours the text, and is remembered', gui.text === '#000000' && gui.saved);
  check(42, 'Reset puts the workshop green back', gui.back === gui.before && gui.cleared, gui.back);
  check(43, 'Background: Grid, Squares and Marbled on the stage, remembered', gui.ground.grid && gui.ground.squares && gui.ground.marbled && gui.marble);
  check(43, 'no paper: the sheet is see-through with a thin edge line', gui.ground.clear.bg === 'rgba(0, 0, 0, 0)' && gui.ground.clear.outline === 'solid 1px', JSON.stringify(gui.ground.clear));

  // Dragging a 2D slider out across the page selects nothing; Spectrum picks.
  await p.click('.brand');
  await p.click('.gui-tabs .seg:nth-child(1)');
  await p.click('.gui-views .seg:nth-child(2)');
  const spec = await p.locator('.gui-spectrum').boundingBox();
  await p.mouse.move(spec.x + spec.width * 0.6, spec.y + spec.height * 0.5);
  await p.mouse.down();
  await p.mouse.move(spec.x + spec.width * 0.66, spec.y + spec.height * 0.25, { steps: 5 });
  await p.mouse.move(1300, 500, { steps: 8 });
  await p.mouse.move(spec.x + spec.width * 0.66, spec.y + spec.height * 0.25, { steps: 5 });
  await p.mouse.up();
  const sel = await p.evaluate(() => ({
    selected: String(window.getSelection()), panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
  }));
  check(44, 'dragging across the page selects no text', sel.selected === '', JSON.stringify(sel.selected.slice(0, 40)));
  check(44, 'the Spectrum swatch picks a colour', /^#[0-9a-f]{6}$/.test(sel.panel) && sel.panel !== '#a3b8a8', sel.panel);
  await p.evaluate(() => { [...document.querySelectorAll('.gui-head .btn')].find((b) => b.textContent === 'Reset').click(); localStorage.removeItem('contour.gui-view'); });
  await p.keyboard.press('Escape');

  check(41, 'a colour picked from the picture becomes a band', picked.n === c1 + 1 && picked.groups === picked.n, `${c1} → ${picked.n} bands, ${picked.groups} drawn`);
  await p.close();
}

// -- phone ------------------------------------------------------------------
{
  const p = await page(devices['iPhone 13'], '?testcard');
  await settle(p);
  const s = await p.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const bar = document.querySelector('.toolbar');
    return {
      stageAbove: r('.stage').bottom <= r('.sidebar').top + 1,
      oneRow: bar.scrollWidth > bar.clientWidth && r('.toolbar').height < 80,
      inputs: [...document.querySelectorAll('select, .ctrl-value')].filter((n) => n.offsetParent)
        .every((n) => parseFloat(getComputedStyle(n).fontSize) >= 16),
      exportMenu: getComputedStyle(document.querySelector('.export-select')).display !== 'none',
      lane: parseFloat(getComputedStyle(document.querySelector('.sidebar')).paddingRight) >= 20,
      rangesIgnoreFinger: getComputedStyle(document.querySelector('.range')).pointerEvents === 'none',
    };
  });
  check(25, 'upright phone: picture on top, controls underneath', s.stageAbove);
  check(25, 'toolbar is one row that scrolls sideways', s.oneRow);
  check(27, 'fields and menus at 16px, so iOS does not zoom', s.inputs);
  check(31, 'Export is one menu on a phone', s.exportMenu);
  check(30, 'a thumb lane down the panel’s right edge', s.lane);
  check(28, 'range inputs ignore the finger; the row drives them', s.rangesIgnoreFinger);

  // A vertical swipe over a slider scrolls and leaves its value alone.
  const target = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.ctrl.slider')].find((r) => r.offsetParent && r.getBoundingClientRect().top > 0);
    row.scrollIntoView({ block: 'center' });
    const rr = row.querySelector('.range').getBoundingClientRect();
    return { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2, value: row.querySelector('.range').value,
      label: row.querySelector('.ctrl-label').textContent };
  });
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(target.x), y: Math.round(target.y), yDistance: -160, speed: 600, gestureSourceType: 'touch' });
  const now = await p.evaluate((label) => [...document.querySelectorAll('.ctrl.slider')]
    .find((r) => r.querySelector('.ctrl-label').textContent === label).querySelector('.range').value, target.label);
  check(28, `a vertical swipe over "${target.label}" leaves it alone`, now === target.value, `${target.value} → ${now}`);
  await p.close();
}
{
  const p = await page(devices['iPhone 13 landscape'], '?testcard');
  await settle(p);
  const side = await p.evaluate(() => {
    const st = document.querySelector('.stage').getBoundingClientRect();
    const sb = document.querySelector('.sidebar').getBoundingClientRect();
    return st.right <= sb.left + 1 && Math.abs(st.top - sb.top) < 2;
  });
  check(26, 'phone on its side: side by side again', side);
  await p.close();
}

check(0, 'no page errors', errors.length === 0, errors.slice(0, 3).join(' / '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks pass`);
process.exit(failed.length ? 1 : 0);
