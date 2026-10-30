"""Internationalisation: user-facing text comes from JSON catalogs, one per language.

Catalogs live in ``locales/<lang>.json`` next to each package that has text (the
core, the OrcaSlicer plugin…). Keys are flat and dotted (``"report.warnings"``);
values use ``{name}`` placeholders. English (``en``) is the reference: every
other catalog must have the same keys and placeholders (checked by the tests).
A missing translation falls back to English, then to the key itself.

To add a language, copy ``locales/en.json`` to ``locales/<code>.json``, translate
the values and run the tests. See docs/translating.md.
"""

from __future__ import annotations

import json
import locale
import os
from pathlib import Path

DEFAULT_LANGUAGE = "en"
ENV_LANGUAGE = "BETTERBRIDGE_LANG"
META_KEY = "_meta"  # {"name": "Español", "contributors": [...]}: not a message

_catalog_dirs: list[Path] = [Path(__file__).parent / "locales"]
_cache: dict[str, dict[str, str]] = {}
_current: str | None = None


def add_catalog_dir(path: str | Path) -> None:
    """Register extra catalogs (e.g. the OrcaSlicer plugin's own messages)."""
    path = Path(path)
    if path not in _catalog_dirs:
        _catalog_dirs.append(path)
        _cache.clear()


def available_languages() -> list[str]:
    return sorted({f.stem for d in _catalog_dirs if d.is_dir() for f in d.glob("*.json")})


def normalize(tag: str | None) -> str | None:
    """'es_MX.UTF-8', 'es-MX', 'Spanish' → 'es' when a catalog exists for it."""
    if not tag:
        return None
    base = tag.replace("-", "_").split(".")[0].split("_")[0].lower()
    return base if base in available_languages() else None


def detect_language() -> str:
    candidates = [os.environ.get(ENV_LANGUAGE)]
    candidates += [os.environ.get(var) for var in ("LC_ALL", "LC_MESSAGES", "LANG")]
    try:
        candidates.append(locale.getlocale()[0])
    except ValueError:
        pass
    for tag in candidates:
        if lang := normalize(tag):
            return lang
    return DEFAULT_LANGUAGE


def set_language(lang: str | None = None) -> str:
    """Select the language (None = detect). Returns the language actually used."""
    global _current
    _current = normalize(lang) or detect_language()
    return _current


def get_language() -> str:
    return _current or set_language()


def catalog(lang: str | None = None) -> dict[str, str]:
    """Merged messages for a language (English filled in for missing keys)."""
    lang = normalize(lang) or get_language()
    if lang not in _cache:
        merged: dict[str, str] = {}
        for code in dict.fromkeys([DEFAULT_LANGUAGE, lang]):
            for d in _catalog_dirs:
                f = d / f"{code}.json"
                if f.is_file():
                    data = json.loads(f.read_text(encoding="utf-8"))
                    merged.update({k: v for k, v in data.items() if k != META_KEY})
        _cache[lang] = merged
    return _cache[lang]


class _Keep(dict):
    """Leave unknown placeholders visible instead of failing."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def t(message_id: str, /, **params) -> str:
    """Translated message for `message_id` with `{placeholders}` filled from `params`.

    `message_id` is positional-only so messages can use any placeholder name (e.g. `{key}`).
    """
    text = catalog().get(message_id, message_id)
    return text.format_map(_Keep(params)) if params else text
