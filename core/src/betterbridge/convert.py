"""Pipeline de conversión: proyecto 3MF de origen -> proyecto para la impresora destino.

No escribe nada en disco: devuelve el reporte y los archivos modificados.
"""

from __future__ import annotations

import copy
import json
import math
from dataclasses import dataclass, field

from . import model_edit
from .printer_profiles import creator5pro
from .profiles import ProfileError, ProfileLibrary
from .read_3mf import (
    MODEL_FILE,
    MODEL_SETTINGS,
    PROJECT_SETTINGS,
    SOURCE_FLASHFORGE,
    SOURCE_PRUSA,
    SOURCE_UNKNOWN,
    Project3MF,
    detect_source,
)
from .remap_filaments import assign
from .report import FieldChange, FilamentMapping, ObjectOverride, Report

CUSTOM_GCODE_PER_LAYER = "Metadata/custom_gcode_per_layer.xml"

# Ajustes de PrusaSlicer que se trasladan (clave Prusa -> clave Orca).
PRUSA_PROCESS_KEYS = {
    "layer_height": "layer_height",
    "first_layer_height": "initial_layer_print_height",
    "perimeters": "wall_loops",
    "top_solid_layers": "top_shell_layers",
    "bottom_solid_layers": "bottom_shell_layers",
    "fill_density": "sparse_infill_density",
    "brim_width": "brim_width",
    "support_material": "enable_support",
}


@dataclass
class ConversionResult:
    report: Report
    files: dict[str, bytes] = field(default_factory=dict)  # entradas nuevas o reemplazadas
    removed: set[str] = field(default_factory=set)
    # placa -> filamentos usados (None = no determinable); para la vista previa del plugin
    usage: dict[str, set[int] | None] = field(default_factory=dict)


def _first(value, default=None):
    if isinstance(value, list):
        return value[0] if value else default
    return value if value is not None else default


def _split_diff(value) -> list[set[str]]:
    if not isinstance(value, list):
        return []
    return [{k for k in str(v).split(";") if k} for v in value]


def _prusa_settings(project: Project3MF) -> dict:
    """Ajustes Prusa traducidos a claves Orca (solo lo mínimo para elegir perfiles)."""
    ini = project.prusa_settings or {}
    out: dict = {
        "printer_model": ini.get("printer_model", "PrusaSlicer"),
        "printer_settings_id": ini.get("printer_settings_id", ""),
        "nozzle_diameter": ini.get("nozzle_diameter", "0.4").split(","),
        "filament_type": ini.get("filament_type", "PLA").split(";"),
        "filament_colour": ini.get("filament_colour", ini.get("extruder_colour", "#FFFFFF")).split(";"),
        "filament_settings_id": [s.strip('"') for s in ini.get("filament_settings_id", "").split(";")],
        "printable_area": ini.get("bed_shape", "0x0,250x0,250x210,0x210").split(","),
    }
    author = []
    for pkey, okey in PRUSA_PROCESS_KEYS.items():
        if pkey in ini:
            out[okey] = ini[pkey]
            author.append(okey)
    n = len(out["filament_type"])
    out["different_settings_to_system"] = [";".join(author)] + [""] * (n + 1)
    return out


