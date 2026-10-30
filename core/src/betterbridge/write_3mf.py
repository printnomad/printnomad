"""Reempaquetado del .3mf: las entradas sin cambios se copian byte a byte."""

from __future__ import annotations

import hashlib
import os
import tempfile
import zipfile
from pathlib import Path

from .read_3mf import Project3MF


class WriteError(Exception):
    pass


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def output_path(source: Path, suffix: str) -> Path:
    return source.with_name(f"{source.stem}{suffix}.3mf")


def write(
    project: Project3MF,
    dest: Path,
    replaced: dict[str, bytes],
    removed: set[str] = frozenset(),
    force: bool = False,
) -> None:
    dest = Path(dest)
    if dest.resolve() == Path(project.path).resolve():
        raise WriteError("la salida no puede ser el archivo original")
    if dest.exists() and not force:
        raise WriteError(f"{dest} ya existe (usa --force para sobrescribir)")

    # Escritura atómica: archivo temporal en la misma carpeta y rename.
    fd, tmp = tempfile.mkstemp(prefix=".betterbridge-", suffix=".3mf", dir=dest.parent)
    os.close(fd)
    try:
        # Nivel 1: misma salida descomprimida, ~5× más rápido que el nivel por defecto.
        with zipfile.ZipFile(tmp, "w", compresslevel=1) as zf:
            for name, entry in project.entries.items():
                if name in removed:
                    continue
                data = replaced.get(name, entry.data)
                info = zipfile.ZipInfo(name, date_time=entry.info.date_time)
                info.compress_type = entry.info.compress_type
                # writestr(ZipInfo) ignora el compresslevel del ZipFile: hay que fijarlo aquí
                # (`compress_level` desde 3.13, `_compresslevel` en 3.12).
                if hasattr(type(info), "compress_level"):
                    info.compress_level = 1
                else:
                    info._compresslevel = 1
                info.external_attr = entry.info.external_attr
                zf.writestr(info, data)
            for name, data in replaced.items():
                if name not in project.entries:
                    zf.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_DEFLATED)
        # mkstemp crea el archivo con 0600; mismos permisos que el original.
        os.chmod(tmp, Path(project.path).stat().st_mode & 0o777)
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def verify(source: Project3MF, dest: Path, replaced: dict[str, bytes]) -> list[str]:
    """Comprueba ZIP válido y geometría byte-idéntica. Devuelve lista de problemas."""
    problems: list[str] = []
    try:
        with zipfile.ZipFile(dest) as zf:
            bad = zf.testzip()
            if bad:
                problems.append(f"entrada corrupta en la salida: {bad}")
            names = set(zf.namelist())
            for name in source.geometry_names():
                if name not in names:
                    problems.append(f"falta geometría {name}")
                elif hashlib.sha256(zf.read(name)).digest() != hashlib.sha256(source.read(name)).digest():
                    problems.append(f"geometría modificada: {name}")
            for name, data in replaced.items():
                if zf.read(name) != data:
                    problems.append(f"contenido inesperado en {name}")
    except zipfile.BadZipFile as e:
        problems.append(f"la salida no es un ZIP válido: {e}")
    return problems
