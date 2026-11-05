# PrintNomad — OrcaSlicer plugin

Converts the project open in OrcaSlicer (2.5+, plugin API in beta) to another printer using the PrintNomad core.

## Install

```sh
.venv/bin/python orca-plugin/tools/build.py --install
```

This builds the panel (`ui/`, Tailwind CSS, needs Node.js) and `orca-plugin/dist/printnomad_orca-<version>-py3-none-any.whl` (the plugin, the panel and a copy of `core/`) and copies it to `~/Library/Application Support/OrcaSlicer/orca_plugins/printnomad/`, clearing OrcaSlicer's extracted copy (OrcaSlicer does not refresh it on its own). Restart OrcaSlicer with ⌘Q and enable the plugin in the Plugins dialog.

## How it works

1. On `ProjectOpened`, if the project comes from Bambu Studio / PrusaSlicer, a notification offers the conversion.
2. The dock panel shows a preview: filament → extruder (editable), nozzle, process profile, warnings.
3. **Convert** writes `<name>_<PRINTER>.3mf` (e.g. `_CREATOR5_PRO`) next to the original (asks before replacing) and shows the report.
4. **Open in OrcaSlicer / Flash Studio** asks macOS to open it (another window). Experimental option: same window, via a local HTTP server and `orcaslicer://open?file=http://127.0.0.1…`.

Target printer: set in the plugin's **Config** tab (Plugins dialog): `slicer` (`flashstudio`, `bambustudio`, `orcaslicer`) and `printer` (any preset name, yours included; see `printnomad printers`). Default: Flashforge Creator 5 Pro 0.4 nozzle in Flash Studio. Because the plugin runs inside OrcaSlicer, OrcaSlicer's limits also apply to the result (e.g. manual filament mapping only on extruders 1–2).

Permissions requested from OrcaSlicer: read Flash Studio profiles; read/write `~/Downloads`, `~/Documents`, `~/Desktop`; fixed `open -a …` commands. The experimental option asks for a local port and one thread when used.

Debug log: `~/Library/Application Support/OrcaSlicer/orca_plugins/plugin_data/printnomad/debug.log`.

## Panel (ui/)

The dock panel is plain HTML + JavaScript styled with Tailwind CSS v4:

- `ui/src/panel.html`, `panel.js`, `panel.css` (theme tokens, light/dark).
- `npm run build` (in `ui/`) generates only the Tailwind classes in use and inlines CSS and JS into `ui/dist/panel.html`.
- Text comes from `printnomad_orca/locales/*.json` (`panel.*` keys); the plugin injects the catalog of OrcaSlicer's language into the page.

## Development

- `tools/preview_panel.py project.3mf [--lang en]` renders the built panel with real data in a browser (no OrcaSlicer needed).
- `tests/test_plugin.py` drives the plugin with a fake `orca` module; `ui/tests/panel_flow.cjs` runs the built panel in jsdom with OrcaSlicer's real JS bridge (OrcaSlicer swallows page JS errors, so this is the only place they show up).
