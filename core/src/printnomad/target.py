"""Impresora destino construida desde cualquier preset de máquina (sistema o usuario).

Todo lo que antes eran constantes de una impresora concreta se deduce del perfil:
extrusores (`nozzle_diameter`), boquilla, modelo, placa, variante de extrusor,
límites, procesos y filamentos compatibles, variantes de boquilla del mismo modelo.
Las particularidades del laminador (p. ej. límite de asignación manual) vienen del
registro de laminadores (data/slicers.json).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import rules
from .i18n import t
from .profiles import USER_VENDOR, ProfileError, ProfileLibrary
from .slicers import Slicer

DEFAULT_EXTRUDER_VARIANT = "Direct Drive Standard"
BAMBU_VENDOR = "BBL"  # profile folder of Bambu Lab printers


def _first(value, default=None):
    if isinstance(value, list):
        return value[0] if value else default
    return value if value not in (None, "") else default


def _tokens(text: str) -> set[str]:
    text = re.sub(r"@.*$", "", text)
    return {tok for tok in re.split(r"[^a-z0-9]+", text.lower()) if tok}


def output_suffix(printer_model: str, vendor: str | None) -> str:
    """'Flashforge Creator 5 Pro' → '_CREATOR5_PRO'; 'Bambu Lab P1S' → '_BAMBU_LAB_P1S'.

    Se quita el fabricante si el modelo empieza por él y se pega cada número a la
    palabra anterior (CREATOR 5 → CREATOR5).
    """
    words = re.findall(r"[A-Za-z0-9]+", printer_model)
    if vendor and len(words) > 1 and words[0].lower() == vendor.lower():
        words = words[1:]
    merged: list[str] = []
    for w in words:
        if merged and w.isdigit():
            merged[-1] += w
        else:
            merged.append(w)
    return "_" + "_".join(merged).upper() if merged else "_CONVERTED"


@dataclass
class Target:
    lib: ProfileLibrary
    machine: str
    slicer: Slicer | None = None
    # Otros laminadores en los que también se abrirá el resultado (p. ej. el plugin corre
    # en OrcaSlicer aunque el destino sea Flash Studio): se aplica la particularidad más
    # restrictiva de todos.
    also_open_in: tuple[Slicer, ...] = ()
    settings: dict = field(init=False, repr=False)
    compatible: list[str] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not self.lib.has("machine", self.machine):
            raise ProfileError(t("target.error.unknown_printer", name=self.machine))
        self.settings = self.lib.settings("machine", self.machine)
        self.compatible = self._compatible_names()

    def _compatible_names(self) -> list[str]:
        """Nombres con los que se buscan procesos y filamentos compatibles.

        Como OrcaSlicer: el propio preset y, si es de usuario, sus padres hasta llegar al
        primer preset de sistema (incluido). No se sube más: el preset de la C5P hereda
        del de la Adventurer 5M Pro y sus perfiles no son compatibles con la C5P.
        """
        out: list[str] = []
        for name in self.lib.ancestors("machine", self.machine):
            out.append(name)
            if self.lib.vendors.get(("machine", name)) != USER_VENDOR:
                break
        return out

    # --- datos de la máquina ------------------------------------------------
    @property
    def printer_model(self) -> str:
        return str(self.settings.get("printer_model") or self.machine)

    @property
    def display_name(self) -> str:
        return self.printer_model

    @property
    def vendor(self) -> str | None:
        """Fabricante de la carpeta de perfiles del preset de sistema (no 'user')."""
        for name in self.compatible:
            v = self.lib.vendors.get(("machine", name))
            if v and v != USER_VENDOR:
                return v
        return None

    @property
    def extruders(self) -> int:
        nozzles = self.settings.get("nozzle_diameter")
        return len(nozzles) if isinstance(nozzles, list) and nozzles else 1

    @property
    def nozzle(self) -> str:
        return str(_first(self.settings.get("nozzle_diameter"), "0.4"))

    @property
    def extruder_variant(self) -> str:
        return str(_first(self.settings.get("printer_extruder_variant"), DEFAULT_EXTRUDER_VARIANT))

    @property
    def bed_type(self) -> str | None:
        """Placa por defecto: la del preset o la del modelo (`machine_model`); None = no tocar."""
        model = self.lib.raw.get(("machine_model", self.printer_model)) or {}
        named = _first(self.settings.get("default_bed_type")) or model.get("default_bed_type")
        if not named:
            return None
        # Some profiles give the slicer's enum number (Elegoo Centauri Carbon: "4"; Preset.cpp).
        text = str(named)
        if text.isdigit():
            return rules.BED_TYPES[int(text) - 1] if 1 <= int(text) <= len(rules.BED_TYPES) else None
        return text

    @property
    def bed_types(self) -> list[str]:
        """Plates the user can choose, as the slicer offers them; empty when the plate is fixed.

        The slicer enables the choice for Bambu printers or with support_multi_bed_types
        (Plater.cpp) and hides what the model's not_support_bed_types lists.
        """
        multi = str(_first(self.settings.get("support_multi_bed_types"), "0")).strip().lower() in ("1", "true")
        if not multi and self.vendor != BAMBU_VENDOR:
            return []
        model = self.lib.raw.get(("machine_model", self.printer_model)) or {}
        hidden = model.get("not_support_bed_types") or []
        hidden = {x.strip().strip('"') for x in hidden.split(";")} if isinstance(hidden, str) else set(hidden)
        missing = (self.slicer.quirk("bed_types_missing") if self.slicer else None) or ()
        return [b for b in rules.BED_TYPES if b not in missing and not hidden & set(rules.BED_LABELS[b])]

    @property
    def shared_nozzle(self) -> bool:
        """Una boquilla con cambiador de filamento (AMS, IFS, ACE): `single_extruder_multi_material`."""
        return self.extruders == 1 and str(_first(self.settings.get("single_extruder_multi_material"), "0")) == "1"

    @property
    def filament_printable_all(self) -> str:
        """Máscara de extrusores en los que puede ir cada filamento (bit 0 = E1)."""
        return str((1 << self.extruders) - 1)

    def filament_printable_of(self, preset: str) -> str:
        """Extruder mask for a filament preset: the printer maker's own restriction when
        its system preset sets one (e.g. a flexible filament only on some extruders), else
        every extruder. User presets do not count: theirs is often the slicer default
        meant for two nozzles (3), copied when the preset was saved."""
        key = ("filament", preset)
        if preset and key in self.lib.raw and self.lib.vendors.get(key) != USER_VENDOR:
            try:
                own = _first(self.lib.resolve("filament", preset).get("filament_printable"))
            except ProfileError:
                own = None
            if str(own or "").isdigit() and 0 < int(own) & int(self.filament_printable_all):
                return str(int(own) & int(self.filament_printable_all))
        return self.filament_printable_all

    @property
    def manual_map_max_extruder(self) -> int | None:
        limits = [s.quirk("manual_map_max_extruder") for s in (self.slicer, *self.also_open_in) if s]
        limits = [x for x in limits if x is not None]
        return min(limits) if limits else None

    @property
    def output_suffix(self) -> str:
        return output_suffix(self.printer_model, self.vendor)

    @property
    def limits(self) -> dict[str, float]:
        return rules.speed_limits(self.settings)

    def is_usable(self) -> bool:
        """Perfiles completos: herencia resoluble y al menos un proceso compatible.

        Algunos laminadores traen copias incompletas de otros fabricantes (Flash Studio
        incluye presets de Creality sin su perfil base, o la Kobra Neo sin procesos).
        """
        try:
            self.lib.resolve("machine", self.machine)
            return bool(self.lib.instantiable("process", self.compatible, self.settings))
        except ProfileError:
            return False

    def is_same_printer(self, settings: dict) -> bool:
        """The project is already set up for this printer: same preset, or the same model and
        nozzle under a preset of the designer's own (e.g. "A1 Mini - No Timelapse")."""
        if settings.get("printer_settings_id") in self.compatible:
            return True
        same_model = settings.get("printer_model") == self.printer_model
        return same_model and str(_first(settings.get("nozzle_diameter"), "")) == self.nozzle

    # --- variantes de boquilla ---------------------------------------------
    def nozzle_variants(self) -> dict[str, str]:
        """{boquilla: preset de máquina} del mismo modelo; incluye siempre el propio."""
        out = {self.nozzle: self.machine}
        for name in self.lib.names("machine"):
            data = self.lib.raw[("machine", name)]
            if str(data.get("instantiation", "true")).lower() != "true" or name == self.machine:
                continue
            if self.lib.vendors.get(("machine", name)) == USER_VENDOR:
                continue  # las variantes se buscan entre presets de sistema
            try:
                s = self.lib.settings("machine", name)
            except ProfileError:
                continue
            if s.get("printer_model") == self.printer_model:
                out.setdefault(str(_first(s.get("nozzle_diameter"), "")), name)
        return dict(sorted(out.items(), key=lambda kv: float(kv[0]) if kv[0] else 0))

    def with_nozzle(self, nozzle: str) -> Target:
        variants = self.nozzle_variants()
        if nozzle not in variants:
            raise ProfileError(t("convert.error.nozzle_unavailable", nozzle=nozzle, options=", ".join(variants)))
        if variants[nozzle] == self.machine:
            return self
        return Target(self.lib, variants[nozzle], self.slicer, self.also_open_in)

    # --- procesos y filamentos ----------------------------------------------
    def pick_process(self, layer_height: float) -> str:
        names = self.lib.instantiable("process", self.compatible, self.settings)
        if not names:
            raise ProfileError(t("profiles.error.no_process", machine=self.machine))

        default = _first(self.settings.get("default_print_profile"))

        def key(name: str):
            lh = float(self.lib.resolve("process", name).get("layer_height", 0) or 0)
            user = self.lib.vendors.get(("process", name)) == USER_VENDOR
            # A igual altura de capa: el de sistema y, entre ellos, el "Standard" (no "Draft",
            # "Fine", "Strength"…, que cambian otros ajustes); si no hay, el que propone el perfil
            # de la impresora. "Soluble" pide un filamento de soporte que quizá no hay.
            lowered = name.lower()
            standard = "standard" in lowered
            # Rounded: 0.12 and 0.20 are equally near 0.16, whatever the floats say (the name decides).
            return (round(abs(lh - layer_height), 6), user, not standard, name != default, "soluble" in lowered, name)

        return min(names, key=key)

    def pick_filament(self, ftype: str, source_id: str) -> str | None:
        """Perfil compatible del mismo tipo; desempata por palabras del nombre de origen.

        Devuelve None si no hay equivalente: nunca se inventa uno.
        """
        wanted = {ftype.upper(), *rules.TYPE_ALIASES.get(ftype.upper(), ())}
        source_tokens = _tokens(source_id) - rules.GENERIC_TOKENS
        is_generic = "generic" in _tokens(source_id)
        own_brand = _tokens(self.printer_model.split(" ")[0]) | ({self.vendor.lower()} if self.vendor else set())
        best: tuple[int, str] | None = None
        # The printer's own profiles first; the common library only when they have no such material.
        for names in (self.lib.instantiable("filament", self.compatible, self.settings), self.lib.library_filaments()):
            for name in names:
                types = self.lib.resolve("filament", name).get("filament_type") or [""]
                ctype = str(_first(types, "")).upper()
                if ctype not in wanted:
                    continue
                cand = _tokens(name)
                # A support material has the type of what it supports: only for a project using one.
                if "support" in cand and "support" not in source_tokens:
                    continue
                score = 4 * len(source_tokens & cand)
                if ctype == ftype.upper():
                    score += 3
                if not source_tokens:
                    if "basic" in cand:
                        score += 2
                    if "generic" in cand and is_generic:
                        score += 3
                if not cand & (own_brand | {"generic"}):
                    score -= 2  # otras marcas solo si el nombre coincide
                if cand & {"hs", "pro", "transparent", "lw"} and not source_tokens & cand:
                    score -= 1
                if self.lib.vendors.get(("filament", name)) == USER_VENDOR:
                    score += 10 if name == source_id else -1   # preset propio del usuario: solo si es el mismo
                if best is None or score > best[0] or (score == best[0] and name < best[1]):
                    best = (score, name)
            if best:
                break
        return best[1] if best else None