def convert(
    project: Project3MF,
    lib: ProfileLibrary,
    nozzle: str | None = None,
    user_map: dict[int, int] | None = None,
    target=creator5pro,
) -> ConversionResult:
    report = Report(source=str(project.path), target=target.DISPLAY_NAME)
    result = ConversionResult(report=report)
    kind = detect_source(project)
    report.source_kind = kind
    if kind == SOURCE_FLASHFORGE:
        report.errors.append("el proyecto ya está configurado para una impresora Flashforge")
        return result
    if kind == SOURCE_UNKNOWN:
        report.errors.append("no se reconoce el origen (falta Metadata/project_settings.config)")
        return result

    src = _prusa_settings(project) if kind == SOURCE_PRUSA else copy.deepcopy(project.project_settings)
    out = copy.deepcopy(src)

    # --- Impresora -------------------------------------------------------
    src_nozzle = str(_first(src.get("nozzle_diameter"), target.DEFAULT_NOZZLE))
    nozzle = nozzle or (src_nozzle if src_nozzle in target.NOZZLES else target.DEFAULT_NOZZLE)
    if nozzle not in target.NOZZLES:
        report.errors.append(f"boquilla {nozzle} no disponible (opciones: {', '.join(target.NOZZLES)})")
        return result
    if nozzle != src_nozzle:
        report.warnings.append(f"boquilla de origen {src_nozzle} → destino {nozzle}; revisa anchos de línea")
    machine = target.machine_name(nozzle)
    report.presets.update(nozzle=nozzle, machine=machine)
    try:
        machine_cfg = lib.settings("machine", machine)
    except ProfileError as e:
        report.errors.append(str(e))
        return result
    limits = target.speed_limits(machine_cfg)

    reasons: dict[str, str] = {}

    def put(key, value, reason):
        out[key] = value
        reasons[key] = reason

    for k, v in machine_cfg.items():
        put(k, v, "perfil de impresora destino")
    for k in target.GCODE_KEYS:
        if k not in machine_cfg and out.get(k):
            put(k, "", "G-code de origen sin equivalente en el destino")

    # --- Proceso ---------------------------------------------------------
    diffs = _split_diff(src.get("different_settings_to_system"))
    author_process = diffs[0] if diffs else set()
    try:
        layer_height = float(_first(src.get("layer_height"), 0.2))
    except (TypeError, ValueError):
        layer_height = 0.2
    try:
        process = target.pick_process(lib, machine, layer_height)
        process_cfg = lib.settings("process", process)
        report.presets["process"] = process
    except ProfileError as e:
        report.errors.append(str(e))
        return result
    cooling_reason = "enfriamiento: depende de los ventiladores de la máquina, manda el perfil C5P"
    for k, v in process_cfg.items():
        if k in target.KEEP_SOURCE_PROCESS_KEYS and k in src and src[k] != v and k not in author_process:
            report.kept_author.append(FieldChange(k, src[k], v, target.KEEP_SOURCE_PROCESS_KEYS[k]))
            out[k] = src[k]
        elif k in author_process and k in src and not target.is_cooling_key(k):
            report.kept_author.append(FieldChange(k, src[k], v, "ajuste del autor sobre perfil de proceso"))
            out[k] = src[k]
        else:
            if k in author_process and k in src and src[k] != v:
                report.dropped.append(FieldChange(k, src[k], v, cooling_reason))
            put(k, v, "perfil de proceso destino")
    for k in sorted(author_process - set(process_cfg)):
        if k in src and not target.is_cooling_key(k):
            report.kept_author.append(FieldChange(k, src[k], "(sin valor en perfil)", "ajuste del autor"))
    _collapse_variants(src, out, set(machine_cfg), target, put)
    for c in report.kept_author:
        msg = target.check_value(c.key, out.get(c.key, c.original), limits)
        if msg:
            report.warnings.append(f"ajuste del autor: {msg} (se conserva)")

    # --- Uso de filamentos por placa ---------------------------------------
    ftypes = [str(t) for t in (src.get("filament_type") or ["PLA"])]
    n = len(ftypes)
    fids = list(src.get("filament_settings_id") or [""] * n) + [""] * n
    colours = list(src.get("filament_colour") or ["#FFFFFF"] * n) + ["#FFFFFF"] * n

    ms_root = project.model_settings()
    info = model_edit.read_model_info(ms_root)
    painted = set()
    if project.has(MODEL_FILE):
        geometry = {name: project.read(name) for name in project.geometry_names()}
        painted = model_edit.painted_objects(project.read(MODEL_FILE), geometry)
    per_layer = model_edit.layer_change_filaments(
        project.read(CUSTOM_GCODE_PER_LAYER) if project.has(CUSTOM_GCODE_PER_LAYER) else None)
    usage: dict[str, set[int] | None] = {}
    for pid, objects in (info.plates or {"1": list(info.object_names)}).items():
        if "*" in painted or any(o in painted for o in objects):
            usage[pid] = None
            continue
        used: set[int] = set(per_layer.get(pid, set()))
        for o in objects:
            used |= info.object_filaments.get(o, {1})
        usage[pid] = {f for f in used if 1 <= f <= n} or {1}

    result.usage = usage
    assignment = assign(ftypes, usage, target.EXTRUDERS, user_map)
    report.warnings.extend(assignment.warnings)
    if assignment.errors:
        report.errors.extend(assignment.errors)
        for i in range(n):
            report.filaments.append(FilamentMapping(
                i + 1, fids[i], ftypes[i], colours[i], target.pick_filament(lib, machine, ftypes[i], fids[i])))
        return result
    used_anywhere = set().union(*[u if u is not None else set(range(1, n + 1)) for u in usage.values()])

    # --- Filamentos --------------------------------------------------------
    fprofiles: list[str | None] = []
    for i in range(n):
        name = target.pick_filament(lib, machine, ftypes[i], fids[i])
        fprofiles.append(name)
        mapping = FilamentMapping(i + 1, fids[i], ftypes[i], colours[i], name,
                                  {p: m[i] for p, m in assignment.per_plate.items()
                                   if usage.get(p) is None or i + 1 in usage[p]})
        report.filaments.append(mapping)
        if name is None:
            msg = f"filamento #{i + 1} '{fids[i]}' ({ftypes[i]}) no tiene equivalente para {target.DISPLAY_NAME}"
            if i + 1 in used_anywhere:
                report.errors.append(msg)
            else:
                report.warnings.append(msg + "; no se usa en ninguna placa, se dejan sus valores de origen")
    if report.errors:
        return result

    fcfgs = [lib.settings("filament", p) if p else None for p in fprofiles]
    fkeys = sorted(set().union(*[set(c) for c in fcfgs if c]))
    for k in fkeys:
        values = []
        for i, cfg in enumerate(fcfgs):
            if cfg is not None and k in cfg:
                values.append(_first(cfg[k], "") if isinstance(cfg[k], list) else cfg[k])
            elif isinstance(src.get(k), list) and i < len(src[k]):
                values.append(src[k][i])
            else:
                fallback = next(c[k] for c in fcfgs if c and k in c)
                values.append(_first(fallback, "") if isinstance(fallback, list) else fallback)
        put(k, values if isinstance(next(c[k] for c in fcfgs if c and k in c), list) else values[0],
            "perfil de filamento destino")
    for i in range(n):
        author_f = diffs[i + 1] if len(diffs) > i + 1 else set()
        for k in sorted(author_f):
            if fcfgs[i] is not None and k in fcfgs[i] and isinstance(src.get(k), list) and i < len(src[k]):
                report.dropped.append(FieldChange(
                    f"{k}[filamento {i + 1}]", src[k][i], out[k][i] if isinstance(out[k], list) else out[k],
                    "ajuste del autor para filamento Bambu; manda el perfil de filamento C5P"))

    _note_volumetric(out, report, [i for i in range(n) if i + 1 in used_anywhere])

    put("filament_settings_id", [p or fids[i] for i, p in enumerate(fprofiles)], "perfiles de filamento destino")
    filament_ids = [lib.resolve("filament", p).get("filament_id", "") if p else "" for p in fprofiles]
    if any(filament_ids):
        put("filament_ids", filament_ids, "perfiles de filamento destino")
    out["filament_colour"] = colours[:n]
    gmap = assignment.global_map(n)
    put("filament_map", [str(e) for e in gmap], "asignación de filamentos a extrusores")
    highest = max((e for m in assignment.per_plate.values() for e in m), default=1)
    if user_map is None and highest > target.ORCA_MANUAL_MAX_EXTRUDER:
        map_mode = target.MAP_MODE_AUTO
        report.warnings.append(
            "se usan los extrusores 3–4: la asignación queda en modo automático porque OrcaSlicer "
            "rechaza el modo manual en ellos; el slicer confirma la asignación prevista al laminar")
    else:
        map_mode = target.MAP_MODE_MANUAL
        if highest > target.ORCA_MANUAL_MAX_EXTRUDER:
            report.warnings.append(
                "--map usa los extrusores 3–4 en modo manual: Flash Studio lo acepta, "
                "OrcaSlicer 2.5 lo rechaza al laminar")
    put("filament_map_mode", map_mode, "modo de asignación de filamentos a extrusores")
    put("filament_printable", [target.FILAMENT_PRINTABLE_ALL] * n,
        f"cada filamento puede ir en los {target.EXTRUDERS} extrusores")
    ext_colours = list(machine_cfg.get("extruder_colour") or ["#FFFFFF"] * target.EXTRUDERS)
    for i in reversed(range(n)):
        ext_colours[gmap[i] - 1] = colours[i]
    put("extruder_colour", ext_colours, "color del filamento asignado a cada extrusor")

    # --- Identificadores de preset ---------------------------------------
    put("printer_settings_id", machine, "preset de impresora destino")
    put("print_settings_id", process, "preset de proceso destino")
    put("print_compatible_printers", [machine], "preset de proceso destino")
    put("inherits_group", [process, *[p or "" for p in fprofiles], machine], "presets destino")
    put("different_settings_to_system",
        [";".join(sorted(c.key for c in report.kept_author if c.key in out))] + [""] * n + [""],
        "ajustes del autor sobre presets destino")
    if "curr_bed_type" in out and out["curr_bed_type"] != target.BED_TYPE:
        put("curr_bed_type", target.BED_TYPE, "placa de la impresora destino")
    report.presets["filaments"] = fprofiles

    # --- Eliminar específico de Bambu --------------------------------------
    # Solo si el perfil destino no la define (la C5P sí define p. ej. nozzle_volume).
    for k in sorted(k for k in target.BAMBU_ONLY_KEYS & set(out) if k not in reasons):
        report.dropped.append(FieldChange(k, out.pop(k), None, "específico de hardware Bambu"))
    # Enfriamiento del origen que el perfil C5P no define: fuera, Orca usa su valor por defecto.
    for k in sorted(k for k in out if k not in reasons and target.is_cooling_key(k)):
        report.dropped.append(FieldChange(k, out.pop(k), None, cooling_reason + " (sin valor C5P)"))
    for k, fixes in target.VALUE_FIXES.items():
        if k in out and isinstance(out[k], str) and out[k] in fixes:
            fixed = fixes[out[k]]
            if fixed is None:
                report.dropped.append(
                    FieldChange(k, out.pop(k), None, "valor no válido en OrcaSlicer; se usa el de Orca"))
            else:
                put(k, fixed, "valor equivalente válido en OrcaSlicer")
    for k, v in out.items():
        text = "\n".join(v) if isinstance(v, list) and all(isinstance(x, str) for x in v) else v
        marker = target.BAMBU_GCODE_MARKERS.search(text) if isinstance(text, str) else None
        if marker:
            report.warnings.append(f"{k} contiene G-code propio de Bambu ({marker.group(0)})")

    for k in sorted(set(out) | set(src)):
        if k in reasons and src.get(k) != out.get(k):
            report.change(k, src.get(k, "(no existía)"), out.get(k), reasons[k])

    result.files[PROJECT_SETTINGS] = (json.dumps(out, indent=4, ensure_ascii=False) + "\n").encode("utf-8")

    # --- model_settings.config ------------------------------------------
    if ms_root is not None:
        _edit_model_settings(ms_root, info, assignment.per_plate, map_mode, target, limits, report)
        result.files[MODEL_SETTINGS] = model_edit.serialize(ms_root)

    # --- Posición en plato ------------------------------------------------
    if project.has(MODEL_FILE) and src.get("printable_area") and machine_cfg.get("printable_area"):
        plate_ids = list(info.plates) or ["1"]
        item_plate = {oid: idx for idx, pid in enumerate(plate_ids) for oid in info.plates.get(pid, [])}
        new_xml, moves = model_edit.shift_items(
            project.read(MODEL_FILE), item_plate, len(plate_ids),
            src["printable_area"], machine_cfg["printable_area"])
        for oid, before, after in moves:
            report.positions.append(FieldChange(
                f"{info.object_names.get(oid, oid)} (id {oid})", before, after,
                "recentrado al plato de destino"))
        if moves:
            result.files[MODEL_FILE] = new_xml
    return result


