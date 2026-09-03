"""Kiosks: the interactive world furniture the game hangs its UI on.

Every model in here is a UI anchor as much as a prop.  The game overlays each
one with a canvas-rendered text decal, so each build carries a single
unbevelled quad -- named ``Panel`` -- of the advertised size, facing -Y and
sitting ``DECAL_OFFSET`` proud of the board behind it.  Nothing is allowed to
cross in front of that quad: no trim, no awning valance, no pinned notes.  If a
prop wants decoration where the panel lives, the panel wins and the decoration
moves to the margin.  (The sell trough's little chalkboard carries a second
such quad, ``ChalkFace``, on the same terms.)

Everything else follows the house style: chunky boxes with a 0.015-0.02 m
chamfer, colour carried in the corner attribute, and second-pass face painting
instead of texture detail.
"""

import math

# --------------------------------------------------------------------------
# Shared dimensions
# --------------------------------------------------------------------------
POST_THICK = 0.14          # a post you can read as "hand-hewn timber" at 20 m
POST_BEVEL = 0.015
BOARD_BEVEL = 0.02
DECAL_OFFSET = 0.012       # panel-to-backing gap; enough to beat depth precision


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def lathe_span(segments, index):
    """Face indices of one span of a :func:`from_profile` lathe.

    ``from_profile`` emits exactly ``segments`` faces per profile span, in
    bottom-to-top order, and appends the end caps afterwards -- so a span's
    faces are always a contiguous block and stay valid whether or not the caps
    exist.  Painting by span index beats a normal/centre predicate when the
    band you want is a horizontal ring.
    """
    return list(range(index * segments, (index + 1) * segments))


def post(name, height, loc_xy=(0.0, 0.0), thickness=POST_THICK, color="wood",
         family="Prop", cap_color=None):
    """A square upright standing on the ground at ``loc_xy``.

    ``cap_color`` paints the end grain before the chamfer goes on, which is the
    cheap way to make a sawn timber read as sawn.
    """
    upright = cube(name, size=(thickness, thickness, height),
                   loc=(loc_xy[0], loc_xy[1], height / 2.0), color=color, family=family)
    if cap_color is not None:
        paint(upright, cap_color, family=family,
              faces=select_faces(upright, lambda c, n: n.z > 0.8))
    bevel(upright, POST_BEVEL, 1)
    return upright


def decal_panel(name, width, height, loc, color="barn_trim", family="Prop"):
    """The flat -Y quad the game overlays with rendered text.

    Deliberately a single unbevelled, unsmoothed polygon: the overlay is
    projected onto it, so any curvature or inset would skew the glyphs.
    """
    quad = plane(name, size=(width, height), loc=loc,
                 rot=(math.radians(90.0), 0.0, 0.0), color=color, family=family)
    flat(quad)
    return quad


def banded_sweep(name, stations, half_y, half_z, colors, family="Prop"):
    """Sweep a rectangular section through a list of ``(x, z)`` stations.

    Each span between two stations is painted with the next entry of
    ``colors``, which is how the awning gets its stripes and the barrier rope
    its hazard bands without a second material or a texture.
    """
    verts, faces = [], []
    for x, z in stations:
        verts.extend([(x, -half_y, z - half_z), (x, half_y, z - half_z),
                      (x, half_y, z + half_z), (x, -half_y, z + half_z)])
    for i in range(len(stations) - 1):
        a, b = i * 4, (i + 1) * 4
        for k in range(4):
            k2 = (k + 1) % 4
            faces.append((a + k, a + k2, b + k2, b + k))
    last = (len(stations) - 1) * 4
    faces.append((3, 2, 1, 0))
    faces.append((last, last + 1, last + 2, last + 3))

    swept = from_points(name, verts, faces, color=colors[0], family=family)
    for i in range(len(stations) - 1):
        paint(swept, colors[i % len(colors)], family=family,
              faces=list(range(i * 4, i * 4 + 4)))
    return swept


