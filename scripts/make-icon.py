"""Contour's icon: black shears coming at you down a strip of grey cloth.

Framed like the Lumières' train arriving at La Ciotat: seen from a little above
and to one side, the cloth is a long strip running back on a diagonal to a
vanishing point, and the shears come down it towards the viewer, tips first,
cutting it lengthwise. Behind them the two halves have parted. The upper blade
rides over the cloth, the lower one runs beneath it and shows past the strip's
edge. Everything is modelled in 3D and projected through one pinhole camera,
so the foreshortening is real rather than drawn.

    python3 scripts/make-icon.py                        # writes assets/brand/*.svg
    rsvg-convert -w 1024 assets/brand/app-icon.svg -o assets/brand/app-icon.png
    npx tauri icon assets/brand/app-icon.png            # every size and .icns

Writes assets/brand/app-icon.svg, assets/brand/mark.svg and public/favicon.svg.
"""
import math, sys

out_dir = sys.argv[1] if len(sys.argv) > 1 else 'assets/brand'

TURN = math.radians(27)     # the strip's angle off straight-ahead
PITCH = math.radians(20)    # the camera looking down
CAM = (230.0, 300.0, 0.0)   # standing to the right of the strip, above it
FOCAL = 900.0


def project(p, s, ox, oy):
    """A pinhole camera at CAM, looking along -z, tipped down by PITCH."""
    x, y, z = p[0] - CAM[0], p[1] - CAM[1], p[2] - CAM[2]
    c, sn = math.cos(PITCH), math.sin(PITCH)
    y1 = y * c - z * sn
    z1 = y * sn + z * c
    k = FOCAL / max(1.0, -z1)
    return (ox + s * x * k, oy - s * y1 * k)


def f(v):
    return f'{v:.1f}'


def path(pts, close=True):
    d = 'M' + ' L'.join(f'{f(x)},{f(y)}' for x, y in pts)
    return d + (' Z' if close else '')


DEFS = '''<defs>
<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f8f78"/><stop offset="0.5" stop-color="#5b7c65"/><stop offset="1" stop-color="#46644f"/></linearGradient>
<linearGradient id="clothTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a9d9b"/><stop offset="0.45" stop-color="#b9bcba"/><stop offset="1" stop-color="#d4d6d4"/></linearGradient>
<linearGradient id="clothEdge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8d908e"/><stop offset="1" stop-color="#5d605e"/></linearGradient>
<linearGradient id="steel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a5f5e"/><stop offset="0.35" stop-color="#2b2e2e"/><stop offset="0.7" stop-color="#131515"/><stop offset="1" stop-color="#3a3e3d"/></linearGradient>
<linearGradient id="grip" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b3d3d"/><stop offset="0.4" stop-color="#151616"/><stop offset="1" stop-color="#050505"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="screw" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#d9dcdb"/><stop offset="0.45" stop-color="#7b807f"/><stop offset="1" stop-color="#222424"/></radialGradient>
<clipPath id="plateClip"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
</defs>'''

# -- the model ----------------------------------------------------------------

AWAY = (math.sin(TURN), 0.0, -math.cos(TURN))   # down the strip, into the distance
ACROSS = (-AWAY[2], 0.0, AWAY[0])                # across it, towards the camera's side
PIVOT = (420.0, 0.0, -1700.0)                     # the screw, on the strip's centre line
OPEN = math.radians(17)
BLADE = 430
HANDLE = 260
HALF = 80                                        # the strip's half-width


def S(u, v):
    """A point in the shears' plane: u towards the viewer along the cut, v up."""
    return (PIVOT[0] - AWAY[0] * u, v, PIVOT[2] - AWAY[2] * u)


def C(s, w, y=0.0):
    """A point on the cloth: s down the strip from the screw, w across it."""
    return (PIVOT[0] + AWAY[0] * s + ACROSS[0] * w, y, PIVOT[2] + AWAY[2] * s + ACROSS[2] * w)


