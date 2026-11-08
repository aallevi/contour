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
      const shares = [...document.querySelectorAll('.band-meta')].map((m) => parseInt(m.textContent, 10));
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
    return { names: r.files.map((f) => f.name), skipped: r.skipped, groups: window.contour.scene().groups.length,
      firstFilm: r.files[0]?.data ?? '' };
  });
  check(20, 'one film per band plus a proof', flat && plates.names.length === plates.groups + 1 && plates.names.at(-1).endsWith('proof.svg'), plates.names.join(', '));
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

  // 23: the loading bar.
  const bar = await p.evaluate(async () => {
    window.contour.store.updateBanding({ levels: 6 });
    await new Promise((r) => setTimeout(r, 30));
    return document.querySelector('.progress').classList.contains('on');
  });
  check(23, 'a bar is up while tracing', bar);
  await settle(p);
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
