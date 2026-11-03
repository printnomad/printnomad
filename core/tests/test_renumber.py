"""Renumbering a project's filaments: unused ones dropped, those sharing an extruder merged."""

import io
import json
import re
import zipfile

from conftest import FAKE_PRINTER, make_bambu_3mf
from printnomad import model_edit, read_3mf, renumber, write_3mf
from printnomad.convert import convert
from printnomad.profiles import ProfileLibrary
from printnomad.target import Target

COLOURS = ["#000000", "#2A2E32", "#FFFFFF", "#FF6A13", "#136935", "#EFB1D5"]
LAYERS = (b'<?xml version="1.0"?><custom_gcodes_per_layer><plate><plate_info id="1"/>'
          b'<layer top_z="2" type="2" extruder="5" color="#136935"/></plate></custom_gcodes_per_layer>')


def project_with_everything(tmp_path):
    """6 colours: painted 1–4, part on 6 via its own extruder, a layer change to 5."""
    path = make_bambu_3mf(tmp_path / "p.3mf", [("PLA", "Bambu PLA Basic @BBL A1", c) for c in COLOURS], [["2"]],
                          object_extruders={"2": 6}, paint=(1, 2, 3, 4), settings={
                              "flush_volumes_matrix": [str(10 * i + j) for i in range(1, 7) for j in range(1, 7)],
                              "flush_volumes_vector": [str(v) for v in range(12)],
                              "support_filament": "6", "wall_filament": "0"})
    buffer = io.BytesIO()
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as out:
        for item in src.infolist():
            out.writestr(item, src.read(item))
        out.writestr("Metadata/custom_gcode_per_layer.xml", LAYERS)
    path.write_bytes(buffer.getvalue())
    return read_3mf.load(path)


def test_plan():
    assert renumber.plan(3, {1, 2, 3}, None) is None                       # nothing to do
    p = renumber.plan(4, {2, 4}, None)
    assert p.reps == [2, 4] and p.new_of == {2: 1, 4: 2} and p.removed == [1, 3]
    m = renumber.plan(5, {1, 2, 3, 4, 5}, {1: 1, 2: 1, 3: 2, 4: 3, 5: 4})
    assert m.reps == [1, 3, 4, 5] and m.merged[1] == [1, 2] and m.user_map == {1: 1, 2: 2, 3: 3, 4: 4}


def test_every_reference_is_renumbered(tmp_path):
    project = project_with_everything(tmp_path)
    # 6 used filaments on 4 extruders: blacks (1, 2) together, 3+5 together, 4 and 6 alone.
    plan = renumber.plan(6, {1, 2, 3, 4, 5, 6}, {1: 1, 2: 1, 3: 2, 4: 3, 5: 2, 6: 4})
    reduced, changed = renumber.apply(project, plan)
    s = reduced.project_settings
    assert s["filament_colour"] == ["#000000", "#FFFFFF", "#FF6A13", "#EFB1D5"]
    assert s["support_filament"] == "4" and s["wall_filament"] == "0"
    old = [str(10 * i + j) for i in range(1, 7) for j in range(1, 7)]
    reps = [1, 3, 4, 6]
    assert s["flush_volumes_matrix"] == [old[(i - 1) * 6 + (j - 1)] for i in reps for j in reps]
    assert s["flush_volumes_vector"] == ["0", "1", "4", "5", "6", "7", "10", "11"]
    assert len(s["different_settings_to_system"]) == 6                     # process + 4 + machine
    assert b'key="extruder" value="4"' in changed[read_3mf.MODEL_SETTINGS]  # part on old 6 → 4
    assert b'extruder="2"' in changed["Metadata/custom_gcode_per_layer.xml"]  # layer change old 5 → 2
    geometry = reduced.geometry_names()[0]
    painted = model_edit.painted_filaments(reduced.read(read_3mf.MODEL_FILE), {geometry: reduced.read(geometry)})
    assert painted == {"2": {1, 2, 3}}                                      # old 1, 2 → 1; 3 → 2; 4 → 3
    # The mesh itself is untouched: only paint attribute values changed.
    strip = lambda b: re.sub(rb' paint_color="[0-9A-F]+"', b"", b)  # noqa: E731
    assert strip(changed[geometry]) == strip(project.read(geometry))


def test_converted_project_lists_one_filament_per_extruder(profiles_root, tmp_path):
    project = project_with_everything(tmp_path)
    target = Target(ProfileLibrary.load(profiles_root), FAKE_PRINTER)
    first = convert(project, target)
    assert first.report.needs_map                       # 6 colours on one plate, 4 extruders
    user_map = {1: 1, 2: 1, 3: 2, 4: 3, 5: 2, 6: 4}
    result = convert(project, target, user_map=user_map)
    assert result.report.ok, result.report.errors
    s = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert len(s["filament_colour"]) == 4 and s["filament_map"] == ["1", "2", "3", "4"]
    assert any("#1, #2" in c for c in result.report.filament_changes)
    dest = tmp_path / "out.3mf"
    write_3mf.write(project, dest, result.files, result.removed)
    assert write_3mf.verify(project, dest, result.files) == []


def test_lists_as_long_as_the_filament_count_are_not_mistaken_for_filament_lists(tmp_path):
    """Regression: a project with 4 filaments has a 4-corner printable_area; it must stay whole."""
    path = make_bambu_3mf(tmp_path / "q.3mf", [("PLA", "Bambu PLA Basic @BBL A1", c) for c in COLOURS[:4]], [["2"]])
    project = read_3mf.load(path)
    reduced, _ = renumber.apply(project, renumber.plan(4, {1}, None))
    assert reduced.project_settings["printable_area"] == project.project_settings["printable_area"]
    assert reduced.project_settings["filament_colour"] == ["#000000"]
