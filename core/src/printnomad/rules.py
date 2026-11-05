"""Reglas sobre la configuración de OrcaSlicer y Bambu Studio, independientes de la impresora destino.

Qué claves son de hardware Bambu, cuáles son de enfriamiento, qué valores rechaza
OrcaSlicer, qué G-code se reemplaza… Cada regla lleva el porqué y, cuando viene del
comportamiento de un laminador, cómo se comprobó.
"""

from __future__ import annotations

import re

from .i18n import t

# Claves de proceso que Bambu Studio 2.x guarda con un valor por variante de extrusor.
VARIANT_KEY_SUFFIXES = ("_speed", "_acceleration", "_jerk")

# Claves exclusivas del hardware Bambu: se eliminan y se reportan.
BAMBU_ONLY_KEYS = frozenset({
    "head_wrap_detect_zone",
    "extruder_clearance_dist_to_rod",
    "extruder_clearance_max_radius",
    "nozzle_volume",
    "scan_first_layer",
    "thumbnail_size",
})


# Modos de asignación de filamentos a extrusores en project_settings (filament_map_mode).
# How PrintNomad chooses the slicer's assignment mode (option `map_mode`):
# compatible = automatic in the slicer (opens and slices in every Orca-based slicer),
# exact = manual (the planned assignment is enforced), slicer = manual unless the
# target slicer rejects it (data/slicers.json quirk manual_map_max_extruder).
MAP_COMPATIBLE, MAP_EXACT, MAP_BY_SLICER = "compatible", "exact", "slicer"
MAP_MODES = (MAP_COMPATIBLE, MAP_EXACT, MAP_BY_SLICER)
MAP_MODE_MANUAL = "Manual"
MAP_MODE_AUTO = "Auto For Flush"

# Enfriamiento: depende de los ventiladores de cada máquina (la Creator 5 Pro usa
# P101 turbo L+R, P2 entrada de aire, P3 filtro; Bambu usa P1 pieza, P2 auxiliar,
# P3 cámara). Siempre manda el perfil destino; lo del origen sin equivalente se quita.
COOLING_KEY = re.compile(r"fan|cooling|exhaust|air_filtration|chamber_temperatures")
# Claves de cambio de herramienta que contienen "cooling" pero no son de ventilación.
NOT_COOLING_KEYS = frozenset({
    "filament_cooling_moves", "filament_cooling_initial_speed", "filament_cooling_final_speed",
    "cooling_tube_length", "cooling_tube_retraction",
})


def is_cooling_key(key: str) -> bool:
    return key not in NOT_COOLING_KEYS and bool(COOLING_KEY.search(key))


# Process settings that belong to the printer, not to the model: calibration (elephant
# foot, XY compensation, first-layer flow), kinematics (accelerations), firmware support
# (arcs) and the user's G-code file naming. Taken from the target profile unless the
# option keep_designer_printer_settings is on.
# The purge tower is NOT here: it follows the model (decided 2026-10-30; the designer
# knows whether the colour changes need it, and other converters do the same). When the
# designer did not change it, the target profile's value applies like any other setting.
PRINTER_PROCESS_KEY = re.compile(
    r"^(elefant_foot_compensation(_layers)?|"
    r"\w*_acceleration|accel_to_decel_\w+|initial_layer_flow_ratio|xy_(contour|hole)_compensation|"
    r"enable_arc_fitting|filename_format)$")


# Project data, not preset values: kept from the source even when no profile sets them
# and the designer did not "change" them (positions, purge table, print order, which
# filament prints each feature, colours).
PROJECT_KEYS = frozenset({
    "wipe_tower_x", "wipe_tower_y", "flush_volumes_matrix", "flush_volumes_vector", "flush_multiplier",
    "first_layer_print_sequence", "other_layers_print_sequence", "other_layers_print_sequence_nums",
    "filament_colour", "default_filament_colour", "curr_bed_type",
    "wall_filament", "sparse_infill_filament", "solid_infill_filament",
    "support_filament", "support_interface_filament", "version", "name", "from",
})


def is_printer_process_key(key: str) -> bool:
    return bool(PRINTER_PROCESS_KEY.match(key))


# Ajustes de filamento del diseñador que se conservan sobre el perfil de filamento
# destino: decisiones sobre el material (temperaturas, densidad). Lo que depende del
# hardware o de la calibración de cada máquina NO se conserva: caudal volumétrico
# (hotend; un proyecto traía 50 mm³/s frente a 18 de la C5P), flow ratio, pressure
# advance y todo el enfriamiento.
DESIGNER_FILAMENT_KEEP = re.compile(r"^(nozzle_temperature(_initial_layer|_range_low|_range_high)?|"
                                    r"[a-z_]*plate_temp(_initial_layer)?|filament_density)$")


