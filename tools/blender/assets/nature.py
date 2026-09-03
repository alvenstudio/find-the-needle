"""Vegetation, rock and sky scatter -- everything green, stony or fluffy.

These props dress the ground plane between the barn and the haystack, so almost
all of them are instanced in bulk and the budgets are the tightest in the
library.  Two rules shape the geometry here:

* anything the player only ever sees in a crowd (grass, flowers) is built from
  flat tapered strips fanned through 360 degrees -- a tube costs four times the
  triangles and reads exactly the same from eye height;
* anything organic starts as a jittered icosphere so no two instances of a bush
  or a boulder share a silhouette once the game rotates them.

Two conventions that every builder below obeys:

* -Y is toward the camera.  A positive X rotation leans a part toward the
  player, which is why grass blades, reeds and the sunflower head all take
  positive tilts.
* ``shade()`` multiplies *linear* RGB, so a factor reads roughly as its square
  root perceptually: shade(c, 0.58) is about 24% darker to the eye, not 42%.
  All the second-pass factors here are written in linear terms for that reason
  -- they look extreme next to an sRGB colour picker and are not.

The one prop that does not stand on the ground is ``cloud``: its origin sits at
its own centre so the sky layer can spin it about itself.
"""

import math

# Curved bases are sunk this far below z=0 so no seam shows where a round
# footprint meets the flat ground mesh.
GROUND_SINK = 0.04

# Jitter as a fraction of radius.  Past ~0.2 an icosphere stops reading as a
# lump and starts reading as damage.
BLOB_JITTER = 0.16

# A blade of grass gets four triangles and nothing else, so its whole character
# has to come from the taper and the arch.
GRASS_BLADE_HEIGHT = 0.35
GRASS_BLADE_WIDTHS = (0.017, 0.010, 0.003)


# --------------------------------------------------------------------------
# Shared shapes
# --------------------------------------------------------------------------
def centre_origin(obj):
    """Bake any leftover rotation/scale, then drop the pivot on the origin.

    ``join()`` adopts the transform of its first object, and ``set_origin``
    shifts the mesh by a *world*-space offset applied in local space -- which is
    only the right answer when that transform has no rotation.  Applying first
    makes it right for every caller and leaves the exported root node identity.
    """
    apply_transform(obj)
    set_origin(obj, (0.0, 0.0, 0.0))
    return obj


def blob(name, radius, loc, color, family="Prop", subdivisions=1, squash=1.0,
         stretch=1.0, roughness=BLOB_JITTER, seed=0):
    """A jittered icosphere: the lump behind foliage, boulders and clouds.

    ``squash`` (Z) and ``stretch`` (X) are applied *after* the jitter so the
    noise stays proportional to the sphere rather than being smeared by the
    scale.  Note that the jitter moves the bottom pole by up to
    ``radius * roughness * squash``, so callers that need ground contact have to
    sink the centre by at least that much.
    """
    lump = icosphere(name, radius=radius, subdivisions=subdivisions, loc=loc,
                     color=color, family=family)
    jitter(lump, radius * roughness, seed=seed)
    if squash != 1.0 or stretch != 1.0:
        place(lump, scale=(stretch, 1.0, squash))
        apply_transform(lump)
    return lump


def tapered_strip(name, length, widths, bend=0.0, lean=0.0, color=None, family="Prop"):
    """A flat blade standing at the origin, arching toward -Y.

    ``widths`` are half-widths from base to tip; N widths make N-1 quads.
    ``bend`` is how far the tip leans out of vertical, ``lean`` is a sideways
    curl so a fan of blades never looks like a spirograph.
    """
    verts, faces = [], []
    stations = len(widths)
    for i, half in enumerate(widths):
        t = i / (stations - 1)
        verts.append((lean * t * t - half, -bend * t * t, length * t))
        verts.append((lean * t * t + half, -bend * t * t, length * t))
    for i in range(stations - 1):
        base = i * 2
        faces.append((base, base + 1, base + 3, base + 2))
    return from_points(name, verts, faces, color=color, family=family)


