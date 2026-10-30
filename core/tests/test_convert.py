import json
import xml.etree.ElementTree as ET

import pytest

from betterbridge import read_3mf
from betterbridge.convert import convert
from betterbridge.model_edit import meta
from betterbridge.profiles import ProfileLibrary
from betterbridge.slicers import Slicer
from betterbridge.target import Target
from conftest import make_bambu_3mf

# Particularidad de OrcaSlicer 2.5 (registro de laminadores): manual solo en E1–E2.
ORCA = Slicer(key="orcaslicer", name="OrcaSlicer", quirks={"manual_map_max_extruder": 2})

PLA = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")
PLA_MATTE = ("PLA", "Bambu PLA Matte @BBL A1", "#00FF00")
PETG = ("PETG", "Bambu PETG Basic @BBL A1", "#0000FF")
PC = ("PC", "Bambu PC @BBL A1", "#FFFFFF")


@pytest.fixture
def lib(profiles_root):
    return ProfileLibrary.load(profiles_root)


MACHINE = "Flashforge Creator 5 Pro 0.4 nozzle"


def run(lib, path, slicer=ORCA, **kw):
    project = read_3mf.load(path)
    result = convert(project, Target(lib, MACHINE, slicer), **kw)
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS]) if result.report.ok else None
    return project, result, settings


def test_printer_fields_replaced(lib, tmp_path):
    _, result, s = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]]))
    assert result.report.ok, result.report.errors
    assert s["printer_model"] == "Flashforge Creator 5 Pro"
    assert s["printer_settings_id"] == "Flashforge Creator 5 Pro 0.4 nozzle"
    assert s["printable_area"] == ["0x0", "256x0", "256x256", "0x256"]
    assert s["nozzle_diameter"] == ["0.4"] * 4
    assert s["gcode_flavor"] == "klipper"
    assert s["machine_start_gcode"] == ";start_gcode"
    assert s["layer_change_gcode"] == ";AFTER_LAYER_CHANGE"
    assert s["print_settings_id"] == "0.20mm Standard @FF C5"
    changed = {c.key for c in result.report.changed}
    assert {"printer_model", "gcode_flavor", "machine_start_gcode"} <= changed


def test_bambu_specifics_removed_and_reported(lib, tmp_path):
    _, result, s = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]]))
    assert "head_wrap_detect_zone" not in s   # el perfil destino de prueba no la define
    assert s["time_lapse_gcode"] == ""  # el destino no lo define
    assert s["curr_bed_type"] == "Textured PEI Plate"
    assert "head_wrap_detect_zone" in {d.key for d in result.report.dropped}
    assert not any("M1007" in w or "G392" in w for w in result.report.warnings)


def test_value_fixes_for_orca(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]],
                          settings={"raft_first_layer_expansion": "-1",
                                    "ensure_vertical_shell_thickness": "enabled"},
                          part_overrides={"2": {"ensure_vertical_shell_thickness": "enabled"}})
    _, result, s = run(lib, path)
    assert "raft_first_layer_expansion" not in s
    assert s["ensure_vertical_shell_thickness"] == "ensure_all"
    o = [o for o in result.report.object_overrides if o.key == "ensure_vertical_shell_thickness"]
    assert o and o[0].final == "ensure_all"


def test_author_process_override_kept_and_limits_warned(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]],
                          settings={"sparse_infill_speed": "700", "line_width": "0.42"})
    _, result, s = run(lib, path)
    assert s["sparse_infill_speed"] == "700"          # ajuste del autor, sin cambio silencioso
    assert s["outer_wall_speed"] == "150"             # no tocado por el autor: perfil C5P
    assert s["initial_layer_print_height"] == "0.2"   # del proyecto: objetos finos
    assert any(c.key == "initial_layer_print_height" for c in result.report.kept_author)
    assert any(c.key == "sparse_infill_speed" for c in result.report.kept_author)
    assert any("sparse_infill_speed=700" in w for w in result.report.warnings)
    # 700 mm/s × 0.42 × 0.2 = 58.8 mm³/s > 18: nota (el slicer limita solo), no advertencia
    assert any("sparse_infill_speed 700 mm/s (~239 mm/s reales)" in n for n in result.report.notes)
    assert not any("mm³/s" in w for w in result.report.warnings)


def test_filament_profiles_and_author_filament_overrides_reported(lib, tmp_path):
    _, result, s = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA, PLA_MATTE, PETG], [["2"]],
                                           object_extruders={"2": 3}))
    assert s["filament_settings_id"] == [
        "Flashforge PLA Basic @FF C5P", "Flashforge PLA Matte @FF C5P", "Flashforge PETG Basic @FF C5P"]
    assert s["filament_max_volumetric_speed"] == ["18", "18", "18"]
    assert s["filament_colour"] == ["#FF0000", "#00FF00", "#0000FF"]
    assert s["filament_map"] == ["1", "2", "3"]
    assert s["extruder_colour"][:3] == ["#FF0000", "#00FF00", "#0000FF"]
    assert s["filament_printable"] == ["15"] * 3
    # E3 en uso sin --map: modo automático (Orca rechaza el manual en E3/E4).
    assert s["filament_map_mode"] == "Auto For Flush"
    assert any("modo automático" in w for w in result.report.warnings)
    dropped = [d for d in result.report.dropped if d.key.startswith("filament_max_volumetric_speed")]
    assert len(dropped) == 3 and dropped[0].original == "21"


