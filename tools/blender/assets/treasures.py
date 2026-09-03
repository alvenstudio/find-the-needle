"""Treasures: everything the player can actually pull out of the haystack.

Every prop here is seen twice -- half-buried in straw at arm's length, and then
spinning a hand's width from the camera during the collect reveal.  That second
view drives two rules for the whole module:

* the pivot goes at the geometric centre, never on the ground, or the reveal
  spin wobbles.  ``centre_origin`` at the end of each builder does that;
* silhouette beats detail.  These things are 2 cm on screen while buried, so
  the read has to survive being three pixels wide.

The needle is the title object and gets the geometry budget to match.  Its eye
is a real hole punched through the head -- a ring of quads, not a dark painted
oval -- because the reveal zoom is exactly where a faked hole falls apart.

The only builder that breaks the centred-pivot rule is ``chest_lid``, whose
origin sits on the hinge axis so the game can rotate it open.
"""

import math

from mathutils import Euler, Matrix, Vector

# --------------------------------------------------------------------------
# Shared dimensions
# --------------------------------------------------------------------------
# The needle is deliberately ~8x life size: a real one is invisible at the
# densities the haystack is built at, and the joke only lands if you can see
# the thing you spent ten minutes looking for.
NEEDLE_LENGTH = 0.16
NEEDLE_HALF = NEEDLE_LENGTH * 0.5
NEEDLE_SHAFT_SEGMENTS = 12
# The eye ring: 20 keeps the slot ends round under the reveal zoom, which is
# the only place in the game anything is ever seen this close.
EYE_SEGMENTS = 20
# A chamfer this fine is invisible as geometry and entirely visible as a
# highlight -- it is what stops the head reading as a flat cardboard cutout,
# and it is where the needle's oversized triangle budget actually goes.  Two
# segments, because a single-segment chamfer on a 7 mm plate flickers as the
# reveal spins past it.
NEEDLE_CHAMFER = 0.0009
NEEDLE_CHAMFER_SEGMENTS = 2

# The chest is authored as two files that have to line up in game.  The body is
# built standing on z=0 and recentred, so its origin lands here; the lid is
# authored with the hinge already at its own origin.  Parent the lid to the
# body at this offset and rotating it about local +X opens it.
CHEST_HALF_WIDTH = 0.45
CHEST_HALF_DEPTH = 0.25
CHEST_FOOT_HEIGHT = 0.06
CHEST_BODY_TOP = 0.48
CHEST_LID_RISE = 0.20
CHEST_BAND_X = (-0.30, 0.0, 0.30)
CHEST_HINGE_OFFSET = (0.0, CHEST_HALF_DEPTH, CHEST_BODY_TOP * 0.5)

# Anything lathed round and small looks best at 10-12 sides; past that the
# silhouette stops improving and the file just gets fatter.
ROUND_SEGMENTS = 12


# --------------------------------------------------------------------------
# Shared shapes
# --------------------------------------------------------------------------
def centre_origin(obj):
    """Put the pivot at the middle of the bounding box.

    Two steps, because :func:`set_origin` only bakes the *object* offset into
    the mesh: first drop the object onto the world origin, then slide the mesh
    so its bounds straddle it.  The reveal spin is a plain local rotation, so
    anything off-centre reads as a wobble.
    """
    set_origin(obj, (0.0, 0.0, 0.0))
    coords = [vert.co for vert in obj.data.vertices]
    low = Vector((min(c.x for c in coords), min(c.y for c in coords), min(c.z for c in coords)))
    high = Vector((max(c.x for c in coords), max(c.y for c in coords), max(c.z for c in coords)))
    obj.data.transform(Matrix.Translation(-(low + high) * 0.5))
    return obj


def arc_points(count, radius, start_deg, end_deg, squash=1.0):
    """``count`` points along an arc in a plane, both ends included.

    ``squash`` scales the second axis, which is how a horseshoe stays circular
    but a barrel-vault lid can be a flattened half-round.
    """
    span = math.radians(end_deg - start_deg)
    start = math.radians(start_deg)
    return [
        (
            math.cos(start + span * i / (count - 1)) * radius,
            math.sin(start + span * i / (count - 1)) * radius * squash,
        )
        for i in range(count)
    ]


def slot_outline(count, half_width, half_length, centre_z=0.0):
    """Points around a stadium (a rectangle with semicircular ends) in XZ.

    Used for both the needle head and the eye punched through it, so the wall
    between them stays an even thickness the whole way round.  ``count`` must
    be even or the four corners of the straight sides land off-axis.
    """
    cap = max(half_length - half_width, 0.0)
    points = []
    for i in range(count):
        angle = TAU * i / count
        offset = cap if math.sin(angle) >= 0.0 else -cap
        points.append((math.cos(angle) * half_width,
                       math.sin(angle) * half_width + offset + centre_z))
    return points


