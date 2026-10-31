"""Suggested filament → extruder assignment when a plate needs more filaments than extruders."""

from betterbridge import web
from betterbridge.remap_filaments import format_map, parse_map, suggest_map
from conftest import FAKE_PRINTER, make_bambu_3mf

# The 12 colours of a real MakerWorld project (bettyb.3mf), all painted on one plate.
BETTY = ["#000000", "#FFFFFF", "#888888", "#FF6A13", "#C9E5BD", "#2A2E32",
         "#136935", "#F9E6B7", "#E2C094", "#2A2E32", "#FAFAFA", "#EFB1D5"]


def groups(mapping):
    out = {}
    for f, e in mapping.items():
        out.setdefault(e, set()).add(f)
    return out


def test_similar_colours_share_an_extruder():
    mapping = suggest_map(["PLA"] * 12, BETTY, {"1": set(range(1, 13))}, 4)
    assert set(mapping.values()) == {1, 2, 3, 4} and len(mapping) == 12
    same = lambda a, b: mapping[a] == mapping[b]  # noqa: E731
    assert same(1, 6) and same(6, 10)        # black and the two near-blacks
    assert same(2, 11)                       # white and near-white
    assert not same(1, 2)                    # black and white stay apart
    assert format_map(mapping) == ",".join(f"{f}:{mapping[f]}" for f in range(1, 13))
    assert parse_map(format_map(mapping)) == mapping


def test_materials_never_mix_and_unused_filaments_follow_a_look_alike():
    types = ["PLA", "PLA", "PETG", "PLA", "PLA", "PLA"]
    colours = ["#FF0000", "#EE1111", "#00FF00", "#0000FF", "#FFFFFF", "#F00000"]
    mapping = suggest_map(types, colours, {"1": {1, 2, 3, 4, 5}}, 4)
    assert mapping[3] not in {mapping[f] for f in (1, 2, 4, 5)}   # PETG alone
    assert mapping[1] == mapping[2]                               # the two reds
    assert mapping[6] == mapping[1]                               # unused red joins the reds
    assert suggest_map(["PLA", "PETG", "ABS", "TPU", "ASA"], ["#000"] * 5, {"1": {1, 2, 3, 4, 5}}, 4) is None


def test_conversion_offers_a_plan_and_accepts_it(profiles_root, tmp_path):
    from test_web import bundles_from

    src = make_bambu_3mf(tmp_path / "b.3mf", [("PLA", "Bambu PLA Basic @BBL A1", c) for c in BETTY[:6]], [["2"]],
                         paint=(1, 2, 3, 4, 5, 6))
    res = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root), lang="en")
    assert not res["ok"] and res["needs_map"]
    plan = res["plan"]
    assert plan["extruders"] == 4 and len(plan["filaments"]) == 6 and plan["filaments"][5]["plates"] == ["1"]
    assert plan["plates"] == {"1": [1, 2, 3, 4, 5, 6]}
    again = web.convert_file(str(src), str(tmp_path), FAKE_PRINTER, bundles_from(profiles_root),
                             map_text=plan["suggestion"], lang="en")
    assert again["ok"], again["text"]
