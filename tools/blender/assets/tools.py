"""First-person viewmodels: the gloved hands and everything they hold.

These meshes sit two hand-spans from the lens for the whole game, so they earn
more detail per triangle than anything else in the library -- a wrapped grip, a
rivet line, a worn patch of paint, a maker's plate.

BUILD FRAME.  Every model here is built *Z-forward*: the grip sits on the world
origin, the business end runs up +Z, and +Y is "up".  :func:`orient_tool` then
rolls the finished mesh 90 degrees about X into the viewmodel frame the game
expects -- grip on the origin, tool pointing down -Y, +Z up.  Building along +Z
is what lets ``from_profile`` lathe the handles directly and lets
:func:`paint_band` pick trim rings out by height.  The one exception is
``vacuum_pack``, which is worn rather than held; it is documented in place.

JOIN ORDER.  ``join()`` folds every part into the *first* object's local space,
so the first entry of a parts list is always a ``cube``/``from_profile``/
``from_points`` -- those carry an identity rotation, while ``cylinder`` and
friends hold their ``rot`` as an un-applied object transform.
"""

import math

from mathutils import Vector

# The roll that takes the Z-forward build frame to the viewmodel frame.
VIEWMODEL_ROLL = (math.radians(90.0), 0.0, 0.0)

HAND_SPAN = 0.34        # centre-to-centre distance between the two hands
CORRUGATION = 0.007     # rib depth on the vacuum / compressor hoses


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------
def sweep_tube(name, spine, radii, sides=6, color=None, family="Prop", caps=True):
    """Sweep a regular-polygon cross-section along ``spine``.

    ``radii`` is per-station, so one call covers a fork tine tapering to a point
    and a hose alternating fat/thin rings into a corrugation -- the ribs cost no
    extra stations.  ``sides=4`` gives a square bar, ``sides=8`` a round hose.
    """
    verts, faces = [], []
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
        radius = radii[i]
        for k in range(sides):
            # The half-step phase puts flats on the frame axes, so a 4-sided
            # sweep reads as a square bar instead of a diamond.
            angle = TAU * (k + 0.5) / sides
            verts.append(centre + side * (math.cos(angle) * radius)
                         + up * (math.sin(angle) * radius))

    for i in range(count - 1):
        a, b = i * sides, (i + 1) * sides
        for k in range(sides):
            k2 = (k + 1) % sides
            # Wound so the section normal points away from the spine.
            faces.append((a + k, b + k, b + k2, a + k2))

    if caps:
        faces.append(tuple(range(sides)))
        last = (count - 1) * sides
        faces.append(tuple(range(last + sides - 1, last - 1, -1)))

    return from_points(name, verts, faces, color=color, family=family)


def paint_band(obj, color, z_range, family="Prop"):
    """Recolour a horizontal slice of a lathed body.

    Grip wraps, ferrule trim and worn patches are all free if the profile
    already has rings at the right heights -- no extra geometry, one more
    colour.  Only valid on objects whose mesh sits on the build axis
    (``from_profile`` output), because face centres are read in local space.
    """
    low, high = z_range
    faces = select_faces(obj, lambda c, n: low <= c.z <= high)
    paint(obj, color, family=family, faces=faces)
    return obj


def paint_wedges(obj, color, count, family="Prop", z_range=None, wall_only=True):
    """Paint alternating angular wedges around the local Z axis.

    Vent slats, hazard chevrons and a fan grille are the same trick: geometry
    that already exists, recoloured in pie slices.  ``wall_only`` keeps the
    paint off the caps of a barrel; drop it for a flat lathed disc.
    """
    step = TAU / count

    def keep(centre, normal):
        if wall_only and abs(normal.z) > 0.6:
            return False
        if z_range is not None and not (z_range[0] <= centre.z <= z_range[1]):
            return False
        return int((math.atan2(centre.y, centre.x) % TAU) / step) % 2 == 0

    paint(obj, color, family=family, faces=select_faces(obj, keep))
    return obj


def hazard_ring(name, radius, depth, loc, count=6, verts=12):
    """A gold-and-black warning collar -- the industrial kit wears these."""
    ring = cylinder(name, radius=radius, depth=depth, verts=verts,
                    loc=loc, color="gold", family="Metal")
    paint_wedges(ring, "black", count, family="Metal")
    return ring


