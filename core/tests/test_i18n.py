"""Translation catalogs: every language must match English (keys and placeholders)."""

import json
import string
from pathlib import Path

import pytest

from betterbridge import cli, i18n
from conftest import cli_target, make_bambu_3mf

ROOT = Path(__file__).resolve().parents[2]
CATALOG_DIRS = [
    ROOT / "core" / "src" / "betterbridge" / "locales",
    ROOT / "orca-plugin" / "betterbridge_orca" / "locales",
]


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _placeholders(text: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


def _catalogs():
    for d in CATALOG_DIRS:
        for f in sorted(d.glob("*.json")):
            if f.stem != i18n.DEFAULT_LANGUAGE:
                yield pytest.param(d, f, id=f"{d.parent.name}/{f.name}")


@pytest.mark.parametrize("folder,catalog_file", list(_catalogs()))
def test_catalog_matches_english(folder, catalog_file):
    english = _load(folder / "en.json")
    other = _load(catalog_file)
    assert other.get(i18n.META_KEY, {}).get("name"), "add _meta.name with the language's own name"
    missing = sorted(set(english) - set(other))
    extra = sorted(set(other) - set(english))
    assert not missing, f"untranslated keys: {missing}"
    assert not extra, f"keys that do not exist in en.json: {extra}"
    for key, text in english.items():
        if key == i18n.META_KEY:
            continue
        assert _placeholders(other[key]) == _placeholders(text), f"{key}: placeholders differ"


@pytest.mark.parametrize("folder", CATALOG_DIRS, ids=lambda d: d.parent.name)
def test_catalogs_are_valid_and_english_exists(folder):
    assert (folder / "en.json").is_file()
    for f in folder.glob("*.json"):
        data = _load(f)
        assert all(isinstance(v, str) for k, v in data.items() if k != i18n.META_KEY), f.name


def test_lookup_fallbacks(tmp_path):
    (tmp_path / "en.json").write_text(json.dumps({"x.only_en": "only {what}", "x.both": "English"}))
    (tmp_path / "zz.json").write_text(json.dumps({"_meta": {"name": "Test"}, "x.both": "Zed"}))
    i18n.add_catalog_dir(tmp_path)
    try:
        assert i18n.set_language("zz") == "zz"
        assert i18n.t("x.both") == "Zed"
        assert i18n.t("x.only_en", what="English") == "only English"    # falls back to English
        assert i18n.t("x.not_a_key") == "x.not_a_key"                     # falls back to the key
        assert i18n.t("x.only_en") == "only {what}"                       # missing placeholder kept
    finally:
        i18n._catalog_dirs.remove(tmp_path)
        i18n._cache.clear()


@pytest.mark.parametrize("tag,expected", [
    ("es_MX.UTF-8", "es"), ("es-ES", "es"), ("en_US", "en"), ("xx_YY", None), (None, None)])
def test_normalize(tag, expected):
    assert i18n.normalize(tag) == expected


def test_detect_from_environment(monkeypatch):
    monkeypatch.setenv(i18n.ENV_LANGUAGE, "en")
    assert i18n.set_language(None) == "en"
    monkeypatch.setenv(i18n.ENV_LANGUAGE, "es_AR.UTF-8")
    assert i18n.set_language(None) == "es"


@pytest.mark.parametrize("lang,expected", [("en", "Target:"), ("es", "Destino:")])
def test_cli_language(lang, expected, profiles_root, tmp_path, capsys):
    src = make_bambu_3mf(tmp_path / "p.3mf", [("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")], [["2"]])
    assert cli.main([str(src), *cli_target(profiles_root), "--lang", lang]) == cli.EXIT_OK
    assert expected in capsys.readouterr().out
