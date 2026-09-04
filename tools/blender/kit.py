"""Modelling kit for the Find the Needle art style.

Every asset script imports this module, builds its geometry with the helpers
below, and calls :func:`export_glb`.  The house style is chunky low-poly with
lightly bevelled edges and *no textures* -- surface colour lives in a per-corner
FLOAT_COLOR attribute so an entire prop collapses to a single draw call in the
browser and the whole model library weighs a few dozen kilobytes.

Run from Blender with::

    exec(open(r"D:/projects/find-the-needle/tools/blender/kit.py").read())
"""

from __future__ import annotations

import math
import os

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

PROJECT_DIR = r"D:/projects/find-the-needle"
MODEL_DIR = os.path.join(PROJECT_DIR, "public", "models")

TAU = math.tau

# --------------------------------------------------------------------------
# Palette
# --------------------------------------------------------------------------
# Sampled from the reference art: warm saturated farmland under a midday sun.
PALETTE: dict[str, str] = {
    # straw & hay
    "straw_light": "#F2D98B",
    "straw": "#E3BF62",
    "straw_mid": "#D3A945",
    "straw_dark": "#B08630",
    "straw_grey": "#C9B489",
    # ground
    "grass": "#6FBF3F",
    "grass_dark": "#4E9A2E",
    "grass_deep": "#3B7A22",
    "dirt": "#9A6A3C",
    "dirt_dark": "#7A5230",
    "sand": "#E4D2A6",
    "path": "#B98B54",
    # wood
    "wood": "#A9773F",
    "wood_dark": "#7C5429",
    "wood_light": "#C79B5E",
    "plank": "#C2A277",
    # barn
    "barn_red": "#E0555F",
    "barn_pink": "#F07C86",
    "barn_roof": "#5E3644",
    "barn_trim": "#FBF3EC",
    # metal
    "metal": "#C9D2DA",
    "metal_dark": "#8A949E",
    "iron": "#6E7681",
    "gold": "#F2C044",
    "copper": "#C9743C",
    # accents
    "white": "#FBF7F0",
    "black": "#2A2622",
    "cow_hide": "#F5EFE6",
    "cow_spot": "#3B3330",
    "cow_nose": "#E9A6A6",
    "pumpkin": "#E8823A",
    "leaf": "#57A83C",
    "leaf_dark": "#3F8A2B",
    "pine": "#4C9A3A",
    "pine_dark": "#37752A",
    "sky": "#7EC8F2",
    "cloud": "#FDFDFF",
    "mushroom_cap": "#D8453F",
    "mushroom_stem": "#F4EAD8",
    "glass": "#BFE4F5",
    "rubber": "#3A3D42",
    "skin": "#F0B48A",
    "glove": "#F6F2EA",
    "denim": "#4A6B96",
    "ufo": "#8FE3C8",
    "ufo_glass": "#9BD8FF",
    "rope": "#D8C08E",
    "stone": "#9AA0A6",
    "stone_dark": "#767C82",
}

# Shading families.  Keeping this list short keeps the runtime material count low.
SURFACES: dict[str, dict[str, float]] = {
    "Prop": {"roughness": 0.85, "metallic": 0.0},
    "Metal": {"roughness": 0.28, "metallic": 0.9},
    "Foliage": {"roughness": 0.9, "metallic": 0.0},
    "Glass": {"roughness": 0.08, "metallic": 0.0, "alpha": 0.35},
    "Emit": {"roughness": 0.5, "metallic": 0.0, "emission": 1.0},
}