def lathed_disc(name, radius, rise, segments, color=None, family="Prop"):
    """A flat fan of triangles built at the local origin, facing +Z.

    ``from_profile`` winds an apex band toward +Z whichever way the profile is
    written, so any disc that has to face elsewhere -- a fan grille, an intake
    cap, a gauge -- is built here and rotated into place by the caller.
    """
    return from_profile(name, [(0.0, 0.0), (radius, rise)], segments=segments,
                        color=color, family=family, close_bottom=False)


def orient_tool(obj):
    """Roll a Z-forward build into the viewmodel frame and pin the grip.

    Order matters: the origin has to reach the grip point *before* the roll, or
    the rotation pivots around whatever part happened to lead the join list.
    """
    apply_transform(obj)                    # bake anything the join target carried
    set_origin(obj, (0.0, 0.0, 0.0))
    place(obj, rot=VIEWMODEL_ROLL)
    apply_transform(obj)
    return obj


def _ribbed_hose(name, spine, radius, color="rubber"):
    """A corrugated hose: every other station swells to make the ribs."""
    radii = [radius + (CORRUGATION if i % 2 else 0.0) for i in range(len(spine))]
    hose = sweep_tube(name, spine, radii, sides=8, color=color)
    smooth(hose, 50)
    return hose


# --------------------------------------------------------------------------
# Hands
# --------------------------------------------------------------------------
def build_hands():
    """A pair of gloved fists in rolled plaid sleeves.

    Mitten proportions, not anatomy: one fist block, three finger ridges laid
    across the knuckles and a stubby thumb.  Only the right hand is modelled --
    a mirror modifier across the build origin supplies the left, which is also
    what guarantees the pair sits exactly ``HAND_SPAN`` apart.
    """
    x = HAND_SPAN * 0.5
    parts = []

    fist = cube("Fist", size=(0.105, 0.115, 0.135), loc=(x, 0.0, 0.0), color="glove")
    bevel(fist, 0.022, 1)
    apply_modifiers(fist)
    # A scuffed leather palm patch, on the inboard face where it would wear.
    paint(fist, "wood_dark", faces=select_faces(fist, lambda c, n: n.x < -0.8))
    # Shading the knuckle plate darker turns the finger gaps into creases.
    paint(fist, shade("glove", 0.72), faces=select_faces(fist, lambda c, n: n.y > 0.8))
    parts.append(fist)

    for i, z in enumerate((-0.042, 0.0, 0.042)):
        parts.append(cube(f"Finger{i}", size=(0.115, 0.05, 0.036),
                          loc=(x, 0.045, z), color="glove"))

    thumb = cube("Thumb", size=(0.05, 0.062, 0.085), loc=(x - 0.062, 0.018, 0.038),
                 rot=(math.radians(-16.0), 0.0, math.radians(-12.0)), color="glove")
    bevel(thumb, 0.014, 1)
    parts.append(thumb)

    parts.append(cube("Wrist", size=(0.095, 0.095, 0.05), loc=(x, -0.005, -0.095),
                      color="skin"))

    cuff = cube("Cuff", size=(0.128, 0.128, 0.058), loc=(x, -0.005, -0.147),
                color=shade("barn_red", 0.72))
    # The rolled edge shows the shirt's pale lining.
    paint(cuff, "barn_trim", faces=select_faces(cuff, lambda c, n: n.z > 0.8))
    parts.append(cuff)

    # Three stacked bands stand in for a plaid check -- cheaper and far more
    # legible at viewmodel range than any painted stripe on a single box.
    for i, z in enumerate((-0.215, -0.29, -0.365)):
        band = cube(f"Sleeve{i}", size=(0.115, 0.115, 0.075), loc=(x, -0.005, z),
                    color="barn_red" if i % 2 == 0 else shade("barn_red", 0.7))
        if i == 1:
            paint(band, "barn_trim",
                  faces=select_faces(band, lambda c, n: n.y > 0.8 or n.x > 0.8))
        parts.append(band)

    hands = join(parts, "Hands")
    set_origin(hands, (0.0, 0.0, 0.0))
    mirror(hands, axis=(True, False, False))
    apply_modifiers(hands)
    orient_tool(hands)
    report(hands)
    export_glb(hands, "hands")


