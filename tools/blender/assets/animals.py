"""Farm animals: the cow, the hen, the barn cat and the scarecrow's crow.

Everything here is skinned and animated, which makes these the only modules that
build an armature.  The rig style is deliberately blunt -- one bone per body
part, rigid weights, under a dozen bones -- because a chunky box animal has no
soft tissue to deform and rigid weighting is the only scheme that cannot go
subtly wrong at build time.

Three conventions are worth knowing before reading the pose tables:

* Every animal faces -Y (the camera direction once the exporter flips to Y-up)
  and stands on Z=0.
* A bone's local axes follow Blender's roll-0 rule, so which channel you rotate
  depends on where the bone points.  For the horizontal spine/neck/head bones
  (pointing -Y) local X is pitch and local Z is yaw.  For the vertical root, leg
  and tail bones (pointing +/-Z) local Y runs along the bone, which is why
  :func:`lift` exists and why the cat's head yaw lives in the middle channel.
  The hen's wing bones point +Y, so their middle channel is a rotation *about*
  the bone -- which is a real flap only because the bone sits on the shoulder
  line with the whole wing panel hanging below it.
* Parts are laid out against each other's *chamfered* surfaces, not their boxes.
  A one-segment bevel of width w pulls a surface back by up to w near an edge,
  so neighbouring parts overlap by w plus a margin or they come apart in the
  export.
"""

import math

import bpy
from mathutils import Euler

FPS = 24
REST = (0.0, 0.0, 0.0)


# --------------------------------------------------------------------------
# Shape helpers
# --------------------------------------------------------------------------
def box(name, size, loc, rot_deg=(0.0, 0.0, 0.0), color=None, bevel_width=0.0,
        bevel_segments=1, family="Prop"):
    """A cube whose rotation is given in degrees, with an optional bevel.

    Nearly every part of every animal is a rounded box, so taking degrees and
    beveling on request removes a lot of noise from the call sites.
    """
    obj = cube(name, size=size, loc=loc,
               rot=tuple(math.radians(a) for a in rot_deg), color=color,
               family=family)
    if bevel_width > 0.0:
        bevel(obj, bevel_width, bevel_segments)
    return obj


def repaint(obj, color, predicate):
    """Bake pending modifiers, then paint the faces matching ``predicate``.

    Face indices only exist once the bevel is real, so the two steps always
    travel together.
    """
    apply_modifiers(obj)
    paint(obj, color, faces=select_faces(obj, predicate))
    return obj


# --------------------------------------------------------------------------
# Rigging
# --------------------------------------------------------------------------
def bind_parts(parts, mesh_name):
    """Join ``[(object, bone_name)]`` into one mesh with rigid vertex groups.

    Groups are assigned *before* the join rather than by slicing index ranges
    afterwards: Blender merges same-named groups when it joins meshes, so this
    version has no dependency on the order the join happens to visit objects in.
    """
    expected = 0
    for obj, bone_name in parts:
        apply_modifiers(obj)  # so bevel-generated vertices land in the group too
        group = obj.vertex_groups.new(name=bone_name)
        group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
        expected += len(obj.data.vertices)

    mesh = join([obj for obj, _ in parts], mesh_name)
    assert len(mesh.data.vertices) == expected, (
        f"{mesh_name}: join changed the vertex count "
        f"({len(mesh.data.vertices)} != {expected})")
    return mesh


def make_rig(name, bone_specs, mesh):
    """Build an armature from ``[(name, head, tail, parent)]`` and skin ``mesh``."""
    armature = bpy.data.armatures.new(name)
    rig = bpy.data.objects.new(name, armature)
    bpy.context.collection.objects.link(rig)

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for bone_name, head, tail, parent in bone_specs:
        bone = armature.edit_bones.new(bone_name)
        bone.head = head
        bone.tail = tail
        bone.roll = 0.0  # the pose tables assume Blender's default roll
        bone.use_connect = False
        if parent is not None:
            bone.parent = armature.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")

    bone_names = {spec[0] for spec in bone_specs}
    stray = {group.name for group in mesh.vertex_groups} - bone_names
    assert not stray, f"{name}: vertex groups with no bone: {sorted(stray)}"

    mesh.parent = rig
    mesh.matrix_parent_inverse = rig.matrix_world.inverted()
    modifier = mesh.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig
    modifier.use_vertex_groups = True
    return rig


def lift(metres):
    """A pose-bone translation of ``metres`` straight up.

    Pose locations live in bone space, and every root bone here points at +Z, so
    the bone's local +Y is the world's up.
    """
    return (0.0, metres, 0.0)


def frames(seconds):
    """Last frame of a loop that starts on frame 1 and runs for ``seconds``."""
    return 1 + int(round(seconds * FPS))


