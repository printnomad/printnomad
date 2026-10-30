"""Destino: Flashforge Creator 5 Pro (4 extrusores independientes).

Solo contiene reglas propias (nombres, mapeos, límites). Los valores de los
perfiles se leen en runtime con `betterbridge.profiles`.
"""

from __future__ import annotations

import re

from ..i18n import t
from ..profiles import ProfileError, ProfileLibrary

KEY = "creator5pro"
DISPLAY_NAME = "Flashforge Creator 5 Pro"
OUTPUT_SUFFIX = "_CREATOR5_PRO"
EXTRUDERS = 4
NOZZLES = ("0.4", "0.25", "0.6", "0.8")
DEFAULT_NOZZLE = "0.4"
BED_TYPE = "Textured PEI Plate"
EXTRUDER_VARIANT = "Direct Drive Standard"
# Claves de proceso que Bambu Studio 2.x guarda con un valor por variante de extrusor.
VARIANT_KEY_SUFFIXES = ("_speed", "_acceleration", "_jerk")


def machine_name(nozzle: str) -> str:
    return f"Flashforge Creator 5 Pro {nozzle} nozzle"


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

# Máscara de extrusores en los que puede imprimirse cada filamento (bit 0 = E1).
FILAMENT_PRINTABLE_ALL = str((1 << EXTRUDERS) - 1)

# OrcaSlicer 2.5 solo respeta la asignación manual en los extrusores 1 y 2
# (lógica pensada para impresoras de dos extrusores). Flash Studio sí la respeta.
ORCA_MANUAL_MAX_EXTRUDER = 2
MAP_MODE_MANUAL = "Manual"
MAP_MODE_AUTO = "Auto For Flush"

# Enfriamiento: depende de los ventiladores de cada máquina (la Creator 5 Pro usa
# P101 turbo L+R, P2 entrada de aire, P3 filtro; Bambu usa P1 pieza, P2 auxiliar,
# P3 cámara). Siempre manda el perfil C5P; lo del origen sin equivalente se quita.
COOLING_KEY = re.compile(r"fan|cooling|exhaust|air_filtration|chamber_temperatures")
# Claves de cambio de herramienta que contienen "cooling" pero no son de ventilación.
NOT_COOLING_KEYS = frozenset({
    "filament_cooling_moves", "filament_cooling_initial_speed", "filament_cooling_final_speed",
    "cooling_tube_length", "cooling_tube_retraction",
})


def is_cooling_key(key: str) -> bool:
    return key not in NOT_COOLING_KEYS and bool(COOLING_KEY.search(key))


# Valores que OrcaSlicer rechaza o reinterpreta: valor -> valor válido.
# None = quitar la clave para que Orca use su valor por defecto.
VALUE_FIXES = {
    "raft_first_layer_expansion": {"-1": None},  # "auto" en Bambu; Orca exige >= 0
    "ensure_vertical_shell_thickness": {"enabled": "ensure_all", "disabled": "none",
                                        "1": "ensure_all", "0": "none"},
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

# Tipos de filamento de origen que en Flash Studio usan otro nombre de tipo.
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


def pick_process(lib: ProfileLibrary, machine: str, layer_height: float) -> str:
    names = lib.instantiable("process", machine)
    if not names:
        raise ProfileError(t("profiles.error.no_process", machine=machine))
    return min(names, key=lambda n: (abs(float(lib.resolve("process", n).get("layer_height", 0)) - layer_height), n))


def _tokens(text: str) -> set[str]:
    text = re.sub(r"@.*$", "", text)
    return {t for t in re.split(r"[^a-z0-9]+", text.lower()) if t}


def pick_filament(lib: ProfileLibrary, machine: str, ftype: str, source_id: str) -> str | None:
    """Perfil C5P con el mismo tipo; desempata por palabras del nombre de origen.

    Devuelve None si no hay equivalente: nunca se inventa uno.
    """
    wanted = {ftype.upper(), *TYPE_ALIASES.get(ftype.upper(), ())}
    source_tokens = _tokens(source_id) - GENERIC_TOKENS
    is_generic = "generic" in _tokens(source_id)
    best: tuple[int, str] | None = None
    for name in lib.instantiable("filament", machine):
        types = lib.resolve("filament", name).get("filament_type") or [""]
        ctype = str(types[0] if isinstance(types, list) else types).upper()
        if ctype not in wanted:
            continue
        cand = _tokens(name)
        score = 4 * len(source_tokens & cand)
        if ctype == ftype.upper():
            score += 3
        if not source_tokens:
            if "basic" in cand:
                score += 2
            if "generic" in cand and is_generic:
                score += 3
        if not cand & {"flashforge", "generic"}:
            score -= 2  # otras marcas (FusRock) solo si el nombre coincide
        if cand & {"hs", "pro", "transparent", "lw"} and not source_tokens & cand:
            score -= 1
        key = (score, name)
        if best is None or key[0] > best[0] or (key[0] == best[0] and name < best[1]):
            best = key
    return best[1] if best else None


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
