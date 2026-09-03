"""Farmyard clutter: the fences, containers and yard furniture that dress the field.

Everything in here is scenery the player walks past at eye height, so the rules
are the same throughout -- chunky boxy silhouettes, a light bevel on anything
hard-surface so the midday sun catches an edge, and colour that comes from
face-subset painting rather than a texture.

The local helpers exist because the same handful of shapes keep recurring: a box
that changes width as it rises (posts, tubs), a square bar swept along a polyline
(handles and cranks), a slatted crate wall, and a checked panel.
"""

import math

from mathutils import Vector

# Shared farmyard dimensions.  A rail at 1.05 m and a gate at 1.27 m read as
# waist-and-chest height to a 1.62 m eye, which is what sells the scale.
FENCE_SPAN = 2.4
RAIL_HIGH_Z = 1.05
RAIL_LOW_Z = 0.55
POST_HEIGHT = 1.30

# A bevel this size is roughly one pixel of highlight at conversational range
# and triples a box's face count, so it is spent only on large flat parts.
EDGE_BEVEL = 0.018


# --------------------------------------------------------------------------
# Local helpers
# --------------------------------------------------------------------------
def square_profile(name, profile, loc=(0.0, 0.0, 0.0), color=None, family="Prop",
                   close_bottom=True, close_top=True):
    """Loft a square cross-section through a list of ``(half_extent, z)`` rings.

    The rectangular cousin of :func:`from_profile`.  ``half_extent`` is either a
    scalar or an ``(x, y)`` pair, which is what turns a chamfered fence post or
    a flared tub into one mesh instead of five overlapping boxes.
    """
    ox, oy, oz = loc
    verts, faces = [], []
    for half, z in profile:
        hx, hy = half if hasattr(half, "__len__") else (half, half)
        verts.extend([
            (ox - hx, oy - hy, oz + z),
            (ox + hx, oy - hy, oz + z),
            (ox + hx, oy + hy, oz + z),
            (ox - hx, oy + hy, oz + z),
        ])

    for ring in range(len(profile) - 1):
        low, high = ring * 4, (ring + 1) * 4
        for k in range(4):
            k2 = (k + 1) % 4
            faces.append((low + k, low + k2, high + k2, high + k))

    if close_bottom:
        faces.append((3, 2, 1, 0))
    if close_top:
        top = (len(profile) - 1) * 4
        faces.append((top, top + 1, top + 2, top + 3))

    return from_points(name, verts, faces, color=color, family=family)


def sweep_bar(name, spine, half, color=None, family="Prop"):
    """Sweep a square bar of half-width ``half`` along a polyline.

    Bucket handles and crank arms want a bent rod; a torus costs four times the
    triangles for a shape that is 80% hidden behind the prop it is bolted to.
    """
    count = len(spine)
    halves = list(half) if hasattr(half, "__len__") else [half] * count
    verts, faces = [], []
    # The reference up-vector is carried along the spine rather than re-derived
    # from world up at every point.  Re-deriving it means a segment that happens
    # to be near-vertical picks a different fallback axis from its neighbour and
    # the bar takes a visible 90 degree twist at that joint -- and the bucket
    # handle sits 0.0003 away from exactly that threshold.
    ref_up = Vector((0.0, 0.0, 1.0))
    for i, point in enumerate(spine):
        centre = Vector(point)
        forward = Vector(spine[min(i + 1, count - 1)]) - Vector(spine[max(i - 1, 0)])
        if forward.length < 1e-6:
            forward = Vector((0.0, 0.0, 1.0))
        forward.normalize()
        up = ref_up - forward * ref_up.dot(forward)
        if up.length < 1e-4:
            # Only reachable if the spine doubles back on itself; pick any axis
            # that is not parallel to forward and carry on.
            seed = Vector((0.0, 1.0, 0.0)) if abs(forward.z) > 0.9 else Vector((0.0, 0.0, 1.0))
            up = seed - forward * seed.dot(forward)
        up.normalize()
        side = forward.cross(up).normalized()
        up = side.cross(forward).normalized()
        ref_up = up
        h = halves[i]
        verts.extend([
            centre + side * h + up * h,
            centre - side * h + up * h,
            centre - side * h - up * h,
            centre + side * h - up * h,
        ])

    # side x up = -forward here, so the ring winds clockwise about forward and
    # every face has to be listed in reverse to end up pointing outwards.
    for i in range(count - 1):
        a, b = i * 4, (i + 1) * 4
        for k in range(4):
            k2 = (k + 1) % 4
            faces.append((a + k2, a + k, b + k, b + k2))

    faces.append((0, 1, 2, 3))
    last = (count - 1) * 4
    faces.append((last + 3, last + 2, last + 1, last))

    return from_points(name, verts, faces, color=color, family=family)