# --------------------------------------------------------------------------
# Colour helpers
# --------------------------------------------------------------------------
def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(value: str) -> tuple[float, float, float, float]:
    """Convert an sRGB hex string (or palette key) to linear-space RGBA."""
    key = PALETTE.get(value, value).lstrip("#")
    r, g, b = (int(key[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), 1.0)


def shade(value: str, factor: float) -> tuple[float, float, float, float]:
    """Multiply a palette colour's linear RGB by ``factor`` (clamped)."""
    r, g, b, a = hex_to_linear(value)
    return (min(r * factor, 1.0), min(g * factor, 1.0), min(b * factor, 1.0), a)


# --------------------------------------------------------------------------
# Scene management
# --------------------------------------------------------------------------
def clear_scene() -> None:
    """Wipe the scene and every orphaned datablock so runs are reproducible."""
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=True)
    for collection in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.curves,
        bpy.data.armatures,
        bpy.data.actions,
        bpy.data.images,
        bpy.data.node_groups,
    ):
        for datablock in list(collection):
            if datablock.users == 0:
                collection.remove(datablock)


def _activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# --------------------------------------------------------------------------
# Surface assignment
# --------------------------------------------------------------------------
def _surface_material(family: str) -> bpy.types.Material:
    """One shared material per shading family, driven by the colour attribute."""
    name = f"FTN_{family}"
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing

    spec = SURFACES[family]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = spec["roughness"]
    bsdf.inputs["Metallic"].default_value = spec["metallic"]

    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    attr.location = (-320, 180)
    links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])

    if "emission" in spec:
        links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = spec["emission"]
    if "alpha" in spec:
        bsdf.inputs["Alpha"].default_value = spec["alpha"]
        # Material.blend_method was retired when EEVEE Next landed and replaced
        # by surface_render_method.  The magnifier's lens is the first Glass part
        # in the library, so this line is the first one to find out which build
        # we are on; without the guard it takes the whole model down.
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
        elif hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
    return mat


def paint(obj: bpy.types.Object, color, family: str = "Prop", faces=None) -> bpy.types.Object:
    """Write ``color`` into the object's corner colour attribute.

    ``faces`` optionally restricts the paint to a set of polygon indices, which
    is how a single joined mesh ends up multi-coloured while still exporting as
    one material.
    """
    mesh = obj.data
    rgba = hex_to_linear(color) if isinstance(color, str) else tuple(color)

    layer = mesh.color_attributes.get("Col")
    if layer is None:
        layer = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    mesh.color_attributes.active_color = layer
    mesh.attributes.active_color = layer

    if faces is None:
        for datum in layer.data:
            datum.color = rgba
    else:
        wanted = set(faces)
        for poly in mesh.polygons:
            if poly.index in wanted:
                for corner in poly.loop_indices:
                    layer.data[corner].color = rgba

    mat = _surface_material(family)
    if mat.name not in {slot.name for slot in mesh.materials}:
        mesh.materials.append(mat)
    slot_index = list(mesh.materials).index(mat)
    target = mesh.polygons if faces is None else [mesh.polygons[i] for i in faces]
    for poly in target:
        poly.material_index = slot_index
    return obj


def select_faces(obj: bpy.types.Object, predicate) -> list[int]:
    """Polygon indices whose (centre, normal) pass ``predicate``."""
    return [p.index for p in obj.data.polygons if predicate(p.center, p.normal)]


# --------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------
def _finish(name: str, color, family: str) -> bpy.types.Object:
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    if color is not None:
        paint(obj, color, family)
    return obj


def cube(name="Cube", size=(1.0, 1.0, 1.0), loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0),
         color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    obj = _finish(name, color, family)
    obj.scale = size
    apply_transform(obj)
    return obj


def cylinder(name="Cylinder", radius=0.5, depth=1.0, verts=16, loc=(0.0, 0.0, 0.0),
             rot=(0.0, 0.0, 0.0), color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth,
                                        location=loc, rotation=rot)
    return _finish(name, color, family)


def cone(name="Cone", r1=0.5, r2=0.0, depth=1.0, verts=16, loc=(0.0, 0.0, 0.0),
         rot=(0.0, 0.0, 0.0), color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth,
                                    location=loc, rotation=rot)
    return _finish(name, color, family)