def _collapse_variants(src: dict, out: dict, machine_keys: set[str], target, put) -> None:
    """Bambu Studio 2.x guarda velocidades por variante de extrusor
    (`print_extruder_variant`, p. ej. [Standard, High Flow]). El destino tiene una
    sola variante: se toma el valor de la variante estándar."""
    variants = src.get("print_extruder_variant")
    if not isinstance(variants, list) or len(variants) < 2:
        return
    idx = variants.index(target.EXTRUDER_VARIANT) if target.EXTRUDER_VARIANT in variants else 0
    for k, v in list(out.items()):
        if (k in machine_keys or not k.endswith(target.VARIANT_KEY_SUFFIXES)
                or k.startswith("filament_") or not isinstance(v, list) or len(v) != len(variants)):
            continue
        put(k, v[idx], f"valor de la variante '{variants[idx]}' (el destino tiene una sola)")
    put("print_extruder_variant", [target.EXTRUDER_VARIANT], "variante de extrusor del destino")
    put("print_extruder_id", ["1"], "variante de extrusor del destino")


def _num(value) -> float | None:
    value = _first(value)
    try:
        return float(str(value).rstrip("%")) if value not in (None, "") and not str(value).endswith("%") else None
    except ValueError:
        return None


def _note_volumetric(out: dict, report: Report, used: list[int]) -> None:
    """Nota (no advertencia) cuando un ajuste del autor pide más caudal del que admite el
    filamento C5P: el slicer limita cada movimiento a `filament_max_volumetric_speed`
    (comprobado en el G-code), así que no hace falta cambiar nada."""
    caps = [_num(v) for i, v in enumerate(out.get("filament_max_volumetric_speed") or []) if i in used]
    caps = [c for c in caps if c]
    layer = _num(out.get("layer_height"))
    if not caps or not layer:
        return
    cap = min(caps)
    capped = []
    for c in report.kept_author:
        # gap_infill: ancho de línea variable, no se puede estimar (en el G-code va sin limitar).
        if not c.key.endswith("_speed") or c.key.startswith("gap_infill"):
            continue
        speed = _num(out.get(c.key))
        width = _num(out.get(c.key.replace("_speed", "_line_width"))) or _num(out.get("line_width"))
        if speed and width and speed * width * layer > cap:
            # Sección de línea de Orca: rectángulo con extremos redondeados.
            area = (width - layer * (1 - math.pi / 4)) * layer
            capped.append(f"{c.key} {speed:g} mm/s (~{cap / area:.0f} mm/s reales)")
    if capped:
        report.notes.append(
            f"El filamento C5P admite {cap:g} mm³/s; el slicer limita solo estas velocidades del "
            f"autor, sin cambiar el ajuste: " + ", ".join(capped))


