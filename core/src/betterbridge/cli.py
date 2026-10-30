"""Uso: python cli.py entrada.3mf --target creator5pro [--map 1:1,2:2,5:1]"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import read_3mf, write_3mf
from .convert import convert
from .printer_profiles import creator5pro
from .profiles import ProfileError, ProfileLibrary, find_root
from .remap_filaments import MapError, parse_map

TARGETS = {creator5pro.KEY: creator5pro}

EXIT_OK, EXIT_ERROR, EXIT_NEEDS_INPUT = 0, 1, 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="betterbridge", description="Convierte un .3mf a otra impresora.")
    p.add_argument("input", type=Path, help="proyecto .3mf de origen (no se modifica)")
    p.add_argument("--target", default=creator5pro.KEY, choices=sorted(TARGETS))
    p.add_argument("--map", help="filamento:extrusor separados por comas, p. ej. 1:1,2:2,5:1")
    p.add_argument("--nozzle", help="diámetro de boquilla destino (por defecto, el del origen)")
    p.add_argument("--out", type=Path, help="archivo o carpeta de salida (por defecto, junto al original)")
    p.add_argument("--profiles-dir", help="carpeta 'profiles' de Flash Studio")
    p.add_argument("--report", type=Path, help="ruta del reporte JSON (por defecto, junto a la salida)")
    p.add_argument("--force", action="store_true", help="sobrescribir la salida si existe")
    p.add_argument("-v", "--verbose", action="store_true", help="listar cada campo cambiado")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target = TARGETS[args.target]
    src: Path = args.input
    if not src.is_file():
        print(f"error: no existe {src}", file=sys.stderr)
        return EXIT_ERROR

    try:
        user_map = parse_map(args.map) if args.map else None
        lib = ProfileLibrary.load(find_root(args.profiles_dir))
    except (MapError, ProfileError) as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_ERROR

    before = write_3mf.sha256_file(src)
    project = read_3mf.load(src)
    result = convert(project, lib, nozzle=args.nozzle, user_map=user_map, target=target)
    report = result.report

    dest = write_3mf.output_path(src, target.OUTPUT_SUFFIX)
    if args.out:
        dest = args.out / dest.name if args.out.is_dir() else args.out
    report_path = args.report or dest.with_suffix(".report.json")

    if report.ok:
        try:
            write_3mf.write(project, dest, result.files, result.removed, force=args.force)
        except write_3mf.WriteError as e:
            report.errors.append(str(e))
        else:
            report.output = str(dest)
            report.errors.extend(write_3mf.verify(project, dest, result.files))
    if write_3mf.sha256_file(src) != before:
        report.errors.append("el archivo original cambió durante la conversión")

    report_path.write_text(report.to_json(), encoding="utf-8")
    print(report.to_text(verbose=args.verbose))
    print(f"Reporte: {report_path}")
    if report.ok:
        return EXIT_OK
    needs_map = any("--map" in e for e in report.errors)
    return EXIT_NEEDS_INPUT if needs_map else EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
