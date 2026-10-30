"""Edición de `model_settings.config` y `3D/3dmodel.model`.

`3D/Objects/*.model` (la geometría) nunca se modifica. En `3dmodel.model` solo
se reescribe el atributo `transform` de los `<item>` del `<build>` cuando el
plato de destino tiene otro tamaño.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

# Bambu/Orca separan las placas virtuales por un 20 % del tamaño del plato.
PLATE_GAP = 0.2

# Metadatos de objeto/pieza que no son ajustes de impresión.
STRUCTURAL_KEYS = frozenset({
    "name", "matrix", "extruder", "source_file", "source_object_id", "source_volume_id",
    "source_offset_x", "source_offset_y", "source_offset_z", "source_in_inches",
    "source_in_meters", "mesh_stat", "volume_type", "id", "face_count", "is_cut",
})


@dataclass
class ModelInfo:
    object_names: dict[str, str] = field(default_factory=dict)        # id -> nombre
    object_filaments: dict[str, set[int]] = field(default_factory=dict)  # id -> filamentos usados
    plates: dict[str, list[str]] = field(default_factory=dict)        # plater_id -> [object_id]


def meta(el: ET.Element) -> dict[str, str]:
    return {m.get("key"): m.get("value", "") for m in el.findall("metadata") if m.get("key")}


def set_meta(el: ET.Element, key: str, value: str) -> str | None:
    """Fija `<metadata key=... value=...>`; devuelve el valor anterior (None si no existía)."""
    for m in el.findall("metadata"):
        if m.get("key") == key:
            old = m.get("value")
            m.set("value", value)
            return old
    node = ET.Element("metadata", {"key": key, "value": value})
    # Antes del primer hijo que no sea metadata, para mantener el orden habitual.
    children = list(el)
    idx = next((i for i, c in enumerate(children) if c.tag != "metadata"), len(children))
    el.insert(idx, node)
    return None


def read_model_info(root: ET.Element | None) -> ModelInfo:
    info = ModelInfo()
    if root is None:
        return info
    for obj in root.findall("object"):
        oid = obj.get("id", "")
        m = meta(obj)
        info.object_names[oid] = m.get("name", f"objeto {oid}")
        used = {int(m.get("extruder") or 1)}
        for part in obj.findall("part"):
            pm = meta(part)
            if pm.get("extruder"):
                used.add(int(pm["extruder"]))
        info.object_filaments[oid] = used
    for plate in root.findall("plate"):
        pid = meta(plate).get("plater_id", str(len(info.plates) + 1))
        info.plates[pid] = [meta(mi).get("object_id", "") for mi in plate.findall("model_instance")]
    return info


def painted_objects(model_xml: bytes, geometry: dict[str, bytes]) -> set[str]:
    """Ids de objeto (3dmodel.model) cuya malla tiene pintura de color."""
    painted_files = {name for name, data in geometry.items() if _has_paint(data)}
    out: set[str] = set()
    if _has_paint(model_xml):
        out.add("*")  # malla pintada dentro del propio 3dmodel.model: no se sabe qué objeto
    if not painted_files:
        return out
    # Solo etiquetas <object>/<component>: el archivo puede traer mallas enormes y
    # un parseo XML completo tarda segundos.
    current = ""
    for m in _TAG_RE.finditer(model_xml):
        tag, attrs = m.group(1), m.group(2)
        if tag == b"object":
            oid = re.search(rb'\bid="([^"]*)"', attrs)
            current = oid.group(1).decode() if oid else ""
        else:
            path = re.search(rb'path="([^"]*)"', attrs)
            if path and path.group(1).decode().lstrip("/") in painted_files:
                out.add(current)
    return out


_TAG_RE = re.compile(rb"<(object|component)\b([^>]*)>")


def _has_paint(data: bytes) -> bool:
    return b"paint_color" in data or b"mmu_segmentation" in data


def layer_change_filaments(xml: bytes | None) -> dict[str, set[int]]:
    """Filamentos referenciados por cambios por capa (`custom_gcode_per_layer.xml`)."""
    out: dict[str, set[int]] = {}
    if not xml:
        return out
    root = ET.fromstring(xml)
    for plate in root.findall("plate"):
        info = plate.find("plate_info")
        pid = info.get("id", "1") if info is not None else "1"
        for layer in plate.findall("layer"):
            ext = layer.get("extruder")
            if ext and ext.isdigit() and int(ext) > 0:
                out.setdefault(pid, set()).add(int(ext))
    return out


def bed_box(area: list[str]) -> tuple[float, float, float, float]:
    pts = [tuple(float(v) for v in p.split("x")) for p in area]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def plate_origin(index: int, plate_count: int, box: tuple[float, float, float, float]) -> tuple[float, float]:
    cols = max(1, math.ceil(math.sqrt(plate_count)))
    w, d = box[2] - box[0], box[3] - box[1]
    row, col = divmod(index, cols)
    return col * w * (1 + PLATE_GAP), -row * d * (1 + PLATE_GAP)


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


_ITEM_RE = re.compile(rb"<item\b[^>]*>")
_ATTR_RE = rb'\b%s="([^"]*)"'


def shift_items(
    model_xml: bytes,
    item_plate: dict[str, int],
    plate_count: int,
    src_area: list[str],
    dst_area: list[str],
) -> tuple[bytes, list[tuple[str, str, str]]]:
    """Recoloca cada `<item>` conservando su posición relativa al centro del plato.

    Devuelve el XML (sin tocar si no hay cambios) y [(objectid, antes, después)].
    """
    src, dst = bed_box(src_area), bed_box(dst_area)
    if src == dst:
        return model_xml, []
    changes: list[tuple[str, str, str]] = []

    def fix(match: re.Match) -> bytes:
        tag = match.group(0)
        oid_m = re.search(_ATTR_RE % b"objectid", tag)
        tr_m = re.search(_ATTR_RE % b"transform", tag)
        if not oid_m or not tr_m:
            return tag
        oid = oid_m.group(1).decode()
        idx = item_plate.get(oid, 0)
        sx, sy = plate_origin(idx, plate_count, src)
        dx, dy = plate_origin(idx, plate_count, dst)
        delta_x = (dx + (dst[0] + dst[2]) / 2) - (sx + (src[0] + src[2]) / 2)
        delta_y = (dy + (dst[1] + dst[3]) / 2) - (sy + (src[1] + src[3]) / 2)
        values = tr_m.group(1).decode().split()
        if len(values) != 12:
            return tag
        before = " ".join(values)
        values[9] = _num(float(values[9]) + delta_x)
        values[10] = _num(float(values[10]) + delta_y)
        after = " ".join(values)
        changes.append((oid, before, after))
        return tag[: tr_m.start(1)] + after.encode() + tag[tr_m.end(1):]

    return _ITEM_RE.sub(fix, model_xml), changes


def serialize(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="UTF-8", xml_declaration=True)
