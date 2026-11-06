# printnomad (core)

Conversion engine of [PrintNomad](../README.md): converts 3MF slicer projects (Bambu Studio, PrusaSlicer) for another printer and Orca-based slicer, keeping the designer's settings and reporting every change.

Standard library only, Python 3.12+ (it also runs inside OrcaSlicer's embedded Python).

## Command line

For developers and advanced users. Most people should use the [browser extension](../README.md).

It needs an installed slicer with the target printer's profiles (macOS today: Flash Studio, Bambu Studio; OrcaSlicer 2.5 user presets).

```sh
python -m venv .venv && .venv/bin/pip install -e core
.venv/bin/printnomad ~/Downloads/model.3mf --printer "Flashforge Creator 5 Pro 0.4 nozzle"
# -> ~/Downloads/model_CREATOR5_PRO.3mf and model_CREATOR5_PRO.report.json
```

`--printer` takes any printer preset of an installed slicer, system or your own (a unique part of the name is enough; list them with `printnomad printers [--search text]`). Add `--slicer flashstudio|bambustudio|orcaslicer` to pick the slicer, or `--profiles-dir DIR` for a profiles folder. Other options: `--map 1:1,2:2,5:1` (choose the extruder of each filament; those sharing one are merged), `--nozzle 0.6`, `--out DIR`, `--force`, `--lang`, `-v`. Exit codes: `0` converted, `1` error.

## Modules

Modules: `read_3mf` (read, detect source), `slicers` + `data/slicers.json` (installed slicers and where their profiles live), `profiles` (system and user presets, inheritance), `target` (target printer derived from any machine preset), `rules` (OrcaSlicer/Bambu config rules), `remap_filaments`, `model_edit` (plates, overrides, positions), `convert` (pipeline), `report`, `write_3mf`, `i18n`, `cli`.
