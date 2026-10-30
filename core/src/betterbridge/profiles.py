"""Perfiles de destino leídos en runtime desde una instalación de Flash Studio.

No se copia ningún JSON al repositorio: se localiza el directorio `profiles`
instalado, se indexa por nombre y se resuelve la cadena `inherits`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ENV_PROFILES = "BETTERBRIDGE_PROFILES"

DEFAULT_ROOTS = (
    Path("/Applications/Flash Studio.app/Contents/Resources/profiles"),
    Path.home() / "Library/Application Support/Orca-Flashforge/system",
)

VENDOR_DIRS = ("Flashforge", "OrcaFilamentLibrary")
KINDS = ("machine", "process", "filament")

# Claves que describen el perfil en sí y no van al proyecto.
META_KEYS = frozenset({
    "type", "name", "inherits", "from", "instantiation", "setting_id",
    "is_custom_defined", "version", "compatible_printers",
    "compatible_printers_condition", "compatible_prints",
    "compatible_prints_condition", "filament_id", "description",
})


class ProfileError(Exception):
    pass


@dataclass
class ProfileLibrary:
    root: Path
    raw: dict[tuple[str, str], dict] = field(default_factory=dict)
    _cache: dict[tuple[str, str], dict] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, root: Path) -> ProfileLibrary:
        lib = cls(root=root)
        for vendor in VENDOR_DIRS:
            for kind in KINDS:
                folder = root / vendor / kind
                if not folder.is_dir():
                    continue
                for f in sorted(folder.rglob("*.json")):
                    try:
                        data = json.loads(f.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    name = data.get("name")
                    # Hay archivos guardados en la carpeta equivocada: manda el campo "type".
                    real_kind = data.get("type", kind)
                    if name and real_kind in KINDS:
                        lib.raw.setdefault((real_kind, name), data)
        if not lib.raw:
            raise ProfileError(f"no se encontraron perfiles en {root}")
        return lib

    def has(self, kind: str, name: str) -> bool:
        return (kind, name) in self.raw

    def resolve(self, kind: str, name: str) -> dict:
        """Perfil con la cadena `inherits` aplicada (padre primero)."""
        key = (kind, name)
        if key in self._cache:
            return self._cache[key]
        chain: list[dict] = []
        seen: set[str] = set()
        current: str | None = name
        while current:
            if current in seen:
                raise ProfileError(f"herencia circular en {kind} '{current}'")
            seen.add(current)
            data = self.raw.get((kind, current))
            if data is None:
                raise ProfileError(f"perfil {kind} '{current}' no encontrado (heredado por '{name}')")
            chain.append(data)
            current = data.get("inherits") or None
        merged: dict = {}
        for data in reversed(chain):
            merged.update(data)
        merged["name"] = name
        merged.pop("inherits", None)
        self._cache[key] = merged
        return merged

    def settings(self, kind: str, name: str) -> dict:
        """Solo las claves de configuración (sin metadatos del perfil)."""
        return {k: v for k, v in self.resolve(kind, name).items() if k not in META_KEYS}

    def instantiable(self, kind: str, compatible_with: str) -> list[str]:
        out = []
        for (k, name), data in self.raw.items():
            if k != kind or str(data.get("instantiation", "true")).lower() != "true":
                continue
            try:
                compatible = self.resolve(kind, name).get("compatible_printers", [])
            except ProfileError:
                continue
            if compatible_with in compatible:
                out.append(name)
        return sorted(out)


def find_root(explicit: str | Path | None = None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    if os.environ.get(ENV_PROFILES):
        candidates.append(Path(os.environ[ENV_PROFILES]))
    candidates.extend(DEFAULT_ROOTS)
    for c in candidates:
        if (c / "Flashforge").is_dir():
            return c
    tried = ", ".join(str(c) for c in candidates)
    raise ProfileError(
        f"no se encontró el directorio de perfiles de Flash Studio (probado: {tried}). "
        f"Usa --profiles-dir o la variable {ENV_PROFILES}."
    )