# --------------------------------------------------------------------------
# Hand tools
# --------------------------------------------------------------------------
def build_pitchfork():
    """The player's main tool: 1.6 m of ash, a D-grip butt and three tines.

    The grip point sits 0.30 m up the haft, which is where a hand naturally
    falls when the D-grip is braced against the hip.
    """
    parts = []

    # The butt starts on a small ring rather than a point: an apex band would
    # be wound facing into the mesh, and this end is aimed at the camera.
    haft = from_profile(
        "Haft",
        [(0.012, -0.30), (0.027, -0.285), (0.025, -0.02), (0.0245, 0.16),
         (0.021, 1.28), (0.0, 1.30)],
        segments=10, color="wood",
    )
    # Rings at -0.02 and 0.16 exist purely so this leather wrap can be painted.
    paint_band(haft, "wood_dark", (0.0, 0.14))
    smooth(haft, 50)
    parts.append(haft)

    parts.append(cube("Yoke", size=(0.10, 0.030, 0.030), loc=(0.0, 0.0, -0.30),
                      color="wood_dark"))
    for side in (-1.0, 1.0):
        parts.append(cube("DStrut", size=(0.024, 0.024, 0.145),
                          loc=(side * 0.042, 0.0, -0.376), color="wood"))
    parts.append(cube("DBar", size=(0.115, 0.030, 0.030), loc=(0.0, 0.0, -0.455),
                      color="wood_dark"))

    socket = from_profile(
        "Socket",
        [(0.0, 1.22), (0.032, 1.25), (0.036, 1.33), (0.030, 1.44), (0.0, 1.46)],
        segments=10, color="iron", family="Metal",
    )
    smooth(socket, 45)
    parts.append(socket)

    # Two rivets through the socket -- the one detail that says "forged, then
    # hammered onto a stick" rather than "extruded in one piece".
    for z in (1.27, 1.41):
        parts.append(cube("Rivet", size=(0.078, 0.012, 0.012), loc=(0.0, 0.0, z),
                          color="metal_dark", family="Metal"))

    for i, offset in enumerate((-0.105, 0.0, 0.105)):
        tine = sweep_tube(
            f"Tine{i}",
            [(offset * 0.30, 0.0, 1.38), (offset * 0.72, 0.004, 1.58),
             (offset * 0.93, 0.020, 1.79), (offset, 0.048, 1.96)],
            [0.017, 0.014, 0.010, 0.004], sides=5, color="metal", family="Metal",
        )
        smooth(tine, 50)
        parts.append(tine)

    fork = join(parts, "Pitchfork")
    orient_tool(fork)
    report(fork)
    export_glb(fork, "pitchfork")


def build_rake():
    """A 1.5 m rake: light ash handle, wide head, ten springy teeth."""
    parts = []

    handle = from_profile(
        "Handle",
        [(0.011, -0.20), (0.025, -0.185), (0.023, 0.02), (0.0225, 0.22),
         (0.020, 1.26), (0.0, 1.28)],
        segments=10, color="wood_light",
    )
    paint_band(handle, shade("wood", 0.8), (0.04, 0.20))  # sweat-darkened grip
    smooth(handle, 50)
    parts.append(handle)

    ferrule = from_profile(
        "Ferrule", [(0.0, 1.22), (0.030, 1.25), (0.030, 1.35), (0.0, 1.37)],
        segments=10, color="iron", family="Metal",
    )
    smooth(ferrule, 45)
    parts.append(ferrule)

    head = cube("Head", size=(0.62, 0.055, 0.072), loc=(0.0, 0.0, 1.40), color="wood")
    bevel(head, 0.012, 1)
    apply_modifiers(head)
    # The underside takes every scrape, so it reads a shade darker than the top.
    paint(head, "wood_dark", faces=select_faces(head, lambda c, n: n.y < -0.8))
    parts.append(head)

    for side in (-1.0, 1.0):
        parts.append(cube("Brace", size=(0.30, 0.026, 0.026),
                          loc=(side * 0.145, 0.0, 1.378),
                          rot=(0.0, math.radians(-13.0 * side), 0.0), color="wood_dark"))

    for i in range(10):
        x = -0.27 + i * 0.06
        tooth = sweep_tube(
            f"Tooth{i}",
            [(x, 0.005, 1.395), (x * 1.03, -0.055, 1.487), (x * 1.06, -0.142, 1.524)],
            [0.011, 0.009, 0.004], sides=4, color="metal", family="Metal",
        )
        parts.append(tooth)

    rake = join(parts, "Rake")
    orient_tool(rake)
    report(rake)
    export_glb(rake, "rake")


