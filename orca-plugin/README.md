# BetterBridge — OrcaSlicer plugin

Converts the project open in OrcaSlicer (2.5+, plugin API in beta) to another printer using the BetterBridge core.

## Install

```sh
.venv/bin/python orca-plugin/tools/build.py --install
```

This builds `orca-plugin/dist/betterbridge_orca-<version>-py3-none-any.whl` (the plugin plus a copy of `core/`) and copies it to `~/Library/Application Support/OrcaSlicer/orca_plugins/betterbridge/`, clearing OrcaSlicer's extracted copy (OrcaSlicer does not refresh it on its own). Restart OrcaSlicer with ⌘Q and enable the plugin in the Plugins dialog.

## How it works

1. On `ProjectOpened`, if the project comes from Bambu Studio / PrusaSlicer, a notification offers the conversion.
2. The dock panel shows a preview: filament → extruder (editable), nozzle, process profile, warnings.
3. **Convert** writes `<name>_CREATOR5_PRO.3mf` next to the original (asks before replacing) and shows the report.
4. **Open in OrcaSlicer / Flash Studio** asks macOS to open it (another window). Experimental option: same window, via a local HTTP server and `orcaslicer://open?file=http://127.0.0.1…`.

Permissions requested from OrcaSlicer: read Flash Studio profiles; read/write `~/Downloads`, `~/Documents`, `~/Desktop`; fixed `open -a …` commands. The experimental option asks for a local port and one thread when used.

Debug log: `~/Library/Application Support/OrcaSlicer/orca_plugins/plugin_data/betterbridge/debug.log`.

## Development

- `tools/preview_panel.py project.3mf` renders the panel with real data in a browser (no OrcaSlicer needed).
- `tests/test_plugin.py` drives the plugin with a fake `orca` module; `tests/js/panel_flow.js` runs the panel in jsdom with OrcaSlicer's real JS bridge (OrcaSlicer swallows page JS errors, so this is the only place they show up).