def purge_actions():
    """Delete *every* action in the file, fake user and all.

    :func:`add_action` marks its actions with a fake user so nothing garbage
    collects them mid-build, which also means ``clear_scene()`` cannot reclaim
    them: it only removes datablocks with ``users == 0`` and a fake user counts.
    Purging by name alone is not enough either.  The glTF exporter, handed a
    file with exactly one armature, collects every action in ``bpy.data`` whose
    channels resolve against that rig -- and "Eat"/"Peck" key "neck"/"head"/
    "body", bone names the hen, the cat and the crow all have too.  So a
    surviving cow action does not merely rename the next animal's "Idle" to
    "Idle.001", it ships a bogus extra clip inside chicken.glb.

    Call this once per builder, before the first :func:`add_action`.
    """
    for action in list(bpy.data.actions):
        action.use_fake_user = False
        bpy.data.actions.remove(action)


def add_action(rig, name, last_frame, tracks):
    """Key one looping action from ``{bone: [(frame, rot_deg[, location])]}``.

    Rotations are XYZ Euler degrees in *bone* space, converted here to the
    quaternions glTF wants.  The asserts enforce the two properties a game loop
    needs and that are invisible in a viewport: every track spans the whole
    range, and its last key restates its first.
    """
    # Belt and braces on top of purge_actions(): a name reused inside a single
    # builder would otherwise silently become "Idle.001".
    stale = bpy.data.actions.get(name)
    if stale is not None:
        stale.use_fake_user = False
        bpy.data.actions.remove(stale)

    if rig.animation_data is None:
        rig.animation_data_create()
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action

    # Safe only because the action just assigned is still empty and cannot fight
    # back: whatever pose the previous action left behind is cleared here, so an
    # unkeyed bone exports at rest instead of frozen mid-graze.
    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pose_bone.location = (0.0, 0.0, 0.0)

    for bone_name, keys in tracks.items():
        label = f"{rig.name}/{name}/{bone_name}"
        assert keys[0][0] == 1 and keys[-1][0] == last_frame, f"{label}: partial track"
        assert keys[0][1:] == keys[-1][1:], f"{label}: first and last key differ"
        moved = [key for key in keys if len(key) > 2]
        assert not moved or len(moved) == len(keys), f"{label}: mixed key shapes"

        pose_bone = rig.pose.bones[bone_name]
        for key in keys:
            frame, rot_deg = key[0], key[1]
            euler = Euler([math.radians(angle) for angle in rot_deg], "XYZ")
            pose_bone.rotation_quaternion = euler.to_quaternion()
            pose_bone.keyframe_insert("rotation_quaternion", frame=frame)
            if len(key) > 2:
                pose_bone.location = key[2]
                pose_bone.keyframe_insert("location", frame=frame)

    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = last_frame
    return action


# --------------------------------------------------------------------------
# Cow
# --------------------------------------------------------------------------
COW_BODY = (0.0, 0.06, 1.00)       # barrel centre; the shoulder line lands at 1.38 m
COW_BODY_SIZE = (0.66, 1.24, 0.76)
COW_LEG_TOP = 0.62                 # underside of the barrel, where the legs meet it
COW_SHOULDER = (0.24, -0.36)       # |x| and y of the front legs
COW_HIP = (0.24, 0.46)             # |x| and y of the back legs
COW_SPINE_Z = 1.00                 # the spine and neck bones run flat at these heights
COW_NECK_Z = 1.12

COW_BONES = [
    ("root", (0.0, 0.05, 0.0), (0.0, 0.05, 0.55), None),
    ("spine", (0.0, 0.64, COW_SPINE_Z), (0.0, -0.44, COW_SPINE_Z), "root"),
    ("neck", (0.0, -0.44, COW_NECK_Z), (0.0, -0.82, COW_NECK_Z), "spine"),
    ("head", (0.0, -0.82, COW_NECK_Z), (0.0, -1.16, COW_NECK_Z), "neck"),
    ("tail", (0.0, 0.70, 1.26), (0.0, 0.71, 0.69), "spine"),
    # Legs hang off the root, not the spine, so the body can breathe and graze
    # without dragging the hooves through the ground.
    ("leg_fl", (COW_SHOULDER[0], COW_SHOULDER[1], COW_LEG_TOP),
     (COW_SHOULDER[0], COW_SHOULDER[1], 0.02), "root"),
    ("leg_fr", (-COW_SHOULDER[0], COW_SHOULDER[1], COW_LEG_TOP),
     (-COW_SHOULDER[0], COW_SHOULDER[1], 0.02), "root"),
    ("leg_bl", (COW_HIP[0], COW_HIP[1], COW_LEG_TOP),
     (COW_HIP[0], COW_HIP[1], 0.02), "root"),
    ("leg_br", (-COW_HIP[0], COW_HIP[1], COW_LEG_TOP),
     (-COW_HIP[0], COW_HIP[1], 0.02), "root"),
]


