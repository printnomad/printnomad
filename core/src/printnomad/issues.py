"""Error codes: what failed, at which stage of the conversion, and what the user can do.

A code never changes meaning once released, so reports and bug tickets stay comparable.
Texts live in the catalogs: `issue.<code>.suggestion` and `stage.<stage>`.
"""

from __future__ import annotations

UNKNOWN_SOURCE = "PN101"
UNREADABLE_PROJECT = "PN102"
ALREADY_TARGET = "PN103"
UNKNOWN_PRINTER = "PN201"
NOZZLE_UNAVAILABLE = "PN202"
NO_PROCESS = "PN203"
BAD_OPTION = "PN301"
BAD_MAP = "PN302"
NO_FILAMENT = "PN401"
WRITE_FAILED = "PN501"
VERIFY_FAILED = "PN502"
INTERNAL = "PN901"

STAGE_READ, STAGE_PROFILES, STAGE_INPUT, STAGE_FILAMENTS, STAGE_WRITE, STAGE_INTERNAL = (
    "read", "profiles", "input", "filaments", "write", "internal")

STAGES = {
    UNKNOWN_SOURCE: STAGE_READ,
    UNREADABLE_PROJECT: STAGE_READ,
    ALREADY_TARGET: STAGE_READ,
    UNKNOWN_PRINTER: STAGE_PROFILES,
    NOZZLE_UNAVAILABLE: STAGE_PROFILES,
    NO_PROCESS: STAGE_PROFILES,
    BAD_OPTION: STAGE_INPUT,
    BAD_MAP: STAGE_INPUT,
    NO_FILAMENT: STAGE_FILAMENTS,
    WRITE_FAILED: STAGE_WRITE,
    VERIFY_FAILED: STAGE_WRITE,
    INTERNAL: STAGE_INTERNAL,
}
