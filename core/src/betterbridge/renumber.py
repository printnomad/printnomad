"""Renumber a project's filaments: drop the unused ones and merge those sharing an extruder.

A converted project should list the filaments it really prints, one per extruder when
the user merged colours (12 designer colours on 4 extruders → 4 filaments). Every
place that names a filament by its number is rewritten: per-filament settings, the purge
table, object and part filaments, plate maps, per-layer colour changes and the colour
painting of every triangle. Meshes are not touched: only paint attribute values change
inside the geometry files, and each rewritten paint code is checked to keep its tree and
to map exactly to the new numbers.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field

from . import model_edit
from .read_3mf import CUSTOM_GCODE_PER_LAYER, MODEL_SETTINGS, PROJECT_SETTINGS, Entry, Project3MF

# Settings naming one filament by number (0 = the object's own).
SCALAR_FILAMENT_KEYS = frozenset({
    "wall_filament", "sparse_infill_filament", "solid_infill_filament",
    "support_filament", "support_interface_filament", "wipe_tower_filament",
})
# Lists of [process, filament 1…n, machine].
PRESET_GROUP_KEYS = frozenset({"different_settings_to_system", "inherits_group"})
# Plate metadata with one value per filament.
PLATE_FILAMENT_KEYS = ("filament_maps", "filament_volume_maps")


class RenumberError(Exception):
    pass


@dataclass
class Renumbering:
    """New filament i (1-based) is `reps[i - 1]` of the source; `merged[i]` its source filaments."""

    reps: list[int]
    new_of: dict[int, int]
    merged: dict[int, list[int]] = field(default_factory=dict)
    removed: list[int] = field(default_factory=list)
    # Assignment for the renumbered project (new filament → extruder), when the user chose one.
    user_map: dict[int, int] | None = None

    @property
    def changes(self) -> bool:
        return bool(self.removed or any(len(v) > 1 for v in self.merged.values()))


def plan(count: int, used: set[int], user_map: dict[int, int] | None) -> Renumbering | None:
    """The renumbering for a project of `count` filaments, or None when nothing changes.

    Without `user_map`, unused filaments are dropped. With it, the used filaments sent to
    the same extruder become one filament (numbered by extruder, keeping the first one's
    settings and colour).
    """
    used = {f for f in used if 1 <= f <= count}
    if not used:
        return None
    if user_map:
        groups: dict[int, list[int]] = {}
        for f in sorted(used):
            groups.setdefault(user_map[f], []).append(f)
        order = sorted(groups)
        merged = {new: groups[e] for new, e in enumerate(order, start=1)}
        result = Renumbering(
            reps=[group[0] for group in merged.values()],
            new_of={f: new for new, group in merged.items() for f in group},
            merged=merged,
            removed=sorted(set(range(1, count + 1)) - used),
            user_map={new: e for new, e in enumerate(order, start=1)},
        )
    else:
        reps = sorted(used)
        result = Renumbering(reps=reps, new_of={f: i for i, f in enumerate(reps, start=1)},
                             merged={i: [f] for i, f in enumerate(reps, start=1)},
                             removed=sorted(set(range(1, count + 1)) - used))
    return result if result.changes else None


def _pick(values: list, reps: list[int]) -> list:
    return [values[r - 1] for r in reps]


def _settings(settings: dict, count: int, r: Renumbering) -> dict:
    out = copy.deepcopy(settings)
    n_new = len(r.reps)
    # Per-filament lists, named explicitly: a list's length alone is not enough (the bed's
    # printable_area has 4 corners, like a project with 4 filaments). Other per-filament
    # values are rebuilt from the target profiles by the conversion, or dropped.
    diffs = settings.get("different_settings_to_system") or []
    designer = {k for section in diffs[1:count + 1] for k in str(section).split(";") if k}
    filament_keys = {k for k in settings if k.startswith("filament_")} | designer | {"default_filament_colour"}
    for key, value in settings.items():
        if key in PRESET_GROUP_KEYS and isinstance(value, list) and len(value) == count + 2:
            out[key] = [value[0], *_pick(value[1:-1], r.reps), value[-1]]
        elif key == "flush_volumes_matrix" and isinstance(value, list) and value and len(value) % (count * count) == 0:
            # One n×n block per extruder (two on dual-nozzle printers): keep the kept rows and columns.
            blocks = len(value) // (count * count)
            out[key] = [value[b * count * count + (i - 1) * count + (j - 1)]
                        for b in range(blocks) for i in r.reps for j in r.reps]
        elif key == "flush_volumes_vector" and isinstance(value, list) and len(value) == 2 * count:
            out[key] = [v for rep in r.reps for v in value[2 * (rep - 1): 2 * rep]]
        elif key in filament_keys and isinstance(value, list) and len(value) == count:
            out[key] = _pick(value, r.reps)
        elif key in SCALAR_FILAMENT_KEYS and str(value).isdigit() and int(value) > 0:
            out[key] = str(r.new_of.get(int(value), 1))
    if len(out.get("filament_colour") or []) != n_new:
        raise RenumberError("filament list length mismatch")
    return out


def _model_settings(xml: bytes, count: int, r: Renumbering) -> bytes:
    def remap_extruder(m: re.Match) -> bytes:
        value = int(m.group(2))
        return m.group(1) + str(r.new_of.get(value, value) if value else 0).encode() + m.group(3)

    xml = re.sub(rb'(key="extruder"\s+value=")(\d+)(")', remap_extruder, xml)
    for key in PLATE_FILAMENT_KEYS:
        def pick(m: re.Match) -> bytes:
            values = m.group(2).decode().split()
            kept = " ".join(_pick(values, r.reps)) if len(values) == count else m.group(2).decode()
            return m.group(1) + kept.encode() + m.group(3)
        xml = re.sub(rb'(key="' + key.encode() + rb'"\s+value=")([^"]*)(")', pick, xml)
    return xml


def _layer_changes(xml: bytes, r: Renumbering) -> bytes:
    def remap(m: re.Match) -> bytes:
        value = int(m.group(2))
        return m.group(1) + str(r.new_of.get(value, value)).encode() + m.group(3)
    return re.sub(rb'(\bextruder=")(\d+)(")', remap, xml)


def apply(project: Project3MF, r: Renumbering) -> tuple[Project3MF, dict[str, bytes]]:
    """The renumbered project and the entries that changed (to write over the source)."""
    settings = project.project_settings or {}
    count = len(settings.get("filament_colour") or [])
    new_settings = _settings(settings, count, r)
    changed: dict[str, bytes] = {PROJECT_SETTINGS: json.dumps(new_settings, indent=4, ensure_ascii=False).encode()}
    if project.has(MODEL_SETTINGS):
        changed[MODEL_SETTINGS] = _model_settings(project.read(MODEL_SETTINGS), count, r)
    if project.has(CUSTOM_GCODE_PER_LAYER):
        changed[CUSTOM_GCODE_PER_LAYER] = _layer_changes(project.read(CUSTOM_GCODE_PER_LAYER), r)
    mapping = {0: 0, **r.new_of}
    for name in [*project.geometry_names(), "3D/3dmodel.model"]:
        if project.has(name):
            data = project.read(name)
            new = model_edit.remap_paint_bytes(data, mapping)
            if new is not data and new != data:
                _check_paint(data, new, mapping)
                changed[name] = new
    reduced = Project3MF(path=project.path, prusa_settings=project.prusa_settings,
                         entries={n: Entry(e.info, changed.get(n, e.data)) for n, e in project.entries.items()},
                         project_settings=new_settings)
    return reduced, changed


def _check_paint(old: bytes, new: bytes, mapping: dict[int, int]) -> None:
    """Same number of painted triangles; each distinct code became its renumbered self,
    with the same tree and exactly the renumbered states."""
    if model_edit.paint_count(old) != model_edit.paint_count(new):
        raise RenumberError("paint codes lost while renumbering")
    old_codes = model_edit.paint_code_set(old)
    expected = {model_edit.remap_paint(c.decode(), mapping).encode() for c in old_codes}
    if model_edit.paint_code_set(new) != expected:
        raise RenumberError("unexpected paint codes after renumbering")
    for code in old_codes:
        states = {mapping.get(s, s) for s in model_edit.decode_paint(code.decode())}
        if model_edit.decode_paint(model_edit.remap_paint(code.decode(), mapping)) != states:
            raise RenumberError(f"paint code {code!r} renumbered wrongly")
