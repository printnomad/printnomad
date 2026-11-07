# How PrintNomad converts a project

A 3MF project from MakerWorld or Bambu Studio mixes three kinds of values. PrintNomad
treats each one differently, so the converted project prints like the designer
intended **on your printer**, and every change is written in the conversion report.

| Kind | Examples | Comes from |
|---|---|---|
| **The printer** | bed, start/end G-code, extruders, limits, accelerations, retraction, calibration (elephant foot, XY compensation), cooling | your printer's profile |
| **The model** | supports, infill, walls, layer height, seam, ironing, fuzzy skin, speeds, purge tower — whatever the designer changed | the project |
| **Slicer factory defaults** | everything else (hundreds of settings) | your slicer's own defaults |

## The model's values, and only those

A Bambu project stores *every* setting of its presets, but it also records which ones
the designer changed (`different_settings_to_system`). PrintNomad keeps exactly those.

**Factory defaults of the source slicer are not carried over.** Values that are in the
project only because Bambu's presets set them (about 200 per project) are removed when
your printer's profile does not define them, so your slicer applies its own defaults —
the same result as picking your printer from scratch.

*Why it matters:* converters that keep the whole project leave Bambu's factory values
behind. When you select the printer again, the slicer lists them all as "modified"
(Flash Studio's *Transfer or discard changes* dialog) and you cannot tell the designer's
choices from leftovers. With PrintNomad that dialog only shows the designer's real
changes, so **Transfer** is the right answer.

**A layer height your printer has no process for** is kept. A project made with Bambu's
*0.16mm High Quality* on a printer with 0.12 and 0.20 processes prints at 0.16 mm over the
nearest process; every other setting comes from that process, plus the designer's changes,
and the report lists the layer height apart. The first layer also comes from your printer's
process, unless the designer changed it.

## You see what the designer changed, and from what

When the source slicer's profiles are available (the extension includes Bambu Studio's
public profiles; the command line uses an installed Bambu Studio), the report shows each
change with the original value of the preset the designer started from:

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

- **Accelerations** — the machine's kinematics.
- **Calibration** — elephant foot and XY compensation, first-layer flow.
- **Arc fitting** (firmware support) and the **G-code file name** (your preference).
- **Cooling** — fan percentages refer to each printer's own fans, which differ in power,
  number and numbering.

The **purge tower** stays the model's: whether the colour changes of a design need it is
the designer's call. If the designer did not change it, your printer's profile decides.
Keep in mind that a model made for a Bambu printer (which purges through a chute) may
turn it off; on a tool changer such as the Flashforge Creator 5 Pro (idle heads cooled by
100 °C) you can turn it back on in the slicer if the first lines after a head change
come out thin.

Speeds stay the model's: your slicer caps every move at the filament's maximum
volumetric speed when slicing, so a faster filament still benefits.

The same rule applies to every printer: PrintNomad does not keep per-printer
exceptions, which would need someone to verify each machine. The printer maker's profile
is the reference, and you decide when the model's values should win.

The conversion preferences can keep the model's cooling or printer settings anyway; each option
explains its risk.

## Filament settings

The designer's temperatures, filament density and flow ratio are kept on top of your
printer's filament profile, but only when the designer changed them on purpose: a value that
merely comes from their preset is not kept. Flow ratio is usually calibrated per printer and
filament, so the designer's value may not be ideal on your machine; check it in the slicer, or
turn off the *Filament settings* preference. Maximum volumetric speed and pressure advance
depend on the hardware and always come from your printer's profile.

## Your build plate

Each printer in *My printers* can have its own build plate, when its slicer lets you choose
one: the menu lists the plates that slicer offers for that printer, such as Cool Plate and
Cool Plate SuperTack on the Flashforge Creator 5 Pro. Without a choice, the printer's default
applies. The plates of a converted project all follow that choice, so changing it in the slicer
updates every plate. If the slicer would refuse a filament on the chosen plate (PETG on a Cool
Plate, for example), the report says so.

## Painted colours are read, not guessed