def disc(name, radius, loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), segments=10,
         color=None, family="Prop"):
    """A single filled n-gon facing +Z: cut faces, end grain, mushroom spots.

    One polygon rather than a fan from a centre vertex.  An n-gon triangulates
    to n-2 triangles where the fan costs n, and nothing here ever needs the
    centre vertex -- these discs are always flat and always one colour.  On the
    mushroom that saving is the difference between fitting the 80-triangle
    scatter budget and not.
    """
    verts = [(math.cos(TAU * i / segments) * radius,
              math.sin(TAU * i / segments) * radius,
              0.0) for i in range(segments)]
    face = from_points(name, verts, [tuple(range(segments))], color=color, family=family)
    place(face, loc=loc, rot=rot)
    apply_transform(face)
    return face


def grass_blades(prefix, count, height=GRASS_BLADE_HEIGHT, spread=0.025, seed=0):
    """A fan of blades radiating from one point, alternating two greens.

    Returned unjoined so a caller can add flowers before the join.
    """
    blades = []
    for i in range(count):
        angle = TAU * i / count + (i % 2) * 0.24
        # Cheap deterministic variety: a stride that never lines up with count.
        t = ((i * 0.37) + seed * 0.13) % 1.0
        tall = height * (0.62 + 0.55 * t)
        blade = tapered_strip(
            f"{prefix}{i}", tall, GRASS_BLADE_WIDTHS,
            bend=tall * 0.36, lean=tall * 0.09 * (1.0 if i % 2 else -1.0),
            color="grass" if i % 2 else "grass_dark", family="Foliage",
        )
        place(blade,
              loc=(math.sin(angle) * spread, -math.cos(angle) * spread, 0.0),
              rot=(math.radians(6.0 + 18.0 * t), 0.0, angle))
        blades.append(blade)
    return blades


def stone_lump(name, radius, loc, subdivisions=1, seed=0, squash=0.72, stretch=1.15):
    """A boulder: squashed, jittered, dark underneath and bleached on top."""
    rock = blob(name, radius, loc, "stone", subdivisions=subdivisions, squash=squash,
                stretch=stretch, roughness=0.22, seed=seed)
    flat(rock)
    paint(rock, "stone_dark", faces=select_faces(rock, lambda c, n: n.z < -0.15))
    paint(rock, shade("stone", 1.40), faces=select_faces(rock, lambda c, n: n.z > 0.55))
    return rock


# The toadstool cap, lathed around Z.  Radii shrink monotonically, which is what
# lets cap_seat() below find the segment a spot belongs to by radius alone.
CAP_PROFILE = ((0.115, 0.150), (0.105, 0.175), (0.062, 0.228), (0.0, 0.250))
CAP_SEGMENTS = 8
# An n-sided lathe only touches the ideal profile at its ring vertices; at the
# centre of a facet it has fallen cos(pi/n) of the way in.  Spots are seated on
# the facet, so every radius taken off CAP_PROFILE is scaled by this.
CAP_INSET = math.cos(math.pi / CAP_SEGMENTS)

# The four white spots: (ring radius on the ideal profile, spot radius,
# azimuth).  Hand-placed rather than generated -- an even ring of spots looks
# printed -- but only the *placement* is by hand: the height and the tilt are
# derived from CAP_PROFILE by cap_seat(), so the spots stay flush if the cap
# profile is ever retuned.  Azimuths are facet centres (22.5 + 45k) so each disc
# lands on one flat facet instead of straddling a ridge, and each spot's radius
# is kept under the width of the profile segment it sits on.
CAP_SPOTS = (
    (0.086, 0.022, 67.5),
    (0.093, 0.016, 157.5),
    (0.078, 0.024, 292.5),
    (0.033, 0.018, 337.5),
)


def cap_seat(ring):
    """Where a spot at ideal radius ``ring`` sits: (radius, height, tilt).

    ``tilt`` is the angle of the facet's own normal off vertical -- for a lathe
    band that is atan2(rise, inset run), i.e. the same angle the surface makes
    with the horizontal.  Returning it (rather than trusting a typed-in guess)
    is what keeps the disc coplanar with the facet instead of floating over it
    or cutting into it.
    """
    for (r0, z0), (r1, z1) in zip(CAP_PROFILE, CAP_PROFILE[1:]):
        if r1 - 1e-9 <= ring <= r0 + 1e-9:
            t = (r0 - ring) / (r0 - r1)
            run = (r0 - r1) * CAP_INSET
            return ring * CAP_INSET, z0 + t * (z1 - z0), math.atan2(z1 - z0, run)
    raise ValueError(f"spot ring {ring} is off the cap profile")


