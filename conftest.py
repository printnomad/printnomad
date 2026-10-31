"""Fixtures sintéticos: 3MF propios y pequeños + un árbol de perfiles falso."""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

import pytest

CUBE = """<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh><vertices>
  <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
  <vertex x="0" y="0" z="10"/><vertex x="10" y="0" z="10"/><vertex x="10" y="10" z="10"/><vertex x="0" y="10" z="10"/>
 </vertices><triangles>
  <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
  <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
  <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
 </triangles></mesh></object></resources>
</model>
"""


def _model_xml(items: list[tuple[str, float, float]]) -> str:
    objs = "".join(
        f'<object id="{oid}" type="model"><components>'
        f'<component p:path="/3D/Objects/object_{oid}.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'
        f"</components></object>" for oid, _, _ in items)
    build = "".join(f'<item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 {x} {y} 5" printable="1"/>'
                    for oid, x, y in items)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
            'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/1595/02">'
            '<metadata name="Application">BambuStudio-02.07.01.62</metadata>'
            f"<resources>{objs}</resources><build>{build}</build></model>\n")


def paint_code(state: int) -> str:
    """Paint code of a whole triangle painted with filament `state` (TriangleSelector format)."""
    if state < 3:
        return f"{state << 2:X}"
    if state <= 17:
        return f"{state - 3:X}C"
    return f"{state - 18:X}FC"


