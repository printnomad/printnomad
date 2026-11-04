"""Renumbering a project's filaments: unused ones dropped, those sharing an extruder merged."""

import io
import json
import re
import xml.etree.ElementTree as ET
import zipfile

import pytest

from conftest import FAKE_PRINTER, make_bambu_3mf
from printnomad import model_edit, read_3mf, renumber, write_3mf
from printnomad.convert import convert, plate_usage
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


def _ranges(*objects):
    """Height ranges file: each object is {option: value} of one range; position = its index."""
    body = "".join(
        f'<object id="{i}"><range min_z="0" max_z="1">'
        + "".join(f'<option opt_key="{k}">{v}</option>' for k, v in options.items())
        + "</range></object>" for i, options in objects)
    return f'<?xml version="1.0" encoding="utf-8"?><objects>{body}</objects>'


THREE_PLA = [("PLA", "Bambu PLA Basic @BBL A1", c) for c in ("#FF0000", "#00FF00", "#0000FF")]


def test_filament_chosen_in_a_height_range_counts_on_the_plate_of_its_object(tmp_path):
    ranges = _ranges((2, {"layer_height": "0.2", "extruder": "3"}))
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"], ["5"]],
                          extra_files={read_3mf.LAYER_CONFIG_RANGES: ranges})
    # The file counts by position: index 2 is the second object (id 5), on plate 2.
    assert plate_usage(read_3mf.load(path), 3) == {"1": {1}, "2": {1, 3}}


@pytest.mark.parametrize(("key", "value", "used"), [
    ("extruder", "0", {1}),                        # 0 = inherit
    ("sparse_infill_filament", "2", {1, 2}),       # Bambu Studio
    ("outer_wall_filament_id", "2", {1, 2}),       # OrcaSlicer
    ("extruder", "9", {1}),                        # no such filament
    ("layer_height", "2", {1}),                    # not a filament
])
def test_height_range_options_that_choose_a_filament(tmp_path, key, value, used):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]],
                          extra_files={read_3mf.LAYER_CONFIG_RANGES: _ranges((1, {key: value}))})
    assert plate_usage(read_3mf.load(path), 3) == {"1": used}


def test_height_range_of_unknown_object_counts_on_every_plate(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"], ["5"]],
                          extra_files={read_3mf.LAYER_CONFIG_RANGES: _ranges((7, {"extruder": "2"}))})
    assert plate_usage(read_3mf.load(path), 3) == {"1": {1, 2}, "2": {1, 2}}


def test_unreadable_height_ranges_change_nothing(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]],
                          extra_files={read_3mf.LAYER_CONFIG_RANGES: "not xml"})
    project = read_3mf.load(path)
    assert plate_usage(project, 3) == {"1": {1}}
    assert model_edit.remap_range_filaments(b"not xml", {1: 2}) == b"not xml"


def test_height_range_filaments_survive_the_conversion_renumbered(profiles_root, tmp_path):
    """Filament 2 is listed but unused, 3 only in a range: 2 goes, 3 becomes 2 with its width in mm."""
    ranges = _ranges((1, {"extruder": "3", "skin_infill_line_width": "100%"}))
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], extra_files={read_3mf.LAYER_CONFIG_RANGES: ranges})
    target = Target(ProfileLibrary.load(profiles_root), FAKE_PRINTER)
    result = convert(read_3mf.load(path), target)
    assert result.report.ok, result.report.errors
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert settings["filament_colour"] == ["#FF0000", "#0000FF"]
    written = ET.fromstring(result.files[read_3mf.LAYER_CONFIG_RANGES])
    options = {o.get("opt_key"): o.text for o in written.iter("option")}
    assert options == {"extruder": "2", "skin_infill_line_width": "0.4"}