def build_hay_hook():
    """A stevedore's hay hook: fat turned grip, one hard curve of steel."""
    parts = []

    grip = from_profile(
        "Grip",
        [(0.012, -0.075), (0.026, -0.068), (0.033, -0.030), (0.033, 0.048),
         (0.026, 0.082), (0.0, 0.090)],
        segments=8, color="wood",
    )
    # The middle of the grip is polished dark by years of palms.
    paint_band(grip, shade("wood", 0.72), (-0.028, 0.046))
    smooth(grip, 50)
    parts.append(grip)

    collar = from_profile(
        "Collar", [(0.0, 0.082), (0.021, 0.090), (0.021, 0.128), (0.0, 0.134)],
        segments=8, color="iron", family="Metal",
    )
    smooth(collar, 45)
    parts.append(collar)

    hook = sweep_tube(
        "Hook",
        [(0.0, 0.0, 0.120), (0.0, -0.012, 0.235), (0.0, -0.062, 0.318),
         (0.0, -0.150, 0.342), (0.0, -0.228, 0.292), (0.0, -0.262, 0.198)],
        [0.014, 0.013, 0.012, 0.011, 0.009, 0.004], sides=5,
        color="metal", family="Metal",
    )
    smooth(hook, 50)
    # The inside of the bend is burnished bright where bales ride against it.
    paint(hook, "white", family="Metal",
          faces=select_faces(hook, lambda c, n: n.y > 0.5 and c.z > 0.25))
    parts.append(hook)

    parts.append(cube("Pin", size=(0.046, 0.011, 0.011), loc=(0.0, 0.0, 0.106),
                      color="metal_dark", family="Metal"))

    tool = join(parts, "HayHook")
    orient_tool(tool)
    report(tool)
    export_glb(tool, "hay_hook")


# --------------------------------------------------------------------------
# Powered tools
# --------------------------------------------------------------------------
def build_leaf_blower():
    """A cartoon two-stroke blower, 0.75 m from cord handle to muzzle.

    The shell rides above the grip so the hand node lands on the trigger, which
    is where a player expects the weight of the thing to be.
    """
    SHELL_Y = 0.075     # the body sits this far above the grip axis
    parts = []

    grip = cube("Grip", size=(0.055, 0.10, 0.078), loc=(0.0, 0.0, -0.01),
                color="rubber")
    bevel(grip, 0.014, 1)
    apply_modifiers(grip)
    paint(grip, shade("rubber", 1.5),
          faces=select_faces(grip, lambda c, n: n.y > 0.8))   # hand-polished shine
    parts.append(grip)

    parts.append(cube("Trigger", size=(0.028, 0.024, 0.05), loc=(0.0, -0.048, 0.022),
                      color="metal_dark", family="Metal"))
    parts.append(cube("Neck", size=(0.062, 0.075, 0.10), loc=(0.0, 0.048, 0.0),
                      color=shade("pumpkin", 0.8)))

    shell = from_profile(
        "Shell",
        [(0.0, -0.115), (0.058, -0.085), (0.088, -0.020), (0.094, 0.160),
         (0.080, 0.300), (0.0, 0.345)],
        segments=12, color="pumpkin",
    )
    # Cooling slats: one band of the lathe, every other wedge dropped in value.
    paint_wedges(shell, shade("pumpkin", 0.42), 6, z_range=(-0.01, 0.15))
    paint_band(shell, "barn_trim", (0.19, 0.28))   # the model-name stripe
    smooth(shell, 46)
    place(shell, loc=(0.0, SHELL_Y, 0.0))
    parts.append(shell)

    intake = lathed_disc("IntakeCap", 0.060, 0.016, 12, color="iron", family="Metal")
    paint_wedges(intake, "black", 12, family="Metal", wall_only=False)
    place(intake, loc=(0.0, SHELL_Y, -0.112), rot=(math.radians(180.0), 0.0, 0.0))
    parts.append(intake)

    nozzle = from_profile(
        "Nozzle",
        [(0.048, 0.335), (0.052, 0.395), (0.044, 0.490), (0.054, 0.560),
         (0.086, 0.630), (0.089, 0.662)],
        segments=12, color="iron", family="Metal", close_bottom=False,
    )
    # The muzzle cap stays as the dark bore; open geometry would show backfaces.
    paint(nozzle, "black", family="Metal",
          faces=select_faces(nozzle, lambda c, n: n.z > 0.9))
    smooth(nozzle, 46)
    place(nozzle, loc=(0.0, SHELL_Y, 0.0))
    parts.append(nozzle)

    parts.append(cylinder("Exhaust", radius=0.020, depth=0.085, verts=8,
                          loc=(0.082, SHELL_Y + 0.02, 0.10),
                          rot=(0.0, math.radians(72.0), 0.0),
                          color="metal_dark", family="Metal"))
    parts.append(cylinder("FuelCap", radius=0.026, depth=0.026, verts=8,
                          loc=(0.0, SHELL_Y + 0.096, 0.245),
                          rot=(math.radians(90.0), 0.0, 0.0), color="black"))

    parts.append(cube("CordHandle", size=(0.052, 0.024, 0.024),
                      loc=(-0.125, SHELL_Y + 0.075, 0.055), color="wood_light"))
    parts.append(sweep_tube(
        "Cord",
        [(-0.100, SHELL_Y + 0.072, 0.055), (-0.060, SHELL_Y + 0.086, 0.020),
         (-0.010, SHELL_Y + 0.070, -0.010)],
        [0.006, 0.006, 0.006], sides=4, color="rope"))

    plate = cube("Plate", size=(0.048, 0.006, 0.030),
                 loc=(0.0, SHELL_Y + 0.098, -0.030), color="metal", family="Metal")
    parts.append(plate)

    blower = join(parts, "LeafBlower")
    orient_tool(blower)
    report(blower)
    export_glb(blower, "leaf_blower")