def make_bambu_3mf(
    path: Path,
    filaments: list[tuple[str, str, str]],
    plates: list[list[str]],
    object_extruders: dict[str, int] | None = None,
    part_overrides: dict[str, dict[str, str]] | None = None,
    bed: int = 256,
    settings: dict | None = None,
    paint: tuple[int, ...] = (),
) -> Path:
    """filaments: [(tipo, id de perfil, color)]; plates: ids de objeto por placa."""
    object_extruders = object_extruders or {}
    part_overrides = part_overrides or {}
    n = len(filaments)
    objects = [oid for plate in plates for oid in plate]
    project = {
        "printer_model": "Bambu Lab A1",
        "printer_settings_id": "Bambu Lab A1 0.4 nozzle",
        "print_settings_id": "0.20mm Standard @BBL A1",
        "nozzle_diameter": ["0.4"],
        "layer_height": "0.2",
        "initial_layer_print_height": "0.2",
        "printable_area": ["0x0", f"{bed}x0", f"{bed}x{bed}", f"0x{bed}"],
        "gcode_flavor": "marlin",
        "machine_start_gcode": "M1007 S0\nG392 S0",
        "layer_change_gcode": "M73 L{layer_num}",
        "time_lapse_gcode": "M622 J1",
        "head_wrap_detect_zone": ["226x224"],
        "outer_wall_speed": "200",
        "sparse_infill_speed": "270",
        "default_acceleration": "10000",
        "curr_bed_type": "Cool Plate",
        "filament_type": [f[0] for f in filaments],
        "filament_settings_id": [f[1] for f in filaments],
        "filament_colour": [f[2] for f in filaments],
        "filament_max_volumetric_speed": ["21"] * n,
        "different_settings_to_system": ["sparse_infill_speed"] + ["filament_max_volumetric_speed"] * n + [""],
    }
    project.update(settings or {})

    ms = ['<?xml version="1.0" encoding="UTF-8"?>', "<config>"]
    for oid in objects:
        ms.append(f'  <object id="{oid}">')
        ms.append(f'    <metadata key="name" value="obj{oid}"/>')
        ms.append(f'    <metadata key="extruder" value="{object_extruders.get(oid, 1)}"/>')
        ms.append('    <part id="1" subtype="normal_part">')
        ms.append(f'      <metadata key="name" value="part{oid}"/>')
        for k, v in part_overrides.get(oid, {}).items():
            ms.append(f'      <metadata key="{k}" value="{v}"/>')
        ms.append("    </part>")
        ms.append("  </object>")
    for i, plate in enumerate(plates, 1):
        ms.append("  <plate>")
        ms.append(f'    <metadata key="plater_id" value="{i}"/>')
        ms.append('    <metadata key="filament_map_mode" value="Auto For Flush"/>')
        ms.append(f'    <metadata key="filament_maps" value="{" ".join(["1"] * n)}"/>')
        for oid in plate:
            ms.append("    <model_instance>")
            ms.append(f'      <metadata key="object_id" value="{oid}"/>')
            ms.append('      <metadata key="instance_id" value="0"/>')
            ms.append("    </model_instance>")
        ms.append("  </plate>")
    ms.append("</config>")

    items = []
    for idx, plate in enumerate(plates):
        cols = max(1, int(-(-len(plates) ** 0.5 // 1)))
        row, col = divmod(idx, cols)
        for oid in plate:
            items.append((oid, col * bed * 1.2 + bed / 2, -row * bed * 1.2 + bed / 2))

    # Colour painting: one triangle per filament in `paint`, encoded like Bambu Studio.
    cube = CUBE
    for state in paint:  # the next unpainted triangle
        cube = re.sub(r'<triangle (v1="\d+" v2="\d+" v3="\d+")/>',
                      rf'<triangle \1 paint_color="{paint_code(state)}"/>', cube, count=1)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("3D/3dmodel.model", _model_xml(items))
        for oid in objects:
            zf.writestr(f"3D/Objects/object_{oid}.model", cube)
        zf.writestr("Metadata/project_settings.config", json.dumps(project, indent=4))
        zf.writestr("Metadata/model_settings.config", "\n".join(ms))
    return path


FAKE_PRINTER = "Flashforge Creator 5 Pro 0.4 nozzle"


def cli_target(profiles_root: Path) -> list[str]:
    """Argumentos de la CLI para convertir a la impresora del árbol de perfiles falso."""
    return ["--profiles-dir", str(profiles_root), "--printer", FAKE_PRINTER]


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture
def profiles_root(tmp_path: Path) -> Path:
    """Árbol mínimo con la misma forma que el de Flash Studio (herencia incluida)."""
    return build_profiles_tree(tmp_path)


def build_profiles_tree(tmp_path: Path) -> Path:
    """Crea el árbol de perfiles falso en `tmp_path/profiles` (también para pruebas fuera de pytest)."""
    root = tmp_path / "profiles"
    ff = root / "Flashforge"
    machine = "Flashforge Creator 5 Pro 0.4 nozzle"
    _write(ff / "machine/fdm_common.json", {
        "type": "machine", "name": "fdm_common", "instantiation": "false",
        "gcode_flavor": "marlin", "printable_height": "250",
        "machine_max_speed_x": ["500", "200"], "machine_max_speed_y": ["500", "200"],
        "machine_max_acceleration_extruding": ["20000", "20000"],
        "machine_max_acceleration_travel": ["20000", "20000"],
    })
    _write(ff / "machine/c5p.json", {
        "type": "machine", "name": machine, "inherits": "fdm_common", "instantiation": "true",
        "printer_model": "Flashforge Creator 5 Pro", "gcode_flavor": "klipper",
        "printable_area": ["0x0", "256x0", "256x256", "0x256"], "printable_height": "256",
        "nozzle_diameter": ["0.4", "0.4", "0.4", "0.4"],
        "extruder_colour": ["#FCE94F"] * 4,
        "max_layer_height": ["0.28"] * 4, "min_layer_height": ["0.08"] * 4,
        "machine_max_speed_x": ["600", "600"], "machine_max_speed_y": ["600", "600"],
        "machine_start_gcode": ";start_gcode", "layer_change_gcode": ";AFTER_LAYER_CHANGE",
        "change_filament_gcode": "",
    })
    _write(ff / "machine/model.json", {"type": "machine_model", "name": "Flashforge Creator 5 Pro",
                                        "default_bed_type": "Textured PEI Plate"})
    # Variante de boquilla del mismo modelo (para elegir boquilla).
    _write(ff / "machine/c5p06.json", {
        "type": "machine", "name": "Flashforge Creator 5 Pro 0.6 nozzle", "inherits": machine,
        "instantiation": "true", "nozzle_diameter": ["0.6", "0.6", "0.6", "0.6"],
    })
    _write(ff / "process/draft024.json", {"type": "process", "name": "0.24mm Draft @FF C5", "instantiation": "true",
                                          "compatible_printers": [machine], "layer_height": "0.24"})
    _write(ff / "process/c5p06.json", {"type": "process", "name": "0.30mm Standard @FF C5 0.6 nozzle",
                                       "instantiation": "true", "layer_height": "0.3",
                                       "compatible_printers": ["Flashforge Creator 5 Pro 0.6 nozzle"]})
    # Proceso compatible solo con el padre (AD5M): no debe ofrecerse para la C5P.
    _write(ff / "process/ad5m.json", {"type": "process", "name": "0.20mm Draft @AD5M", "instantiation": "true",
                                      "compatible_printers": ["fdm_common"], "layer_height": "0.2"})
    # Archivo de máquina guardado en la carpeta de filamentos (pasa en Flash Studio).
    _write(ff / "filament/misplaced.json", {"type": "machine", "name": "misplaced", "inherits": "nope"})
    for lh in ("0.20", "0.24"):
        _write(ff / f"process/{lh}.json", {
            "type": "process", "name": f"{lh}mm Standard @FF C5", "instantiation": "true",
            "compatible_printers": [machine], "layer_height": lh.rstrip("0") if lh != "0.20" else "0.2",
            "sparse_infill_speed": "230", "outer_wall_speed": "150", "initial_layer_print_height": "0.25",
            "enable_prime_tower": "1", "default_acceleration": "8000", "elefant_foot_compensation": "0.1",
        })
    _write(root / "OrcaFilamentLibrary/filament/base_pla.json", {
        "type": "filament", "name": "Generic PLA @System", "instantiation": "false",
        "filament_type": ["PLA"], "filament_max_volumetric_speed": ["15"], "nozzle_temperature": ["210"],
    })
    _write(root / "OrcaFilamentLibrary/filament/base_petg.json", {
        "type": "filament", "name": "Generic PETG @System", "instantiation": "false",
        "filament_type": ["PETG"], "filament_max_volumetric_speed": ["12"], "nozzle_temperature": ["240"],
    })
    for name, parent in (("Flashforge PLA Basic @FF C5P", "Generic PLA @System"),
                         ("Flashforge PLA Matte @FF C5P", "Generic PLA @System"),
                         ("Generic PLA @FF C5P", "Generic PLA @System"),
                         ("Flashforge PETG Basic @FF C5P", "Generic PETG @System")):
        _write(ff / f"filament/{name}.json", {
            "type": "filament", "name": name, "inherits": parent, "instantiation": "true",
            "compatible_printers": [machine, "Flashforge Creator 5 Pro 0.6 nozzle"], "filament_settings_id": [name],
            "filament_max_volumetric_speed": ["18"],
        })
    return root


@pytest.fixture(autouse=True)
def _spanish_messages():
    """Las aserciones de texto de las pruebas existentes están en español.

    Las pruebas de i18n (core/tests/test_i18n.py) cambian el idioma explícitamente.
    """
    from betterbridge import i18n

    i18n.set_language("es")
    yield
    i18n.set_language("es")