def cow_parts():
    """Every mesh piece of the cow paired with the bone that owns it."""
    parts = []

    body = box("CowBody", COW_BODY_SIZE, COW_BODY, color="cow_hide",
               bevel_width=0.07, bevel_segments=2)
    repaint(body, shade("cow_hide", 0.86), lambda c, n: n.z < -0.8)
    parts.append((body, "spine"))

    # Holstein patches are proud plates rather than painted faces: a bevelled box
    # has only one quad per side, so painting one would black out a whole flank.
    for index, (size, loc) in enumerate([
        ((0.03, 0.46, 0.34), (0.335, 0.10, 1.10)),
        ((0.03, 0.34, 0.30), (-0.335, -0.18, 1.14)),
        ((0.34, 0.36, 0.03), (0.08, 0.44, 1.385)),
        ((0.26, 0.28, 0.03), (-0.06, -0.30, 1.385)),
    ]):
        parts.append((box(f"CowPatch{index}", size, loc, color="cow_spot"), "spine"))

    # She is a dairy cow wearing a dairy cow's bell, so she gets an udder: a
    # lathed sac tucked 2 cm up into the belly, well inboard of the hind legs.
    udder = from_profile(
        "CowUdder",
        [(0.055, 0.0), (0.10, 0.045), (0.12, 0.10), (0.115, 0.16), (0.10, 0.20)],
        segments=8, color="cow_nose",
    )
    place(udder, loc=(0.0, 0.26, 0.44))
    smooth(udder, 40)
    parts.append((udder, "spine"))
    # Four teats, apex-down, their bases 3 cm inside the sac's widest ring.
    for dx in (-0.035, 0.035):
        for dy in (-0.04, 0.04):
            teat = cone("CowTeat", r1=0.022, r2=0.0, depth=0.09, verts=6,
                        loc=(dx, 0.26 + dy, 0.425), rot=(math.pi, 0.0, 0.0),
                        color="cow_nose")
            parts.append((teat, "spine"))

    neck = box("CowNeck", (0.42, 0.34, 0.48), (0.0, -0.60, 1.14), color="cow_hide",
               bevel_width=0.04)
    parts.append((neck, "neck"))

    # A torus cannot ring a box neck.  This neck's surface is 0.21 from the axis
    # on the flat faces but 0.318 at the corners, so any tube narrow enough to
    # touch the flats is completely buried around all four corners and renders
    # as four floating arcs.  A chunky band that simply encloses the neck's
    # cross-section and stands 2 cm proud of it reads as a collar from every
    # angle and costs 68 fewer triangles than the torus did.
    collar = box("CowCollar", (0.46, 0.12, 0.52), (0.0, -0.62, 1.14),
                 color="barn_red", bevel_width=0.02)
    parts.append((collar, "neck"))

    # The profile deliberately starts at a small radius rather than at 0.0:
    # kit's from_profile winds a *bottom* apex fan the same way as a top one,
    # which is inside-out, and the resulting flipped tris punch a hole in the
    # bell under front-face culling.  Starting at 0.045 lets close_bottom cap it
    # with rings[0][::-1] instead, which is wound correctly.
    bell = from_profile(
        "CowBell",
        [(0.045, 0.0), (0.085, 0.02), (0.085, 0.055), (0.05, 0.10), (0.03, 0.125),
         (0.0, 0.13)],
        segments=8, color="gold", family="Metal",
    )
    place(bell, loc=(0.0, -0.62, 0.78))  # top 3 cm buried in the collar band
    smooth(bell, 40)
    parts.append((bell, "neck"))

    head = box("CowHead", (0.44, 0.44, 0.42), (0.0, -0.94, 1.20), color="cow_hide",
               bevel_width=0.06, bevel_segments=2)
    repaint(head, "cow_spot", lambda c, n: n.z > 0.85)
    parts.append((head, "head"))

    muzzle = box("CowMuzzle", (0.34, 0.26, 0.26), (0.0, -1.22, 1.11), color="cow_nose",
                 bevel_width=0.05)
    repaint(muzzle, shade("cow_nose", 0.78), lambda c, n: n.y < -0.8)
    parts.append((muzzle, "head"))

    for side in (1.0, -1.0):
        # The eye wraps the head's front-side corner instead of hiding on the
        # flank: 3.5 cm of it is proud in x and it stays visible head-on, which
        # is the angle a first-person player meets the cow from.
        parts.append((box("CowEye", (0.08, 0.09, 0.10), (side * 0.215, -1.105, 1.28),
                          color="black"), "head"))
        parts.append((box("CowGlint", (0.034, 0.034, 0.034),
                          (side * 0.228, -1.145, 1.305), color="white"), "head"))
        parts.append((box("CowEar", (0.24, 0.14, 0.06), (side * 0.30, -0.92, 1.30),
                          rot_deg=(0.0, side * 20.0, 0.0), color="cow_hide"), "head"))
        horn = cone("CowHorn", r1=0.055, r2=0.0, depth=0.18, verts=6,
                    loc=(side * 0.14, -0.90, 1.50),
                    rot=(0.0, math.radians(side * 30.0), 0.0), color="straw_grey")
        parts.append((horn, "head"))

    parts.append((box("CowTail", (0.08, 0.08, 0.54), (0.0, 0.70, 1.00),
                      rot_deg=(-6.0, 0.0, 0.0), color="cow_hide"), "tail"))
    parts.append((box("CowTuft", (0.14, 0.14, 0.18), (0.0, 0.735, 0.70),
                      color="cow_spot"), "tail"))

    # knee_dy pushes the joint block forward on the front legs and back on the
    # hind ones, which is enough to read as a knee and a hock in silhouette.
    for bone, (x, y), knee_dy in [
        ("leg_fl", COW_SHOULDER, -0.02),
        ("leg_fr", (-COW_SHOULDER[0], COW_SHOULDER[1]), -0.02),
        ("leg_bl", COW_HIP, 0.03),
        ("leg_br", (-COW_HIP[0], COW_HIP[1]), 0.03),
    ]:
        parts.append((box(f"CowLeg_{bone}", (0.20, 0.21, 0.52), (x, y, 0.38),
                          color="cow_hide"), bone))
        parts.append((box(f"CowKnee_{bone}", (0.225, 0.24, 0.14), (x, y + knee_dy, 0.36),
                          color="cow_hide"), bone))
        parts.append((box(f"CowHoof_{bone}", (0.22, 0.23, 0.14), (x, y, 0.07),
                          color="cow_spot"), bone))
    return parts