def find_printer(lib: ProfileLibrary, query: str) -> str | None:
    """Preset de máquina por nombre exacto o, si es único, por coincidencia parcial."""
    if lib.has("machine", query):
        return query
    q = query.lower()
    matches = [n for n in lib.names("machine")
               if q in n.lower() and str(lib.raw[("machine", n)].get("instantiation", "true")).lower() == "true"]
    return matches[0] if len(matches) == 1 else None


def load_target(printer: str, slicer: str | None = None, profiles_dir: str | None = None) -> Target:
    """Destino a partir del nombre (o parte única del nombre) de un preset de máquina.

    - `profiles_dir` (o la variable PRINTNOMAD_PROFILES): carpeta de perfiles explícita.
    - `slicer`: clave del registro (p. ej. "flashstudio").
    - Ninguno: se busca en los laminadores instalados, en el orden del registro.
    """
    import os
    from pathlib import Path

    from .profiles import ENV_PROFILES
    from .slicers import installed_slicers, registry

    profiles_dir = profiles_dir or os.environ.get(ENV_PROFILES)
    if profiles_dir:
        candidates = [(None, ProfileLibrary.from_roots([Path(profiles_dir)]))]
    elif slicer:
        known = registry()
        if slicer not in known:
            raise ProfileError(t("target.error.unknown_slicer", slicer=slicer, options=", ".join(known)))
        candidates = [(known[slicer], known[slicer].library())]
    else:
        candidates = []
        for s in installed_slicers():
            try:
                candidates.append((s, s.library()))
            except ProfileError:
                continue  # laminador sin perfiles legibles (p. ej. OrcaSlicer 2.5 sin presets de usuario)
    for s, lib in candidates:
        name = find_printer(lib, printer)
        if name:
            return Target(lib, name, s)
    raise ProfileError(t("target.error.unknown_printer", name=printer))
