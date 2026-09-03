"""Farm buildings: the skyline of the level.

Every one of these is read from twenty metres away long before the player walks
up to it, so the modelling effort goes into silhouette -- the gambrel kink in
the barn roof, the splayed legs under the water tower, a rotor that reads as a
rotor -- and all the surface interest comes from painting face subsets rather
than from adding geometry.

Four helpers carry most of the file.  ``plank_wall`` builds a wall box whose
long faces are pre-split into columns, which is the only reason there is
anything to paint a stripe onto.  ``angled_slab`` bridges two points in a
vertical plane and is used for every rafter, ramp, brace and door cross.
``prism`` extrudes a flat outline and makes the gables and trapezoid walls.
``taper_batten`` lays a board flat against one facet of a tapering lathe.

Two rules run through the whole file, because breaking either one is invisible
in the viewport and glaring in game:

  * No two outward faces ever share a plane.  Walls butt *inside* each other
    (one pair runs the full outer dimension, the perpendicular pair is short by
    a wall thickness and overlaps 2 cm into it) and trim is always a couple of
    centimetres proud of what it trims.
  * Roofs are solved so their underside passes just *below* the wall tops they
    land on.  A roof that lands exactly on a wall top leaves a wedge of daylight
    along the eave; the barn is walk-in, so the player would see straight
    through it.
"""

import math

# --------------------------------------------------------------------------
# Shared dimensions.  The player is 1.75 m tall with a 1.62 m eye height, so
# these numbers are the difference between "barn" and "dolls house".
# --------------------------------------------------------------------------
BARN_W, BARN_D = 12.0, 9.0
BARN_WALL_H = 5.0
BARN_RIDGE_H = 8.5
BARN_KNEE_X, BARN_KNEE_Z = 3.4, 7.3          # where the gambrel changes pitch
BARN_WALL_T = 0.3
BARN_DOOR_W, BARN_DOOR_H = 3.0, 3.4          # a real opening, walk-through
BARN_EAVE_X = 6.6                            # outer corner of the roof overhang
# Solve the lower pitch so its underside crosses the wall line 3 cm BELOW the
# top of the side walls.  Picking a round number here instead is what opens a
# 9 m daylight slot along both eaves.
BARN_PITCH = (BARN_KNEE_Z - (BARN_WALL_H - 0.03)) / (BARN_W / 2.0 - BARN_KNEE_X)
BARN_EAVE_Z = BARN_WALL_H - 0.03 - BARN_PITCH * (BARN_EAVE_X - BARN_W / 2.0)

SILO_R, SILO_H = 1.6, 9.0
SILO_SEGMENTS = 14

SHED_W, SHED_D = 4.0, 3.0
SHED_LOW_H, SHED_HIGH_H = 2.25, 2.95         # mono-pitch, low end at -X
SHED_DOOR_W, SHED_DOOR_H = 0.95, 2.05

COOP_W, COOP_D = 2.0, 1.6
COOP_LEG_H, COOP_BODY_H = 0.5, 1.05
COOP_RIDGE_H = 2.05

TOWER_LEG_SPREAD = 1.45                      # leg footprint half-width
TOWER_LEG_INSET = 0.5                        # how far the legs lean in
TOWER_DECK_Z = 3.7
TOWER_TANK_TOP = 6.05
TOWER_TANK_R = 1.5

HAYBARN_W, HAYBARN_D = 8.0, 6.0
HAYBARN_EAVE_Z, HAYBARN_RIDGE_Z = 3.45, 4.45

WINDMILL_H = 6.2
# The hub stands clear of the tower's own base radius (1.07 m at the bottom of
# the blade sweep) plus the corner battens, or the sail tips vanish into the
# tower four times per revolution.
WINDMILL_HUB = (0.0, -1.25, 5.6)
BLADE_LEN = 3.2


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------
def plank_columns(length, target=0.4):
    """How many boards fit across ``length`` at roughly ``target`` metres wide.

    Hard-coding a column count per panel makes the boarding visibly step at
    every corner, because a 1 m panel and a 4 m panel end up with wildly
    different plank widths.  Deriving it from a target width keeps one facade
    consistent, and the floor of 3 guarantees every panel is wide enough to
    show all three tones of a three-tone cycle.
    """
    return max(3, int(round(abs(length) / target)))


def plank_wall(name, size, columns, tones, family="Prop"):
    """A wall box whose two long faces are split into ``columns`` vertical strips.

    A stock cube has a single polygon per side, so there is nothing to paint a
    stripe onto.  Splitting the long faces here is what buys the barn its pink
    accent bands and the sheds their weathered plank tones without a single
    extra object.  ``tones`` is cycled column by column, so a tone may be
    repeated in the sequence to make it more common -- ("barn_red", "barn_red",
    "barn_pink") paints one accent band every third board.

    Built centred on the origin -- position it afterwards with ``place()``.
    """
    sx, sy, sz = size
    hx, hy, hz = sx / 2.0, sy / 2.0, sz / 2.0
    step = sx / columns

    verts, faces = [], []
    for i in range(columns + 1):
        x = -hx + step * i
        verts.extend([(x, -hy, -hz), (x, hy, -hz), (x, hy, hz), (x, -hy, hz)])
    for i in range(columns):
        a, b = i * 4, (i + 1) * 4
        faces.append((a + 0, b + 0, b + 3, a + 3))          # -Y
        faces.append((a + 1, a + 2, b + 2, b + 1))          # +Y
        faces.append((a + 3, b + 3, b + 2, a + 2))          # +Z
        faces.append((a + 0, a + 1, b + 1, b + 0))          # -Z
    end = columns * 4
    faces.append((3, 2, 1, 0))                              # -X cap
    faces.append((end + 0, end + 1, end + 2, end + 3))      # +X cap

    wall = from_points(name, verts, faces, color=tones[0], family=family)
    if len(tones) > 1:
        for index, tone in enumerate(tones):
            def nth_column(centre, normal, i=index):
                if abs(normal.y) < 0.7:              # only the two long faces
                    return False
                column = min(int((centre.x + hx) / step), columns - 1)
                return column % len(tones) == i
            paint(wall, tone, family=family, faces=select_faces(wall, nth_column))
    return wall


def angled_slab(name, p0, p1, span, thickness, plane="xz", offset=0.0, lift=0.0,
                color=None, family="Prop"):
    """A box bridging two points of a vertical plane: rafters, ramps, braces.

    ``plane="xz"`` takes (x, z) points and extrudes ``span`` along Y at
    y=``offset``; ``plane="yz"`` takes (y, z) points and extrudes along X at
    x=``offset``.  ``lift`` shifts the slab along its own thickness axis, which
    is how a roof panel sits *on* the rafter line instead of straddling it --
    order the points along the increasing in-plane axis (left to right, back to
    front) so that lift always points upward.

    Anything that has to sit a fixed distance above a sloped surface -- roof
    ribs on a roof panel, cleats on a ramp -- belongs in ``lift`` too.  Adding
    the offset to the z of the endpoints instead shifts it *vertically*, which
    is short by a factor of cos(pitch) and leaves an air gap.
    """
    (u0, v0), (u1, v1) = p0, p1
    du, dv = u1 - u0, v1 - v0
    length = math.hypot(du, dv)
    mu, mv = (u0 + u1) / 2.0, (v0 + v1) / 2.0

    if plane == "xz":
        angle = math.atan2(-dv, du)
        loc = (mu + math.sin(angle) * lift, offset, mv + math.cos(angle) * lift)
        return cube(name, size=(length, span, thickness), loc=loc,
                    rot=(0.0, angle, 0.0), color=color, family=family)

    angle = math.atan2(dv, du)
    loc = (offset, mu - math.sin(angle) * lift, mv + math.cos(angle) * lift)
    return cube(name, size=(span, length, thickness), loc=loc,
                rot=(angle, 0.0, 0.0), color=color, family=family)