def build_cow():
    """A Holstein with a bell, a breathing idle and a grazing loop."""
    mesh = bind_parts(cow_parts(), "CowMesh")
    smooth(mesh, 38)
    set_origin(mesh, (0.0, 0.0, 0.0))
    rig = make_rig("CowRig", COW_BONES, mesh)
    purge_actions()

    idle_end = frames(4.0)
    add_action(rig, "Idle", idle_end, {
        "root": [(1, REST, lift(0.0)), (24, REST, lift(0.006)), (48, REST, lift(0.0)),
                 (72, REST, lift(0.004)), (idle_end, REST, lift(0.0))],
        "spine": [(1, REST), (24, (1.4, 0.0, 0.0)), (48, REST), (72, (1.0, 0.0, 0.0)),
                  (idle_end, REST)],
        "neck": [(1, REST), (28, (-2.0, 0.0, 5.0)), (56, (1.0, 0.0, 0.0)),
                 (80, (-2.0, 0.0, -5.0)), (idle_end, REST)],
        "head": [(1, REST), (28, (2.0, 0.0, -3.0)), (56, (-2.0, 0.0, 0.0)),
                 (80, (2.0, 0.0, 3.0)), (idle_end, REST)],
        # The flick: three fast beats punched out of an otherwise lazy sway.
        "tail": [(1, REST), (18, (0.0, 0.0, 5.0)), (36, (0.0, 0.0, -4.0)), (54, REST),
                 (60, (0.0, 0.0, -19.0)), (66, (0.0, 0.0, 17.0)), (72, (0.0, 0.0, -9.0)),
                 (80, (0.0, 0.0, 4.0)), (idle_end, REST)],
    })

    # Spine 4 + neck 60 + head 26 chained through the actual bone heads puts the
    # muzzle's front-bottom corner at z = 0.175 m -- that is this rig's floor,
    # not a hand's width above the grass.  Leaning further curls the head back
    # up again: the neck-to-nose reach is 0.78 m from a pivot at 1.12 m, so 90
    # degrees of total pitch is as low as the cow gets without splaying her
    # front legs.  Whoever tunes the grass scatter should aim at ~0.18 m, not
    # ~0.10 m.
    eat_end = frames(3.0)
    add_action(rig, "Eat", eat_end, {
        "spine": [(1, REST), (20, (-4.0, 0.0, 0.0)), (56, (-4.0, 0.0, 0.0)),
                  (eat_end, REST)],
        "neck": [(1, REST), (20, (-60.0, 0.0, 0.0)), (56, (-59.0, 0.0, 0.0)),
                 (eat_end, REST)],
        "head": [(1, REST), (20, (-26.0, 0.0, 0.0)), (26, (-20.0, 0.0, 0.0)),
                 (32, (-28.0, 0.0, 0.0)), (38, (-20.0, 0.0, 0.0)),
                 (44, (-28.0, 0.0, 0.0)), (50, (-21.0, 0.0, 0.0)),
                 (56, (-26.0, 0.0, 0.0)), (eat_end, REST)],
        "leg_fl": [(1, REST), (20, (-6.0, 0.0, 0.0)), (56, (-6.0, 0.0, 0.0)),
                   (eat_end, REST)],
        "leg_fr": [(1, REST), (20, (-6.0, 0.0, 0.0)), (56, (-6.0, 0.0, 0.0)),
                   (eat_end, REST)],
        "leg_bl": [(1, REST), (20, (4.0, 0.0, 0.0)), (56, (4.0, 0.0, 0.0)),
                   (eat_end, REST)],
        "leg_br": [(1, REST), (20, (4.0, 0.0, 0.0)), (56, (4.0, 0.0, 0.0)),
                   (eat_end, REST)],
        "tail": [(1, REST), (24, (0.0, 0.0, 6.0)), (48, (0.0, 0.0, -6.0)),
                 (eat_end, REST)],
    })

    report(mesh)
    # Both objects, so export_glb's face tally counts the mesh instead of
    # printing "(0 faces)" for the armature and hiding a budget regression.
    export_glb([rig, mesh], "cow", animated=True)