def sphere(name="Sphere", radius=0.5, segments=16, rings=8, loc=(0.0, 0.0, 0.0),
           rot=(0.0, 0.0, 0.0), color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius,
                                         location=loc, rotation=rot)
    return _finish(name, color, family)


def icosphere(name="Icosphere", radius=0.5, subdivisions=2, loc=(0.0, 0.0, 0.0),
              color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius, location=loc)
    return _finish(name, color, family)


def torus(name="Torus", major=0.5, minor=0.1, major_seg=20, minor_seg=8, loc=(0.0, 0.0, 0.0),
          rot=(0.0, 0.0, 0.0), color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor,
                                     major_segments=major_seg, minor_segments=minor_seg,
                                     location=loc, rotation=rot)
    return _finish(name, color, family)


def plane(name="Plane", size=(1.0, 1.0), loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0),
          color=None, family="Prop") -> bpy.types.Object:
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc, rotation=rot)
    obj = _finish(name, color, family)
    obj.scale = (size[0], size[1], 1.0)
    apply_transform(obj)
    return obj


def from_profile(name: str, profile: list[tuple[float, float]], segments: int = 16,
                 color=None, family="Prop", close_bottom=True, close_top=True) -> bpy.types.Object:
    """Lathe a 2-D (radius, height) profile around Z.

    The workhorse for silos, mugs, mushrooms, trees and anything else
    rotationally symmetric.
    """
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings: list[list[bmesh.types.BMVert]] = []
    for radius, height in profile:
        if radius <= 1e-6:
            rings.append([bm.verts.new((0.0, 0.0, height))])
            continue
        ring = []
        for i in range(segments):
            angle = TAU * i / segments
            ring.append(bm.verts.new((math.cos(angle) * radius, math.sin(angle) * radius, height)))
        rings.append(ring)

    for lower, upper in zip(rings, rings[1:]):
        if len(lower) == 1 and len(upper) == 1:
            continue
        if len(lower) == 1:
            for i in range(segments):
                bm.faces.new((lower[0], upper[i], upper[(i + 1) % segments]))
        elif len(upper) == 1:
            for i in range(segments):
                bm.faces.new((lower[i], lower[(i + 1) % segments], upper[0]))
        else:
            for i in range(segments):
                j = (i + 1) % segments
                bm.faces.new((lower[i], lower[j], upper[j], upper[i]))

    if close_bottom and len(rings[0]) > 1:
        bm.faces.new(rings[0][::-1])
    if close_top and len(rings[-1]) > 1:
        bm.faces.new(rings[-1])

    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    _activate(obj)
    if color is not None:
        paint(obj, color, family)
    return obj


