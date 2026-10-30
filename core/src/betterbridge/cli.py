"""Command line.

    betterbridge entrada.3mf --printer "<preset>" [--slicer flashstudio] [--map 1:1,2:2] [--lang es]
    betterbridge printers [--slicer flashstudio] [--search "creator"] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import i18n, read_3mf, write_3mf
from .convert import convert
from .i18n import t
from .profiles import USER_VENDOR, ProfileError
from .remap_filaments import MapError, parse_map
from .slicers import installed_slicers, registry
from .target import load_target

EXIT_OK, EXIT_ERROR, EXIT_NEEDS_INPUT = 0, 1, 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="betterbridge", description=t("cli.description"))
    p.add_argument("input", type=Path, help=t("cli.help.input"))
    p.add_argument("--printer", help=t("cli.help.printer"))
    p.add_argument("--slicer", help=t("cli.help.slicer"))
    p.add_argument("--map", help=t("cli.help.map"))
    p.add_argument("--nozzle", help=t("cli.help.nozzle"))
    p.add_argument("--out", type=Path, help=t("cli.help.out"))
    p.add_argument("--profiles-dir", help=t("cli.help.profiles_dir"))
    p.add_argument("--report", type=Path, help=t("cli.help.report"))
    p.add_argument("--force", action="store_true", help=t("cli.help.force"))
    p.add_argument("--no-designer-filament", action="store_true", help=t("cli.help.no_designer_filament"))
    p.add_argument("-v", "--verbose", action="store_true", help=t("cli.help.verbose"))
    p.add_argument("--lang", help=t("cli.help.lang", languages=", ".join(i18n.available_languages())))
    return p


def _lang_from_argv(argv: list[str]) -> str | None:
    """`--lang` se lee antes de construir el parser para que la ayuda salga en ese idioma."""
    for i, arg in enumerate(argv):
        if arg == "--lang" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--lang="):
            return arg.split("=", 1)[1]
    return None


def list_printers(argv: list[str]) -> int:
    """`betterbridge printers [--slicer X] [--search texto] [--json]`."""
    p = argparse.ArgumentParser(prog="betterbridge printers", description=t("cli.printers.description"))
    p.add_argument("--slicer", help=t("cli.help.slicer"))
    p.add_argument("--search", help=t("cli.printers.help.search"))
    p.add_argument("--json", action="store_true", help=t("cli.printers.help.json"))
    p.add_argument("--lang", help=t("cli.help.lang", languages=", ".join(i18n.available_languages())))
    args = p.parse_args(argv)
    if args.slicer:
        known = registry()
        if args.slicer not in known:
            print(t("cli.error", message=t("target.error.unknown_slicer", slicer=args.slicer,
                                           options=", ".join(known))), file=sys.stderr)
            return EXIT_ERROR
        slicers = [known[args.slicer]]
    else:
        slicers = installed_slicers()
    found: list[dict] = []
    for s in slicers:
        try:
            lib = s.library()
        except ProfileError:
            continue
        for name in lib.names("machine"):
            if str(lib.raw[("machine", name)].get("instantiation", "true")).lower() != "true":
                continue
            if args.search and args.search.lower() not in name.lower():
                continue
            found.append({"slicer": s.key, "slicer_name": s.name, "printer": name,
                          "user": lib.vendors.get(("machine", name)) == USER_VENDOR})
    if args.json:
        print(json.dumps(found, ensure_ascii=False, indent=2))
        return EXIT_OK
    if not found:
        print(t("cli.printers.none"))
        return EXIT_OK
    current = None
    for row in found:
        if row["slicer"] != current:
            current = row["slicer"]
            print(t("cli.printers.slicer_heading", name=row["slicer_name"], key=row["slicer"]))
        print(f"  {row['printer']}" + (f"  ({t('cli.printers.user')})" if row["user"] else ""))
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    i18n.set_language(_lang_from_argv(argv))
    if argv and argv[0] == "printers":
        return list_printers(argv[1:])
    args = build_parser().parse_args(argv)
    src: Path = args.input
    if not src.is_file():
        print(t("cli.error", message=t("cli.error.no_such_file", path=src)), file=sys.stderr)
        return EXIT_ERROR

    try:
        user_map = parse_map(args.map) if args.map else None
        if not args.printer:
            raise ProfileError(t("cli.error.no_printer"))
        target = load_target(args.printer, args.slicer, args.profiles_dir)
    except (MapError, ProfileError) as e:
        print(t("cli.error", message=e), file=sys.stderr)
        return EXIT_ERROR

    before = write_3mf.sha256_file(src)
    project = read_3mf.load(src)
    result = convert(project, target, nozzle=args.nozzle, user_map=user_map,
                     keep_designer_filament=not args.no_designer_filament)
    report = result.report

    dest = write_3mf.output_path(src, target.output_suffix)
    if args.out:
        dest = args.out / dest.name if args.out.is_dir() else args.out
    report_path = args.report or dest.with_suffix(".report.json")

    if report.ok and dest.exists() and not args.force:
        report.errors.append(t("cli.error.exists", path=dest))
    if report.ok:
        try:
            write_3mf.write(project, dest, result.files, result.removed, force=args.force)
        except write_3mf.WriteError as e:
            report.errors.append(str(e))
        else:
            report.output = str(dest)
            report.errors.extend(write_3mf.verify(project, dest, result.files))
    if write_3mf.sha256_file(src) != before:
        report.errors.append(t("cli.error.original_changed"))

    report_path.write_text(report.to_json(), encoding="utf-8")
    print(report.to_text(verbose=args.verbose))
    print(t("cli.report_path", path=report_path))
    if report.ok:
        return EXIT_OK
    if report.needs_map:
        print(t("cli.hint_map"), file=sys.stderr)
        return EXIT_NEEDS_INPUT
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