def build_toadstool(name, spots=True):
    """A red-capped toadstool standing on z=0, 0.25 m to the crown.

    Shared by the ``mushroom`` prop and the one growing out of the fallen log,
    which skips the spots because at log scale they turn into noise.

    Both stem caps are open: the bottom is sunk under the ground (or buried in
    the log) and the top is swallowed by the cap, whose underside starts 10 mm
    below the top of the stem.  That is eight triangles of pure waste on a prop
    with an 80-triangle ceiling.
    """
    stem = from_profile(f"{name}Stem",
                        [(0.050, -GROUND_SINK), (0.036, 0.08), (0.042, 0.16)],
                        segments=5, color="mushroom_stem",
                        close_bottom=False, close_top=False)
    cap = from_profile(f"{name}Cap", list(CAP_PROFILE), segments=CAP_SEGMENTS,
                       color="mushroom_cap")
    smooth(cap, 50)
    gills = select_faces(cap, lambda c, n: n.z < -0.5)
    paint(cap, shade("mushroom_stem", 0.66), faces=gills)

    dots = []
    if spots:
        for i, (ring, radius, azimuth) in enumerate(CAP_SPOTS):
            seat_r, seat_z, tilt = cap_seat(ring)
            az_r = math.radians(azimuth)
            normal = (math.sin(tilt) * math.cos(az_r),
                      math.sin(tilt) * math.sin(az_r),
                      math.cos(tilt))
            # 2 mm along the facet normal: enough to beat depth precision, far
            # too little to read as a gap on a 0.25 m prop.
            lift = 0.002
            dots.append(disc(
                f"{name}Spot{i}", radius, segments=5, color="white",
                loc=(seat_r * math.cos(az_r) + normal[0] * lift,
                     seat_r * math.sin(az_r) + normal[1] * lift,
                     seat_z + normal[2] * lift),
                rot=(0.0, tilt, az_r),
            ))
    return join([stem, cap] + dots, name)


# --------------------------------------------------------------------------
# Trees
# --------------------------------------------------------------------------
PINE_HEIGHT = 5.5
# (bottom radius, top radius, depth, centre z, colour) -- darkest at the base.
PINE_TIERS = (
    (1.38, 0.78, 1.50, 1.55, "pine_dark"),
    (1.16, 0.62, 1.35, 2.55, "pine_dark"),
    (0.94, 0.46, 1.20, 3.50, "pine"),
)
# The apex is long and narrow on purpose: its base disc has to finish well
# inside the top tier.  Tier 2 spans z 2.90-4.10 and is 0.66 m wide at z=3.60,
# where this cone's 0.46 m base sits -- clear even after both are jittered.
PINE_APEX_DEPTH = 1.90
PINE_APEX_RADIUS = 0.46


def build_tree_pine():
    """A conifer 5.5 m tall: stacked jittered cone tiers over a fat trunk.

    Deliberately left flat-shaded -- the hard facet lines between skirts are
    what makes a stylised fir read as a fir instead of a green blob.
    """
    trunk = cylinder("Trunk", radius=0.26, depth=1.30, verts=8,
                     loc=(0.0, 0.0, 0.62 - GROUND_SINK), color="wood_dark")

    tiers = []
    for i, (r1, r2, depth, height, tone) in enumerate(PINE_TIERS):
        tier = cone(f"Tier{i}", r1=r1, r2=r2, depth=depth, verts=12,
                    loc=(0.0, 0.0, height), rot=(0.0, 0.0, math.radians(15.0 * i)),
                    color=tone, family="Foliage")
        jitter(tier, 0.05, seed=7 + i)
        # The underside of each skirt sits in its own shadow.
        paint(tier, shade(tone, 0.58), family="Foliage",
              faces=select_faces(tier, lambda c, n: n.z < -0.8))
        tiers.append(tier)

    apex = cone("Apex", r1=PINE_APEX_RADIUS, r2=0.0, depth=PINE_APEX_DEPTH, verts=12,
                loc=(0.0, 0.0, PINE_HEIGHT - PINE_APEX_DEPTH * 0.5),
                rot=(0.0, 0.0, math.radians(22.0)),
                color=shade("pine", 1.40), family="Foliage")
    jitter(apex, 0.04, seed=11)
    # Buried inside tier 2, but shaded like every other underside so that a
    # jitter spike poking through never shows up as the brightest face in the
    # tree pointing at the ground.
    paint(apex, shade("pine", 0.72), family="Foliage",
          faces=select_faces(apex, lambda c, n: n.z < -0.8))

    tree = join([trunk] + tiers + [apex], "TreePine")
    flat(tree)
    centre_origin(tree)
    report(tree)
    export_glb(tree, "tree_pine")


