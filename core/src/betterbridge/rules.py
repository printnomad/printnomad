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

# Ajustes de proceso que se toman del proyecto original aunque el autor no los
# haya cambiado, con la clave i18n del motivo que va al reporte.
KEEP_SOURCE_PROCESS_KEYS = {
    # Orca corta la primera capa a media altura: con una primera capa más alta,
    # los objetos muy finos (logos de una capa) desaparecen.
    "initial_layer_print_height": "reason.first_layer",  # clave del catálogo i18n
}

# Modos de asignación de filamentos a extrusores en project_settings (filament_map_mode).
# How BetterBridge chooses the slicer's assignment mode (option `map_mode`):
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


# Process settings that belong to the printer, not to the model: purge/prime tower
# (a tool changer needs it to prime the next head; the C5P cools idle heads by 80 °C),
# calibration (elephant foot, XY compensation, first-layer flow), kinematics
# (accelerations), firmware support (arcs) and the user's G-code file naming. Taken
# from the target profile unless the option keep_designer_printer_settings is on.
# Tower positions (wipe_tower_x/y) are per project and stay.
PRINTER_PROCESS_KEY = re.compile(
    r"^(enable_prime_tower|prime_tower_\w+|prime_volume|wipe_tower_(?!x$|y$)\w+|"
    r"flush_into_(infill|objects|support)|elefant_foot_compensation(_layers)?|"
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