def taper_batten(name, azimuth, p0, p1, span, thickness, shift=0.0, lift=0.0,
                 color="wood_dark", family="Prop"):
    """A board lying flat against a tapering lathe, at ``azimuth`` around it.

    ``p0``/``p1`` are (radius, z) pairs, so the board leans with the taper
    instead of standing plumb.  ``shift`` slides it tangentially and ``lift``
    pushes it radially outward -- a small negative lift buries the inside face
    in the facet, which is how a batten or a door reads as fixed *to* the wall
    rather than hovering off it.

    The euler is (0, pitch, azimuth): Blender's XYZ order applies the pitch in
    the radial plane first and then swings the whole board round to its
    azimuth, which is the one ordering that keeps the board tangential.
    """
    (r0, z0), (r1, z1) = p0, p1
    dr, dz = r1 - r0, z1 - z0
    length = math.hypot(dr, dz)
    pitch = math.atan2(-dz, dr)
    radius = (r0 + r1) / 2.0 + dz / length * lift
    height = (z0 + z1) / 2.0 - dr / length * lift
    loc = (math.cos(azimuth) * radius - math.sin(azimuth) * shift,
           math.sin(azimuth) * radius + math.cos(azimuth) * shift,
           height)
    return cube(name, size=(length, span, thickness), loc=loc,
                rot=(0.0, pitch, azimuth), color=color, family=family)


def prism(name, outline, span, y=0.0, color=None, family="Prop"):
    """Extrude a closed XZ outline ``span`` metres along Y.

    Gable ends, trapezoid walls and the coop's arched doorway are all one of
    these.  The winding is normalised so callers can list the outline in
    whichever direction reads best and still get outward-facing normals.
    """
    pts = list(outline)
    count = len(pts)
    signed_area = sum(pts[i][0] * pts[(i + 1) % count][1] - pts[(i + 1) % count][0] * pts[i][1]
                      for i in range(count))
    if signed_area < 0.0:
        pts.reverse()

    verts = [(x, y - span / 2.0, z) for x, z in pts] + [(x, y + span / 2.0, z) for x, z in pts]
    faces = []
    for i in range(1, count - 1):
        faces.append((0, i, i + 1))                                  # -Y cap
        faces.append((count, count + i + 1, count + i))              # +Y cap
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, count + i, count + j, j))                   # side
    return from_points(name, verts, faces, color=color, family=family)


def make_window(name, width, height, depth=0.12, frame="barn_trim"):
    """Four frame bars around a real opening, glazed and mullioned.  Faces -Y.

    The frame is deliberately NOT a solid box: a pane buried inside a solid
    frame never renders, and the window ships as a cream slab with a cream
    cross on it.  Front to back the stack is mullions (proud of the frame),
    glass, then a dark board closing the back of the aperture so the glazing
    always has an interior to read against whatever it is mounted on.

    Mount it with ``window_mount()`` so the frame's back edge buries itself in
    the wall while the backing board stays clear of the wall's own plane.
    """
    bar = min(0.12, width * 0.24, height * 0.24)
    open_w, open_h = width - 2.0 * bar, height - 2.0 * bar
    hd = depth / 2.0
    parts = [
        cube(f"{name}FrameTop", size=(width, depth, bar),
             loc=(0.0, 0.0, (height - bar) / 2.0), color=frame),
        cube(f"{name}FrameBot", size=(width, depth, bar),
             loc=(0.0, 0.0, -(height - bar) / 2.0), color=frame),
        cube(f"{name}FrameL", size=(bar, depth, open_h),
             loc=(-(width - bar) / 2.0, 0.0, 0.0), color=frame),
        cube(f"{name}FrameR", size=(bar, depth, open_h),
             loc=((width - bar) / 2.0, 0.0, 0.0), color=frame),
        cube(f"{name}Back", size=(open_w + 0.03, 0.03, open_h + 0.03),
             loc=(0.0, hd - 0.02, 0.0), color=shade("wood_dark", 0.45)),
        cube(f"{name}Pane", size=(open_w + 0.02, 0.025, open_h + 0.02),
             loc=(0.0, hd - 0.07, 0.0), color="glass", family="Glass"),
        cube(f"{name}MullionV", size=(0.06, 0.05, open_h + 0.02),
             loc=(0.0, -hd - 0.005, 0.0), color=frame),
        cube(f"{name}MullionH", size=(open_w + 0.02, 0.05, 0.06),
             loc=(0.0, -hd - 0.005, 0.0), color=frame),
    ]
    return join(parts, name)


def window_mount(face, depth=0.12):
    """Where to put a window whose wall's outward face is at ``face``.

    Buries the back 2 cm of the frame in the wall -- enough that no gap opens
    behind it, little enough that the backing board stays in front of the
    wall's own face and cannot z-fight with it.
    """
    return face - depth / 2.0 + 0.02


def make_ladder(name, height, width=0.42, spacing=0.55, bar=0.06,
                color="metal_dark", family="Metal"):
    """Two rails and evenly spaced rungs, climbing +Z from the ground, facing -Y.

    Rung spacing is deliberately twice life-size: at this scale a realistic
    0.3 m pitch just reads as a grey smear and costs four times the triangles.
    """
    parts = []
    for side in (-1.0, 1.0):
        parts.append(cube(f"{name}Rail{side}", size=(bar, bar, height),
                          loc=(side * width / 2.0, 0.0, height / 2.0),
                          color=color, family=family))
    rungs = max(int(height / spacing), 1)
    for i in range(rungs):
        z = height * (i + 0.5) / rungs
        parts.append(cube(f"{name}Rung{i}", size=(width, bar * 0.8, bar * 0.8),
                          loc=(0.0, 0.0, z), color=color, family=family))
    rig = join(parts, name)
    # join() inherits the first rail's origin; drop it back to the foot so
    # callers can place the ladder by where it touches the ground.
    return set_origin(rig, (0.0, 0.0, 0.0))


def sleeve(name, radius, z, thickness, segments, color, family="Metal"):
    """An open band hugging a lathed body -- the hoops on the silo and tank.

    Zero thickness, so the radius has to hug the *widest* point of the body it
    wraps (or reach the ribs standing on it).  Float it further out and you see
    straight past the band to the tank behind.
    """
    return from_profile(name, [(radius, z - thickness / 2.0), (radius, z + thickness / 2.0)],
                        segments=segments, color=color, family=family,
                        close_bottom=False, close_top=False)