def build_hay_vacuum():
    """The wand half of the backpack vacuum: funnel, tube, grip, 0.4 m of hose.

    The pack itself is a separate model the game hangs off the player's back,
    so the hose is cut where it would disappear over the shoulder.
    """
    parts = []

    tube = from_profile(
        "Wand",
        [(0.0, 0.010), (0.038, 0.036), (0.035, 0.190), (0.038, 0.216), (0.0, 0.226)],
        segments=10, color="denim",
    )
    paint_band(tube, "gold", (0.195, 0.212))   # brass clamp at the funnel joint
    smooth(tube, 46)
    parts.append(tube)

    # Lathed out and back again, so the inside of the funnel is real surface
    # rather than the backface of a cone.
    funnel = from_profile(
        "Funnel",
        [(0.037, 0.200), (0.048, 0.300), (0.100, 0.440), (0.116, 0.500),
         (0.101, 0.474), (0.050, 0.338), (0.042, 0.262)],
        segments=12, color="metal", family="Metal", close_bottom=False,
    )
    paint(funnel, "black", family="Metal",
          faces=select_faces(funnel, lambda c, n: n.z > 0.9))          # dark throat
    paint(funnel, "straw_dark", family="Metal",
          faces=select_faces(funnel, lambda c, n: c.z > 0.455 and n.z < 0.5))
    smooth(funnel, 44)
    parts.append(funnel)

    grip = cube("Grip", size=(0.052, 0.095, 0.135), loc=(0.0, -0.062, 0.020),
                rot=(math.radians(-14.0), 0.0, 0.0), color="rubber")
    bevel(grip, 0.014, 1)
    apply_modifiers(grip)
    paint(grip, shade("rubber", 1.5),
          faces=select_faces(grip, lambda c, n: n.y < -0.7))
    parts.append(grip)

    parts.append(cube("Switch", size=(0.024, 0.020, 0.038), loc=(0.0, -0.108, 0.062),
                      color="barn_red"))

    stations = 11
    spine = []
    for i in range(stations):
        t = i / (stations - 1)
        # Falls away behind the hand on a lazy arc toward the shoulder strap.
        spine.append((0.0, -0.115 * t * t, 0.020 - 0.385 * t))
    hose = _ribbed_hose("Hose", spine, 0.036)
    parts.append(hose)

    wand = join(parts, "HayVacuumWand")
    orient_tool(wand)
    report(wand)
    export_glb(wand, "hay_vacuum")


