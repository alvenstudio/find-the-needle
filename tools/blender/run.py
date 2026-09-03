"""Asset build runner.

From Blender::

    exec(open(r"D:/projects/find-the-needle/tools/blender/run.py").read())
    build("hay")          # one module
    build_everything()    # the whole library

Each asset module is executed in a namespace pre-populated with ``kit`` so the
modelling helpers read as bare functions inside the asset scripts.
"""

import os
import traceback

BLENDER_DIR = r"D:/projects/find-the-needle/tools/blender"
ASSET_DIR = os.path.join(BLENDER_DIR, "assets")

MODULES = [
    "hay",
    "nature",
    "farm",
    "structures",
    "animals",
    "tools",
    "treasures",
    "kiosks",
]


def _kit_namespace():
    path = os.path.join(BLENDER_DIR, "kit.py")
    ns = {"__name__": "kit", "__file__": path}
    exec(compile(open(path, encoding="utf-8").read(), path, "exec"), ns)
    return ns


def build(module_name, only=None):
    """Run one asset module. ``only`` restricts it to a single builder key."""
    path = os.path.join(ASSET_DIR, f"{module_name}.py")
    if not os.path.exists(path):
        print(f"[skip] {module_name} (no {path})")
        return
    ns = _kit_namespace()
    ns["__name__"] = module_name
    ns["__file__"] = path
    exec(compile(open(path, encoding="utf-8").read(), path, "exec"), ns)
    builders = ns.get("BUILDERS", {})
    if only:
        keys = [only] if isinstance(only, str) else list(only)
    else:
        keys = list(builders)
    for key in keys:
        ns["clear_scene"]()
        print(f"[{module_name}] {key}")
        builders[key]()
    return ns


def build_everything():
    ok, failed = [], []
    for module_name in MODULES:
        try:
            if build(module_name) is not None:
                ok.append(module_name)
        except Exception:
            failed.append(module_name)
            traceback.print_exc()
    print(f"\nbuilt: {', '.join(ok) or 'none'}")
    if failed:
        print(f"FAILED: {', '.join(failed)}")


print("run.py loaded -- call build('hay') or build_everything()")
