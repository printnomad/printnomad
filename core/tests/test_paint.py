"""Colour painting decoded like OrcaSlicer's TriangleSelector: the filaments really used."""

import json

import pytest

from betterbridge import model_edit, read_3mf
from betterbridge.convert import convert
from betterbridge.profiles import ProfileLibrary
from betterbridge.target import Target
from conftest import FAKE_PRINTER, make_bambu_3mf, paint_code

PLA = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")


@pytest.mark.parametrize("code, states", [
    ("4", {1}),                 # whole triangle, filament 1
    ("8", {2}),                 # filament 2
    ("0", {0}),                 # the part's own filament
    ("0C", {3}),                # "11" + (3 - 3)
    ("EC", {17}),               # "11" + (17 - 3)
    ("0FC", {18}),              # "11" + 0b1111 + (18 - 18)
    ("841", {1, 2}),            # split in two: children filament 2 then 1 (read from the end)
    ("1C0C2C0C1C13", {3, 4, 5}),  # OrcaSlicer's 3-colour example (Model.cpp): "1C"=4, "0C"=3, "2C"=5
])
def test_decode_paint(code, states):
    assert model_edit.decode_paint(code) == states


# OrcaSlicer's table of whole-triangle codes, index = filament (libslic3r/Model.cpp).
CONST_FILAMENTS = [
    "", "4", "8", "0C", "1C", "2C", "3C", "4C", "5C", "6C", "7C", "8C", "9C", "AC", "BC", "CC", "DC",
    "EC", "0FC", "1FC", "2FC", "3FC", "4FC", "5FC", "6FC", "7FC", "8FC", "9FC", "AFC", "BFC", "CFC", "DFC", "EFC",
]


@pytest.mark.parametrize("state", range(1, len(CONST_FILAMENTS)))
def test_orca_filament_codes(state):
    assert model_edit.decode_paint(CONST_FILAMENTS[state]) == {state}
    assert paint_code(state) == CONST_FILAMENTS[state]   # the fixtures encode like Orca


@pytest.mark.parametrize("state", [1, 2, 3, 12, 17, 18, 20])
def test_fixture_codes_round_trip(state):
    assert model_edit.decode_paint(paint_code(state)) == {state}


def test_truncated_code_does_not_crash():
    assert model_edit.decode_paint("C") == set()


def test_painted_project_uses_only_the_painted_filaments(profiles_root, tmp_path):
    """12 colours defined, 3 painted: fits on 4 extruders, no manual assignment."""
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA] * 12, [["2"]], paint=(2, 7, 12))
    project = read_3mf.load(path)
    geometry = {n: project.read(n) for n in project.geometry_names()}
    assert model_edit.painted_filaments(project.read(read_3mf.MODEL_FILE), geometry) == {"2": {2, 7, 12}}
    result = convert(project, Target(ProfileLibrary.load(profiles_root), FAKE_PRINTER))
    assert result.report.ok, result.report.errors
    assert result.usage == {"1": {1, 2, 7, 12}}   # the object's own filament (1) + painted ones
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert sorted(set(settings["filament_map"])) <= ["1", "2", "3", "4"]
