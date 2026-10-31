# How BetterBridge converts a project

A 3MF project from MakerWorld or Bambu Studio mixes three kinds of values. BetterBridge
treats each one differently, so the converted project prints like the designer
intended **on your printer**, and every change is written in the conversion report.

| Kind | Examples | Comes from |
|---|---|---|
| **The printer** | bed, start/end G-code, extruders, limits, purge tower, accelerations, calibration (elephant foot, XY compensation), cooling | your printer's profile |
| **The model** | supports, infill, walls, layer height, seam, ironing, fuzzy skin, speeds — whatever the designer changed | the project |
| **Slicer factory defaults** | everything else (hundreds of settings) | your slicer's own defaults |

## The model's values, and only those

A Bambu project stores *every* setting of its presets, but it also records which ones
the designer changed (`different_settings_to_system`). BetterBridge keeps exactly those.

**Factory defaults of the source slicer are not carried over.** Values that are in the
project only because Bambu's presets set them (about 200 per project) are removed when
your printer's profile does not define them, so your slicer applies its own defaults —
the same result as picking your printer from scratch.

*Why it matters:* converters that keep the whole project leave Bambu's factory values
behind. When you select the printer again, the slicer lists them all as "modified"
(Flash Studio's *Transfer or discard changes* dialog) and you cannot tell the designer's
choices from leftovers. With BetterBridge that dialog only shows the designer's real
changes, so **Transfer** is the right answer.

## You see what the designer changed, and from what

When the source slicer's profiles are available (BetterBridge downloads Bambu Studio's
public profiles, or uses an installed Bambu Studio), the report shows each change with
the original value of the preset the designer started from:

```
bridge_speed: 50 → 10 (target profile: 35)
```

*original preset value → the model's value (what your printer's profile would use)*.

Settings a project marks as changed although they still have the original value
(it happens with MakerWorld "Shared" profiles) are not treated as the designer's
choice; your printer's value applies.

## Printer settings come from your printer

Some process settings describe the machine, not the model, and are taken from your
printer's profile even when the designer changed them:

- **Purge tower** (and purging into infill/objects). A tool changer such as the
  Flashforge Creator 5 Pro lowers idle heads by 80 °C and primes the next head on the
  tower; MakerWorld projects often turn it off for Bambu printers.
- **Accelerations** — the machine's kinematics.
- **Calibration** — elephant foot and XY compensation, first-layer flow.
- **Arc fitting** (firmware support) and the **G-code file name** (your preference).
- **Cooling** — fan percentages refer to each printer's own fans, which differ in power,
  number and numbering.

Speeds stay the model's: your slicer caps every move at the filament's maximum
volumetric speed when slicing, so a faster filament still benefits.

Advanced mode can keep the model's cooling or printer settings anyway; each option
explains its risk.

## Opens in any slicer

Filament-to-extruder assignment uses the slicer's *automatic* mode by default, so the
project slices in every Orca-based slicer (OrcaSlicer rejects a manual assignment on
extruders 3–4). The planned assignment is kept as the suggestion. Advanced mode offers
*Exact* (manual) for Flash Studio, and an assignment you choose by hand is always kept.

## Current printer profiles

Profiles come from the slicers' official releases, and the report names the source and
version (for example *Flash Studio 1.7.20*). When a slicer's public repository lags behind
its app — Flashforge's repository was at 1.7.15 while Flash Studio shipped 1.7.20 —
BetterBridge uses the profiles of the released app. Copies of old profiles are what make
slicers show "old vs new" values after a conversion.

## Nothing silent

Every replaced, kept, removed or warned value is in the report (text and JSON), including
per-object overrides one by one. Geometry, colour painting and the original file are never
modified.
