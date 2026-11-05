"""Review a project already set up for the target printer and fix what would stop it slicing.

A project saved by the slicer after the user picked other filament presets can carry
values meant for another printer. `filament_printable` (the extruders each filament may
use, bit 0 = E1) is the known case: user presets often copy the slicer default of
Bambu's two-nozzle code (3 = E1–E2), and on a four-extruder printer the slicer then
refuses manual assignments to E3–E4 ("The right nozzle can not print PLA"). The printer
maker's own restrictions (Target.filament_printable_of) are kept; when the assignment
breaks one, the review warns instead of changing the assignment.
"""

from __future__ import annotations

import copy
import json
import xml.etree.ElementTree as ET

from . import model_edit, rules
from .i18n import t
from .read_3mf import PROJECT_SETTINGS, Project3MF, detect_source
from .report import FieldChange, Report
from .target import Target


def printable_conflicts(masks: list[str], plates: dict[str, tuple[str, list[int]]],
                        usage: dict[str, set[int] | None]) -> list[tuple[str, int, int]]:
    """(plate, filament, extruder) for each used filament sent by a manual assignment to an
    extruder its mask excludes. `plates`: plate → (map mode, extruder of each filament)."""
    out = []
    for pid, (mode, extruders) in plates.items():
        if mode != rules.MAP_MODE_MANUAL:
            continue  # the slicer regroups by itself and respects the masks
        used = usage.get(pid) or set(range(1, len(extruders) + 1))
        for f in sorted(used):
            if f > len(extruders) or f > len(masks) or not str(masks[f - 1]).isdigit():
                continue
            e = extruders[f - 1]
            if not int(masks[f - 1]) >> (e - 1) & 1:
                out.append((pid, f, e))
    return out


def extruders_text(mask: str) -> str:
    return ", ".join(f"E{i + 1}" for i in range(int(mask).bit_length()) if int(mask) >> i & 1)


def conflict_warnings(conflicts: list[tuple[str, int, int]], masks: list[str], types: list[str]) -> list[str]:
    return [t("convert.warn.filament_not_printable", plate=pid, filament=f, extruder=e,
              type=types[f - 1] if f <= len(types) else "", allowed=extruders_text(masks[f - 1]))
            for pid, f, e in conflicts]


def _plate_maps(root: ET.Element | None, settings: dict, n: int) -> dict[str, tuple[str, list[int]]]:
    """Each plate's map mode and filament → extruder list, as the slicer reads them: the
    plate's own values, else the project's."""
    default_mode = str(settings.get("filament_map_mode") or rules.MAP_MODE_AUTO)
    default_map = [int(x) if str(x).isdigit() else 1 for x in settings.get("filament_map") or []]
    default_map = (default_map + [1] * n)[:n]
    out: dict[str, tuple[str, list[int]]] = {}
    plates = root.findall("plate") if root is not None else []
    for i, plate in enumerate(plates, start=1):
        m = model_edit.meta(plate)
        values = [int(x) for x in (m.get("filament_maps") or "").split() if x.isdigit()]
        out[m.get("plater_id", str(i))] = (m.get("filament_map_mode") or default_mode,
                                           values if len(values) == n else default_map)
    return out or {"1": (default_mode, default_map)}


def review(project: Project3MF, target: Target) -> tuple[Report, dict[str, bytes]]:
    """The review report and the files to replace (empty when nothing needs fixing)."""
    from .convert import plate_usage  # noqa: PLC0415 (convert imports this module)

    report = Report(source=str(project.path), target=target.display_name, profiles=target.lib.source,
                    source_kind=detect_source(project))
    settings = project.project_settings or {}
    types = [str(x) for x in settings.get("filament_type") or []]
    n = len(settings.get("filament_colour") or types)
    if not n:
        return report, {}
    presets = list(settings.get("filament_settings_id") or []) + [""] * n
    current = [str(x) for x in settings.get("filament_printable") or []]
    masks = [target.filament_printable_of(presets[i]) for i in range(n)]
    out = copy.deepcopy(settings)
    if current != masks:
        out["filament_printable"] = masks
        for i in range(n):
            old = current[i] if i < len(current) else None
            if old != masks[i]:
                report.changed.append(FieldChange(t("report.filament_key", key="filament_printable", index=i + 1),
                                                  old, masks[i], t("reason.filament_printable_repaired",
                                                                   allowed=extruders_text(masks[i]))))
    try:
        root = project.model_settings()
        plates = _plate_maps(root, settings, n)
        usage = plate_usage(project, n)
    except ET.ParseError:
        plates, usage = _plate_maps(None, settings, n), {}
    report.warnings.extend(conflict_warnings(printable_conflicts(masks, plates, usage), masks, types))
    if not report.changed:
        return report, {}
    report.notes.append(t("report.repaired"))
    files = {PROJECT_SETTINGS: (json.dumps(out, indent=4, ensure_ascii=False) + "\n").encode("utf-8")}
    return report, files
