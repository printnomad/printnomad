# Contributing to BetterBridge

Thanks for helping! This guide covers the workflow and the rules that keep the project easy to work on.

## Setup

```sh
python -m venv .venv
.venv/bin/pip install -e core pytest ruff
(cd orca-plugin/tests/js && npm ci)    # optional, enables the plugin panel DOM tests
.venv/bin/ruff check . && .venv/bin/pytest
```

Everything must pass before you open a pull request. CI runs the same commands.

## Repository layout

- `core/` — conversion engine (`betterbridge` package). **Standard library only**: it also runs inside OrcaSlicer's embedded Python and, later, in the browser (Pyodide).
- `orca-plugin/` — OrcaSlicer plugin; `tools/build.py` packages it as a wheel with a copy of `core/`.
- `tools/` — developer tools shared by components.
- `conftest.py` — shared test fixtures (synthetic 3MF projects and a fake profile tree).
- `docs/` — architecture and decisions.

## Workflow

- `main` is always releasable. Work in short-lived branches named `<type>/<short-description>`: `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`.
- Open a pull request to `main`. Keep it focused on one change; include tests.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with the component as scope: `feat(core): …`, `fix(orca-plugin): …`, `docs: …`.
- Sign off every commit (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/). We use the DCO instead of a CLA.
- Update [CHANGELOG.md](CHANGELOG.md) under *Unreleased* for user-visible changes.

## Code rules

- **No hard-coded printer or slicer knowledge in logic.** Printer/slicer specifics live in data (profile files, target definitions, quirk tables) with a comment explaining *why* (link the slicer source when the behaviour comes from it).
- **Never change the user's data silently.** Every value the converter changes, keeps or drops goes to the report with a reason.
- **Verify, don't guess.** Slicer behaviour must be checked against its source code or by slicing with its CLI (`tools/validate_orca.py`). Note the evidence in the PR.
- **Tests with synthetic data only.** Build fixtures with the helpers in `conftest.py`. Never commit models from MakerWorld or other repositories: they belong to their designers.
- Small, readable modules; type hints; docstrings for anything non-obvious.
- Front-end code uses Tailwind CSS compiled at build time so only the classes in use are shipped. Write complete class names (no string concatenation such as `"text-" + color`) so the build can detect them.

## Adding support for a printer or slicer

Open an issue first with the printer, nozzle sizes, slicer and version, and where its profiles live (installation folder and official repository). Include a small test project you created yourself.

## Reporting security issues

Do not open a public issue; see [SECURITY.md](SECURITY.md).