def striped_slab(name, size, segments, colors, loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0),
                 family="Prop"):
    """A flat slab banded along its local X: awnings, plank walls, shingle courses."""
    sx, sy, sz = size
    stations = [(-sx / 2.0 + sx * i / segments, 0.0) for i in range(segments + 1)]
    slab = banded_sweep(name, stations, sy / 2.0, sz / 2.0, colors, family)
    place(slab, loc=loc, rot=rot)
    apply_transform(slab)
    return slab


def extrude_profile(name, outline, depth, color=None, family="Prop"):
    """Extrude a closed ``(x, z)`` outline along Y into a flat-faced prism.

    List the outline counter-clockwise in the XZ plane (run +X along its bottom
    edge first) and the front cap comes out facing -Y, ready to be painted as
    a single face -- it is always face 0.
    """
    half = depth / 2.0
    count = len(outline)
    verts = [(x, -half, z) for x, z in outline] + [(x, half, z) for x, z in outline]
    faces = [tuple(range(count)), tuple(range(2 * count - 1, count - 1, -1))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, count + i, count + j, j))
    return from_points(name, verts, faces, color=color, family=family)


def bipyramid(name, radius, top, bottom, segments=6, color=None, family="Prop"):
    """A faceted crystal: one waist ring pinched to a point above and below.

    Cheaper and sharper than an icosphere, and the waist sits on the object's
    local Z origin so it is easy to float at a given height.
    """
    verts = [(0.0, 0.0, bottom)]
    for i in range(segments):
        angle = TAU * i / segments
        verts.append((math.cos(angle) * radius, math.sin(angle) * radius, 0.0))
    apex = segments + 1
    verts.append((0.0, 0.0, top))

    faces = []
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((0, 1 + j, 1 + i))
        faces.append((1 + i, 1 + j, apex))
    return from_points(name, verts, faces, color=color, family=family)


# --------------------------------------------------------------------------
# Sell trough
# --------------------------------------------------------------------------
def build_sell_trough():
    """Dump hay here for money: a 2.6 m trough under a price board.

    The board's 2.0 x 0.7 panel sits above the trough rim so a player standing
    close enough to dump can still read it without looking down.
    """
    parts = []
    for x in (-1.16, 1.16):
        for y in (-0.30, 0.30):
            parts.append(post(f"Leg{x}{y}", 0.50, (x, y), 0.14, "wood_dark"))

    floor = cube("Floor", size=(2.60, 0.85, 0.12), loc=(0.0, 0.0, 0.56), color="wood")
    # The trough is never empty -- a straw-coloured bed sells that at zero cost.
    paint(floor, "straw_mid", faces=select_faces(floor, lambda c, n: n.z > 0.8))
    bevel(floor, BOARD_BEVEL, 1)
    parts.append(floor)

    # Front boards are staves so the trough reads as coopered, not extruded.
    parts.append(striped_slab("FrontWall", (2.60, 0.11, 0.52), 7, ("wood", "wood_light"),
                              loc=(0.0, -0.37, 0.88)))
    parts.append(cube("BackWall", size=(2.60, 0.11, 0.52), loc=(0.0, 0.37, 0.88),
                      color="wood"))
    for x in (-1.24, 1.24):
        end = cube("EndWall", size=(0.12, 0.85, 0.52), loc=(x, 0.0, 0.88), color="wood_light")
        bevel(end, BOARD_BEVEL, 1)
        parts.append(end)

    for x in (-1.24, 1.24):
        for y in (-0.37, 0.37):
            parts.append(cube("CornerCap", size=(0.20, 0.20, 0.12), loc=(x, y, 1.20),
                              color="gold", family="Metal"))

    board = cube("PriceBoard", size=(2.30, 0.10, 0.92), loc=(0.0, 0.37, 1.60), color="plank")
    paint(board, "barn_trim", faces=select_faces(board, lambda c, n: n.y < -0.8))
    bevel(board, BOARD_BEVEL, 1)
    parts.append(board)
    parts.append(decal_panel("Panel", 2.00, 0.70, (0.0, 0.37 - 0.05 - DECAL_OFFSET, 1.60)))

    # Thin enough that the post stays behind the chalk face it carries.
    parts.append(post("SignPost", 1.30, (1.62, 0.0), 0.08, "wood_dark"))
    chalkboard = cube("Chalkboard", size=(0.62, 0.07, 0.48), loc=(1.62, 0.0, 1.42),
                      color="wood_dark")
    bevel(chalkboard, BOARD_BEVEL, 1)
    parts.append(chalkboard)
    parts.append(decal_panel("ChalkFace", 0.50, 0.36,
                             (1.62, -0.035 - DECAL_OFFSET, 1.42), color="black"))

    trough = join(parts, "SellTrough")
    set_origin(trough, (0.0, 0.0, 0.0))
    report(trough)
    export_glb(trough, "sell_trough")


