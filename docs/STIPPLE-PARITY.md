# Contour and Stipple, as a set

Contour and [Stipple](https://github.com/aallevi/stipple) are twins: the same
shell, the same chrome, the same way of working, applied to two ways of drawing
a photograph — Stipple with points, Contour with traced shapes. This is the
list of everything Stipple went through on its way to being a public tool,
taken from its commit history one commit at a time, and what each item became
here. `npm run verify` checks the items marked ✓ in a real browser.

The translation rule: Stipple's *layer* is Contour's *band*, Stipple's *ink* is
the colour a band prints, and Stipple's *print* is the whole band stack. Where
Stipple's idea depends on GPU points it has no counterpart and says so.

| # | Stipple | Contour | |
|---|---|---|---|
| 1 | Anchored `.gitignore` patterns (`/dist`, not `dist`) | Same | ✓ |
| 2 | MIT licence, `"license"` in package.json | Same | ✓ |
| 3 | `npm start` builds and opens the browser version; `base: './'` | Same, on port 4174 so both can run at once | ✓ |
| 4 | README is install and usage; the long material moved unchanged to `docs/` | `docs/GUIDE.md` is the old README, unchanged | ✓ |
| 5 | GitHub Pages workflow, tests before deploy | `.github/workflows/pages.yml` | ✓ |
| 6 | Flat grey chrome: square corners, no gradients or shadows, one accent | Flat workshop green, yellow accent | ✓ |
| 7 | Filled-triangle disclosure, boxed bar sliders with a marker, square lamp toggles | Same | ✓ |
| 8 | One control grid: label, track, number line up in every panel | Same | ✓ |
| 9 | Sidebar in signal order; a control only affects what is below it | Document → Image → Regions → Trace → Bands → Band (already so) | ✓ |
| 10 | Toolbar left to right as the workflow runs: Open image… (the one accent), Fit / 100%, compare, Undo / Redo, Presets…, then Export and Save / Load on the right | Same order and names | ✓ |
| 11 | The compare switch is quiet — pressed in, not lit — because it changes only the view | Same | ✓ |
| 12 | Compare views: Drawing, Original, Split (dragged divider), Under (photo through the paper) | Drawing, Original, Split, Under | ✓ |
| 13 | Inks view: the photo in just the print's inks | The drawing *is* that, flat, so no separate view | — |
| 14 | Views are never saved, never undoable, never in an export | Same; verify checks exports are identical across views | ✓ |
| 15 | Presets as a menu of named starting points | Same, retuned | ✓ |
| 16 | Opens on an empty sheet with a quiet drop zone; the test card only behind `?testcard` | Same | ✓ |
| 17 | Every length is a fraction of the picture, shown in mm / in / % / px | Hatch spacing and weight, wave, dot pitch and size, outline width; project version 2 converts version 1 on load | ✓ |
| 18 | Document: px and mm per edge, a ratio link, resolution keeps the print size, 2× / ½× | Same. No Apply step: in Contour a resize rescales paths and does not retrace | ✓ |
| 19 | One canvas pixel is 1/dpi inch, in every exporter | Already so; verify asserts SVG inches, PDF MediaBox and PNG pixels agree | ✓ |
| 20 | Plates: one black-on-white film per ink plus a colour proof, identical registration marks in a margin | One film per band, knocked out by the bands painted over it; gradient bands are not one ink and are named and left out | ✓ |
| 21 | Ink shares readout ("sand 38% · grey 25% · paper 0%") | Each band's share of the sheet, in the band list | ✓ |
| 22 | Eyedropper: pick an ink from the picture; picked inks survive re-sampling | Pick a palette colour from the picture; it is pinned, so it survives Re-solve | ✓ |
| 23 | Loading bar along the top of the canvas instead of a frozen window | Same, over the last drawing while tracing | ✓ |
| 24 | (i) buttons that explain a panel, since a phone has no tooltips | Every panel's explanations sit behind its (i) | ✓ |
| 25 | Phone upright: picture on top, controls scrolling under, toolbar one sideways row | Same | ✓ |
| 26 | Phone on its side: side by side again | Same | ✓ |
| 27 | Coarse pointer: finger-sized controls, 16px fields so iOS does not zoom | Same | ✓ |
| 28 | Sliders driven from the row under a finger: vertical scrolls, sideways drags, tap does nothing | Same | ✓ |
| 29 | Pinch to zoom, double-tap to fit, refit on rotation only if fitted | Same | ✓ |
| 30 | A lane down the panel's right edge with no controls, for the thumb | Same | ✓ |
| 31 | Export is one menu on a phone, each entry saying what it makes | Same | ✓ |
| 32 | Projects save as `.stipple.json` in a browser; the picker accepts any file; a non-project says so | `.contour.json`, same | ✓ |
| 33 | `viewport-fit=cover`, a theme colour, a favicon | Same | ✓ |
| 34 | Icon drawn by `scripts/make-icon.py`, desktop set by `tauri icon`, toolbar mark and favicon from the same drawing | Black shears cutting a grey cloth, Lumière framing | ✓ |
| 35 | A browser verification script, `npm run verify` | Same, checking this list | ✓ |
| 36 | README screenshot of a synthetic picture, carrying nobody's photograph | Same | ✓ |
| 37 | Layer groups and linked editing | Bands are already one document-wide stack; Trace settings are document-wide with a per-band override | — |
| 38 | GPU fixes: mip chain, sub-pixel marks, detail pass, point buffers | No GPU points here | — |
