"""Projects already set up for the printer are reviewed: values that would stop them
slicing are fixed, the printer maker's own restrictions are kept and reported."""

import json
from pathlib import Path

import pytest
from test_web import bundles_from

from conftest import make_bambu_3mf
from printnomad import read_3mf, web, write_3mf
from printnomad.convert import convert
from printnomad.profiles import ProfileLibrary
from printnomad.target import Target

MACHINE = "Flashforge Creator 5 Pro 0.4 nozzle"
SAVED = {"printer_model": "Flashforge Creator 5 Pro", "printer_settings_id": MACHINE,
         "filament_map_mode": "Manual", "filament_map": ["1", "2", "3", "4"]}
KINGROON = ("PLA", "PLA - Kingroon", "#000000")  # a user preset: not in the profiles
TPU = ("TPU", "Flashforge TPU @FF C5P", "#222222")


@pytest.fixture
def target(profiles_root):
    return Target(ProfileLibrary.load(profiles_root), MACHINE)


def saved_project(tmp_path, filaments, printable, maps=(1, 2, 3, 4)):
    """A project for the C5P saved by the slicer, every filament used on plate 1."""
    return make_bambu_3mf(tmp_path / "x_CREATOR5_PRO.3mf", filaments, [["2"]],
                          object_extruders={"2": 1}, paint=tuple(range(1, len(filaments) + 1)),
                          settings={**SAVED, "filament_printable": printable},
                          plate_map_mode="Manual", plate_maps=list(maps))


def test_two_nozzle_default_from_a_user_preset_is_fixed(tmp_path, target):
    path = saved_project(tmp_path, [KINGROON] * 4, ["3"] * 4)
    result = convert(read_3mf.load(path), target)
    report = result.report
    assert report.ok and report.already_target and not report.warnings
    assert json.loads(result.files[read_3mf.PROJECT_SETTINGS])["filament_printable"] == ["15"] * 4
    assert [c.final for c in report.changed] == ["15"] * 4 and "E1, E2, E3, E4" in report.changed[0].reason


def test_missing_value_is_written(tmp_path, target):
    """Without the key the slicer applies its default (3): it is written for every extruder."""
    path = make_bambu_3mf(tmp_path / "a.3mf", [KINGROON], [["2"]], settings={k: v for k, v in SAVED.items()
                                                                         if k != "filament_map"})
    result = convert(read_3mf.load(path), target)
    assert result.report.ok and json.loads(result.files[read_3mf.PROJECT_SETTINGS])["filament_printable"] == ["15"]


def test_nothing_to_fix_is_already_target(tmp_path, target):
    path = saved_project(tmp_path, [KINGROON] * 4, ["15"] * 4)
    result = convert(read_3mf.load(path), target)
    assert not result.report.ok and result.report.already_target and not result.files
    assert "Creator 5 Pro" in result.report.errors[0]


def test_maker_restriction_is_kept_and_reported(tmp_path, target):
    path = saved_project(tmp_path, [KINGROON, KINGROON, TPU, KINGROON], ["3"] * 4)
    result = convert(read_3mf.load(path), target)
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert settings["filament_printable"] == ["15", "15", "3", "15"]
    [warning] = result.report.warnings
    assert "#3" in warning and "E3" in warning and "E1, E2" in warning


def test_maker_restriction_respected_by_the_assignment_is_quiet(tmp_path, target):
    path = saved_project(tmp_path, [TPU, KINGROON, KINGROON, KINGROON], ["3"] * 4)
    result = convert(read_3mf.load(path), target)
    assert result.report.ok and not result.report.warnings


def test_automatic_assignment_is_not_a_conflict(tmp_path, target):
    """The slicer only checks manual assignments; automatic ones avoid excluded extruders."""
    path = make_bambu_3mf(tmp_path / "a.3mf", [KINGROON, KINGROON, TPU], [["2"]], paint=(1, 2, 3),
                          settings={**SAVED, "filament_map_mode": "Auto For Flush", "filament_printable": ["3"] * 3},
                          plate_maps=[1, 2, 3])
    assert not convert(read_3mf.load(path), target).report.warnings


def test_conversion_keeps_maker_restriction_and_warns(tmp_path, target):
    pla = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")
    tpu = ("TPU", "Bambu TPU 95A @BBL A1", "#222222")
    path = make_bambu_3mf(tmp_path / "a.3mf", [pla, pla, tpu], [["2"]], paint=(1, 2, 3))
    result = convert(read_3mf.load(path), target, user_map={1: 1, 2: 2, 3: 3})
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert settings["filament_printable"] == ["15", "15", "3"]
    assert any("#3" in w and "E3" in w for w in result.report.warnings)


def test_output_name_of_a_repaired_project():
    assert write_3mf.output_path(Path("a/x_CREATOR5_PRO.3mf"), "_CREATOR5_PRO").name == "x_CREATOR5_PRO_fixed.3mf"
    assert write_3mf.output_path(Path("a/x.3mf"), "_CREATOR5_PRO").name == "x_CREATOR5_PRO.3mf"


def test_web_writes_the_repaired_project(tmp_path, profiles_root):
    src = saved_project(tmp_path, [KINGROON] * 4, ["3"] * 4)
    out = tmp_path / "out"
    out.mkdir()
    res = web.convert_file(str(src), str(out), MACHINE, bundles_from(profiles_root))
    assert res["ok"] and not res["already_target"] and res["output"].endswith("x_CREATOR5_PRO_fixed.3mf")
