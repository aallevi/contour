# Bugs Stipple fixed that Contour may share

Found in Stipple in November 2026, mostly while porting Contour's curves, tone
windows, light exports and paper row into it. Each item says what went wrong,
how Stipple fixed it, and what was seen in Contour's code when this list was
written. **Confirmed** means the same pattern is in Contour's code now. **Check**
means it depends on code that was not traced to the end. Stipple's commits are
on `master` at https://github.com/aallevi/stipple.

Read alongside [STIPPLE-PARITY.md](STIPPLE-PARITY.md). Fix, then run
`npm run verify`, then reinstall the app and test drags **in the installed
bundle**: none of the first two bugs show up in a browser tab.

---

## 1. Dropping files does nothing in the desktop app — **confirmed**

**Symptom in Stipple:** dragging a picture in from Eagle did nothing. Contour's
setup is worse: `src-tauri/tauri.conf.json` has `"dragDropEnabled": true`, and
the only drop handling is HTML5 (`wireDrop` in `src/ui/app.ts`, which reads
`e.dataTransfer.files`).

**Why:** with `dragDropEnabled: true`, the macOS web view hands every drag to
Tauri's native handler, so `dragenter`, `dragover` and `drop` **never fire in the
page**. With it `false`, HTML5 drops work for files from the Finder but are
unreliable from other apps (Eagle, asset libraries, anything that hands over a
file URL or a file promise).

**Stipple's fix** (`bindNativeDrop` in `src/ui/app.ts`): keep `dragDropEnabled`
`true` and take drops natively, by path.

```ts
const { getCurrentWebview } = await import('@tauri-apps/api/webview');
await getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === 'enter' || p.type === 'over') highlight(target(p.position));
  else if (p.type === 'leave') highlight(null);
  else if (p.type === 'drop') {
    const path = p.paths[0];
    if (!path) return notify('That drop carried no file');
    // read with plugin-fs readFile(path), then route by target(p.position)
  }
});
```

- **Route by position** with `document.elementFromPoint`. In Stipple, a drop on
  the Shape section is a stamp and anything else is the picture. In Contour,
  that means a `.contour`/`.json` file opens as a document and an image opens as
  the source, wherever it lands.
- **macOS gotcha:** `position` is typed `PhysicalPosition`, but on macOS it is
  in **points**, the same as CSS pixels. wry passes AppKit's `draggingLocation`
  through unscaled. Divide by `devicePixelRatio` only off the Mac.
- wry reads only `NSFilenamesPboardType`. A drop with no paths should say so
  rather than do nothing.
- A native drop has a real path, so a TIFF can go to the Rust decoder.
- Keep the HTML5 `wireDrop` for the browser build, behind `if (!isTauri())`.
  Add URL drops there (see 3).

## 2. Reordering bands by dragging is dead in the desktop app — **confirmed**

`src/ui/bands.ts` (around line 208) reorders rows with `row.draggable = true`,
`dragstart`, `dragover` and `drop`. Because `dragDropEnabled` is `true`, these
never fire in the installed app. Stipple's layer list had exactly this bug: it
worked in `npm run dev` and did nothing in `/Applications`.

**Fix:** reorder with pointer events, which no host intercepts. See
`beginDrag` in Stipple's `src/ui/layers.ts`:

- `pointerdown` on the row's grip, then `setPointerCapture`.
- A drag threshold of a few pixels, so a click is still a click.
- A drop indicator line between rows.
- `pointerup` commits the move as one undo step.

Once nothing uses HTML5 drag, native file drop (1) and row reordering can both
work.

## 3. Browser drops: links, and drops that miss — check

In the browser build, a picture dragged from another tab or out of a web page
arrives as `text/uri-list` or `text/html` (an `<img src>`), not as a file.
Stipple's `droppedFile()` helper tries these in turn:

1. `dt.files[0]`
2. `dt.items` with `getAsFile()`
3. the `<img src>` parsed from `text/html`
4. the first line of `text/uri-list`

It fetches `http(s):`, `data:` and `blob:` URLs. Contour already calls
`preventDefault()` on window-level `dragover` and `drop`, which is the other half
and stops the tab navigating to the file. Keep that.

## 4. `hidden` does nothing on a row styled `display: grid` — check

