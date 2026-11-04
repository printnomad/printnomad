import json

import pytest

from printnomad import rules
from printnomad.profiles import ProfileError, ProfileLibrary
from printnomad.target import Target, find_printer, load_target, output_suffix

MACHINE = "Flashforge Creator 5 Pro 0.4 nozzle"


def test_resolve_applies_inheritance_child_wins(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    m = lib.resolve("machine", MACHINE)
    assert m["gcode_flavor"] == "klipper"          # hijo pisa al padre
    assert m["machine_max_acceleration_travel"] == ["20000", "20000"]  # heredado
    assert "inherits" not in m


def test_settings_strip_profile_metadata(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    s = lib.settings("filament", "Flashforge PLA Basic @FF C5P")
    assert s["nozzle_temperature"] == ["210"]       # de OrcaFilamentLibrary
    assert "compatible_printers" not in s and "name" not in s and "instantiation" not in s


def test_misplaced_file_is_indexed_by_type(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    assert lib.has("machine", "misplaced")
    assert not lib.has("filament", "misplaced")
    # El perfil roto no impide listar los compatibles.
    assert "Generic PLA @FF C5P" in lib.instantiable("filament", MACHINE)


def test_profiles_with_utf8_bom_are_read(tmp_path):
    """Snapmaker Orca 2.4.1 saves its profiles with a BOM; they must not be skipped."""
    def write_with_bom(path, data):
        path.parent.mkdir(parents=True)
        path.write_bytes(b"\xef\xbb\xbf" + json.dumps(data).encode("utf-8"))

    system = tmp_path / "system"
    write_with_bom(system / "Snapmaker/machine/u1.json", {"type": "machine", "name": "U1", "gcode_flavor": "klipper"})
    account = tmp_path / "user" / "default"
    write_with_bom(account / "machine/mine.json", {"type": "machine", "name": "Mine", "inherits": "U1"})
    lib = ProfileLibrary.from_roots([system], [account])
    assert lib.settings("machine", "Mine")["gcode_flavor"] == "klipper"


def test_process_tie_goes_to_the_finer_one(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    target = Target(lib, MACHINE)
    lib.raw[("process", "0.12mm Standard @FF C5")] = {"type": "process", "name": "0.12mm Standard @FF C5",
                                                      "instantiation": "true", "layer_height": "0.12",
                                                      "compatible_printers": [MACHINE]}
    lib.vendors[("process", "0.12mm Standard @FF C5")] = "Flashforge"
    assert target.pick_process(0.16) == "0.12mm Standard @FF C5"


def test_missing_parent_raises(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    with pytest.raises(ProfileError):
        lib.resolve("machine", "misplaced")


def test_load_target_from_profiles_dir_and_errors(profiles_root, monkeypatch):
    target = load_target("Creator 5 Pro 0.4", profiles_dir=profiles_root)   # parte única del nombre
    assert target.machine == MACHINE and target.extruders == 4 and target.nozzle == "0.4"
    with pytest.raises(ProfileError):
        load_target("No existe", profiles_dir=profiles_root)
    with pytest.raises(ProfileError):
        load_target("x", slicer="nope")
    monkeypatch.setenv("PRINTNOMAD_PROFILES", str(profiles_root))
    assert load_target(MACHINE).machine == MACHINE


def test_target_derived_properties(profiles_root):
    target = Target(ProfileLibrary.load(profiles_root), MACHINE)
    assert target.display_name == "Flashforge Creator 5 Pro"
    assert target.vendor == "Flashforge"
    assert target.output_suffix == "_CREATOR5_PRO"
    assert target.bed_type == "Textured PEI Plate"            # del machine_model
    assert target.filament_printable_all == "15"
    assert target.nozzle_variants() == {"0.4": MACHINE, "0.6": "Flashforge Creator 5 Pro 0.6 nozzle"}
    assert target.with_nozzle("0.6").nozzle == "0.6"
    assert find_printer(target.lib, "5 Pro") is None          # ambiguo: dos coincidencias


@pytest.mark.parametrize("model,vendor,suffix", [
    ("Flashforge Creator 5 Pro", "Flashforge", "_CREATOR5_PRO"),
    ("Bambu Lab P1S", "BBL", "_BAMBU_LAB_P1S"),
    ("Creality K1 Max", "Creality", "_K1_MAX"),
    ("Prusa MK4", "Prusa", "_MK4"),
])
def test_output_suffix(model, vendor, suffix):
    assert output_suffix(model, vendor) == suffix


def test_pick_process_closest_layer_height(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    target = Target(lib, MACHINE)
    assert target.pick_process(0.2) == "0.20mm Standard @FF C5"
    assert target.pick_process(0.25) == "0.24mm Standard @FF C5"


@pytest.mark.parametrize("ftype,source,expected", [
    ("PLA", "Bambu PLA Basic @BBL A1", "Flashforge PLA Basic @FF C5P"),
    ("PLA", "Bambu PLA Matte @BBL A1", "Flashforge PLA Matte @FF C5P"),
    ("PLA", "Generic PLA @BBL A1", "Generic PLA @FF C5P"),
    ("PETG", "Bambu PETG Basic @BBL A1", "Flashforge PETG Basic @FF C5P"),
    ("PC", "Bambu PC @BBL A1", None),
])
def test_pick_filament(profiles_root, ftype, source, expected):
    lib = ProfileLibrary.load(profiles_root)
    assert Target(lib, MACHINE).pick_filament(ftype, source) == expected


def test_check_value_limits():
    limits = {"speed": 600, "acceleration": 20000, "travel_acceleration": 20000,
              "max_layer_height": 0.28, "min_layer_height": 0.08}
    assert rules.check_value("outer_wall_speed", "700", limits)
    assert rules.check_value("outer_wall_speed", "300", limits) is None
    assert rules.check_value("small_perimeter_speed", "50%", limits) is None
    assert rules.check_value("fan_max_speed", ["100"], limits) is None
    assert rules.check_value("default_acceleration", "25000", limits)
    assert rules.check_value("layer_height", "0.3", limits)


def test_inheritance_resolved_within_vendor_then_library(tmp_path):
    """Regresión: fdm_filament_common existe en Flashforge (2.85 mm) y en la biblioteca común
    (1.75 mm). "Generic PLA @System" (biblioteca) debe heredar el de la biblioteca, como en
    OrcaSlicer; antes se tomaba el primero por nombre y el filamento salía con 2.85 mm."""
    import json

    def w(rel, data):
        f = tmp_path / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(data))

    w("Flashforge/filament/common.json", {"type": "filament", "name": "fdm_filament_common",
                                          "filament_diameter": ["2.85"]})
    w("OrcaFilamentLibrary/filament/base/common.json", {"type": "filament", "name": "fdm_filament_common",
                                                        "filament_diameter": ["1.75"]})
    w("OrcaFilamentLibrary/filament/pla.json", {"type": "filament", "name": "Generic PLA @System",
                                                "inherits": "fdm_filament_common", "instantiation": "false"})
    w("Flashforge/filament/c5p.json", {"type": "filament", "name": "Flashforge PLA Basic @FF C5P",
                                       "inherits": "Generic PLA @System"})
    lib = ProfileLibrary.from_roots([tmp_path])
    assert lib.resolve("filament", "Flashforge PLA Basic @FF C5P")["filament_diameter"] == ["1.75"]


def test_most_restrictive_quirk_applies(profiles_root):
    from printnomad.slicers import Slicer
    flash = Slicer(key="flashstudio", name="Flash Studio")
    orca = Slicer(key="orcaslicer", name="OrcaSlicer", quirks={"manual_map_max_extruder": 2})
    lib = ProfileLibrary.load(profiles_root)
    assert Target(lib, MACHINE, flash).manual_map_max_extruder is None
    assert Target(lib, MACHINE, flash, (orca,)).manual_map_max_extruder == 2
    assert Target(lib, MACHINE, flash, (orca,)).with_nozzle("0.6").manual_map_max_extruder == 2


def test_compatibility_does_not_climb_system_ancestors(profiles_root):
    """El preset de sistema de la C5P hereda de otro: los perfiles del padre no son compatibles."""
    target = Target(ProfileLibrary.load(profiles_root), MACHINE)
    assert target.compatible == [MACHINE]
    assert "0.20mm Draft @AD5M" not in target.lib.instantiable("process", target.compatible)
