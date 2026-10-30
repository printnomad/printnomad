"""Lectura de proyectos .3mf (Bambu Studio / OrcaSlicer / PrusaSlicer).

Un .3mf es un ZIP. Se carga todo en memoria conservando cada entrada en
bytes crudos para poder reescribir sin cambios lo que no se toca.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_SETTINGS = "Metadata/project_settings.config"
MODEL_SETTINGS = "Metadata/model_settings.config"
PRUSA_CONFIG = "Metadata/Slic3r_PE.config"
MODEL_FILE = "3D/3dmodel.model"
OBJECTS_PREFIX = "3D/Objects/"

SOURCE_BAMBU = "bambu"
SOURCE_ORCA = "orca"
SOURCE_PRUSA = "prusa"
SOURCE_FLASHFORGE = "flashforge"
SOURCE_UNKNOWN = "unknown"


@dataclass
class Entry:
    info: zipfile.ZipInfo
    data: bytes


@dataclass
class Project3MF:
    path: Path
    entries: dict[str, Entry] = field(default_factory=dict)
    project_settings: dict | None = None
    prusa_settings: dict[str, str] | None = None

    def names(self) -> list[str]:
        return list(self.entries)

    def read(self, name: str) -> bytes:
        return self.entries[name].data

    def has(self, name: str) -> bool:
        return name in self.entries

    def model_settings(self) -> ET.Element | None:
        if not self.has(MODEL_SETTINGS):
            return None
        return ET.fromstring(self.read(MODEL_SETTINGS))

    def geometry_names(self) -> list[str]:
        return [n for n in self.entries if n.startswith(OBJECTS_PREFIX) and n.endswith(".model")]


def parse_prusa_ini(text: str) -> dict[str, str]:
    """`Slic3r_PE.config`: líneas `; key = value`."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(";"):
            line = line[1:].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def load(path: str | Path) -> Project3MF:
    path = Path(path)
    project = Project3MF(path=path)
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            project.entries[info.filename] = Entry(info=info, data=zf.read(info))
    if project.has(PROJECT_SETTINGS):
        project.project_settings = json.loads(project.read(PROJECT_SETTINGS))
    if project.has(PRUSA_CONFIG):
        project.prusa_settings = parse_prusa_ini(project.read(PRUSA_CONFIG).decode("utf-8", "replace"))
    return project


def peek(path: str | Path) -> Project3MF:
    """Solo los ajustes (sin mallas): para detectar el origen rápido."""
    path = Path(path)
    project = Project3MF(path=path)
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        if PROJECT_SETTINGS in names:
            project.project_settings = json.loads(zf.read(PROJECT_SETTINGS))
        if PRUSA_CONFIG in names:
            project.prusa_settings = parse_prusa_ini(zf.read(PRUSA_CONFIG).decode("utf-8", "replace"))
    return project


def detect_source(project: Project3MF) -> str:
    settings = project.project_settings
    if settings:
        model = str(settings.get("printer_model", ""))
        printer_id = str(settings.get("printer_settings_id", ""))
        if model.startswith("Bambu Lab") or "Bambu Lab" in printer_id or "@BBL" in printer_id:
            return SOURCE_BAMBU
        if model.startswith("Flashforge"):
            return SOURCE_FLASHFORGE
        return SOURCE_ORCA
    if project.prusa_settings is not None:
        return SOURCE_PRUSA
    return SOURCE_UNKNOWN