def test_unknown_filament_used_is_error(lib, tmp_path):
    _, result, _ = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA, PC], [["2"]],
                                           object_extruders={"2": 2}))
    assert not result.report.ok
    assert any("PC" in e and "equivalente" in e for e in result.report.errors)
    assert not result.files


def test_unknown_filament_unused_is_warning(lib, tmp_path):
    _, result, s = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA, PC], [["2"]]))
    assert result.report.ok
    assert s["filament_settings_id"][1] == "Bambu PC @BBL A1"
    assert any("PC" in w for w in result.report.warnings)


def test_object_overrides_reported_one_by_one(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2", "3"]],
                          part_overrides={"2": {"inner_wall_speed": "300", "sparse_infill_density": "10%"},
                                          "3": {"outer_wall_speed": "900"}})
    _, result, _ = run(lib, path)
    ov = {(o.object, o.key): o for o in result.report.object_overrides}
    assert ov[("obj2", "inner_wall_speed")].final == "300"
    assert ov[("obj2", "sparse_infill_density")].reason == "conservado"
    assert "ADVERTENCIA" in ov[("obj3", "outer_wall_speed")].reason
    ms = ET.fromstring(result.files[read_3mf.MODEL_SETTINGS])
    part = ms.find("object[@id='3']/part")
    assert meta(part)["outer_wall_speed"] == "900"


def test_more_than_four_filaments(lib, tmp_path):
    fil = [PLA] * 5
    # Cada placa usa pocos: se asigna por placa sin --map.
    path = make_bambu_3mf(tmp_path / "a.3mf", fil, [["2"], ["3"]], object_extruders={"2": 5, "3": 4})
    _, result, _ = run(lib, path)
    assert result.report.ok
    ms = ET.fromstring(result.files[read_3mf.MODEL_SETTINGS])
    maps = [meta(p)["filament_maps"] for p in ms.findall("plate")]
    assert maps[0].split()[4] == "1" and maps[1].split()[3] == "1"
    assert all(meta(p)["filament_map_mode"] == "Manual" for p in ms.findall("plate"))

    # Pintura de color: uso desconocido, hace falta --map.
    painted = make_bambu_3mf(tmp_path / "b.3mf", fil, [["2"]], paint=True)
    _, result, _ = run(lib, painted)
    assert not result.report.ok and result.report.needs_map
    _, result, s = run(lib, painted, user_map={1: 1, 2: 2, 3: 3, 4: 4, 5: 1})
    assert result.report.ok
    assert s["filament_map"] == ["1", "2", "3", "4", "1"]
    assert s["filament_map_mode"] == "Manual"         # --map explícito se respeta
    assert any("comparten el extrusor 1" in w for w in result.report.warnings)
    assert any("Flash Studio lo acepta" in w for w in result.report.warnings)


def test_recenter_items_for_smaller_source_bed(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"], ["3"]], bed=180)
    project, result, _ = run(lib, path)
    model = result.files[read_3mf.MODEL_FILE].decode()
    # placa 1: centro 90 -> 128; placa 2 (columna 1): 180*1.2+90 -> 256*1.2+128
    assert 'transform="1 0 0 0 1 0 0 0 1 128 128 5"' in model
    assert "435.2 128 5" in model
    assert len(result.report.positions) == 2


def test_same_bed_keeps_model_file(lib, tmp_path):
    _, result, _ = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]]))
    assert read_3mf.MODEL_FILE not in result.files


def test_project_already_for_target_rejected(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]],
                          settings={"printer_model": "Flashforge Creator 5 Pro", "printer_settings_id": MACHINE})
    _, result, _ = run(lib, path)
    assert not result.report.ok and "Creator 5 Pro" in result.report.errors[0]


def test_flashforge_source_can_be_converted_to_another_nozzle_variant(lib, tmp_path):
    """Un proyecto de Flashforge ya no se rechaza por ser Flashforge, sino por ser la misma impresora."""
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]],
                          settings={"printer_model": "Flashforge Adventurer 5M", "printer_settings_id": "AD5M"})
    _, result, s = run(lib, path)
    assert result.report.ok and s["printer_model"] == "Flashforge Creator 5 Pro"


def test_nozzle_variant_selected_from_source(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]], settings={"nozzle_diameter": ["0.6"]})
    _, result, s = run(lib, path)
    assert result.report.presets["machine"] == "Flashforge Creator 5 Pro 0.6 nozzle"
    assert s["nozzle_diameter"] == ["0.6"] * 4
    _, result, _ = run(lib, path, nozzle="0.8")
    assert not result.report.ok and "0.8" in result.report.errors[0]