# --------------------------------------------------------------------------
# Upgrade kiosk
# --------------------------------------------------------------------------
def build_upgrade_kiosk():
    """A 2.4 m market stall: counter, striped awning, display board, service bell.

    The awning slopes toward the player so its underside stays lit, and the
    display board hangs at the back where the awning cannot shadow it.
    """
    parts = []
    body = cube("CounterBody", size=(2.20, 0.85, 0.90), loc=(0.0, 0.0, 0.45), color="wood_dark")
    parts.append(body)
    parts.append(striped_slab("CounterFront", (2.28, 0.08, 0.90), 6, ("wood", "wood_light"),
                              loc=(0.0, -0.465, 0.45)))
    top = cube("CounterTop", size=(2.40, 1.00, 0.12), loc=(0.0, 0.0, 0.96), color="plank")
    bevel(top, BOARD_BEVEL, 1)
    parts.append(top)

    # Post heights are the awning's underside at each post's y, so nothing
    # pokes through the canopy.
    for x in (-1.12, 1.12):
        parts.append(post(f"BackPost{x}", 2.29, (x, 0.42), POST_THICK, "wood",
                          cap_color="wood_dark"))
        parts.append(post(f"FrontPost{x}", 2.12, (x, -0.46), POST_THICK, "wood",
                          cap_color="wood_dark"))

    stripes = ("barn_red", "barn_trim")
    parts.append(striped_slab("Awning", (2.62, 1.12, 0.08), 8, stripes,
                              loc=(0.0, -0.02, 2.25), rot=(math.radians(11.0), 0.0, 0.0)))
    parts.append(striped_slab("Valance", (2.62, 0.06, 0.22), 8, stripes,
                              loc=(0.0, -0.60, 2.09)))

    # The board hangs in the gap between the counter top (1.02 m) and the
    # valance (1.98 m); the panel has to clear both or the awning eats the text.
    display = cube("DisplayBoard", size=(1.60, 0.10, 1.05), loc=(0.0, 0.42, 1.50),
                   color="plank")
    paint(display, "barn_trim", faces=select_faces(display, lambda c, n: n.y < -0.8))
    bevel(display, BOARD_BEVEL, 1)
    parts.append(display)
    parts.append(decal_panel("Panel", 1.40, 0.90, (0.0, 0.42 - 0.05 - DECAL_OFFSET, 1.50)))

    bell_at = (0.86, -0.06)
    plate = cylinder("BellPlate", radius=0.11, depth=0.03, verts=10,
                     loc=(bell_at[0], bell_at[1], 1.035), color="wood_dark")
    parts.append(plate)
    bell = from_profile("Bell", [(0.10, 0.0), (0.10, 0.02), (0.085, 0.12), (0.05, 0.17),
                                 (0.0, 0.20)], segments=10, color="gold", family="Metal")
    smooth(bell, 40)
    place(bell, loc=(bell_at[0], bell_at[1], 1.05))
    parts.append(bell)

    kiosk = join(parts, "UpgradeKiosk")
    set_origin(kiosk, (0.0, 0.0, 0.0))
    report(kiosk)
    export_glb(kiosk, "upgrade_kiosk")