**Symptom in Stipple:** a slider wrapped in a show-when condition stayed
visible. The control row's `.ctl { display: grid }` outranks the browser's
`[hidden] { display: none }` from the user-agent stylesheet.

Contour patches this one class at a time: `.drop-zone[hidden]`, `.surface[hidden]`,
`.gui-colours[hidden]`, `.gui-grid[hidden]`, `.band-row[hidden]`. Any other
element with `display: grid` or `flex` that is toggled by `hidden` has the bug.
`style.css` lines 65, 225, 313, 511 and 680 are the ones to check. Stipple's
general fix is one rule:

```css
.section-body > [hidden] { display: none !important; }
```

A global `[hidden] { display: none !important; }` would also do it.

## 5. Canvases repainted after their panel was rebuilt — check

**Symptom in Stipple:** "Cannot read properties of undefined (reading
'distribution')". When a panel was rebuilt, the canvases of the old one (curve
editor, histograms) were still painted by their ResizeObserver or rAF, and a
per-frame hook ran for a layer that had just been deleted.

**Fix:**
- Start every paint function with `if (!canvas.isConnected) return;`.
- In any per-frame UI hook, return early when its band or layer no longer
  exists.

This applies to Contour's curve editor, tone-window histograms and the
band-list share readouts.

## 6. Tone-window histogram: comb pattern and clipped handles — check

These are fixes Stipple made to the `histoRange` control **ported from
Contour**, so Contour has the original:

- **Comb pattern:** drawing a 256-bin histogram into a strip narrower or wider
  than 256 px aliases into a comb. Rebin to about one bin per 3 CSS px before
  drawing.
- **Clipped handles:** at 0 or 1, the end handles were half off the canvas.
  Clamp each handle's drawn x to `[r, width - r]`. Clamp the drawing only, not
  the value.

## 7. Transparent PNG export comes out dark or fringed — check

Stipple composites with premultiplied alpha. With paper set to None, the PNG
export wrote premultiplied pixels, which gave dark edges on every soft dot. It
now unpremultiplies before encoding. This matters only where a Contour export
reads pixels back from WebGL (`readPixels`) or from its own premultiplied
buffer. A plain 2D canvas `toBlob` is already right. `src/image/adjust-cpu.ts`
already unpremultiplies, so check the export path, not the adjust path.

## 8. Compact SVG: a space between transforms — check

When Stipple shortens `transform="translate(..) rotate(..) scale(..)"`, it keeps
the **space between the transforms**. SVG 2 allows them run together, but SVG
1.1 does not, and Illustrator reads 1.1. If Contour's compactor strips
whitespace with a blanket `\s+` rule, make sure it does not join transform
functions. Also, Stipple rounds dot positions only, not path data inside
`<defs>`. Those shapes are drawn in a unit square and scaled up, so rounding
them to a tenth flattens them. Check whether Contour has any unit-space defs.

## 9. Rotated grids must reach the corners — check

**Symptom in Stipple:** a hexagonal halftone turned 90° on a wide picture ended
about six cells short of the corners. The lattice covered a radius of
`hypot(w, h) / 2` with as many rows as cells, but hex rows are only `√3/2` of a
cell apart, so it needed `rows = ceil(half / (√3/2))`.

Any rotated pattern in Contour (hatching at an angle, dot or wave fills on a
grid with a pitch) should be generated over the rotated bounding radius,
counting rows by their real pitch, plus a cell or two of margin. A user-set
offset or shift adds to the reach. Stipple's test samples the nearest mark to
each of the four corners at several angles on a 10:1 canvas.

## 10. Small things

- **WebP in Safari or the Tauri web view:** `toBlob('image/webp')` quietly
  returns a PNG. Contour already checks `blob.type`. Stipple's fallback is a
  Rust `encode_webp` command (image crate, `WebPEncoder::new_lossless`), fed raw
  RGBA through `tauri::ipc::Request` with an `x-size` header. Stipple copied
  this from Contour, so it is listed only for completeness.
- **Point buffers are Float32:** a test that compares coordinates to `1e-6` fails
  on rounding alone. Use `1e-3` px.
- **Test drags in the bundle.** Anything involving drag, drop or the window
  (items 1 and 2 above) cannot be verified by Playwright against the dev
  server. Reinstall and try it by hand.