@pytest.mark.parametrize(("settings", "used"), [
    ({"support_filament": "3", "enable_support": "1"}, {1, 3}),
    ({"support_interface_filament": "2", "enable_support": "1"}, {1, 2}),
    ({"support_filament": "3", "raft_layers": "2"}, {1, 3}),
    ({"support_filament": "3", "enforce_support_layers": "5"}, {1, 3}),
    ({"support_filament": "3", "enable_support": "0"}, {1}),         # support off: not printed
    ({"support_filament": "0", "enable_support": "1"}, {1}),         # 0 = the object's own
    ({"wall_filament": "3"}, {1, 3}),
    ({"outer_wall_filament_id": "2"}, {1, 2}),
    ({"sparse_infill_filament": "1"}, {1}),                          # legacy default: inherit
    ({"wall_filament": "9"}, {1}),                                   # no such filament
    ({"wipe_tower_filament": "3"}, {1}),                             # plate with one filament: no tower
])
def test_filaments_chosen_per_feature_in_project_settings(tmp_path, settings, used):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], settings=settings)
    assert plate_usage(read_3mf.load(path), 3) == {"1": used}


def test_legacy_default_does_not_keep_an_unused_filament_1(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], object_extruders={"2": 2},
                          settings={"wall_filament": "1", "sparse_infill_filament": "1"})
    assert plate_usage(read_3mf.load(path), 3) == {"1": {2}}


def test_purge_tower_filament_counts_when_the_plate_changes_filament(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], paint=(2,), settings={"wipe_tower_filament": "3"})
    assert plate_usage(read_3mf.load(path), 3) == {"1": {1, 2, 3}}
    off = make_bambu_3mf(tmp_path / "off.3mf", THREE_PLA, [["2"]], paint=(2,),
                         settings={"wipe_tower_filament": "3", "enable_prime_tower": "0"})
    assert plate_usage(read_3mf.load(off), 3) == {"1": {1, 2}}


def test_filament_chosen_on_an_object_or_part_counts_only_on_its_plate(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"], ["5"]],
                          part_overrides={"5": {"sparse_infill_filament": "3"}})
    assert plate_usage(read_3mf.load(path), 3) == {"1": {1}, "2": {1, 3}}


def test_feature_filaments_are_renumbered_in_settings_and_objects(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], settings={
        "support_filament": "3", "enable_support": "1", "wall_filament": "1"},
        part_overrides={"2": {"outer_wall_filament_id": "3", "support_interface_filament": "2"}})
    project = read_3mf.load(path)
    reduced, changed = renumber.apply(project, renumber.plan(3, {1, 3}, None))
    assert reduced.project_settings["support_filament"] == "2"       # old 3 → 2
    assert reduced.project_settings["wall_filament"] == "1"          # legacy default stays
    assert b'key="outer_wall_filament_id" value="2"' in changed[read_3mf.MODEL_SETTINGS]
    # Part setting without effect on usage: filament 2 was removed, back to the object's own.
    assert b'key="support_interface_filament" value="0"' in changed[read_3mf.MODEL_SETTINGS]


def test_support_filament_that_is_not_printed_goes_back_to_the_objects_own(tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], settings={"support_filament": "3"})
    project = read_3mf.load(path)
    reduced, _ = renumber.apply(project, renumber.plan(3, plate_usage(project, 3)["1"], None))
    assert reduced.project_settings["support_filament"] == "0"
    assert reduced.project_settings["filament_colour"] == ["#FF0000"]


def test_support_filament_survives_the_conversion(profiles_root, tmp_path):
    path = make_bambu_3mf(tmp_path / "p.3mf", THREE_PLA, [["2"]], settings={
        "support_filament": "3", "enable_support": "1",
        "different_settings_to_system": ["enable_support;support_filament", "", "", "", ""]})
    result = convert(read_3mf.load(path), Target(ProfileLibrary.load(profiles_root), FAKE_PRINTER))
    assert result.report.ok, result.report.errors
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert settings["filament_colour"] == ["#FF0000", "#0000FF"]
    assert settings["support_filament"] == "2"


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
    assert first.report.over_extruders                  # 6 colours on one plate, 4 extruders
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