# (radius, x, y, z, subdivisions, colour) -- one big blob plus satellites.
OAK_CROWN = (
    (1.45, 0.00, 0.00, 4.35, 2, "leaf"),
    (1.05, 0.95, 0.35, 3.85, 2, "leaf_dark"),
    (0.85, -0.90, -0.40, 4.05, 1, "leaf_dark"),
    (0.80, 0.25, -0.85, 4.90, 1, "leaf"),
    (0.72, -0.35, 0.80, 3.55, 1, "leaf_dark"),
)
# (base z, length, tilt from vertical, azimuth) for the two forked branches.
OAK_BRANCHES = (
    (2.45, 1.50, 38.0, 20.0),
    (2.25, 1.40, 36.0, -156.0),
)


def build_tree_oak():
    """A broadleaf ~6 m: tapering trunk, two forked branches, five leaf blobs."""
    trunk = from_profile(
        "Trunk",
        [(0.32, -GROUND_SINK), (0.27, 0.55), (0.22, 1.45), (0.18, 2.45), (0.15, 3.20)],
        segments=8, color="wood_dark",
    )
    # The lit half of the trunk faces the camera (-Y) and the sun (+X).  On an
    # 8-sided lathe the column normals sit at 22.5 + 45i degrees, so this test
    # catches four of the eight -- an actual half, not the 90-degree wedge that
    # a plain n.x test picks out.
    paint(trunk, "wood", faces=select_faces(trunk, lambda c, n: n.x - n.y > 0.4))

    branches = []
    for i, (base_z, length, tilt, azimuth) in enumerate(OAK_BRANCHES):
        tilt_r, az_r = math.radians(tilt), math.radians(azimuth)
        direction = (math.sin(tilt_r) * math.cos(az_r),
                     math.sin(tilt_r) * math.sin(az_r),
                     math.cos(tilt_r))
        branches.append(cone(
            f"Branch{i}", r1=0.13, r2=0.055, depth=length, verts=6,
            loc=(direction[0] * length * 0.5,
                 direction[1] * length * 0.5,
                 base_z + direction[2] * length * 0.5),
            rot=(0.0, tilt_r, az_r), color="wood_dark",
        ))

    crown = []
    for i, (radius, x, y, z, subdiv, tone) in enumerate(OAK_CROWN):
        leaves = blob(f"Crown{i}", radius, (x, y, z), tone, family="Foliage",
                      subdivisions=subdiv, squash=0.88, seed=20 + i)
        smooth(leaves, 60)
        # Sun from above: the top of every blob catches a lighter green.
        paint(leaves, shade(tone, 1.45), family="Foliage",
              faces=select_faces(leaves, lambda c, n: n.z > 0.6))
        crown.append(leaves)

    tree = join([trunk] + branches + crown, "TreeOak")
    centre_origin(tree)
    report(tree)
    export_glb(tree, "tree_oak")


STUMP_HEIGHT = 0.60
STUMP_ROOT_AZIMUTHS = (30.0, 150.0, 270.0)