def plate_with_hole(name, outer, inner, half_thickness, color=None, family="Prop",
                    inner_color=None):
    """A flat plate in the XZ plane with a matching hole through it.

    ``outer`` and ``inner`` are equal-length (x, z) outlines wound the same
    way; the plate is extruded +/-``half_thickness`` along Y.  Faces are built
    front, back, outer rim, hole wall -- so the hole wall is always the last
    ``len(inner)`` polygons and ``inner_color`` can find it without a
    predicate.
    """
    count = len(outer)
    verts = [(x, -half_thickness, z) for x, z in outer]
    verts += [(x, half_thickness, z) for x, z in outer]
    verts += [(x, -half_thickness, z) for x, z in inner]
    verts += [(x, half_thickness, z) for x, z in inner]
    o_front, o_back, i_front, i_back = 0, count, 2 * count, 3 * count

    faces = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((o_front + i, o_front + j, i_front + j, i_front + i))
    for i in range(count):
        j = (i + 1) % count
        faces.append((o_back + j, o_back + i, i_back + i, i_back + j))
    for i in range(count):
        j = (i + 1) % count
        faces.append((o_front + j, o_front + i, o_back + i, o_back + j))
    for i in range(count):
        j = (i + 1) % count
        faces.append((i_front + i, i_front + j, i_back + j, i_back + i))

    plate = from_points(name, verts, faces, color=color, family=family)
    if inner_color is not None:
        paint(plate, inner_color, family=family,
              faces=list(range(3 * count, 4 * count)))
    return plate


def extrude_outline(name, outline, bottom, top, color=None, family="Prop"):
    """Extrude a closed (x, y) outline along Z into a capped prism.

    The outline must be wound counter-clockwise seen from +Z.  Concave outlines
    are fine -- the horseshoe is a U and its caps are one n-gon each, which the
    glTF exporter triangulates on the way out.
    """
    count = len(outline)
    verts = [(x, y, bottom) for x, y in outline] + [(x, y, top) for x, y in outline]
    faces = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    faces.append(tuple(range(count - 1, -1, -1)))
    faces.append(tuple(range(count, 2 * count)))
    return from_points(name, verts, faces, color=color, family=family)


def sweep_section(name, section, x_start, x_end, color=None, family="Prop"):
    """Sweep a closed (y, z) cross-section along X into a capped solid.

    The chest lid and its iron straps are all the same arch at four different
    radii and widths, so they all come from here.  Wind the section
    counter-clockwise seen from +X.
    """
    count = len(section)
    verts = [(x_start, y, z) for y, z in section] + [(x_end, y, z) for y, z in section]
    faces = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    faces.append(tuple(range(count - 1, -1, -1)))
    faces.append(tuple(range(count, 2 * count)))
    return from_points(name, verts, faces, color=color, family=family)


def faceted_gem(name, radius, height, sides=8, table=0.45, color="glass",
                family="Glass"):
    """A cut stone: pointed pavilion, a girdle at the widest ring, flat table.

    Left flat-shaded on purpose -- the whole point of a gem is that every facet
    catches the sun at a different moment as it spins.
    """
    gem = from_profile(
        name,
        [
            (0.0, -height * 0.5),
            (radius * 0.55, -height * 0.18),
            (radius, 0.0),
            (radius * table, height * 0.5),
        ],
        segments=sides, color=color, family=family,
    )
    flat(gem)
    return gem


def needle_shaft(name, color, radius, top_z):
    """The tapered body shared by both needles: a point at -Z, a swell, a neck.

    The tip is a lathe pole rather than a blunt cap so the silhouette actually
    comes to a point when it is lying flat on a bale.
    """
    shaft = from_profile(
        name,
        [
            (0.0, -NEEDLE_HALF),
            (radius * 0.30, -NEEDLE_HALF + 0.014),
            (radius * 0.58, -NEEDLE_HALF + 0.034),
            (radius * 0.85, -NEEDLE_HALF + 0.062),
            (radius, -0.004),
            (radius * 0.92, top_z),
        ],
        segments=NEEDLE_SHAFT_SEGMENTS, color=color, family="Metal",
    )
    smooth(shaft, 50)
    return shaft


def chain_link(name, loc, upright, color="gold"):
    """One link of the pocket watch chain, alternating plane so it reads as a
    chain rather than a stack of washers."""
    link = torus(name, major=0.012, minor=0.004, major_seg=6, minor_seg=3, loc=loc,
                 rot=(math.radians(90) if upright else 0.0, 0.0, 0.0),
                 color=color, family="Metal")
    smooth(link, 50)
    return link


# --------------------------------------------------------------------------
# The needles
# --------------------------------------------------------------------------
def build_needle():
    """The hero object: 0.16 m of polished steel with a real punched eye."""
    shaft = needle_shaft("Shaft", "metal", 0.0055, 0.030)
    # A bleached tip sells "sharp" from further away than the taper alone does.
    paint(shaft, "white", family="Metal",
          faces=select_faces(shaft, lambda c, n: c.z < -0.058))

    head = plate_with_hole(
        "Head",
        slot_outline(EYE_SEGMENTS, 0.0115, 0.032, centre_z=0.048),
        slot_outline(EYE_SEGMENTS, 0.0050, 0.021, centre_z=0.050),
        half_thickness=0.0035,
        color="metal", family="Metal", inner_color="metal_dark",
    )
    flat(head)
    bevel(head, NEEDLE_CHAMFER, NEEDLE_CHAMFER_SEGMENTS)

    needle = join([shaft, head], "Needle")
    centre_origin(needle)
    report(needle)
    export_glb(needle, "needle")