# --------------------------------------------------------------------------
# The barn
# --------------------------------------------------------------------------
def _barn_walls():
    """Red walls with a pink accent board every third column, around the door.

    The two side walls run the full 12 m outer width; the back wall and the
    front piers are short by a wall thickness and overlap 2 cm into them.  That
    is what stops the four corners z-fighting: no two outward faces share the
    x = +/-6 or y = +/-4.5 planes.
    """
    stripes = ("barn_red", "barn_red", "barn_pink")
    half_w, half_d = BARN_W / 2.0, BARN_D / 2.0
    inset = half_d - BARN_WALL_T / 2.0
    butt = half_w - BARN_WALL_T + 0.02        # reach of the walls that butt between
    parts = []

    for side in (-1.0, 1.0):
        wall = plank_wall(f"SideWall{side}", (BARN_D, BARN_WALL_T, BARN_WALL_H),
                          plank_columns(BARN_D, 0.6), stripes)
        place(wall, loc=(side * (half_w - BARN_WALL_T / 2.0), 0.0, BARN_WALL_H / 2.0),
              rot=(0.0, 0.0, math.radians(90)))
        parts.append(wall)

    back = plank_wall("BackWall", (butt * 2.0, BARN_WALL_T, BARN_WALL_H),
                      plank_columns(butt * 2.0, 0.6), stripes)
    place(back, loc=(0.0, inset, BARN_WALL_H / 2.0))
    parts.append(back)

    pier_w = butt - BARN_DOOR_W / 2.0
    for side in (-1.0, 1.0):
        pier = plank_wall(f"FrontPier{side}", (pier_w, BARN_WALL_T, BARN_WALL_H),
                          plank_columns(pier_w, 0.6), stripes)
        place(pier, loc=(side * (BARN_DOOR_W / 2.0 + pier_w / 2.0), -inset, BARN_WALL_H / 2.0))
        parts.append(pier)
    # Wider than the opening so its ends bury inside the piers rather than
    # sharing their reveal faces.
    parts.append(cube("DoorHead",
                      size=(BARN_DOOR_W + 0.12, BARN_WALL_T, BARN_WALL_H - BARN_DOOR_H),
                      loc=(0.0, -inset, (BARN_WALL_H + BARN_DOOR_H) / 2.0), color="barn_red"))

    gable = [(-half_w, BARN_WALL_H), (-BARN_KNEE_X, BARN_KNEE_Z), (0.0, BARN_RIDGE_H),
             (BARN_KNEE_X, BARN_KNEE_Z), (half_w, BARN_WALL_H)]
    for side in (-1.0, 1.0):
        parts.append(prism(f"Gable{side}", gable, BARN_WALL_T, y=side * inset,
                           color="barn_red"))

    # Cream corner boards and fascias -- the trim that stops a red box reading flat.
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            parts.append(cube(f"Corner{sx}{sy}", size=(0.22, 0.22, BARN_WALL_H),
                              loc=(sx * (half_w - 0.08), sy * (half_d - 0.08), BARN_WALL_H / 2.0),
                              color="barn_trim"))
        # Tall enough that its top edge is buried in the roof slab across the
        # whole 0.16 m of its width -- a shorter board hangs off the eave.
        parts.append(cube(f"Fascia{sx}", size=(0.16, BARN_D + 0.9, 0.44),
                          loc=(sx * (BARN_EAVE_X - 0.16), 0.0, BARN_EAVE_Z + 0.02),
                          color="barn_trim"))
    return parts


def _barn_eave_fill():
    """The wedge between the wall top and the underside of the lower pitch.

    The side walls stop flat at 5 m while the roof climbs away from them, so
    without this there is a 9 m long slot of daylight above both eaves -- and
    the barn is walk-in, so it is the first thing you see from inside.  Kept a
    hair inside the wall's outer plane so the two never share a face.
    """
    outer = BARN_W / 2.0 - 0.015
    inner = BARN_W / 2.0 - BARN_WALL_T - 0.02
    span = BARN_D - 2.0 * BARN_WALL_T + 0.04           # ends buried in the gables
    z_out = BARN_KNEE_Z - BARN_PITCH * (outer - BARN_KNEE_X) + 0.04
    z_in = BARN_KNEE_Z - BARN_PITCH * (inner - BARN_KNEE_X) + 0.04
    base = BARN_WALL_H - 0.06
    parts = []
    for side in (-1.0, 1.0):
        outline = [(side * inner, base), (side * outer, base),
                   (side * outer, z_out), (side * inner, z_in)]
        parts.append(prism(f"EaveFill{side}", outline, span, color="barn_red"))
    return parts


def _barn_roof():
    """Gambrel: a steep lower pitch to the knee, a shallow one to the ridge."""
    span = BARN_D + 0.9
    parts = []
    for name, p0, p1 in (
        ("RoofLowerL", (-BARN_EAVE_X, BARN_EAVE_Z), (-BARN_KNEE_X, BARN_KNEE_Z)),
        ("RoofUpperL", (-BARN_KNEE_X - 0.05, BARN_KNEE_Z - 0.04), (0.0, BARN_RIDGE_H)),
        ("RoofUpperR", (0.0, BARN_RIDGE_H), (BARN_KNEE_X + 0.05, BARN_KNEE_Z - 0.04)),
        ("RoofLowerR", (BARN_KNEE_X, BARN_KNEE_Z), (BARN_EAVE_X, BARN_EAVE_Z)),
    ):
        panel = angled_slab(name, p0, p1, span=span, thickness=0.22, lift=0.11,
                            color="barn_roof")
        bevel(panel, 0.03, 1)
        parts.append(panel)
    parts.append(cube("RidgeCap", size=(0.5, span + 0.1, 0.24),
                      loc=(0.0, 0.0, BARN_RIDGE_H + 0.14),
                      color=shade("barn_roof", 1.35)))
    return parts


def _barn_hayloft():
    """The loft doors high on the front gable, plus the hoist beam and pulley."""
    face = -BARN_D / 2.0
    z = 6.3
    parts = [cube("LoftOpening", size=(1.5, 0.12, 1.5), loc=(0.0, face - 0.05, z),
                  color=shade("wood_dark", 0.55))]
    for sx in (-1.0, 1.0):
        parts.append(cube(f"LoftJamb{sx}", size=(0.14, 0.16, 1.8),
                          loc=(sx * 0.82, face - 0.09, z), color="barn_trim"))
        parts.append(cube(f"LoftHead{sx}", size=(1.8, 0.16, 0.14),
                          loc=(0.0, face - 0.09, z + sx * 0.82), color="barn_trim"))

    parts.append(cube("HoistBeam", size=(0.2, 1.8, 0.2), loc=(0.0, face - 0.75, 7.7),
                      color="wood_dark"))
    parts.append(angled_slab("HoistBrace", (face - 1.1, 7.55), (face + 0.0, 6.85),
                             span=0.14, thickness=0.14, plane="yz", color="wood_dark"))
    parts.append(cylinder("HoistPulley", radius=0.13, depth=0.09, verts=8,
                          loc=(0.0, face - 1.35, 7.48), rot=(0.0, math.radians(90), 0.0),
                          color="iron", family="Metal"))
    return parts


