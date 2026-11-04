import pytest

from printnomad.conditions import ConditionError, _Parser, matches

MK4S = {"printer_notes": "PRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_MK4S\nHF_NOZZLE", "nozzle_diameter": ["0.4"],
        "single_extruder_multi_material": "1", "printer_model": "Prusa MK4S", "printer_variant": "0.4"}


@pytest.mark.parametrize(("condition", "expected"), [
    ("printer_notes=~/.*MK4S.*/ and nozzle_diameter[0]==0.4", True),
    ("printer_notes=~/.*MK4S.*/ and nozzle_diameter[0]==0.6", False),
    ("printer_notes!~/.*HF_NOZZLE.*/", False),
    ("printer_notes=~/.*PRINTER_MODEL_COREONE[^_a-zA-Z0-9].*/", False),
    ("printer_notes=~/MK4S/", False),                                        # the whole text must match
    ("printer_notes=~/.*MK4S.*/ and single_extruder_multi_material", True),
    ('not ((printer_model == "Prusa MK4S" or printer_model == "X") and printer_variant == "0.4")', False),
    ('printer_model != "X" && !(nozzle_diameter[0] > 0.5)', True),
    ("nozzle_diameter[0] >= 0.4 and nozzle_diameter[0] <= 0.4", True),
    ("nozzle_diameter[9] == 0.4", True),                                     # past the end: the last value
])
def test_conditions_of_real_profiles(condition, expected):
    assert matches(condition, MK4S) is expected


def test_a_false_setting_is_false():
    assert not matches("single_extruder_multi_material", {"single_extruder_multi_material": "0"})


@pytest.mark.parametrize("broken", ["(printer_model", "printer_model ==", "@", "printer_notes=~/[/"])
def test_what_cannot_be_parsed_is_compatible_as_in_the_slicer(broken):
    assert matches(broken, MK4S) is True


def test_a_setting_the_profile_does_not_have_is_empty():
    """Without this, every printer without printer_notes took Prusa's processes as its own."""
    assert matches("printer_notes=~/.*PRINTER_VENDOR_PRUSA3D.*/", {}) is False
    assert matches("printer_notes!~/.*HF_NOZZLE.*/", {}) is True
    assert matches("single_extruder_multi_material", {}) is False


def test_errors_are_reported_to_the_caller_of_the_parser():
    with pytest.raises(ConditionError):
        _Parser("printer_model ==", MK4S).parse()