def build_needle_golden():
    """The rare drop: same silhouette, gold, with a collar and a set stone."""
    shaft = needle_shaft("Shaft", "gold", 0.0062, 0.028)

    # A turned collar where the shaft meets the head -- the cheapest possible
    # signal that this one was made by a jeweller and the plain one was not.
    collar = from_profile("Collar", [(0.0075, 0.006), (0.0135, 0.013), (0.0075, 0.020)],
                          segments=NEEDLE_SHAFT_SEGMENTS, color="gold", family="Metal")
    smooth(collar, 50)

    head = plate_with_hole(
        "Head",
        slot_outline(EYE_SEGMENTS, 0.0145, 0.035, centre_z=0.045),
        slot_outline(EYE_SEGMENTS, 0.0058, 0.020, centre_z=0.046),
        half_thickness=0.0042,
        color="gold", family="Metal", inner_color=shade("gold", 0.55),
    )
    flat(head)
    bevel(head, NEEDLE_CHAMFER, NEEDLE_CHAMFER_SEGMENTS)

    gem = faceted_gem("Stone", radius=0.011, height=0.024, sides=6, color="glass")
    place(gem, loc=(0.0, 0.0, 0.090))

    needle = join([shaft, collar, head, gem], "NeedleGolden")
    centre_origin(needle)
    report(needle)
    export_glb(needle, "needle_golden")


# --------------------------------------------------------------------------
# The easter egg
# --------------------------------------------------------------------------
UFO_RADIUS = 0.60
UFO_LIGHT_COUNT = 8
UFO_STRUT_COUNT = 3
UFO_STRUT_TILT = math.radians(16)
UFO_STRUT_LENGTH = 0.22
UFO_HIP_RADIUS = 0.32
UFO_HIP_Z = -0.10


def build_ufo():
    """A 1.2 m saucer: two lathed domes meeting at a sharp rim.

    Both domes stop at exactly ``UFO_RADIUS`` at z=0 so the hull closes without
    a visible seam, and the rim stays a hard edge -- that knife edge is most of
    what makes a lens read as a flying saucer instead of a pebble.
    """
    upper = from_profile(
        "HullUpper",
        [(UFO_RADIUS, 0.0), (0.53, 0.06), (0.36, 0.12), (0.0, 0.155)],
        segments=14, color="metal", family="Metal", close_bottom=False,
    )
    smooth(upper, 46)

    lower = from_profile(
        "HullLower",
        [(0.0, -0.13), (0.32, -0.09), (0.52, -0.035), (UFO_RADIUS, 0.0)],
        segments=14, color="metal_dark", family="Metal", close_top=False,
    )
    smooth(lower, 46)
    # The tractor-beam glow on the belly costs nothing but a second paint pass.
    paint(lower, "ufo", family="Emit",
          faces=select_faces(lower, lambda c, n: c.z < -0.105))

    canopy = from_profile(
        "Canopy",
        [(0.24, 0.13), (0.20, 0.20), (0.11, 0.25), (0.0, 0.27)],
        segments=ROUND_SEGMENTS, color="ufo_glass", family="Glass", close_bottom=False,
    )
    smooth(canopy, 46)

    parts = [upper, lower, canopy]
    for i in range(UFO_LIGHT_COUNT):
        angle = TAU * i / UFO_LIGHT_COUNT
        parts.append(icosphere(
            f"Light{i}", radius=0.045, subdivisions=1,
            loc=(math.cos(angle) * 0.55, math.sin(angle) * 0.55, -0.018),
            color="ufo", family="Emit",
        ))

    # Walk out from the hip along the tilted leg axis to find the midpoint of a
    # strut and the pad under it; the ring of legs is just this, spun.
    mid_r = UFO_HIP_RADIUS + math.sin(UFO_STRUT_TILT) * UFO_STRUT_LENGTH * 0.5
    mid_z = UFO_HIP_Z - math.cos(UFO_STRUT_TILT) * UFO_STRUT_LENGTH * 0.5
    foot_r = UFO_HIP_RADIUS + math.sin(UFO_STRUT_TILT) * UFO_STRUT_LENGTH
    foot_z = UFO_HIP_Z - math.cos(UFO_STRUT_TILT) * UFO_STRUT_LENGTH
    for i in range(UFO_STRUT_COUNT):
        angle = TAU * i / UFO_STRUT_COUNT
        # Negative Y tilt leans the *bottom* of the leg outward; the positive
        # sign would splay the hip and tuck the feet under the hull.
        parts.append(cylinder(
            f"Strut{i}", radius=0.028, depth=UFO_STRUT_LENGTH, verts=6,
            loc=(math.cos(angle) * mid_r, math.sin(angle) * mid_r, mid_z),
            rot=(0.0, -UFO_STRUT_TILT, angle), color="metal_dark", family="Metal",
        ))
        parts.append(cylinder(
            f"Pad{i}", radius=0.070, depth=0.030, verts=8,
            loc=(math.cos(angle) * foot_r, math.sin(angle) * foot_r, foot_z),
            color="iron", family="Metal",
        ))

    saucer = join(parts, "Ufo")
    centre_origin(saucer)
    report(saucer)
    export_glb(saucer, "ufo")


