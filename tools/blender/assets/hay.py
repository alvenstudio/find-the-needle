"""Hay assets: the instanced straw, hay bales and the cart that carts them around.

The straw is the single most important mesh in the game -- sixteen thousand of
them are on screen at once -- so it is budgeted at twenty triangles and built by
sweeping a tapered rectangle along a gently curved spine.
"""

import math

import bpy
from mathutils import Euler, Vector


def sweep_rect(name, spine, half_w, half_h, color=None, family="Prop", caps=True):
    """Sweep a rectangular cross-section along ``spine``.

    ``half_w`` / ``half_h`` are per-station half-extents, so a straw can taper
    to a point at both ends without extra geometry.
    """
    verts = []
    faces = []
    count = len(spine)
    for i, point in enumerate(spine):
        centre = Vector(point)
        forward = Vector(spine[min(i + 1, count - 1)]) - Vector(spine[max(i - 1, 0)])
        if forward.length < 1e-6:
            forward = Vector((0.0, 0.0, 1.0))
        forward.normalize()
        up = Vector((0.0, 0.0, 1.0))
        if abs(forward.dot(up)) > 0.95:
            up = Vector((0.0, 1.0, 0.0))
        side = forward.cross(up).normalized()
        up = side.cross(forward).normalized()
        w, h = half_w[i], half_h[i]
        verts.extend([
            centre + side * w + up * h,
            centre - side * w + up * h,
            centre - side * w - up * h,
            centre + side * w - up * h,
        ])

    for i in range(count - 1):
        a, b = i * 4, (i + 1) * 4
        for k in range(4):
            k2 = (k + 1) % 4
            faces.append((a + k, a + k2, b + k2, b + k))

    if caps:
        faces.append((3, 2, 1, 0))
        last = (count - 1) * 4
        faces.append((last, last + 1, last + 2, last + 3))

    return from_points(name, verts, faces, color=color, family=family)


def build_straw():
    """A single stalk of straw: 0.30 m long, tapered, with a lazy S-bend."""
    length = 0.30
    stations = 4
    spine = []
    for i in range(stations):
        t = i / (stations - 1)
        # A shallow S so a field of randomly rotated straws never looks gridded.
        bend = math.sin(t * math.pi) * 0.018 - math.sin(t * math.pi * 2.0) * 0.010
        spine.append((bend, 0.0, (t - 0.5) * length))

    # Taper: fat in the middle third, pinched at the tips.
    half_w, half_h = [], []
    for i in range(stations):
        t = i / (stations - 1)
        girth = 0.35 + 0.65 * math.sin(min(max(t, 0.0), 1.0) * math.pi) ** 0.5
        half_w.append(0.0175 * girth)
        half_h.append(0.0105 * girth)

    straw = sweep_rect("Straw", spine, half_w, half_h, color="straw", family="Prop")
    # A darker crease down one face catches the light and sells the fibre.
    crease = select_faces(straw, lambda c, n: n.x < -0.6)
    paint(straw, "straw_mid", faces=crease)
    tips = select_faces(straw, lambda c, n: abs(n.z) > 0.85)
    paint(straw, "straw_light", faces=tips)
    flat(straw)
    set_origin(straw, (0.0, 0.0, 0.0))
    report(straw)
    export_glb(straw, "straw")


def build_hay_wisp():
    """A three-blade tuft used for collect bursts and the vacuum stream."""
    blades = []
    for i in range(3):
        angle = i * 2.4
        spine = [(0.0, 0.0, -0.06), (math.sin(angle) * 0.01, math.cos(angle) * 0.01, 0.06)]
        blade = sweep_rect(f"Wisp{i}", spine, [0.008, 0.004], [0.005, 0.003],
                           color="straw_light", family="Prop")
        place(blade, rot=(math.radians(18 * i), math.radians(12 * i), angle))
        blades.append(blade)
    wisp = join(blades, "HayWisp")
    flat(wisp)
    set_origin(wisp, (0.0, 0.0, 0.0))
    report(wisp)
    export_glb(wisp, "hay_wisp")


def build_round_bale():
    """A cylindrical bale, banded with twine, lying on its side."""
    body = from_profile(
        "BaleBody",
        [(0.0, -0.55), (0.52, -0.55), (0.58, -0.48), (0.58, 0.48), (0.52, 0.55), (0.0, 0.55)],
        segments=18, color="straw_mid",
    )
    smooth(body, 44)

    # Concentric end-swirls: two flat rings on each cap read as coiled straw.
    swirls = []
    for side in (-1.0, 1.0):
        for radius, tone in ((0.40, "straw"), (0.24, "straw_light"), (0.10, "straw_dark")):
            ring = from_profile(f"Swirl{side}{radius}", [(0.0, 0.0), (radius, 0.0)], segments=18,
                                color=tone, close_bottom=False)
            place(ring, loc=(0.0, 0.0, side * 0.552), rot=(0.0, 0.0 if side > 0 else math.pi, 0.0))
            swirls.append(ring)

    twine = []
    for offset in (-0.28, 0.0, 0.28):
        band = torus("Twine", major=0.586, minor=0.016, major_seg=18, minor_seg=6,
                     loc=(0.0, 0.0, offset), rot=(0.0, 0.0, 0.0), color="rope")
        smooth(band, 40)
        twine.append(band)

    bale = join([body] + swirls + twine, "HayBaleRound")
    place(bale, rot=(math.radians(90), 0.0, 0.0))
    apply_transform(bale)
    set_origin(bale, (0.0, 0.0, 0.0))
    report(bale)
    export_glb(bale, "bale_round")


