"""Pipeline de conversión: proyecto 3MF de origen -> proyecto para la impresora destino.

No escribe nada en disco: devuelve el reporte y los archivos modificados.
"""

from __future__ import annotations

import copy
import json
import math
from dataclasses import dataclass, field

from . import model_edit, rules
from .i18n import t
from .profiles import ProfileError
from .read_3mf import (
    MODEL_FILE,
    MODEL_SETTINGS,
    PROJECT_SETTINGS,
    SOURCE_PRUSA,
    SOURCE_UNKNOWN,
    Project3MF,
    detect_source,
)
from .remap_filaments import assign
from .report import FieldChange, FilamentMapping, ObjectOverride, Report
from .target import Target

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
    target: Target,
    nozzle: str | None = None,
    user_map: dict[int, int] | None = None,
    keep_designer_filament: bool = True,
    keep_designer_cooling: bool = False,
    keep_designer_printer_settings: bool = False,
    map_mode: str = rules.MAP_COMPATIBLE,
) -> ConversionResult:
    """Convierte `project` para la impresora `target`.

    `nozzle`: diámetro de boquilla destino; por defecto el del proyecto si el modelo
    destino tiene esa variante, si no la del preset elegido.
    `keep_designer_filament`: conservar las temperaturas y la densidad que el diseñador
    cambió en sus filamentos (ver rules.DESIGNER_FILAMENT_KEEP).
    `keep_designer_cooling`: conservar también el enfriamiento que cambió el diseñador
    (proceso y filamentos); por defecto manda el perfil destino porque los ventiladores
    cambian de una impresora a otra.
    `keep_designer_printer_settings`: conservar también los ajustes de proceso que dependen
    de la impresora (torre de purga, aceleraciones, calibración; ver rules.PRINTER_PROCESS_KEY).
    `map_mode`: rules.MAP_COMPATIBLE | MAP_EXACT | MAP_BY_SLICER (ver options.py).
    """
    if map_mode not in rules.MAP_MODES:
        raise ValueError(f"map_mode must be one of {rules.MAP_MODES}, not {map_mode!r}")

    def keep_process_key(k: str) -> bool:
        if rules.is_cooling_key(k):
            return keep_designer_cooling
        if rules.is_printer_process_key(k):
            return keep_designer_printer_settings
        return True

    def process_reason(k: str) -> str:
        return t("reason.cooling") if rules.is_cooling_key(k) else t("reason.printer_setting")

    report = Report(source=str(project.path), target=target.display_name, profiles=target.lib.source)
    result = ConversionResult(report=report)
    kind = detect_source(project)
    report.source_kind = kind
    if kind == SOURCE_UNKNOWN:
        report.errors.append(t("convert.error.unknown_source"))
        return result

    src = _prusa_settings(project) if kind == SOURCE_PRUSA else copy.deepcopy(project.project_settings)
    out = copy.deepcopy(src)
    if target.is_same_printer(src):
        report.errors.append(t("convert.error.already_target", target=target.display_name))
        return result

    # --- Impresora -------------------------------------------------------
    src_nozzle = str(_first(src.get("nozzle_diameter"), target.nozzle))
    variants = target.nozzle_variants()
    wanted = nozzle or (src_nozzle if src_nozzle in variants else target.nozzle)
    try:
        target = target.with_nozzle(wanted)
    except ProfileError as e:
        report.errors.append(str(e))
        return result
    if target.nozzle != src_nozzle:
        report.warnings.append(t("convert.warn.nozzle_changed", source=src_nozzle, target=target.nozzle))
    lib = target.lib
    machine = target.machine
    report.presets.update(nozzle=target.nozzle, machine=machine)
    machine_cfg = target.settings
    limits = target.limits

    reasons: dict[str, str] = {}

    def put(key, value, reason):
        out[key] = value
        reasons[key] = reason

    for k, v in machine_cfg.items():
        put(k, v, t("reason.target_machine"))
    for k in rules.GCODE_KEYS:
        if k not in machine_cfg and out.get(k):
            put(k, "", t("reason.gcode_no_equivalent"))

    # --- Proceso ---------------------------------------------------------
    diffs = _split_diff(src.get("different_settings_to_system"))
    author_process = diffs[0] if diffs else set()
    try:
        layer_height = float(_first(src.get("layer_height"), 0.2))
    except (TypeError, ValueError):
        layer_height = 0.2
    try:
        process = target.pick_process(layer_height)
        process_cfg = lib.settings("process", process)
        report.presets["process"] = process
    except ProfileError as e:
        report.errors.append(str(e))
        return result
    for k, v in process_cfg.items():
        if k in rules.KEEP_SOURCE_PROCESS_KEYS and k in src and src[k] != v and k not in author_process:
            report.kept_author.append(FieldChange(k, src[k], v, t(rules.KEEP_SOURCE_PROCESS_KEYS[k])))
            out[k] = src[k]
        elif k in author_process and k in src and keep_process_key(k):
            report.kept_author.append(FieldChange(k, src[k], v, t("reason.author_on_process")))
            out[k] = src[k]
        else:
            if k in author_process and k in src and src[k] != v:
                report.dropped.append(FieldChange(k, src[k], v, process_reason(k)))
            put(k, v, t("reason.target_process"))
    for k in sorted(author_process - set(process_cfg)):
        if k not in src or k in reasons:
            continue
        if keep_process_key(k):
            report.kept_author.append(FieldChange(k, src[k], t("value.no_profile_value"), t("reason.author")))
        elif rules.is_printer_process_key(k):
            # The target profile does not set it: the slicer's default applies.
            report.dropped.append(FieldChange(k, out.pop(k), None, process_reason(k)))
    _collapse_variants(src, out, set(machine_cfg), target, put)
    for c in report.kept_author:
        msg = rules.check_value(c.key, out.get(c.key, c.original), limits)
        if msg:
            report.warnings.append(t("convert.warn.author_limit", message=msg))

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
    assignment = assign(ftypes, usage, target.extruders, user_map, shared_nozzle=target.shared_nozzle)
    report.warnings.extend(assignment.warnings)
    report.needs_map = assignment.needs_map
    if assignment.errors:
        report.errors.extend(assignment.errors)
        for i in range(n):
            report.filaments.append(FilamentMapping(
                i + 1, fids[i], ftypes[i], colours[i], target.pick_filament(ftypes[i], fids[i])))
        return result
    used_anywhere = set().union(*[u if u is not None else set(range(1, n + 1)) for u in usage.values()])

    # --- Filamentos --------------------------------------------------------
    fprofiles: list[str | None] = []
    for i in range(n):
        name = target.pick_filament(ftypes[i], fids[i])
        fprofiles.append(name)
        mapping = FilamentMapping(i + 1, fids[i], ftypes[i], colours[i], name,
                                  {p: m[i] for p, m in assignment.per_plate.items()
                                   if usage.get(p) is None or i + 1 in usage[p]})
        report.filaments.append(mapping)
        if name is None:
            msg = t("convert.warn.filament_no_equivalent", index=i + 1, profile=fids[i], type=ftypes[i],
                    target=target.display_name)
            if i + 1 in used_anywhere:
                report.errors.append(msg)
            else:
                report.warnings.append(t("convert.warn.filament_unused", message=msg))
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
            t("reason.target_filament"))
    kept_filament: dict[int, set[str]] = {}  # filamento -> claves del diseñador conservadas
    for i in range(n):
        author_f = diffs[i + 1] if len(diffs) > i + 1 else set()
        for k in sorted(author_f):
            if fcfgs[i] is None or not isinstance(src.get(k), list) or i >= len(src[k]):
                continue
            if rules.keep_designer_filament_key(k, keep_designer_filament, keep_designer_cooling) \
                    and isinstance(out.get(k), list):
                target_value = out[k][i] if i < len(out[k]) else None
                out[k][i] = src[k][i]
                kept_filament.setdefault(i, set()).add(k)
                report.kept_author.append(FieldChange(
                    t("report.filament_key", key=k, index=i + 1), src[k][i], target_value,
                    t("reason.author_filament_kept")))
            elif k in fcfgs[i]:
                report.dropped.append(FieldChange(
                    t("report.filament_key", key=k, index=i + 1), src[k][i],
                    out[k][i] if isinstance(out[k], list) else out[k], t("reason.author_filament_replaced")))

    _note_volumetric(out, report, [i for i in range(n) if i + 1 in used_anywhere])

    put("filament_settings_id", [p or fids[i] for i, p in enumerate(fprofiles)], t("reason.target_filament_profiles"))
    filament_ids = [lib.resolve("filament", p).get("filament_id", "") if p else "" for p in fprofiles]
    if any(filament_ids):
        put("filament_ids", filament_ids, t("reason.target_filament_profiles"))
    out["filament_colour"] = colours[:n]
    gmap = assignment.global_map(n)
    put("filament_map", [str(e) for e in gmap], t("reason.filament_map"))
    highest = max((e for m in assignment.per_plate.values() for e in m), default=1)
    # Algunos laminadores solo respetan la asignación manual en los primeros extrusores
    # (OrcaSlicer 2.5: E1–E2); se lee del registro de laminadores (quirk).
    manual_limit = target.manual_map_max_extruder
    over_limit = manual_limit is not None and highest > manual_limit
    slicer_map_mode = _slicer_map_mode(map_mode, user_map, over_limit, target.extruders, report)
    put("filament_map_mode", slicer_map_mode, t("reason.filament_map_mode"))
    put("filament_printable", [target.filament_printable_all] * n,
        t("reason.filament_printable", count=target.extruders))
    ext_colours = list(machine_cfg.get("extruder_colour") or [])
    ext_colours += ["#FFFFFF"] * (target.extruders - len(ext_colours))
    for i in reversed(range(n)):
        ext_colours[gmap[i] - 1] = colours[i]
    put("extruder_colour", ext_colours, t("reason.extruder_colour"))

    # --- Identificadores de preset ---------------------------------------
    put("printer_settings_id", machine, t("reason.target_printer_preset"))
    put("print_settings_id", process, t("reason.target_process_preset"))
    put("print_compatible_printers", [machine], t("reason.target_process_preset"))
    put("inherits_group", [process, *[p or "" for p in fprofiles], machine], t("reason.target_presets"))
    put("different_settings_to_system",
        [";".join(sorted(c.key for c in report.kept_author if c.key in out))]
        + [";".join(sorted(kept_filament.get(i, ()))) for i in range(n)] + [""],
        t("reason.author_on_presets"))
    if target.bed_type and "curr_bed_type" in out and out["curr_bed_type"] != target.bed_type:
        put("curr_bed_type", target.bed_type, t("reason.target_bed"))
    report.presets["filaments"] = fprofiles

    # --- Eliminar específico de Bambu --------------------------------------
    # Solo si el perfil destino no la define (la C5P sí define p. ej. nozzle_volume).
    for k in sorted(k for k in rules.BAMBU_ONLY_KEYS & set(out) if k not in reasons):
        report.dropped.append(FieldChange(k, out.pop(k), None, t("reason.bambu_hardware")))
    # Enfriamiento del origen que el perfil C5P no define: fuera, Orca usa su valor por defecto.
    kept_keys = {c.key for c in report.kept_author}.union(*kept_filament.values())
    for k in sorted(k for k in out if k not in reasons and k not in kept_keys and rules.is_cooling_key(k)):
        report.dropped.append(FieldChange(k, out.pop(k), None, t("reason.cooling_no_value")))
    kept_cooling = sorted({c.key for c in report.kept_author if c.key in out and rules.is_cooling_key(c.key)}
                          | {k for ks in kept_filament.values() for k in ks if rules.is_cooling_key(k)})
    if kept_cooling:
        report.warnings.append(t("convert.warn.designer_cooling", keys=", ".join(kept_cooling)))
    kept_printer = sorted(c.key for c in report.kept_author if c.key in out and rules.is_printer_process_key(c.key))
    if kept_printer:
        report.warnings.append(t("convert.warn.designer_printer_settings", keys=", ".join(kept_printer)))
    for k, fixes in rules.VALUE_FIXES.items():
        value = out.get(k)
        values = value if isinstance(value, list) else [value]
        if k not in out or not values or not all(isinstance(v, str) and v in fixes for v in values):
            continue
        fixed = [fixes[v] for v in values]
        if any(f is None for f in fixed):
            report.dropped.append(FieldChange(k, out.pop(k), None, t("reason.invalid_in_orca")))
        else:
            put(k, fixed if isinstance(value, list) else fixed[0], t("reason.orca_equivalent"))
    for k, v in out.items():
        if k in machine_cfg and v == machine_cfg[k]:
            continue  # viene del perfil destino (p. ej. una impresora Bambu): es su G-code legítimo
        text = "\n".join(v) if isinstance(v, list) and all(isinstance(x, str) for x in v) else v
        marker = rules.BAMBU_GCODE_MARKERS.search(text) if isinstance(text, str) else None
        if marker:
            report.warnings.append(t("convert.warn.bambu_gcode", key=k, marker=marker.group(0)))

    for k in sorted(set(out) | set(src)):
        if k in reasons and src.get(k) != out.get(k):
            report.change(k, src.get(k, t("value.did_not_exist")), out.get(k), reasons[k])

    result.files[PROJECT_SETTINGS] = (json.dumps(out, indent=4, ensure_ascii=False) + "\n").encode("utf-8")

    # --- model_settings.config ------------------------------------------
    if ms_root is not None:
        _edit_model_settings(ms_root, info, assignment.per_plate, slicer_map_mode, target, limits, report)
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
                t("reason.recentered")))
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
    idx = variants.index(target.extruder_variant) if target.extruder_variant in variants else 0
    for k, v in list(out.items()):
        if (k in machine_keys or not k.endswith(rules.VARIANT_KEY_SUFFIXES)
                or k.startswith("filament_") or not isinstance(v, list) or len(v) != len(variants)):
            continue
        put(k, v[idx], t("reason.variant_value", variant=variants[idx]))
    put("print_extruder_variant", [target.extruder_variant], t("reason.target_variant"))
    put("print_extruder_id", ["1"], t("reason.target_variant"))


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
            capped.append(t("convert.note.volumetric_item", key=c.key, speed=f"{speed:g}", actual=f"{cap / area:.0f}"))
    if capped:
        report.notes.append(t("convert.note.volumetric", cap=f"{cap:g}", items=", ".join(capped)))


