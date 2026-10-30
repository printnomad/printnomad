# Translating BetterBridge

BetterBridge's user-facing text lives in JSON catalogs, one file per language. You do not need to know Python to translate.

## Where the catalogs are

| Component | Folder |
|---|---|
| Core (conversion report, CLI) | `core/src/betterbridge/locales/` |
| OrcaSlicer plugin (notifications, panel) | `orca-plugin/betterbridge_orca/locales/` |

`en.json` is the reference. Each language is `<code>.json`, using the two-letter [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) code (`es`, `fr`, `pt`, `de`…).

## Add a language

1. Copy `en.json` to `<code>.json` in **each** folder above.
2. Set `"_meta"`: `{"name": "<language name in that language>", "contributors": ["your GitHub user"]}`.
3. Translate the values. Keep the keys unchanged.
4. Keep every `{placeholder}` exactly as it is (you may move it within the sentence). Example: `"Plate {plate} uses {count} filaments"` → `"La placa {plate} usa {count} filamentos"`.
5. Run the tests: `.venv/bin/pytest core/tests/test_i18n.py`. They check that your file has the same keys and placeholders as English.
6. Open a pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Fix or complete a translation

Edit the value in `<code>.json`. If a key is missing, the English text is shown until it is translated (the tests will report it as untranslated).

## How the language is chosen

- CLI: `--lang <code>`, else the `BETTERBRIDGE_LANG` environment variable, else the system language, else English.
- OrcaSlicer plugin: OrcaSlicer's interface language.

## For developers

- Never write user-facing text in code: add a key to `en.json` (and the other catalogs) and use `t("area.key", name=value)` from `betterbridge.i18n`.
- Keys are flat and dotted by area: `convert.warn.…`, `reason.…`, `report.…`, `cli.…`, `plugin.…`.
- Placeholders use `{name}`; pass already-formatted numbers (`f"{value:g}"`).
