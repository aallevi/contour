# Contour

Turns a photograph into a vector illustration: adjust it, cut it into tone or
colour regions, trace those regions with [potrace](https://potrace.sourceforge.net/),
and shade the shapes with hatching, gradients or stipple. Exports SVG and PDF as
real vector geometry.



Runs as a macOS desktop app (Tauri v2). Everything is local; nothing is uploaded
anywhere.

---

## What it does differently

**The preview is the export.** The same `exportSVG` that writes the file puts
its output into the DOM. There is no second renderer that can drift from the
first, and no "export looks different from the screen" class of bug, because
there is only one thing being drawn.

**Bands nest, so there are no seams.** Trace two adjacent regions
independently and you get two curves fitted to the same edge from opposite
sides, agreeing to within a fraction of a pixel — so the paper shows through
along every shared boundary as a hairline. Each band here is *itself plus
everything darker*, so the bands overlap completely and paint over one another
back to front. Nothing is left to leak through, and the extra covered area costs
nothing because it is covered.

**Shading is generated inside the region, not clipped to it.** Every hatch line
is walked against the band's own mask and every dot is tested against it, so the
file contains only marks that are visible. That is the difference between a
hatched portrait of a few thousand line segments and one of a few hundred
thousand — and it is why the PDF backend needs no clipping machinery to match
what the SVG does.

**Only the things that change shape pay for a retrace.** potrace is a
subprocess per band and the only step measured in hundreds of milliseconds.
Colour, opacity, hatch angle, gradient stops, dot size, outline width — all of
it rebuilds the scene inside the frame the change arrived in. The handful of
settings that genuinely move a contour are the only ones that go near potrace,
and they are marked in the panel where they live.

---

## Getting started

```bash
npm install
npm run app              # desktop app in dev mode

brew install potrace     # optional: the second tracer
brew install imagemagick # optional: PSD, HEIC, camera raw, PDF and CMYK input
```

Nothing has to be installed to trace: **vtracer is compiled into the app**.
potrace is worth having as well — the two fit curves differently and neither is
better at everything — but its absence is now a choice between tracers rather
than a degraded mode, and the app switches to vtracer on its own if it cannot
find it.

`npm run dev` alone serves the same UI in a browser at <http://localhost:1421>,
which is faster to iterate on — but a browser tab cannot run subprocesses, so
tracing there falls back to the built-in tracer (see below).

To produce a distributable bundle:

```bash
npm run app:build        # -> src-tauri/target/release/bundle/
```

Requires Node 20+ and a Rust toolchain.

### Installing it properly

```bash
npm run install-app
```

That quits Contour if it is open, rebuilds, and swaps the bundle in
`/Applications`. No `sudo` needed. `-- --launch` reopens it afterwards,
`-- --skip-build` installs whatever is already built.

**The project directory is the only master copy.** The bundle in
`/Applications` is disposable build output — there is no auto-update and no
state inside it, so upgrading is just building again and replacing it.

---

## Where potrace has to be

potrace is not bundled. It is found by looking in `/opt/homebrew/bin`,
`/usr/local/bin`, `/opt/local/bin`, `/usr/bin` and `/bin`, in that order, and
only then by asking `PATH`.

That order is deliberate and it is not paranoia: an app launched from Finder
inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, so a Homebrew
potrace is invisible to it even though it is plainly on your path in a terminal.
Probing the known prefixes explicitly is what makes the installed app behave the
same as `npm run dev`. The Trace panel reports which binary it found.

**If it is not found**, the app does not stop — it falls back to a tracer built
into the app, and says so in the status bar. That tracer follows the same three
steps potrace does (extract the boundary, simplify it, fit curves) using the
simplest honest method for each: unit-edge boundary walking, Douglas–Peucker,
and chord-scaled Catmull–Rom with corner detection. It is not a
reimplementation and does not pretend to be. potrace solves for the globally
optimal polygon and fits corner-aware Béziers; this does not. The shapes are
recognisably the same and the difference shows in the details, which is exactly
where it should.

---

## The pipeline

Knowing where a control sits is usually enough to predict both what it does and
what it costs.

```
 SOURCE  ──►  ADJUST (GPU)  ──────────────────────────► the histogram
              exposure, brightness, contrast,           under the curve editor
              saturation, hue, levels, curves,          is this, exactly
              denoise, blur, sharpen, invert
                    │
                    ▼
              BAND ──┬── tone:   posterise luminance at N-1 thresholds
                     └── colour: quantise to N colours in CIE Lab
                    │
                    │   every band owns one level — a tone threshold, or a
                    │   palette entry — and its mask is everything up to that
                    │   level  ── nested, so bands overlap
                    ▼
              SHAPE   grow / smooth, per band
                    │
                    ▼
              TRACE   potrace, one process per band, run in parallel
                    │   -t turdsize  -a alphamax  -O opttolerance
                    │   -z turnpolicy  -u unit  -n longcurve
                    ▼
              FILL ──┬── flat      the band colour
                     ├── gradient  aimed and coloured from the photograph
                     ├── hatch     lines, or ribbons that swell with tone
                     └── stipple   dots, sized and thinned by tone
                    │
                    ▼
              SCENE  ──┬──►  SVG  (and the preview, which is the same call)
                       ├──►  PDF
                       └──►  PNG  (the SVG, rasterised)
```

Two things fall out of that and they are the ones worth remembering.

**The lightest level is the paper, not a band.** Four levels is three inks
printed on a ground — the same arithmetic a screen printer does. It is also why
thresholds are never allowed to reach pure white: a threshold at white would put
every pixel at or below it, the band would take the whole canvas, and the paper
would never show. On a cutout or a studio shot, where half the frame can be
exactly white, that is the difference between a drawing on paper and a drawing
with its own grey background painted over the paper.

**Adjustment is measured in trace pixels.** Blur, denoise and mask shaping are
all in the working resolution's pixels, which is what `Trace detail` sets. That
makes them independent of how large the source photograph happens to be, and it
means changing `Trace detail` rescales their effect.

---

## Using it

Open an image (the app starts on a test card, so there is always something on
screen), pick a preset to see the shape of things, then work down the sidebar.

**Drawing / Split / Photo** across the top switch what the stage shows, and Tab
cycles them. In Split, the seam has a grip on it: drag to wipe between the
photograph and the drawing. The grip lives on the stage rather than on the
canvas, so it stays the same size however far the drawing is zoomed.

### Image

**Blur is the most important control in the panel**, and it is the one people
under-use. potrace traces exactly what it is given, so film grain and sensor
noise become thousands of extra contour points. Soften first and the shapes come
out drawn rather than photocopied. `Denoise` is a median filter — it removes
speckle without softening edges, which blur cannot do — and `Sharpen` pulls
edges back afterwards.

The stack runs denoise, blur, sharpen, then tone. That is not the order a photo
editor uses, and the reason is the histogram: banding reads the very last thing
this produces, so putting the curve at the end means the histogram under the
curve editor is literally the distribution the thresholds are chosen from.

Curves use monotone cubic interpolation, so dragging a handle can never make the
region beside it move the wrong way. Click to add a point, drag to move,
alt-click to remove; arrow keys nudge the selected point by one step of 255 and
shift-arrow by ten, and Backspace removes it. The readout under the plot gives
the selected point and the value under the cursor in input → output form.

**Levels and curves are one editor.** The rail under the plot carries the black
point, the midtone and the white point, and dragging one of them is the same
edit as moving the matching slider above it. The dashed line is levels and the
curve *composed* — what the image actually gets — because a curve that looks
gentle can be sitting on a levels clip that has already thrown half the range
away, and there is no way to see that if the two live in different boxes.

### Regions

| Mode | What it cuts on | Good for |
|---|---|---|
| Tone | Luminance, posterised at N−1 thresholds | Mono and duotone illustration, ink drawing, print separations |
| Colour | k-means in CIE Lab, N flat colours | Flat-colour illustration — the field-guide look |

Colour quantisation is done in Lab rather than RGB because the clusters have to
land where the eye would put them. In RGB, the distance from a mid skin tone to
its own shadow is larger than the distance from that shadow to a dark green, so
an RGB quantiser reliably splits a face in two and merges the darker half with
the background.

**The palette is yours to set.** Every swatch is a colour picker: choose a
colour and that entry is pinned, so the solver has to arrange the rest of the
palette around it. That is the difference between posterising a photograph and
drawing with it — you can fix the two that matter, a skin tone and a background,
and let k-means find the others. The padlock in the corner pins an entry you
have not changed. `Requantise` starts over and drops every pin; `Re-solve the
rest` keeps the pins and redoes the others. The lightest entry becomes the
paper, the same way the lightest tone level does — unless the paper is set to
Transparent, which is a decision rather than a missing colour.

Colour bands nest by **palette index**, not by lightness, and that distinction
is load-bearing. A photograph quantised to four colours can easily return a tan
at luminance 138 and a grey at 147 — nine steps apart and nothing alike. Nesting
those by lightness merges them into a single band and leaves the other one
drawing nothing at all. Indices cannot collide, so every entry gets a band.

| Threshold spacing | What it does |
|---|---|
| Equal area | Same number of pixels per band. Almost always the better opening move |
| Even | Uniform across the tone range |
| Manual | Drag the dividers on the strip |

A photograph's tones are never uniformly distributed, so evenly spaced
thresholds routinely hand three of four bands to a sky and leave the subject as
one flat shape. Equal-area spacing spends the levels where the pixels actually
are.

**Nest regions** is on by default and explained above. Turn it off when you want
the shapes as separate objects to pull apart in an editor, and expect hairlines.

#### Transparency

Open a cut-out — a PNG with a real matte — and Contour treats it as one: the
paper is set to none, nothing is drawn where the source is transparent, and the
empty ground is left out of the histogram so the thresholds are chosen from the
subject alone. A **Transparency** group appears in this panel with the matte
cut, which is the alpha below which a pixel is not part of the drawing at all.

This matters more than it sounds. A transparent PNG carries black in the RGB of
every clear pixel, because the encoder had no reason to put anything else there.
Without a matte the banding code reads that black as the darkest tone in the
picture, so a figure meant to float on nothing comes back sitting on a solid
black plate — and it looks like a tracing bug rather than an alpha one. Alpha is
carried premultiplied through the whole adjustment stack for the same reason:
resampling or blurring straight RGBA mixes that black into every edge and puts a
dark fringe round the subject, which potrace then faithfully traces.

Growing a band with `Grow` cannot push it outside the matte — the matte is
applied again after morphology, so trapping a figure does not put a halo of ink
on the ground it is floating on.

### Trace

**Two tracers, one set of masks.** Both are handed exactly the same bitmaps and
the same mask shaping, so switching between them changes the curve fitting and
nothing else.

| | potrace | vtracer |
|---|---|---|
| How it ships | a binary you install | compiled into the app |
| Fits | long, confident curves | shorter splines that hold small detail |
| Straight edges | no | yes, in polygon mode |
| Best at | organic subjects, faces, fur | flat-vector work, hard-edged shapes |

potrace smooths away detail below its corner threshold, which is exactly what
you want on a photograph of an animal and exactly what you do not want on a
diagram. vtracer's **polygon** mode is the cut-paper look, and it is the reason
it is here as well as potrace rather than instead of it.

#### potrace

Its own parameters, one to one, document-wide with a per-band override.

| Control | Flag | What it does |
|---|---|---|
| Speckle | `-t` | Drops any shape *or hole* smaller than this area |
| Corner threshold | `-a` | 0 keeps every vertex a corner; 1.334 keeps none |
| Optimisation | `-O` | How far a fitted curve may stray before it is split |
| Turn policy | `-z` | How an ambiguous diagonal crossing is resolved |
| Precision | `-u` | Coordinates quantised to 1/n of a pixel |
| Polygon only | `-n` | Skip curve optimisation, keep the raw fitted Béziers |

Speckle is the one to reach for first on a photograph. Corner threshold is worth
knowing the shape of: fed a rectangle, potrace keeps the corners perfectly
square at 0, 0.5 and 1, and only rounds them at its maximum of 1.334.

#### vtracer

| Control | What it does |
|---|---|
| Edges | Curves, Straight (cut-paper) or Pixels (the mask's own staircase) |
| Speckle | Drops any shape or hole smaller than this area |
| Corner threshold | A turn sharper than this stays a corner |
| Segment length | The shortest run of pixels the fitter treats as a segment |
| Splice threshold | How far apart two curves may point and still be joined |
| Precision | Decimal places on the coordinates |

Speckle is stated as an *area*, matching potrace's `-t`, so the setting means
the same thing on both sides of the switch — vtracer measures it as a side
length internally and the conversion happens on the way out. Holes survive: they
come back as extra subpaths wound the other way, which the nonzero fill rule
already used everywhere here reads correctly.

### Bands

A band is an object, not a slot. It owns the tone it cuts at, so **Duplicate**
gives you a second pass over the same region with its own fill — a flat wash
under a hatch, two hatches crossed at different weights — and deleting one
leaves the rest exactly where they were. Drag to reorder; the list paints back
to front, so the last one goes down first and the first one lands on top.

**Fill** is where the shading lives.

| Fill | The idea | The controls that matter |
|---|---|---|
| Flat | One solid colour | — |
| Ramp | A multi-stop gradient along an axis | the stop bar, `Ramp start` / `Ramp end`, `Aim from the photograph` |
| Freeform | Colours dropped where the light puts them | the handles on the drawing, `Scatter` |
| Hatch | Lines, or ribbons that swell with tone | `Weight follows tone`, `Spacing`, `Cross-hatch` |
| Stipple | Dots, sized and thinned by tone | `Size follows tone`, `Thinning`, `Jitter` |

#### Freeform gradients

A ramp can only say "it gets darker that way". A face, a flank, a piece of fruit
all get darker several ways at once, and the usual answer — three bands stacked
with three separate ramps — is more work and less convincing than putting four
colours roughly where the light puts them.

**The handles are on the drawing, not in the sidebar.** A colour point has a
position, and a position is a thing you point at; put the same control in a
panel and it becomes two numbers you adjust and then look up to check.

| | |
|---|---|
| drag a handle | move that colour |
| double-click the drawing | add a colour point there |
| alt-click a handle | remove it |
| alt-scroll over a handle | change how far it reaches |

The dashed ring round each handle is its reach. Overlap the neighbours, or the
ground colour shows through between them and the region reads as blotchy.

**`Scatter` is the whole workflow in one press**: it covers the region with
points and reads the photograph under each one. Points land on a jittered grid
rather than at random — random points on a small region clump, and four colour
blobs in one corner is worse than nothing — and only those inside the mask are
kept, so a crescent-shaped band gets its points along the crescent instead of in
the hole. It is deterministic, so pressing it again is a refinement rather than
a dice roll. `Take colours` re-reads the photograph under the points already
there without moving any of them.

Positions are stored as fractions of the region's own bounding box, not as
canvas coordinates. That is what lets a point survive a retrace: change the blur
or a threshold and the region moves, but "two thirds of the way down the muzzle"
still means the same place.

Under the hood it is a ground colour with one soft radial blob painted over it
per point — which is a thing SVG and PDF can both express exactly, and the
reason this is real vector output rather than an embedded bitmap. The falloff is
four stops tracing a smoothstep rather than a straight ramp to clear, because
the eye finds the break in a gradient's *slope* even when its value is
continuous, and a linear falloff leaves a visible ring where the blob ends.

#### Ramp gradients

The ramp is edited on a bar: click to add a stop, drag to move it, alt-click to
remove it. Two stops is a plain blend; four is what a form turning away from a
light actually does, and it is what the flat-vector illustration style this app
exists to serve uses throughout.

**Ramp start** and **Ramp end** are where the two ends of the ramp land on the
region, measured along its own extent — 0 and 1 put them exactly on its edges.
Values outside that push the ramp off the region so you see one part of it hard,
and an end below the start reverses it. Without this a gradient is a fact about
the region's bounding box with nothing left to aim, which is why gradient tools
pinned to a bounding box feel stuck.

**Aim from the photograph** fits a least-squares plane to the region's tone and
points the gradient down its slope — one pass of accumulation, and the
difference between a gradient that follows the light and one you aim by hand for
every band.

**Read colours from the photograph** takes each stop's colour from the region's
mean colour at that stop's own position on the ramp, so adding a stop adds a
reading of the photograph rather than a colour to pick. **Take colours** bakes
the current reading into real stops and turns sampling off, which is how a
sampled gradient becomes one you can edit by hand.

If a gradient looks like it is doing nothing, the usual cause is nesting: a
light band is mostly covered by the darker ones painted on top of it, so only
its outer margin shows. Put the gradient on the darkest band, or turn off
**Nest regions**, to see the whole ramp.

**Weight follows tone** is the engraving move and the reason hatching here reads
as shading rather than as texture. Above zero the lines stop being strokes and
become filled ribbons that swell in shadow and taper out in the light, carrying
tone the way a burin does with no change in spacing. It is emitted as a closed
polygon because SVG and PDF both have variable-width strokes in exactly the same
place, which is nowhere.

**Base wash** puts a flat layer of the band colour under the marks. Hatching on
bare paper is the engraving look; hatching over a light wash of the same ink is
what most illustrations actually want, because the band reads as a tone at a
distance and as line work up close.

**Spacing, on both Hatch and Stipple, is capped by how much the canvas can
hold** — four thousand lines or two hundred thousand dots per band. Past that
the spacing opens up rather than marks being dropped, and the hint under the
slider says what is actually being drawn. Dropping marks was the first way round
this and the wrong one: it kept the count down and quietly turned the density
control into a random one, so dragging it tighter past the limit made the field
*thinner*.

**Region shape** — `Grow` and `Smooth` — is the one group in this panel that
costs a retrace, and the panel says so. Both come out of the same blur, which is
the trick: blur a bilevel mask and a straight edge becomes a ramp whose value at
signed distance *d* is the Gaussian CDF of *d*/σ, so re-thresholding at 0.5 puts
the edge back where it was only smoother, and thresholding anywhere else moves
it a known, uniform distance. A dilation by *n* pixels is therefore a threshold
at Φ(−n/σ) and costs nothing extra — and because it is a level set of a blurred
field, the result is round rather than the square-cornered thing a separable
min/max filter gives you. `Grow` is the printer's trapping trick: spread every
band slightly and the band below is covered even where the two traces disagree.

---

## Export

SVG and PDF are both written directly, from the same scene.

Physical size is stated on the root in inches, with canvas pixels in the
`viewBox`. A bare `width="1000"` is 1000 CSS pixels, which an editor reads as
10.4in — but a canvas pixel here is 1/dpi of an inch, so at 300 ppi the same
drawing is 3.33in. Stating it in inches is what makes the file open at the size
the Document panel promised, and what makes a hatch spacing of 4px actually come
out at 4/300 of an inch on paper.

Bands become named groups, tagged so Inkscape reads them as layers.

Set the paper to **Transparent** in the Document panel and no background
rectangle is written at all, in any of the three formats — which is what you
want for an asset destined to sit on something else. Opening a cut-out does this
for you.

PNG is rasterised from the SVG, so it cannot drift from it. The copy handed to
the rasteriser states its size in user units rather than inches: a browser
rasterises an SVG at its intrinsic size and then scales the bitmap, so a 300 ppi
drawing declared as 3.33in would be drawn at 320 pixels and blown up to whatever
size was asked for.

An outline used by more than one node — a freeform gradient's ground and all of
its blobs, a hatch and its base wash — is written once into `<defs>` and
referenced with `<use>` after that, but only when the reference is actually
smaller than saying it again. A four-corner square is cheaper repeated; a traced
band is thousands of characters of Bézier and is not.

PDF gets the same treatment with two differences. PDF has no such thing as
filling a path with a gradient, so the path becomes a clip and an axial or
radial shading is painted through it. And it has no such thing as a transparent
gradient stop either, so a freeform gradient's soft blobs are painted with a
**luminosity soft mask**: the same ramp again in DeviceGray, inside a
transparency group, read as the alpha of everything under it. Content streams
are Flate-compressed — a hatched drawing is hundreds of thousands of short
decimal strings, which is close to the best case deflate ever sees, and it also
means a repeated outline costs almost nothing there.

Documents save as `.contour`, which is JSON with the source image embedded, so a
file opens standalone on another machine.

| | |
|---|---|
| ⌘O | Open an image |
| ⌘S | Save the document |
| ⌘E | Export SVG |
| ⌘Z / ⇧⌘Z | Undo / redo |
| Tab | Cycle drawing / photo / split view |
| F or ⌘0 | Fit to window |
| scroll | Zoom about the cursor |
| drag | Pan |

---

## Tests

```bash
npm test
```

184 tests. The interesting ones are not the unit tests:

- `tests/trace.test.ts` runs the **real potrace binary** over a pipe, exactly as
  the app does, and checks that discs come back the right size, that holes
  survive with the right winding, that `turdsize` suppresses what it says it
  does, and that the working-to-canvas transform composes correctly with
  potrace's own ten-times-and-upside-down output.
- `tests/e2e.test.ts` runs the whole pipeline on a real picture — banding,
  potrace, fills, both serialisers — and writes the results to `artifacts/` so
  they can be opened and looked at.
- `tests/pdf.test.ts` walks the cross-reference table and checks every offset
  actually lands on the object it claims, inflates the content stream with
  Node's zlib rather than the API that wrote it, and checks that a gradient's
  end stops survive into the shading function — a stitched PDF function's
  `/Bounds` holds only the *interior* boundaries, so building it the obvious way
  silently stretches the ramp across the whole domain and the PDF stops
  agreeing with the SVG.
- `tests/matte.test.ts` builds a cut-out with black under its transparent ground
  and checks that none of it reaches a mask, a histogram or the quantiser.
- `tests/ui.test.ts` builds the real sidebar in jsdom and drives it — clicks the
  gradient bar, switches a band to a gradient, releases a slider over the wrong
  element. This is only possible because the engine builds its GL context on
  first use rather than in its constructor, which is also why a machine without
  WebGL2 now gets a working app instead of a blank window.
- `tests/adjust.test.ts` covers the adjustment stack, which used to be the one
  part with no coverage at all: it needs a graphics context, so any test that
  touched it died in a constructor. `src/image/adjust-cpu.ts` is the same
  arithmetic without one — it is what runs when there is no WebGL2, and it is
  what the tests drive.
- `tests/freeform.test.ts` checks that both backends express the soft falloff,
  including that the PDF carries a `/Luminosity` soft mask and that the SVG
  writes the region outline once rather than once per colour point.

---

## Layout

```
src/
  core/      types, the document model, the store and its invalidation ladder
  image/     loading, the adjustment stack on GPU and on CPU, curves and levels
  band/      masks and their morphology, tone posterising, Lab quantising
  trace/     path geometry, the native tracer bridge, the fallback tracer
  fill/      flat, ramp, freeform, hatch, stipple
  render/    scene assembly
  export/    SVG, PDF, PNG
  ui/        panels, controls, the curve/gradient editors, the canvas overlay
src-tauri/   locating the tools, running both tracers in parallel, decoding
scripts/     install.sh, and make-icon.py for the app icon
```

The icon is generated rather than drawn: `python3 scripts/make-icon.py` models
black shears and a strip of grey cloth in 3D and projects them, and writes
`assets/brand/app-icon.svg`, the toolbar mark and the favicon; render the SVG to
`assets/brand/app-icon.png` with `rsvg-convert` and `npx tauri icon` on that PNG
produces every size and the `.icns`.

**Working with Claude on it.** Point a session at this directory and describe
the change; `npm run install-app` is what puts the result in your Applications
folder. Nothing about the installed copy needs to be touched by hand, and
nothing in it is worth preserving.