def blade(direction, side):
    """A blade from just behind the screw to its tip, opened `direction` off the
    cut; `side` is +1 for the blade above the cloth."""
    ux, uy = math.cos(direction), math.sin(direction)
    nx, ny = -uy, ux
    if ny * side < 0:
        nx, ny = -nx, -ny
    at = lambda s, o: S(ux * s + nx * o, uy * s + ny * o)
    back = [at(BLADE * t, 56 * (1 - t ** 1.7) + 3) for t in (0.97, 0.88, 0.7, 0.45, 0.2, 0.0)]
    return [at(-36, -6), at(BLADE, 0)] + back + [at(-36, 48)]


def handle(direction, big):
    """The shank and loop, carrying a blade's line on through the screw."""
    ux, uy = -math.cos(direction), -math.sin(direction)
    px, py = -uy, ux
    r_out, r_in = (92, 60) if big else (76, 48)
    cu, cv = ux * HANDLE, uy * HANDLE
    s0, s1 = 24, HANDLE - r_out * 0.95
    shank = [S(ux * s0 + px * 26, uy * s0 + py * 26), S(ux * s1 + px * 32, uy * s1 + py * 32),
             S(ux * s1 - px * 32, uy * s1 - py * 32), S(ux * s0 - px * 26, uy * s0 - py * 26)]
    ring = lambda r, sq: [
        S(cu + ux * r * math.cos(t) + px * r * sq * math.sin(t),
          cv + uy * r * math.cos(t) + py * r * sq * math.sin(t))
        for t in [i / 48 * math.tau for i in range(48)]
    ]
    return shank, ring(r_out, 0.8), ring(r_in, 0.64)


def gap(s):
    """Half the parting of the cut, s down the strip from the screw."""
    return 0.0 if s <= 10 else min(70.0, 6 + (s - 10) * 0.16)


def scene(s, ox, oy, mark=False):
    P = lambda p: project(p, s, ox, oy)
    out = []
    add = out.append

    above_blade = blade(OPEN, 1)
    below_blade = blade(-OPEN, -1)
    # Each blade runs straight through the screw into its own handle, so the
    # blade above the cloth has its handle below it, and the other way round.
    lower_handle = handle(OPEN, big=True)
    upper_handle = handle(-OPEN, big=False)

    def draw_handle(h):
        shank, outer, inner = h
        add(f'<path d="{path([P(p) for p in shank])}" fill="url(#grip)" stroke="#000" stroke-width="2"/>')
        add(f'<path d="{path([P(p) for p in outer])} {path([P(p) for p in inner])}" '
            f'fill="url(#grip)" fill-rule="evenodd" stroke="#000" stroke-width="2"/>')
        if not mark:
            arc = [P(p) for p in outer[6:18]]
            add(f'<path d="{path(arc, close=False)}" fill="none" stroke="#fff" stroke-width="4" '
                f'stroke-linecap="round" opacity="0.3"/>')

    def draw_blade(b):
        add(f'<path d="{path([P(p) for p in b])}" fill="url(#steel)" stroke="#000" stroke-width="2" stroke-linejoin="round"/>')
        if not mark:
            add(f'<path d="{path([P(b[0]), P(b[1])], close=False)}" stroke="#c9cecd" stroke-width="3" opacity="0.75"/>')

    # 1. Beneath the cloth: the lower blade and the handle continuing the upper one.
    draw_blade(below_blade)
    draw_handle(lower_handle)

    # 2. The strip, from well in front of the shears back to the horizon: whole
    # ahead of the screw, in two parted halves behind it.
    NEAR, FAR = -1400.0, 40000.0
    ss = [NEAR, -200, 0, 10] + [10 + 30 * 1.25 ** i for i in range(40) if 10 + 30 * 1.25 ** i < FAR] + [FAR]
    for sg in (-1, 1):                    # -1: the far side of the strip, +1: the near side
        inner = [C(x, sg * gap(x)) for x in ss]
        outer = [C(x, sg * HALF) for x in ss]
        add(f'<path d="{path([P(p) for p in inner + outer[::-1]])}" fill="url(#clothTop)"/>')
        if sg == 1:
            # The near side's edge: the cloth's thickness, facing the camera.
            low = [C(x, HALF, -8.0) for x in ss]
            add(f'<path d="{path([P(p) for p in outer + low[::-1]])}" fill="url(#clothEdge)"/>')
        # The inner lip's edge, where the cut has opened it.
        lip = [C(x, sg * gap(x), -8.0) for x in ss if x >= 10]
        top = [C(x, sg * gap(x)) for x in ss if x >= 10]
        if sg == -1:
            add(f'<path d="{path([P(p) for p in top + lip[::-1]])}" fill="url(#clothEdge)"/>')
    if not mark:
        # The weave, running down the strip and converging on the vanishing point.
        threads = []
        for w in range(-HALF + 12, HALF, 14):
            pts = [C(x, w if abs(w) > gap(x) else math.copysign(gap(x), w or 1)) for x in ss]
            threads.append(path([P(p) for p in pts], close=False))
        add(f'<path d="{" ".join(threads)}" stroke="#000" stroke-width="1.1" fill="none" opacity="0.08"/>')
        # Frayed threads along both lips of the cut, near the blades.
        fray = []
        for sg in (-1, 1):
            for x in range(30, 420, 36):
                a = P(C(x, sg * gap(x)))
                b = P(C(x - 10, sg * (gap(x) - 9)))
                fray.append(f'M{f(a[0])},{f(a[1])} L{f(b[0])},{f(b[1])}')
        add(f'<path d="{" ".join(fray)}" stroke="#6e716f" stroke-width="2" stroke-linecap="round"/>')

    # 3. Over the cloth: the handle continuing the lower blade, the upper blade, the screw.
    draw_handle(upper_handle)
    draw_blade(above_blade)
    c = P(PIVOT)
    r = math.dist(c, P((PIVOT[0], 18.0, PIVOT[2])))   # 18 model units, at the screw's distance
    add(f'<circle cx="{f(c[0])}" cy="{f(c[1])}" r="{f(r)}" fill="url(#screw)" stroke="#000" stroke-width="2"/>')
    if not mark:
        q = r * 0.45
        add(f'<path d="M{f(c[0] - q)},{f(c[1] + q)} L{f(c[0] + q)},{f(c[1] - q)}" stroke="#1a1c1c" stroke-width="4" stroke-linecap="round"/>')
    return out