# --------------------------------------------------------------------------
# Quest board
# --------------------------------------------------------------------------
def build_quest_board():
    """A rustic notice board under a shingled gable.

    The pinned notes live in the plank margin above and below the 1.6 x 1.1
    panel -- they are set dressing and must never sit on top of quest text.
    """
    parts = []
    # 2.32 buries the post tops inside the roof slabs rather than through them.
    for x in (-0.98, 0.98):
        parts.append(post(f"Post{x}", 2.32, (x, 0.02), POST_THICK, "wood_dark",
                          cap_color="wood"))

    parts.append(striped_slab("Planks", (2.02, 0.09, 1.52), 5, ("plank", "wood_light"),
                              loc=(0.0, 0.02, 1.46)))
    parts.append(decal_panel("Panel", 1.60, 1.10, (0.0, -0.025 - DECAL_OFFSET, 1.53)))

    # Two slopes swept along their own fall line so the bands read as courses
    # of shingles rather than vertical battens.
    shingles = ("barn_roof", shade("barn_roof", 1.35))
    for sign in (-1.0, 1.0):
        parts.append(striped_slab(f"Roof{sign}", (0.62, 2.00, 0.07), 4, shingles,
                                  loc=(0.0, sign * 0.26, 2.24),
                                  rot=(0.0, math.radians(22.0 * sign), math.radians(90.0))))
    parts.append(cube("Ridge", size=(2.06, 0.10, 0.08), loc=(0.0, 0.0, 2.40),
                      color="wood_dark"))

    for i, (x, z, roll) in enumerate(((-0.62, 0.84, 7.0), (0.02, 0.82, -5.0),
                                      (0.64, 0.85, 9.0))):
        note = plane(f"Note{i}", size=(0.26, 0.20), loc=(x, -0.036, z),
                     rot=(math.radians(90.0), math.radians(roll), 0.0), color="white")
        flat(note)
        parts.append(note)
        parts.append(cube(f"Pin{i}", size=(0.04, 0.04, 0.04), loc=(x, -0.05, z + 0.07),
                          color="barn_red", family="Metal"))

    board = join(parts, "QuestBoard")
    set_origin(board, (0.0, 0.0, 0.0))
    report(board)
    export_glb(board, "quest_board")


# --------------------------------------------------------------------------
# Leaderboard
# --------------------------------------------------------------------------
def build_leaderboard():
    """A 3.5 m scoreboard: carved pediment, tall panel, gold cup on top.

    Read from across the yard, so the silhouette does the work -- the trophy
    breaks the rectangle and the pediment gives the top edge a shape.
    """
    parts = []
    plinth = cube("Plinth", size=(2.30, 0.62, 0.35), loc=(0.0, 0.0, 0.175), color="stone")
    paint(plinth, "stone_dark", faces=select_faces(plinth, lambda c, n: n.z > 0.8))
    bevel(plinth, 0.03, 1)
    parts.append(plinth)

    for x in (-1.02, 1.02):
        parts.append(post(f"Post{x}", 2.85, (x, 0.0), 0.18, "wood_dark", cap_color="wood"))

    board = cube("Board", size=(1.95, 0.12, 2.43), loc=(0.0, 0.0, 1.565), color="plank")
    paint(board, "barn_trim", faces=select_faces(board, lambda c, n: n.y < -0.8))
    bevel(board, BOARD_BEVEL, 1)
    parts.append(board)
    parts.append(decal_panel("Panel", 1.80, 2.20, (0.0, -0.06 - DECAL_OFFSET, 1.60)))

    header = extrude_profile("Header", [
        (-1.15, 0.0), (1.15, 0.0), (1.15, 0.10), (0.70, 0.19), (0.30, 0.26),
        (0.0, 0.28), (-0.30, 0.26), (-0.70, 0.19), (-1.15, 0.10),
    ], 0.28, color="wood_dark")
    # Face 0 is the front cap: gilding it is what makes the carving read.
    paint(header, "gold", family="Metal", faces=[0])
    place(header, loc=(0.0, 0.0, 2.80))
    parts.append(header)

    # The cup finishes at exactly 3.50 m -- it is the whole silhouette, so it
    # gets the last 0.34 m and nothing is allowed to grow past it.
    parts.append(cube("TrophyBase", size=(0.30, 0.30, 0.08), loc=(0.0, 0.0, 3.12),
                      color="wood_dark"))
    cup = from_profile("Trophy", [(0.12, 0.0), (0.12, 0.04), (0.05, 0.07), (0.045, 0.16),
                                  (0.10, 0.21), (0.13, 0.30), (0.13, 0.34)],
                       segments=8, color="gold", family="Metal")
    smooth(cup, 40)
    place(cup, loc=(0.0, 0.0, 3.16))
    parts.append(cup)
    for x in (-0.17, 0.17):
        parts.append(cube("TrophyHandle", size=(0.10, 0.05, 0.16), loc=(x, 0.0, 3.40),
                          rot=(0.0, math.radians(18.0 * (1 if x > 0 else -1)), 0.0),
                          color="gold", family="Metal"))

    tower = join(parts, "Leaderboard")
    set_origin(tower, (0.0, 0.0, 0.0))
    report(tower)
    export_glb(tower, "leaderboard")


