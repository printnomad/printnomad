# PrintNomad browser extension

Chrome/Chromium extension (Manifest V3) that converts 3MF projects for the printers
you register in **My printers**. It runs the same Python core as the CLI and the
OrcaSlicer plugin (`core/`), inside the browser with [Pyodide](https://pyodide.org).

## Layout

| Path | What |
|---|---|
| `src/engine/` | Web Worker running Pyodide + the core (`worker.ts`) and its promise API (`client.ts`) |
| `src/profiles/` | Profile catalog published by CI, with the bundled fallback (`catalog.ts`) |
| `src/options/` | Options page: My printers, profile status, conversion options (advanced mode), convert a file |
| `src/makerworld/` | MakerWorld integration: content script (chips, button, menu), page-world capture of the 3MF download, bridge page running the engine |
| `src/lib/` | i18n (`chrome.i18n`), settings (`chrome.storage.sync`) and the shared conversion (`conversion.ts`) |
| `static/` | `manifest.json` template and `_locales/<lang>/messages.json` |
| `config.json` | Catalog URL (also the host permission) and the profiles bundled as fallback |

## Develop

```sh
npm ci
npm run build          # → dist/ ; load it from chrome://extensions (Developer mode → Load unpacked)
npm run typecheck
npm test               # unit tests (node --test)
npm run test:e2e       # real browser (Chrome, Chromium or Brave; set CHROME_PATH otherwise): options page and MakerWorld integration (local stand-in page)
```

Extensions cannot read the installed slicer's folders (Chromium blocks them); see
"Helper app" in [docs/architecture.md](../docs/architecture.md).

To bundle fallback profiles, build a catalog first and point the build at it (from a
repository checkout, or with `--from-app` from an installed app when its repository
lags behind):

```sh
python tools/build_profile_catalog.py --slicer flashstudio \
  --profiles <Orca-Flashforge checkout>/resources/profiles --ref 1.7.15 --out /tmp/catalog
PN_PROFILES_DIR=/tmp/catalog npm run build
```

Styles are Tailwind CSS v4 (`src/styles.css`); only classes that appear in `src/` are
emitted, so always write complete class names. Texts live in `static/_locales` — see
[docs/translating.md](../docs/translating.md).