def _barn_doors():
    """Both leaves swung flat against the facade so the opening stays clear.

    Front to back: leaf, then the diagonal braces 3 cm proud of it, then the
    rails 3.5 cm proud of those.  Sharing one Y slab between the rails and the
    braces flickers at all eight junctions where they cross.
    """
    face = -(BARN_D / 2.0)
    parts = []
    for side in (-1.0, 1.0):
        near, far = side * 1.55, side * 3.05
        inner, outer = min(near, far), max(near, far)
        parts.append(cube(f"DoorLeaf{side}", size=(1.5, 0.12, BARN_DOOR_H),
                          loc=(side * 2.3, face - 0.07, BARN_DOOR_H / 2.0 + 0.05),
                          color="wood"))
        for p0, p1 in (((inner + 0.03, 0.35), (outer - 0.03, BARN_DOOR_H - 0.2)),
                       ((inner + 0.03, BARN_DOOR_H - 0.2), (outer - 0.03, 0.35))):
            parts.append(angled_slab(f"DoorBrace{side}{p0[1]}", p0, p1, span=0.06,
                                     thickness=0.16, offset=face - 0.13, color="barn_trim"))
        for rail_z in (0.3, BARN_DOOR_H - 0.15):
            parts.append(cube(f"DoorRail{side}{rail_z}", size=(1.44, 0.07, 0.16),
                              loc=(side * 2.3, face - 0.16, rail_z), color="barn_trim"))

    inset = -(BARN_D / 2.0 - BARN_WALL_T / 2.0)
    for side in (-1.0, 1.0):
        parts.append(cube(f"DoorJamb{side}", size=(0.2, BARN_WALL_T + 0.06, BARN_DOOR_H + 0.2),
                          loc=(side * (BARN_DOOR_W / 2.0 + 0.09), inset,
                               (BARN_DOOR_H + 0.2) / 2.0), color="barn_trim"))
    parts.append(cube("DoorLintel", size=(BARN_DOOR_W + 0.4, BARN_WALL_T + 0.06, 0.2),
                      loc=(0.0, inset, BARN_DOOR_H + 0.3), color="barn_trim"))
    return parts


def _barn_weather_vane():
    """A cockerel is too many triangles; an arrow and a compass cross is not."""
    z = BARN_RIDGE_H + 0.15          # just clear of the ridge cap
    parts = [
        cylinder("VaneMast", radius=0.05, depth=1.2, verts=6, loc=(0.0, -3.4, z + 0.6),
                 color="iron", family="Metal"),
        cube("VaneCrossX", size=(0.9, 0.05, 0.05), loc=(0.0, -3.4, z + 0.55),
             color="iron", family="Metal"),
        cube("VaneCrossY", size=(0.05, 0.9, 0.05), loc=(0.0, -3.4, z + 0.55),
             color="iron", family="Metal"),
        cube("VaneShaft", size=(0.06, 1.0, 0.06), loc=(0.0, -3.4, z + 1.02),
             color="gold", family="Metal"),
        cone("VaneHead", r1=0.15, r2=0.0, depth=0.34, verts=6,
             loc=(0.0, -4.02, z + 1.02), rot=(math.radians(90), 0.0, 0.0),
             color="gold", family="Metal"),
        cube("VaneFin", size=(0.04, 0.42, 0.32), loc=(0.0, -2.98, z + 1.02),
             color="gold", family="Metal"),
    ]
    return parts


def build_barn():
    """The hero building: 12 x 9 m, 8.5 m to the ridge, gable facing the player.

    The front wall is four separate boxes around a 3 x 3.4 m hole, so the player
    really can walk in; the doors are modelled open and flat against the facade
    rather than filling the opening.
    """
    parts = _barn_walls() + _barn_eave_fill() + _barn_roof() + _barn_hayloft()
    parts += _barn_doors() + _barn_weather_vane()

    # The front windows sit outboard of the swung-open door leaves (which reach
    # x = 3.05) so no two front-facing panels share an x plane.
    for name, loc, rot_z in (
        ("WinFrontL", (-4.15, window_mount(-BARN_D / 2.0), 2.8), 0.0),
        ("WinFrontR", (4.15, window_mount(-BARN_D / 2.0), 2.8), 0.0),
        ("WinSideL", (window_mount(-BARN_W / 2.0), 0.6, 2.8), -90.0),
        ("WinSideR", (-window_mount(-BARN_W / 2.0), 0.6, 2.8), 90.0),
    ):
        win = make_window(name, 1.1, 1.3)
        place(win, loc=loc, rot=(0.0, 0.0, math.radians(rot_z)))
        parts.append(win)

    barn = join(parts, "Barn")
    # The first part is a rotated wall, so bake the transform before the origin
    # moves -- otherwise the barn ships with its local axes turned 90 degrees.
    apply_transform(barn)
    flat(barn)
    set_origin(barn, (0.0, 0.0, 0.0))
    report(barn)
    export_glb(barn, "barn")


# --------------------------------------------------------------------------
# Silo
# --------------------------------------------------------------------------
def build_silo():
    """A 9 m corrugated silo: lathed body, ribbed skin, hoops and a ladder."""
    body = from_profile(
        "SiloBody",
        [(SILO_R, 0.0), (SILO_R, 7.2), (SILO_R * 0.97, 7.5), (SILO_R * 0.81, 8.05),
         (SILO_R * 0.56, 8.55), (0.0, SILO_H)],
        segments=SILO_SEGMENTS, color="metal", family="Metal", close_bottom=False,
    )
    dome = select_faces(body, lambda c, n: c.z > 7.2)
    paint(body, "metal_dark", family="Metal", faces=dome)
    smooth(body, 50)
    parts = [body]

    # Vertical ribs are what sell "corrugated" at distance; the lathe stays smooth.
    for i in range(12):
        angle = TAU * i / 12.0
        parts.append(cube(f"Rib{i}", size=(0.12, 0.1, 7.15),
                          loc=(math.cos(angle) * SILO_R, math.sin(angle) * SILO_R, 3.575),
                          rot=(0.0, 0.0, angle), color="metal_dark", family="Metal"))

    # Inside the ribs' outer face (r = 1.66) so the bands are caught by them
    # instead of floating a centimetre clear of everything.
    for z in (2.0, 4.2, 6.4):
        parts.append(sleeve(f"Hoop{z}", SILO_R + 0.04, z, 0.18, SILO_SEGMENTS, "iron"))

    # -Y is an edge midpoint on a 14-gon, not a vertex, so the skin is only
    # 1.56 m out there: park the ladder against that, not against SILO_R.  Its
    # rungs then pass through the rib at 270 degrees and read as fixed to it.
    ladder = make_ladder("SiloLadder", 6.6)
    place(ladder, loc=(0.0, -(SILO_R * math.cos(math.pi / SILO_SEGMENTS) + 0.04), 0.0))
    parts.append(ladder)

    parts.append(cylinder("Vent", radius=0.24, depth=0.36, verts=8, loc=(0.0, 0.0, 9.05),
                          color="metal_dark", family="Metal"))
    parts.append(cone("VentCap", r1=0.32, r2=0.0, depth=0.26, verts=8, loc=(0.0, 0.0, 9.34),
                      color="iron", family="Metal"))

    silo = join(parts, "Silo")
    apply_transform(silo)
    set_origin(silo, (0.0, 0.0, 0.0))
    report(silo)
    export_glb(silo, "silo")