def build_square_bale():
    """A rectangular bale with chamfered corners and two baling wires."""
    body = cube("BaleBody", size=(0.9, 0.6, 0.55), loc=(0.0, 0.0, 0.275), color="straw")
    bevel(body, 0.05, 2)
    apply_modifiers(body)
    ends = select_faces(body, lambda c, n: abs(n.x) > 0.8)
    paint(body, "straw_mid", faces=ends)
    top = select_faces(body, lambda c, n: n.z > 0.8)
    paint(body, "straw_light", faces=top)

    wires = []
    for offset in (-0.22, 0.22):
        wire = cube(f"Wire{offset}", size=(0.02, 0.63, 0.58), loc=(offset, 0.0, 0.275),
                    color="metal_dark", family="Metal")
        wires.append(wire)

    # A few loose stalks poking out of the ends make the silhouette less CAD-like.
    loose = []
    for i, (x, y, z, rx, ry) in enumerate([
        (0.46, 0.12, 0.42, 0.3, 1.3), (-0.46, -0.16, 0.34, -0.2, -1.5),
        (0.44, -0.20, 0.16, 0.5, 1.2), (-0.45, 0.22, 0.48, -0.4, -1.4),
    ]):
        stalk = sweep_rect(f"Loose{i}", [(0, 0, -0.06), (0.005, 0.004, 0.08)],
                           [0.012, 0.006], [0.008, 0.004], color="straw_light")
        place(stalk, loc=(x, y, z), rot=(rx, ry, i * 0.7))
        loose.append(stalk)

    bale = join([body] + wires + loose, "HayBaleSquare")
    set_origin(bale, (0.0, 0.0, 0.0))
    report(bale)
    export_glb(bale, "bale_square")


def build_hay_cart():
    """A two-wheeled wooden cart -- the sell point for a load of straw."""
    parts = []
    floor = cube("Floor", size=(2.0, 1.1, 0.09), loc=(0.0, 0.0, 0.62), color="plank")
    bevel(floor, 0.02, 1)
    parts.append(floor)

    for x in (-0.98, 0.98):
        wall = cube("WallX", size=(0.08, 1.1, 0.46), loc=(x, 0.0, 0.86), color="wood")
        bevel(wall, 0.02, 1)
        parts.append(wall)
    for y in (-0.53, 0.53):
        wall = cube("WallY", size=(2.04, 0.07, 0.42), loc=(0.0, y, 0.84), color="wood")
        bevel(wall, 0.02, 1)
        parts.append(wall)
    for y in (-0.53, 0.53):
        for x in (-0.62, 0.0, 0.62):
            slat = cube("Slat", size=(0.09, 0.09, 0.5), loc=(x, y, 0.88), color="wood_dark")
            parts.append(slat)

    for x in (-0.75, 0.75):
        for y in (-0.62, 0.62):
            axle_end = cylinder("Hub", radius=0.07, depth=0.1, verts=8,
                                loc=(x, y, 0.42), rot=(math.radians(90), 0, 0), color="wood_dark")
            parts.append(axle_end)
            wheel = torus("Wheel", major=0.36, minor=0.075, major_seg=16, minor_seg=6,
                          loc=(x, y, 0.42), rot=(math.radians(90), 0, 0), color="wood_dark")
            smooth(wheel, 40)
            parts.append(wheel)
            for s in range(6):
                spoke = cube("Spoke", size=(0.05, 0.055, 0.62), loc=(x, y, 0.42),
                             rot=(0, 0, 0), color="wood_light")
                place(spoke, rot=(math.radians(90), math.radians(30 * s), 0))
                apply_transform(spoke)
                parts.append(spoke)

    # Draw handles angling up at the front.
    for y in (-0.4, 0.4):
        handle = cube("Handle", size=(1.2, 0.08, 0.08), loc=(-1.55, y, 0.78),
                      rot=(0, math.radians(-9), 0), color="wood")
        parts.append(handle)
    crossbar = cube("Crossbar", size=(0.09, 0.95, 0.09), loc=(-2.08, 0.0, 0.86), color="wood_dark")
    parts.append(crossbar)

    cart = join(parts, "HayCart")
    set_origin(cart, (0.0, 0.0, 0.0))
    report(cart)
    export_glb(cart, "hay_cart")


def build_pitchfork_head():
    """Shared tine cluster, reused by the pitchfork tool and the scarecrow."""
    parts = []
    socket = from_profile("Socket", [(0.0, 0.0), (0.05, 0.0), (0.055, 0.14), (0.035, 0.2), (0.0, 0.2)],
                          segments=10, color="iron", family="Metal")
    smooth(socket, 40)
    parts.append(socket)
    for i, x in enumerate((-0.11, 0.0, 0.11)):
        curve = 0.0 if i == 1 else (0.03 if x > 0 else -0.03)
        tine = sweep_rect(
            f"Tine{i}",
            [(x, 0.0, 0.18), (x + curve * 0.4, 0.0, 0.42), (x + curve, 0.0, 0.66)],
            [0.019, 0.015, 0.004], [0.019, 0.014, 0.004],
            color="metal", family="Metal",
        )
        parts.append(tine)
    head = join(parts, "PitchforkHead")
    set_origin(head, (0.0, 0.0, 0.0))
    return head


BUILDERS = {
    "straw": build_straw,
    "hay_wisp": build_hay_wisp,
    "bale_round": build_round_bale,
    "bale_square": build_square_bale,
    "hay_cart": build_hay_cart,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[hay] {name}")
        fn()
