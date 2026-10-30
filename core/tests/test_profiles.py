import pytest

from betterbridge.printer_profiles import creator5pro as t
from betterbridge.profiles import ProfileError, ProfileLibrary, find_root

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


def test_missing_parent_raises(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    with pytest.raises(ProfileError):
        lib.resolve("machine", "misplaced")


def test_find_root_explicit_and_missing(profiles_root, tmp_path, monkeypatch):
    assert find_root(profiles_root) == profiles_root
    monkeypatch.setattr("betterbridge.profiles.DEFAULT_ROOTS", ())
    monkeypatch.delenv("BETTERBRIDGE_PROFILES", raising=False)
    with pytest.raises(ProfileError):
        find_root(tmp_path / "nada")


def test_pick_process_closest_layer_height(profiles_root):
    lib = ProfileLibrary.load(profiles_root)
    assert t.pick_process(lib, MACHINE, 0.2) == "0.20mm Standard @FF C5"
    assert t.pick_process(lib, MACHINE, 0.25) == "0.24mm Standard @FF C5"


@pytest.mark.parametrize("ftype,source,expected", [
    ("PLA", "Bambu PLA Basic @BBL A1", "Flashforge PLA Basic @FF C5P"),
    ("PLA", "Bambu PLA Matte @BBL A1", "Flashforge PLA Matte @FF C5P"),
    ("PLA", "Generic PLA @BBL A1", "Generic PLA @FF C5P"),
    ("PETG", "Bambu PETG Basic @BBL A1", "Flashforge PETG Basic @FF C5P"),
    ("PC", "Bambu PC @BBL A1", None),
])
def test_pick_filament(profiles_root, ftype, source, expected):
    lib = ProfileLibrary.load(profiles_root)
    assert t.pick_filament(lib, MACHINE, ftype, source) == expected


def test_check_value_limits():
    limits = {"speed": 600, "acceleration": 20000, "travel_acceleration": 20000,
              "max_layer_height": 0.28, "min_layer_height": 0.08}
    assert t.check_value("outer_wall_speed", "700", limits)
    assert t.check_value("outer_wall_speed", "300", limits) is None
    assert t.check_value("small_perimeter_speed", "50%", limits) is None
    assert t.check_value("fan_max_speed", ["100"], limits) is None
    assert t.check_value("default_acceleration", "25000", limits)
    assert t.check_value("layer_height", "0.3", limits)
