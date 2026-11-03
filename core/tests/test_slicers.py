"""Registro de laminadores y biblioteca multi-raíz (sistema + usuario)."""

import json

import pytest

from printnomad import slicers
from printnomad.profiles import LIBRARY_VENDOR, USER_VENDOR, ProfileError, ProfileLibrary


def _w(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture
def fake_slicer(tmp_path, monkeypatch):
    """Laminador falso con dos fabricantes, biblioteca común y presets de usuario."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    app = tmp_path / "Apps" / "Fake.app"
    system = app / "profiles"
    # Mismo nombre base en dos fabricantes con contenido distinto.
    _w(system / "VendorA/machine/base.json", {"type": "machine", "name": "fdm_base", "gcode_flavor": "A"})
    _w(system / "VendorB/machine/base.json", {"type": "machine", "name": "fdm_base", "gcode_flavor": "B"})
    _w(system / "VendorB/machine/printer.json", {"type": "machine", "name": "B Printer 0.4 nozzle",
                                                  "inherits": "fdm_base", "nozzle_diameter": ["0.4"]})
    _w(system / "VendorB/process/p.json", {"type": "process", "name": "0.20 @B", "layer_height": "0.2",
                                           "compatible_printers": ["B Printer 0.4 nozzle"]})
    # Caso real (Flash Studio): fdm_filament_common existe en Flashforge (2.85 mm) y en la
    # biblioteca común (1.75 mm); "Generic PLA @System" debe heredar el de la biblioteca.
    _w(system / "VendorB/filament/common.json", {"type": "filament", "name": "fdm_filament_common",
                                                 "filament_diameter": ["2.85"]})
    _w(system / f"{LIBRARY_VENDOR}/filament/base/common.json", {"type": "filament", "name": "fdm_filament_common",
                                                               "filament_diameter": ["1.75"]})
    _w(system / f"{LIBRARY_VENDOR}/filament/pla.json", {"type": "filament", "name": "Generic PLA @System",
                                                        "inherits": "fdm_filament_common",
                                                        "filament_type": ["PLA"], "instantiation": "false"})
    _w(system / "VendorB/filament/pla.json", {"type": "filament", "name": "B PLA", "inherits": "Generic PLA @System",
                                              "compatible_printers": ["B Printer 0.4 nozzle"]})
    user = tmp_path / "home" / "Library/Fake/user/12345"
    _w(user / "machine/Mine.json", {"name": "My B", "inherits": "B Printer 0.4 nozzle", "from": "User"})
    _w(user / "process/Fine.json", {"name": "Fine", "inherits": "0.20 @B", "layer_height": "0.12", "from": "User"})
    data = tmp_path / "slicers.json"
    _w(data, {"fake": {"name": "Fake Slicer", "url_scheme": "fake", "quirks": {"manual_map_max_extruder": 2},
                       "macos": {"app": str(app), "system": ["{app}/profiles"],
                                 "user": "~/Library/Fake/user"}},
              "other": {"name": "Not on this OS", "linux": {"system": ["/nope"]}}})
    return data


def test_registry_expands_paths_and_skips_other_platforms(fake_slicer, tmp_path):
    reg = slicers.registry(fake_slicer, platform="macos")
    assert list(reg) == ["fake"]
    s = reg["fake"]
    assert s.installed and s.quirk("manual_map_max_extruder") == 2 and s.quirk("missing", 9) == 9
    assert s.system_roots == [tmp_path / "Apps/Fake.app/profiles"]
    assert s.user_root == tmp_path / "home/Library/Fake/user"
    assert [d.name for d in s.user_dirs()] == ["12345"]


def test_inheritance_resolved_within_vendor(fake_slicer):
    lib = slicers.registry(fake_slicer, platform="macos")["fake"].library()
    assert lib.resolve("machine", "B Printer 0.4 nozzle")["gcode_flavor"] == "B"   # no el de VendorA
    assert lib.resolve("filament", "B PLA")["filament_type"] == ["PLA"]            # desde la biblioteca común
    # Regresión: antes se tomaba el fdm_filament_common del fabricante (2.85 mm → subextrusión).
    assert lib.resolve("filament", "B PLA")["filament_diameter"] == ["1.75"]


def test_user_presets_inherit_and_are_compatible(fake_slicer):
    lib = slicers.registry(fake_slicer, platform="macos")["fake"].library()
    assert lib.vendors[("machine", "My B")] == USER_VENDOR
    assert lib.resolve("machine", "My B")["gcode_flavor"] == "B"
    assert lib.ancestors("machine", "My B") == ["My B", "B Printer 0.4 nozzle", "fdm_base"]
    compatible = lib.instantiable("process", ["My B", "B Printer 0.4 nozzle"])
    assert compatible == ["0.20 @B", "Fine"]       # el preset de usuario hereda la compatibilidad
    assert lib.instantiable("filament", "My B") == []   # solo el nombre propio: sin ancestros no hay
    assert lib.instantiable("filament", ["My B", "B Printer 0.4 nozzle"]) == ["B PLA"]


def test_library_without_user_presets(fake_slicer):
    lib = slicers.registry(fake_slicer, platform="macos")["fake"].library(include_user=False)
    assert not lib.has("machine", "My B")


def test_missing_profiles_raise(tmp_path):
    with pytest.raises(ProfileError):
        ProfileLibrary.from_roots([tmp_path / "nothing"])


def test_bundled_registry_is_valid():
    """El registro real se carga para todas las plataformas declaradas."""
    for platform in ("macos", "windows", "linux"):
        for s in slicers.registry(platform=platform).values():
            assert s.name and s.system_roots