# --------------------------------------------------------------------------
# Windmill
# --------------------------------------------------------------------------
def build_windmill():
    """A 7 m tapered octagonal tower -- 6.2 m of wall, the rest cap -- plus the rotor hub.

    The rotor ships as its own model (``windmill_blades``); mount it at
    ``WINDMILL_HUB`` rotated +90 degrees about X, which maps its local +Z onto
    -Y so the sails face the player and the rotor spins the right way round.
    (-90 puts the sails on the far side of the frame and reverses the spin.)
    """
    radii = [(1.25, 0.0), (1.12, 1.6), (0.98, 3.2), (0.86, 4.8), (0.78, WINDMILL_H)]

    def tower_radius(z):
        """Radius of the octagon's vertices at height z -- what anything bolted
        to the -Y face has to clear."""
        for (r0, z0), (r1, z1) in zip(radii, radii[1:]):
            if z <= z1:
                return r0 + (r1 - r0) * (z - z0) / (z1 - z0)
        return radii[-1][0]

    tower = from_profile("TowerBody", radii, segments=8, color="wood", family="Prop",
                         close_bottom=False)
    parts = [tower]

    parts.append(cone("TowerCap", r1=0.95, r2=0.16, depth=0.75, verts=8,
                      loc=(0.0, 0.0, WINDMILL_H + 0.34), color="barn_roof"))

    for radius, z in radii[1:4]:
        parts.append(sleeve(f"TowerBand{z}", radius + 0.04, z, 0.2, 8, "wood_dark",
                            family="Prop"))

    # Corner battens follow the taper, so they lean with it rather than standing
    # plumb like a fence post would.  All four sit on the DIAGONAL vertices of
    # the octagon: a batten at -Y would stand straight down the middle of the
    # door and through the window.
    base_r, top_r = radii[0][0], radii[-1][0]
    for i in range(4):
        azimuth = math.radians(45 + 90 * i)
        parts.append(taper_batten(f"Batten{i}", azimuth, (base_r, 0.0), (top_r, WINDMILL_H),
                                  span=0.16, thickness=0.16, lift=0.02, color="wood_dark"))

    # The door leans with the taper too and is buried 2 cm into the -Y vertex.
    # Sitting it on a plumb plane at y = -1.1 lets the tower's own corner eat
    # the bottom of it, right at eye height.
    door_h, door_r0, door_r1 = 1.95, tower_radius(0.0), tower_radius(1.95)
    face = math.radians(-90)
    parts.append(taper_batten("MillDoor", face, (door_r0, 0.0), (door_r1, door_h),
                              span=0.95, thickness=0.14, lift=0.04, color="wood_dark"))
    for side in (-1.0, 1.0):
        parts.append(taper_batten(f"MillDoorJamb{side}", face,
                                  (door_r0, 0.0), (tower_radius(2.1), 2.1),
                                  span=0.12, thickness=0.16, shift=side * 0.53, lift=0.05,
                                  color="barn_trim"))
    head_r = tower_radius(2.05)
    parts.append(cube("MillDoorHead", size=(1.2, 0.16, 0.13), loc=(0.0, -(head_r + 0.04), 2.05),
                      color="barn_trim"))

    win = make_window("MillWindow", 0.6, 0.6)
    place(win, loc=(0.0, window_mount(-tower_radius(3.6)), 3.6))
    parts.append(win)

    # A chunky mounting block passes through the wall so the hub, standing off
    # far enough for the sail tips to clear the tower, is not left in mid air.
    hub_x, hub_y, hub_z = WINDMILL_HUB
    parts.append(cube("HubBlock", size=(0.5, 0.66, 0.5), loc=(hub_x, hub_y + 0.42, hub_z),
                      color="wood_dark"))
    parts.append(cylinder("Hub", radius=0.34, depth=0.5, verts=10,
                          loc=(hub_x, hub_y + 0.05, hub_z), rot=(math.radians(90), 0.0, 0.0),
                          color="wood_dark"))
    parts.append(cone("HubNose", r1=0.3, r2=0.1, depth=0.3, verts=8,
                      loc=(hub_x, hub_y - 0.14, hub_z), rot=(math.radians(90), 0.0, 0.0),
                      color="iron", family="Metal"))

    mill = join(parts, "Windmill")
    apply_transform(mill)
    flat(mill)
    set_origin(mill, (0.0, 0.0, 0.0))
    report(mill)
    export_glb(mill, "windmill")


def build_windmill_blades():
    """The four-sail rotor, origin at the hub, sails lying in the local XY plane.

    Keeping the sails in XY means the game spins this on its local Z and never
    has to think about which way the tower faces.  Local +Z is the FRONT of the
    rotor: the cloth sits on that face of the lattice, not inside it, so mount
    the rotor with +90 degrees about X to turn +Z toward the camera.
    """
    parts = [cylinder("BladeHub", radius=0.3, depth=0.26, verts=10, color="wood_dark")]
    for i in range(4):
        spin = math.radians(90 * i)

        def spoke(x, y, z=0.0, a=spin):
            """Blade-local offset moved onto the i-th spoke.

            The parts have to be *born* on their spoke: a cube keeps its origin
            at its own centre, so rotating one after the fact spins it in place
            instead of swinging it around the hub.  ``z`` is the rotor's own
            front-to-back axis and is untouched by the spin.
            """
            return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), z)

        parts.append(cube(f"Spar{i}", size=(0.16, BLADE_LEN, 0.12),
                          loc=spoke(0.0, BLADE_LEN / 2.0 + 0.25), rot=(0.0, 0.0, spin),
                          color="wood"))
        for k in range(4):
            parts.append(cube(f"Cross{i}{k}", size=(1.0, 0.1, 0.09),
                              loc=spoke(0.0, 0.55 + k * 0.8), rot=(0.0, 0.0, spin),
                              color="wood_dark"))
        # Cloth on the outboard half of the cross bars, sitting on the front
        # face of the frame (z = 0.03..0.08) rather than buried inside it.
        parts.append(cube(f"Sail{i}", size=(0.46, 2.6, 0.05),
                          loc=spoke(0.32, BLADE_LEN / 2.0 + 0.25, 0.055),
                          rot=(0.0, 0.0, spin), color="barn_trim"))

    rotor = join(parts, "WindmillBlades")
    apply_transform(rotor)
    flat(rotor)
    set_origin(rotor, (0.0, 0.0, 0.0))
    report(rotor)
    export_glb(rotor, "windmill_blades")


