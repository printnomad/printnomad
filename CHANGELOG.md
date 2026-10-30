# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); components use [Semantic Versioning](https://semver.org/) and are tagged as `core-vX.Y.Z` and `orca-plugin-vX.Y.Z`.

## [Unreleased]

### Fixed
- **Filament diameter 2.85 mm instead of 1.75 mm** for Flashforge PLA profiles: profile inheritance now resolves parents within the same vendor, then the common filament library, as OrcaSlicer does. Projects converted with earlier versions must be converted again before printing.

### Added
- **Any printer as target**: the target is built from any machine preset (system or user) of an installed slicer; extruders, nozzle variants, bed type, limits, compatible processes and filaments are derived from the profiles. User presets are found too (e.g. your own calibrated filament for the same brand). CLI: `--printer` and `--slicer` replace `--target creator5pro`.
- **Designer's filament choices kept**: temperatures (nozzle and plates) and density the designer changed are kept on top of the target filament profile; hardware- or calibration-dependent settings (max volumetric speed, flow ratio, pressure advance, cooling) come from the target. `--no-designer-filament` turns it off.
- `betterbridge printers [--slicer X] [--search text] [--json]` lists the printer presets (system and yours) of the installed slicers.
- Data-driven registry of slicers (`data/slicers.json`) with per-slicer quirks; when the result will also be opened in OrcaSlicer, its stricter manual-mapping limit applies.
- Internationalisation: all user-facing text in JSON catalogs (English and Spanish), `--lang` option, language detection (system or OrcaSlicer's), translation guide in `docs/translating.md` with automatic checks for translators.

### Changed
- OrcaSlicer plugin panel rebuilt with Tailwind CSS v4 (only the classes in use are shipped, ~9 KiB), semantic light/dark theme tokens, translated text, separate `ui/` sources with a Node build; tested in jsdom with OrcaSlicer's real JS bridge.
- The report flags `needs_map` when filaments must be assigned to extruders manually (the CLI and the plugin no longer parse error text).
- The OrcaSlicer plugin capability is now named `BetterBridge` (re-enable it once in the Plugins dialog).
- Repository reorganised as a monorepo (`core/`, `orca-plugin/`, `tools/`), licensed AGPL-3.0-or-later, with contribution guidelines and CI.

## core 0.1.0 / orca-plugin 0.2.9 — 2026-10-30 (first internal version)

### Added
- Conversion of Bambu Studio / PrusaSlicer 3MF projects to the Flashforge Creator 5 Pro using the profiles of the installed Flash Studio (inheritance resolved at runtime).
- Designer's process settings kept on top of the target profile; values beyond printer limits are warned, never changed silently; volumetric-flow note when the slicer will cap a speed.
- Filament mapping to 4 extruders (per plate, or `--map`); colour, extruder colour and `filament_printable` set for the target.
- Cooling always taken from the target printer; Bambu-only keys and values rejected by OrcaSlicer removed or fixed, all reported.
- Bambu Studio 2.x per-extruder-variant values collapsed to the target's single variant.
- Plate recentering for smaller source beds (e.g. A1 mini); geometry verified byte-identical.
- OrcaSlicer plugin: notification on project open, preview panel (filament → extruder, nozzle), conversion with overwrite confirmation, "Open in OrcaSlicer / Flash Studio", experimental same-window opening through a local server.
- Tools: OrcaSlicer CLI validation, panel preview in the browser.