# --------------------------------------------------------------------------
# Rebirth shrine
# --------------------------------------------------------------------------
SHRINE_GLOW = "ufo_glass"      # the palette's cyan; the only Emit hue on the shrine
SHRINE_RADIUS = 1.50           # 3 m across, as specified
STONE_RING_RADIUS = 1.15


def build_rebirth_shrine():
    """A 3 m stone circle with a crystal floating over the altar.

    Everything that glows is the same cyan so the prestige mechanic reads as
    one system: the inlaid ring, a rune band per stone, the altar collar and
    the crystal itself.
    """
    parts = []
    pad_segments = 12
    pad = from_profile("Pad", [(SHRINE_RADIUS, 0.0), (SHRINE_RADIUS, 0.12),
                               (1.18, 0.14), (0.0, 0.18)],
                       segments=pad_segments, color="stone", close_bottom=True)
    paint(pad, "stone_dark", faces=lathe_span(pad_segments, 0))
    paint(pad, SHRINE_GLOW, family="Emit", faces=lathe_span(pad_segments, 1))
    parts.append(pad)

    altar_segments = 10
    altar = from_profile("Altar", [(0.62, 0.0), (0.62, 0.30), (0.52, 0.38), (0.52, 0.46),
                                   (0.0, 0.50)],
                         segments=altar_segments, color="stone", close_bottom=True)
    paint(altar, "stone_dark", faces=lathe_span(altar_segments, 0))
    paint(altar, SHRINE_GLOW, family="Emit", faces=lathe_span(altar_segments, 2))
    place(altar, loc=(0.0, 0.0, 0.15))
    parts.append(altar)

    for i, (bearing, height) in enumerate(((90.0, 1.95), (162.0, 1.45), (234.0, 1.75),
                                           (306.0, 1.30), (18.0, 1.60))):
        stone = from_profile(f"Stone{i}", [(0.25, 0.0), (0.23, height * 0.34),
                                           (0.20, height * 0.70), (0.14, height)],
                             segments=6, color="stone", close_bottom=True)
        rune = select_faces(stone, lambda c, n: n.y < -0.8
                            and height * 0.34 < c.z < height * 0.70)
        paint(stone, SHRINE_GLOW, family="Emit", faces=rune)
        # Jitter last: it perturbs the normals the rune predicate relies on.
        jitter(stone, 0.018, seed=i + 1)
        angle = math.radians(bearing)
        place(stone,
              loc=(math.cos(angle) * STONE_RING_RADIUS, math.sin(angle) * STONE_RING_RADIUS, 0.13),
              rot=(0.0, 0.0, angle - math.radians(90.0)))
        parts.append(stone)

    crystal = bipyramid("Crystal", 0.20, 0.42, -0.34, segments=6,
                        color=SHRINE_GLOW, family="Emit")
    place(crystal, loc=(0.0, 0.0, 1.42), rot=(math.radians(6.0), 0.0, math.radians(14.0)))
    parts.append(crystal)

    for i, (bearing, radius, height) in enumerate(((40.0, 0.42, 1.05), (170.0, 0.38, 1.86),
                                                   (280.0, 0.45, 1.24))):
        angle = math.radians(bearing)
        shard = bipyramid(f"Shard{i}", 0.06, 0.13, -0.11, segments=4,
                          color=SHRINE_GLOW, family="Emit")
        place(shard, loc=(math.cos(angle) * radius, math.sin(angle) * radius, height),
              rot=(math.radians(20.0 * i), 0.0, angle))
        parts.append(shard)

    shrine = join(parts, "RebirthShrine")
    set_origin(shrine, (0.0, 0.0, 0.0))
    report(shrine)
    export_glb(shrine, "rebirth_shrine")


