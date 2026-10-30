"""Destino: Flashforge Creator 5 Pro (4 extrusores independientes).

Solo contiene reglas propias (nombres, mapeos, límites). Los valores de los
perfiles se leen en runtime con `betterbridge.profiles`.
"""

from __future__ import annotations

import re

from ..i18n import t
from ..profiles import ProfileError, ProfileLibrary
from ..rules import GENERIC_TOKENS, TYPE_ALIASES

KEY = "creator5pro"
DISPLAY_NAME = "Flashforge Creator 5 Pro"
OUTPUT_SUFFIX = "_CREATOR5_PRO"
EXTRUDERS = 4
NOZZLES = ("0.4", "0.25", "0.6", "0.8")
DEFAULT_NOZZLE = "0.4"
BED_TYPE = "Textured PEI Plate"
EXTRUDER_VARIANT = "Direct Drive Standard"


def machine_name(nozzle: str) -> str:
    return f"Flashforge Creator 5 Pro {nozzle} nozzle"


# Máscara de extrusores en los que puede imprimirse cada filamento (bit 0 = E1).
FILAMENT_PRINTABLE_ALL = str((1 << EXTRUDERS) - 1)

# OrcaSlicer 2.5 solo respeta la asignación manual en los extrusores 1 y 2
# (lógica pensada para impresoras de dos extrusores). Flash Studio sí la respeta.
ORCA_MANUAL_MAX_EXTRUDER = 2


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
