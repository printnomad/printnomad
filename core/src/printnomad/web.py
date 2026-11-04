"""Conversion entry point for embedders that hand over data instead of installed slicers.

The browser extension runs this module in Pyodide: profiles arrive as bundles
(see tools/build_profile_catalog.py or a folder the user picked), the project as a
file in the virtual file system, and the result goes back as a dict that is plain
JSON (report included), so the caller needs no Python objects.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from . import i18n, issues, read_3mf, write_3mf
from . import options as conversion_options
from .convert import convert
from .profiles import ProfileError, ProfileLibrary
from .remap_filaments import MapError, format_map, parse_map, suggest_map
from .report import Report
from .slicers import Slicer, registry, source_slicer
from .target import Target, find_printer


def source_info(src: str) -> dict:
    """What the project was made with: {"kind", "slicer", "printer"}; slicer/printer may be None.

    The extension uses it to fetch the source slicer's profiles before converting.
    """
    project = read_3mf.peek(src)
    kind = read_3mf.detect_source(project)
    printer = (project.project_settings or {}).get("printer_settings_id") or None
    return {"kind": kind, "slicer": source_slicer(kind), "printer": printer}


def list_options(lang: str | None = None) -> list[dict]:
    """Advanced options with texts in `lang` (for the settings screens)."""
    if lang:
        i18n.set_language(lang)
    return conversion_options.describe()


def list_printers(bundles: list[dict]) -> list[dict]:
    """Usable machine presets in the bundles (what "My printers" can offer)."""
    return usable_printers(ProfileLibrary.from_bundles(bundles))


def usable_printers(lib: ProfileLibrary, slicer: Slicer | None = None) -> list[dict]:
    """Instantiable machine presets whose profiles are complete (see Target.is_usable).

    `bed_types`: plates that can be chosen in `slicer` (empty: fixed); `bed_type`: the default.
    """
    out = []
    for name in lib.names("machine"):
        if str(lib.raw[("machine", name)].get("instantiation", "true")).lower() != "true":
            continue
        try:
            target = Target(lib, name, slicer)
        except ProfileError:
            continue
        if target.is_usable():
            out.append({"name": name, "model": target.printer_model, "nozzle": target.nozzle,
                        "extruders": target.extruders, "vendor": lib.vendors[("machine", name)],
                        "bed_types": target.bed_types, "bed_type": target.bed_type})
    return out


def convert_file(
    src: str,
    out_dir: str,
    printer: str,
    bundles: list[dict],
    *,
    slicer: str | None = None,
    platform: str | None = None,
    nozzle: str | None = None,
    map_text: str | None = None,
    options: dict | None = None,
    source_bundles: list[dict] | None = None,
    lang: str | None = None,
    bed_type: str | None = None,
) -> dict:
    """Convert `src` for `printer` and write the result into `out_dir`.

    Returns {"ok", "output", "needs_map", "already_target", "report", "text"}; `output`
    is the path of the converted project or None (also when the project is already set up
    for that printer and needs no fix: `already_target`; one that needs fixes is written
    repaired, see repair.py). `options` are the advanced options (see
    options.py; missing ones take their defaults). Errors in the input (unknown
    printer, bad map or option) come back in the report instead of raising.
    `source_bundles`: profiles of the slicer the project comes from (see source_info),
    to compare the designer's changes with their original values. `bed_type`: the build
    plate chosen for this printer (see usable_printers).
    """
    if lang:
        i18n.set_language(lang)
    try:
        project = read_3mf.load(src)
    except read_3mf.UNREADABLE_ERRORS as e:
        return _failed(src, printer, issues.UNREADABLE_PROJECT, i18n.t("convert.error.unreadable", detail=e))
    try:
        user_map = parse_map(map_text) if map_text else None
    except MapError as e:
        return _failed(src, printer, issues.BAD_MAP, str(e))
    try:
        chosen = conversion_options.resolve(options)
    except conversion_options.OptionError as e:
        return _failed(src, printer, issues.BAD_OPTION, str(e))
    try:
        lib = ProfileLibrary.from_bundles(bundles)
        name = find_printer(lib, printer)
        if not name:
            raise ProfileError(i18n.t("target.error.unknown_printer", name=printer))
        known = registry(platform=platform) if slicer else {}
        target = Target(lib, name, known.get(slicer))
    except ProfileError as e:
        return _failed(src, printer, issues.UNKNOWN_PRINTER, str(e))
    source_lib = None
    if source_bundles:
        try:
            source_lib = ProfileLibrary.from_bundles(source_bundles)
        except ProfileError:
            source_lib = None  # optional: only enriches the report
    try:
        result = convert(project, target, nozzle=nozzle, user_map=user_map, source_lib=source_lib, bed_type=bed_type,
                         **chosen)
    except ET.ParseError as e:
        return _failed(src, printer, issues.UNREADABLE_PROJECT, i18n.t("convert.error.unreadable", detail=e))
    except Exception as e:  # noqa: BLE001 (last resort: the user gets a code and a report to send)
        detail = f"{type(e).__name__}: {e}"
        return _failed(src, printer, issues.INTERNAL, i18n.t("convert.error.internal", detail=detail))
    report = result.report
    if report.already_target and not result.files:
        # Not an error when converting for several printers: this one needs nothing.
        return {"ok": True, "output": None, "needs_map": False, "report": None, "already_target": True,
                "text": i18n.t("convert.error.already_target", target=target.display_name)}
    dest = Path(out_dir) / write_3mf.output_path(Path(src), target.output_suffix).name
    if report.ok:
        try:
            write_3mf.write(project, dest, result.files, result.removed, force=True)
        except write_3mf.WriteError as e:
            report.fail(issues.WRITE_FAILED, str(e))
        else:
            report.output = str(dest)
            for problem in write_3mf.verify(project, dest, result.files):
                report.fail(issues.VERIFY_FAILED, problem)
    output = report.output or None
    # Paths in the embedder's virtual file system mean nothing to the user: names only.
    report.source = Path(src).name
    report.output = Path(output).name if output else ""
    result_dict = {"ok": report.ok, "output": output, "needs_map": report.needs_map, "already_target": False,
                   "report": report.to_dict(), "text": report.to_text()}
    if report.needs_map:
        result_dict["plan"] = assignment_plan(project, result.usage, target.extruders)
    return result_dict


def _failed(src: str, printer: str, code: str, message: str) -> dict:
    """The result of a conversion that could not start: a report with only the error."""
    report = Report(source=Path(src).name, target=printer)
    report.fail(code, message)
    return {"ok": False, "output": None, "needs_map": False, "already_target": False,
            "report": report.to_dict(), "text": report.to_text()}


def assignment_plan(project, usage: dict[str, set[int] | None], extruders: int) -> dict:
    """What a filament → extruder assignment screen needs: the project's filaments (with the
    plates using them), the extruders, and a suggestion to start from (--map syntax)."""
    settings = project.project_settings or {}
    types = [str(t) for t in settings.get("filament_type") or ["PLA"]]
    colours = list(settings.get("filament_colour") or ["#FFFFFF"] * len(types))
    profiles = list(settings.get("filament_settings_id") or [""] * len(types))
    filaments = []
    for i, ftype in enumerate(types, start=1):
        plates = sorted((p for p, used in usage.items() if used is None or i in used), key=str)
        filaments.append({"index": i, "type": ftype, "colour": colours[i - 1] if i - 1 < len(colours) else "#FFFFFF",
                          "profile": profiles[i - 1] if i - 1 < len(profiles) else "", "plates": plates})
    suggestion = suggest_map(types, colours, usage, extruders)
    return {"extruders": extruders, "filaments": filaments,
            "plates": {p: sorted(u) if u is not None else None for p, u in usage.items()},
            "suggestion": format_map(suggestion) if suggestion else None}