# --------------------------------------------------------------------------
# Tool shed
# --------------------------------------------------------------------------
def build_shed():
    """A 4 x 3 m tool shed with a mono-pitch tin roof, one door and one window.

    The pitch runs along X, which keeps the side walls plain rectangles and puts
    the slanted edge in the front and back walls where a triangular filler
    handles it in eight triangles.  The side walls run the full outer depth and
    everything else butts between them.
    """
    planks = ("wood", "plank", "wood_light")
    board = 0.34                                   # target plank width
    half_w, half_d = SHED_W / 2.0, SHED_D / 2.0
    thickness = 0.12
    face = half_d - thickness / 2.0
    butt = half_w - thickness + 0.02               # reach of the front/back walls
    slope = (SHED_HIGH_H - SHED_LOW_H) / SHED_W

    parts = [cube("ShedFloor", size=(SHED_W - 0.1, SHED_D - 0.1, 0.12), loc=(0.0, 0.0, 0.06),
                  color="wood_dark")]

    door_min, door_max = -1.0, -1.0 + SHED_DOOR_W
    left_w, right_w = door_min + butt, butt - door_max
    left = plank_wall("ShedFrontL", (left_w, thickness, SHED_LOW_H),
                      plank_columns(left_w, board), planks)
    place(left, loc=((-butt + door_min) / 2.0, -face, SHED_LOW_H / 2.0))
    right = plank_wall("ShedFrontR", (right_w, thickness, SHED_LOW_H),
                       plank_columns(right_w, board), planks)
    place(right, loc=((door_max + butt) / 2.0, -face, SHED_LOW_H / 2.0))
    parts += [left, right]
    parts.append(cube("ShedDoorHead", size=(SHED_DOOR_W + 0.1, thickness, SHED_LOW_H - SHED_DOOR_H),
                      loc=(door_min + SHED_DOOR_W / 2.0, -face,
                           (SHED_LOW_H + SHED_DOOR_H) / 2.0), color="wood"))

    back = plank_wall("ShedBack", (butt * 2.0, thickness, SHED_LOW_H),
                      plank_columns(butt * 2.0, board), planks)
    place(back, loc=(0.0, face, SHED_LOW_H / 2.0))
    parts.append(back)

    # The filler above the front and back walls: its top edge runs a few
    # centimetres ABOVE the roof underside so it buries in the slab, and it is
    # 1 cm thicker than the wall so the two never share an outward face.
    wedge = [(-butt, SHED_LOW_H - 0.06), (butt, SHED_LOW_H - 0.06),
             (butt, SHED_HIGH_H + 0.04), (-butt, SHED_LOW_H + 0.04)]
    for side in (-1.0, 1.0):
        parts.append(prism(f"ShedWedge{side}", wedge, thickness + 0.02, y=side * face,
                           color="plank"))

    # 5 cm over-height on the side walls: the roof underside climbs away from
    # the wall line, and a wall that stops exactly on it leaves a slot.
    for side, height in ((-1.0, SHED_LOW_H + 0.05), (1.0, SHED_HIGH_H + 0.05)):
        wall = plank_wall(f"ShedSide{side}", (SHED_D, thickness, height),
                          plank_columns(SHED_D, board), planks)
        place(wall, loc=(side * (half_w - thickness / 2.0), 0.0, height / 2.0),
              rot=(0.0, 0.0, math.radians(90)))
        parts.append(wall)

    overhang = 0.35
    roof = angled_slab(
        "ShedRoof",
        (-half_w - overhang, SHED_LOW_H - overhang * slope),
        (half_w + overhang, SHED_HIGH_H + overhang * slope),
        span=SHED_D + 0.7, thickness=0.14, lift=0.07, color="metal", family="Metal",
    )
    bevel(roof, 0.03, 1)
    parts.append(roof)
    parts.append(cube("ShedFascia", size=(0.1, SHED_D + 0.7, 0.2),
                      loc=(half_w + overhang, 0.0, SHED_HIGH_H + overhang * slope - 0.06),
                      color="wood_dark"))

    door = plank_wall("ShedDoor", (SHED_DOOR_W - 0.06, 0.08, SHED_DOOR_H - 0.05),
                      plank_columns(SHED_DOOR_W - 0.06, 0.3), ("wood_dark", "wood"))
    place(door, loc=(door_min + SHED_DOOR_W / 2.0, -face - 0.09, (SHED_DOOR_H - 0.05) / 2.0))
    parts.append(door)
    # Sunk into the leaf rather than parked on its front plane.
    for z in (0.4, 1.65):
        parts.append(cube(f"ShedHinge{z}", size=(0.3, 0.04, 0.08),
                          loc=(door_min + 0.16, -face - 0.13, z), color="iron", family="Metal"))
    parts.append(cylinder("ShedKnob", radius=0.05, depth=0.1, verts=6,
                          loc=(door_max - 0.16, -face - 0.16, 1.05),
                          rot=(math.radians(90), 0.0, 0.0), color="iron", family="Metal"))

    win = make_window("ShedWindow", 0.75, 0.65)
    place(win, loc=(0.95, window_mount(-(half_d + thickness / 2.0)), 1.5))
    parts.append(win)

    shed = join(parts, "Shed")
    apply_transform(shed)
    flat(shed)
    set_origin(shed, (0.0, 0.0, 0.0))
    report(shed)
    export_glb(shed, "shed")