def keep_designer_filament_key(key: str, filament: bool = True, cooling: bool = False) -> bool:
    """Whether the designer's value of a filament setting is kept on the target profile.

    `filament`: material choices (temperatures, density); `cooling`: fan settings, off
    by default because fans differ between printers (see option keep_designer_cooling).
    """
    if is_cooling_key(key):
        return cooling
    return filament and bool(DESIGNER_FILAMENT_KEEP.match(key))


# Valores que OrcaSlicer rechaza o reinterpreta: valor -> valor válido.
# None = quitar la clave para que Orca use su valor por defecto.
VALUE_FIXES = {
    "raft_first_layer_expansion": {"-1": None},  # "auto" en Bambu; Orca exige >= 0
    "ensure_vertical_shell_thickness": {"enabled": "ensure_all", "disabled": "none",
                                        "1": "ensure_all", "0": "none"},
    # El perfil de Anycubic Kobra S1 Max que trae Flash Studio 1.7.20 lo define a 0 (con
    # la función desactivada) y el propio laminador lo rechaza: rango 10–18 (comprobado
    # con su CLI). Se aplica también a listas (un valor por extrusor).
    "retraction_distances_when_cut": {"0": None},
}

# Toda clave de G-code se toma del perfil destino; si no lo define, queda vacía.
GCODE_KEYS = (
    "machine_start_gcode", "machine_end_gcode", "before_layer_change_gcode",
    "layer_change_gcode", "change_filament_gcode", "time_lapse_gcode",
    "machine_pause_gcode", "template_custom_gcode", "printing_by_object_gcode",
    "change_extrusion_role_gcode", "file_start_gcode", "wrapping_detection_gcode",
)

# Comandos propios del firmware Bambu: si aparecen en un campo de texto final, se avisa.
BAMBU_GCODE_MARKERS = re.compile(r"\b(M1007|G392|M620|M621|M622|M623|M624|M625|M73\.2|M1002|M9833)\b")

# Tipos de filamento de origen que en los perfiles destino usan otro nombre de tipo
# (p. ej. Bambu "TPU" ↔ Flash Studio "TPU-95A").
TYPE_ALIASES = {
    "TPU": ("TPU-95A", "TPU-90A", "TPU-64D", "FLEX"),
    "TPU-AMS": ("TPU-95A", "TPU-64D"),
    "PLA": ("PLA", "SILK"),
    "PLA-S": ("PLA", "SILK"),
    "PETG-HF": ("PETG",),
    "PA": ("PA-CF",),
}

GENERIC_TOKENS = frozenset({"bambu", "lab", "generic", "basic", "flashforge", "polyterra",
                            "polymaker", "esun", "sunlu", "elegoo", "overture", "pla", "petg",
                            "abs", "asa", "tpu", "hf"})


# Build plates (curr_bed_type), in the slicers' order: value -> filament temperature key.
# A temperature of 0 makes the slicer refuse the filament on that plate (Print.cpp: "Plate %d:
# %s does not support filament %s").
BED_TEMP_KEYS = {
    "Cool Plate": "cool_plate_temp",
    "Engineering Plate": "eng_plate_temp",
    "High Temp Plate": "hot_plate_temp",
    "Textured PEI Plate": "textured_plate_temp",
    "Textured Cool Plate": "textured_cool_plate_temp",
    "Supertack Plate": "supertack_plate_temp",
}
BED_TYPES = tuple(BED_TEMP_KEYS)
# What the slicer uses for a printer whose plate cannot be chosen and whose profile names none
# (Preset::get_default_bed_type). Keeping the project's would print PLA at 35 °C on a printer
# that was never on a Cool Plate, and the slicer's menu is off, so nobody could change it.
FIXED_PLATE_DEFAULT = "High Temp Plate"
# The model's not_support_bed_types lists the slicers' labels, which differ from the values.
BED_LABELS = {
    "Cool Plate": ("Cool Plate", "Smooth Cool Plate"),
    "Engineering Plate": ("Engineering Plate",),
    "High Temp Plate": ("High Temp Plate", "Smooth High Temp Plate", "Smooth PEI Plate / High Temp Plate"),
    "Textured PEI Plate": ("Textured PEI Plate",),
    "Textured Cool Plate": ("Textured Cool Plate",),
    "Supertack Plate": ("Supertack Plate", "Cool Plate (SuperTack)", "Bambu Cool Plate SuperTack"),
}