# --------------------------------------------------------------------------
# Tier gate
# --------------------------------------------------------------------------
GATE_PILLAR_X = 1.95           # inner faces land ~3.0 m apart
GATE_LINTEL_Z = 2.99
GATE_ROPE_Z = 1.25             # rope height, shared by the gate and its barrier


def build_tier_gate():
    """The archway onto the next haystack: 3.4 m tall over a 3 m opening.

    The barrier rope is a separate export (``tier_gate_rope``) built in this
    same local space, so the game can drop it in place and delete it on unlock
    without touching the arch.
    """
    parts = []
    pillar_segments = 8
    for x in (-GATE_PILLAR_X, GATE_PILLAR_X):
        pillar = from_profile(f"Pillar{x}", [(0.44, 0.0), (0.40, 0.25), (0.36, 2.45),
                                             (0.42, 2.62), (0.40, 2.78)],
                              segments=pillar_segments, color="stone", close_bottom=True)
        paint(pillar, "stone_dark", faces=lathe_span(pillar_segments, 0))
        paint(pillar, "stone_dark", faces=lathe_span(pillar_segments, 2))
        place(pillar, loc=(x, 0.0, 0.0))
        parts.append(pillar)

        footing = cube("Footing", size=(1.05, 1.05, 0.22), loc=(x, 0.0, 0.11),
                       color="stone_dark")
        bevel(footing, 0.03, 1)
        parts.append(footing)
        parts.append(cube("Capital", size=(0.55, 0.55, 0.22), loc=(x, 0.0, 2.70),
                          color="stone"))
        # Anchor for the barrier rope, which is a separate export.
        parts.append(cube("RopeEye", size=(0.12, 0.12, 0.12),
                          loc=(math.copysign(GATE_PILLAR_X - 0.48, x), 0.0, GATE_ROPE_Z),
                          color="gold", family="Metal"))

    lintel = cube("Lintel", size=(5.00, 0.55, 0.42), loc=(0.0, 0.0, GATE_LINTEL_Z),
                  color="wood")
    paint(lintel, "wood_dark", faces=select_faces(lintel, lambda c, n: n.z > 0.8))
    bevel(lintel, BOARD_BEVEL, 1)
    parts.append(lintel)
    cap = cube("LintelCap", size=(5.30, 0.72, 0.18), loc=(0.0, 0.0, 3.30), color="wood_dark")
    bevel(cap, BOARD_BEVEL, 1)
    parts.append(cap)

    sign = extrude_profile("Sign", [
        (-0.90, -0.50), (-0.72, -0.62), (0.72, -0.62), (0.90, -0.50),
        (0.90, -0.06), (0.72, 0.0), (-0.72, 0.0), (-0.90, -0.06),
    ], 0.09, color="wood_dark")
    paint(sign, "barn_trim", faces=[0])
    place(sign, loc=(0.0, 0.0, 2.72))
    parts.append(sign)
    parts.append(decal_panel("Panel", 1.60, 0.50, (0.0, -0.045 - DECAL_OFFSET, 2.41)))
    for x in (-0.55, 0.55):
        parts.append(cube("Hanger", size=(0.06, 0.05, 0.14), loc=(x, 0.0, 2.75),
                          color="iron", family="Metal"))

    for x in (-1.55, 1.55):
        parts.append(cube("LanternArm", size=(0.07, 0.07, 0.24), loc=(x, 0.0, 2.68),
                          color="iron", family="Metal"))
        parts.append(cone("LanternCap", r1=0.15, r2=0.05, depth=0.12, verts=6,
                          loc=(x, 0.0, 2.51), color="iron", family="Metal"))
        parts.append(cube("LanternGlass", size=(0.20, 0.20, 0.28), loc=(x, 0.0, 2.31),
                          color="straw_light", family="Emit"))
        parts.append(cube("LanternFoot", size=(0.24, 0.24, 0.06), loc=(x, 0.0, 2.14),
                          color="iron", family="Metal"))

    gate = join(parts, "TierGate")
    set_origin(gate, (0.0, 0.0, 0.0))
    report(gate)
    export_glb(gate, "tier_gate")


