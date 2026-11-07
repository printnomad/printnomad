import assert from "node:assert/strict";
import { test } from "node:test";
import { planChips } from "../src/makerworld/chips.ts";

const printer = (label: string, brand: string) => ({ id: label, label, brand, slicer: "orcaslicer" });

test("my printers that MakerWorld lists go first, in my order", () => {
  const { mine, inject } = planChips(["X1 Carbon", "P1S", "A1"], [printer("A1", "Bambu Lab"), printer("P1S", "Bambu Lab")]);
  assert.deepEqual(mine, [2, 1]);
  assert.deepEqual(inject, []);
});

test("other brands get a chip of ours", () => {
  const c5p = printer("Creator 5 Pro", "Flashforge");
  assert.deepEqual(planChips(["P1S"], [c5p]), { mine: [], inject: [c5p] });
});

test("a Bambu Lab printer the model does not list gets no chip: it is not converted", () => {
  assert.deepEqual(planChips(["P1S"], [printer("A1", "Bambu Lab")]), { mine: [], inject: [] });
});

test("labels match whatever their case and spacing", () => {
  assert.deepEqual(planChips([" core  one "], [printer("CORE One", "Prusa")]), { mine: [0], inject: [] });
});
