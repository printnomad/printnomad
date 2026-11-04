import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_OPTIONS, migrateSettings } from "../src/lib/settings.ts";

test("options chosen outside advanced mode never applied, so they go with it", () => {
  assert.deepEqual(migrateSettings({ advanced: false, options: { map_mode: "exact" } }), { set: { options: {} }, remove: ["advanced"] });
});

test("options chosen in advanced mode stay", () => {
  assert.deepEqual(migrateSettings({ advanced: true, options: { map_mode: "exact" } }), { set: {}, remove: ["advanced"] });
});

test("the switch for one slicer on every printer goes; each printer keeps the slicer it gave", () => {
  const printers = [{ id: "a", slicer: "orcaslicer", printer: "A", slicerAuto: true }];
  assert.deepEqual(migrateSettings({ generalSlicerForAll: true, printers }), { set: {}, remove: ["generalSlicerForAll"] });
});

test("the default printer goes: on MakerWorld the printer is chosen on the page", () => {
  assert.deepEqual(migrateSettings({ defaultPrinterId: "a" }), { set: {}, remove: ["defaultPrinterId"] });
});

test("settings already up to date are left alone", () => {
  assert.deepEqual(migrateSettings({ options: { map_mode: "exact" } }), { set: {}, remove: [] });
});

test("the defaults are the core's", () => {
  const options = readFileSync(join(import.meta.dirname, "../../core/src/printnomad/options.py"), "utf8");
  for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
    const expected = typeof value === "boolean" ? `Option("${key}", ${value ? "True" : "False"}` : `Option("${key}", rules.MAP_COMPATIBLE`;
    assert.ok(options.includes(expected), `${key} in options.py`);
  }
});