def build_tree_stump():
    """A 0.6 m cut stump with a pale sapwood ring and three flaring roots."""
    body = from_profile(
        "Stump",
        [(0.42, -GROUND_SINK), (0.40, 0.14), (0.35, 0.44), (0.33, STUMP_HEIGHT)],
        segments=10, color="wood_dark",
    )
    paint(body, "wood_light", faces=select_faces(body, lambda c, n: n.z > 0.9))
    # A darker heartwood plate over the pale cut face leaves a ring of sapwood.
    heart = disc("Heartwood", 0.22, loc=(0.0, 0.0, STUMP_HEIGHT + 0.002),
                 segments=10, color="wood")

    roots = []
    for i, azimuth in enumerate(STUMP_ROOT_AZIMUTHS):
        tilt_r, az_r = math.radians(115.0), math.radians(azimuth)
        direction = (math.sin(tilt_r) * math.cos(az_r),
                     math.sin(tilt_r) * math.sin(az_r),
                     math.cos(tilt_r))
        roots.append(cone(
            f"Root{i}", r1=0.16, r2=0.05, depth=0.62, verts=6,
            loc=(direction[0] * 0.31, direction[1] * 0.31, 0.30 + direction[2] * 0.31),
            rot=(0.0, tilt_r, az_r), color="wood_dark",
        ))

    stump = join([body, heart] + roots, "TreeStump")
    flat(stump)
    centre_origin(stump)
    report(stump)
    export_glb(stump, "tree_stump")


# --------------------------------------------------------------------------
# Low scatter
# --------------------------------------------------------------------------
# (radius, x, y, z, subdivisions, colour).  z is the *unsunk* centre height:
# build_bush drops each lump by GROUND_SINK.  The two satellites are set low
# enough that even the worst jitter (radius * BLOB_JITTER * squash upward on the
# bottom pole) still leaves the smaller one below z=0, so the bush is guaranteed
# to meet the ground rather than hover a visible 3-5 cm above it.
BUSH_LUMPS = (
    (0.42, 0.00, 0.00, 0.46, 2, "leaf"),
    (0.30, 0.30, 0.10, 0.26, 1, "leaf_dark"),
    (0.28, -0.28, -0.09, 0.28, 1, "leaf_dark"),
)


def build_bush():
    """Three clustered leaf blobs, ~0.85 m tall and wider than it is high."""
    lumps = []
    for i, (radius, x, y, z, subdiv, tone) in enumerate(BUSH_LUMPS):
        lump = blob(f"Lump{i}", radius, (x, y, z - GROUND_SINK), tone, family="Foliage",
                    subdivisions=subdiv, squash=0.92, stretch=1.1, seed=40 + i)
        smooth(lump, 60)
        paint(lump, shade(tone, 1.40), family="Foliage",
              faces=select_faces(lump, lambda c, n: n.z > 0.65))
        lumps.append(lump)

    bush = join(lumps, "Bush")
    centre_origin(bush)
    report(bush)
    export_glb(bush, "bush")


def build_grass_tuft():
    """Seven blades fanned through a full circle -- the map's densest instance.

    Fanned rather than aligned so that whichever way the player faces, some
    blades present their front face to the camera.
    """
    tuft = join(grass_blades("Blade", 7), "GrassTuft")
    flat(tuft)
    # The join target is Blade0, which still carries its lean and spin;
    # centre_origin bakes those before shifting the pivot.
    centre_origin(tuft)
    report(tuft)
    export_glb(tuft, "grass_tuft")


# Three petal colours so a scattered field never repeats side by side.
# (petal colour, stem height, offset x, offset y, tilt, azimuth)
PATCH_FLOWERS = (
    ("barn_pink", 0.30, 0.055, -0.030, 9.0, 20.0),
    ("white", 0.24, -0.060, 0.045, 12.0, 200.0),
    ("sky", 0.27, 0.010, 0.070, 7.0, 300.0),
)


