"""Entry point used by the browser extension: bundles in, plain JSON out."""

import json
import zipfile

import pytest

from conftest import FAKE_PRINTER, make_bambu_3mf
from printnomad import i18n, issues, web

PLA = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")


def bundles_from(root):
    """Same shape as the catalog bundles: one per vendor folder."""
    out = []
    for vendor in sorted(d for d in root.iterdir() if d.is_dir()):
        files = {f.relative_to(vendor).as_posix(): json.loads(f.read_text()) for f in vendor.rglob("*.json")}
        out.append({"vendor": vendor.name, "repo": "Example/Slicer", "ref": "1.0", "files": files})
    return out


def test_list_printers(profiles_root):
    printers = web.list_printers(bundles_from(profiles_root))
    c5p = next(p for p in printers if p["name"] == FAKE_PRINTER)
    assert c5p["extruders"] == 4 and c5p["vendor"] == "Flashforge"


def test_convert_file_writes_output_and_plain_report(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]])
    out = tmp_path / "out"
    out.mkdir()
    res = web.convert_file(str(src), str(out), FAKE_PRINTER, bundles_from(profiles_root),
                           slicer="orcaslicer", platform="macos", lang="en")
    assert res["ok"], res["text"]
    assert res["output"] == str(out / "boat_CREATOR5_PRO.3mf")
    assert zipfile.is_zipfile(res["output"])
    json.dumps(res)  # plain JSON for the JavaScript side
    assert res["report"]["profiles"] == "Example/Slicer@1.0"
    assert "Profiles: Example/Slicer@1.0" in res["text"]
    assert res["report"]["source"] == "boat.3mf" and res["report"]["output"] == "boat_CREATOR5_PRO.3mf"


def test_convert_file_reports_input_errors(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]])
    res = web.convert_file(str(src), str(tmp_path), "No Such Printer", bundles_from(profiles_root), lang="en")
    assert not res["ok"] and res["output"] is None and "No Such Printer" in res["text"]
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), map_text="x")
    assert not res["ok"] and res["report"]["issues"][0]["code"] == issues.BAD_MAP


def test_convert_file_options(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]])
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root),
                           options={"map_mode": "exact"})
    assert res["ok"]
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root),
                           options={"map_mode": "sideways"}, lang="en")
    assert not res["ok"] and "map_mode" in res["text"]
    assert {o["key"] for o in web.list_options("es")} >= {"map_mode", "keep_designer_cooling"}


def test_convert_file_reports_a_project_already_for_the_printer(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]], settings={"printer_settings_id": FAKE_PRINTER,
                                                                            "filament_printable": ["15"]})
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), lang="en")
    assert res["ok"] and res["already_target"] and res["output"] is None


def test_designer_preset_of_the_same_printer_counts_as_already_set_up(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]], settings={
        "printer_settings_id": "C5P - my tweaks", "printer_model": "Flashforge Creator 5 Pro",
        "filament_printable": ["15"]})
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), lang="en")
    assert res["already_target"]


def _issue(res):
    return res["report"]["issues"][0]


def test_issue_carries_code_stage_and_suggestion(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]])
    res = web.convert_file(str(src), str(tmp_path), "No Such Printer", bundles_from(profiles_root), lang="en")
    issue = _issue(res)
    assert (issue["code"], issue["stage"]) == (issues.UNKNOWN_PRINTER, "profiles")
    assert "No Such Printer" in issue["message"] and "My printers" in issue["suggestion"]
    assert "[PN201 · Printer profiles]" in res["text"] and "→ Choose the printer again" in res["text"]


def test_damaged_file_is_a_report_not_an_exception(profiles_root, tmp_path):
    bad = tmp_path / "bad.3mf"
    bad.write_bytes(b"not a zip")
    res = web.convert_file(str(bad), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), lang="en")
    assert not res["ok"] and _issue(res)["code"] == issues.UNREADABLE_PROJECT
    assert res["report"]["source"] == "bad.3mf"


def test_damaged_settings_are_a_report_not_an_exception(profiles_root, tmp_path):
    src = tmp_path / "bad.3mf"
    with zipfile.ZipFile(src, "w") as zf:
        zf.writestr("Metadata/project_settings.config", "{not json")
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), lang="en")
    assert _issue(res)["code"] == issues.UNREADABLE_PROJECT


def test_unexpected_failure_is_a_report_with_the_detail(profiles_root, tmp_path, monkeypatch):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]])

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(web, "convert", broken)
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), lang="en")
    assert not res["ok"] and _issue(res)["code"] == issues.INTERNAL
    assert "RuntimeError: boom" in _issue(res)["message"]


@pytest.mark.parametrize(("printer_kw", "expected"), [
    ({"nozzle": "9.9"}, issues.NOZZLE_UNAVAILABLE),
    ({"map_text": "1:9"}, issues.BAD_MAP),
    ({"options": {"nope": True}}, issues.BAD_OPTION),
])
def test_input_errors_have_their_code(profiles_root, tmp_path, printer_kw, expected):
    src = make_bambu_3mf(tmp_path / "boat.3mf", [PLA], [["2"]])
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), **printer_kw)
    assert _issue(res)["code"] == expected


def test_filament_without_equivalent_and_too_many_colours_have_their_code(profiles_root, tmp_path):
    pc = make_bambu_3mf(tmp_path / "pc.3mf", [("PC", "Bambu PC @BBL A1", "#FFFFFF")], [["2"]])
    assert _issue(web.convert_file(str(pc), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root)))["code"] \
        == issues.NO_FILAMENT
    colours = [("PLA", "Bambu PLA Basic @BBL A1", f"#00000{i}") for i in range(5)]
    painted = make_bambu_3mf(tmp_path / "many.3mf", colours, [["2"]], paint=(1, 2, 3, 4, 5))
    res = web.convert_file(str(painted), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root))
    assert res["needs_map"] and _issue(res)["code"] == issues.NEEDS_MAP


def test_every_code_has_stage_and_texts_in_every_language():
    codes = [v for k, v in vars(issues).items() if k.isupper() and isinstance(v, str) and v.startswith("PN")]
    assert sorted(codes) == sorted(issues.STAGES) and len(set(codes)) == len(codes)
    for lang in i18n.available_languages():
        i18n.set_language(lang)
        for code, stage in issues.STAGES.items():
            assert i18n.t(f"issue.{code}.suggestion") != f"issue.{code}.suggestion"
            assert i18n.t(f"stage.{stage}") != f"stage.{stage}"
