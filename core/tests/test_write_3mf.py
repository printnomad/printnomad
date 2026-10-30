import hashlib
import json
import zipfile

import pytest

from betterbridge import cli, read_3mf, write_3mf
from conftest import make_bambu_3mf

PLA = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_cli_end_to_end(profiles_root, tmp_path, capsys):
    src = make_bambu_3mf(tmp_path / "proj.3mf", [PLA], [["2"]], bed=180)
    before = digest(src)
    code = cli.main([str(src), "--profiles-dir", str(profiles_root)])
    assert code == cli.EXIT_OK, capsys.readouterr().out
    assert digest(src) == before                        # original intacto
    out = tmp_path / "proj_CREATOR5_PRO.3mf"
    report = json.loads((tmp_path / "proj_CREATOR5_PRO.report.json").read_text())
    assert report["ok"] and report["output"] == str(out)
    with zipfile.ZipFile(out) as a, zipfile.ZipFile(src) as b:
        assert a.testzip() is None
        assert sorted(a.namelist()) == sorted(b.namelist())
        assert a.read("3D/Objects/object_2.model") == b.read("3D/Objects/object_2.model")
        assert json.loads(a.read(read_3mf.PROJECT_SETTINGS))["printer_model"] == "Flashforge Creator 5 Pro"


def test_cli_refuses_overwrite_and_needs_map_exit_code(profiles_root, tmp_path):
    src = make_bambu_3mf(tmp_path / "p.3mf", [PLA], [["2"]])
    assert cli.main([str(src), "--profiles-dir", str(profiles_root)]) == cli.EXIT_OK
    assert cli.main([str(src), "--profiles-dir", str(profiles_root)]) == cli.EXIT_ERROR
    assert cli.main([str(src), "--profiles-dir", str(profiles_root), "--force"]) == cli.EXIT_OK

    painted = make_bambu_3mf(tmp_path / "m.3mf", [PLA] * 5, [["2"]], paint=True)
    assert cli.main([str(painted), "--profiles-dir", str(profiles_root)]) == cli.EXIT_NEEDS_INPUT
    assert not (tmp_path / "m_CREATOR5_PRO.3mf").exists()
    assert cli.main([str(painted), "--profiles-dir", str(profiles_root),
                     "--map", "1:1,2:2,3:3,4:4,5:4"]) == cli.EXIT_OK


def test_write_rejects_source_path(tmp_path):
    src = make_bambu_3mf(tmp_path / "p.3mf", [PLA], [["2"]])
    project = read_3mf.load(src)
    with pytest.raises(write_3mf.WriteError):
        write_3mf.write(project, src, {}, force=True)


def test_unchanged_entries_are_byte_identical(tmp_path):
    src = make_bambu_3mf(tmp_path / "p.3mf", [PLA], [["2"]])
    project = read_3mf.load(src)
    dest = tmp_path / "o.3mf"
    write_3mf.write(project, dest, {read_3mf.PROJECT_SETTINGS: b"{}"})
    assert write_3mf.verify(project, dest, {read_3mf.PROJECT_SETTINGS: b"{}"}) == []
    with zipfile.ZipFile(dest) as z:
        for name in project.names():
            if name != read_3mf.PROJECT_SETTINGS:
                assert z.read(name) == project.read(name)


def test_output_keeps_source_permissions(tmp_path):
    src = make_bambu_3mf(tmp_path / "p.3mf", [PLA], [["2"]])
    src.chmod(0o644)
    dest = tmp_path / "o.3mf"
    write_3mf.write(read_3mf.load(src), dest, {})
    assert dest.stat().st_mode & 0o777 == 0o644
