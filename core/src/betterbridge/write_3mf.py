"""Reempaquetado del .3mf: las entradas sin cambios se copian byte a byte."""

from __future__ import annotations

import hashlib
import os
import tempfile
import zipfile
import zlib
from pathlib import Path

from .i18n import t
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
        raise WriteError(t("write.error.same_as_source"))
    if dest.exists() and not force:
        raise WriteError(t("write.error.exists", path=dest))

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
    """Comprueba ZIP válido, geometría byte-idéntica y contenido reemplazado. Devuelve problemas.

    Sin descomprimir lo copiado: cada entrada del ZIP lleva el CRC-32 y el tamaño de sus
    datos (calculados al escribir), así que una entrada copiada coincide con la original
    si coinciden ambos. Solo se leen las entradas reemplazadas (pequeñas). Antes se
    descomprimía todo y se calculaba sha256 de la geometría dos veces: en el navegador
    era la mitad del tiempo de conversión.
    """
    problems: list[str] = []
    try:
        with zipfile.ZipFile(dest) as zf:
            infos = {i.filename: i for i in zf.infolist()}
            # Geometry rewritten on purpose (paint renumbered) is checked with `replaced` below.
            for name in (n for n in source.geometry_names() if n not in replaced):
                info, original = infos.get(name), source.entries[name].info
                data = source.read(name)
                # The source's own CRC when it has one; else computed (projects built in memory).
                expected = (original.CRC if original.CRC else zlib.crc32(data), len(data))
                if info is None:
                    problems.append(t("write.error.missing_geometry", name=name))
                elif (info.CRC, info.file_size) != expected:
                    problems.append(t("write.error.geometry_modified", name=name))
            for name, data in replaced.items():
                try:
                    if zf.read(name) != data:  # read() also checks the CRC
                        problems.append(t("write.error.unexpected_content", name=name))
                except zipfile.BadZipFile:
                    problems.append(t("write.error.corrupt_entry", name=name))
    except zipfile.BadZipFile as e:
        problems.append(t("write.error.not_zip", detail=e))
    return problems
