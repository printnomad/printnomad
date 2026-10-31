"""Profile catalog for the browser extension: bundles load like the folders they come from."""

import importlib.util
import json
from pathlib import Path

from betterbridge.profiles import ProfileLibrary
from betterbridge.target import Target

TOOL = Path(__file__).resolve().parents[1] / "build_profile_catalog.py"
spec = importlib.util.spec_from_file_location("build_profile_catalog", TOOL)
catalog_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog_tool)

C5P = "Flashforge Creator 5 Pro 0.4 nozzle"


def test_catalog_lists_usable_printers_and_bundles(profiles_root, tmp_path):
    out = tmp_path / "out"
    entry = catalog_tool.build("flashstudio", profiles_root, "1.0.0", "abc", out)
    assert entry["repo"] == "FlashForge/Orca-Flashforge" and entry["ref"] == "1.0.0"
    ff = entry["vendors"]["Flashforge"]
    names = [p["name"] for p in ff["printers"]]
    assert C5P in names
    printer = next(p for p in ff["printers"] if p["name"] == C5P)
    assert printer["extruders"] == 4 and printer["nozzle"] == "0.4"
    assert ff["depends"] == ["OrcaFilamentLibrary"]
    bundle = json.loads((out / ff["bundle"]).read_bytes())
    assert bundle["vendor"] == "Flashforge" and bundle["ref"] == "1.0.0"
    assert all(rel.split("/")[0] in ("machine", "process", "filament") for rel in bundle["files"])
    catalog = json.loads((out / "catalog.json").read_text())
    assert catalog["schema"] == 1 and "flashstudio" in catalog["slicers"]


def test_bundles_give_the_same_library_as_folders(profiles_root, tmp_path):
    out = tmp_path / "out"
    entry = catalog_tool.build("flashstudio", profiles_root, "1.0.0", None, out)
    bundles = [json.loads((out / v["bundle"]).read_bytes()) for v in entry["vendors"].values()]
    from_bundles = ProfileLibrary.from_bundles(bundles)
    from_folders = ProfileLibrary.from_roots([profiles_root])
    for kind in ("machine", "process", "filament"):
        names = from_bundles.names(kind)
        assert names and set(names) <= set(from_folders.names(kind))
    for name in from_bundles.names("filament"):
        assert from_bundles.resolve("filament", name) == from_folders.resolve("filament", name)
    a, b = Target(from_bundles, C5P), Target(from_folders, C5P)
    assert a.settings == b.settings and a.compatible == b.compatible
    assert a.pick_process(0.2) == b.pick_process(0.2)


def test_catalog_from_an_installed_app(profiles_root, tmp_path):
    entry = catalog_tool.build("flashstudio", profiles_root, "1.7.20", None, tmp_path / "out", from_app=True)
    assert entry["repo"] is None and entry["source"] == "Flash Studio 1.7.20"
    bundles = [json.loads((tmp_path / "out" / v["bundle"]).read_bytes()) for v in entry["vendors"].values()]
    assert ProfileLibrary.from_bundles(bundles).source == "Flash Studio 1.7.20"


def test_vendor_display_name_and_covers(profiles_root, tmp_path):
    (profiles_root / "Flashforge.json").write_text(json.dumps({"name": "Flashforge", "version": "1"}))
    from PIL import Image

    Image.new("RGBA", (500, 500), "teal").save(profiles_root / "Flashforge" / "Flashforge Creator 5 Pro_cover.png")
    out = tmp_path / "out"
    ff = catalog_tool.build("flashstudio", profiles_root, "1.0.0", None, out)["vendors"]["Flashforge"]
    assert ff["name"] == "Flashforge"
    cover = out / ff["covers"]["Flashforge Creator 5 Pro"]
    assert cover.suffix == ".webp" and Image.open(cover).size == (192, 192)
