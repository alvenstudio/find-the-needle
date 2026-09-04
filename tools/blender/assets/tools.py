"""First-person viewmodels.

These are the meshes the player looks at for the entire game, so they get the
most geometry and the most detail per triangle of anything in the project.

CONVENTION: every tool is built with its GRIP at the origin and its business end
pointing along +Y, with +Z up. Blender's +Y is glTF's -Z once export_yup has
done its work, which is "into the screen, away from the camera" in three.js -
i.e. forward. The game parents the model to a hand node and applies its own
carry offset, so the pivot is what matters.

The powered tools (blower, vacuum wand, detector, compressor) are far easier to
lay out around their own body centre, so they build in body space and call
recentre() onto the grip before export. If the game has offsets tuned against
the old body-centred pivots, they need re-zeroing - the grip is now (0,0,0) on
every tool in this file, which is what the convention above always claimed.

House style reminder: chunky. A real pitchfork handle is 3 cm across; ours is
6 cm, because at a 72-degree field of view a realistic handle is two pixels wide
and reads as a scratch on the screen.
"""

import math

import bpy
from mathutils import Matrix, Vector

# Anything thinner than this vanishes at viewmodel distance.
MIN_BAR = 0.022

# Distance between the player's two fists.  Two-handed tools put a wrapped grip
# here so the forward hand has somewhere to land instead of closing on bare wood.
HAND_SPAN = 0.208