def _slicer_map_mode(map_mode: str, user_map, over_limit: bool, extruders: int, report: Report) -> str:
    """Slicer's `filament_map_mode` for the `map_mode` option.

    An assignment the user chose by hand (`user_map`) is always enforced (manual).
    Otherwise: compatible → automatic; exact → manual; slicer → manual unless the
    target slicer rejects manual mode on the extruders in use.
    """
    if user_map is not None or map_mode == rules.MAP_EXACT or (map_mode == rules.MAP_BY_SLICER and not over_limit):
        if over_limit:
            report.warnings.append(t("convert.warn.map_manual_e34"))
        return rules.MAP_MODE_MANUAL
    if map_mode == rules.MAP_BY_SLICER:
        report.warnings.append(t("convert.warn.map_auto_e34"))
    elif extruders > 1:
        report.notes.append(t("convert.note.map_compatible"))
    return rules.MAP_MODE_AUTO


def _edit_model_settings(root, info, per_plate, map_mode, target, limits, report: Report) -> None:
    for obj in root.findall("object"):
        oname = info.object_names.get(obj.get("id", ""), obj.get("id", ""))
        targets = [(None, obj)] + [(model_edit.meta(p).get("name", t("report.part", id=p.get("id"))), p)
                                   for p in obj.findall("part")]
        for part_name, el in targets:
            for key, value in model_edit.meta(el).items():
                if key in model_edit.STRUCTURAL_KEYS:
                    continue
                fixes = rules.VALUE_FIXES.get(key, {})
                if value in fixes and fixes[value] is not None:
                    model_edit.set_meta(el, key, fixes[value])
                    report.object_overrides.append(ObjectOverride(
                        oname, part_name, key, value, fixes[value], t("reason.orca_equivalent")))
                    continue
                msg = rules.check_value(key, value, limits)
                reason = t("reason.kept_warning", message=msg) if msg else t("reason.kept")
                report.object_overrides.append(ObjectOverride(oname, part_name, key, value, value, reason))
                if msg:
                    where = oname + (f" / {part_name}" if part_name else "")
                    report.warnings.append(t("convert.warn.override_limit", where=where, message=msg))
    for plate in root.findall("plate"):
        pid = model_edit.meta(plate).get("plater_id", "1")
        mapping = per_plate.get(pid)
        if mapping is None:
            continue
        new_maps = " ".join(str(e) for e in mapping)
        old = model_edit.set_meta(plate, "filament_maps", new_maps)
        if old != new_maps:
            report.plates.append(FieldChange(t("report.plate_key", plate=pid, key="filament_maps"), old, new_maps,
                                             t("reason.target_extruders")))
        old = model_edit.set_meta(plate, "filament_map_mode", map_mode)
        if old != map_mode:
            report.plates.append(FieldChange(t("report.plate_key", plate=pid, key="filament_map_mode"), old, map_mode,
                                             t("reason.map_mode")))
        bed = model_edit.meta(plate).get("curr_bed_type")
        if target.bed_type and bed and bed != target.bed_type:
            model_edit.set_meta(plate, "curr_bed_type", target.bed_type)
            report.plates.append(FieldChange(t("report.plate_key", plate=pid, key="curr_bed_type"), bed,
                                             target.bed_type, t("reason.target_bed")))
