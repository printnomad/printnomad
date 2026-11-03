# printnomad (core)

Conversion engine of [PrintNomad](../README.md): converts 3MF slicer projects (Bambu Studio, PrusaSlicer) for another printer and Orca-based slicer, keeping the designer's settings and reporting every change.

Standard library only, Python 3.12+ (it also runs inside OrcaSlicer's embedded Python).

```sh
pip install -e core
printnomad model.3mf --printer "Flashforge Creator 5 Pro 0.4 nozzle"   # or: python -m printnomad …
```

Modules: `read_3mf` (read, detect source), `slicers` + `data/slicers.json` (installed slicers and where their profiles live), `profiles` (system and user presets, inheritance), `target` (target printer derived from any machine preset), `rules` (OrcaSlicer/Bambu config rules), `remap_filaments`, `model_edit` (plates, overrides, positions), `convert` (pipeline), `report`, `write_3mf`, `i18n`, `cli`.
