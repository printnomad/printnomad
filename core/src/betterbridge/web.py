"""Conversion entry point for embedders that hand over data instead of installed slicers.

The browser extension runs this module in Pyodide: profiles arrive as bundles
(see tools/build_profile_catalog.py or a folder the user picked), the project as a
file in the virtual file system, and the result goes back as a dict that is plain
JSON (report included), so the caller needs no Python objects.
"""

from __future__ import annotations

from pathlib import Path

from . import i18n, read_3mf, write_3mf
from .convert import convert
from .profiles import ProfileError, ProfileLibrary
from .remap_filaments import MapError, parse_map
from .slicers import registry
from .target import Target, find_printer


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
    keep_designer_filament: bool = True,
    lang: str | None = None,
) -> dict:
    """Convert `src` for `printer` and write the result into `out_dir`.

    Returns {"ok", "output", "needs_map", "report", "text"}; `output` is the path of
    the converted project or None. Errors in the input (unknown printer, bad map)
    come back in the report instead of raising, like the CLI does.
    """
    if lang:
        i18n.set_language(lang)
    project = read_3mf.load(src)
    try:
        user_map = parse_map(map_text) if map_text else None
        lib = ProfileLibrary.from_bundles(bundles)
        name = find_printer(lib, printer)
        if not name:
            raise ProfileError(i18n.t("target.error.unknown_printer", name=printer))
        known = registry(platform=platform) if slicer else {}
        target = Target(lib, name, known.get(slicer))
    except (MapError, ProfileError) as e:
        return {"ok": False, "output": None, "needs_map": False, "report": None, "text": str(e)}

    result = convert(project, target, nozzle=nozzle, user_map=user_map,
                     keep_designer_filament=keep_designer_filament)
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
    return {"ok": report.ok, "output": report.output or None, "needs_map": report.needs_map,
            "report": report.to_dict(), "text": report.to_text()}
