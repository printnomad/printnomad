"""Per-printer rules for machine-dependent process settings (data/printer_rules.json).

Printers differ in what a converted project must take from them: a filament changer
purges the old colour, a tool changer primes a cooled head, accelerations follow the
machine's kinematics… The rules are data so anyone can add or verify a printer without
touching the converter: a printer model's rule overrides the rule of its architecture,
which overrides the defaults. Reports say whether the rule used was verified.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "printer_rules.json"
POLICY_PRINTER = "printer"
POLICY_MODEL = "model"


@dataclass(frozen=True)
class PrinterRules:
    architecture: str
    policies: dict[str, str]
    verified: str | None  # how it was verified; None = generic rule
    issue_url: str

    def policy(self, group: str) -> str:
        return self.policies.get(group, POLICY_PRINTER)


@cache
def _data(path: Path = DATA_FILE) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@cache
def _group_patterns(path: Path = DATA_FILE) -> dict[str, re.Pattern]:
    return {name: re.compile(f"^({pattern})$") for name, pattern in _data(path)["setting_groups"].items()}


def group_of(key: str, path: Path = DATA_FILE) -> str | None:
    """Machine-dependent setting group of a process key ("purge_tower", "kinematics"…), or None."""
    return next((name for name, rx in _group_patterns(path).items() if rx.match(key)), None)


def architecture(extruders: int, shared_nozzle: bool) -> str:
    if extruders > 1:
        return "toolchanger"
    return "filament_changer" if shared_nozzle else "single"


def rules_for(printer_model: str, extruders: int, shared_nozzle: bool, path: Path = DATA_FILE) -> PrinterRules:
    data = _data(path)
    printer = data["printers"].get(printer_model, {})
    arch = printer.get("architecture") or architecture(extruders, shared_nozzle)
    policies = {**data["default_policies"], **data["architectures"].get(arch, {}).get("policies", {}),
                **printer.get("policies", {})}
    return PrinterRules(arch, policies, printer.get("verified"), data["issue_url"])
