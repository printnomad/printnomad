# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); components use [Semantic Versioning](https://semver.org/) and are tagged as `core-vX.Y.Z` and `orca-plugin-vX.Y.Z`.

## [Unreleased]

### Fixed
- Bambu G-code from a Bambu target profile is no longer flagged; `retraction_distances_when_cut = 0` (rejected by the slicer, shipped in a Flash Studio profile) is dropped; Standard processes win layer-height ties.
- **Filament diameter 2.85 mm instead of 1.75 mm** for Flashforge PLA profiles: profile inheritance now resolves parents within the same vendor, then the common filament library, as OrcaSlicer does. Projects converted with earlier versions must be converted again before printing.

### Added
- **Conversion options as data** (`betterbridge.options`): one list of options with defaults and translated labels, help and warnings, shared by the CLI, the plugin and the extension. CLI: `--map-mode`, `--designer-cooling`.
- **Filament assignment mode**: `compatible` (default; the slicer finalises the assignment, so projects slice in any Orca-based slicer, as other converters do), `exact` (the planned assignment is enforced; OrcaSlicer 2.5 rejects it on extruders 3–4) and `slicer` (previous behaviour). An assignment chosen by hand is always enforced.
- **The designer's changes with their original values**: with the source slicer's profiles (Bambu Studio's public profiles in the extension, or an installed Bambu Studio for the CLI and the plugin) the report shows each kept change as *original preset value → model value (target profile value)*. Settings marked as changed that still equal the original are not treated as the designer's choice. See [docs/features.md](docs/features.md).
- **Source preset defaults are no longer carried over**: values a project only has because of its Bambu presets (the designer did not change them and the target profile does not set them; ~200 per project) are removed so the target slicer applies its own defaults, as when the printer is picked from scratch. Re-selecting the printer in the slicer now only lists the model's real changes. Project data (purge tower position, purge table, print order, filament per feature) is kept.
- **Printer-dependent process settings come from the target**: accelerations, elephant foot and XY compensation, first-layer flow, arc fitting and the G-code file name (`rules.PRINTER_PROCESS_KEY`), the same rule for every printer. The purge tower follows the model. Option `keep_designer_printer_settings` (off by default, with a warning) keeps the model's values.
- **Designer's cooling** can be kept on request (`keep_designer_cooling`, off by default) with a warning: fan percentages refer to the source printer's fans.
- **Browser extension** (`extension/`, Chrome/Chromium, Manifest V3): converts projects in the browser with the same core (Pyodide), for the printers in *My printers*; downloads the result and shows it in Finder. Profiles are automatic (catalog, bundled fallback); options page with an advanced mode and a manual "convert a file". English and Spanish.
- `tools/build_profile_catalog.py --from-app` builds the catalog from an installed slicer release when its repository lags behind (Flash Studio 1.7.20 vs repository 1.7.15).
- **Profile catalog** from the slicers' official repositories (`tools/build_profile_catalog.py`, published weekly by CI): one bundle per vendor with sha256 and the usable printers; conversions with it are byte-identical to using the repository folders.
- Reports name where the target profiles came from (folders, or `repo@release`).
- **Any printer as target**: the target is built from any machine preset (system or user) of an installed slicer; extruders, nozzle variants, bed type, limits, compatible processes and filaments are derived from the profiles. User presets are found too (e.g. your own calibrated filament for the same brand). CLI: `--printer` and `--slicer` replace `--target creator5pro`.
- **Designer's filament choices kept**: temperatures (nozzle and plates) and density the designer changed are kept on top of the target filament profile; hardware- or calibration-dependent settings (max volumetric speed, flow ratio, pressure advance, cooling) come from the target. `--no-designer-filament` turns it off.
- `betterbridge printers [--slicer X] [--search text] [--json]` lists the printer presets (system and yours) of the installed slicers.
- Data-driven registry of slicers (`data/slicers.json`) with per-slicer quirks; when the result will also be opened in OrcaSlicer, its stricter manual-mapping limit applies.
- Internationalisation: all user-facing text in JSON catalogs (English and Spanish), `--lang` option, language detection (system or OrcaSlicer's), translation guide in `docs/translating.md` with automatic checks for translators.

### Changed
- OrcaSlicer plugin 0.4.0: the target printer is configurable (`slicer`, `printer` in the Config tab); output names use the printer model (e.g. `_CREATOR5_PRO`, `_BAMBU_LAB_P1S`).
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