# --------------------------------------------------------------------------
# Chicken
# --------------------------------------------------------------------------
CHICKEN_BODY = (0.0, 0.02, 0.22)
CHICKEN_NECK_Z = 0.32
CHICKEN_FOOT_X = 0.062
CHICKEN_WING_Z = 0.30   # the shoulder line: the wing panel hangs entirely below it

CHICKEN_BONES = [
    ("root", (0.0, 0.0, 0.0), (0.0, 0.0, 0.10), None),
    ("body", (0.0, 0.10, 0.22), (0.0, -0.08, 0.22), "root"),
    ("neck", (0.0, -0.08, CHICKEN_NECK_Z), (0.0, -0.15, CHICKEN_NECK_Z), "body"),
    ("head", (0.0, -0.15, CHICKEN_NECK_Z), (0.0, -0.24, CHICKEN_NECK_Z), "neck"),
    ("leg_l", (CHICKEN_FOOT_X, 0.005, 0.115), (CHICKEN_FOOT_X, 0.005, 0.005), "root"),
    ("leg_r", (-CHICKEN_FOOT_X, 0.005, 0.115), (-CHICKEN_FOOT_X, 0.005, 0.005), "root"),
    # A +Y bone's middle pose channel rotates about the bone's own length.  On
    # the shoulder line that is a flap; through the middle of the panel (where
    # these bones used to sit) it was only a twist that buried the wing's top
    # edge in the body while swinging the bottom edge out.
    ("wing_l", (0.105, -0.06, CHICKEN_WING_Z), (0.105, 0.10, CHICKEN_WING_Z), "body"),
    ("wing_r", (-0.105, -0.06, CHICKEN_WING_Z), (-0.105, 0.10, CHICKEN_WING_Z), "body"),
]


def chicken_parts():
    """Every mesh piece of the hen paired with the bone that owns it."""
    parts = []

    body = box("HenBody", (0.22, 0.30, 0.24), CHICKEN_BODY, color="white",
               bevel_width=0.065, bevel_segments=2)
    repaint(body, shade("white", 0.86), lambda c, n: n.z < -0.8)
    parts.append((body, "body"))

    parts.append((box("HenNeck", (0.125, 0.115, 0.12), (0.0, -0.10, 0.32),
                      color="white"), "neck"))

    head = box("HenHead", (0.14, 0.14, 0.13), (0.0, -0.155, 0.375), color="white",
               bevel_width=0.04)
    parts.append((head, "head"))

    # A four-sided cone is a wedge, which is exactly the beak we want.
    beak = cone("HenBeak", r1=0.042, r2=0.0, depth=0.085, verts=4,
                loc=(0.0, -0.26, 0.365), rot=(math.radians(90), 0.0, 0.0), color="gold")
    parts.append((beak, "head"))

    for index, y in enumerate((-0.195, -0.155, -0.115)):
        parts.append((box(f"HenComb{index}", (0.028, 0.045, 0.05), (0.0, y, 0.455),
                          color="barn_red"), "head"))
    parts.append((box("HenWattle", (0.03, 0.04, 0.05), (0.0, -0.225, 0.325),
                      color="barn_red"), "head"))

    for side in (1.0, -1.0):
        wing_bone = "wing_l" if side > 0 else "wing_r"
        leg_bone = "leg_l" if side > 0 else "leg_r"
        parts.append((box("HenEye", (0.028, 0.028, 0.032),
                          (side * 0.062, -0.20, 0.395), color="black"), "head"))
        parts.append((box("HenWing", (0.045, 0.185, 0.13), (side * 0.115, 0.03, 0.235),
                          rot_deg=(0.0, -side * 6.0, 0.0), color="straw_grey",
                          bevel_width=0.02), wing_bone))
        # The shank starts at the foot's mid-height so the two do not share a
        # coplanar underside and z-fight.
        parts.append((box("HenShank", (0.032, 0.032, 0.101),
                          (side * CHICKEN_FOOT_X, 0.005, 0.0645), color="gold"),
                      leg_bone))
        parts.append((box("HenFoot", (0.075, 0.11, 0.028),
                          (side * CHICKEN_FOOT_X, -0.03, 0.014), color="gold"),
                      leg_bone))

    for index, (dx, spread) in enumerate([(-0.03, -14.0), (0.0, 0.0), (0.03, 14.0)]):
        parts.append((box(f"HenTail{index}", (0.03, 0.14, 0.095), (dx, 0.195, 0.325),
                          rot_deg=(-38.0, 0.0, spread), color="white"), "body"))
    return parts