def checker_panel(name, size, grid, loc, rot, color_a, color_b, family="Prop"):
    """A flat subdivided quad painted as a two-tone check, facing -Y by default.

    The scarecrow's plaid shirt needs a pattern finer than a face, and stapling
    two of these onto a plain box costs a quarter of what subdividing the whole
    torso would -- including the four sides nobody ever sees.
    """
    cols, rows = grid
    width, height = size
    verts, faces = [], []
    for row in range(rows + 1):
        for col in range(cols + 1):
            verts.append((-width / 2 + width * col / cols, 0.0,
                          -height / 2 + height * row / rows))
    for row in range(rows):
        for col in range(cols):
            corner = row * (cols + 1) + col
            faces.append((corner, corner + 1, corner + cols + 2, corner + cols + 1))

    panel = from_points(name, verts, faces, color=color_a, family=family)
    alternate = [i for i in range(len(faces)) if ((i % cols) + (i // cols)) % 2]
    paint(panel, color_b, family=family, faces=alternate)
    place(panel, loc=loc, rot=rot)
    return panel


def slatted_box(edge, rows, lid, tag="Crate", wood="wood", frame="wood_dark"):
    """Corner posts plus slatted walls and floor -- the skeleton of both crates.

    Returned unjoined so the caller can drop cargo in before merging, and so the
    apple crate can ask for a shorter, lidless version of the same carpentry.
    """
    half = edge / 2.0
    post = edge * 0.10
    board_t = edge * 0.075
    board_h = edge * 0.20
    span = edge - 2.0 * post
    floor_w = edge * 0.26
    floor_step = edge * 0.34

    parts = []
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            parts.append(cube(f"{tag}Post", size=(post, post, edge),
                              loc=(sx * (half - post / 2), sy * (half - post / 2), half),
                              color=frame))

    for row in range(rows):
        z = edge * (row + 0.5) / rows
        tone = wood if row % 2 == 0 else "wood_light"
        for sy in (-1.0, 1.0):
            parts.append(cube(f"{tag}SlatY", size=(span, board_t, board_h),
                              loc=(0.0, sy * (half - board_t / 2), z), color=tone))
        for sx in (-1.0, 1.0):
            parts.append(cube(f"{tag}SlatX", size=(board_t, span, board_h),
                              loc=(sx * (half - board_t / 2), 0.0, z), color=tone))

    for i in (-1, 0, 1):
        parts.append(cube(f"{tag}Floor", size=(span, floor_w, board_t),
                          loc=(0.0, i * floor_step, board_t / 2), color=frame))
    if lid:
        # Kept narrower than the slat span so the lid's end grain never lands on
        # the same plane as a wall slat or a corner post: coincident co-normal
        # quads on the top of the crate are the most-looked-at z-fight there is.
        lid_w = span - board_t / 2.0
        for i in (-1, 0, 1):
            parts.append(cube(f"{tag}Lid", size=(lid_w, floor_w, board_t),
                              loc=(0.0, i * floor_step, edge - board_t / 2),
                              color="wood_light"))
    return parts


# --------------------------------------------------------------------------
# Boundaries
# --------------------------------------------------------------------------
def build_fence_section():
    """One 2.4 m span of post-and-rail, origin at the span centre.

    The span runs along +X.  The rails stop exactly on the span edges and the
    posts straddle them, so chaining sections at 2.4 m intervals lands each
    section's end post exactly on its neighbour's -- one visually solid post
    instead of a pair with a 5 cm slot between them.
    """
    parts = []
    for x in (-FENCE_SPAN / 2.0, FENCE_SPAN / 2.0):
        # A chamfered cap sheds rain in real life and, more usefully, gives the
        # post a lit top facet instead of a flat grey square.
        post = square_profile(
            "Post",
            [(0.075, 0.0), (0.075, POST_HEIGHT - 0.10), (0.048, POST_HEIGHT)],
            loc=(x, 0.0, 0.0), color="wood_dark",
        )
        chamfer = select_faces(post, lambda c, n: n.z > 0.2)
        paint(post, "wood_light", faces=chamfer)
        parts.append(post)

    for z in (RAIL_LOW_Z, RAIL_HIGH_Z):
        rail = cube("Rail", size=(FENCE_SPAN, 0.06, 0.16), loc=(0.0, 0.0, z), color="wood")
        bevel(rail, EDGE_BEVEL, 1)
        apply_modifiers(rail)
        paint(rail, "wood_light", faces=select_faces(rail, lambda c, n: n.z > 0.8))
        paint(rail, "wood_dark", faces=select_faces(rail, lambda c, n: n.z < -0.8))
        parts.append(rail)

    fence = join(parts, "FenceSection")
    flat(fence)
    set_origin(fence, (0.0, 0.0, 0.0))
    report(fence)
    export_glb(fence, "fence_section")


def build_fence_gate():
    """A 2.4 m field gate with its origin on the hinge axis so it can swing.

    All geometry lives at positive X: rotating the model about its own Z axis
    is therefore exactly the gate opening, no pivot offset needed in the game.
    """
    clearance = 0.12          # gate hangs clear of the ground like a real one
    height = 1.15
    centre_z = clearance + height / 2.0
    top_z = clearance + height
    parts = []

    for x in (0.09, 2.31):
        stile = cube("Stile", size=(0.10, 0.07, height), loc=(x, 0.0, centre_z), color="wood")
        bevel(stile, EDGE_BEVEL, 1)
        parts.append(stile)

    for z in (clearance + 0.09, top_z - 0.08):
        rail = cube("GateRail", size=(2.30, 0.06, 0.14), loc=(1.20, 0.0, z), color="wood")
        bevel(rail, EDGE_BEVEL, 1)
        parts.append(rail)

    # The brace runs low-hinge to high-latch; that is the direction that carries
    # the gate's weight back into the post rather than sagging away from it.
    rise, run = 0.86, 2.16
    brace = cube("Brace", size=(math.hypot(run, rise), 0.05, 0.12),
                 loc=(1.20, 0.0, centre_z), rot=(0.0, -math.atan2(rise, run), 0.0),
                 color="wood_light")
    parts.append(brace)

    for x in (0.60, 1.10, 1.60, 2.05):
        parts.append(cube("Slat", size=(0.09, 0.045, height - 0.10),
                          loc=(x, -0.05, centre_z), color="wood_light"))

    for z in (clearance + 0.22, top_z - 0.22):
        parts.append(cube("HingePlate", size=(0.26, 0.10, 0.08),
                          loc=(0.13, 0.0, z), color="iron", family="Metal"))
        parts.append(cylinder("HingePin", radius=0.035, depth=0.15, verts=6,
                              loc=(0.02, 0.0, z), color="metal_dark", family="Metal"))

    gate = join(parts, "FenceGate")
    flat(gate)
    set_origin(gate, (0.0, 0.0, 0.0))
    report(gate)
    export_glb(gate, "fence_gate")


# --------------------------------------------------------------------------
# Containers
# --------------------------------------------------------------------------
def build_trough():
    """A 1.8 m plank trough on stubby legs, hollow and dark inside.

    Built from five separate boards rather than a solidified box: solidify on a
    cube produces inverted normals on the inner shell, and separate boards let
    each inner face be painted without hunting through a bevelled face soup.
    """
    leg_h = 0.20
    wall_h = 0.42
    wall_z = leg_h + wall_h / 2.0
    parts = []

    # The floor and the end boards are tucked *inside* the two side walls rather
    # than being flush with them: flush would put the floor's side quad and the
    # wall's outer quad on the same plane with the same normal, which z-fights
    # the length of the trough.  The 0.03 m of remaining overlap still welds.
    floor = cube("TroughFloor", size=(1.74, 0.50, 0.07), loc=(0.0, 0.0, leg_h + 0.035),
                 color="wood")
    paint(floor, "wood_dark", faces=select_faces(floor, lambda c, n: n.z > 0.8))
    parts.append(floor)

    for y in (-0.245, 0.245):
        wall = cube("TroughSide", size=(1.80, 0.06, wall_h), loc=(0.0, y, wall_z), color="wood")
        bevel(wall, EDGE_BEVEL, 1)
        apply_modifiers(wall)
        inward = -1.0 if y > 0 else 1.0
        paint(wall, "wood_dark",
              faces=select_faces(wall, lambda c, n, s=inward: n.y * s > 0.8))
        paint(wall, "wood_light", faces=select_faces(wall, lambda c, n: n.z > 0.8))
        parts.append(wall)

    # The end boards are housed between the side walls the way a real plank
    # trough is built -- 1.5 cm short of the wall ends, 2 cm proud of the rim,
    # bottom buried in the floor board.  Every mating face is therefore inside
    # solid geometry instead of sitting on a neighbour's plane.
    for x in (-0.855, 0.855):
        end = cube("TroughEnd", size=(0.06, 0.50, wall_h - 0.01),
                   loc=(x, 0.0, wall_z + 0.025), color="wood")
        inward = -1.0 if x > 0 else 1.0
        paint(end, "wood_dark",
              faces=select_faces(end, lambda c, n, s=inward: n.x * s > 0.8))
        parts.append(end)

    for x in (-0.72, 0.72):
        for y in (-0.19, 0.19):
            parts.append(cube("TroughLeg", size=(0.14, 0.14, leg_h),
                              loc=(x, y, leg_h / 2.0), color="wood_dark"))

    trough = join(parts, "Trough")
    flat(trough)
    set_origin(trough, (0.0, 0.0, 0.0))
    report(trough)
    export_glb(trough, "trough")


def build_bucket():
    """A 0.32 m galvanised bucket with a rolled rim and a wire handle.

    The profile folds back inwards at the top so the mesh closes on a small
    disc a few centimetres down: that disc, painted near-black, is the cheapest
    convincing "there is a dark interior in here" a closed mesh can manage.
    """
    rim_z = 0.295
    body = from_profile(
        "BucketBody",
        [(0.098, 0.0), (0.104, 0.03), (0.138, 0.28), (0.150, rim_z),
         (0.140, 0.315), (0.124, 0.285)],
        segments=10, color="metal", family="Metal",
    )
    smooth(body, 46)
    paint(body, "metal_dark", family="Metal",
          faces=select_faces(body, lambda c, n: c.z > 0.27 and abs(n.z) < 0.6))
    paint(body, shade("iron", 0.35), family="Metal",
          faces=select_faces(body, lambda c, n: n.z > 0.8 and c.z < 0.30))
    paint(body, "metal_dark", family="Metal",
          faces=select_faces(body, lambda c, n: n.z < -0.8))

    spine = []
    for i in range(6):
        t = i / 5.0
        angle = math.pi * t
        spine.append((-math.cos(angle) * 0.132, 0.0, rim_z - 0.02 + math.sin(angle) * 0.13))
    handle = sweep_bar("BucketHandle", spine, 0.012, color="metal_dark", family="Metal")

    bucket = join([body, handle], "Bucket")
    set_origin(bucket, (0.0, 0.0, 0.0))
    report(bucket)
    export_glb(bucket, "bucket")


def build_crate():
    """A 0.8 m slatted shipping crate with a slatted lid."""
    crate = join(slatted_box(0.80, rows=3, lid=True), "Crate")
    flat(crate)
    set_origin(crate, (0.0, 0.0, 0.0))
    report(crate)
    export_glb(crate, "crate")


def build_apple_crate():
    """A 0.55 m open crate heaped with apples.

    Seven spheres at six segments apiece is deliberately coarse -- smooth shading
    rounds them off, and a proper sphere per apple would eat the whole budget.
    """
    parts = slatted_box(0.55, rows=2, lid=False, tag="Apple")

    heap = [
        (-0.14, -0.13, 0.47), (0.13, -0.14, 0.47), (-0.13, 0.14, 0.47),
        (0.14, 0.13, 0.47), (0.0, 0.0, 0.49), (-0.05, 0.02, 0.62), (0.09, -0.04, 0.60),
    ]
    for i, (x, y, z) in enumerate(heap):
        tone = "mushroom_cap" if i % 2 == 0 else "barn_red"
        apple = sphere(f"Apple{i}", radius=0.085, segments=6, rings=4,
                       loc=(x, y, z), color=tone)
        paint(apple, shade("mushroom_cap", 0.4),
              faces=select_faces(apple, lambda c, n: n.z > 0.6))
        smooth(apple, 60)
        parts.append(apple)

    crate = join(parts, "AppleCrate")
    set_origin(crate, (0.0, 0.0, 0.0))
    report(crate)
    export_glb(crate, "apple_crate")


def build_barrel():
    """A 0.9 m coopered barrel: bulged staves, three iron hoops, a lidded top."""
    body = from_profile(
        "BarrelBody",
        [(0.255, 0.0), (0.295, 0.09), (0.325, 0.30), (0.325, 0.56),
         (0.295, 0.78), (0.262, 0.87)],
        segments=12, color="wood", family="Prop", close_top=False,
    )
    smooth(body, 50)
    paint(body, "wood_dark", faces=select_faces(body, lambda c, n: n.z < -0.8))

    # Each hoop is a zero-thickness ribbon, so any part of it that falls inside
    # the staves simply disappears.  The body tapers, therefore the hoops taper
    # with it: body radius + 6 mm at both ends of every band, never a constant
    # radius fighting a sloped wall.
    hoops = []
    for r_low, r_high, low, high in ((0.3024, 0.3124, 0.10, 0.17),
                                     (0.3320, 0.3320, 0.40, 0.47),
                                     (0.3133, 0.3037, 0.69, 0.76)):
        hoop = from_profile(f"Hoop{low}", [(r_low, low), (r_high, high)], segments=12,
                            color="iron", family="Metal",
                            close_bottom=False, close_top=False)
        hoops.append(hoop)

    lid = from_profile(
        "BarrelLid",
        [(0.268, 0.86), (0.282, 0.885), (0.258, 0.915)],
        segments=12, color="wood_light",
    )
    paint(lid, "wood_dark", faces=select_faces(lid, lambda c, n: abs(n.z) < 0.6))

    barrel = join([body] + hoops + [lid], "Barrel")
    set_origin(barrel, (0.0, 0.0, 0.0))
    report(barrel)
    export_glb(barrel, "barrel")


def build_milk_can():
    """A 0.75 m dairy can: fat body, sharp shoulder, narrow lidded neck.

    The whole thing is one lathe -- the lid is just the top two bands painted
    darker, which is free where a separate lid mesh would cost thirty triangles.
    """
    body = from_profile(
        "CanBody",
        [(0.150, 0.0), (0.163, 0.03), (0.163, 0.36), (0.150, 0.42), (0.098, 0.52),
         (0.098, 0.60), (0.112, 0.625), (0.086, 0.66), (0.086, 0.75)],
        segments=10, color="metal", family="Metal",
    )
    smooth(body, 44)
    paint(body, "metal_dark", family="Metal",
          faces=select_faces(body, lambda c, n: c.z > 0.615))
    paint(body, "iron", family="Metal",
          faces=select_faces(body, lambda c, n: n.z < -0.8))

    lugs = []
    for x in (-0.105, 0.105):
        lugs.append(cube("CanLug", size=(0.05, 0.11, 0.09), loc=(x, 0.0, 0.50),
                         rot=(0.0, math.radians(-24 if x > 0 else 24), 0.0),
                         color="metal_dark", family="Metal"))

    can = join([body] + lugs, "MilkCan")
    set_origin(can, (0.0, 0.0, 0.0))
    report(can)
    export_glb(can, "milk_can")


# --------------------------------------------------------------------------
# Yard furniture
# --------------------------------------------------------------------------
def build_wheelbarrow():
    """A 1.45 m barrow: flared metal tray, one wheel, two handles, two legs.

    Points along -Y (wheel forward) so it faces the camera when dropped into the
    scene unrotated.
    """
    tray_z = 0.52
    parts = []

    floor = cube("TrayFloor", size=(0.60, 0.80, 0.06), loc=(0.0, 0.05, tray_z), color="metal",
                 family="Metal")
    parts.append(floor)

    for sx in (-1.0, 1.0):
        wall = cube("TraySide", size=(0.06, 0.80, 0.34), loc=(sx * 0.32, 0.05, tray_z + 0.16),
                    rot=(0.0, math.radians(12) * sx, 0.0), color="metal", family="Metal")
        bevel(wall, EDGE_BEVEL, 1)
        parts.append(wall)
    for sy in (-1.0, 1.0):
        wall = cube("TrayEnd", size=(0.62, 0.06, 0.34), loc=(0.0, 0.05 + sy * 0.40, tray_z + 0.16),
                    rot=(math.radians(12) * -sy, 0.0, 0.0), color="metal", family="Metal")
        bevel(wall, EDGE_BEVEL, 1)
        parts.append(wall)

    wheel = cylinder("Wheel", radius=0.22, depth=0.09, verts=12, loc=(0.0, -0.56, 0.22),
                     rot=(0.0, math.radians(90), 0.0), color="rubber")
    smooth(wheel, 50)
    # cylinder() keeps its rot as an un-applied object transform, so the caps
    # are still local +/-Z here even though they face +/-X in the world.
    paint(wheel, "metal_dark", faces=select_faces(wheel, lambda c, n: abs(n.z) > 0.8))
    parts.append(wheel)
    parts.append(cylinder("Hub", radius=0.06, depth=0.13, verts=6, loc=(0.0, -0.56, 0.22),
                          rot=(0.0, math.radians(90), 0.0), color="metal", family="Metal"))

    # Without these the wheel is a disc hanging in a 0.20 m gap either side of
    # the rails.  Two fork plates drop off the front of the chassis and a short
    # axle spans between them, straight through the hub.
    for sx in (-1.0, 1.0):
        parts.append(cube("Fork", size=(0.05, 0.07, 0.30), loc=(sx * 0.30, -0.575, 0.30),
                          color="wood_dark"))
    parts.append(cylinder("Axle", radius=0.035, depth=0.64, verts=6, loc=(0.0, -0.56, 0.22),
                          rot=(0.0, math.radians(90), 0.0), color="metal_dark", family="Metal"))

    # The handles are simply the back ends of the two chassis rails, which is how
    # a real barrow is built and saves two more boxes.
    rail_tilt = math.radians(12)
    for sx in (-1.0, 1.0):
        parts.append(cube("Rail", size=(0.07, 1.20, 0.07), loc=(sx * 0.30, -0.02, 0.46),
                          rot=(rail_tilt, 0.0, 0.0), color="wood"))
        parts.append(cylinder("Grip", radius=0.045, depth=0.18, verts=6,
                              loc=(sx * 0.30, 0.567, 0.585), rot=(math.radians(90), 0.0, 0.0),
                              color="rubber"))
        parts.append(cube("Leg", size=(0.06, 0.06, 0.54), loc=(sx * 0.28, 0.40, 0.27),
                          color="wood_dark"))
        parts.append(cube("Strut", size=(0.06, 0.34, 0.06), loc=(sx * 0.28, -0.44, 0.32),
                          rot=(math.radians(-24), 0.0, 0.0), color="wood_dark"))

    barrow = join(parts, "Wheelbarrow")
    set_origin(barrow, (0.0, 0.0, 0.0))
    report(barrow)
    export_glb(barrow, "wheelbarrow")


def build_signpost():
    """A chamfered post carrying an arrow board that points off to +X.

    The board's front face is a single flat 0.90 x 0.42 m quad painted in barn
    trim white, sitting at local ``(0, -0.075, 1.35)`` with a 10 degree yaw --
    that is the surface the game projects its text decal onto, so the quad is
    kept undivided and unbevelled.  The offset is chosen so the board's *back*
    face stays a clear 15 mm inside the post's front plane across the whole
    yaw, rather than grazing it and shimmering at distance.
    """
    post = square_profile(
        "SignPost",
        [(0.065, 0.0), (0.065, 1.62), (0.042, 1.72)],
        color="wood_dark",
    )
    bevel(post, EDGE_BEVEL, 1)
    apply_modifiers(post)
    paint(post, "wood_light", faces=select_faces(post, lambda c, n: n.z > 0.2))

    half_w, half_h, half_t, tip = 0.45, 0.21, 0.025, 0.62
    outline = [(-half_w, -half_h), (half_w, -half_h), (tip, 0.0),
               (half_w, half_h), (-half_w, half_h)]
    verts = [(x, -half_t, z) for x, z in outline] + [(x, half_t, z) for x, z in outline]
    faces = [(0, 1, 3, 4), (1, 2, 3), (9, 8, 6, 5), (8, 7, 6)]
    for i in range(5):
        j = (i + 1) % 5
        faces.append((j, i, i + 5, j + 5))
    board = from_points("SignBoard", verts, faces, color="wood")
    paint(board, "barn_trim",
          faces=select_faces(board, lambda c, n: n.y < -0.9 and c.x < half_w - 0.01))
    place(board, loc=(0.0, -0.075, 1.35), rot=(0.0, 0.0, math.radians(10)))

    sign = join([post, board], "Signpost")
    flat(sign)
    set_origin(sign, (0.0, 0.0, 0.0))
    report(sign)
    export_glb(sign, "signpost")


def build_pumpkin():
    """A 0.45 m ribbed pumpkin with a stubby green stalk.

    The ribs are real geometry: every vertex of a squashed sphere is pushed in
    and out radially by a six-lobe cosine, which costs nothing and reads far
    better than painted stripes when the player crouches next to it.
    """
    lobes = 6
    squash = 0.72
    rib_depth = 0.075
    radius = 0.22

    # Built at the origin so the rib maths is centred, then lifted by its own
    # squashed radius to sit the fruit flat on the ground.
    centre = radius * squash
    body = sphere("PumpkinBody", radius=radius, segments=12, rings=8, color="pumpkin")
    for vert in body.data.vertices:
        x, y, z = vert.co
        swell = 1.0 + rib_depth * math.cos(lobes * math.atan2(y, x))
        vert.co = Vector((x * swell, y * swell, z * squash))
    body.data.update()
    smooth(body, 60)
    # Darken the valleys between ribs so the form still reads in flat light.
    paint(body, shade("pumpkin", 0.78),
          faces=select_faces(body, lambda c, n: math.cos(lobes * math.atan2(c.y, c.x)) < -0.4))
    place(body, loc=(0.0, 0.0, centre))

    stalk = from_profile(
        "Stalk",
        [(0.038, 2 * centre - 0.03), (0.030, 2 * centre + 0.05), (0.040, 2 * centre + 0.09)],
        segments=6, color="pine_dark",
    )
    paint(stalk, "leaf_dark", faces=select_faces(stalk, lambda c, n: n.z > 0.8))

    pumpkin = join([body, stalk], "Pumpkin")
    set_origin(pumpkin, (0.0, 0.0, 0.0))
    report(pumpkin)
    export_glb(pumpkin, "pumpkin")


def build_scarecrow():
    """A 2.1 m scarecrow: pole cross, sack head, plaid shirt, floppy hat.

    The plaid is two subdivided quads stuck on the front and back of a plain box
    torso.  Subdividing the whole torso would cost four times as much for four
    faces the player will never see.
    """
    torso_z = 1.22
    head_base = 1.55
    parts = []

    parts.append(cube("Pole", size=(0.08, 0.08, 2.00), loc=(0.0, 0.0, 1.00), color="wood_dark"))
    parts.append(cube("CrossArm", size=(1.35, 0.07, 0.07), loc=(0.0, 0.0, 1.45), color="wood"))

    torso = cube("Torso", size=(0.46, 0.26, 0.62), loc=(0.0, 0.0, torso_z), color="barn_red")
    parts.append(torso)
    for sy, yaw in ((-1.0, 0.0), (1.0, math.pi)):
        panel = checker_panel("Plaid", (0.44, 0.60), (4, 3),
                              loc=(0.0, sy * 0.135, torso_z), rot=(0.0, 0.0, yaw),
                              color_a="barn_red", color_b="barn_pink")
        parts.append(panel)

    for sx in (-1.0, 1.0):
        parts.append(cube("Sleeve", size=(0.46, 0.18, 0.18), loc=(sx * 0.45, 0.0, 1.43),
                          rot=(0.0, math.radians(6) * sx, 0.0), color="barn_pink"))
        parts.append(cube("Trouser", size=(0.16, 0.16, 0.60), loc=(sx * 0.13, 0.0, 0.62),
                          color="denim"))

    # Straw bursting from every cuff is the single detail that says "stuffed".
    # cone() puts its point at local +Z, so the ankle pair needs rx = pi to aim
    # the straw down out of the trouser hem instead of up inside the leg; the
    # small ry then splays them outwards.
    for x, z, rx, ry in ((-0.70, 1.43, 0.0, -1.5), (-0.66, 1.36, 0.6, -1.3),
                         (0.70, 1.43, 0.0, 1.5), (0.66, 1.36, -0.6, 1.3),
                         (-0.13, 0.27, math.pi, 0.25), (0.13, 0.27, math.pi, -0.25)):
        parts.append(cone("Straw", r1=0.055, r2=0.0, depth=0.22, verts=6, loc=(x, 0.0, z),
                          rot=(rx, ry, 0.0), color="straw_light"))

    head = from_profile(
        "SackHead",
        [(0.080, head_base), (0.155, head_base + 0.07), (0.185, head_base + 0.22),
         (0.150, head_base + 0.36), (0.075, head_base + 0.42)],
        segments=10, color="straw_grey",
    )
    smooth(head, 50)
    parts.append(head)
    # The twine band follows the sack's own taper, offset outwards, so it grips
    # the neck instead of floating around it.
    parts.append(from_profile("NeckTie",
                              [(0.095, head_base + 0.005), (0.163, head_base + 0.075)],
                              segments=10, color="rope",
                              close_bottom=False, close_top=False))

    for x in (-0.072, 0.072):
        parts.append(cube("Eye", size=(0.055, 0.03, 0.055), loc=(x, -0.163, head_base + 0.27),
                          color="black"))
    for i, x in enumerate((-0.075, -0.025, 0.025, 0.075)):
        parts.append(cube("Stitch", size=(0.026, 0.03, 0.026),
                          loc=(x, -0.168, head_base + 0.15 + (i % 2) * 0.022),
                          color="black"))

    hat_z = head_base + 0.38
    brim = from_profile("HatBrim", [(0.32, hat_z), (0.32, hat_z + 0.035)], segments=10,
                        color="straw_mid")
    crown = from_profile("HatCrown",
                         [(0.175, hat_z + 0.03), (0.165, hat_z + 0.15), (0.125, hat_z + 0.17)],
                         segments=10, color="straw_dark", close_bottom=False)
    # from_profile builds its geometry at absolute Z with the object origin left
    # at the world origin, so rotating the hat straight away would swing it about
    # a point two metres below itself and fling it off the back of the head.
    # Move the origin to the hat's own base first, then tilt.
    for piece in (brim, crown):
        set_origin(piece, (0.0, 0.0, hat_z))
        place(piece, rot=(math.radians(-9), 0.0, 0.0))
        parts.append(piece)

    crow = join(parts, "Scarecrow")
    set_origin(crow, (0.0, 0.0, 0.0))
    report(crow)
    export_glb(crow, "scarecrow")


def build_well():
    """A 2.4 m stone well: coped ring, gabled roof on two posts, winch and bucket.

    The ring is a single lathe whose profile climbs the outside, crosses the
    coping and drops back down the inside, so the shaft is genuinely hollow with
    correctly facing walls; a short dark cylinder caps the water off below.
    """
    parts = []

    ring = from_profile(
        "WellRing",
        [(0.70, 0.0), (0.70, 0.56), (0.78, 0.60), (0.78, 0.68), (0.60, 0.68), (0.60, 0.10)],
        segments=12, color="stone", close_bottom=False, close_top=False,
    )
    sector = math.tau / 12.0
    paint(ring, "stone_dark",
          faces=select_faces(ring, lambda c, n: int(math.atan2(c.y, c.x) % math.tau / sector) % 2))
    parts.append(ring)

    # Sits entirely above Z = 0 -- its top at 0.16 still plugs the shaft (whose
    # wall stops at 0.10) but the model's bounding box no longer dips below its
    # own origin, which would fight the game's ground-snapping.
    water = cylinder("Water", radius=0.605, depth=0.16, verts=12, loc=(0.0, 0.0, 0.08),
                     color=shade("stone_dark", 0.25))
    paint(water, shade("sky", 0.30), faces=select_faces(water, lambda c, n: n.z > 0.8))
    parts.append(water)

    # Posts stand on the coping annulus (radius 0.60 to 0.78), not beside it.
    for x in (-0.68, 0.68):
        post = square_profile("WellPost",
                              [(0.065, 0.62), (0.065, 1.86), (0.045, 1.94)],
                              loc=(x, 0.0, 0.0), color="wood_dark")
        bevel(post, EDGE_BEVEL, 1)
        parts.append(post)

    pitch = math.atan2(0.46, 0.78)
    for sx in (-1.0, 1.0):
        slab = cube("RoofSlab", size=(0.95, 0.95, 0.07), loc=(sx * 0.40, 0.0, 2.08),
                    rot=(0.0, pitch * sx, 0.0), color="barn_roof")
        bevel(slab, EDGE_BEVEL, 1)
        parts.append(slab)
    parts.append(cube("Ridge", size=(0.11, 0.98, 0.10), loc=(0.0, 0.0, 2.33), color="wood_dark"))

    # The winch axle runs right through both posts so the crank has something to
    # come out of on the near side.
    parts.append(cylinder("Winch", radius=0.065, depth=1.50, verts=8, loc=(0.0, 0.0, 1.62),
                          rot=(0.0, math.radians(90), 0.0), color="wood"))
    parts.append(sweep_bar("Crank",
                           [(0.74, 0.0, 1.62), (0.90, 0.0, 1.62),
                            (0.90, 0.0, 1.47), (1.00, 0.0, 1.47)],
                           0.028, color="iron", family="Metal"))

    parts.append(cube("Rope", size=(0.04, 0.04, 0.86), loc=(0.0, 0.0, 1.19), color="rope"))
    pail = from_profile(
        "WellBucket",
        [(0.100, 0.52), (0.135, 0.74), (0.145, 0.76), (0.126, 0.735)],
        segments=8, color="wood",
    )
    paint(pail, "iron", faces=select_faces(pail, lambda c, n: n.z > 0.8 and c.z < 0.75))
    parts.append(pail)
    parts.append(sweep_bar("PailHandle",
                           [(-0.14, 0.0, 0.74), (-0.09, 0.0, 0.84),
                            (0.09, 0.0, 0.84), (0.14, 0.0, 0.74)],
                           0.014, color="metal_dark", family="Metal"))

    well = join(parts, "Well")
    set_origin(well, (0.0, 0.0, 0.0))
    report(well)
    export_glb(well, "well")


BUILDERS = {
    "fence_section": build_fence_section,
    "fence_gate": build_fence_gate,
    "trough": build_trough,
    "bucket": build_bucket,
    "crate": build_crate,
    "barrel": build_barrel,
    "wheelbarrow": build_wheelbarrow,
    "signpost": build_signpost,
    "milk_can": build_milk_can,
    "pumpkin": build_pumpkin,
    "apple_crate": build_apple_crate,
    "scarecrow": build_scarecrow,
    "well": build_well,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[farm] {name}")
        fn()