def build_tier_gate_rope():
    """The barrier slung across the gate, exported alone so it can be dropped.

    Built in the gate's own local space and pivoted on the ground at the gate
    centre, so the game parents it with an identity transform.
    """
    span = (GATE_PILLAR_X - 0.48) * 2.0
    stations = []
    steps = 8
    for i in range(steps + 1):
        t = i / steps
        # A parabola, not a catenary: indistinguishable over 3 m and one multiply.
        sag = 0.28 * (1.0 - (2.0 * t - 1.0) ** 2)
        stations.append(((t - 0.5) * span, GATE_ROPE_Z - sag))
    rope = banded_sweep("BarrierRope", stations, 0.05, 0.05, ("barn_red", "barn_trim"))

    knots = [cube("Knot", size=(0.14, 0.14, 0.14),
                  loc=(math.copysign(span / 2.0, side), 0.0, GATE_ROPE_Z),
                  color="gold", family="Metal") for side in (-1.0, 1.0)]

    barrier = join([rope] + knots, "TierGateRope")
    set_origin(barrier, (0.0, 0.0, 0.0))
    report(barrier)
    export_glb(barrier, "tier_gate_rope")


# --------------------------------------------------------------------------
# Storage silo
# --------------------------------------------------------------------------
def build_storage_silo():
    """The late-tier hay deposit: a hopper on legs with a chute and a gauge.

    The sign plate rides high on the barrel so the chute mouth stays clear --
    a player walks under the panel to reach the deposit point.
    """
    parts = []
    for x in (-0.62, 0.62):
        for y in (-0.62, 0.62):
            parts.append(post(f"Leg{x}{y}", 1.02, (x, y), 0.16, "iron", family="Metal"))
    for y in (-0.62, 0.62):
        parts.append(cube("Brace", size=(1.40, 0.08, 0.08), loc=(0.0, y, 0.42),
                          color="iron", family="Metal"))

    hopper_segments = 12
    hopper = from_profile("Hopper", [(0.18, 0.95), (0.26, 1.06), (0.92, 1.74),
                                     (0.92, 2.46), (0.84, 2.60)],
                          segments=hopper_segments, color="metal", family="Metal",
                          close_bottom=True)
    paint(hopper, "metal_dark", family="Metal", faces=lathe_span(hopper_segments, 0))
    paint(hopper, "metal_dark", family="Metal", faces=lathe_span(hopper_segments, 1))
    paint(hopper, "iron", family="Metal", faces=lathe_span(hopper_segments, 3))
    smooth(hopper, 34)
    parts.append(hopper)
    parts.append(cone("Lid", r1=0.90, r2=0.22, depth=0.26, verts=12, loc=(0.0, 0.0, 2.72),
                      color="barn_red"))

    chute = cube("Chute", size=(0.52, 1.15, 0.30), loc=(0.0, -0.62, 1.24),
                 rot=(math.radians(35.0), 0.0, 0.0), color="metal_dark", family="Metal")
    bevel(chute, BOARD_BEVEL, 1)
    parts.append(chute)
    parts.append(cube("ChuteLip", size=(0.62, 0.20, 0.10), loc=(0.0, -1.10, 0.88),
                      color="iron", family="Metal"))

    parts.append(cube("Gauge", size=(0.16, 0.14, 0.52), loc=(0.0, -0.80, 1.62),
                      color="glass", family="Glass"))

    plate = cube("SignPlate", size=(2.08, 0.10, 0.88), loc=(0.0, -1.00, 2.05), color="metal")
    paint(plate, "barn_trim", faces=select_faces(plate, lambda c, n: n.y < -0.8))
    bevel(plate, BOARD_BEVEL, 1)
    parts.append(plate)
    parts.append(decal_panel("Panel", 2.00, 0.80, (0.0, -1.05 - DECAL_OFFSET, 2.05)))
    for x in (-0.55, 0.55):
        parts.append(cube("Bracket", size=(0.08, 0.34, 0.08), loc=(x, -0.86, 2.05),
                          color="iron", family="Metal"))

    silo = join(parts, "StorageSilo")
    set_origin(silo, (0.0, 0.0, 0.0))
    report(silo)
    export_glb(silo, "storage_silo")