def build_chicken():
    """A plump white hen that bobs on the spot and pecks the dirt."""
    mesh = bind_parts(chicken_parts(), "HenMesh")
    smooth(mesh, 38)
    set_origin(mesh, (0.0, 0.0, 0.0))
    rig = make_rig("HenRig", CHICKEN_BONES, mesh)
    purge_actions()

    # The wings hold a small resting flare, so their loops return to that rather
    # than to zero.  Negative on the left, positive on the right, both swinging
    # the panel's lower edge away from the body.
    wing_rest_l, wing_rest_r = (0.0, -2.0, 0.0), (0.0, 2.0, 0.0)

    idle_end = frames(2.0)
    add_action(rig, "Idle", idle_end, {
        "root": [(1, REST, lift(0.0)), (12, REST, lift(0.006)), (24, REST, lift(0.0)),
                 (36, REST, lift(0.004)), (idle_end, REST, lift(0.0))],
        "body": [(1, REST), (12, (3.0, 0.0, 0.0)), (24, REST), (36, (-2.0, 0.0, 0.0)),
                 (idle_end, REST)],
        "neck": [(1, REST), (12, (-6.0, 0.0, 4.0)), (24, REST), (36, (-5.0, 0.0, -4.0)),
                 (idle_end, REST)],
        "head": [(1, REST), (12, (6.0, 0.0, -6.0)), (24, REST), (36, (5.0, 0.0, 6.0)),
                 (idle_end, REST)],
        "wing_l": [(1, wing_rest_l), (16, (0.0, -9.0, 0.0)), (32, wing_rest_l),
                   (idle_end, wing_rest_l)],
        "wing_r": [(1, wing_rest_r), (16, (0.0, 9.0, 0.0)), (32, wing_rest_r),
                   (idle_end, wing_rest_r)],
    })

    # Body 18 + neck 60 + head 32 is what it takes to land the beak on Z=0 from a
    # pivot at 0.22 m.
    peck_end = frames(1.2)
    add_action(rig, "Peck", peck_end, {
        "body": [(1, REST), (9, (-16.0, 0.0, 0.0)), (14, (-18.0, 0.0, 0.0)),
                 (21, REST), (peck_end, REST)],
        "neck": [(1, REST), (9, (-52.0, 0.0, 0.0)), (13, (-60.0, 0.0, 0.0)),
                 (17, (-46.0, 0.0, 0.0)), (23, REST), (peck_end, REST)],
        "head": [(1, REST), (9, (-26.0, 0.0, 0.0)), (13, (-32.0, 0.0, 0.0)),
                 (17, (-20.0, 0.0, 0.0)), (23, REST), (peck_end, REST)],
        "wing_l": [(1, wing_rest_l), (13, (0.0, -12.0, 0.0)), (23, wing_rest_l),
                   (peck_end, wing_rest_l)],
        "wing_r": [(1, wing_rest_r), (13, (0.0, 12.0, 0.0)), (23, wing_rest_r),
                   (peck_end, wing_rest_r)],
    })

    report(mesh)
    export_glb([rig, mesh], "chicken", animated=True)


# --------------------------------------------------------------------------
# Cat
# --------------------------------------------------------------------------
CAT_TORSO = (0.0, -0.015, 0.22)
CAT_TORSO_HALF_DEPTH = 0.085
CAT_TILT = 6.0  # degrees; a sitting cat leans back a little

CAT_BONES = [
    ("root", (0.0, 0.04, 0.0), (0.0, 0.04, 0.10), None),
    ("body", (0.0, 0.04, 0.10), (0.0, 0.04, 0.30), "root"),
    ("head", (0.0, -0.03, 0.29), (0.0, -0.03, 0.43), "body"),
    ("tail1", (0.0, 0.14, 0.05), (0.0, 0.19, 0.16), "root"),
    ("tail2", (0.0, 0.19, 0.16), (0.0, 0.235, 0.27), "tail1"),
    ("tail3", (0.0, 0.235, 0.27), (0.0, 0.245, 0.39), "tail2"),
]