# Settings choosing a filament by number for one feature; 0 = the object's own. Region
# settings can be set on the project, objects, parts and height ranges; support settings
# only count when the object prints support or a raft (Print::has_support_material).
LEGACY_REGION_FILAMENT_KEYS = frozenset({"wall_filament", "sparse_infill_filament", "solid_infill_filament"})
REGION_FILAMENT_KEYS = LEGACY_REGION_FILAMENT_KEYS | {
    "outer_wall_filament_id", "inner_wall_filament_id", "sparse_infill_filament_id",
    "internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id",
}
SUPPORT_FILAMENT_KEYS = frozenset({"support_filament", "support_interface_filament"})
WIPE_TOWER_FILAMENT_KEY = "wipe_tower_filament"
SCALAR_FILAMENT_KEYS = REGION_FILAMENT_KEYS | SUPPORT_FILAMENT_KEYS | {WIPE_TOWER_FILAMENT_KEY}


def chosen_filament(key: str, value) -> int | None:
    """The filament `key` explicitly chooses, or None when it inherits the object's.

    In the legacy keys "1" was the default and means inherit (OrcaSlicer handle_legacy
    maps it to 0): 10 of 38 real projects carry it without using filament 1 on purpose.
    """
    text = str(value).strip()
    if not text.isdigit() or int(text) == 0 or (key in LEGACY_REGION_FILAMENT_KEYS and int(text) == 1):
        return None
    return int(text)


# Line widths. OrcaSlicer takes mm or a % of the nozzle diameter (coFloatOrPercent,
# Flow::new_from_config_width); Bambu Studio only takes mm (coFloat, PrintConfig.cpp) and
# reads "100%" as 100 mm, as does QIDI Studio ("too large line width"). A value in mm means
# the same in all of them.
LINE_WIDTH_KEY = re.compile(r"^(\w+_)?line_width$")
_PERCENT = re.compile(r"^\s*(\d+(?:\.\d*)?|\.\d+)\s*%\s*$")


def percent_width_to_mm(key: str, value, nozzle: str):
    """`value` in mm if `key` is a line width given as a % of `nozzle`, else None.

    Lists (one value per variant or extruder) are converted item by item.
    """
    if not LINE_WIDTH_KEY.match(key):
        return None
    try:
        diameter = float(nozzle)
    except (TypeError, ValueError):
        return None

    def convert(item):
        match = _PERCENT.match(item) if isinstance(item, str) else None
        return f"{round(float(match.group(1)) * diameter / 100, 4):g}" if match else item

    converted = [convert(v) for v in value] if isinstance(value, list) else convert(value)
    return None if converted == value else converted


def speed_limits(machine_settings: dict) -> dict[str, float]:
    def first(key: str) -> float | None:
        v = machine_settings.get(key)
        if isinstance(v, list):
            v = v[0] if v else None
        try:
            return float(v) if v not in (None, "") else None
        except ValueError:
            return None

    limits = {
        "speed": min(x for x in (first("machine_max_speed_x"), first("machine_max_speed_y"), 1e9) if x),
        "acceleration": first("machine_max_acceleration_extruding") or 1e9,
        "travel_acceleration": first("machine_max_acceleration_travel") or 1e9,
        "max_layer_height": first("max_layer_height") or 1e9,
        "min_layer_height": first("min_layer_height") or 0.0,
    }
    return limits


def check_value(key: str, value, limits: dict[str, float]) -> str | None:
    """Mensaje de advertencia si `value` supera los límites de la impresora."""
    raw = value[0] if isinstance(value, list) and value else value
    if not isinstance(raw, str) and not isinstance(raw, (int, float)):
        return None
    text = str(raw).strip()
    if not text or text.endswith("%"):
        return None
    try:
        num = float(text)
    except ValueError:
        return None
    if key == "travel_acceleration" and num > limits["travel_acceleration"]:
        return t("limit.travel_acceleration", key=key, value=text, max=f"{limits['travel_acceleration']:g}")
    if key.endswith("_acceleration") and key != "travel_acceleration" and num > limits["acceleration"]:
        return t("limit.acceleration", key=key, value=text, max=f"{limits['acceleration']:g}")
    if key.endswith("_speed") and not key.startswith(("fan", "filament", "deretraction", "retraction", "z_hop")) \
            and "fan" not in key and num > limits["speed"]:
        return t("limit.speed", key=key, value=text, max=f"{limits['speed']:g}")
    if key == "layer_height" and not (limits["min_layer_height"] <= num <= limits["max_layer_height"]):
        return t("limit.layer_height", value=text, min=f"{limits['min_layer_height']:g}",
                 max=f"{limits['max_layer_height']:g}")
    return None
