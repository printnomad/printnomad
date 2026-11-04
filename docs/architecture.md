# Architecture

## Goal

From any model repository, open a project in the slicer of **your** printer with the designer's settings preserved. PrintNomad targets OrcaSlicer and the slicers derived from it (Flash Studio, Snapmaker Orca, Elegoo Slicer, Creality Print, Bambu Studio…).

## Components

```
Browser (MakerWorld, Printables…)
 └─ extension/  "Open with [slicer · printer]" button
     ├─ default: converts in the browser (core via Pyodide) and downloads the result
     └─ experimental: asks helper/ (Native Messaging) to convert and open the slicer

OrcaSlicer (and forks with plugin support)
 └─ orca-plugin/  converts the project that is open

core/  one conversion engine (Python, standard library only) used by all of the above and the CLI
tools/build_profile_catalog.py  turns slicer releases into the profile catalog the extension downloads
```

### Extension internals

- **Engine**: Pyodide in a module Web Worker started by extension pages (`extension/src/engine/`). MV3 service workers cannot `import()` Pyodide. The core is shipped as `core.json` and written into Pyodide's file system; `printnomad.web.convert_file()` takes profile bundles and returns plain JSON. Boot ~1 s; a 3 MB project converts in ~0.5 s.
- **Profiles** (automatic, nothing to configure):
  1. *Catalog* built weekly by CI from the latest release of each slicer repository (`.github/workflows/profiles.yml` → GitHub Pages): one minified bundle per vendor, sha256-verified and cached by release. When a repository lags behind its app (Flashforge: repository 1.7.15, Flash Studio 1.7.20), the catalog can be built from the released app instead (`tools/build_profile_catalog.py --from-app`).
  2. *Shipped copy*: every bundle of the configured slicers (`extension/config.json` → `fallbackProfiles`, `"*"` = all vendors), gzipped (~1.4 MB for Flash Studio, Bambu Studio and OrcaSlicer). Used offline, before the catalog is published, and whenever the online bundle has the same sha256.
  Reports name the source (`repo@release` or `App version`).
- **Not possible from the extension: the installed slicer's own profiles.** Chromium's File System Access API blocks `~/Library` (including `Application Support`) and `/Applications` on macOS, and `%APPDATA%`/`%LOCALAPPDATA%`/`%PROGRAMDATA%` on Windows (`chrome_file_system_access_permission_context.cc`). See *Helper app* below.

### MakerWorld integration

- **Button**: near MakerWorld's own button, a split button in a shadow root (`src/makerworld/content.ts`): *Download for <default printer>* and a menu with the other printers. MakerWorld's own button and menu keep working.
- **Download**: MakerWorld's own *Download 3MF* is triggered, so the user's session is used and no credentials are handled. A script in the page's world (`main-world.ts`, `"world": "MAIN"`) reads the `/f3mf` JSON answer (file name and signed CDN URL, fetch or XHR) and keeps the page from saving the original; the content script downloads the CDN file. The idea comes from makerworld-to-snapmaker-u1 (MIT part); the code is ours.
- **Conversion**: a hidden extension iframe (`bridge.html`, web-accessible only on the MakerWorld origins of `config.json`) runs the engine and `chrome.downloads`; the 3MF is transferred to it with `postMessage`, origins checked on both sides. Chromium does not apply the page's `frame-src` to iframes added by extensions.
- MakerWorld's class names are generated: elements are found by structure (`span.primaryButton`, `.swiper-wrapper`, MUI menus) and by "3MF" in menu texts. Tested on a local stand-in page (`tests/fixtures/makerworld.html`) because MakerWorld blocks automated browsers.

### Helper app (planned, experimental)

A small native program the extension talks to through Native Messaging. Besides opening the converted project directly in the slicer, it is the only way for the browser flow to use:

- the **exact profiles of the installed slicer** (system profiles of the installed version), and
- the user's **own presets** (calibrated filaments, modified printers) in *My printers*.

It reads the slicer folders listed in `core/src/printnomad/data/slicers.json` and returns them as profile bundles in the catalog format (user presets under the vendor `user`), or converts by itself with the same core. Proposed messages (JSON, `"v": 1`): `hello`, `list_profiles {slicer}` → `{bundles, source}`, `convert {input_path, printer, options}`, `open {output_path, slicer, same_window}`.

Without the helper, a planned advanced-mode alternative is **Import presets** from the bundle the slicer exports (*File → Export → Export preset bundle*), which lands in Downloads where the browser may read it.

## Key decisions

| Decision | Reason |
|---|---|
| AGPL-3.0-or-later | Same license as OrcaSlicer/PrusaSlicer; compatible with running inside OrcaSlicer and with its profiles. |
| Monorepo | Changes to the conversion format touch several components; one PR, shared fixtures. |
| Single core in Python, stdlib only | One implementation for CLI, OrcaSlicer plugin (embedded Python 3.12), helper and browser (Pyodide). |
| Convert for a specific target printer | Bed size, start/end G-code, extruder count, limits and cooling are printer-specific; switching printers inside the slicer loses the designer's settings. |
| Python core in the browser via Pyodide, not a TypeScript port | One implementation to test; conversions are byte-identical to the CLI. ~13 MB download once, ~1 s start. |
| Profiles from the installed slicer first | Bundled or repository copies get stale: Flashforge's public repository lags behind Flash Studio, which is why other converters produce "old vs new" values. |
| Cooling always from the target | Printers have different fans (Creator 5 Pro: P101/P2/P3; Bambu: P1/P2/P3). |
| Designer speeds kept even above filament flow | The slicer caps them at slice time from the selected filament's max volumetric speed (verified in G-code), so a faster filament still benefits. |
| The extension cannot open a slicer by itself | Slicer URL schemes (`orcaslicer://open?file=…`) download `file=` and load it only on HTTP 2xx (OrcaSlicer `Http.cpp`); browsers cannot serve local HTTP or launch apps. Opening directly requires the optional helper. |

## Conversion pipeline (core)

1. **Read** the 3MF in memory, keeping raw entries so unchanged files are rewritten byte-for-byte.
2. **Resolve target profiles** (machine, process by closest layer height, filament by type and name) with `inherits` chains.
3. **Assemble settings**: target machine → target process with the designer's changes on top → target filaments; per-variant values collapsed; cooling and Bambu-only keys handled.
4. **Map filaments** to extruders per plate.
5. **Edit `model_settings.config`** (plates, per-object overrides kept and reported) and recenter items if the bed differs.
6. **Write** a new 3MF and verify geometry; produce the report.