def flower(name, height, color):
    """One flower: a triangular-prism stem and a five-petal disc with a centre.

    Everything is in the Foliage family, petals included -- a flower patch is
    instanced by the thousand and is not worth a second material for a
    roughness difference nobody can see.
    """
    stem = from_profile(name + "Stem", [(0.011, 0.0), (0.008, height)], segments=3,
                        color="grass_dark", family="Foliage",
                        close_bottom=False, close_top=False)
    head = from_profile(
        name + "Head",
        [(0.0, height - 0.014), (0.075, height), (0.028, height + 0.016)],
        segments=5, color=color, family="Foliage",
    )
    # Select the centre by radius, not by normal: the petal ring tilts inward
    # steeply enough that its normals are nearly vertical too.  The close_top
    # pentagon is part of that centre, which is why the head keeps its cap.
    centre = select_faces(head, lambda c, n: c.x * c.x + c.y * c.y < 0.0009)
    paint(head, "gold", family="Foliage", faces=centre)
    paint(head, shade(color, 0.60), family="Foliage",
          faces=select_faces(head, lambda c, n: n.z < -0.2))
    return [stem, head]


def build_flower_patch():
    """A small grass tuft with three flowers pushing up through it.

    ~92 triangles: over the 80 of a bare grass tuft, inside the 120 this prop is
    budgeted at.  Everything cheaper here costs a flower its round head or its
    gold centre, so it stays a medium-tier scatter prop.
    """
    parts = grass_blades("Blade", 5, height=0.30, seed=3)
    for i, (color, height, x, y, tilt, azimuth) in enumerate(PATCH_FLOWERS):
        for part in flower(f"Flower{i}", height, color):
            place(part, loc=(x, y, 0.0),
                  rot=(math.radians(tilt), 0.0, math.radians(azimuth)))
            parts.append(part)

    patch = join(parts, "FlowerPatch")
    flat(patch)
    # Same as the grass tuft: the target blade is tilted, so bake before pivoting.
    centre_origin(patch)
    report(patch)
    export_glb(patch, "flower_patch")


def build_rock():
    """A single boulder ~0.8 m across; the game rescales it per instance."""
    rock = stone_lump("Rock", 0.36, (0.0, 0.0, 0.36 * 0.72 - 0.06),
                      subdivisions=2, seed=5)
    centre_origin(rock)
    report(rock)
    export_glb(rock, "rock")


# (name, radius, x, y, subdivisions, seed, squash, stretch)
CLUSTER_STONES = (
    ("Big", 0.34, 0.00, 0.00, 2, 13, 0.78, 1.10),
    ("Mid", 0.23, 0.42, 0.14, 1, 17, 0.70, 1.25),
    ("Small", 0.16, -0.30, -0.26, 1, 23, 0.66, 1.05),
)


def build_rock_cluster():
    """Three boulders of different size, squash and spin, huddled together."""
    stones = []
    for i, (label, radius, x, y, subdiv, seed, squash, stretch) in enumerate(CLUSTER_STONES):
        stone = stone_lump(f"Stone{label}", radius, (x, y, radius * squash - 0.05),
                           subdivisions=subdiv, seed=seed, squash=squash, stretch=stretch)
        # Spin each stone so the shared icosphere topology stops being readable.
        place(stone, rot=(0.0, 0.0, math.radians(37.0 * (i + 1))))
        stones.append(stone)

    cluster = join(stones, "RockCluster")
    centre_origin(cluster)
    report(cluster)
    export_glb(cluster, "rock_cluster")


LOG_LENGTH = 2.20
LOG_RADIUS = 0.185


def build_log():
    """A fallen 2.2 m log lying along X, with end grain and a passenger.

    The barrel is lathed upright and then rolled 90 degrees, which is why the
    face selections below are made after the transform is applied: by then the
    normals are in the orientation the player actually sees.
    """
    half = LOG_LENGTH * 0.5
    body = from_profile(
        "LogBody",
        [(LOG_RADIUS, -half), (0.165, -0.45), (0.180, 0.30), (0.170, half)],
        segments=10, color="wood_dark",
    )
    place(body, loc=(0.0, 0.0, LOG_RADIUS - GROUND_SINK), rot=(0.0, math.radians(90.0), 0.0))
    apply_transform(body)
    paint(body, "wood", faces=select_faces(body, lambda c, n: n.z > 0.45))
    paint(body, "wood_light", faces=select_faces(body, lambda c, n: abs(n.x) > 0.85))

    ends = []
    for sign in (1.0, -1.0):
        ends.append(disc(
            f"EndGrain{sign:+.0f}", 0.115, segments=10, color="wood",
            loc=(sign * (half + 0.002), 0.0, LOG_RADIUS - GROUND_SINK),
            rot=(0.0, math.radians(90.0 * sign), 0.0),
        ))

    # A snapped-off branch stub keeps the silhouette from being a plain tube.
    stub = cone("Stub", r1=0.075, r2=0.045, depth=0.34, verts=5,
                loc=(-0.35, 0.14, LOG_RADIUS + 0.12),
                rot=(math.radians(-62.0), 0.0, math.radians(14.0)), color="wood_dark")

    shroom = build_toadstool("LogShroom", spots=False)
    place(shroom, loc=(0.42, 0.06, LOG_RADIUS + 0.11), scale=0.62)
    apply_transform(shroom)

    log = join([body] + ends + [stub, shroom], "FallenLog")
    centre_origin(log)
    report(log)
    export_glb(log, "log")