def test_prusa_source_basic(lib, tmp_path):
    import zipfile

    from conftest import CUBE
    path = tmp_path / "prusa.3mf"
    ini = "\n".join([
        "; generated by PrusaSlicer 2.8.1",
        "; printer_model = MK4",
        "; nozzle_diameter = 0.4",
        "; layer_height = 0.2",
        "; fill_density = 20%",
        "; filament_type = PLA;PETG",
        "; filament_colour = #FF0000;#00FF00",
        '; filament_settings_id = "Prusament PLA";"Prusament PETG"',
        "; bed_shape = 0x-4,250x-4,250x210,0x210",
    ])
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("3D/3dmodel.model", CUBE)
        zf.writestr("Metadata/Slic3r_PE.config", ini)
    _, result, s = run(lib, path)
    assert result.report.source_kind == "prusa"
    assert result.report.ok, result.report.errors
    assert s["printer_model"] == "Flashforge Creator 5 Pro"
    assert s["filament_settings_id"] == ["Flashforge PLA Basic @FF C5P", "Flashforge PETG Basic @FF C5P"]
    assert s["sparse_infill_density"] == "20%"
    assert read_3mf.PROJECT_SETTINGS in result.files


def test_bambu2_per_variant_values_collapsed(lib, tmp_path):
    # Bambu Studio 2.x: un valor por variante [Standard, High Flow].
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]], settings={
        "print_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow"],
        "print_extruder_id": ["1", "1"],
        "sparse_infill_speed": ["300", "370"],
        "inner_wall_speed": ["250", "350"],
        "different_settings_to_system": ["sparse_infill_speed", "", ""],
    })
    _, result, s = run(lib, path)
    assert s["sparse_infill_speed"] == "300"   # ajuste del autor, variante estándar
    assert s["inner_wall_speed"] == "250"
    assert s["print_extruder_variant"] == ["Direct Drive Standard"]
    assert s["print_extruder_id"] == ["1"]


def test_cooling_always_from_target(lib, tmp_path):
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]], settings={
        "fan_direction": "left",                      # Bambu, sin equivalente C5P
        "close_additional_fan_first_x_layers": ["1"],
        "ironing_fan_speed": ["-1"],
        "cooling_tube_length": "5",                   # no es ventilación: se queda
        "different_settings_to_system": ["sparse_infill_speed;ironing_fan_speed", "", ""],
    })
    _, result, s = run(lib, path)
    for k in ("fan_direction", "close_additional_fan_first_x_layers", "ironing_fan_speed"):
        assert k not in s
        assert any(d.key == k and "enfriamiento" in d.reason for d in result.report.dropped)
    assert s["cooling_tube_length"] == "5"
    assert not any(c.key == "ironing_fan_speed" for c in result.report.kept_author)


def test_bambu_only_key_kept_when_target_defines_it(lib, tmp_path, profiles_root):
    import json as _json
    f = profiles_root / "Flashforge/machine/c5p.json"
    d = _json.loads(f.read_text())
    d["nozzle_volume"] = ["0"] * 4
    f.write_text(_json.dumps(d))
    lib2 = ProfileLibrary.load(profiles_root)
    _, result, s = run(lib2, make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]], settings={"nozzle_volume": "92"}))
    assert s["nozzle_volume"] == ["0"] * 4
    assert not any(d.key == "nozzle_volume" for d in result.report.dropped)



def test_manual_extruder_map_kept_when_slicer_has_no_limit(lib, tmp_path):
    """Flash Studio respeta la asignación manual en E3/E4: sin la particularidad de Orca, se queda manual."""
    _, result, s = run(lib, make_bambu_3mf(tmp_path / "a.3mf", [PLA, PLA_MATTE, PETG], [["2"]]), slicer=None)
    assert s["filament_map_mode"] == "Manual" and s["filament_map"] == ["1", "2", "3"]
    assert not any("modo automático" in w for w in result.report.warnings)



def test_designer_filament_temperatures_kept_hardware_settings_not(lib, tmp_path):
    """Temperaturas y densidad del diseñador se conservan; caudal y enfriamiento, del destino."""
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA, PLA], [["2"]], object_extruders={"2": 2}, settings={
        "nozzle_temperature": ["200", "230"],
        "filament_max_volumetric_speed": ["21", "50"],
        "fan_max_speed": ["100", "100"],
        "different_settings_to_system": ["", "", "nozzle_temperature;filament_max_volumetric_speed;fan_max_speed", ""],
    })
    _, result, s = run(lib, path)
    assert s["nozzle_temperature"] == ["210", "230"]           # filamento 2: el del diseñador
    assert s["filament_max_volumetric_speed"] == ["18", "18"]  # hardware: el del destino
    assert s["different_settings_to_system"][2] == "nozzle_temperature"
    kept = {c.key for c in result.report.kept_author}
    dropped = {d.key for d in result.report.dropped}
    assert "nozzle_temperature[filamento 2]" in kept
    assert "filament_max_volumetric_speed[filamento 2]" in dropped

    _, _, s = run(lib, path, keep_designer_filament=False)
    assert s["nozzle_temperature"] == ["210", "210"]
