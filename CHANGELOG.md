# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); components use [Semantic Versioning](https://semver.org/) and are tagged as `core-vX.Y.Z` and `orca-plugin-vX.Y.Z`.

## [Unreleased]

### Changed
- **On MakerWorld, your printers come first**, followed by a divider and the model's other printers. They carry PrintNomad's mark and colours. Adding a printer saves it right away; Edit is there to change it. Bambu Lab printers keep MakerWorld's own button and are no longer converted there.

### Fixed
- **No more errors in open MakerWorld tabs after the extension is reloaded or updated.** A chip of ours is also removed when MakerWorld lists that printer itself.
- **MakerWorld downloads no longer time out after changing chip or model**: the button could still be set to "Open in Bambu Studio" and was pressed anyway. A click that starts nothing is retried after 8 seconds, and the sign-in message only appears when MakerWorld really refuses the download. While it works, the button shows the spinner and "Downloading…" or "Converting…" in a fixed place, on a layer of its own, so whatever MakerWorld writes on the button meanwhile is not seen. Closing the save dialog no longer shows "Not saved".
- **MakerWorld's label no longer flashes on the button** while a project is being converted.

### Changed
- **More colours than extruders no longer stops the conversion**: every colour is kept, the project stays in automatic assignment and a warning says to choose the extruders in the slicer. The assignment screen, the `needs_map` report flag and error PN303 are gone; `--map` remains in the CLI.
- **Renamed from BetterBridge to PrintNomad** (the old name was taken on GitHub). Python packages are now `printnomad` and `printnomad_orca`; environment variables `PRINTNOMAD_PROFILES` and `PRINTNOMAD_LANG` replace `BETTERBRIDGE_*`.

### Changed
- **The designer's flow ratio is kept** when they changed it on purpose, like temperatures and density. A value that only comes from their filament preset still gives way to your printer's profile.

### Added
- **Store package:** `npm run package` makes a checked release zip, with profiles from pinned public slicer tags (`tools/build_release_catalog.sh`). Privacy policy (`docs/privacy.md`) and third-party notices.

### Fixed
- **Windows and Linux lost slicer-specific rules:** the extension converted without them, because the slicer registry left out slicers with no verified local paths on that system.
- **Support materials are no longer picked as a project's plain filament:** a Snapmaker U1 project in PLA could get "Breakaway Support For PLA".
- **Bed temperature on printers with a fixed plate** (Prusa, Neptune, Kobra 3…): they kept the project's plate, so a Bambu project on a Cool Plate printed PLA at 35 °C. They now use the plate the slicer would pick. A default plate given as a number (Elegoo Centauri Carbon) is understood; it also printed at 35 °C.
- **Printers whose profiles use conditions** (`compatible_printers_condition`: Prusa MK4S, CORE One…) are now offered: the expressions are evaluated (`conditions.py`). Filaments of the common library back up printers that have none of a material (Voron, Sovol SV06).
- **Purge tower kept on smaller beds**, moved like the objects: its position in the project made the slicer refuse to slice. An empty `filament_notes` no longer stops Prusa's start G-code.
- **Layer height kept when the printer has no process for it**: a 0.16 mm project on a printer with 0.12 and 0.20 processes was silently printed at 0.12 mm. The project's layer height is now kept over the nearest process and listed apart in the report; every other setting comes from that process.
- **First layer height comes from the target's process**, unless the designer changed it; it used to be kept from the project and declared a designer change. Very thin objects may need it lowered in the slicer.
- **Line widths in % become mm**: `*_line_width` values such as `skin_infill_line_width = 100%` are converted with the target nozzle's diameter in the project settings, object and part overrides and height ranges. Bambu Studio and QIDI Studio read them as 100 mm ("too large line width").
- **Profiles saved with a UTF-8 BOM are read** (Snapmaker Orca 2.4.1), also by the catalog builder; they used to be skipped silently.
- **Filaments chosen per feature are kept**: a filament chosen for walls, infill, support (when the object prints support or a raft) or the purge tower, on the project, an object or a part, could be removed as unused, and support silently moved to filament 1. They now count as used and are renumbered; such a filament with no equivalent on the target is now an error.
- **Filaments chosen in height ranges are kept**: a filament used only by a height range could be removed as unused, and the range kept the old number after renumbering (the slicer falls back to filament 1).
- **Faster verification of the written 3MF**: copied entries are checked by the CRC-32 and size the ZIP records for them instead of decompressing the whole file and hashing the geometry twice (half of the conversion time in the browser: SpeedBoat 435 → 217 ms in Pyodide). Replaced entries are still compared byte by byte.
- Bambu G-code from a Bambu target profile is no longer flagged; `retraction_distances_when_cut = 0` (rejected by the slicer, shipped in a Flash Studio profile) is dropped; Standard processes win layer-height ties.
- **Filament diameter 2.85 mm instead of 1.75 mm** for Flashforge PLA profiles: profile inheritance now resolves parents within the same vendor, then the common filament library, as OrcaSlicer does. Projects converted with earlier versions must be converted again before printing.

### Changed
- **New design**: home page with the conversion preferences always visible, first-run onboarding, printers as cards edited in place with a Save button, and a separate screen to add one in two clicks. Light theme only for now. Advanced mode and the switch for one slicer on every printer are gone; settings saved by earlier versions are migrated.