Many MakerWorld projects define more colours than a printer has extruders but paint only
a few of them on each plate. PrintNomad decodes the colour painting of every triangle
(the same format OrcaSlicer and Bambu Studio use) to know which filaments each plate
really needs, and assigns extruders plate by plate. If one plate truly uses more filaments
than the printer has extruders, every colour is kept, the project stays in the slicer's
automatic mode, and a warning tells you to choose how to print them in your slicer. The
command line and the OrcaSlicer plugin also accept a manual assignment.

## The filaments it really prints

The converted project lists only the filaments it uses: colours the project defines but
never uses are removed. A project that defines 12 colours and uses 4 opens with 4 filaments,
not 12 — and the slicer does not keep 12 filament slots after you close it. With a manual
assignment, several colours sent to one extruder become one filament. Every place that names
a filament is renumbered:
filament settings, the purge table, objects and parts, plates, per-layer colour changes,
height ranges, the filaments chosen for walls, infill, support or the purge tower, and the
colour painting of each triangle (the meshes themselves are untouched; each
rewritten paint code is checked to keep its shape and its new colours).

## A project that will not slice gets fixed

A project already set up for your printer is not skipped blindly: it is reviewed, and
values that would stop it slicing are fixed (the file is saved as `…_fixed.3mf`). The
known case is the extruders each filament may use (`filament_printable`). Filament
presets saved by users often carry the default of Bambu's two-nozzle code (extruders 1
and 2 only); after picking such a preset in Flash Studio, a manual assignment to
extruders 3–4 fails with *"The right nozzle can not print PLA"*. The review opens those
filaments to every extruder. A restriction set by the printer maker's own preset (for
example a flexible filament limited to some extruders) is kept, by the conversion too,
and the report warns when the assignment sends that filament elsewhere. The preset
that caused the problem stays as it is in the slicer: fix it there (or the review will
be needed again after picking it).

## Opens in any slicer

Filament-to-extruder assignment uses the slicer's *automatic* mode by default, so the
project slices in every Orca-based slicer (OrcaSlicer rejects a manual assignment on
extruders 3–4). The planned assignment is kept as the suggestion. The conversion preferences offer
*Exact* (manual) for Flash Studio, and an assignment you choose by hand is always kept. A plate
with more colours than extruders stays automatic unless you assign it by hand.

## The right slicer for each printer

A converted project is self-contained and prints the same wherever it is opened, but it
is only *exact* for the slicer whose profiles it was converted with: same profile version,
preset names that slicer knows, and no false "modified" values when the printer is
selected again. Compared on a Creator 5 Pro, Flash Studio 1.7.20 and OrcaSlicer 2.4.2
differ in 27 of 142 machine settings (end G-code included).

So each printer uses its brand's own slicer when there is one (Flash Studio for
Flashforge, Bambu Studio for Bambu Lab) and OrcaSlicer, which ships profiles for most
brands, for the rest — nothing to choose. A printer's slicer can be changed when setting it
up or with Edit. Other converters made for one
brand do the same implicitly (ForgeBridge targets Flash Studio; the Snapmaker U1
converter targets Snapmaker Orca, with an OrcaSlicer compatibility switch).

## Printer profiles

The extension includes its printer profiles, so it needs no connection to get them. They come
from tagged releases of each slicer's public repository, and the report names the source and
version. A public repository can lag behind its app: the extension uses Flashforge's 1.7.15,
while Flash Studio has shipped 1.7.20. When your slicer's profiles are newer than the ones used
for the conversion, it can show some "old vs new" values. The command line reads the profiles of
your installed slicer instead.

## Right on MakerWorld

Your printers appear in MakerWorld's *Print Files* as if MakerWorld supported them: a
Creator 5 Pro chip next to A1, P1S…, with your printers first and a divider before the rest.
Printers MakerWorld already lists, and Bambu Lab printers in general, keep MakerWorld's own
button and are not converted there.
Pick it and the green button becomes *Download for Creator 5 Pro*: the project is
downloaded through MakerWorld as usual, converted in the browser and saved — only the
converted file.

## Nothing silent

Every replaced, kept, removed or warned value is in the report (text and JSON), including
per-object overrides one by one. The original file is never modified, and the meshes stay
byte-identical; colour painting is only renumbered when filaments are (see above).