def _edit_model_settings(root, info, per_plate, map_mode, target, limits, report: Report) -> None:
    for obj in root.findall("object"):
        oname = info.object_names.get(obj.get("id", ""), obj.get("id", ""))
        targets = [(None, obj)] + [(model_edit.meta(p).get("name", f"pieza {p.get('id')}"), p)
                                   for p in obj.findall("part")]
        for part_name, el in targets:
            for key, value in model_edit.meta(el).items():
                if key in model_edit.STRUCTURAL_KEYS:
                    continue
                fixes = target.VALUE_FIXES.get(key, {})
                if value in fixes and fixes[value] is not None:
                    model_edit.set_meta(el, key, fixes[value])
                    report.object_overrides.append(ObjectOverride(
                        oname, part_name, key, value, fixes[value], "valor equivalente válido en OrcaSlicer"))
                    continue
                msg = target.check_value(key, value, limits)
                reason = "conservado" if not msg else f"conservado; ADVERTENCIA: {msg}"
                report.object_overrides.append(ObjectOverride(oname, part_name, key, value, value, reason))
                if msg:
                    where = oname + (f" / {part_name}" if part_name else "")
                    report.warnings.append(f"{where}: {msg} (override conservado)")
    for plate in root.findall("plate"):
        pid = model_edit.meta(plate).get("plater_id", "1")
        mapping = per_plate.get(pid)
        if mapping is None:
            continue
        new_maps = " ".join(str(e) for e in mapping)
        old = model_edit.set_meta(plate, "filament_maps", new_maps)
        if old != new_maps:
            report.plates.append(FieldChange(f"placa {pid} filament_maps", old, new_maps, "extrusores destino"))
        old = model_edit.set_meta(plate, "filament_map_mode", map_mode)
        if old != map_mode:
            report.plates.append(FieldChange(f"placa {pid} filament_map_mode", old, map_mode, "modo de asignación"))
        bed = model_edit.meta(plate).get("curr_bed_type")
        if bed and bed != target.BED_TYPE:
            model_edit.set_meta(plate, "curr_bed_type", target.BED_TYPE)
            report.plates.append(FieldChange(f"placa {pid} curr_bed_type", bed, target.BED_TYPE, "placa destino"))