def build_mushroom():
    """The full 0.25 m toadstool: red cap, white spots, cream stem.

    78 triangles: 20 for the open stem, 46 for the cap and its gill face, 12 for
    the four spots.
    """
    shroom = build_toadstool("Mushroom")
    centre_origin(shroom)
    report(shroom)
    export_glb(shroom, "mushroom")


# (x, y, stem height, tilt, azimuth) -- reeds lean apart so the heads never kiss.
CATTAIL_REEDS = (
    (0.000, 0.000, 1.02, 3.0, 20.0),
    (0.090, 0.050, 0.86, 8.0, 150.0),
    (-0.080, 0.060, 0.72, 7.0, -80.0),
)


def build_cattail():
    """Three reeds with brown sausage heads, 1.3 m, for the pond edge.

    Stems are triangular prisms: at 4 cm across nobody counts the sides, and it
    keeps all three reeds inside a budget that a hexagon would blow on its own.
    Heads share the stems' Foliage family so the whole prop is one primitive.
    """
    parts = []
    for i, (x, y, height, tilt, azimuth) in enumerate(CATTAIL_REEDS):
        stem = from_profile(f"Stem{i}", [(0.022, -GROUND_SINK), (0.016, height + 0.02)],
                            segments=3, color="grass_dark", family="Foliage",
                            close_bottom=False, close_top=False)
        head = from_profile(
            f"Head{i}",
            [(0.0, height - 0.02), (0.036, height + 0.03),
             (0.036, height + 0.20), (0.0, height + 0.26)],
            segments=5, color="dirt_dark", family="Foliage",
        )
        smooth(head, 55)
        # Pick the tip band by height, not by normal: the head's steepest
        # up-facing band only reaches n.z = 0.51 (there is no flat cap -- the
        # profile closes on a point), so any n.z threshold worth writing would
        # be a magic number that a profile tweak silently turns into a no-op.
        paint(head, shade("dirt_dark", 1.55), family="Foliage",
              faces=select_faces(head, lambda c, n: c.z > height + 0.19))
        for part in (stem, head):
            place(part, loc=(x, y, 0.0),
                  rot=(math.radians(tilt), 0.0, math.radians(azimuth)))
            parts.append(part)

    reeds = join(parts, "Cattail")
    centre_origin(reeds)
    report(reeds)
    export_glb(reeds, "cattail")


# The head is tipped 70 degrees forward, which lifts its top edge ~0.28 m above
# the stem: 1.32 + 0.28 keeps the prop at the briefed 1.6 m.
SUNFLOWER_STEM_HEIGHT = 1.32
SUNFLOWER_HEAD_TILT = 70.0
SUNFLOWER_PETALS = 12
# (height up the stem, azimuth) for the two leaves.
SUNFLOWER_LEAVES = ((0.58, 55.0), (0.94, 235.0))


