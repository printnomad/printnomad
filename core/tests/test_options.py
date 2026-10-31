"""Conversion options as data: defaults, validation and texts for settings screens."""

import pytest

from betterbridge import i18n, options, rules
from betterbridge.convert import convert


def test_defaults_match_convert_signature():
    import inspect

    params = inspect.signature(convert).parameters
    for key, value in options.defaults().items():
        assert params[key].default == value, key
    assert options.defaults()["map_mode"] == rules.MAP_COMPATIBLE
    assert options.defaults()["keep_designer_cooling"] is False


def test_resolve_validates():
    assert options.resolve({"keep_designer_cooling": True})["keep_designer_cooling"] is True
    with pytest.raises(options.OptionError):
        options.resolve({"nope": 1})
    with pytest.raises(options.OptionError):
        options.resolve({"map_mode": "sideways"})
    with pytest.raises(options.OptionError):
        options.resolve({"keep_designer_cooling": "yes"})


@pytest.mark.parametrize("lang", ["en", "es"])
def test_every_option_is_translated(lang):
    i18n.set_language(lang)
    for item in options.describe():
        texts = [item["label"], item["help"], item.get("warning", "x"), *(c["label"] for c in item.get("choices", []))]
        assert all(text and not text.startswith("option.") for text in texts), item
    cooling = next(o for o in options.describe() if o["key"] == "keep_designer_cooling")
    assert cooling["warn_when"] is True and cooling["kind"] == "bool"
