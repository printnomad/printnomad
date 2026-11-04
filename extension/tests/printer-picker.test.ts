import assert from "node:assert/strict";
import { test } from "node:test";

import type { Catalog } from "../src/profiles/catalog.ts";
import {
  buildModels,
  keepBed,
  matches,
  modelOfPreset,
  nozzlesFor,
  pickSlicer,
  presetFor,
  slicersFor,
  supportedOnly,
} from "../src/options/printer-picker.ts";

const printer = (name: string, model: string, nozzle: string) => ({ name, model, nozzle, extruders: 1 });
const vendor = (name: string, printers: ReturnType<typeof printer>[], covers = {}) =>
  ({ name, covers, version: "1", bundle: "x.json", sha256: "", bytes: 0, depends: [], printers });

const catalog: Catalog = {
  schema: 1,
  generated: "",
  slicers: {
    orcaslicer: {
      name: "OrcaSlicer", repo: null, ref: "2", commit: null, makers: [], general: true,
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
});

test("search by brand or model", () => {
  const c5p = models[1];
  assert.ok(matches(c5p, "creator 5"));
  assert.ok(matches(c5p, "flashforge pro"));
  assert.ok(matches(c5p, ""));
  assert.ok(!matches(c5p, "p1s"));
});

test("only tested models are offered", () => {
  assert.deepEqual(supportedOnly(models, ["Bambu Lab P1S", "Not in the catalog"]).map((m) => m.label), ["P1S"]);
});

test("the brand's own slicer first, 0.4 nozzle by default", () => {
  const c5p = models[1];
  assert.deepEqual(slicersFor(c5p, catalog).map((s) => s.slicer), ["flashstudio", "orcaslicer"]);
  assert.deepEqual(nozzlesFor(c5p, "flashstudio"), { nozzles: ["0.4", "0.6"], preferred: "0.4" });
  assert.equal(presetFor(c5p, "flashstudio", "0.6"), "Flashforge Creator 5 Pro 0.6 nozzle");
  assert.equal(modelOfPreset(models, "orcaslicer", "Bambu Lab P1S 0.4 nozzle")?.label, "P1S");
});


test("the brand's slicer by default, the general one for all on request", () => {
  const [p1s, c5p] = models;
  assert.equal(pickSlicer(c5p, catalog, false), "flashstudio");
  assert.equal(pickSlicer(c5p, catalog, true), "orcaslicer");
  assert.equal(pickSlicer(p1s, catalog, false), "orcaslicer");     // no Bambu Studio here: the general one
  assert.deepEqual(slicersFor(c5p, catalog, "0.6").map((s) => s.slicer), ["flashstudio"]);
});

test("plates of each preset come from the catalog, and a chosen plate is kept only if on offer", () => {
  const bedCatalog: Catalog = {
    schema: 1,
    generated: "",
    slicers: {
      flashstudio: {
        name: "Flash Studio", repo: null, ref: "1", commit: null,
        vendors: { Flashforge: vendor("Flashforge", [
          { ...printer("C5P", "Flashforge Creator 5 Pro", "0.4"), bed_types: ["Cool Plate", "Textured Cool Plate"], bed_type: "Textured PEI Plate" } as never,
        ]) },
      },
      bambustudio: {
        name: "Bambu Studio", repo: null, ref: "1", commit: null,
        vendors: { Flashforge: vendor("Flashforge", [
          { ...printer("C5P", "Flashforge Creator 5 Pro", "0.4"), bed_types: ["Cool Plate"] } as never,
          printer("Old", "Flashforge Creator 5 Pro", "0.6"),  // older catalog: no plate data
        ]) },
      },
    },
  };
  const [model] = buildModels(bedCatalog, "https://example.test/catalog.json");
  const flash = model.variants.find((v) => v.slicer === "flashstudio")!;
  assert.deepEqual(flash.bedTypes, ["Cool Plate", "Textured Cool Plate"]);
  assert.equal(flash.defaultBed, "Textured PEI Plate");
  assert.deepEqual(model.variants.find((v) => v.preset === "Old")!.bedTypes, []);
  assert.equal(keepBed(model, "bambustudio", "C5P", "Cool Plate"), "Cool Plate");
  assert.equal(keepBed(model, "bambustudio", "C5P", "Textured Cool Plate"), undefined);
  assert.equal(keepBed(model, "bambustudio", "Old", "Cool Plate"), undefined);
  assert.equal(keepBed(model, "bambustudio", "C5P", undefined), undefined);
});