def frame(width, cx, cy):
    """The scale and offset that fit the shears to `width` centred on (cx, cy):
    the camera is placed by the story, and the picture is then framed on the
    shears, as a photographer would crop."""
    pts = []
    for d, side in ((OPEN, 1), (-OPEN, -1)):
        pts += [project(p, 1, 0, 0) for p in blade(d, side)]
        sh, outer, _ = handle(d, side == 1)
        pts += [project(p, 1, 0, 0) for p in sh + outer]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    s = width / max(max(xs) - min(xs), max(ys) - min(ys))
    return s, cx - s * (max(xs) + min(xs)) / 2, cy - s * (max(ys) + min(ys)) / 2


def doc(body):
    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n'
    return head + DEFS + '\n' + '\n'.join(body) + '\n</svg>\n'


# App icon: the macOS 824-unit content square with a 185 corner. The cloth runs
# out past the plate's edges and is clipped by it, so its far edge reads as a
# horizon rather than as the end of a sheet.
icon = [
    '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)"/>',
    '<g clip-path="url(#plateClip)">',
] + scene(*frame(600, 500, 540)) + [
    '</g>',
    '<rect x="103" y="103" width="818" height="818" rx="182" fill="none" stroke="#2f4f3b" stroke-width="6"/>',
]
open(f'{out_dir}/app-icon.svg', 'w').write(doc(icon))

# Toolbar mark and favicon: the same drawing without the weave, the threads or
# the shadows, filling the square, on a clear ground.
mark = ['<clipPath id="markClip"><rect x="0" y="0" width="1024" height="1024"/></clipPath>',
        '<g clip-path="url(#markClip)">'] + scene(*frame(960, 512, 512), mark=True) + ['</g>']
open(f'{out_dir}/mark.svg', 'w').write(doc(mark))
open('public/favicon.svg', 'w').write(doc(mark))
print('ok')