# ---------------------------------------------------------------------------
# shared builders
# ---------------------------------------------------------------------------
def shaft(name, length, radius, color="wood", family="Prop", taper=1.0, verts=10):
    """A handle lying along -Y with its butt at the origin."""
    profile = [(radius, 0.0), (radius * 1.06, length * 0.08), (radius * taper, length)]
    bar = from_profile(name, profile, segments=verts, color=color, family=family)
    place(bar, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(bar)
    smooth(bar, 50)
    return bar


def band(name, y, radius, width, color="metal_dark", family="Metal", verts=10):
    """A ferrule or collar around a shaft."""
    ring = cylinder(name, radius=radius, depth=width, verts=verts,
                    loc=(0.0, y, 0.0), rot=(math.radians(90), 0.0, 0.0),
                    color=color, family=family)
    smooth(ring, 50)
    return ring


def curved_bar(name, points, radii, color, family="Prop", verts=6):
    """Sweep a circular cross-section along a polyline.

    Used for tines, hooks, wire handles and hose runs - anything that has to
    bend without looking like a chain of separate cylinders.

    The cross-section frame is parallel-transported from the first station.
    Re-deriving it from a world axis at every station (the obvious way) makes
    the ring snap 90 degrees the instant the tangent crosses the "too close to
    the reference axis" threshold - which the hay hook's curl does, right at the
    tightest part of the bend, pinching the tube into a fan of folded quads.
    """
    stations = len(points)
    verts_out = []
    faces = []
    up = None
    for i, point in enumerate(points):
        centre = Vector(point)
        ahead = Vector(points[min(i + 1, stations - 1)])
        behind = Vector(points[max(i - 1, 0)])
        forward = (ahead - behind)
        if forward.length < 1e-6:
            forward = Vector((0.0, -1.0, 0.0))
        forward.normalize()
        if up is None:
            # Seed the frame from a world axis exactly once.
            reference = Vector((0.0, 0.0, 1.0))
            if abs(forward.dot(reference)) > 0.95:
                reference = Vector((1.0, 0.0, 0.0))
            side = forward.cross(reference).normalized()
            up = side.cross(forward).normalized()
        else:
            # Parallel transport: project the previous up onto the plane
            # perpendicular to the new tangent and re-orthogonalise.
            up = up - forward * up.dot(forward)
            if up.length < 1e-6:
                up = Vector((0.0, 0.0, 1.0)) - forward * forward.z
            up.normalize()
            side = forward.cross(up).normalized()
            up = side.cross(forward).normalized()
        for k in range(verts):
            angle = TAU * k / verts
            verts_out.append(centre + side * (math.cos(angle) * radii[i]) + up * (math.sin(angle) * radii[i]))

    for i in range(stations - 1):
        a, b = i * verts, (i + 1) * verts
        for k in range(verts):
            k2 = (k + 1) % verts
            faces.append((a + k, b + k, b + k2, a + k2))
    faces.append(tuple(range(verts - 1, -1, -1)))
    faces.append(tuple(range((stations - 1) * verts, stations * verts)))

    bar = from_points(name, verts_out, faces, color=color, family=family)
    smooth(bar, 55)
    return bar


def arc_points(centre, radius, start_deg, end_deg, steps, plane="xz"):
    """Sample an arc, for hooks, wire handles and D-grips."""
    points = []
    for i in range(steps):
        t = i / (steps - 1)
        angle = math.radians(start_deg + (end_deg - start_deg) * t)
        c, s = math.cos(angle) * radius, math.sin(angle) * radius
        if plane == "xz":
            points.append((centre[0] + c, centre[1], centre[2] + s))
        elif plane == "yz":
            points.append((centre[0], centre[1] + c, centre[2] + s))
        else:
            points.append((centre[0] + c, centre[1] + s, centre[2]))
    return points


def grip_wrap(name, y0, y1, radius, color="rubber", count=3, verts=8):
    """A moulded grip: fat rings so the hand has somewhere to sit."""
    rings = []
    for i in range(count):
        t = (i + 0.5) / count
        rings.append(band(f"{name}{i}", y0 + (y1 - y0) * t, radius * 1.16, (y1 - y0) / count * 0.78,
                          color=color, family="Prop", verts=verts))
    return rings


def mouth_faces(obj, y_min, max_radius):
    """The faces you see looking down the barrel of a lathed mouth.

    Everything past ``y_min`` and inside ``max_radius`` that either faces the
    axis (the bore wall) or faces straight back out of the mouth (the recessed
    throat floor).  Painting these dark is what makes a nozzle read as a hole
    instead of a plug.  Assumes the lathe has been stood up along +Y.
    """
    def inside(centre, normal):
        if centre.y < y_min:
            return False
        radial = Vector((centre.x, 0.0, centre.z))
        if radial.length > max_radius:
            return False
        if normal.y > 0.8:
            return True
        return (radial.length > 1e-5
                and radial.normalized().dot(Vector((normal.x, 0.0, normal.z))) < 0.0)

    return select_faces(obj, inside)


def recentre(obj, point):
    """Slide the mesh so ``point`` ends up on the object origin.

    The powered tools are far easier to lay out around their own body centre,
    but the viewmodel convention wants the *grip* at (0,0,0) so the game's hand
    node has something meaningful to hang the model from.  Build in body space,
    shift at the end.
    """
    obj.data.transform(Matrix.Translation(-Vector(point)))
    obj.data.update()
    return obj


# ---------------------------------------------------------------------------
# hands
# ---------------------------------------------------------------------------
FINGER_GAP = 0.004


def build_hand(side, suffix):
    """One gloved mitten hand with a rolled plaid sleeve.

    Proportions are Roblox-chunky on purpose: a block of three fingers plus a
    separate thumb reads as a hand from inside a first-person camera far better
    than five modelled digits ever would at this size. The forearm is cut short
    because the viewmodel only ever shows the last hand's width of it.
    """
    parts = []
    x = HAND_SPAN * 0.5 * side

    forearm = cube(f"Forearm{suffix}", size=(0.094, 0.175, 0.094), loc=(x, 0.088, -0.010),
                   color="barn_red")
    bevel(forearm, 0.012, 2)
    apply_modifiers(forearm)
    # Plaid: cream weft bands around the sleeve plus one warp stripe along it.
    # Bands read from every angle, which a lengthwise stripe alone does not.
    for centre in (0.045, 0.115):
        paint(forearm, "barn_trim",
              faces=select_faces(forearm, lambda c, n, y=centre: abs(n.y) < 0.5 and abs(c.y - y) < 0.017))
    paint(forearm, shade("barn_red", 0.55),
          faces=select_faces(forearm, lambda c, n: abs(n.z) > 0.7 and abs(c.x - x) < 0.018))
    paint(forearm, shade("barn_red", 0.60),
          faces=select_faces(forearm, lambda c, n: n.z < -0.7
                             and abs(c.y - 0.045) > 0.017 and abs(c.y - 0.115) > 0.017))
    parts.append(forearm)

    cuff = cube(f"Cuff{suffix}", size=(0.108, 0.040, 0.108), loc=(x, 0.004, -0.010),
                color="barn_trim")
    bevel(cuff, 0.010, 2)
    parts.append(cuff)

    # Deliberately long in Y: the cuff and the palm each swallow a few
    # millimetres of it, or the bevels open a slit that daylight shows through.
    wrist = cube(f"Wrist{suffix}", size=(0.082, 0.046, 0.082), loc=(x, -0.032, -0.012), color="skin")
    bevel(wrist, 0.012, 2)
    parts.append(wrist)

    palm = cube(f"Palm{suffix}", size=(0.104, 0.125, 0.078), loc=(x, -0.110, -0.014),
                color="glove")
    bevel(palm, 0.016, 2)
    apply_modifiers(palm)
    # A darker leather palm on the grip side sells the glove.
    paint(palm, shade("glove", 0.70), faces=select_faces(palm, lambda c, n: n.z < -0.6))
    parts.append(palm)

    # Three fingers as separate blocks: cheap, and the gaps catch shadow.
    for i in range(3):
        offset = (i - 1) * 0.033
        length = 0.082 - abs(i - 1) * 0.012
        # Rooted 6 mm inside the palm block; the palm's 0.016 bevel eats a
        # butt-joint alive.
        finger = cube(f"Finger{suffix}{i}", size=(0.029, length, 0.058),
                      loc=(x + offset, -0.166 - length * 0.5, -0.018), color="glove")
        bevel(finger, 0.011, 2)
        apply_modifiers(finger)
        paint(finger, shade("glove", 0.80), faces=select_faces(finger, lambda c, n: n.z < -0.6))
        paint(finger, shade("glove", 1.08), faces=select_faces(finger, lambda c, n: n.z > 0.6))
        parts.append(finger)

    thumb = cube(f"Thumb{suffix}", size=(0.037, 0.088, 0.050),
                 loc=(x - 0.058 * side, -0.138, -0.006),
                 rot=(0.0, 0.0, math.radians(32 * side)), color="glove")
    bevel(thumb, 0.013, 2)
    parts.append(thumb)

    knuckles = cube(f"Knuckles{suffix}", size=(0.100, 0.026, 0.030), loc=(x, -0.168, 0.014),
                    color=shade("glove", 0.86))
    bevel(knuckles, 0.008, 1)
    parts.append(knuckles)

    return parts


def build_hands():
    """Both hands, toed in and tipped up.

    At a 74-degree field of view a pair pointing straight down -Y sits at the
    very edges of the frame and reads as two disconnected lumps. Angling them
    puts them where a person's hands actually are when they are about to grab
    something, and turns the backs of the gloves toward the camera where the
    knuckle block and the finger gaps can be seen.
    """
    parts = []
    for side, suffix, roll in ((1, "R", -15.0), (-1, "L", 15.0)):
        hand = join(build_hand(side, suffix), f"Hand{suffix}")
        place(hand, rot=(math.radians(-14), 0.0, math.radians(roll)))
        apply_transform(hand)
        parts.append(hand)

    hands = join(parts, "Hands")
    set_origin(hands, (0.0, 0.0, 0.0))
    report(hands)
    export_glb(hands, "hands")


# ---------------------------------------------------------------------------
# pitchfork
# ---------------------------------------------------------------------------
PITCHFORK_LENGTH = 0.86
TINE_SPREAD = 0.105


def build_pitchfork():
    """Ash haft, D-grip, iron socket and three curved tines.

    1.34 m from the back of the D to the tine tips, with the tips 1.27 m ahead
    of the grip.  A D-grip belongs on a SHORT fork - a long two-handed haft is
    held bare at the butt - and at 1.62 m eye height anything further out than
    this stops reading as a fork and starts reading as a pike with specks on the
    end.
    """
    parts = []
    handle = shaft("Handle", PITCHFORK_LENGTH, 0.030, color="wood", taper=0.94)
    parts.append(handle)
    # A worn, darker patch where the forward hand rides.
    paint(handle, shade("wood", 0.74),
          faces=select_faces(handle, lambda c, n: 0.28 < c.y < 0.40))
    # ...and a wrapped grip under it, so the forward fist has a landing pad
    # instead of closing on bare dowel.
    parts.extend(grip_wrap("Wrap", HAND_SPAN - 0.055, HAND_SPAN + 0.055, 0.030,
                           color="rope", count=2))

    # D-grip at the butt.
    parts.append(band("ButtRing", -0.012, 0.038, 0.028, color="iron"))
    for x in (-0.041, 0.041):
        parts.append(cube("DSide", size=(0.020, 0.024, 0.115), loc=(x, -0.055, 0.0), color="wood_dark"))
    parts.append(curved_bar("DTop", arc_points((0.0, -0.055, 0.0), 0.041, 180, 0, 7, plane="xy"),
                            [0.017] * 7, "wood_dark"))

    parts.append(band("Ferrule", PITCHFORK_LENGTH - 0.05, 0.037, 0.075, color="iron"))
    socket = from_profile(
        "Socket",
        # Starts on a small ring rather than a point: from_profile winds an
        # apex-at-the-bottom fan inside-out, and the flipped band poisons the
        # averaged normals of the correctly wound band next to it.
        [(0.026, PITCHFORK_LENGTH - 0.01), (0.036, PITCHFORK_LENGTH + 0.005),
         (0.050, PITCHFORK_LENGTH + 0.075), (0.062, PITCHFORK_LENGTH + 0.135),
         (0.0, PITCHFORK_LENGTH + 0.150)],
        segments=10, color="metal_dark", family="Metal",
    )
    place(socket, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(socket)
    smooth(socket, 45)
    parts.append(socket)

    root = PITCHFORK_LENGTH + 0.11
    for i, offset in enumerate((-TINE_SPREAD, 0.0, TINE_SPREAD)):
        splay = offset * 1.35
        points = [
            (offset * 0.35, root, 0.0),
            (offset * 0.8, root + 0.11, 0.010),
            (offset + splay * 0.35, root + 0.22, 0.024),
            (offset + splay * 0.7, root + 0.30, 0.042),
        ]
        radii = [0.020, 0.017, 0.012, 0.0035]
        tine = curved_bar(f"Tine{i}", points, radii, "metal", family="Metal")
        parts.append(tine)

    fork = join(parts, "Pitchfork")
    set_origin(fork, (0.0, 0.0, 0.0))
    report(fork)
    export_glb(fork, "pitchfork")


# ---------------------------------------------------------------------------
# rake
# ---------------------------------------------------------------------------
RAKE_LENGTH = 1.22
RAKE_TEETH = 11
RAKE_WIDTH = 0.62


def build_rake():
    """A wide head on a stout handle, with braced shoulders.

    1.33 m butt to tooth tips, 0.62 m across the head.
    """
    parts = []
    handle = shaft("Handle", RAKE_LENGTH, 0.028, color="wood_light", taper=0.95)
    parts.append(handle)
    paint(handle, shade("wood_light", 0.72),
          faces=select_faces(handle, lambda c, n: 0.26 < c.y < 0.46))
    parts.append(band("ButtCap", -0.008, 0.034, 0.022, color="iron"))
    parts.append(band("Ferrule", RAKE_LENGTH - 0.04, 0.035, 0.07, color="iron"))

    # +0.02, not +0.10: the head used to hang 71 mm off the end of the handle
    # with only two 12 mm braces crossing the gap.  Now the handle's end cap is
    # buried inside the head bar.
    head_y = RAKE_LENGTH + 0.02
    bar = cube("HeadBar", size=(RAKE_WIDTH, 0.058, 0.072), loc=(0.0, head_y, 0.0), color="wood_dark")
    bevel(bar, 0.016, 2)
    apply_modifiers(bar)
    paint(bar, shade("wood_dark", 1.22), faces=select_faces(bar, lambda c, n: n.z > 0.7))
    parts.append(bar)

    # Shoulder braces from the ferrule out to the ends of the head.
    for x in (-RAKE_WIDTH * 0.42, RAKE_WIDTH * 0.42):
        brace = curved_bar(
            f"Brace{x:.2f}",
            [(0.0, RAKE_LENGTH - 0.06, 0.0), (x * 0.55, head_y - 0.04, 0.004), (x, head_y - 0.005, 0.006)],
            [0.014, 0.012, 0.011], "metal_dark", family="Metal",
        )
        parts.append(brace)

    for i in range(RAKE_TEETH):
        t = i / (RAKE_TEETH - 1) - 0.5
        x = t * RAKE_WIDTH * 0.93
        points = [
            (x, head_y, -0.02),
            (x, head_y + 0.055, -0.075),
            (x, head_y + 0.075, -0.145),
        ]
        parts.append(curved_bar(f"Tooth{i}", points, [0.016, 0.013, 0.0045], "metal", family="Metal"))

    rake = join(parts, "Rake")
    set_origin(rake, (0.0, 0.0, 0.0))
    report(rake)
    export_glb(rake, "rake")


# ---------------------------------------------------------------------------
# hay hook
# ---------------------------------------------------------------------------
def build_hay_hook():
    """A short, heavy hand hook: turned grip, steel shank, fat curl.

    0.35 m nose to tail, one-handed - pair it with the single-hand model.
    """
    parts = []
    grip = from_profile(
        "Grip",
        # Butt starts on a small ring, not a point: an apex-at-the-bottom fan
        # comes out of from_profile wound inside-out.
        [(0.014, -0.01), (0.040, 0.0), (0.048, 0.045), (0.046, 0.115), (0.036, 0.155), (0.0, 0.165)],
        segments=12, color="wood",
    )
    place(grip, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(grip)
    smooth(grip, 50)
    parts.append(grip)
    paint(grip, shade("wood", 0.7), faces=select_faces(grip, lambda c, n: 0.05 < c.y < 0.095))
    parts.append(band("Collar", 0.172, 0.030, 0.028, color="iron"))

    # The old lead-in point sat 3 mm from the first arc sample, which squashed
    # one band flat; the arc's own first sample is the shank top.
    points = [(0.0, 0.185, 0.0)]
    points += arc_points((0.0, 0.245, -0.088), 0.094, 88, -95, 9, plane="yz")
    radii = [0.017] + [0.016, 0.015, 0.014, 0.013, 0.011, 0.009, 0.007, 0.005, 0.003]
    parts.append(curved_bar("Hook", points, radii, "metal", family="Metal", verts=7))

    hook = join(parts, "HayHook")
    set_origin(hook, (0.0, 0.0, 0.0))
    report(hook)
    export_glb(hook, "hay_hook")


# ---------------------------------------------------------------------------
# leaf blower
# ---------------------------------------------------------------------------
def build_leaf_blower():
    """A fat cartoon blower: shell, carry arch, trigger grip and flared tube.

    0.77 m from the intake screen to the nozzle rim.  Built around the body
    centre and shifted onto the grip at the end.
    """
    parts = []

    shell = from_profile(
        "Shell",
        # The 0.018 first ring is not decoration: from_profile winds an
        # apex-at-the-bottom fan inside-out, and once the part is smoothed the
        # flipped band drags the shared ring's normals into a dark blotchy seam.
        # A small ring routes the band through the (correct) quad branch and
        # lets close_bottom cap it.
        [(0.018, -0.03), (0.070, -0.02), (0.092, 0.03), (0.096, 0.16), (0.088, 0.26),
         (0.062, 0.30), (0.0, 0.31)],
        segments=12, color="pumpkin",
    )
    place(shell, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(shell)
    smooth(shell, 46)
    parts.append(shell)
    # Cooling slats: alternating darker faces around the barrel.
    slats = [p.index for p in shell.data.polygons
             if 0.06 < p.center.y < 0.20 and int((math.atan2(p.center.z, p.center.x) + TAU) / TAU * 12) % 2 == 0]
    paint(shell, shade("pumpkin", 0.66), faces=slats)

    # A plain capped ring, not two apex fans: same silhouette, fewer triangles,
    # and no inside-out band at either end.
    intake = from_profile(
        "Intake",
        [(0.070, 0.0), (0.070, 0.02)],
        segments=12, color="rubber",
    )
    place(intake, loc=(0.0, -0.045, 0.0), rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(intake)
    parts.append(intake)
    for i in range(4):
        vane = cube(f"Vane{i}", size=(0.13, 0.014, 0.012), loc=(0.0, -0.042, 0.0),
                    rot=(0.0, math.radians(45 * i), 0.0), color="metal_dark", family="Metal")
        parts.append(vane)

    # Carry arch across the top.
    arch = curved_bar("Arch", arc_points((0.0, 0.13, 0.088), 0.075, 160, 20, 7, plane="yz"),
                      [0.019] * 7, "rubber")
    parts.append(arch)

    # Trigger grip hanging below, angled back into the palm.
    handle = cube("Handle", size=(0.055, 0.075, 0.155), loc=(0.0, 0.055, -0.135),
                  rot=(math.radians(16), 0.0, 0.0), color="rubber")
    bevel(handle, 0.02, 2)
    parts.append(handle)
    parts.extend(grip_wrap("HandleRib", 0.03, 0.09, 0.028, color=shade("rubber", 1.5)))
    trigger = cube("Trigger", size=(0.026, 0.020, 0.052), loc=(0.0, 0.006, -0.10),
                   rot=(math.radians(-12), 0.0, 0.0), color="metal_dark", family="Metal")
    parts.append(trigger)

    # Blow tube: straight run, flare, then a rolled lip that turns back down the
    # bore to a recessed throat.  The old profile closed with an apex, which
    # plugged the nozzle with a cone - a leaf blower you cannot see into reads as
    # a solid orange stick.  Running the profile back inside gives a real hole
    # with no open edge and no backfaces on show.
    tube = from_profile(
        "Tube",
        [(0.020, 0.30), (0.052, 0.31), (0.050, 0.52), (0.056, 0.60), (0.108, 0.696),
         (0.126, 0.726), (0.104, 0.726), (0.052, 0.625), (0.0, 0.618)],
        segments=12, color="metal_dark", family="Metal",
    )
    place(tube, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(tube)
    smooth(tube, 44)
    # Orange lip band, painted rather than hooped on: a solid ring cylinder here
    # would cap the mouth again with its own end disc.
    paint(tube, "pumpkin",
          faces=select_faces(tube, lambda c, n: n.y > 0.85 and c.y > 0.70))
    paint(tube, shade("metal_dark", 0.30), family="Metal",
          faces=mouth_faces(tube, 0.615, 0.105))
    parts.append(tube)
    parts.append(band("TubeRing", 0.52, 0.058, 0.024, color="pumpkin", family="Prop"))

    exhaust = cylinder("Exhaust", radius=0.020, depth=0.06, verts=8, loc=(0.072, 0.20, 0.052),
                       rot=(math.radians(90), 0.0, 0.0), color="iron", family="Metal")
    parts.append(exhaust)
    pull = cylinder("PullKnob", radius=0.016, depth=0.028, verts=8, loc=(-0.086, 0.05, 0.03),
                    rot=(0.0, math.radians(90), 0.0), color="metal_dark", family="Metal")
    parts.append(pull)
    # Starter cord from the knob back into the recoil housing.
    parts.append(curved_bar(
        "PullCord",
        [(-0.098, 0.052, 0.028), (-0.096, 0.085, 0.040), (-0.086, 0.115, 0.052),
         (-0.072, 0.130, 0.058)],
        [0.006] * 4, "rope", verts=4,
    ))
    # Maker's plate.  The shell is a 12-gon, so what the plate has to sink into
    # is the facet plane (r * cos 15 deg = 0.0919 here), not the vertex radius -
    # sitting on the vertex radius leaves it hovering 3 mm off every facet.
    plate = cube("Plate", size=(0.006, 0.05, 0.028), loc=(-0.088, 0.17, 0.0), color="barn_trim")
    parts.append(plate)

    blower = join(parts, "LeafBlower")
    recentre(blower, (0.0, 0.055, -0.135))
    set_origin(blower, (0.0, 0.0, 0.0))
    report(blower)
    export_glb(blower, "leaf_blower")


# ---------------------------------------------------------------------------
# hay vacuum
# ---------------------------------------------------------------------------
def build_hay_vacuum():
    """The wand: pistol grip, straight run, wide intake funnel, hose stub.

    0.99 m from the hose tail to the funnel rim, 0.30 m across the mouth.
    """
    parts = []

    body = from_profile(
        "Body",
        # Small first ring (an apex-at-the-bottom fan comes out inside-out), and
        # the funnel folds back to a recessed throat at 0.41 instead of closing
        # over with a cone - a hay vacuum wants a hole you can see into.
        [(0.020, -0.05), (0.055, -0.04), (0.058, 0.10), (0.052, 0.30), (0.058, 0.36),
         (0.120, 0.50), (0.148, 0.552), (0.126, 0.552), (0.062, 0.420), (0.0, 0.410)],
        segments=12, color="metal", family="Metal",
    )
    place(body, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(body)
    smooth(body, 44)
    # Denim lip painted on the flat rim; a solid ring here would re-cap the mouth.
    paint(body, "denim",
          faces=select_faces(body, lambda c, n: n.y > 0.85 and c.y > 0.53))
    paint(body, shade("metal", 0.28), family="Metal",
          faces=mouth_faces(body, 0.405, 0.115))
    parts.append(body)

    parts.append(band("Collar", 0.10, 0.066, 0.03, color="denim", family="Prop"))
    parts.append(band("Collar2", 0.33, 0.064, 0.026, color="denim", family="Prop"))

    grip = cube("Grip", size=(0.052, 0.07, 0.145), loc=(0.0, 0.055, -0.115),
                rot=(math.radians(14), 0.0, 0.0), color="rubber")
    bevel(grip, 0.02, 2)
    parts.append(grip)
    parts.extend(grip_wrap("GripRib", 0.028, 0.085, 0.026, color=shade("rubber", 1.55)))
    trigger = cube("Trigger", size=(0.024, 0.018, 0.05), loc=(0.0, 0.008, -0.082),
                   rot=(math.radians(-10), 0.0, 0.0), color="metal_dark", family="Metal")
    parts.append(trigger)

    # Hose stub running back over the shoulder to the pack.  Starts at -0.035,
    # inside the body: at -0.06 its capped end sat a centimetre behind the
    # body's own capped tail with daylight in between.
    hose_points = [(0.0, -0.035 - i * 0.080, -0.02 - i * i * 0.012) for i in range(6)]
    parts.append(curved_bar("Hose", hose_points, [0.046] * 6, "rubber", verts=8))
    for i in range(5):
        parts.append(torus(f"HoseRib{i}", major=0.049, minor=0.011, major_seg=8, minor_seg=5,
                           loc=hose_points[i + 1], rot=(math.radians(90 - i * 6), 0.0, 0.0),
                           color=shade("rubber", 1.5)))

    # Suction gauge.  The old one floated: its inner cap sat at radius 0.054
    # against a 12-gon body whose facet plane is only 0.0525 out, so it touched
    # nothing but the ridges.  This one is sunk 8 mm past the facet and has an
    # actual face and needle instead of being a blank white puck.
    gauge = cylinder("Gauge", radius=0.026, depth=0.030, verts=8, loc=(0.050, 0.22, 0.0),
                     rot=(0.0, math.radians(90), 0.0), color="metal_dark", family="Metal")
    parts.append(gauge)
    face = cylinder("GaugeFace", radius=0.019, depth=0.008, verts=8, loc=(0.066, 0.22, 0.0),
                    rot=(0.0, math.radians(90), 0.0), color="barn_trim")
    parts.append(face)
    parts.append(cube("GaugeNeedle", size=(0.004, 0.004, 0.026), loc=(0.0695, 0.2275, 0.0107),
                      rot=(math.radians(-35), 0.0, 0.0), color="barn_red"))

    wand = join(parts, "HayVacuum")
    recentre(wand, (0.0, 0.055, -0.115))
    set_origin(wand, (0.0, 0.0, 0.0))
    report(wand)
    export_glb(wand, "hay_vacuum")


def build_vacuum_pack():
    """The backpack canister, drawn on the player's back rather than in hand."""
    parts = []
    tank = from_profile(
        "Tank",
        # Flat base and a flat shoulder rather than points at both ends: an
        # apex-at-the-bottom fan is wound inside-out, and a canister with a
        # pointed bottom cannot sit on anything anyway.
        [(0.06, 0.0), (0.16, 0.02), (0.185, 0.10), (0.185, 0.52), (0.16, 0.60), (0.10, 0.618)],
        segments=14, color="denim",
    )
    smooth(tank, 44)
    parts.append(tank)
    for z in (0.16, 0.34, 0.50):
        parts.append(torus(f"Hoop{z}", major=0.19, minor=0.016, major_seg=14, minor_seg=6,
                           loc=(0.0, 0.0, z), color="metal_dark", family="Metal"))
    window = cube("Window", size=(0.055, 0.02, 0.28), loc=(0.0, -0.182, 0.31), color="straw_light")
    parts.append(window)
    cap = from_profile("Cap", [(0.03, 0.62), (0.085, 0.63), (0.085, 0.70), (0.0, 0.71)],
                       segments=10, color="metal", family="Metal")
    smooth(cap, 44)
    parts.append(cap)
    for x in (-0.13, 0.13):
        # y=0.150, not 0.185: the tank's surface at x=0.13 is only 0.132 out, so
        # the old straps ran their whole length 4 cm clear of the canister.
        strap = cube("Strap", size=(0.062, 0.028, 0.60), loc=(x, 0.150, 0.31),
                     rot=(math.radians(-6), 0.0, 0.0), color="wood_dark")
        bevel(strap, 0.01, 1)
        parts.append(strap)
    port = cylinder("Port", radius=0.05, depth=0.09, verts=10, loc=(0.0, -0.20, 0.50),
                    rot=(math.radians(90), 0.0, 0.0), color="rubber")
    parts.append(port)

    pack = join(parts, "VacuumPack")
    set_origin(pack, (0.0, 0.0, 0.0))
    report(pack)
    export_glb(pack, "vacuum_pack")


# ---------------------------------------------------------------------------
# magnifier
# ---------------------------------------------------------------------------
def build_magnifier():
    """Brass rim, real glass lens, turned handle with a worn grip.

    0.335 m butt to the top of the rim, 0.20 m across the glass.  One-handed:
    pair it with the single-hand model, not the pair.
    """
    parts = []
    handle = from_profile(
        "Handle",
        # 0.012 butt ring, not a point - the apex-at-the-bottom band would be
        # wound inside-out and blotch the smoothed butt.
        [(0.012, -0.005), (0.030, 0.0), (0.034, 0.02), (0.026, 0.05), (0.030, 0.10),
         (0.026, 0.145), (0.020, 0.165), (0.0, 0.172)],
        segments=12, color="wood_dark",
    )
    place(handle, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(handle)
    smooth(handle, 50)
    parts.append(handle)
    paint(handle, shade("wood_dark", 1.3), faces=select_faces(handle, lambda c, n: 0.05 < c.y < 0.10))

    parts.append(band("Collar", 0.178, 0.024, 0.026, color="gold"))
    neck = cube("Neck", size=(0.026, 0.05, 0.020), loc=(0.0, 0.205, 0.0), color="gold", family="Metal")
    bevel(neck, 0.006, 1)
    parts.append(neck)

    rim = torus("Rim", major=0.088, minor=0.014, major_seg=20, minor_seg=7,
                loc=(0.0, 0.316, 0.0), rot=(math.radians(90), 0.0, 0.0), color="gold", family="Metal")
    smooth(rim, 50)
    parts.append(rim)
    # A slim inner bezel keeps the glass from floating in the middle of nothing.
    bezel = torus("Bezel", major=0.080, minor=0.006, major_seg=20, minor_seg=5,
                  loc=(0.0, 0.316, 0.0), rot=(math.radians(90), 0.0, 0.0),
                  color=shade("gold", 0.7), family="Metal")
    smooth(bezel, 50)
    parts.append(bezel)

    # Gently domed lens, so the highlight sweeps as the player turns.
    lens = from_profile(
        "Lens",
        [(0.014, -0.012), (0.048, -0.008), (0.078, 0.0), (0.048, 0.008), (0.0, 0.012)],
        segments=20, color="glass", family="Glass",
    )
    place(lens, loc=(0.0, 0.316, 0.0), rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(lens)
    smooth(lens, 60)
    parts.append(lens)

    for x in (-0.058, 0.058):
        rivet = cylinder("Rivet", radius=0.007, depth=0.032, verts=6, loc=(x, 0.316, -0.062),
                         rot=(math.radians(90), 0.0, 0.0), color=shade("gold", 1.3), family="Metal")
        parts.append(rivet)

    glass = join(parts, "Magnifier")
    set_origin(glass, (0.0, 0.0, 0.0))
    report(glass)
    export_glb(glass, "magnifier")


# ---------------------------------------------------------------------------
# metal detector
# ---------------------------------------------------------------------------
def build_metal_detector():
    """Armrest cuff, control box with a real dial, and a wide search coil.

    1.02 m from the cuff to the far edge of the coil, with the coil 0.30 m below
    the shaft line.  Built around the grip and shifted onto it at the end.
    """
    parts = []

    cuff = from_profile("Cuff", [(0.052, 0.0), (0.052, 0.10), (0.044, 0.115)],
                        segments=10, color="metal", family="Metal",
                        close_bottom=False, close_top=False)
    place(cuff, loc=(0.0, -0.04, 0.055), rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(cuff)
    solidify(cuff, 0.009)
    smooth(cuff, 50)
    parts.append(cuff)

    upper = shaft("Upper", 0.30, 0.024, color="metal", family="Metal")
    parts.append(upper)

    # z=-0.078, not -0.085: the shaft's surface is at -0.024 and the old grip
    # topped out at -0.0275, so the two never met.
    grip = cube("Grip", size=(0.046, 0.058, 0.115), loc=(0.0, 0.20, -0.078),
                rot=(math.radians(12), 0.0, 0.0), color="rubber")
    bevel(grip, 0.016, 2)
    parts.append(grip)
    parts.extend(grip_wrap("GripRib", 0.175, 0.235, 0.023, color=shade("rubber", 1.5)))

    box = cube("Box", size=(0.150, 0.115, 0.105), loc=(0.0, 0.115, 0.098), color="barn_trim")
    bevel(box, 0.016, 2)
    apply_modifiers(box)
    paint(box, shade("barn_trim", 0.55), faces=select_faces(box, lambda c, n: n.z < -0.6))
    parts.append(box)

    dial = cylinder("Dial", radius=0.044, depth=0.012, verts=16, loc=(0.0, 0.062, 0.108),
                    rot=(math.radians(90), 0.0, 0.0), color="white")
    parts.append(dial)
    for i in range(9):
        angle = math.radians(-100 + i * 25)
        tick = cube(f"Tick{i}", size=(0.005, 0.006, 0.016),
                    loc=(math.sin(angle) * 0.033, 0.056, 0.108 + math.cos(angle) * 0.033),
                    rot=(0.0, -angle, 0.0), color="black")
        parts.append(tick)
    # The needle pivots ON the dial centre and crosses its face by a millimetre.
    # Offset from the centre it reads as one more tick mark, and flush with the
    # face it z-fights, because glTF exports these doubleSided.
    hub = cylinder("DialHub", radius=0.007, depth=0.008, verts=6, loc=(0.0, 0.0525, 0.108),
                   rot=(math.radians(90), 0.0, 0.0), color="black")
    parts.append(hub)
    needle = cube("DialNeedle", size=(0.004, 0.007, 0.042), loc=(-0.0086, 0.0535, 0.1272),
                  rot=(0.0, math.radians(-24), 0.0), color="barn_red")
    parts.append(needle)
    for x in (-0.052, 0.052):
        knob = cylinder("Knob", radius=0.018, depth=0.026, verts=8, loc=(x, 0.062, 0.048),
                        rot=(math.radians(90), 0.0, 0.0), color="rubber")
        parts.append(knob)

    # Sleeved 35 mm up over the upper shaft.  Butted at 0.30 the two end caps
    # were coplanar, and glTF exports both sides of both of them.
    lower = curved_bar(
        "Lower",
        [(0.0, 0.265, 0.0), (0.0, 0.52, -0.05), (0.0, 0.70, -0.14), (0.0, 0.80, -0.235)],
        [0.026, 0.021, 0.019, 0.017], "metal", family="Metal", verts=8,
    )
    parts.append(lower)

    coil_ring = torus("Coil", major=0.165, minor=0.030, major_seg=18, minor_seg=6,
                      loc=(0.0, 0.90, -0.27), rot=(math.radians(78), 0.0, 0.0),
                      color="rubber")
    smooth(coil_ring, 46)
    parts.append(coil_ring)
    # A capped ring, not a pair of apex fans - the bottom fan came out
    # inside-out and the top fan was a solid cap over it either way.
    coil_face = from_profile("CoilFace", [(0.168, 0.0), (0.168, 0.018)],
                             segments=18, color=shade("rubber", 1.5))
    place(coil_face, loc=(0.0, 0.90, -0.28), rot=(math.radians(78), 0.0, 0.0))
    apply_transform(coil_face)
    parts.append(coil_face)
    boss = cylinder("CoilBoss", radius=0.045, depth=0.030, verts=10,
                    loc=(0.0, 0.8804, -0.2758), rot=(math.radians(78), 0.0, 0.0),
                    color="metal_dark", family="Metal")
    parts.append(boss)
    # Long enough to actually bridge the gap: the shaft ends 0.098 m clear of
    # the coil face, so a 0.035 block centred halfway floated in mid-air with
    # daylight on both sides of it.
    yoke = cube("Yoke", size=(0.10, 0.135, 0.036), loc=(0.0, 0.85, -0.2575),
                rot=(math.radians(-24.3), 0.0, 0.0), color="metal_dark", family="Metal")
    parts.append(yoke)

    detector = join(parts, "MetalDetector")
    recentre(detector, (0.0, 0.20, -0.078))
    set_origin(detector, (0.0, 0.0, 0.0))
    report(detector)
    export_glb(detector, "metal_detector")


# ---------------------------------------------------------------------------
# compressor
# ---------------------------------------------------------------------------
def build_compressor():
    """The endgame extractor: motor housing, fan grille, ribbed hose, intake bell.

    0.83 m from the front of the housing to the bell rim (0.93 m corner to
    corner), 0.54 m across the mouth.  Built around the housing centre and
    shifted onto the grip at the end.
    """
    parts = []

    housing = cube("Housing", size=(0.26, 0.30, 0.24), loc=(0.0, 0.10, 0.0), color="metal_dark",
                   family="Metal")
    bevel(housing, 0.028, 2)
    apply_modifiers(housing)
    paint(housing, shade("metal_dark", 0.8),
          faces=select_faces(housing, lambda c, n: n.z > 0.7))
    parts.append(housing)

    # Hazard stripes as a painted deck plate rather than a face subset of the
    # housing: the bevelled top is ONE n-gon plus a ring of bevel slivers, so
    # "paint every other polygon" gave a solid top and a speckled rim, not
    # stripes.  Sixteen verts, seven quads, and it reads from across the yard.
    stripe_verts = []
    stripe_faces = []
    for i in range(8):
        y = -0.015 + 0.230 * i / 7
        stripe_verts.append((-0.095, y, 0.1205))
        stripe_verts.append((0.095, y, 0.1205))
    for i in range(7):
        stripe_faces.append((i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2))
    stripes = from_points("Hazard", stripe_verts, stripe_faces, color="gold", family="Metal")
    paint(stripes, "black", faces=[i for i in range(7) if i % 2])
    parts.append(stripes)

    grille = cylinder("Grille", radius=0.088, depth=0.018, verts=14, loc=(0.135, 0.10, 0.0),
                      rot=(0.0, math.radians(90), 0.0), color="black")
    parts.append(grille)
    for i in range(5):
        blade = cube(f"Blade{i}", size=(0.012, 0.145, 0.034), loc=(0.144, 0.10, 0.0),
                     rot=(math.radians(36 * i), 0.0, 0.0), color="metal", family="Metal")
        parts.append(blade)
    parts.append(torus("GrilleRim", major=0.092, minor=0.012, major_seg=14, minor_seg=5,
                       loc=(0.140, 0.10, 0.0), rot=(0.0, math.radians(90), 0.0),
                       color="gold", family="Metal"))

    plate = cube("Plate", size=(0.006, 0.09, 0.05), loc=(-0.134, 0.10, 0.03), color="barn_trim")
    parts.append(plate)
    for i in range(3):
        lamp = cylinder(f"Lamp{i}", radius=0.011, depth=0.014, verts=6,
                        loc=(-0.02 + i * 0.02, -0.048, 0.085), rot=(math.radians(90), 0.0, 0.0),
                        color=("ufo" if i == 0 else "gold"), family="Emit")
        parts.append(lamp)

    handle = curved_bar("Handle", arc_points((0.0, 0.10, 0.125), 0.115, 168, 12, 9, plane="yz"),
                        [0.022] * 9, "rubber")
    parts.append(handle)
    grip = cube("Grip", size=(0.05, 0.065, 0.14), loc=(0.0, 0.055, -0.175),
                rot=(math.radians(12), 0.0, 0.0), color="rubber")
    bevel(grip, 0.018, 2)
    parts.append(grip)
    trigger = cube("Trigger", size=(0.024, 0.018, 0.05), loc=(0.0, 0.010, -0.135),
                   color="gold", family="Metal")
    parts.append(trigger)

    # Starts at 0.235, inside the housing: the old run began at 0.26 with the
    # housing's back face at 0.25, so the hose's end cap floated a centimetre
    # clear of the machine it is supposed to come out of.
    hose_points = [(0.0, 0.235 + i * 0.068, 0.0) for i in range(5)]
    parts.append(curved_bar("Hose", hose_points, [0.062] * 5, "rubber", verts=10))
    for i in range(4):
        parts.append(torus(f"Rib{i}", major=0.068, minor=0.016, major_seg=10, minor_seg=5,
                           loc=(0.0, 0.269 + i * 0.068, 0.0), rot=(math.radians(90), 0.0, 0.0),
                           color=shade("rubber", 1.6)))

    bell = from_profile(
        "Bell",
        # Small first ring, and the mouth rolls over a flat rim and back down to
        # a throat at 0.59 instead of closing with an apex.  An intake bell you
        # cannot see into is just a cone, and the old gold lip hoop capped the
        # mouth a second time with its own end disc.
        [(0.030, 0.50), (0.070, 0.51), (0.075, 0.56), (0.150, 0.66), (0.235, 0.74),
         (0.268, 0.778), (0.242, 0.778), (0.150, 0.690), (0.080, 0.600), (0.0, 0.590)],
        segments=16, color="metal", family="Metal",
    )
    place(bell, rot=(math.radians(-90), 0.0, 0.0))
    apply_transform(bell)
    smooth(bell, 42)
    paint(bell, "gold", family="Metal",
          faces=select_faces(bell, lambda c, n: n.y > 0.85 and c.y > 0.76))
    paint(bell, shade("metal", 0.26), family="Metal",
          faces=mouth_faces(bell, 0.58, 0.235))
    parts.append(bell)
    # Bracing ribs that follow the flare instead of cutting across it.  Straight
    # bars at a fixed radius sat outside the neck and inside the mouth - now the
    # bell is hollow they would have hung in the middle of the intake.
    for i in range(3):
        angle = math.radians(120 * i + 30)
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        strut = curved_bar(
            f"Strut{i}",
            [(cos_a * 0.062, 0.520, sin_a * 0.062),
             (cos_a * 0.105, 0.600, sin_a * 0.105),
             (cos_a * 0.175, 0.685, sin_a * 0.175)],
            [0.014, 0.013, 0.012], "gold", family="Metal", verts=5,
        )
        parts.append(strut)

    unit = join(parts, "Compressor")
    recentre(unit, (0.0, 0.055, -0.175))
    set_origin(unit, (0.0, 0.0, 0.0))
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