# --------------------------------------------------------------------------
# Small shiny things
# --------------------------------------------------------------------------
COIN_RADIUS = 0.060
COIN_FACE_Z = 0.0060
STAR_POINTS = 5


def build_coin():
    """A fat coin: chamfered edge, a raised rim, a star standing off the face.

    The face is lathed 1.5 mm below the rim so the star sits *in* a dish rather
    than floating on a disc.
    """
    body = from_profile(
        "Coin",
        [
            (0.0, -0.0075),
            (0.050, -0.0075),
            (COIN_RADIUS, -0.0035),
            (COIN_RADIUS, 0.0035),
            (0.050, 0.0075),
            (0.042, COIN_FACE_Z),
            (0.0, COIN_FACE_Z),
        ],
        segments=ROUND_SEGMENTS, color="gold", family="Metal",
    )
    flat(body)
    paint(body, shade("gold", 0.68), family="Metal",
          faces=select_faces(body, lambda c, n: abs(n.z) < 0.4))

    # A five-pointed star: alternate outer and inner radii around the circle.
    outline = []
    for i in range(STAR_POINTS * 2):
        radius = 0.030 if i % 2 == 0 else 0.013
        angle = math.radians(90) + TAU * i / (STAR_POINTS * 2)
        outline.append((math.cos(angle) * radius, math.sin(angle) * radius))
    star = extrude_outline("Star", outline, COIN_FACE_Z - 0.001, COIN_FACE_Z + 0.005,
                           color="straw_light", family="Metal")
    flat(star)

    coin = join([body, star], "Coin")
    centre_origin(coin)
    report(coin)
    export_glb(coin, "coin")


def build_gem():
    """A cut stone with a glowing heart, so it still reads inside dark straw."""
    crystal = faceted_gem("Crystal", radius=0.050, height=0.110, sides=10,
                          color="glass", family="Glass")
    core = icosphere("Core", radius=0.022, subdivisions=1, loc=(0.0, 0.0, -0.005),
                     color="ufo_glass", family="Emit")
    smooth(core, 60)

    gem = join([crystal, core], "Gem")
    centre_origin(gem)
    report(gem)
    export_glb(gem, "gem")


HORSESHOE_OUTER = 0.095
HORSESHOE_INNER = 0.058
HORSESHOE_THICKNESS = 0.024
HORSESHOE_START_DEG = -30.0
HORSESHOE_END_DEG = 210.0
HORSESHOE_STATIONS = 9
NAIL_COUNT = 6


def build_horseshoe():
    """A U of thick iron, holes and all, lying flat with the gap toward -Y.

    Built as one extruded outline: the outer arc out, the inner arc back.  The
    two straight ends of the U are just the closing quads, which is why the
    heels come out square like a real shoe rather than rounded.
    """
    outer = arc_points(HORSESHOE_STATIONS, HORSESHOE_OUTER,
                       HORSESHOE_START_DEG, HORSESHOE_END_DEG)
    inner = arc_points(HORSESHOE_STATIONS, HORSESHOE_INNER,
                       HORSESHOE_START_DEG, HORSESHOE_END_DEG)
    shoe = extrude_outline("Shoe", outer + inner[::-1], 0.0, HORSESHOE_THICKNESS,
                           color="iron", family="Metal")
    flat(shoe)

    mid_radius = (HORSESHOE_OUTER + HORSESHOE_INNER) * 0.5
    # The inner wall is the edge a hoof wears bright; the top face is scuffed
    # but not polished, so it only lifts one step.
    paint(shoe, "metal", family="Metal", faces=select_faces(
        shoe, lambda c, n: abs(n.z) < 0.3 and math.hypot(c.x, c.y) < mid_radius))
    paint(shoe, "metal_dark", family="Metal",
          faces=select_faces(shoe, lambda c, n: n.z > 0.9))

    nails = []
    for i in range(NAIL_COUNT):
        angle = math.radians(HORSESHOE_START_DEG + 18.0
                             + (HORSESHOE_END_DEG - HORSESHOE_START_DEG - 36.0)
                             * i / (NAIL_COUNT - 1))
        nails.append(cylinder(
            f"Nail{i}", radius=0.0075, depth=0.020, verts=6,
            loc=(math.cos(angle) * mid_radius, math.sin(angle) * mid_radius, 0.011),
            color="black", family="Metal",
        ))

    horseshoe = join([shoe] + nails, "Horseshoe")
    centre_origin(horseshoe)
    report(horseshoe)
    export_glb(horseshoe, "horseshoe")


WATCH_RADIUS = 0.058
WATCH_DIAL_Z = 0.013
WATCH_TICKS = 12
WATCH_CHAIN_LINKS = 5


