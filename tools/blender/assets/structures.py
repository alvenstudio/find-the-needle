"""Farm buildings: the skyline of the level.

Every one of these is read from twenty metres away long before the player walks
up to it, so the modelling effort goes into silhouette -- the gambrel kink in
the barn roof, the splayed legs under the water tower, a rotor that reads as a
rotor -- and all the surface interest comes from painting face subsets rather
than from adding geometry.

Three helpers carry most of the file.  ``plank_wall`` builds a wall box whose
long faces are pre-split into columns, which is the only reason there is
anything to paint a stripe onto.  ``angled_slab`` bridges two points in a
vertical plane and is used for every rafter, ramp, brace and door cross.
``prism`` extrudes a flat outline and makes the gables and trapezoid walls.
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
BARN_EAVE_X, BARN_EAVE_Z = 6.6, 4.5          # outer corner of the roof overhang

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

HAYBARN_W, HAYBARN_D = 8.0, 6.0
HAYBARN_EAVE_Z, HAYBARN_RIDGE_Z = 3.45, 4.45

WINDMILL_H = 6.2
WINDMILL_HUB = (0.0, -0.95, 5.6)             # where the rotor mounts
BLADE_LEN = 3.2


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------
def plank_wall(name, size, columns, tones, family="Prop"):
    """A wall box whose two long faces are split into ``columns`` vertical strips.

    A stock cube has a single polygon per side, so there is nothing to paint a
    stripe onto.  Splitting the long faces here is what buys the barn its pink
    accent bands and the sheds their weathered plank tones without a single
    extra object.  ``tones`` is cycled column by column.

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


def make_window(name, width, height, depth=0.16, frame="barn_trim"):
    """Frame, glazing and a pair of mullions, joined and centred on the origin.

    Surface-mounted on purpose: cutting a hole in a wall costs geometry and
    nobody can see through a window from twenty metres anyway.  Faces -Y.
    """
    parts = [
        cube(f"{name}Frame", size=(width, depth, height), color=frame),
        cube(f"{name}Pane", size=(width - 0.2, depth * 0.5, height - 0.2),
             loc=(0.0, -0.02, 0.0), color="glass", family="Glass"),
        cube(f"{name}MullionV", size=(0.07, depth * 0.9, height - 0.2),
             loc=(0.0, -0.04, 0.0), color=frame),
        cube(f"{name}MullionH", size=(width - 0.2, depth * 0.9, 0.07),
             loc=(0.0, -0.04, 0.0), color=frame),
    ]
    return join(parts, name)


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
    """An open band hugging a lathed body -- the hoops on the silo and tank."""
    return from_profile(name, [(radius, z - thickness / 2.0), (radius, z + thickness / 2.0)],
                        segments=segments, color=color, family=family,
                        close_bottom=False, close_top=False)


