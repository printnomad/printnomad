"""Conversion options shared by the CLI, the OrcaSlicer plugin and the browser extension.

Options are data so every front end offers the same choices, defaults and texts.
Basic mode shows nothing (defaults apply); advanced mode shows every option here.
Keys are the keyword arguments of `convert.convert()`; texts are i18n messages
`option.<key>.label`, `.help`, `.<choice>` and, when the chosen value deserves it,
`.warning`.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import rules
from .i18n import t


class OptionError(ValueError):
    pass


@dataclass(frozen=True)
class Option:
    key: str
    default: bool | str
    choices: tuple[str, ...] = ()  # empty: on/off
    warn_when: bool | str | None = None  # value that shows option.<key>.warning

    @property
    def kind(self) -> str:
        return "choice" if self.choices else "bool"


OPTIONS: tuple[Option, ...] = (
    Option("map_mode", rules.MAP_COMPATIBLE, rules.MAP_MODES, warn_when=rules.MAP_EXACT),
    Option("keep_designer_filament", True),
    Option("keep_designer_cooling", False, warn_when=True),
    Option("keep_designer_printer_settings", False, warn_when=True),
)
BY_KEY = {o.key: o for o in OPTIONS}


def defaults() -> dict[str, bool | str]:
    return {o.key: o.default for o in OPTIONS}


def resolve(values: dict | None) -> dict[str, bool | str]:
    """Defaults updated with `values`; unknown keys or invalid values raise OptionError."""
    out = defaults()
    for key, value in (values or {}).items():
        option = BY_KEY.get(key)
        if option is None:
            raise OptionError(t("option.error.unknown", key=key, options=", ".join(BY_KEY)))
        valid = value in option.choices if option.choices else isinstance(value, bool)
        if not valid:
            allowed = ", ".join(option.choices) if option.choices else "true, false"
            raise OptionError(t("option.error.value", key=key, value=value, allowed=allowed))
        out[key] = value
    return out


def describe() -> list[dict]:
    """Options with texts in the current language, for settings screens (plain JSON)."""
    out = []
    for o in OPTIONS:
        item = {"key": o.key, "kind": o.kind, "default": o.default,
                "label": t(f"option.{o.key}.label"), "help": t(f"option.{o.key}.help")}
        if o.choices:
            item["choices"] = [{"value": c, "label": t(f"option.{o.key}.{c}")} for c in o.choices]
        if o.warn_when is not None:
            item["warn_when"] = o.warn_when
            item["warning"] = t(f"option.{o.key}.warning")
        out.append(item)
    return out
