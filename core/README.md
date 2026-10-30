# betterbridge (core)

Conversion engine of [BetterBridge](../README.md): converts 3MF slicer projects (Bambu Studio, PrusaSlicer) for another printer and Orca-based slicer, keeping the designer's settings and reporting every change.

Standard library only, Python 3.12+ (it also runs inside OrcaSlicer's embedded Python).

```sh
pip install -e core
betterbridge model.3mf --target creator5pro      # or: python -m betterbridge …
```

Modules: `read_3mf` (read, detect source), `profiles` (find and resolve slicer profiles), `printer_profiles/` (target definitions), `remap_filaments`, `model_edit` (plates, overrides, positions), `convert` (pipeline), `report`, `write_3mf`, `cli`.
