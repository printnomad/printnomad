"""Asignación de filamentos del proyecto a los extrusores físicos del destino.

Los filamentos no se fusionan ni se reordenan: los índices de filamento siguen
siendo los del proyecto (la pintura de color vive en `3D/Objects/*.model` y no
se toca). Solo cambia a qué extrusor va cada filamento, por placa.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .i18n import t


class MapError(ValueError):
    pass


@dataclass
class FilamentAssignment:
    # placa -> lista de extrusores (1-based), un valor por filamento
    per_plate: dict[str, list[int]] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    needs_map: bool = False  # hay placas con más filamentos que extrusores: asignación manual

    def global_map(self, count: int) -> list[int]:
        if not self.per_plate:
            return [1] * count
        return next(iter(self.per_plate.values()))


def parse_map(text: str) -> dict[int, int]:
    """`"1:1,2:2,5:1"` -> {1: 1, 2: 2, 5: 1}."""
    out: dict[int, int] = {}
    for chunk in filter(None, (c.strip() for c in text.split(","))):
        src, sep, dst = chunk.partition(":")
        if not sep:
            raise MapError(t("map.error.entry_format", entry=chunk))
        try:
            f, e = int(src), int(dst)
        except ValueError:
            raise MapError(t("map.error.entry_numbers", entry=chunk)) from None
        if f in out:
            raise MapError(t("map.error.repeated", filament=f))
        out[f] = e
    return out


def assign(
    filament_types: list[str],
    plate_usage: dict[str, set[int] | None],
    extruders: int,
    user_map: dict[int, int] | None = None,
) -> FilamentAssignment:
    """`plate_usage`: filamentos (1-based) usados por placa; None = desconocido (se asumen todos)."""
    n = len(filament_types)
    result = FilamentAssignment()
    all_filaments = set(range(1, n + 1))
    plates = plate_usage or {"1": None}

    if user_map is not None:
        missing = sorted(all_filaments - set(user_map))
        extra = sorted(set(user_map) - all_filaments)
        if missing:
            result.errors.append(t("map.error.missing", filaments=missing))
        if extra:
            result.errors.append(t("map.error.unknown", filaments=extra, count=n))
        bad = sorted(f for f, e in user_map.items() if not 1 <= e <= extruders)
        if bad:
            result.errors.append(t("map.error.out_of_range", extruders=extruders, filaments=bad))
        if result.errors:
            return result
        by_extruder: dict[int, list[int]] = {}
        for f, e in sorted(user_map.items()):
            by_extruder.setdefault(e, []).append(f)
        for e, fs in by_extruder.items():
            types = {filament_types[f - 1].upper() for f in fs}
            if len(types) > 1:
                result.errors.append(t("map.error.mixed_types", extruder=e, types=sorted(types), filaments=fs))
        if result.errors:
            return result
        mapping = [user_map[f] for f in range(1, n + 1)]
        for plate, used in plates.items():
            used = all_filaments if used is None else used
            shared: dict[int, list[int]] = {}
            for f in sorted(used):
                shared.setdefault(mapping[f - 1], []).append(f)
            for e, fs in shared.items():
                if len(fs) > 1:
                    result.warnings.append(t("map.warn.shared_extruder", plate=plate, filaments=fs, extruder=e))
            result.per_plate[plate] = list(mapping)
        return result

    if n <= extruders:
        identity = list(range(1, n + 1))
        for plate in plates:
            result.per_plate[plate] = list(identity)
        return result

    preferred: dict[int, int] = {}
    for plate, used in plates.items():
        used_set = all_filaments if used is None else set(used)
        if len(used_set) > extruders:
            detail = t("map.error.usage_unknown") if used is None else ""
            result.errors.append(t("map.error.too_many", plate=plate, count=len(used_set),
                                   filaments=sorted(used_set), extruders=extruders, detail=detail))
            result.needs_map = True
            continue
        taken: dict[int, int] = {}
        pending = []
        for f in sorted(used_set):
            e = preferred.get(f)
            if e and e not in taken.values():
                taken[f] = e
            else:
                pending.append(f)
        for f in pending:
            e = next(x for x in range(1, extruders + 1) if x not in taken.values())
            taken[f] = e
            preferred.setdefault(f, e)
        result.per_plate[plate] = [taken.get(f, preferred.get(f, 1)) for f in range(1, n + 1)]
    return result