# --------------------------------------------------------------------------
# Chicken coop
# --------------------------------------------------------------------------
def build_chicken_coop():
    """A 2 m coop on stubby legs: ramp, arched pop-hole, nesting box, pitched roof."""
    planks = ("wood_light", "plank", "wood")
    board = 0.3
    half_w, half_d = COOP_W / 2.0, COOP_D / 2.0
    thickness = 0.1
    floor_z = COOP_LEG_H + 0.07
    eave_z = floor_z + COOP_BODY_H                 # the line the roof is set out from
    wall_h = COOP_BODY_H + 0.08                    # tops buried in the roof slab
    butt = half_w - thickness + 0.02               # reach of the eave walls
    roof_slope = (COOP_RIDGE_H - (eave_z - 0.08)) / (half_d + 0.14)
    parts = []

    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            parts.append(cube(f"CoopLeg{sx}{sy}", size=(0.14, 0.14, COOP_LEG_H + 0.1),
                              loc=(sx * (half_w - 0.16), sy * (half_d - 0.16),
                                   (COOP_LEG_H + 0.1) / 2.0), color="wood_dark"))
    parts.append(cube("CoopFloor", size=(COOP_W, COOP_D, 0.14), loc=(0.0, 0.0, floor_z - 0.07),
                      color="wood_dark"))

    body_z = floor_z + wall_h / 2.0
    for side in (-1.0, 1.0):
        # Eave walls, short by a wall thickness so they butt inside the gable walls.
        front = plank_wall(f"CoopWallY{side}", (butt * 2.0, thickness, wall_h),
                           plank_columns(butt * 2.0, board), planks)
        place(front, loc=(0.0, side * (half_d - thickness / 2.0), body_z))
        parts.append(front)
        wall = plank_wall(f"CoopWallX{side}", (COOP_D, thickness, wall_h),
                          plank_columns(COOP_D, board), planks)
        place(wall, loc=(side * (half_w - thickness / 2.0), 0.0, body_z),
              rot=(0.0, 0.0, math.radians(90)))
        parts.append(wall)

    # Gable triangles close the ends: the pitch runs across Y, so the wall tops
    # under the ridge are 40 cm short of the roof without them.  Built as an XZ
    # outline and swung 90 degrees so its extrusion lies along X.
    ridge_top = COOP_RIDGE_H + 0.03
    gable_half = (ridge_top - (floor_z + wall_h - 0.01)) / roof_slope
    gable = [(-gable_half, ridge_top - roof_slope * gable_half),
             (gable_half, ridge_top - roof_slope * gable_half), (0.0, ridge_top)]
    for side in (-1.0, 1.0):
        end = prism(f"CoopGable{side}", gable, thickness + 0.04, color="wood")
        place(end, loc=(side * (half_w - thickness / 2.0), 0.0, 0.0),
              rot=(0.0, 0.0, math.radians(90)))
        parts.append(end)

    # Arched pop-hole: a round-topped outline, drawn once and inset into a cream surround.
    hole_w, sill, shoulder = 0.22, floor_z + 0.02, floor_z + 0.32
    arch = [(-hole_w, sill), (hole_w, sill), (hole_w, shoulder)]
    for i in range(1, 4):
        angle = math.pi * i / 4.0
        arch.append((math.cos(angle) * hole_w, shoulder + math.sin(angle) * hole_w))
    arch.append((-hole_w, shoulder))
    surround = [(x * 1.35, sill - 0.03 + (z - sill) * 1.25) for x, z in arch]
    # Trim first, dark opening proud of it: the cream then reads as a border
    # rather than a lid over the hole.
    parts.append(prism("CoopArchTrim", surround, 0.06, y=-half_d - 0.01, color="barn_trim"))
    parts.append(prism("CoopArch", arch, 0.06, y=-half_d - 0.05,
                       color=shade("wood_dark", 0.5)))
    parts.append(cube("CoopLandingBoard", size=(0.62, 0.26, 0.06),
                      loc=(0.0, -half_d - 0.14, floor_z), color="wood"))

    for side in (-1.0, 1.0):
        p0 = (-half_d - 0.14, eave_z - 0.08) if side < 0 else (0.0, COOP_RIDGE_H)
        p1 = (0.0, COOP_RIDGE_H) if side < 0 else (half_d + 0.14, eave_z - 0.08)
        panel = angled_slab(f"CoopRoof{side}", p0, p1, span=COOP_W + 0.3, thickness=0.1,
                            plane="yz", lift=0.05, color="barn_red")
        bevel(panel, 0.02, 1)
        parts.append(panel)
    parts.append(cube("CoopRidge", size=(COOP_W + 0.36, 0.18, 0.1),
                      loc=(0.0, 0.0, COOP_RIDGE_H + 0.08), color=shade("barn_red", 0.8)))

    # Ramp down to the ground, cleated so the birds get some grip.  The cleats
    # clear the ramp's 7 cm top surface by half their own depth, so the whole
    # 5 cm reads as a step instead of 1.5 cm poking out of the plank.
    ramp_bottom, ramp_top = (-half_d - 1.05, 0.0), (-half_d + 0.05, floor_z)
    parts.append(angled_slab("CoopRamp", ramp_bottom, ramp_top, span=0.5, thickness=0.07,
                             plane="yz", lift=0.035, color="wood"))
    ramp_angle = math.atan2(ramp_top[1] - ramp_bottom[1], ramp_top[0] - ramp_bottom[0])
    for i in range(4):
        t = (i + 0.5) / 4.0
        y = ramp_bottom[0] + (ramp_top[0] - ramp_bottom[0]) * t
        z = ramp_bottom[1] + (ramp_top[1] - ramp_bottom[1]) * t
        parts.append(cube(f"CoopCleat{i}", size=(0.5, 0.06, 0.05),
                          loc=(0.0, y - math.sin(ramp_angle) * 0.09,
                               z + math.cos(ramp_angle) * 0.09),
                          rot=(ramp_angle, 0.0, 0.0), color="wood_dark"))

    nest_z = floor_z + 0.42
    parts.append(cube("NestBox", size=(0.5, 1.05, 0.5), loc=(half_w + 0.2, 0.0, nest_z),
                      color="wood"))
    parts.append(angled_slab("NestLid", (half_w - 0.12, nest_z + 0.3),
                             (half_w + 0.52, nest_z + 0.18), span=1.15, thickness=0.07,
                             color="barn_red"))
    parts.append(cube("NestHinge", size=(0.12, 0.9, 0.06), loc=(half_w - 0.1, 0.0, nest_z + 0.3),
                      color="iron", family="Metal"))

    coop = join(parts, "ChickenCoop")
    apply_transform(coop)
    flat(coop)
    set_origin(coop, (0.0, 0.0, 0.0))
    report(coop)
    export_glb(coop, "chicken_coop")


