"""Conversion entry point for embedders that hand over data instead of installed slicers.

The browser extension runs this module in Pyodide: profiles arrive as bundles
(see tools/build_profile_catalog.py or a folder the user picked), the project as a
file in the virtual file system, and the result goes back as a dict that is plain
JSON (report included), so the caller needs no Python objects.
"""

from __future__ import annotations

from pathlib import Path

from . import i18n, read_3mf, write_3mf
from . import options as conversion_options
from .convert import convert
from .profiles import ProfileError, ProfileLibrary
from .remap_filaments import MapError, parse_map
from .slicers import registry, source_slicer
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


def usable_printers(lib: ProfileLibrary) -> list[dict]:
    """Instantiable machine presets whose profiles are complete (see Target.is_usable)."""
    out = []
    for name in lib.names("machine"):
        if str(lib.raw[("machine", name)].get("instantiation", "true")).lower() != "true":
            continue
        try:
            target = Target(lib, name)
        except ProfileError:
            continue
        if target.is_usable():
            out.append({"name": name, "model": target.printer_model, "nozzle": target.nozzle,
                        "extruders": target.extruders, "vendor": lib.vendors[("machine", name)]})
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
) -> dict:
    """Convert `src` for `printer` and write the result into `out_dir`.

    Returns {"ok", "output", "needs_map", "already_target", "report", "text"}; `output`
    is the path of the converted project or None (also when the project is already set up
    for that printer: `already_target`). `options` are the advanced options (see
    options.py; missing ones take their defaults). Errors in the input (unknown
    printer, bad map or option) come back in the report instead of raising.
    `source_bundles`: profiles of the slicer the project comes from (see source_info),
    to compare the designer's changes with their original values.
    """
    if lang:
        i18n.set_language(lang)
    project = read_3mf.load(src)
    try:
        user_map = parse_map(map_text) if map_text else None
        chosen = conversion_options.resolve(options)
        lib = ProfileLibrary.from_bundles(bundles)
        name = find_printer(lib, printer)
        if not name:
            raise ProfileError(i18n.t("target.error.unknown_printer", name=printer))
        known = registry(platform=platform) if slicer else {}
        target = Target(lib, name, known.get(slicer))
    except (MapError, ProfileError, conversion_options.OptionError) as e:
        return {"ok": False, "output": None, "needs_map": False, "report": None, "text": str(e),
                "already_target": False}
    if target.is_same_printer(project.project_settings or {}):
        # Not an error when converting for several printers: this one needs nothing.
        return {"ok": True, "output": None, "needs_map": False, "report": None, "already_target": True,
                "text": i18n.t("convert.error.already_target", target=target.display_name)}

    source_lib = None
    if source_bundles:
        try:
            source_lib = ProfileLibrary.from_bundles(source_bundles)
        except ProfileError:
            source_lib = None  # optional: only enriches the report
    result = convert(project, target, nozzle=nozzle, user_map=user_map, source_lib=source_lib, **chosen)
    report = result.report
    dest = Path(out_dir) / write_3mf.output_path(Path(src), target.output_suffix).name
    if report.ok:
        try:
            write_3mf.write(project, dest, result.files, result.removed, force=True)
        except write_3mf.WriteError as e:
            report.errors.append(str(e))
        else:
            report.output = str(dest)
            report.errors.extend(write_3mf.verify(project, dest, result.files))
    output = report.output or None
    # Paths in the embedder's virtual file system mean nothing to the user: names only.
    report.source = Path(src).name
    report.output = Path(output).name if output else ""
    return {"ok": report.ok, "output": output, "needs_map": report.needs_map, "already_target": False,
            "report": report.to_dict(), "text": report.to_text()}
