"""Reporte de conversión: todo cambio, descarte o advertencia queda registrado."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field


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
    presets: dict[str, object] = field(default_factory=dict)
    changed: list[FieldChange] = field(default_factory=list)
    kept_author: list[FieldChange] = field(default_factory=list)
    dropped: list[FieldChange] = field(default_factory=list)
    object_overrides: list[ObjectOverride] = field(default_factory=list)
    filaments: list[FilamentMapping] = field(default_factory=list)
    positions: list[FieldChange] = field(default_factory=list)
    plates: list[FieldChange] = field(default_factory=list)
    files: list[FieldChange] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)  # informativo: no requiere acción
    errors: list[str] = field(default_factory=list)

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
            f"Origen:  {self.source} ({self.source_kind})",
            f"Destino: {self.target}",
            f"Salida:  {self.output or '(no escrita)'}",
        ]
        if self.presets:
            lines.append("Presets: " + ", ".join(f"{k}={_short(v, 120)}" for k, v in self.presets.items()))
        if self.filaments:
            lines.append("Filamentos:")
            for f in self.filaments:
                ext = ", ".join(f"placa {p}→E{e}" for p, e in f.extruders.items()) or "sin uso"
                lines.append(f"  #{f.index} {f.source_type} {f.colour} '{f.source_profile}' → "
                             f"'{f.target_profile or 'SIN EQUIVALENTE'}' ({ext})")
        lines.append(f"Campos cambiados: {len(self.changed)}")
        if verbose:
            lines += [f"  {c.key}: {_short(c.original)} → {_short(c.final)} [{c.reason}]" for c in self.changed]
        if self.kept_author:
            lines.append(f"Ajustes del autor conservados: {len(self.kept_author)}")
            lines += [f"  {c.key}: {_short(c.original)} (perfil C5P: {_short(c.final)})" for c in self.kept_author]
        if self.dropped:
            lines.append(f"Descartados: {len(self.dropped)}")
            lines += [f"  {c.key}: {_short(c.original)} [{c.reason}]" for c in self.dropped]
        if self.object_overrides:
            lines.append(f"Overrides por objeto/pieza: {len(self.object_overrides)}")
            for o in self.object_overrides:
                where = o.object + (f" / {o.part}" if o.part else "")
                lines.append(f"  {where}: {o.key} {o.original} → {o.final} [{o.reason}]")
        sections = (("Posiciones en plato", self.positions), ("Placas", self.plates), ("Archivos", self.files))
        for title, items in sections:
            if items:
                lines.append(f"{title}: {len(items)}")
                lines += [f"  {c.key}: {_short(c.original)} → {_short(c.final)} [{c.reason}]" for c in items]
        if self.notes:
            lines.append("Notas:")
            lines += [f"  · {n}" for n in self.notes]
        if self.warnings:
            lines.append(f"ADVERTENCIAS ({len(self.warnings)}):")
            lines += [f"  ! {w}" for w in self.warnings]
        if self.errors:
            lines.append(f"ERRORES ({len(self.errors)}):")
            lines += [f"  ✗ {e}" for e in self.errors]
        return "\n".join(lines)