def build_vacuum_pack():
    """The backpack canister the vacuum wand feeds.

    NOTE: this is the one model in the file that is *not* a viewmodel.  It is
    built Z-up and worn, with the origin at the centre of the harness plate and
    the canister behind it at +Y -- so the game can parent it straight to a
    torso node with no offset.
    """
    BODY_Y = 0.175
    parts = []

    back = cube("Backplate", size=(0.30, 0.05, 0.44), loc=(0.0, 0.028, 0.0),
                color=shade("denim", 0.7))
    bevel(back, 0.02, 1)
    apply_modifiers(back)
    parts.append(back)

    # The two extra rings at 0.02 / 0.09 exist only to carry the sight window.
    canister = from_profile(
        "Canister",
        [(0.0, -0.255), (0.098, -0.220), (0.134, -0.150), (0.134, 0.020),
         (0.134, 0.090), (0.134, 0.170), (0.108, 0.250), (0.0, 0.282)],
        segments=12, color="denim",
    )
    paint_band(canister, "metal", (-0.20, -0.17))        # bottom hoop
    paint_band(canister, "straw_light", (0.03, 0.08))    # hay showing through
    paint_wedges(canister, shade("denim", 0.55), 12, z_range=(0.03, 0.08))
    smooth(canister, 46)
    place(canister, loc=(0.0, BODY_Y, 0.0))
    parts.append(canister)

    lid = from_profile(
        "Lid", [(0.0, 0.278), (0.078, 0.292), (0.078, 0.344), (0.0, 0.362)],
        segments=12, color="metal", family="Metal",
    )
    smooth(lid, 44)
    place(lid, loc=(0.0, BODY_Y, 0.0))
    parts.append(lid)

    parts.append(cylinder("Port", radius=0.048, depth=0.10, verts=8,
                          loc=(0.145, BODY_Y - 0.02, 0.20),
                          rot=(0.0, math.radians(64.0), 0.0),
                          color="metal_dark", family="Metal"))

    for side in (-1.0, 1.0):
        parts.append(cube("Strap", size=(0.075, 0.032, 0.34),
                          loc=(side * 0.125, -0.020, 0.030),
                          rot=(math.radians(6.0), 0.0, 0.0), color="wood_dark"))
        parts.append(cube("Buckle", size=(0.082, 0.040, 0.030),
                          loc=(side * 0.125, -0.022, -0.130), color="gold",
                          family="Metal"))
        parts.append(cube("Latch", size=(0.030, 0.055, 0.045),
                          loc=(side * 0.115, BODY_Y - 0.075, 0.268), color="metal",
                          family="Metal"))

    gauge = lathed_disc("Gauge", 0.042, 0.012, 10, color="barn_trim")
    paint_wedges(gauge, "barn_red", 10, wall_only=False)
    place(gauge, loc=(0.0, BODY_Y + 0.128, 0.06), rot=(math.radians(-90.0), 0.0, 0.0))
    parts.append(gauge)

    parts.append(cube("Plate", size=(0.06, 0.006, 0.034),
                      loc=(0.0, BODY_Y + 0.132, -0.06), color="copper", family="Metal"))

    pack = join(parts, "VacuumPack")
    apply_transform(pack)
    set_origin(pack, (0.0, 0.0, 0.0))
    report(pack)
    export_glb(pack, "vacuum_pack")


# --------------------------------------------------------------------------
# Search tools
# --------------------------------------------------------------------------
def build_magnifier():
    """A brass-rimmed glass on a turned handle -- 0.29 m, the needle-finder.

    The lens is a separate disc on the ``Glass`` family, so it exports with the
    alpha the rest of the model must not have.
    """
    parts = []

    handle = from_profile(
        "Handle",
        [(0.009, -0.078), (0.021, -0.070), (0.027, -0.046), (0.019, -0.008),
         (0.025, 0.038), (0.017, 0.084), (0.0, 0.090)],
        segments=8, color="wood",
    )
    # The waist between the two turned bulges is where the fingers rest.
    paint_band(handle, shade("wood", 0.68), (-0.030, 0.020))
    smooth(handle, 50)
    parts.append(handle)

    collar = from_profile(
        "Collar", [(0.0, 0.082), (0.016, 0.090), (0.016, 0.126), (0.0, 0.132)],
        segments=8, color="gold", family="Metal",
    )
    smooth(collar, 44)
    parts.append(collar)

    parts.append(cube("Stem", size=(0.022, 0.022, 0.042), loc=(0.0, 0.0, 0.140),
                      color="gold", family="Metal"))

    # Lathed as a closed loop (out, up, in, down) so both faces of the ring and
    # its inner wall are real surface.
    rim = from_profile(
        "Rim",
        [(0.048, 0.146), (0.059, 0.146), (0.059, 0.170), (0.048, 0.170), (0.048, 0.146)],
        segments=10, color="gold", family="Metal",
        close_bottom=False, close_top=False,
    )
    paint_wedges(rim, "copper", 10, family="Metal")   # maker's knurl on the bezel
    parts.append(rim)

    lens = from_profile(
        "Lens", [(0.0, 0.152), (0.050, 0.150), (0.050, 0.164), (0.0, 0.166)],
        segments=10, color="glass", family="Glass",
    )
    smooth(lens, 60)
    parts.append(lens)

    glass = join(parts, "Magnifier")
    orient_tool(glass)
    report(glass)
    export_glb(glass, "magnifier")


