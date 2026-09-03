"""Turntable previews for visual QA.

Renders whatever is currently in the scene from a three-quarter view with soft
studio lighting, so every model can be eyeballed after it is built.

    exec(open(r"D:/projects/find-the-needle/tools/blender/preview.py").read())
    preview("straw")
    contact_sheet(["straw", "bale_round", "hay_cart"])
"""

import math
import os

import bpy
from mathutils import Vector

PREVIEW_DIR = os.path.join(
    r"C:/Users/AACE~1/AppData/Local/Temp/claude/D--projects-find-the-needle",
    "a35b6199-6f95-46b4-af14-79e918b0d366", "scratchpad", "previews",
)
MODEL_DIR = r"D:/projects/find-the-needle/public/models"


def _scene_bounds(objects):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo[i], world[i]) for i in range(3)))
            hi = Vector((max(hi[i], world[i]) for i in range(3)))
    if lo.x > hi.x:
        lo, hi = Vector((-1, -1, -1)), Vector((1, 1, 1))
    return lo, hi


def setup_studio(azimuth_deg=38.0, elevation_deg=24.0, margin=1.32, ground=True):
    """Frame the scene's meshes and light them for a clean product shot."""
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == "MESH"]
    lo, hi = _scene_bounds(meshes)
    centre = (lo + hi) * 0.5
    radius = max((hi - lo).length * 0.5, 0.08)

    for obj in list(scene.objects):
        if obj.type in {"CAMERA", "LIGHT"} or obj.name.startswith("__preview"):
            bpy.data.objects.remove(obj, do_unlink=True)

    if ground:
        bpy.ops.mesh.primitive_plane_add(size=radius * 40.0, location=(centre.x, centre.y, lo.z - 0.001))
        floor = bpy.context.active_object
        floor.name = "__preview_floor"
        mat = bpy.data.materials.new("__preview_floor_mat")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.57, 0.60, 1)
        mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
        floor.data.materials.append(mat)

    cam_data = bpy.data.cameras.new("__preview_cam")
    cam_data.lens = 62.0
    cam = bpy.data.objects.new("__preview_cam", cam_data)
    scene.collection.objects.link(cam)
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    distance = radius * margin * 3.1
    cam.location = centre + Vector((
        math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))) * distance
    direction = (centre - cam.location).normalized()
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    for name, offset, energy, size, colour in (
        ("key", Vector((1.1, -0.9, 1.5)), 6.0, 2.0, (1.0, 0.96, 0.88)),
        ("fill", Vector((-1.4, -0.5, 0.6)), 2.2, 3.0, (0.80, 0.87, 1.0)),
        ("rim", Vector((-0.6, 1.5, 1.1)), 3.4, 1.5, (1.0, 0.92, 0.80)),
    ):
        data = bpy.data.lights.new(f"__preview_{name}", "AREA")
        data.energy = energy * (radius * 6.0) ** 2
        data.size = size * radius
        data.color = colour
        light = bpy.data.objects.new(f"__preview_{name}", data)
        scene.collection.objects.link(light)
        light.location = centre + offset * radius * 4.0
        light.rotation_euler = (centre - light.location).normalized().to_track_quat("-Z", "Y").to_euler()

    world = scene.world or bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.30, 0.36, 0.44, 1.0)
    bg.inputs["Strength"].default_value = 0.85
    return centre, radius


def render(path, resolution=560, samples=24):
    scene = bpy.context.scene
    engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in {
        item.identifier for item in scene.bl_rna.properties["render"].fixed_type
        .bl_rna.properties["engine"].enum_items
    } else "BLENDER_EEVEE"
    try:
        scene.render.engine = engine
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    if hasattr(scene, "eevee"):
        if hasattr(scene.eevee, "taa_render_samples"):
            scene.eevee.taa_render_samples = samples
        if hasattr(scene.eevee, "use_raytracing"):
            scene.eevee.use_raytracing = True
    scene.render.resolution_x = scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX" if "AgX" in {
        i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items
    } else "Filmic"
    scene.view_settings.look = "AgX - Punchy" if scene.view_settings.view_transform == "AgX" else "None"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def preview_current(name, resolution=560, **kwargs):
    setup_studio(**kwargs)
    return render(os.path.join(PREVIEW_DIR, f"{name}.png"), resolution=resolution)


def preview_glb(name, resolution=560, **kwargs):
    """Reimport an exported .glb and render it.

    Note that Blender's glTF importer only wires the colour attribute of a
    mesh's *first* primitive into its material, so a model built from several
    surface families comes back partly white here even when the exported file is
    correct. Use `build_and_sheet` from run.py for colour QA and keep this for
    checking geometry, scale and pivots.
    """
    for obj in list(bpy.context.scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    path = os.path.join(MODEL_DIR, f"{name}.glb")
    bpy.ops.import_scene.gltf(filepath=path)
    return preview_current(name, resolution=resolution, **kwargs)


def preview_many(names, resolution=560, **kwargs):
    out = []
    for name in names:
        try:
            out.append(preview_glb(name, resolution=resolution, **kwargs))
        except Exception as exc:  # keep going; one bad model should not stop QA
            print(f"  preview failed for {name}: {exc}")
    print("\n".join(out))
    return out


def tile(rendered, out_name="sheet", cell=300, columns=None):
    """Tile already-rendered previews into a single reviewable image."""
    import math as _math

    if not rendered:
        return None
    columns = columns or min(4, len(rendered))
    rows = _math.ceil(len(rendered) / columns)
    width, height = columns * cell, rows * cell

    sheet = bpy.data.images.new(f"__sheet_{out_name}", width, height, alpha=False)
    buffer = [0.12, 0.13, 0.15, 1.0] * (width * height)

    for index, name in enumerate(rendered):
        source = bpy.data.images.load(os.path.join(PREVIEW_DIR, f"{name}.png"), check_existing=False)
        pixels = list(source.pixels)
        sw, sh = source.size
        col, row = index % columns, rows - 1 - index // columns
        for y in range(min(sh, cell)):
            src_start = y * sw * 4
            dst_start = ((row * cell + y) * width + col * cell) * 4
            span = min(sw, cell) * 4
            buffer[dst_start : dst_start + span] = pixels[src_start : src_start + span]
        bpy.data.images.remove(source)

    sheet.pixels = buffer
    path = os.path.join(PREVIEW_DIR, f"sheet_{out_name}.png")
    sheet.filepath_raw = path
    sheet.file_format = "PNG"
    sheet.save()
    bpy.data.images.remove(sheet)
    print(f"contact sheet -> {path}  ({', '.join(rendered)})")
    return path


def contact_sheet(names, out_name="sheet", cell=300, columns=None, **kwargs):
    """Render each exported .glb and tile the results. Geometry QA only."""
    rendered = []
    for name in names:
        try:
            preview_glb(name, resolution=cell, **kwargs)
            rendered.append(name)
        except Exception as exc:
            print(f"  preview failed for {name}: {exc}")
    return tile(rendered, out_name=out_name, cell=cell, columns=columns)


print("preview.py loaded -- preview_glb('straw') / contact_sheet([...])")