def build_pocket_watch():
    """A brass hunter watch lying dial-up, lid thrown open, chain trailing +Y.

    The dial is the top ring of the case lathe, so the white face costs nothing
    but a paint pass; only the hands, ticks and lid are extra geometry.
    """
    case = from_profile(
        "Case",
        [
            (0.0, -0.014),
            (0.048, -0.014),
            (WATCH_RADIUS, -0.006),
            (WATCH_RADIUS, 0.008),
            (0.046, WATCH_DIAL_Z),
            (0.0, WATCH_DIAL_Z),
        ],
        segments=ROUND_SEGMENTS, color="gold", family="Metal",
    )
    flat(case)
    paint(case, "white", family="Prop",
          faces=select_faces(case, lambda c, n: n.z > 0.95 and c.z > WATCH_DIAL_Z - 0.001))
    paint(case, shade("gold", 0.72), family="Metal",
          faces=select_faces(case, lambda c, n: n.z < -0.95))

    parts = [case]
    for i in range(WATCH_TICKS):
        angle = TAU * i / WATCH_TICKS
        quarter = i % 3 == 0
        parts.append(cube(
            f"Tick{i}",
            size=(0.013 if quarter else 0.008, 0.005 if quarter else 0.003, 0.003),
            loc=(math.cos(angle) * 0.036, math.sin(angle) * 0.036, WATCH_DIAL_Z + 0.0015),
            rot=(0.0, 0.0, angle), color="black",
        ))

    # Ten past ten -- the pose every watch in every catalogue is photographed
    # in, and the one arrangement where neither hand hides the other.  Dial
    # angles run anticlockwise from +Y: hour h sits at 90 - 30h degrees.
    for name, length, angle_deg in (("HandHour", 0.024, 145.0), ("HandMinute", 0.034, 30.0)):
        angle = math.radians(angle_deg)
        parts.append(cube(
            name, size=(length, 0.004, 0.003),
            loc=(math.cos(angle) * length * 0.5, math.sin(angle) * length * 0.5,
                 WATCH_DIAL_Z + 0.003),
            rot=(0.0, 0.0, angle), color="black",
        ))
    parts.append(cylinder("Pin", radius=0.005, depth=0.006, verts=6,
                          loc=(0.0, 0.0, WATCH_DIAL_Z + 0.003), color="gold", family="Metal"))

    parts.append(cylinder("Stem", radius=0.009, depth=0.016, verts=6,
                          loc=(0.0, 0.066, 0.0), rot=(math.radians(90), 0.0, 0.0),
                          color="gold", family="Metal"))
    bow = torus("Bow", major=0.015, minor=0.005, major_seg=8, minor_seg=3,
                loc=(0.0, 0.086, 0.0), color="gold", family="Metal")
    smooth(bow, 50)
    parts.append(bow)

    for i in range(WATCH_CHAIN_LINKS):
        parts.append(chain_link(f"Link{i}", (0.0, 0.108 + i * 0.020, 0.0), upright=i % 2 == 1))

    # The lid hangs back off its hinge at the -Y rim rather than sitting shut,
    # so the dial stays visible in the reveal.  A positive X rotation carries
    # the far edge up and over the hinge; the negative one buries it in the case.
    lid = from_profile("Lid", [(WATCH_RADIUS, 0.0), (0.050, 0.008), (0.0, 0.012)],
                       segments=ROUND_SEGMENTS, color="gold", family="Metal")
    flat(lid)
    hinge = Vector((0.0, -WATCH_RADIUS, 0.002))
    tilt = math.radians(118)
    basis = Euler((tilt, 0.0, 0.0), "XYZ").to_matrix()
    place(lid, loc=tuple(hinge - basis @ Vector((0.0, -WATCH_RADIUS, 0.0))),
          rot=(tilt, 0.0, 0.0))
    apply_transform(lid)
    parts.append(lid)

    watch = join(parts, "PocketWatch")
    centre_origin(watch)
    report(watch)
    export_glb(watch, "pocket_watch")


# Outline of the arrowhead in XZ, tip first and running counter-clockwise seen
# from +Y, so the front shell has to be wound backwards to face -Y.
# Hand-placed: barbs and a tang, because a symmetric leaf shape reads as a
# generic dart rather than something somebody chipped out of a rock.
ARROWHEAD_OUTLINE = (
    (0.000, 0.055),
    (0.024, 0.012),
    (0.030, -0.012),
    (0.012, -0.006),
    (0.010, -0.038),
    (-0.010, -0.038),
    (-0.012, -0.006),
    (-0.030, -0.012),
    (-0.024, 0.012),
)
ARROWHEAD_HALF_THICKNESS = 0.008


def build_arrowhead():
    """Knapped flint: two shallow fans meeting at a central ridge.

    Family is ``Prop``, not ``Metal`` -- flint is the one treasure in here that
    must not catch a specular highlight, or it stops looking like stone.
    """
    verts = [(x, 0.0, z) for x, z in ARROWHEAD_OUTLINE]
    count = len(verts)
    verts.append((0.0, -ARROWHEAD_HALF_THICKNESS, 0.004))
    verts.append((0.0, ARROWHEAD_HALF_THICKNESS, 0.004))
    front, back = count, count + 1

    faces = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((front, j, i))
        faces.append((back, i, j))

    head = from_points("Arrowhead", verts, faces, color="stone_dark")
    # Real knapping leaves no two flakes alike; a hair of noise does the same
    # job and keeps the facets from looking machined.
    jitter(head, 0.0016, seed=7)
    flat(head)
    paint(head, "stone", faces=select_faces(head, lambda c, n: n.x > 0.1))
    centre_origin(head)
    report(head)
    export_glb(head, "arrowhead")