def from_points(name: str, verts, faces, color=None, family="Prop") -> bpy.types.Object:
    """Build a mesh straight from vertex/face lists."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([Vector(v) for v in verts], [], [list(f) for f in faces])
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    _activate(obj)
    recalc_normals(obj)
    if color is not None:
        paint(obj, color, family)
    return obj


# --------------------------------------------------------------------------
# Transforms & modifiers
# --------------------------------------------------------------------------
def place(obj: bpy.types.Object, loc=None, rot=None, scale=None) -> bpy.types.Object:
    if loc is not None:
        obj.location = loc
    if rot is not None:
        obj.rotation_euler = Euler(rot, "XYZ")
    if scale is not None:
        obj.scale = scale if hasattr(scale, "__len__") else (scale, scale, scale)
    return obj


def apply_transform(obj: bpy.types.Object, location=False, rotation=True,
                    scale=True) -> bpy.types.Object:
    _activate(obj)
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)
    return obj


def bevel(obj: bpy.types.Object, width=0.02, segments=1, angle_deg=40.0,
          clamp=True) -> bpy.types.Object:
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle_deg)
    mod.use_clamp_overlap = clamp
    mod.harden_normals = False
    return obj


def subsurf(obj: bpy.types.Object, levels=1) -> bpy.types.Object:
    mod = obj.modifiers.new("Subdivision", "SUBSURF")
    mod.levels = mod.render_levels = levels
    return obj


def solidify(obj: bpy.types.Object, thickness=0.05, offset=-1.0) -> bpy.types.Object:
    mod = obj.modifiers.new("Solidify", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = offset
    return obj


def mirror(obj: bpy.types.Object, axis=(True, False, False), obj_ref=None) -> bpy.types.Object:
    mod = obj.modifiers.new("Mirror", "MIRROR")
    mod.use_axis = axis
    if obj_ref is not None:
        mod.mirror_object = obj_ref
    return obj


def smooth(obj: bpy.types.Object, angle_deg=35.0) -> bpy.types.Object:
    _activate(obj)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
    return obj


def flat(obj: bpy.types.Object) -> bpy.types.Object:
    _activate(obj)
    bpy.ops.object.shade_flat()
    return obj


def apply_modifiers(obj: bpy.types.Object) -> bpy.types.Object:
    _activate(obj)
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def join(objs, name: str) -> bpy.types.Object:
    """Merge parts into one object, applying modifiers first so colours survive."""
    objs = [o for o in objs if o is not None]
    for obj in objs:
        apply_modifiers(obj)
    target = objs[0]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = target
    if len(objs) > 1:
        bpy.ops.object.join()
    target.name = name
    target.data.name = name
    return target


def set_origin(obj: bpy.types.Object, point=(0.0, 0.0, 0.0)) -> bpy.types.Object:
    """Move the object's origin to a world-space point without moving geometry."""
    offset = obj.matrix_world.translation - Vector(point)
    obj.data.transform(Matrix.Translation(offset))
    obj.matrix_world.translation = Vector(point)
    return obj


def recalc_normals(obj: bpy.types.Object, inside=False) -> bpy.types.Object:
    """Make every face point outward.

    Hand-written face lists get their winding wrong sooner or later, and an
    inside-out face is not invisible -- it is lit from behind and renders as a
    solid black shard in the middle of an otherwise clean model. Rather than
    deriving the correct order for every sweep and lathe by hand, everything
    built from raw vertex data goes through this.
    """
    _activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=inside)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def merge_doubles(obj: bpy.types.Object, distance=0.0002) -> bpy.types.Object:
    _activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=distance)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def jitter(obj: bpy.types.Object, amount: float, seed: int = 0) -> bpy.types.Object:
    """Nudge every vertex by a deterministic pseudo-random offset.

    The cheap way to take the machine-made edge off a primitive.
    """
    state = seed * 2654435761 + 1
    for vert in obj.data.vertices:
        offsets = []
        for _ in range(3):
            state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
            offsets.append((state / 0xFFFFFFFF - 0.5) * 2.0 * amount)
        vert.co += Vector(offsets)
    return obj


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------
def export_glb(objs, filename: str, animated: bool = False) -> str:
    """Write ``objs`` to ``public/models/<filename>.glb``."""
    if isinstance(objs, bpy.types.Object):
        objs = [objs]
    os.makedirs(MODEL_DIR, exist_ok=True)
    path = os.path.join(MODEL_DIR, f"{filename}.glb")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
        for child in obj.children_recursive:
            child.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=not animated,
        export_yup=True,
        export_materials="EXPORT",
        export_all_vertex_colors=False,
        export_attributes=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_normals=True,
        export_tangents=False,
        export_skins=animated,
        export_animations=animated,
        export_bake_animation=animated,
        export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=False,
    )
    size = os.path.getsize(path)
    faces = sum(len(o.data.polygons) for o in objs if o.type == "MESH")
    print(f"  exported {filename}.glb  {size / 1024:.1f} KB  ({faces} faces)")
    return path


def report(objs) -> None:
    if isinstance(objs, bpy.types.Object):
        objs = [objs]
    for obj in objs:
        if obj.type == "MESH":
            print(f"    {obj.name}: {len(obj.data.vertices)}v {len(obj.data.polygons)}f")


print("kit.py loaded")