def build_metal_detector():
    """A 1.2 m detector: armrest cuff, control box, elliptical search coil.

    The coil is lathed round and then scaled on one axis -- an ellipse for free,
    and it keeps the profile readable next to the other lathed parts.
    """
    parts = []

    shaft = from_profile(
        "Shaft", [(0.0, -0.44), (0.019, -0.42), (0.019, 0.02), (0.0, 0.04)],
        segments=8, color="metal", family="Metal",
    )
    smooth(shaft, 45)
    parts.append(shaft)

    parts.append(cube("CuffBase", size=(0.10, 0.055, 0.19), loc=(0.0, -0.045, -0.325),
                      color="iron", family="Metal"))
    for side in (-1.0, 1.0):
        parts.append(cube("CuffWall", size=(0.014, 0.085, 0.17),
                          loc=(side * 0.048, -0.018, -0.325), color="iron",
                          family="Metal"))

    grip = cube("Grip", size=(0.048, 0.082, 0.132), loc=(0.0, -0.050, -0.050),
                color="rubber")
    bevel(grip, 0.014, 1)
    apply_modifiers(grip)
    paint(grip, shade("rubber", 1.5),
          faces=select_faces(grip, lambda c, n: n.y < -0.7))
    parts.append(grip)

    box = cube("Box", size=(0.145, 0.115, 0.175), loc=(0.0, 0.085, -0.130),
               color="iron", family="Metal")
    bevel(box, 0.015, 1)
    apply_modifiers(box)
    # The fascia is the only bright face on the tool; it draws the eye to the dial.
    paint(box, "gold", family="Metal",
          faces=select_faces(box, lambda c, n: n.z < -0.8))
    parts.append(box)

    dial = cylinder("Dial", radius=0.042, depth=0.022, verts=10,
                    loc=(0.0, 0.092, -0.226), color="metal_dark", family="Metal")
    paint(dial, "barn_trim", family="Metal",
          faces=select_faces(dial, lambda c, n: n.z < -0.8))
    parts.append(dial)
    parts.append(cube("Needle", size=(0.006, 0.052, 0.006), loc=(0.0, 0.104, -0.240),
                      rot=(0.0, 0.0, math.radians(26.0)), color="barn_red"))

    for side in (-1.0, 1.0):
        parts.append(cylinder("Knob", radius=0.019, depth=0.032, verts=8,
                              loc=(side * 0.046, 0.048, -0.228), color="black"))

    parts.append(sweep_tube(
        "LowerShaft",
        [(0.0, 0.0, 0.010), (0.0, -0.052, 0.340), (0.0, -0.165, 0.620)],
        [0.019, 0.018, 0.017], sides=6, color="metal", family="Metal"))
    parts.append(cube("CoilStem", size=(0.032, 0.11, 0.032), loc=(0.0, -0.188, 0.652),
                      color="iron", family="Metal"))

    coil = from_profile(
        "Coil",
        [(0.0, 0.0), (0.128, 0.006), (0.152, 0.022), (0.152, 0.050),
         (0.128, 0.066), (0.0, 0.072)],
        segments=12, color="metal_dark", family="Metal",
    )
    # Local +Z ends up facing the ground once the whole tool is rolled, so the
    # scuffed underside is painted on what is currently the top.
    paint(coil, shade("metal_dark", 0.6), family="Metal",
          faces=select_faces(coil, lambda c, n: c.z > 0.055))
    smooth(coil, 44)
    place(coil, loc=(0.0, -0.208, 0.700), rot=(math.radians(90.0), 0.0, 0.0),
          scale=(1.0, 1.28, 1.0))
    parts.append(coil)

    detector = join(parts, "MetalDetector")
    orient_tool(detector)
    report(detector)
    export_glb(detector, "metal_detector")