BONE_LENGTH = 0.34
BONE_KNOB_RADIUS = 0.046
BONE_KNOB_SPREAD = 0.030
# Knob centres pulled in by their own radius so ``BONE_LENGTH`` is the real
# tip-to-tip length, and a shaft that stops short of them.
BONE_KNOB_Z = BONE_LENGTH * 0.5 - BONE_KNOB_RADIUS
BONE_SHAFT_HALF = BONE_KNOB_Z + 0.006


def build_bone():
    """A cartoon femur: a pinched shaft with two knobs at each end.

    Laid down along Y so it lies flat in the straw; the reveal spin does the
    rest of the work of showing it off.  The shaft keeps its end caps -- the
    outboard knob does not quite cover the far side of the ring, and an open
    tube end is visible as a hole from underneath.
    """
    shaft = from_profile(
        "Shaft",
        [(0.030, -BONE_SHAFT_HALF), (0.023, -0.060), (0.021, 0.0),
         (0.023, 0.060), (0.030, BONE_SHAFT_HALF)],
        segments=8, color="cow_hide",
    )
    smooth(shaft, 50)

    knobs = []
    for i, (x, z) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        knob = icosphere(f"Knob{i}", radius=BONE_KNOB_RADIUS, subdivisions=1,
                         loc=(x * BONE_KNOB_SPREAD, 0.0, z * BONE_KNOB_Z),
                         color="cow_hide")
        smooth(knob, 50)
        # The faces turned back toward the shaft go a shade warmer, so the pair
        # of knobs at each end reads as two lumps and not one.
        paint(knob, shade("cow_hide", 0.86),
              faces=select_faces(knob, lambda c, n: n.z * z < -0.2))
        knobs.append(knob)

    bone = join([shaft] + knobs, "Bone")
    place(bone, rot=(math.radians(90), 0.0, 0.0))
    apply_transform(bone)
    centre_origin(bone)
    report(bone)
    export_glb(bone, "bone")


RING_RADIUS = 0.045


def build_ring():
    """A gold band standing upright with a cyan stone in a raised setting."""
    band = torus("Band", major=RING_RADIUS, minor=0.011, major_seg=ROUND_SEGMENTS,
                 minor_seg=5, rot=(math.radians(90), 0.0, 0.0),
                 color="gold", family="Metal")
    smooth(band, 50)
    # The band leads the join, so its standing-up rotation has to be baked in
    # or it survives as a node rotation on the exported mesh.
    apply_transform(band)

    setting = from_profile("Setting", [(0.014, RING_RADIUS - 0.004),
                                       (0.019, RING_RADIUS + 0.008),
                                       (0.013, RING_RADIUS + 0.016)],
                           segments=6, color="gold", family="Metal")
    flat(setting)

    stone = faceted_gem("Stone", radius=0.016, height=0.028, sides=6, color="glass")
    place(stone, loc=(0.0, 0.0, RING_RADIUS + 0.028))

    ring = join([band, setting, stone], "Ring")
    centre_origin(ring)
    report(ring)
    export_glb(ring, "ring")


