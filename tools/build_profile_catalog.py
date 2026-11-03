"""Build the static profile catalog the browser extension downloads.

Usage:
    python tools/build_profile_catalog.py --slicer flashstudio --profiles DIR \
        --ref 1.7.15 [--commit SHA] --out OUT

`DIR` is the `resources/profiles` folder of the slicer's official repository at
`--ref` (a sparse checkout is enough), or with `--from-app` the profiles folder of an
installed release of the slicer (e.g. `/Applications/Flash Studio.app/Contents/
Resources/profiles`, `--ref` = its version) when the repository lags behind the app.
The command writes into `OUT`:

- `<slicer>/<ref>/<Vendor>.json`: one bundle per vendor with every machine,
  process and filament JSON, minified, keyed by its path inside the vendor folder.
- `<slicer>/<ref>/covers/<model>.webp`: the slicer's picture of each printer model
  (`<model>_cover.png`), shrunk to a thumbnail when Pillow is installed (`pip install
  pillow`; otherwise copied as is).
- `catalog.json`: merged across runs; per slicer the repository, ref, vendors (with
  a display name and the covers), bundle paths, sha256 and the usable printers (name,
  model, nozzle, extruders).

Only data from the slicer repositories is redistributed (AGPL-3.0, like this
project); the source and version travel with every bundle so reports can name them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core" / "src"))

from printnomad.profiles import INDEXED_KINDS, KINDS, LIBRARY_VENDOR, ProfileLibrary  # noqa: E402
from printnomad.slicers import registry  # noqa: E402
from printnomad.web import usable_printers  # noqa: E402

SCHEMA = 1
COVER_SIZE = 192  # px; shown at 64–96 px, sharp on high-DPI screens
# Vendor names as written in some profile folders, fixed for display.
DISPLAY_NAMES = {"Bambulab": "Bambu Lab"}


def vendor_display_name(root: Path, vendor: str) -> str:
    try:
        name = json.loads((root / f"{vendor}.json").read_text(encoding="utf-8")).get("name") or vendor
    except (OSError, ValueError):
        name = vendor
    return DISPLAY_NAMES.get(name, name)


def write_cover(src: Path, dest_base: Path) -> Path:
    """Thumbnail of a printer cover: WebP with Pillow, else the PNG unchanged."""
    try:
        from PIL import Image
    except ImportError:
        dest = dest_base.with_suffix(".png")
        shutil.copyfile(src, dest)
        return dest
    dest = dest_base.with_suffix(".webp")
    with Image.open(src) as image:
        image.thumbnail((COVER_SIZE, COVER_SIZE))
        image.save(dest, "WEBP", quality=82, method=6)
    return dest


def covers_for(vendor_dir: Path, models: set[str], out: Path, rel_dir: str) -> dict[str, str]:
    """{printer model: cover path relative to the catalog} for the models that have one."""
    covers = {}
    for model in sorted(models):
        src = vendor_dir / f"{model}_cover.png"
        if not src.is_file():
            continue
        slug = re.sub(r"[^A-Za-z0-9]+", "-", model).strip("-").lower()
        (out / rel_dir).mkdir(parents=True, exist_ok=True)
        covers[model] = write_cover(src, out / rel_dir / slug).relative_to(out).as_posix()
    return covers


def vendor_dirs(root: Path) -> list[Path]:
    return sorted(d for d in root.iterdir() if d.is_dir() and any((d / k).is_dir() for k in KINDS))


def vendor_version(root: Path, vendor: str) -> str | None:
    meta = root / f"{vendor}.json"
    try:
        return json.loads(meta.read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError):
        return None


def bundle_files(vendor_dir: Path) -> dict[str, dict]:
    """{"machine/x.json": data} for every profile JSON the core would index."""
    files: dict[str, dict] = {}
    for kind in KINDS:
        for f in sorted((vendor_dir / kind).rglob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, ValueError):
                continue
            if isinstance(data, dict) and data.get("type", kind) in INDEXED_KINDS:
                files[f.relative_to(vendor_dir).as_posix()] = data
    return files


def printers_by_vendor(lib: ProfileLibrary) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for printer in usable_printers(lib):
        out.setdefault(printer.pop("vendor"), []).append(printer)
    return out


def build(slicer: str, profiles: Path, ref: str, commit: str | None, out: Path, from_app: bool = False) -> dict:
    known = registry()
    if slicer not in known:
        raise SystemExit(f"unknown slicer {slicer!r}; known: {', '.join(known)}")
    repo = None if from_app else known[slicer].profile_repo.get("github")
    # What reports show as the profile source.
    source = f"{repo}@{ref}" if repo else f"{known[slicer].name} {ref}"
    lib = ProfileLibrary.from_roots([profiles])
    printers = printers_by_vendor(lib)
    has_library = (profiles / LIBRARY_VENDOR).is_dir()

    vendors: dict[str, dict] = {}
    for vendor_dir in vendor_dirs(profiles):
        vendor = vendor_dir.name
        if vendor != LIBRARY_VENDOR and not printers.get(vendor):
            continue  # nothing a user can pick: skip the download
        payload = {"schema": SCHEMA, "slicer": slicer, "repo": repo, "ref": ref, "source": source, "vendor": vendor,
                   "version": vendor_version(profiles, vendor), "files": bundle_files(vendor_dir)}
        blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        rel = f"{slicer}/{ref}/{vendor}.json"
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        (out / rel).write_bytes(blob)
        vendors[vendor] = {
            "name": vendor_display_name(profiles, vendor),
            "covers": covers_for(vendor_dir, {p["model"] for p in printers.get(vendor, [])}, out,
                                 f"{slicer}/{ref}/covers"),
            "version": payload["version"],
            "bundle": rel,
            "sha256": hashlib.sha256(blob).hexdigest(),
            "bytes": len(blob),
            "depends": [LIBRARY_VENDOR] if has_library and vendor != LIBRARY_VENDOR else [],
            "printers": printers.get(vendor, []),
        }

    catalog_path = out / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8")) if catalog_path.exists() else {}
    catalog.update(schema=SCHEMA, generated=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"))
    catalog.setdefault("slicers", {})[slicer] = {
        "name": known[slicer].name, "repo": repo, "ref": ref, "commit": commit, "source": source, "vendors": vendors,
        # Brands this slicer is made for: preferred for their printers when several slicers have them.
        "makers": known[slicer].makers,
        "general": known[slicer].general,
    }
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    return catalog["slicers"][slicer]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--slicer", required=True, help="key from core/src/printnomad/data/slicers.json")
    ap.add_argument("--profiles", required=True, type=Path, help="resources/profiles of the slicer repository")
    ap.add_argument("--ref", required=True, help="release tag the profiles come from")
    ap.add_argument("--commit", help="commit sha of --ref")
    ap.add_argument("--from-app", action="store_true", help="--profiles is an installed app folder, --ref its version")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    entry = build(args.slicer, args.profiles, args.ref, args.commit, args.out, args.from_app)
    total = sum(v["bytes"] for v in entry["vendors"].values())
    printers = sum(len(v["printers"]) for v in entry["vendors"].values())
    print(f"{args.slicer}@{args.ref}: {len(entry['vendors'])} vendors, {printers} printers, {total / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
