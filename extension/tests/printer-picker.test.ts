import assert from "node:assert/strict";
import { test } from "node:test";

import type { Catalog } from "../src/profiles/catalog.ts";
import { brands, buildModels, matches, modelOfPreset, nozzlesFor, presetFor, slicersFor } from "../src/options/printer-picker.ts";

const printer = (name: string, model: string, nozzle: string) => ({ name, model, nozzle, extruders: 1 });
const vendor = (name: string, printers: ReturnType<typeof printer>[], covers = {}) =>
  ({ name, covers, version: "1", bundle: "x.json", sha256: "", bytes: 0, depends: [], printers });

const catalog: Catalog = {
  schema: 1,
  generated: "",
  slicers: {
    orcaslicer: {
      name: "OrcaSlicer", repo: null, ref: "2", commit: null, makers: [],
      vendors: {
        Flashforge: vendor("Flashforge", [printer("Flashforge Creator 5 Pro 0.4 nozzle", "Flashforge Creator 5 Pro", "0.4")]),
        BBL: vendor("Bambu Lab", [printer("Bambu Lab P1S 0.4 nozzle", "Bambu Lab P1S", "0.4")], { "Bambu Lab P1S": "orca/covers/p1s.webp" }),
        OrcaFilamentLibrary: vendor("OrcaFilamentLibrary", []),
      },
    },
    flashstudio: {
      name: "Flash Studio", repo: null, ref: "1.7.20", commit: null, makers: ["Flashforge"],
      vendors: {
        Flashforge: vendor("Flashforge", [
          printer("Flashforge Creator 5 Pro 0.6 nozzle", "Flashforge Creator 5 Pro", "0.6"),
          printer("Flashforge Creator 5 Pro 0.4 nozzle", "Flashforge Creator 5 Pro", "0.4"),
        ], { "Flashforge Creator 5 Pro": "fs/covers/c5p.webp" }),
      },
    },
  },
};
const models = buildModels(catalog, "https://example.test/profiles/catalog.json");

test("groups presets by model across slicers, without the brand in the label", () => {
  assert.deepEqual(models.map((m) => [m.brand, m.label]), [["Bambu Lab", "P1S"], ["Flashforge", "Creator 5 Pro"]]);
  const c5p = models[1];
  assert.equal(c5p.variants.length, 3);
  assert.equal(c5p.cover, "https://example.test/profiles/fs/covers/c5p.webp");
  assert.deepEqual(brands(models), [{ brand: "Bambu Lab", count: 1 }, { brand: "Flashforge", count: 1 }]);
});

test("search and brand filter", () => {
  const c5p = models[1];
  assert.ok(matches(c5p, "creator 5", null));
  assert.ok(matches(c5p, "flashforge pro", "Flashforge"));
  assert.ok(!matches(c5p, "p1s", null));
  assert.ok(!matches(c5p, "", "Bambu Lab"));
});

test("the brand's own slicer first, 0.4 nozzle by default", () => {
  const c5p = models[1];
  assert.deepEqual(slicersFor(c5p, catalog).map((s) => s.slicer), ["flashstudio", "orcaslicer"]);
  assert.deepEqual(nozzlesFor(c5p, "flashstudio"), { nozzles: ["0.4", "0.6"], preferred: "0.4" });
  assert.equal(presetFor(c5p, "flashstudio", "0.6"), "Flashforge Creator 5 Pro 0.6 nozzle");
  assert.equal(modelOfPreset(models, "orcaslicer", "Bambu Lab P1S 0.4 nozzle")?.label, "P1S");
});
