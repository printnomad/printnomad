import pytest

from printnomad.remap_filaments import MapError, assign, parse_map


def test_parse_map():
    assert parse_map("1:1, 2:2,5:1") == {1: 1, 2: 2, 5: 1}
    for bad in ("1-1", "a:1", "1:1,1:2"):
        with pytest.raises(MapError):
            parse_map(bad)


def test_up_to_four_is_identity():
    r = assign(["PLA"] * 3, {"1": {1}, "2": {2, 3}}, 4)
    assert not r.errors
    assert r.per_plate == {"1": [1, 2, 3], "2": [1, 2, 3]}


def test_more_than_four_packs_per_plate():
    # Cada placa usa pocos filamentos: no hace falta --map.
    r = assign(["PLA"] * 5, {"1": {4}, "2": {5, 1}}, 4)
    assert not r.errors
    assert r.per_plate["1"][3] == 1
    assert r.per_plate["2"][0] != r.per_plate["2"][4]


def test_more_than_four_on_one_plate_needs_map():
    r = assign(["PLA"] * 5, {"1": {1, 2, 3, 4, 5}}, 4)
    assert r.errors and r.needs_map


def test_unknown_usage_assumes_all():
    r = assign(["PLA"] * 5, {"1": None}, 4)
    assert r.errors and "pintura" in r.errors[0]


def test_user_map_validation():
    types = ["PLA", "PLA", "PETG", "PLA", "PLA"]
    assert "no asigna" in assign(types, {"1": None}, 4, {1: 1, 2: 2}).errors[0]
    r = assign(types, {"1": None}, 4, {1: 1, 2: 2, 3: 3, 4: 4, 5: 9})
    assert any("fuera de 1..4" in e for e in r.errors)
    r = assign(types, {"1": None}, 4, {1: 1, 2: 2, 3: 1, 4: 3, 5: 4})
    assert any("tipos distintos" in e for e in r.errors)


def test_user_map_shared_extruder_warns():
    r = assign(["PLA"] * 5, {"1": {1, 5}, "2": {2}}, 4, {1: 1, 2: 2, 3: 3, 4: 4, 5: 1})
    assert not r.errors
    assert r.per_plate["1"] == [1, 2, 3, 4, 1]
    assert len(r.warnings) == 1 and "placa 1" in r.warnings[0]



def test_shared_nozzle_accepts_any_number_of_filaments():
    """AMS / IFS / ACE: una boquilla, cambio automático; ni errores ni avisos."""
    r = assign(["PLA"] * 6, {"1": None, "2": {1, 6}}, 1, shared_nozzle=True)
    assert not r.errors and not r.warnings and not r.needs_map
    assert r.per_plate == {"1": [1] * 6, "2": [1] * 6}