# --------------------------------------------------------------------------
# The chest -- two files that have to meet at the hinge
# --------------------------------------------------------------------------
def build_chest():
    """The 0.9 m body: a banded wooden box on four feet, lock plate at -Y.

    The back gets a hinge plate at exactly the depth of the front lock plate,
    which is not only true to how a chest is built but also keeps the bounding
    box symmetric so ``CHEST_HINGE_OFFSET`` stays an exact number.
    """
    body_height = CHEST_BODY_TOP - CHEST_FOOT_HEIGHT
    box = cube("Box", size=(CHEST_HALF_WIDTH * 2, CHEST_HALF_DEPTH * 2, body_height),
               loc=(0.0, 0.0, CHEST_FOOT_HEIGHT + body_height * 0.5), color="wood")
    bevel(box, 0.015, 1)
    apply_modifiers(box)
    paint(box, "wood_light", faces=select_faces(box, lambda c, n: n.z > 0.85))
    paint(box, "wood_dark", faces=select_faces(box, lambda c, n: n.z < -0.85))
    parts = [box]

    # Two battens per long side break one flat panel into three planks -- the
    # cheapest way to stop a 0.9 m box reading as a crate.
    for y in (-CHEST_HALF_DEPTH, CHEST_HALF_DEPTH):
        for z in (0.20, 0.34):
            parts.append(cube("Batten", size=(CHEST_HALF_WIDTH * 2 - 0.02, 0.012, 0.018),
                              loc=(0.0, y, z), color="wood_dark"))

    # Bands sit proud in Y but flush in Z: anything taller than the box would
    # push the bounding box past CHEST_BODY_TOP and shift the hinge offset.
    for x in CHEST_BAND_X:
        parts.append(cube("Band", size=(0.07, CHEST_HALF_DEPTH * 2 + 0.03, body_height),
                          loc=(x, 0.0, CHEST_FOOT_HEIGHT + body_height * 0.5),
                          color="iron", family="Metal"))

    for x in (-CHEST_HALF_WIDTH + 0.05, CHEST_HALF_WIDTH - 0.05):
        for y in (-CHEST_HALF_DEPTH + 0.05, CHEST_HALF_DEPTH - 0.05):
            parts.append(cube("Foot", size=(0.10, 0.10, CHEST_FOOT_HEIGHT),
                              loc=(x, y, CHEST_FOOT_HEIGHT * 0.5), color="wood_dark"))

    parts.append(cube("LockPlate", size=(0.16, 0.045, 0.15),
                      loc=(0.0, -CHEST_HALF_DEPTH, 0.36), color="gold", family="Metal"))
    # Keyhole sunk 1.5 mm behind the plate face so it reads as a hole and never
    # z-fights with it.
    parts.append(cylinder("Keyhole", radius=0.018, depth=0.024, verts=6,
                          loc=(0.0, -CHEST_HALF_DEPTH - 0.0090, 0.375),
                          rot=(math.radians(90), 0.0, 0.0), color="black", family="Metal"))
    parts.append(cube("KeyholeSlot", size=(0.016, 0.024, 0.035),
                      loc=(0.0, -CHEST_HALF_DEPTH - 0.0090, 0.352),
                      color="black", family="Metal"))
    parts.append(cube("HingePlate", size=(0.24, 0.045, 0.10),
                      loc=(0.0, CHEST_HALF_DEPTH, CHEST_BODY_TOP - 0.06),
                      color="iron", family="Metal"))

    chest = join(parts, "Chest")
    centre_origin(chest)
    report(chest)
    export_glb(chest, "chest")


def build_chest_lid():
    """The barrel-vault lid, authored with its origin already on the hinge.

    Every point is expressed relative to the hinge line, so the game can parent
    this to the chest body at ``CHEST_HINGE_OFFSET`` and rotate it about local
    +X to swing it open with no extra pivot node.
    """
    arch = arc_points(7, CHEST_HALF_DEPTH, 0.0, 180.0,
                      squash=CHEST_LID_RISE / CHEST_HALF_DEPTH)
    # Slide the arch so its hinge end sits on the origin.
    section = [(y - CHEST_HALF_DEPTH, z) for y, z in arch]
    vault = sweep_section("Vault", section, -CHEST_HALF_WIDTH, CHEST_HALF_WIDTH,
                          color="wood")
    flat(vault)
    paint(vault, "wood_light", faces=select_faces(vault, lambda c, n: n.z > 0.75))
    parts = [vault]

    # The straps are the same arch scaled about its own centre, so they stand a
    # few millimetres proud of the boards all the way over the top.
    crown_y = -CHEST_HALF_DEPTH
    strap_section = [(crown_y + (y - crown_y) * 1.06, z * 1.06 + 0.004) for y, z in section]
    for x in CHEST_BAND_X:
        parts.append(sweep_section("Strap", strap_section, x - 0.035, x + 0.035,
                                   color="iron", family="Metal"))

    parts.append(cube("Rim", size=(CHEST_HALF_WIDTH * 2 + 0.02, CHEST_HALF_DEPTH * 2 + 0.02, 0.03),
                      loc=(0.0, -CHEST_HALF_DEPTH, 0.0), color="wood_dark"))
    parts.append(cube("Hasp", size=(0.10, 0.04, 0.12),
                      loc=(0.0, -CHEST_HALF_DEPTH * 2, 0.02), color="gold", family="Metal"))

    lid = join(parts, "ChestLid")
    set_origin(lid, (0.0, 0.0, 0.0))
    report(lid)
    export_glb(lid, "chest_lid")


def build_key():
    """A brass skeleton key: scrolled bow, collar, shank, two-step bit.

    Built flat in the XZ plane so it lies like a key rather than pointing at
    the camera, and so the bow scrolls stay readable in silhouette.
    """
    shank = cylinder("Shank", radius=0.008, depth=0.130, verts=8, color="gold",
                     family="Metal")
    smooth(shank, 50)

    bow = torus("Bow", major=0.030, minor=0.008, major_seg=10, minor_seg=5,
                loc=(0.0, 0.0, 0.093), rot=(math.radians(90), 0.0, 0.0),
                color="gold", family="Metal")
    smooth(bow, 50)

    scrolls = []
    for x in (-0.030, 0.030):
        scroll = torus("Scroll", major=0.014, minor=0.005, major_seg=6, minor_seg=3,
                       loc=(x, 0.0, 0.062), rot=(math.radians(90), 0.0, 0.0),
                       color=shade("gold", 0.78), family="Metal")
        smooth(scroll, 50)
        scrolls.append(scroll)

    collar = cube("Collar", size=(0.026, 0.020, 0.014), loc=(0.0, 0.0, 0.046),
                  color=shade("gold", 0.78), family="Metal")

    bit = [
        cube("BitLong", size=(0.032, 0.008, 0.022), loc=(0.019, 0.0, -0.050),
             color="gold", family="Metal"),
        cube("BitShort", size=(0.024, 0.008, 0.014), loc=(0.015, 0.0, -0.022),
             color="gold", family="Metal"),
    ]

    key = join([shank, bow, collar] + scrolls + bit, "Key")
    centre_origin(key)
    report(key)
    export_glb(key, "key")


