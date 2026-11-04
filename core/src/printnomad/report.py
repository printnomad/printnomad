"""Reporte de conversión: todo cambio, descarte o advertencia queda registrado."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

from .i18n import t


def _short(value, limit: int = 80) -> str:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    text = text.replace("\n", "\\n")
    return text if len(text) <= limit else text[: limit - 1] + "…"


@dataclass
class FieldChange:
    key: str
    original: object
    final: object
    reason: str
    # Value in the source preset the designer started from (when its profiles are
    # available): shows how much the designer changed it.
    source_preset: object = None


@dataclass
class ObjectOverride:
    object: str
    part: str | None
    key: str
    original: str
    final: str
    reason: str


@dataclass
class FilamentMapping:
    index: int  # 1-based, índice de filamento en el proyecto
    source_profile: str
    source_type: str
    colour: str
    target_profile: str | None
    extruders: dict[str, int] = field(default_factory=dict)  # placa -> extrusor


@dataclass
class Report:
    source: str = ""
    output: str = ""
    source_kind: str = ""
    target: str = ""
    profiles: str = ""  # source of the target profiles (folders or repo@ref)
    presets: dict[str, object] = field(default_factory=dict)
    changed: list[FieldChange] = field(default_factory=list)
    kept_author: list[FieldChange] = field(default_factory=list)
    # From the project, not changed by the designer: the layer height, when the target has no
    # process of that height.
    kept_project: list[FieldChange] = field(default_factory=list)
    dropped: list[FieldChange] = field(default_factory=list)
    # Source preset defaults removed so the target slicer's own defaults apply.
    source_defaults: list[str] = field(default_factory=list)
    # Settings the project marks as changed although they equal the source preset
    # (common in MakerWorld "Shared" profiles): treated as not changed.
    not_changed: list[str] = field(default_factory=list)
    # Filaments renumbered before converting: unused ones removed, merged ones (renumber.py).
    filament_changes: list[str] = field(default_factory=list)
    # Source presets the designer's changes were compared with ("" = not available).
    source_presets: str = ""
    object_overrides: list[ObjectOverride] = field(default_factory=list)
    filaments: list[FilamentMapping] = field(default_factory=list)
    positions: list[FieldChange] = field(default_factory=list)
    plates: list[FieldChange] = field(default_factory=list)
    files: list[FieldChange] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)  # informativo: no requiere acción
    errors: list[str] = field(default_factory=list)
    # Hace falta que el usuario asigne filamentos a extrusores (CLI --map o tabla del plugin).
    needs_map: bool = False
    # The project was already set up for the target: only reviewed (repair.py).
    already_target: bool = False

    @property
    def ok(self) -> bool:
        return not self.errors

    def change(self, key, original, final, reason):
        self.changed.append(FieldChange(key, original, final, reason))

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ok"] = self.ok
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    def to_text(self, verbose: bool = False) -> str:
        lines = [
            t("report.source", path=self.source, kind=self.source_kind),
            t("report.target", target=self.target),
            *([t("report.profiles", source=self.profiles)] if self.profiles else []),
            t("report.output", path=self.output or t("report.not_written")),
        ]
        if self.presets:
            items = ", ".join(f"{k}={_short(v, 120)}" for k, v in self.presets.items())
            lines.append(t("report.presets", items=items))
        if self.filaments:
            lines.append(t("report.filaments"))
            for f in self.filaments:
                ext = ", ".join(t("report.plate_extruder", plate=p, extruder=e) for p, e in f.extruders.items())
                lines.append(f"  #{f.index} {f.source_type} {f.colour} '{f.source_profile}' → "
                             f"'{f.target_profile or t('report.no_equivalent')}' ({ext or t('report.unused')})")
        lines += [f"  · {c}" for c in self.filament_changes]
        lines.append(t("report.changed", count=len(self.changed)))
        if verbose:
            lines += [f"  {c.key}: {_short(c.original)} → {_short(c.final)} [{c.reason}]" for c in self.changed]
        if self.kept_author:
            lines.append(t("report.kept_author", count=len(self.kept_author)))
            for c in self.kept_author:
                was = "" if c.source_preset is None else _short(c.source_preset) + " → "
                target = t("report.kept_author_line", value=_short(c.final))
                lines.append(f"  {c.key}: {was}{_short(c.original)} {target}")
        if self.kept_project:
            lines.append(t("report.kept_project", count=len(self.kept_project)))
            for c in self.kept_project:
                target = t("report.kept_author_line", value=_short(c.final))
                lines.append(f"  {c.key}: {_short(c.original)} {target} [{c.reason}]")
        if self.dropped:
            lines.append(t("report.dropped", count=len(self.dropped)))
            lines += [f"  {c.key}: {_short(c.original)} [{c.reason}]" for c in self.dropped]
        if self.not_changed:
            lines.append(t("report.not_changed", count=len(self.not_changed), keys=", ".join(self.not_changed)))
        if self.source_defaults:
            lines.append(t("report.source_defaults", count=len(self.source_defaults)))
            if verbose:
                lines.append("  " + ", ".join(self.source_defaults))
        if self.object_overrides:
            lines.append(t("report.object_overrides", count=len(self.object_overrides)))
            for o in self.object_overrides:
                where = o.object + (f" / {o.part}" if o.part else "")
                lines.append(f"  {where}: {o.key} {o.original} → {o.final} [{o.reason}]")
        sections = ((t("report.positions"), self.positions), (t("report.plates"), self.plates),
                    (t("report.files"), self.files))
        for title, items in sections:
            if items:
                lines.append(f"{title}: {len(items)}")
                lines += [f"  {c.key}: {_short(c.original)} → {_short(c.final)} [{c.reason}]" for c in items]
        if self.notes:
            lines.append(t("report.notes"))
            lines += [f"  · {n}" for n in self.notes]
        if self.warnings:
            lines.append(t("report.warnings", count=len(self.warnings)))
            lines += [f"  ! {w}" for w in self.warnings]
        if self.errors:
            lines.append(t("report.errors", count=len(self.errors)))
            lines += [f"  ✗ {e}" for e in self.errors]
        return "\n".join(lines)
