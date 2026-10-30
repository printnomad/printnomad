"""Presets de laminadores leídos en runtime (sistema y usuario).

No se copia ningún JSON al repositorio: se leen las carpetas de perfiles del
laminador instalado, se indexan por nombre y se resuelve la cadena `inherits`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .i18n import t

ENV_PROFILES = "BETTERBRIDGE_PROFILES"

DEFAULT_ROOTS = (
    Path("/Applications/Flash Studio.app/Contents/Resources/profiles"),
    Path.home() / "Library/Application Support/Orca-Flashforge/system",
)

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


USER_VENDOR = "user"  # pseudo-fabricante de los presets de usuario
# Biblioteca común de filamentos de Orca y sus derivados: los perfiles de cualquier
# fabricante pueden heredar de ella (p. ej. "Generic PLA @System").
LIBRARY_VENDOR = "OrcaFilamentLibrary"


@dataclass
class ProfileLibrary:
    """Presets de un laminador (sistema + usuario), indexados por (tipo, nombre).

    Lee todas las carpetas de fabricante (las que tienen `machine/`, `process/` o
    `filament/`) de cada raíz de sistema, y los presets de usuario
    (`user/<cuenta>/<tipo>/*.json`, que heredan de un preset de sistema por nombre).
    La primera aparición de un nombre gana: el orden de las raíces es la prioridad.
    """

    roots: list[Path] = field(default_factory=list)
    raw: dict[tuple[str, str], dict] = field(default_factory=dict)
    vendors: dict[tuple[str, str], str] = field(default_factory=dict)
    # Mismo nombre en varios fabricantes (p. ej. fdm_filament_pla en Flashforge y en
    # OrcaFilamentLibrary, con contenido distinto): la herencia se resuelve primero
    # dentro del fabricante del hijo, como hace OrcaSlicer.
    by_vendor: dict[str, dict[tuple[str, str], dict]] = field(default_factory=dict)
    _cache: dict[tuple[str, str], dict] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, root: Path) -> ProfileLibrary:
        """Compatibilidad: una sola raíz de sistema."""
        return cls.from_roots([Path(root)])

    @classmethod
    def from_roots(cls, system_roots: list[Path], user_dirs: list[Path] = ()) -> ProfileLibrary:
        lib = cls(roots=[*system_roots, *user_dirs])
        for root in system_roots:
            if not root.is_dir():
                continue
            for vendor_dir in sorted(d for d in root.iterdir() if d.is_dir()):
                for kind in KINDS:
                    lib._scan(vendor_dir / kind, kind, vendor_dir.name)
        for account in user_dirs:
            for kind in KINDS:
                lib._scan(Path(account) / kind, kind, USER_VENDOR)
        if not lib.raw:
            raise ProfileError(t("profiles.error.none_found", root=", ".join(map(str, lib.roots))))
        return lib

    def _scan(self, folder: Path, kind: str, vendor: str) -> None:
        if not folder.is_dir():
            return
        for f in sorted(folder.rglob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            name = data.get("name") or (f.stem if vendor == USER_VENDOR else None)
            # Hay archivos guardados en la carpeta equivocada: manda el campo "type".
            real_kind = data.get("type", kind)
            if not name or real_kind not in KINDS:
                continue
            self.by_vendor.setdefault(vendor, {}).setdefault((real_kind, name), data)
            if (real_kind, name) not in self.raw:
                self.raw[(real_kind, name)] = data
                self.vendors[(real_kind, name)] = vendor

    def has(self, kind: str, name: str) -> bool:
        return (kind, name) in self.raw

    def names(self, kind: str) -> list[str]:
        return sorted(n for k, n in self.raw if k == kind)

    def _lookup(self, kind: str, name: str, vendor: str | None) -> tuple[dict | None, str | None]:
        """Preset `name` buscado en el fabricante dado, luego en la biblioteca común y luego en cualquiera."""
        for v in (vendor, LIBRARY_VENDOR):
            data = self.by_vendor.get(v, {}).get((kind, name)) if v else None
            if data is not None:
                return data, v
        key = (kind, name)
        return self.raw.get(key), self.vendors.get(key)

    def _chain(self, kind: str, name: str) -> list[tuple[str, dict]]:
        """[(nombre, datos)] desde `name` hasta el ancestro más lejano."""
        chain: list[tuple[str, dict]] = []
        seen: set[str] = set()
        current: str | None = name
        data, vendor = self.raw.get((kind, name)), self.vendors.get((kind, name))
        while current:
            if current in seen:
                raise ProfileError(t("profiles.error.circular", kind=kind, name=current))
            seen.add(current)
            if data is None:
                raise ProfileError(t("profiles.error.not_found", kind=kind, name=current, child=name))
            chain.append((current, data))
            current = data.get("inherits") or None
            if current:
                # Un preset de usuario hereda de uno de sistema: buscarlo en todos.
                data, vendor = self._lookup(kind, current, None if vendor == USER_VENDOR else vendor)
        return chain

    def ancestors(self, kind: str, name: str) -> list[str]:
        """`name` y los presets de los que hereda (del más cercano al más lejano)."""
        try:
            return [n for n, _ in self._chain(kind, name)]
        except ProfileError:
            return [name] if (kind, name) in self.raw else []

    def resolve(self, kind: str, name: str) -> dict:
        """Perfil con la cadena `inherits` aplicada (padre primero)."""
        key = (kind, name)
        if key in self._cache:
            return self._cache[key]
        merged: dict = {}
        for _, data in reversed(self._chain(kind, name)):
            merged.update(data)
        merged["name"] = name
        merged.pop("inherits", None)
        self._cache[key] = merged
        return merged

    def settings(self, kind: str, name: str) -> dict:
        """Solo las claves de configuración (sin metadatos del perfil)."""
        return {k: v for k, v in self.resolve(kind, name).items() if k not in META_KEYS}

    def instantiable(self, kind: str, compatible_with: str | list[str]) -> list[str]:
        """Presets elegibles compatibles con una impresora.

        `compatible_with` puede ser el nombre del preset de máquina o la lista con sus
        ancestros: un preset de usuario es compatible con lo que lo sea su preset padre.
        Nota: `compatible_printers_condition` (expresiones de Orca) aún no se evalúa.
        """
        machines = {compatible_with} if isinstance(compatible_with, str) else set(compatible_with)
        out = []
        for (k, name), data in self.raw.items():
            if k != kind or str(data.get("instantiation", "true")).lower() != "true":
                continue
            try:
                compatible = self.resolve(kind, name).get("compatible_printers", [])
            except ProfileError:
                continue
            if machines & set(compatible):
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
    raise ProfileError(t("profiles.error.root_not_found", tried=tried, env=ENV_PROFILES))