# --------------------------------------------------------------------------
# The gnome
# --------------------------------------------------------------------------
GNOME_HEIGHT = 0.50
GNOME_HEAD_Z = 0.315
GNOME_HAT_BASE_Z = 0.360


def build_gnome():
    """A 0.5 m garden gnome, hat tip at exactly ``GNOME_HEIGHT``.

    Proportions are pushed hard -- the hat is a third of him and the beard eats
    the whole coat front -- because at collectible size a realistic gnome just
    reads as a lumpy cylinder.  Prop family throughout except the lantern.
    """
    parts = []
    for x in (-0.055, 0.055):
        boot = cube("Boot", size=(0.085, 0.130, 0.060), loc=(x, -0.012, 0.030),
                    color="wood_dark")
        bevel(boot, 0.014, 1)
        parts.append(boot)

    coat = from_profile(
        "Coat",
        [(0.095, 0.045), (0.115, 0.100), (0.105, 0.210), (0.070, 0.265)],
        segments=10, color="denim",
    )
    smooth(coat, 44)
    parts.append(coat)

    parts.append(cylinder("Belt", radius=0.122, depth=0.034, verts=10,
                          loc=(0.0, 0.0, 0.150), color="black"))
    parts.append(cube("Buckle", size=(0.045, 0.030, 0.045), loc=(0.0, -0.115, 0.150),
                      color="gold", family="Metal"))

    head = sphere("Head", radius=0.068, segments=10, rings=5,
                  loc=(0.0, 0.0, GNOME_HEAD_Z), color="skin")
    smooth(head, 50)
    parts.append(head)
    parts.append(cone("Nose", r1=0.026, r2=0.0, depth=0.050, verts=6,
                      loc=(0.0, -0.066, GNOME_HEAD_Z - 0.005),
                      rot=(math.radians(90), 0.0, 0.0), color="skin"))

    # Beard is a cone standing on its point: wide under the nose, tapering down.
    beard = cone("Beard", r1=0.020, r2=0.088, depth=0.140, verts=10,
                 loc=(0.0, -0.020, 0.255), color="white")
    smooth(beard, 44)
    parts.append(beard)

    parts.append(cone("Hat", r1=0.115, r2=0.0, depth=GNOME_HEIGHT - GNOME_HAT_BASE_Z,
                      verts=10,
                      loc=(0.0, 0.0, (GNOME_HAT_BASE_Z + GNOME_HEIGHT) * 0.5),
                      color="barn_red"))

    # Arms hang out and down: the negative tilt drops the wrist away from the
    # body, which is what puts the hand under the lantern handle.
    for side in (-1.0, 1.0):
        arm = cylinder("Arm", radius=0.024, depth=0.130, verts=6,
                       loc=(side * 0.112, 0.0, 0.180),
                       rot=(0.0, math.radians(-22) * side, 0.0), color="denim")
        parts.append(arm)
        hand = icosphere("Hand", radius=0.030, subdivisions=1,
                         loc=(side * 0.150, 0.0, 0.122), color="skin")
        smooth(hand, 50)
        parts.append(hand)

    # A lantern in the right hand: the one place this model leaves Prop, and
    # the reason a buried gnome is still visible in a dark pocket of straw.
    # It is a glowing block between two metal caps rather than a box with a
    # light inside it -- an enclosed emitter is an emitter nobody ever sees.
    parts.append(cube("LanternGlow", size=(0.048, 0.048, 0.044), loc=(0.150, 0.0, 0.062),
                      color="gold", family="Emit"))
    for z in (0.032, 0.092):
        parts.append(cube("LanternCap", size=(0.060, 0.060, 0.016), loc=(0.150, 0.0, z),
                          color="metal_dark", family="Metal"))
    handle = torus("LanternHandle", major=0.022, minor=0.005, major_seg=8, minor_seg=3,
                   loc=(0.150, 0.0, 0.112), rot=(math.radians(90), 0.0, 0.0),
                   color="metal_dark", family="Metal")
    smooth(handle, 50)
    parts.append(handle)

    gnome = join(parts, "Gnome")
    centre_origin(gnome)
    report(gnome)
    export_glb(gnome, "gnome")


BUILDERS = {
    "needle": build_needle,
    "needle_golden": build_needle_golden,
    "ufo": build_ufo,
    "coin": build_coin,
    "gem": build_gem,
    "horseshoe": build_horseshoe,
    "pocket_watch": build_pocket_watch,
    "arrowhead": build_arrowhead,
    "bone": build_bone,
    "ring": build_ring,
    "chest": build_chest,
    "chest_lid": build_chest_lid,
    "key": build_key,
    "gnome": build_gnome,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[treasures] {name}")
        fn()