# --------------------------------------------------------------------------
# The barn
# --------------------------------------------------------------------------
def _barn_walls():
    """Red-and-pink striped walls, built around a 3 x 3.4 m door opening."""
    stripes = ("barn_red", "barn_pink")
    half_w, half_d = BARN_W / 2.0, BARN_D / 2.0
    inset = half_d - BARN_WALL_T / 2.0
    parts = []

    for side in (-1.0, 1.0):
        wall = plank_wall(f"SideWall{side}", (BARN_D, BARN_WALL_T, BARN_WALL_H), 9, stripes)
        place(wall, loc=(side * (half_w - BARN_WALL_T / 2.0), 0.0, BARN_WALL_H / 2.0),
              rot=(0.0, 0.0, math.radians(90)))
        parts.append(wall)

    back = plank_wall("BackWall", (BARN_W, BARN_WALL_T, BARN_WALL_H), 12, stripes)
    place(back, loc=(0.0, inset, BARN_WALL_H / 2.0))
    parts.append(back)

    pier_w = (BARN_W - BARN_DOOR_W) / 2.0
    for side in (-1.0, 1.0):
        pier = plank_wall(f"FrontPier{side}", (pier_w, BARN_WALL_T, BARN_WALL_H), 5, stripes)
        place(pier, loc=(side * (BARN_DOOR_W / 2.0 + pier_w / 2.0), -inset, BARN_WALL_H / 2.0))
        parts.append(pier)
    parts.append(cube("DoorHead", size=(BARN_DOOR_W, BARN_WALL_T, BARN_WALL_H - BARN_DOOR_H),
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
        parts.append(cube(f"Fascia{sx}", size=(0.16, BARN_D + 0.9, 0.34),
                          loc=(sx * (BARN_EAVE_X - 0.16), 0.0, BARN_EAVE_Z - 0.05),
                          color="barn_trim"))
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
    face = -(BARN_D / 2.0 - BARN_WALL_T / 2.0) - BARN_WALL_T / 2.0
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
    """Both leaves swung flat against the facade so the opening stays clear."""
    face = -(BARN_D / 2.0)
    parts = []
    for side in (-1.0, 1.0):
        near, far = side * 1.55, side * 3.05
        inner, outer = min(near, far), max(near, far)
        parts.append(cube(f"DoorLeaf{side}", size=(1.5, 0.12, BARN_DOOR_H),
                          loc=(side * 2.3, face - 0.07, BARN_DOOR_H / 2.0 + 0.05),
                          color="wood"))
        for rail_z in (0.3, BARN_DOOR_H - 0.15):
            parts.append(cube(f"DoorRail{side}{rail_z}", size=(1.44, 0.07, 0.16),
                              loc=(side * 2.3, face - 0.16, rail_z), color="barn_trim"))
        for p0, p1 in (((inner + 0.03, 0.35), (outer - 0.03, BARN_DOOR_H - 0.2)),
                       ((inner + 0.03, BARN_DOOR_H - 0.2), (outer - 0.03, 0.35))):
            parts.append(angled_slab(f"DoorBrace{side}{p0[1]}", p0, p1, span=0.07,
                                     thickness=0.16, offset=face - 0.16, color="barn_trim"))

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
    parts = _barn_walls() + _barn_roof() + _barn_hayloft() + _barn_doors()
    parts += _barn_weather_vane()

    for name, loc, rot_z in (
        ("WinFrontL", (-3.6, -(BARN_D / 2.0) - 0.03, 2.8), 0.0),
        ("WinFrontR", (3.6, -(BARN_D / 2.0) - 0.03, 2.8), 0.0),
        ("WinSideL", (-(BARN_W / 2.0) - 0.03, 0.6, 2.8), -90.0),
        ("WinSideR", (BARN_W / 2.0 + 0.03, 0.6, 2.8), 90.0),
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
                          loc=(math.cos(angle) * SILO_R, math.sin(angle) * SILO_R, 3.58),
                          rot=(0.0, 0.0, angle), color="metal_dark", family="Metal"))

    for z in (2.0, 4.2, 6.4):
        parts.append(sleeve(f"Hoop{z}", SILO_R + 0.07, z, 0.18, SILO_SEGMENTS, "iron"))

    ladder = make_ladder("SiloLadder", 6.6)
    place(ladder, loc=(0.0, -(SILO_R + 0.08), 0.0))
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
    ``WINDMILL_HUB`` rotated -90 degrees about X so its local Z faces the player.
    """
    radii = [(1.25, 0.0), (1.12, 1.6), (0.98, 3.2), (0.86, 4.8), (0.78, WINDMILL_H)]
    tower = from_profile("TowerBody", radii, segments=8, color="wood", family="Prop",
                         close_bottom=False)
    parts = [tower]

    parts.append(cone("TowerCap", r1=0.95, r2=0.16, depth=0.75, verts=8,
                      loc=(0.0, 0.0, WINDMILL_H + 0.34), color="barn_roof"))

    for radius, z in radii[1:4]:
        parts.append(sleeve(f"TowerBand{z}", radius + 0.04, z, 0.2, 8, "wood_dark",
                            family="Prop"))

    # Corner battens follow the taper, so they lean with it rather than standing
    # plumb like a fence post would.
    base_r, top_r = radii[0][0], radii[-1][0]
    for plane in ("xz", "yz"):
        parts.append(angled_slab(f"Batten{plane}Low", (-base_r, 0.0), (-top_r, WINDMILL_H),
                                 span=0.16, thickness=0.16, plane=plane, color="wood_dark"))
        parts.append(angled_slab(f"Batten{plane}High", (top_r, WINDMILL_H), (base_r, 0.0),
                                 span=0.16, thickness=0.16, plane=plane, color="wood_dark"))

    parts.append(cube("MillDoor", size=(0.95, 0.14, 1.95), loc=(0.0, -1.1, 0.98),
                      color="wood_dark"))
    for side in (-1.0, 1.0):
        parts.append(cube(f"MillDoorJamb{side}", size=(0.12, 0.16, 2.1),
                          loc=(side * 0.53, -1.12, 1.05), color="barn_trim"))
    parts.append(cube("MillDoorHead", size=(1.18, 0.16, 0.12), loc=(0.0, -1.12, 2.02),
                      color="barn_trim"))

    win = make_window("MillWindow", 0.6, 0.6)
    place(win, loc=(0.0, -0.94, 3.6))
    parts.append(win)

    hub_x, hub_y, hub_z = WINDMILL_HUB
    parts.append(cylinder("Hub", radius=0.34, depth=0.6, verts=10,
                          loc=(hub_x, hub_y + 0.1, hub_z), rot=(math.radians(90), 0.0, 0.0),
                          color="wood_dark"))
    parts.append(cone("HubNose", r1=0.3, r2=0.1, depth=0.3, verts=8,
                      loc=(hub_x, hub_y - 0.3, hub_z), rot=(math.radians(90), 0.0, 0.0),
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
    has to think about which way the tower faces.
    """
    parts = [cylinder("BladeHub", radius=0.3, depth=0.26, verts=10, color="wood_dark")]
    for i in range(4):
        spin = math.radians(90 * i)

        def spoke(x, y, a=spin):
            """Blade-local offset moved onto the i-th spoke.

            The parts have to be *born* on their spoke: a cube keeps its origin
            at its own centre, so rotating one after the fact spins it in place
            instead of swinging it around the hub.
            """
            return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), 0.0)

        parts.append(cube(f"Spar{i}", size=(0.16, BLADE_LEN, 0.12),
                          loc=spoke(0.0, BLADE_LEN / 2.0 + 0.25), rot=(0.0, 0.0, spin),
                          color="wood"))
        for k in range(4):
            parts.append(cube(f"Cross{i}{k}", size=(0.72, 0.1, 0.09),
                              loc=spoke(0.0, 0.55 + k * 0.8), rot=(0.0, 0.0, spin),
                              color="wood_dark"))
        parts.append(cube(f"Sail{i}", size=(0.52, 2.5, 0.05),
                          loc=spoke(0.29, BLADE_LEN / 2.0 + 0.35), rot=(0.0, 0.0, spin),
                          color="barn_trim"))

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
    handles it in eight triangles.
    """
    planks = ("wood", "plank", "wood_light")
    half_w, half_d = SHED_W / 2.0, SHED_D / 2.0
    thickness = 0.12
    face = half_d - thickness / 2.0
    slope = (SHED_HIGH_H - SHED_LOW_H) / SHED_W

    parts = [cube("ShedFloor", size=(SHED_W - 0.1, SHED_D - 0.1, 0.12), loc=(0.0, 0.0, 0.06),
                  color="wood_dark")]

    door_min, door_max = -1.0, -1.0 + SHED_DOOR_W
    left = plank_wall("ShedFrontL", (door_min + half_w, thickness, SHED_LOW_H), 2, planks)
    place(left, loc=((-half_w + door_min) / 2.0, -face, SHED_LOW_H / 2.0))
    right = plank_wall("ShedFrontR", (half_w - door_max, thickness, SHED_LOW_H), 5, planks)
    place(right, loc=((door_max + half_w) / 2.0, -face, SHED_LOW_H / 2.0))
    parts += [left, right]
    parts.append(cube("ShedDoorHead", size=(SHED_DOOR_W, thickness, SHED_LOW_H - SHED_DOOR_H),
                      loc=(door_min + SHED_DOOR_W / 2.0, -face,
                           (SHED_LOW_H + SHED_DOOR_H) / 2.0), color="wood"))

    back = plank_wall("ShedBack", (SHED_W, thickness, SHED_LOW_H), 10, planks)
    place(back, loc=(0.0, face, SHED_LOW_H / 2.0))
    parts.append(back)

    wedge = [(-half_w, SHED_LOW_H), (half_w, SHED_LOW_H), (half_w, SHED_HIGH_H)]
    for side in (-1.0, 1.0):
        parts.append(prism(f"ShedWedge{side}", wedge, thickness, y=side * face, color="plank"))

    for side, height in ((-1.0, SHED_LOW_H), (1.0, SHED_HIGH_H)):
        wall = plank_wall(f"ShedSide{side}", (SHED_D, thickness, height), 7, planks)
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

    door = plank_wall("ShedDoor", (SHED_DOOR_W - 0.06, 0.08, SHED_DOOR_H - 0.05), 3,
                      ("wood_dark", "wood"))
    place(door, loc=(door_min + SHED_DOOR_W / 2.0, -face - 0.09, (SHED_DOOR_H - 0.05) / 2.0))
    parts.append(door)
    for z in (0.4, 1.65):
        parts.append(cube(f"ShedHinge{z}", size=(0.3, 0.04, 0.08),
                          loc=(door_min + 0.16, -face - 0.15, z), color="iron", family="Metal"))
    parts.append(cylinder("ShedKnob", radius=0.05, depth=0.1, verts=6,
                          loc=(door_max - 0.16, -face - 0.16, 1.05),
                          rot=(math.radians(90), 0.0, 0.0), color="iron", family="Metal"))

    win = make_window("ShedWindow", 0.75, 0.65, depth=0.12)
    place(win, loc=(0.95, -face - 0.07, 1.5))
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
    half_w, half_d = COOP_W / 2.0, COOP_D / 2.0
    thickness = 0.1
    floor_z = COOP_LEG_H + 0.07
    eave_z = floor_z + COOP_BODY_H
    parts = []

    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            parts.append(cube(f"CoopLeg{sx}{sy}", size=(0.14, 0.14, COOP_LEG_H + 0.1),
                              loc=(sx * (half_w - 0.16), sy * (half_d - 0.16),
                                   (COOP_LEG_H + 0.1) / 2.0), color="wood_dark"))
    parts.append(cube("CoopFloor", size=(COOP_W, COOP_D, 0.14), loc=(0.0, 0.0, floor_z - 0.07),
                      color="wood_dark"))

    body_z = floor_z + COOP_BODY_H / 2.0
    for side in (-1.0, 1.0):
        front = plank_wall(f"CoopWallY{side}", (COOP_W, thickness, COOP_BODY_H), 5, planks)
        place(front, loc=(0.0, side * (half_d - thickness / 2.0), body_z))
        parts.append(front)
        wall = plank_wall(f"CoopWallX{side}", (COOP_D, thickness, COOP_BODY_H), 4, planks)
        place(wall, loc=(side * (half_w - thickness / 2.0), 0.0, body_z),
              rot=(0.0, 0.0, math.radians(90)))
        parts.append(wall)

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

    # Ramp down to the ground, cleated so the birds get some grip.
    ramp_bottom, ramp_top = (-half_d - 1.05, 0.0), (-half_d + 0.05, floor_z)
    parts.append(angled_slab("CoopRamp", ramp_bottom, ramp_top, span=0.5, thickness=0.07,
                             plane="yz", lift=0.035, color="wood"))
    ramp_angle = math.atan2(ramp_top[1] - ramp_bottom[1], ramp_top[0] - ramp_bottom[0])
    for i in range(4):
        t = (i + 0.5) / 4.0
        y = ramp_bottom[0] + (ramp_top[0] - ramp_bottom[0]) * t
        z = ramp_bottom[1] + (ramp_top[1] - ramp_bottom[1]) * t
        parts.append(cube(f"CoopCleat{i}", size=(0.5, 0.06, 0.05),
                          loc=(0.0, y - math.sin(ramp_angle) * 0.06,
                               z + math.cos(ramp_angle) * 0.06),
                          rot=(ramp_angle, 0.0, 0.0), color="wood_dark"))

    nest_z = floor_z + 0.42
    parts.append(cube("NestBox", size=(0.5, 1.05, 0.5), loc=(half_w + 0.2, 0.0, nest_z),
                      color="wood"))
    parts.append(angled_slab("NestLid", (half_w - 0.12, nest_z + 0.34),
                             (half_w + 0.52, nest_z + 0.2), span=1.15, thickness=0.07,
                             color="barn_red"))
    parts.append(cube("NestHinge", size=(0.1, 0.9, 0.05), loc=(half_w - 0.1, 0.0, nest_z + 0.32),
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
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            # Each leg leans in on both axes; solve the euler that aims local +Z
            # straight at the deck corner rather than eyeballing two angles.
            rx = math.asin(sy * TOWER_LEG_INSET / leg_run)
            ry = math.asin(-sx * TOWER_LEG_INSET / (leg_run * math.cos(rx)))
            parts.append(cube(f"TowerLeg{sx}{sy}", size=(0.18, 0.18, leg_run + 0.1),
                              loc=(sx * (TOWER_LEG_SPREAD - TOWER_LEG_INSET / 2.0),
                                   sy * (TOWER_LEG_SPREAD - TOWER_LEG_INSET / 2.0),
                                   TOWER_DECK_Z / 2.0),
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
        [(1.35, deck - 0.15), (1.5, deck + 0.05), (1.5, deck + 1.65), (1.35, deck + 1.85),
         (0.85, deck + 2.15), (0.0, TOWER_TANK_TOP)],
        segments=12, color="metal", family="Metal",
    )
    smooth(tank, 50)
    parts.append(tank)
    lid = select_faces(tank, lambda c, n: c.z > deck + 1.85)
    paint(tank, "metal_dark", family="Metal", faces=lid)
    for z in (deck + 0.45, deck + 1.25):
        parts.append(sleeve(f"TankHoop{z}", 1.54, z, 0.16, 12, "iron"))
    parts.append(cylinder("TankVent", radius=0.13, depth=0.32, verts=6,
                          loc=(0.0, 0.0, TOWER_TANK_TOP + 0.06), color="iron", family="Metal"))
    parts.append(cylinder("DownPipe", radius=0.09, depth=deck - 0.1, verts=6,
                          loc=(1.05, 1.05, (deck - 0.1) / 2.0), color="metal_dark",
                          family="Metal"))

    ladder = make_ladder("TowerLadder", deck + 0.3, color="iron")
    place(ladder, loc=(0.0, -(ring_r + 0.2), 0.0))
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
    parts = []

    for x in (-half_w + 0.3, 0.0, half_w - 0.3):
        for y in (-half_d + 0.3, half_d - 0.3):
            parts.append(cube(f"Post{x}{y}", size=(0.26, 0.26, HAYBARN_EAVE_Z),
                              loc=(x, y, HAYBARN_EAVE_Z / 2.0), color="wood"))

    for side in (-1.0, 1.0):
        parts.append(cube(f"EaveBeam{side}", size=(HAYBARN_W, 0.2, 0.3),
                          loc=(0.0, side * (half_d - 0.3), HAYBARN_EAVE_Z - 0.15),
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
        # Ribs ride 0.18 m above the rafter line -- the panel itself is 0.12 thick,
        # so anything less and the "corrugation" is buried inside the roof.
        for i in range(5):
            x = -half_w - 0.2 + (HAYBARN_W + 0.4) * i / 4.0
            parts.append(angled_slab(f"HayRib{side}{i}", (p0[0], p0[1] + 0.18),
                                     (p1[0], p1[1] + 0.18), span=0.1, thickness=0.06,
                                     plane="yz", offset=x, color="metal_dark", family="Metal"))
    parts.append(cube("HayRidgeCap", size=(HAYBARN_W + 0.6, 0.34, 0.14),
                      loc=(0.0, 0.0, HAYBARN_RIDGE_Z + 0.13), color="metal_dark",
                      family="Metal"))

    # The back wall stops where the sloping roof crosses it, not at the eave.
    back_y = half_d - 0.06
    back_h = HAYBARN_RIDGE_Z - (HAYBARN_RIDGE_Z - HAYBARN_EAVE_Z) * (back_y / eave[0])
    back = plank_wall("HayBackWall", (HAYBARN_W, 0.12, back_h), 10,
                      ("wood", "plank", "wood_light"))
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