def build_sunflower():
    """A 1.6 m sunflower: gold petal ring, dark seed disc, two big leaves.

    The head is built flat in XY with its seed face on +Z and then tipped
    forward as one piece, which is far easier to reason about than orienting
    twelve petals individually.  The tilt is a *positive* X rotation, the file's
    convention for leaning toward the camera: at 70 degrees the seed face ends
    up pointing (0, -0.94, +0.34), i.e. at the player and nodding slightly
    skyward, the way a real head sits.  Anything small or negative here shows
    the player the green back of the head instead.
    """
    stem = from_profile(
        "Stem",
        [(0.040, -GROUND_SINK), (0.034, 0.72), (0.028, SUNFLOWER_STEM_HEIGHT)],
        segments=5, color="grass_dark", family="Foliage",
    )

    leaves = []
    for i, (height, azimuth) in enumerate(SUNFLOWER_LEAVES):
        leaf = tapered_strip(f"Leaf{i}", 0.42, (0.05, 0.09, 0.02), bend=0.10,
                             color="leaf", family="Foliage")
        # The two azimuths are 180 degrees apart, so this pair splays
        # symmetrically whichever way the blades are tilted; the negative angle
        # is what makes the bend droop the tips instead of curling them up.
        place(leaf, loc=(0.0, 0.0, height),
              rot=(math.radians(-58.0), 0.0, math.radians(azimuth)))
        leaves.append(leaf)

    seeds = from_profile(
        "SeedDisc",
        [(0.0, -0.030), (0.115, -0.012), (0.150, 0.0), (0.100, 0.028), (0.0, 0.040)],
        segments=10, color=shade("dirt_dark", 0.55), family="Foliage",
    )
    # The back of a sunflower head is green, not brown.
    paint(seeds, "leaf_dark", family="Foliage",
          faces=select_faces(seeds, lambda c, n: n.z < -0.4))

    petals = []
    for i in range(SUNFLOWER_PETALS):
        angle = TAU * i / SUNFLOWER_PETALS
        petal = tapered_strip(f"Petal{i}", 0.18, (0.030, 0.045, 0.010), bend=0.03,
                              color="gold", family="Foliage")
        # A full ring, so the sign of the tilt only decides whether the petals
        # curl up or down out of the seed plane.
        place(petal, loc=(-math.sin(angle) * 0.125, math.cos(angle) * 0.125, 0.0),
              rot=(math.radians(-84.0), 0.0, angle))
        petals.append(petal)

    head = join([seeds] + petals, "SunflowerHead")
    place(head, loc=(0.0, 0.0, SUNFLOWER_STEM_HEIGHT),
          rot=(math.radians(SUNFLOWER_HEAD_TILT), 0.0, 0.0))
    apply_transform(head)

    flower_obj = join([stem] + leaves + [head], "Sunflower")
    centre_origin(flower_obj)
    report(flower_obj)
    export_glb(flower_obj, "sunflower")


# (radius, x, y, z, subdivisions) -- two dense puffs carry the read, the three
# cheap ones only ever break the outline.
CLOUD_PUFFS = (
    (3.4, -1.1, 0.0, 0.0, 2),
    (2.9, 2.6, 0.4, -0.35, 2),
    (2.3, -4.3, -0.3, -0.5, 1),
    (2.0, 5.0, -0.5, -0.6, 1),
    (1.9, 0.9, 0.6, 1.4, 1),
)


def build_cloud():
    """A ~14 m fluffy cloud whose origin stays at its centre, not on a ground
    plane it never touches -- the sky layer orbits each instance about itself.
    """
    puffs = []
    for i, (radius, x, y, z, subdiv) in enumerate(CLOUD_PUFFS):
        puff = blob(f"Puff{i}", radius, (x, y, z), "cloud", subdivisions=subdiv,
                    squash=0.62, roughness=0.10, seed=60 + i)
        smooth(puff, 70)
        paint(puff, shade("cloud", 0.74),
              faces=select_faces(puff, lambda c, n: n.z < -0.45))
        puffs.append(puff)

    cloud = join(puffs, "Cloud")
    centre_origin(cloud)
    report(cloud)
    export_glb(cloud, "cloud")


BUILDERS = {
    "tree_pine": build_tree_pine,
    "tree_oak": build_tree_oak,
    "tree_stump": build_tree_stump,
    "bush": build_bush,
    "grass_tuft": build_grass_tuft,
    "flower_patch": build_flower_patch,
    "rock": build_rock,
    "rock_cluster": build_rock_cluster,
    "log": build_log,
    "mushroom": build_mushroom,
    "cattail": build_cattail,
    "sunflower": build_sunflower,
    "cloud": build_cloud,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[nature] {name}")
        fn()
