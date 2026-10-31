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
    shared_nozzle: bool = False,
) -> FilamentAssignment:
    """`plate_usage`: filamentos (1-based) usados por placa; None = desconocido (se asumen todos).

    `shared_nozzle`: una sola boquilla con cambiador de filamento (AMS de Bambu, IFS de
    Flashforge AD5X, ACE de Anycubic): todos los filamentos van al extrusor 1 y la
    impresora los cambia sola, así que no hay límite de filamentos por placa.
    """
    n = len(filament_types)
    result = FilamentAssignment()
    all_filaments = set(range(1, n + 1))
    plates = plate_usage or {"1": None}

    if shared_nozzle:
        for plate in plates:
            result.per_plate[plate] = [1] * n
        return result

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


def _rgb(colour: str) -> tuple[int, int, int]:
    hexa = colour.lstrip("#")[:6].ljust(6, "0")
    try:
        return int(hexa[0:2], 16), int(hexa[2:4], 16), int(hexa[4:6], 16)
    except ValueError:
        return 128, 128, 128


def colour_distance(a: str, b: str) -> float:
    """Perceptual-ish RGB distance ("redmean"), enough to tell which colours look alike."""
    (r1, g1, b1), (r2, g2, b2) = _rgb(a), _rgb(b)
    rm = (r1 + r2) / 2
    return ((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2) ** 0.5


def suggest_map(
    filament_types: list[str],
    colours: list[str],
    plate_usage: dict[str, set[int] | None],
    extruders: int,
) -> dict[int, int] | None:
    """A filament → extruder assignment for projects that need one, to start from.

    Filaments are grouped until there are as many groups as extruders, always merging
    the two groups of the same material whose colours look most alike; each group gets
    one extruder (in order of the groups' first filament). Unused filaments go with the
    used filament they look most like. None when the materials alone need more extruders.
    """
    n = len(filament_types)
    used = sorted(set().union(*[u if u is not None else set(range(1, n + 1)) for u in plate_usage.values()])
                  or {1})
    material = {f: filament_types[f - 1].upper() for f in range(1, n + 1)}
    colour = {f: colours[f - 1] if f - 1 < len(colours) else "#808080" for f in range(1, n + 1)}
    groups = [[f] for f in used]

    def distance(a: list[int], b: list[int]) -> float:
        return max(colour_distance(colour[x], colour[y]) for x in a for y in b)  # complete linkage

    while len(groups) > extruders:
        pairs = [(distance(a, b), i, j) for i, a in enumerate(groups) for j, b in enumerate(groups)
                 if i < j and material[a[0]] == material[b[0]]]
        if not pairs:
            return None
        _, i, j = min(pairs)
        groups[i] = sorted(groups[i] + groups.pop(j))
    groups.sort(key=lambda g: g[0])
    mapping = {f: e for e, group in enumerate(groups, start=1) for f in group}
    for f in range(1, n + 1):
        if f not in mapping:
            same = [u for u in used if material[u] == material[f]] or used
            mapping[f] = mapping[min(same, key=lambda u: colour_distance(colour[u], colour[f]))]
    return mapping


def format_map(mapping: dict[int, int]) -> str:
    """{1: 1, 2: 2} → "1:1,2:2" (the --map syntax, see parse_map)."""
    return ",".join(f"{f}:{e}" for f, e in sorted(mapping.items()))