# --------------------------------------------------------------------------
# Water tower
# --------------------------------------------------------------------------
def build_water_tower():
    """A 6 m tank on four splayed, cross-braced legs, with a ladder up the front."""
    parts = []
    leg_run = math.hypot(TOWER_LEG_INSET * math.sqrt(2.0), TOWER_DECK_Z)
    # A tilted leg is shorter in Z than it is long: centre it on half its
    # VERTICAL extent, or all four feet end up 5 cm underground.
    leg_len = leg_run + 0.1
    leg_mid = leg_len * (TOWER_DECK_Z / leg_run) / 2.0
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            # Each leg leans in on both axes; solve the euler that aims local +Z
            # straight at the deck corner rather than eyeballing two angles.
            rx = math.asin(sy * TOWER_LEG_INSET / leg_run)
            ry = math.asin(-sx * TOWER_LEG_INSET / (leg_run * math.cos(rx)))
            parts.append(cube(f"TowerLeg{sx}{sy}", size=(0.18, 0.18, leg_len),
                              loc=(sx * (TOWER_LEG_SPREAD - TOWER_LEG_INSET / 2.0),
                                   sy * (TOWER_LEG_SPREAD - TOWER_LEG_INSET / 2.0),
                                   leg_mid),
                              rot=(rx, ry, 0.0), color="wood", family="Prop"))

    ring_z = 1.9
    ring_r = TOWER_LEG_SPREAD - TOWER_LEG_INSET * ring_z / TOWER_DECK_Z
    for side in (-1.0, 1.0):
        parts.append(cube(f"TowerRingX{side}", size=(ring_r * 2.0, 0.1, 0.14),
                          loc=(0.0, side * ring_r, ring_z), color="wood_dark"))
        parts.append(cube(f"TowerRingY{side}", size=(0.1, ring_r * 2.0, 0.14),
                          loc=(side * ring_r, 0.0, ring_z), color="wood_dark"))
        parts.append(angled_slab(f"TowerBraceX{side}", (-1.3, 0.4), (1.15, ring_z),
                                 span=0.1, thickness=0.12, offset=side * (ring_r + 0.06),
                                 color="wood_dark"))
        parts.append(angled_slab(f"TowerBraceY{side}", (-1.3, 0.4), (1.15, ring_z),
                                 span=0.1, thickness=0.12, plane="yz",
                                 offset=side * (ring_r + 0.06), color="wood_dark"))

    deck = TOWER_DECK_Z
    tank = from_profile(
        "TankBody",
        [(1.35, deck - 0.15), (TOWER_TANK_R, deck + 0.05), (TOWER_TANK_R, deck + 1.65),
         (1.35, deck + 1.85), (0.85, deck + 2.15), (0.0, TOWER_TANK_TOP)],
        segments=12, color="metal", family="Metal",
    )
    smooth(tank, 50)
    parts.append(tank)
    lid = select_faces(tank, lambda c, n: c.z > deck + 1.85)
    paint(tank, "metal_dark", family="Metal", faces=lid)
    # 5 mm outside the tank's widest point: a hoop parked at 1.54 hovers up to
    # 9 cm off the 12-gon's flats with nothing bridging the gap.
    for z in (deck + 0.45, deck + 1.25):
        parts.append(sleeve(f"TankHoop{z}", TOWER_TANK_R + 0.005, z, 0.16, 12, "iron"))
    parts.append(cylinder("TankVent", radius=0.13, depth=0.32, verts=6,
                          loc=(0.0, 0.0, TOWER_TANK_TOP + 0.06), color="iron", family="Metal"))
    # Inboard of the 12-gon's flats (1.449 m) and run 15 cm past the deck so the
    # top of the pipe buries itself in the tank's shoulder instead of stopping
    #13 cm short of it.
    pipe_r = 1.3 / math.sqrt(2.0)
    parts.append(cylinder("DownPipe", radius=0.09, depth=deck + 0.15, verts=6,
                          loc=(pipe_r, pipe_r, (deck + 0.15) / 2.0), color="metal_dark",
                          family="Metal"))

    # Stopped 20 cm below the deck -- the tank's -Y vertex reaches out to 1.5 m,
    # so a taller ladder swallows its own top rung -- and pulled in against the
    # bracing ring so it has something to be bolted to.
    ladder = make_ladder("TowerLadder", deck - 0.2, color="iron")
    place(ladder, loc=(0.0, -(ring_r + 0.05), 0.0))
    parts.append(ladder)

    tower = join(parts, "WaterTower")
    apply_transform(tower)
    set_origin(tower, (0.0, 0.0, 0.0))
    report(tower)
    export_glb(tower, "water_tower")


# --------------------------------------------------------------------------
# Open hay barn
# --------------------------------------------------------------------------
def build_hay_barn():
    """An open-sided pole barn, 8 x 6 m: six posts, a back wall, a corrugated roof.

    The game stacks bales under it, so three of the four sides stay wide open and
    the roof ribs are the only decoration that survives the triangle budget.
    """
    half_w, half_d = HAYBARN_W / 2.0, HAYBARN_D / 2.0
    post_y = half_d - 0.3
    parts = []

    for x in (-half_w + 0.3, 0.0, half_w - 0.3):
        for y in (-post_y, post_y):
            parts.append(cube(f"Post{x}{y}", size=(0.26, 0.26, HAYBARN_EAVE_Z),
                              loc=(x, y, HAYBARN_EAVE_Z / 2.0), color="wood"))

    for side in (-1.0, 1.0):
        parts.append(cube(f"EaveBeam{side}", size=(HAYBARN_W, 0.2, 0.3),
                          loc=(0.0, side * post_y, HAYBARN_EAVE_Z - 0.15),
                          color="wood_dark"))
    parts.append(cube("RidgeBeam", size=(HAYBARN_W, 0.2, 0.28),
                      loc=(0.0, 0.0, HAYBARN_RIDGE_Z - 0.14), color="wood_dark"))
    for x in (-half_w + 0.3, 0.0, half_w - 0.3):
        parts.append(cube(f"KingPost{x}", size=(0.16, 0.16, HAYBARN_RIDGE_Z - HAYBARN_EAVE_Z),
                          loc=(x, 0.0, (HAYBARN_RIDGE_Z + HAYBARN_EAVE_Z) / 2.0),
                          color="wood_dark"))

    eave = (half_d + 0.35, HAYBARN_EAVE_Z)
    ridge = (0.0, HAYBARN_RIDGE_Z)
    for side in (-1.0, 1.0):
        p0 = (-eave[0], eave[1]) if side < 0 else ridge
        p1 = ridge if side < 0 else eave
        panel = angled_slab(f"HayRoof{side}", p0, p1, span=HAYBARN_W + 0.6, thickness=0.12,
                            plane="yz", lift=0.06, color="metal", family="Metal")
        parts.append(panel)
        # Same rafter line as the panel, lifted PERPENDICULAR to it: the panel
        # occupies 0 to 0.12 across its own thickness, so a rib lifted 0.14
        # bites 1 cm into it.  Adding the offset to the z of the endpoints
        # instead is short by cos(pitch) and leaves the ribs hovering.
        for i in range(5):
            x = -half_w - 0.2 + (HAYBARN_W + 0.4) * i / 4.0
            parts.append(angled_slab(f"HayRib{side}{i}", p0, p1, span=0.1, thickness=0.06,
                                     plane="yz", offset=x, lift=0.14,
                                     color="metal_dark", family="Metal"))
    parts.append(cube("HayRidgeCap", size=(HAYBARN_W + 0.6, 0.34, 0.14),
                      loc=(0.0, 0.0, HAYBARN_RIDGE_Z + 0.13), color="metal_dark",
                      family="Metal"))

    # Nailed to the back posts, not floating 5 cm behind them, and tall enough
    # that its top edge is inside the roof slab at its own front face.
    back_y = post_y
    thickness = 0.12
    slope = (HAYBARN_RIDGE_Z - HAYBARN_EAVE_Z) / eave[0]
    back_h = HAYBARN_RIDGE_Z - slope * (back_y - thickness / 2.0) + 0.04
    back = plank_wall("HayBackWall", (HAYBARN_W, thickness, back_h),
                      plank_columns(HAYBARN_W, 0.55), ("wood", "plank", "wood_light"))
    place(back, loc=(0.0, back_y, back_h / 2.0))
    parts.append(back)

    barn = join(parts, "HayBarn")
    apply_transform(barn)
    flat(barn)
    set_origin(barn, (0.0, 0.0, 0.0))
    report(barn)
    export_glb(barn, "hay_barn")


BUILDERS = {
    "barn": build_barn,
    "silo": build_silo,
    "windmill": build_windmill,
    "windmill_blades": build_windmill_blades,
    "shed": build_shed,
    "chicken_coop": build_chicken_coop,
    "water_tower": build_water_tower,
    "hay_barn": build_hay_barn,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[structures] {name}")
        fn()