def cat_parts():
    """Every mesh piece of the cat paired with the bone that owns it."""
    parts = []

    haunch = box("CatHaunch", (0.17, 0.26, 0.16), (0.0, 0.06, 0.08), color="pumpkin",
                 bevel_width=0.045)
    parts.append((haunch, "root"))

    torso = box("CatTorso", (0.155, 0.17, 0.20), CAT_TORSO, rot_deg=(CAT_TILT, 0.0, 0.0),
                color="pumpkin", bevel_width=0.04)
    repaint(torso, "white", lambda c, n: n.y < -0.7)
    parts.append((torso, "body"))

    # Tabby banding, laid on the tilted back plane rather than painted, so the
    # stripes stay narrow instead of swallowing a whole face.  The torso's 0.04
    # bevel leaves only +/-0.0375 of flat back face across and +/-0.06 along, so
    # the stripes are cut to fit inside that window: any wider and their ends
    # would float clear of the rounded edges as free-standing tabs.
    tilt = math.radians(CAT_TILT)
    outward = (0.0, math.cos(tilt), math.sin(tilt))
    along = (0.0, -math.sin(tilt), math.cos(tilt))
    for index, offset in enumerate((-0.045, 0.0, 0.045)):
        loc = tuple(CAT_TORSO[axis]
                    + outward[axis] * (CAT_TORSO_HALF_DEPTH + 0.001)
                    + along[axis] * offset
                    for axis in range(3))
        parts.append((box(f"CatStripe{index}", (0.085, 0.014, 0.024), loc,
                          rot_deg=(CAT_TILT, 0.0, 0.0), color="copper"), "body"))

    head = box("CatHead", (0.15, 0.14, 0.13), (0.0, -0.045, 0.36), color="pumpkin",
               bevel_width=0.045, bevel_segments=2)
    parts.append((head, "head"))

    muzzle = box("CatMuzzle", (0.075, 0.055, 0.05), (0.0, -0.105, 0.335), color="white")
    repaint(muzzle, "cow_nose", lambda c, n: n.y < -0.8)
    parts.append((muzzle, "head"))

    for side in (1.0, -1.0):
        # r1 0.038 at |x| 0.040 keeps the whole base square inside the head's
        # 0.075 half-width once the 12-degree cant is applied; the extra depth
        # buys the height back so the ear still spikes 5.7 cm above the skull.
        ear = cone("CatEar", r1=0.038, r2=0.0, depth=0.085, verts=4,
                   loc=(side * 0.040, -0.02, 0.44),
                   rot=(0.0, math.radians(side * 12.0), 0.0), color="pumpkin")
        parts.append((ear, "head"))
        parts.append((box("CatEye", (0.03, 0.022, 0.032), (side * 0.045, -0.112, 0.375),
                          color="leaf"), "head"))
        # The forelegs ride the root: they are rigid pillars holding the cat up.
        # The leg starts at the paw's mid-height so their undersides are not
        # coplanar.
        parts.append((box("CatForeleg", (0.055, 0.06, 0.178), (side * 0.048, -0.075, 0.111),
                          color="pumpkin"), "root"))
        parts.append((box("CatPaw", (0.062, 0.085, 0.045), (side * 0.048, -0.10, 0.0225),
                          color="white"), "root"))

    for index, (size, loc, pitch, bone) in enumerate([
        ((0.052, 0.052, 0.135), (0.0, 0.163, 0.105), 35.0, "tail1"),
        ((0.048, 0.048, 0.13), (0.0, 0.215, 0.215), 18.0, "tail2"),
        ((0.044, 0.044, 0.125), (0.0, 0.24, 0.33), 5.0, "tail3"),
    ]):
        segment = box(f"CatTail{index}", size, loc, rot_deg=(pitch, 0.0, 0.0),
                      color="pumpkin")
        if bone == "tail3":
            repaint(segment, "white", lambda c, n: n.z > 0.7)
        parts.append((segment, bone))
    return parts


def build_cat():
    """A sitting orange tabby whose tail never quite stops moving."""
    mesh = bind_parts(cat_parts(), "CatMesh")
    smooth(mesh, 38)
    set_origin(mesh, (0.0, 0.0, 0.0))
    rig = make_rig("CatRig", CAT_BONES, mesh)
    purge_actions()

    # The three tail bones run the same sway a few frames apart, which turns a
    # rigid chain into a travelling wave.
    idle_end = frames(4.0)
    add_action(rig, "Idle", idle_end, {
        "root": [(1, REST, lift(0.0)), (32, REST, lift(0.005)), (64, REST, lift(0.0)),
                 (idle_end, REST, lift(0.0))],
        "body": [(1, REST), (32, (1.5, 0.0, 0.0)), (64, REST), (idle_end, REST)],
        # The head bone points up, so its yaw is the middle (local Y) channel.
        "head": [(1, REST), (20, (0.0, 14.0, 0.0)), (44, (0.0, 14.0, 0.0)),
                 (56, (-3.0, -10.0, 0.0)), (80, (0.0, -10.0, 0.0)), (idle_end, REST)],
        "tail1": [(1, REST), (24, (0.0, 0.0, 7.0)), (48, REST), (72, (0.0, 0.0, -7.0)),
                  (idle_end, REST)],
        "tail2": [(1, REST), (30, (0.0, 0.0, 10.0)), (54, REST), (78, (0.0, 0.0, -10.0)),
                  (idle_end, REST)],
        "tail3": [(1, REST), (36, (0.0, 0.0, 13.0)), (60, REST), (84, (0.0, 0.0, -13.0)),
                  (idle_end, REST)],
    })

    report(mesh)
    export_glb([rig, mesh], "cat", animated=True)


