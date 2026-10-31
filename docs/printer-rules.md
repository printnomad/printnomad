# Printer rules

Some process settings describe the machine, not the model. BetterBridge takes them from
your printer's profile by default (see [features.md](features.md)). Which ones, and
whether a printer needs an exception, is data in
[`core/src/betterbridge/data/printer_rules.json`](../core/src/betterbridge/data/printer_rules.json),
so adding or verifying a printer does not require touching the converter.

## Setting groups

| Group | Settings | Why it belongs to the printer |
|---|---|---|
| `purge_tower` | purge/prime tower, purge into infill/objects/support | depends on how the machine changes colour |
| `kinematics` | accelerations | the machine's motion system |
| `calibration` | elephant foot, XY compensation, first-layer flow | your bed and machine calibration |
| `firmware` | arc fitting (G2/G3) | firmware support |
| `file_naming` | G-code file name | your preference |

Cooling is handled separately (fans differ in power and numbering on every printer).

## Kinds of printers

The kind is detected from the printer profile:

| Architecture | Detected when | Colour changes |
|---|---|---|
| `single` | one extruder | manual |
| `filament_changer` | one nozzle with `single_extruder_multi_material` (AMS, IFS, ACE, MMU) | the old colour is purged in the tower, or through a purge chute (Bambu) |
| `toolchanger` | several extruders (independent toolheads, tool changers, IDEX) | no colour purge; idle heads may be cooled and the tower primes the next head |

## Policies and precedence

For every group a rule says `printer` (the target profile applies) or `model` (the
designer's value is kept). A printer model's rule overrides its architecture's, which
overrides `default_policies`. Users can still keep the model's values with the advanced
option *Also keep the model's printer settings*.

## Verified or generic

A rule is **verified** only after converting and printing on that printer; the entry
records how (`verified`). Every report states which rule applied:

- *Printer rules: verified for Flashforge Creator 5 Pro (several toolheads)*
- *Printer rules: generic for printers with a single nozzle and filament changer, not yet verified on …* plus a link to report how it went.

## Add or verify a printer

1. Convert a project with BetterBridge and print it.
2. Open a [printer rules issue](https://github.com/BetterBridge/betterbridge/issues/new?template=printer_rules.yml)
   with the report and what happened, or send a pull request adding the printer under
   `printers` (key = the profile's `printer_model`), with its `architecture`, any
   `policies` that differ, `verified` (date, slicer and profile version, what you checked)
   and `notes`.
3. `pytest core/tests/test_printer_rules.py` checks the file.

### Example

```json
"Flashforge Creator 5 Pro": {
  "architecture": "toolchanger",
  "policies": {},
  "verified": "2026-10-30, Flash Studio 1.7.20 profiles: purge tower from the printer …",
  "notes": "Turning the tower off is possible at the risk of under-extrusion after each head change."
}
```