### Added
- **A short list of tested printers** (`supportedModels` in `extension/config.json`) and a simpler page; printers saved earlier keep working. Your printer not on the list? Ask for it in one click.
- **Send report**: one click, no account or email, from the options page and from a panel on MakerWorld that also explains the error. The panel shows the exact text sent; the 3MF never leaves the browser. Reports become issues in a private repository through `tools/report-worker` (a Cloudflare Worker that keeps the token). While `reportUrl` is empty, only Copy report is offered. An optional email lets us answer; it is sent only with the report, not copied with it.
- **Errors with a code, a stage and what to do**: every conversion error has a stable code (`PN401`, see `issues.py`), the stage that failed and a suggestion, in the report and on the options page. A damaged file or an unexpected failure is now a report instead of a raw exception. **Copy report** puts the report on the clipboard with version, printer, slicer, file and browser, ready to send; nothing leaves the browser by itself. On MakerWorld the button shows the code.
- **Choose the build plate of each printer**: in *My printers*, each printer whose slicer lets you choose the plate (Bambu printers and `support_multi_bed_types`) has a menu with the plates that slicer offers, e.g. Cool Plate and Cool Plate SuperTack on the Creator 5 Pro. Converted projects use it; CLI: `--bed-type`. Plates no longer carry a type of their own, so changing it in the slicer updates them all. The report warns when the slicer will refuse a filament on the chosen plate (e.g. PETG on a Cool Plate).
- **Projects that will not slice are fixed**: a project already set up for the printer is reviewed instead of skipped (`repair.py`; saved as `…_fixed.3mf`). Filaments whose `filament_printable` came from a preset made for another printer (Bambu's two-nozzle default, copied into user presets; Flash Studio then refuses manual assignments to extruders 3–4 with *"The right nozzle can not print PLA"*) are opened to every extruder. The printer maker's own restrictions are kept — also by the conversion, which used to open every filament to every extruder — and reported when the assignment breaks them.
- **Only the filaments it prints**: converted projects drop the filaments they never use and merge the colours sent to one extruder (e.g. 12 colours on 4 extruders → 4 filaments), renumbering filament settings, purge table, objects and parts, plate maps, per-layer changes and the paint codes of every triangle (meshes untouched; each rewritten paint code is checked). The report lists what was removed and merged. 21 of 90 real projects drop unused filaments.
- **Assignment screen** (options page and MakerWorld): when a plate really uses more colours than the printer has extruders, a screen shows each colour with its plates and a suggested assignment — similar colours (CIELAB ΔE) of the same material share an extruder — that can be changed before converting. On MakerWorld it opens over the page and the project is not downloaded again.
- **Colour painting read, not guessed**: the paint of every triangle (Bambu `paint_color`, PrusaSlicer `mmu_segmentation`) is decoded like OrcaSlicer's TriangleSelector, so a plate counts only the filaments really painted on it. Projects that define many colours but paint a few per plate convert without manual assignment (14 of 14 painted projects tested, e.g. 5 colours over 6 plates). Validated against OrcaSlicer's table of paint codes.
- **MakerWorld integration**: in *Print Files*, chips for your printers that MakerWorld does not list, looking like MakerWorld's own; with one selected, the green button and its menu offer *Download for <printer>*, which captures MakerWorld's own 3MF download (your session), converts it in the browser and saves only the converted file. makerworld.com and makerworld.com.cn.
- **Slicer chosen automatically**: each printer uses its brand's slicer (Flash Studio for Flashforge, Bambu Studio for Bambu Lab…) and OrcaSlicer for the rest (`slicers.json` → `makers`, `general`). Advanced mode can use OrcaSlicer for every printer; a single printer's slicer can be changed on its card.
- **Convert for all my printers at once**: with several printers, one click makes one file per printer (the default choice); a project already set up for one of them is skipped ("already set up", also when the designer used a preset of their own for the same model and nozzle). Each printer gets its own line with status, a summary and its report.
- **Every printer profile ships with the extension**: the bundles of Flash Studio, Bambu Studio and OrcaSlicer (~1.4 MB gzipped, decompressed on use) and their thumbnails, so every printer is available offline from the first day. The online catalog only brings updates; unchanged bundles are read from the shipped copy.
- **Printer picker with pictures**: search box, brand filters, a short list of popular printers (`extension/config.json` → `featuredModels`; everything else by search or brand), each model as a card with its thumbnail; nozzle and slicer are chosen afterwards (the brand's own slicer first). The catalog now carries vendor display names and printer thumbnails (WebP, ~7 KB each, from the slicers' `<model>_cover.png`).
- **Conversion options as data** (`printnomad.options`): one list of options with defaults and translated labels, help and warnings, shared by the CLI, the plugin and the extension. CLI: `--map-mode`, `--designer-cooling`.
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
- `printnomad printers [--slicer X] [--search text] [--json]` lists the printer presets (system and yours) of the installed slicers.
- Data-driven registry of slicers (`data/slicers.json`) with per-slicer quirks; when the result will also be opened in OrcaSlicer, its stricter manual-mapping limit applies.
- Internationalisation: all user-facing text in JSON catalogs (English and Spanish), `--lang` option, language detection (system or OrcaSlicer's), translation guide in `docs/translating.md` with automatic checks for translators.

### Changed
- OrcaSlicer plugin 0.4.0: the target printer is configurable (`slicer`, `printer` in the Config tab); output names use the printer model (e.g. `_CREATOR5_PRO`, `_BAMBU_LAB_P1S`).
- OrcaSlicer plugin panel rebuilt with Tailwind CSS v4 (only the classes in use are shipped, ~9 KiB), semantic light/dark theme tokens, translated text, separate `ui/` sources with a Node build; tested in jsdom with OrcaSlicer's real JS bridge.
- The report flags `needs_map` when filaments must be assigned to extruders manually (the CLI and the plugin no longer parse error text).
- The OrcaSlicer plugin capability is now named `PrintNomad` (re-enable it once in the Plugins dialog).
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