# --------------------------------------------------------------------------
# Spawn pad
# --------------------------------------------------------------------------
PAD_SEGMENTS = 14
PAD_TOP = 0.22


def build_spawn_pad():
    """A 4 m mosaic pad with four lamp posts -- where the player wakes up.

    The mosaic is three lathe rings painted face-by-face in alternating tones;
    the checker only exists because a lathe hands you its faces in a known
    order, so it costs nothing but a couple of paint calls.
    """
    pad = from_profile("Pad", [(2.00, 0.0), (2.00, PAD_TOP), (1.62, PAD_TOP),
                               (1.14, PAD_TOP), (0.62, PAD_TOP), (0.0, 0.26)],
                       segments=PAD_SEGMENTS, color="stone", close_bottom=True)
    paint(pad, "stone_dark", faces=lathe_span(PAD_SEGMENTS, 0))
    for ring, (light, dark) in enumerate((("sand", "stone"), ("stone", "stone_dark"),
                                          ("straw", "sand")), start=1):
        faces = lathe_span(PAD_SEGMENTS, ring)
        paint(pad, light, faces=faces[0::2])
        paint(pad, dark, faces=faces[1::2])
    paint(pad, "gold", family="Metal", faces=lathe_span(PAD_SEGMENTS, 4))
    parts = [pad]

    for x in (-1.30, 1.30):
        for y in (-1.30, 1.30):
            parts.append(cube(f"LampFoot{x}{y}", size=(0.26, 0.26, 0.10),
                              loc=(x, y, PAD_TOP + 0.05), color="stone_dark"))
            parts.append(cylinder(f"LampPost{x}{y}", radius=0.07, depth=0.95, verts=8,
                                  loc=(x, y, PAD_TOP + 0.52), color="iron", family="Metal"))
            parts.append(icosphere(f"LampGlobe{x}{y}", radius=0.13, subdivisions=1,
                                   loc=(x, y, PAD_TOP + 1.06), color="straw_light",
                                   family="Emit"))

    spawn = join(parts, "SpawnPad")
    set_origin(spawn, (0.0, 0.0, 0.0))
    report(spawn)
    export_glb(spawn, "spawn_pad")


BUILDERS = {
    "sell_trough": build_sell_trough,
    "upgrade_kiosk": build_upgrade_kiosk,
    "quest_board": build_quest_board,
    "leaderboard": build_leaderboard,
    "rebirth_shrine": build_rebirth_shrine,
    "tier_gate": build_tier_gate,
    "tier_gate_rope": build_tier_gate_rope,
    "storage_silo": build_storage_silo,
    "spawn_pad": build_spawn_pad,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        print(f"[kiosks] {name}")
        fn()
