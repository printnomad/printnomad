## What and why

<!-- What does this change and why is it needed? Link the issue. -->

## Evidence

<!-- Tests added; for slicer behaviour, the source code reference or the slicing result (tools/validate_orca.py). -->

## Checklist

- [ ] `ruff check .` and `pytest` pass
- [ ] Tests use synthetic fixtures only (no models from repositories)
- [ ] No hard-coded printer/slicer knowledge in logic (data + comment with the reason)
- [ ] Every value the converter changes is reported
- [ ] CHANGELOG.md updated under *Unreleased* (if user-visible)
- [ ] Commits signed off (`git commit -s`)
