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


def painted_filaments(model_xml: bytes, geometry: dict[str, bytes]) -> dict[str, set[int]]:
    """Filaments painted on each object of 3dmodel.model: {object id: {filament, …}}.

    Reads the colour painting of every triangle (Bambu `paint_color`, PrusaSlicer
    `slic3rpe:mmu_segmentation`). Painted state 0 means the part's own filament, which
    the caller already knows; only states ≥ 1 are returned. Objects without painting
    are absent.
    """
    by_file = {name: _paint_states(data) for name, data in geometry.items() if _has_paint(data)}
    out: dict[str, set[int]] = {}
    # Meshes inside 3dmodel.model itself: per <object> block.
    if _has_paint(model_xml):
        for m in _OBJECT_BLOCK_RE.finditer(model_xml):
            states = _paint_states(m.group(2))
            if states:
                out.setdefault(m.group(1).decode(), set()).update(states)
    if not by_file:
        return out
    # Only <object>/<component> tags: the file can hold huge meshes and a full XML parse
    # takes seconds.
    current = ""
    for m in _TAG_RE.finditer(model_xml):
        tag, attrs = m.group(1), m.group(2)
        if tag == b"object":
            oid = re.search(rb'\bid="([^"]*)"', attrs)
            current = oid.group(1).decode() if oid else ""
        else:
            path = re.search(rb'path="([^"]*)"', attrs)
            states = by_file.get(path.group(1).decode().lstrip("/")) if path else None
            if states:
                out.setdefault(current, set()).update(states)
    return out


_TAG_RE = re.compile(rb"<(object|component)\b([^>]*)>")
_OBJECT_BLOCK_RE = re.compile(rb'<object\b[^>]*\bid="([^"]*)"[^>]*>(.*?)</object>', re.S)


def _has_paint(data: bytes) -> bool:
    return b"paint_color" in data or b"mmu_segmentation" in data


_PAINT_KEYS = (b'paint_color="', b'slic3rpe:mmu_segmentation="')


def paint_code_set(data: bytes) -> set[bytes]:
    """The distinct paint codes of a mesh file.

    Meshes reach hundreds of MB: plain bytes.find is ~4× faster than a regex here, and
    triangles share few distinct codes.
    """
    codes: set[bytes] = set()
    for key in _PAINT_KEYS:
        start = data.find(key)
        while start != -1:
            start += len(key)
            end = data.index(b'"', start)
            codes.add(data[start:end])
            start = data.find(key, end)
    return codes


def paint_count(data: bytes) -> int:
    return sum(data.count(key) for key in _PAINT_KEYS)


def _paint_states(data: bytes) -> set[int]:
    """Painted filaments (states ≥ 1) of every triangle in a mesh file, each code decoded once."""
    codes = paint_code_set(data)
    states: set[int] = set()
    for code in codes:
        states |= decode_paint(code.decode("ascii", "replace"))
    states.discard(0)
    return states


def decode_paint(code: str) -> set[int]:
    """States of the leaves of one triangle's paint code (TriangleSelector serialization).

    The hex string is read from its last character; each character is a 4-bit code.
    A code with split sides (low 2 bits ≠ 0) is followed by its children, depth first;
    a leaf holds its state in the high 2 bits, or "11" plus one more code (state − 3),
    or "11", 0b1111 and one more code (state − 18). Same format as OrcaSlicer and
    PrusaSlicer (libslic3r/TriangleSelector.cpp, FacetsAnnotation::set_triangle_from_string).
    """
    try:
        codes = [int(c, 16) for c in reversed(code)]
    except ValueError:
        return set()  # malformed: ignored, like the slicer does
    states: set[int] = set()
    i, pending = 0, 1  # nodes still to read
    while pending and i < len(codes):
        c = codes[i]
        i += 1
        pending -= 1
        split_sides = c & 0b11
        if split_sides:
            pending += split_sides + 1
            continue
        if c & 0b1100 == 0b1100:
            if i >= len(codes):
                break
            extra = codes[i]
            i += 1
            if extra == 0b1111:
                if i >= len(codes):
                    break
                states.add(codes[i] + 18)
                i += 1
            else:
                states.add(extra + 3)
        else:
            states.add(c >> 2)
    return states


def _leaf_codes(state: int) -> list[int]:
    if state < 3:
        return [state << 2]
    if state <= 17:
        return [0b1100, state - 3]
    return [0b1100, 0b1111, state - 18]


def remap_paint(code: str, mapping: dict[int, int]) -> str:
    """The same paint code with its filaments renumbered (`mapping`: old → new state).

    Split nodes are kept as they are, so the triangle's subdivision does not change; only
    each leaf's state is rewritten (its encoding may grow or shrink: 2 → 3 is "8" → "0C").
    A malformed code is returned unchanged.
    """
    try:
        codes = [int(c, 16) for c in reversed(code)]
    except ValueError:
        return code
    out: list[int] = []
    i, pending = 0, 1
    while pending and i < len(codes):
        c = codes[i]
        i += 1
        pending -= 1
        split_sides = c & 0b11
        if split_sides:
            out.append(c)
            pending += split_sides + 1
            continue
        if c & 0b1100 == 0b1100:
            if i >= len(codes):
                return code
            extra = codes[i]
            i += 1
            if extra == 0b1111:
                if i >= len(codes):
                    return code
                state = codes[i] + 18
                i += 1
            else:
                state = extra + 3
        else:
            state = c >> 2
        out.extend(_leaf_codes(mapping.get(state, state)))
    if pending:
        return code  # truncated: leave it alone
    out.extend(codes[i:])
    return "".join(f"{n:X}" for n in reversed(out))


def remap_paint_bytes(data: bytes, mapping: dict[int, int]) -> bytes:
    """A mesh file with every paint code renumbered; everything else byte for byte."""
    if not _has_paint(data):
        return data
    cache: dict[bytes, bytes] = {}
    for key in _PAINT_KEYS:
        parts, pos = [], 0
        start = data.find(key)
        while start != -1:
            start += len(key)
            end = data.index(b'"', start)
            code = data[start:end]
            if code not in cache:
                cache[code] = remap_paint(code.decode("ascii", "replace"), mapping).encode()
            parts += [data[pos:start], cache[code]]
            pos = end
            start = data.find(key, end)
        parts.append(data[pos:])
        data = b"".join(parts)
    return data


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