# --------------------------------------------------------------------------
# Crow
# --------------------------------------------------------------------------
# Built at true crow scale: 0.48 m beak to tail tip, 0.395 m to the crown.  The
# earlier bird was 0.30 m long and read as a blackbird next to a 1.75 m player.
# It is only ~200 triangles, so the extra size is free.
CROW_BONES = [
    ("root", (0.0, 0.027, 0.0), (0.0, 0.027, 0.12), None),
    ("body", (0.0, 0.12, 0.255), (0.0, -0.05, 0.255), "root"),
    ("head", (0.0, -0.05, 0.335), (0.0, -0.16, 0.335), "body"),
    ("tail", (0.0, 0.12, 0.25), (0.0, 0.25, 0.225), "body"),
]


def crow_parts():
    """Every mesh piece of the crow paired with the bone that owns it.

    Every overlap here is measured against the neighbour's *chamfered* surface.
    The body's 0.035 bevel pulls its underside up to z ~0.19 out at the legs, so
    the legs run 3.5 cm past that; the head buries a 7 x 6 cm block of itself in
    the body rather than sharing a corner the two chamfers would eat; and the
    wings' inner faces sit 1.5 cm inside the body's side at their lowest point.
    """
    parts = []

    parts.append((box("CrowBody", (0.135, 0.245, 0.16), (0.0, 0.022, 0.255),
                      color="black", bevel_width=0.035), "body"))
    parts.append((box("CrowHead", (0.12, 0.12, 0.12), (0.0, -0.088, 0.335),
                      color="black", bevel_width=0.03), "head"))

    beak = cone("CrowBeak", r1=0.035, r2=0.0, depth=0.10, verts=4,
                loc=(0.0, -0.175, 0.33), rot=(math.radians(90), 0.0, 0.0),
                color="metal_dark")
    parts.append((beak, "head"))

    for side in (1.0, -1.0):
        # "black" has no lighter sibling in the palette, so the wing sheen is a
        # brightened version of it rather than an invented hue.
        wing = box("CrowWing", (0.03, 0.19, 0.09), (side * 0.065, 0.027, 0.25),
                   rot_deg=(0.0, -side * 5.0, 0.0), color="black")
        repaint(wing, shade("black", 1.9), lambda c, n: n.x * side > 0.8)
        parts.append((wing, "body"))
        # The eye rides the side of the skull, where a corvid's eye actually is
        # and where it stays proud of the chamfer instead of sinking into the
        # rounded front corner.
        parts.append((box("CrowEye", (0.026, 0.028, 0.028), (side * 0.055, -0.108, 0.345),
                          color="straw_light"), "head"))
        parts.append((box("CrowLeg", (0.024, 0.024, 0.214), (side * 0.047, 0.027, 0.118),
                          color="metal_dark"), "root"))
        parts.append((box("CrowClaw", (0.035, 0.081, 0.022), (side * 0.047, -0.007, 0.011),
                          color="metal_dark"), "root"))

    parts.append((box("CrowTail", (0.10, 0.16, 0.027), (0.0, 0.18, 0.245),
                      rot_deg=(12.0, 0.0, 0.0), color="black"), "tail"))
    return parts


def build_crow():
    """A perching crow that watches the yard in sharp, birdlike ticks."""
    mesh = bind_parts(crow_parts(), "CrowMesh")
    smooth(mesh, 38)
    set_origin(mesh, (0.0, 0.0, 0.0))
    rig = make_rig("CrowRig", CROW_BONES, mesh)
    purge_actions()

    # Four-frame snaps between long holds -- birds do not ease into a look.
    idle_end = frames(3.0)
    add_action(rig, "Idle", idle_end, {
        "root": [(1, REST, lift(0.0)), (12, REST, lift(0.005)), (44, REST, lift(0.0)),
                 (48, REST, lift(0.007)), (idle_end, REST, lift(0.0))],
        "body": [(1, REST), (36, (2.0, 0.0, 0.0)), (idle_end, REST)],
        "head": [(1, REST), (8, REST), (12, (0.0, 0.0, 30.0)), (26, (0.0, 0.0, 30.0)),
                 (30, (-8.0, 0.0, 4.0)), (40, (-8.0, 0.0, 4.0)), (44, (0.0, 0.0, -26.0)),
                 (58, (0.0, 0.0, -26.0)), (62, REST), (idle_end, REST)],
        "tail": [(1, REST), (11, REST), (14, (-9.0, 0.0, 0.0)), (18, REST), (43, REST),
                 (46, (-7.0, 0.0, 0.0)), (50, REST), (idle_end, REST)],
    })

    report(mesh)
    export_glb([rig, mesh], "crow", animated=True)


BUILDERS = {
    "cow": build_cow,
    "chicken": build_chicken,
    "cat": build_cat,
    "crow": build_crow,
}


def build_all():
    for name, fn in BUILDERS.items():
        clear_scene()
        purge_actions()  # fake-user actions outlive clear_scene(); see purge_actions
        print(f"[animals] {name}")
        fn()
