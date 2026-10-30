"""Command line: `betterbridge entrada.3mf --printer "<preset>" [--slicer flashstudio] [--map 1:1,2:2] [--lang es]`"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import i18n, read_3mf, write_3mf
from .convert import convert
from .i18n import t
from .profiles import ProfileError
from .remap_filaments import MapError, parse_map
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


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    i18n.set_language(_lang_from_argv(argv))
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
    result = convert(project, target, nozzle=args.nozzle, user_map=user_map)
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
