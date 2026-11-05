#!/bin/bash
# Builds the profile catalog shipped in the store package, from public slicer repositories at
# pinned tags (all AGPL-3.0). Bump a tag only after slicing the supported printers with it.
#
#   tools/build_release_catalog.sh <work dir>     → <work dir>/site/catalog.json
#   PYTHON=python3 by default; needs Pillow (printer thumbnails), git and network access.
set -euo pipefail
work="${1:?usage: build_release_catalog.sh <work dir>}"
python="${PYTHON:-python3}"
mkdir -p "$work/repos" "$work/site"
while read -r key repo tag; do
  dest="$work/repos/$key"
  if [ ! -d "$dest/.git" ] || [ "$(git -C "$dest" describe --tags --exact-match 2>/dev/null)" != "$tag" ]; then
    rm -rf -- "$dest"
    git -c advice.detachedHead=false clone -q --depth 1 --filter=blob:none --sparse --branch "$tag" \
      "https://github.com/$repo.git" "$dest"
    git -C "$dest" sparse-checkout set resources/profiles
  fi
  "$python" tools/build_profile_catalog.py --slicer "$key" --profiles "$dest/resources/profiles" \
    --ref "$tag" --commit "$(git -C "$dest" rev-parse HEAD)" --out "$work/site"
done <<EOF
flashstudio FlashForge/Orca-Flashforge 1.7.15
orcaslicer OrcaSlicer/OrcaSlicer v2.5.0-rc
bambustudio bambulab/BambuStudio v02.09.01.70
EOF
