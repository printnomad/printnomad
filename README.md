# BetterBridge

Open a 3D-printing project from any model repository in **your** printer's slicer, keeping the designer's settings.

BetterBridge converts 3MF projects made in Bambu Studio (and PrusaSlicer, basic support) for another printer and another Orca-based slicer: it swaps the printer, process and filament profiles for the target ones, keeps the designer's tweaks on top, maps filaments to the target's extruders, and reports every change it makes. The original file is never modified and the geometry stays byte-identical.

> **Status:** early development. The converter works today for the Flashforge Creator 5 Pro (validated by slicing in OrcaSlicer 2.5 and Flash Studio 1.7). Support for any printer and a browser extension for MakerWorld are in progress.

*Español:* BetterBridge convierte proyectos 3MF de Bambu Studio para abrirlos en el laminador de tu impresora (OrcaSlicer y sus derivados), conservando los ajustes del diseñador. La documentación en español llegará con la primera versión pública.

## Components

| Folder | What it is | Status |
|---|---|---|
| [`core/`](core/) | `betterbridge` Python package: 3MF reading, profile resolution, conversion, report, CLI. Standard library only. | Working (Creator 5 Pro) |
| [`orca-plugin/`](orca-plugin/) | OrcaSlicer plugin: offers to convert the opened project, previews filament → extruder mapping, writes the copy and opens it. | Working (OrcaSlicer 2.5 beta) |
| `extension/` | Browser extension: "Open with [slicer]" button on MakerWorld and other repositories. | Planned |
| `helper/` | Optional local helper to open the converted project directly in the chosen slicer. | Planned (experimental) |
| [`tools/`](tools/) | Developer tools, e.g. validating converted files by slicing them with the OrcaSlicer CLI. | — |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Quick start (CLI)

Requires Python 3.12+ and a slicer installation that provides the target profiles (today: Flash Studio).

```sh
python -m venv .venv && .venv/bin/pip install -e core
.venv/bin/betterbridge ~/Downloads/model.3mf --target creator5pro
# -> ~/Downloads/model_CREATOR5_PRO.3mf and model_CREATOR5_PRO.report.json
```

Options: `--map 1:1,2:2,5:1` (filament → extruder, only needed when a plate uses more filaments than the printer has extruders), `--nozzle 0.6`, `--out DIR`, `--force`, `-v`. Exit codes: `0` converted, `1` error, `2` needs `--map`.

## OrcaSlicer plugin

```sh
.venv/bin/python orca-plugin/tools/build.py --install
```

Restart OrcaSlicer (⌘Q) and enable **BetterBridge** in the Plugins dialog. Opening a Bambu Studio project shows a "Convert to …" notification. See [orca-plugin/README.md](orca-plugin/README.md).

## Development

```sh
python -m venv .venv && .venv/bin/pip install -e core pytest ruff
(cd orca-plugin/tests/js && npm ci)   # optional: browser-DOM tests of the plugin panel
.venv/bin/ruff check . && .venv/bin/pytest
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[AGPL-3.0-or-later](LICENSE), the same license as OrcaSlicer. Slicer profiles are read from the user's installation or downloaded from the slicers' official repositories; they belong to their respective projects.