def build_compressor():
    """The late-game hay extractor: a metre of intake bell, hose and motor.

    Everything about it is meant to read as heavy and slightly dangerous -- a
    hazard collar behind the bell, a caged fan on the flank, a rated plate.
    """
    BARREL_Y = 0.090    # the intake line rides above the grip, as on the blower
    parts = []

    grip = cube("Grip", size=(0.056, 0.102, 0.140), loc=(0.0, -0.058, -0.020),
                rot=(math.radians(-8.0), 0.0, 0.0), color="rubber")
    bevel(grip, 0.014, 1)
    apply_modifiers(grip)
    paint(grip, shade("rubber", 1.5),
          faces=select_faces(grip, lambda c, n: n.y < -0.7))
    parts.append(grip)

    parts.append(cube("Trigger", size=(0.030, 0.026, 0.052), loc=(0.0, -0.112, 0.030),
                      color="gold", family="Metal"))

    housing = cube("Housing", size=(0.205, 0.225, 0.330), loc=(0.0, 0.080, -0.060),
                   color="iron", family="Metal")
    bevel(housing, 0.022, 1)
    apply_modifiers(housing)
    paint(housing, shade("iron", 1.3), family="Metal",
          faces=select_faces(housing, lambda c, n: n.y > 0.8))
    paint(housing, "black", family="Metal",
          faces=select_faces(housing, lambda c, n: n.z < -0.8))
    parts.append(housing)

    parts.append(cube("Plate", size=(0.062, 0.006, 0.034), loc=(0.0, 0.196, -0.140),
                      color="copper", family="Metal"))
    for x in (-0.045, 0.045):
        parts.append(cube("HandleBar", size=(0.030, 0.030, 0.150),
                          loc=(x, 0.208, -0.060), color="black"))
    parts.append(cube("HandleTop", size=(0.150, 0.034, 0.034), loc=(0.0, 0.208, 0.008),
                      color="black"))

    parts.append(cylinder("FanBoss", radius=0.092, depth=0.05, verts=12,
                          loc=(0.108, 0.080, -0.060),
                          rot=(0.0, math.radians(90.0), 0.0),
                          color="iron", family="Metal"))
    grille = lathed_disc("Grille", 0.086, 0.014, 12, color="metal_dark", family="Metal")
    paint_wedges(grille, "black", 12, family="Metal", wall_only=False)
    place(grille, loc=(0.128, 0.080, -0.060), rot=(0.0, math.radians(90.0), 0.0))
    parts.append(grille)

    parts.append(cylinder("Stack", radius=0.030, depth=0.140, verts=8,
                          loc=(-0.062, 0.190, -0.172),
                          rot=(math.radians(-70.0), 0.0, 0.0),
                          color="metal_dark", family="Metal"))

    stations = 9
    spine = []
    for i in range(stations):
        t = i / (stations - 1)
        # A shallow arch so the hose clears the trigger hand.
        spine.append((0.0, BARREL_Y + 0.024 * math.sin(t * math.pi), 0.090 + 0.330 * t))
    parts.append(_ribbed_hose("Hose", spine, 0.062))

    parts.append(hazard_ring("Hazard", radius=0.086, depth=0.085,
                             loc=(0.0, BARREL_Y, 0.455)))

    bell = from_profile(
        "Bell",
        [(0.062, 0.420), (0.078, 0.520), (0.185, 0.760), (0.205, 0.840),
         (0.188, 0.808), (0.082, 0.560), (0.070, 0.470)],
        segments=12, color="metal_dark", family="Metal", close_bottom=False,
    )
    paint(bell, "black", family="Metal",
          faces=select_faces(bell, lambda c, n: n.z > 0.9))            # the throat
    paint(bell, "gold", family="Metal",
          faces=select_faces(bell, lambda c, n: c.z > 0.780 and n.z < 0.5))
    smooth(bell, 44)
    place(bell, loc=(0.0, BARREL_Y, 0.0))
    parts.append(bell)

    unit = join(parts, "Compressor")
    orient_tool(unit)
    report(unit)
    export_glb(unit, "compressor")


BUILDERS = {
    "hands": build_hands,
    "pitchfork": build_pitchfork,
    "rake": build_rake,
    "hay_hook": build_hay_hook,
    "leaf_blower": build_leaf_blower,
    "hay_vacuum": build_hay_vacuum,
    "vacuum_pack": build_vacuum_pack,
    "magnifier": build_magnifier,
    "metal_detector": build_metal_detector,
    "compressor": build_compressor,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[tools] {name}")
        fn()
