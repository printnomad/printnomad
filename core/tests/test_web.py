"""Entry point used by the browser extension: bundles in, plain JSON out."""

import json
import zipfile

from betterbridge import web
from conftest import FAKE_PRINTER, make_bambu_3mf

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
    assert not res["ok"] and res["report"] is None
