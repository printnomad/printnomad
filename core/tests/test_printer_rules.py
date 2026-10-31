"""Per-printer rules for machine-dependent settings (data/printer_rules.json)."""

import json

from betterbridge import printer_rules, read_3mf
from betterbridge.convert import convert
from betterbridge.target import Target
from conftest import make_bambu_3mf

C5P = "Flashforge Creator 5 Pro 0.4 nozzle"
PLA = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")
PETG = ("PETG", "Bambu PETG Basic @BBL A1", "#0000FF")


def test_architecture_from_the_profile():
    assert printer_rules.architecture(4, False) == "toolchanger"
    assert printer_rules.architecture(1, True) == "filament_changer"
    assert printer_rules.architecture(1, False) == "single"


def test_setting_groups():
    assert printer_rules.group_of("enable_prime_tower") == "purge_tower"
    assert printer_rules.group_of("wipe_tower_x") is None          # posición: dato del proyecto
    assert printer_rules.group_of("outer_wall_acceleration") == "kinematics"
    assert printer_rules.group_of("wall_loops") is None


def test_printer_rule_overrides_architecture_and_is_verified():
    c5p = printer_rules.rules_for("Flashforge Creator 5 Pro", 4, False)
    assert c5p.architecture == "toolchanger" and c5p.verified
    other = printer_rules.rules_for("Some Printer", 1, True)
    assert other.architecture == "filament_changer" and other.verified is None
    assert other.policy("purge_tower") == "printer"


def test_rules_file_is_consistent():
    data = json.loads(printer_rules.DATA_FILE.read_text())
    groups = set(data["setting_groups"])
    assert set(data["default_policies"]) == groups
    for spec in [*data["architectures"].values(), *data["printers"].values()]:
        assert set(spec.get("policies", {})) <= groups
        assert all(v in ("printer", "model") for v in spec.get("policies", {}).values())
    for spec in data["printers"].values():
        assert spec["architecture"] in data["architectures"]


def test_report_says_whether_rules_are_verified(profiles_root, tmp_path, monkeypatch):
    from betterbridge.profiles import ProfileLibrary

    lib = ProfileLibrary.load(profiles_root)
    path = make_bambu_3mf(tmp_path / "a.3mf", [PLA], [["2"]])
    report = convert(read_3mf.load(path), Target(lib, C5P)).report
    assert report.printer_rules["verified"] and "verificadas para Flashforge Creator 5 Pro" in report.to_text()

    monkeypatch.setattr(printer_rules, "rules_for", lambda *a, **k: printer_rules.PrinterRules(
        "toolchanger", {"purge_tower": "model"}, None, "https://example.test/issue"))
    path = make_bambu_3mf(tmp_path / "b.3mf", [PLA, PETG], [["2"]], object_extruders={"2": 2}, settings={
        "enable_prime_tower": "0", "different_settings_to_system": ["enable_prime_tower", "", "", ""]})
    result = convert(read_3mf.load(path), Target(lib, C5P))
    settings = json.loads(result.files[read_3mf.PROJECT_SETTINGS])
    assert settings["enable_prime_tower"] == "0"   # la regla dice: manda el modelo
    assert not any("ajustes de impresora del modelo" in w for w in result.report.warnings)
    assert "https://example.test/issue" in result.report.to_text()
