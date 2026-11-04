import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_OPTIONS, defaultPrinter, migrateSettings } from "../src/lib/settings.ts";

test("options chosen outside advanced mode never applied, so they go with it", () => {
  assert.deepEqual(migrateSettings({ advanced: false, options: { map_mode: "exact" } }), { set: { options: {} }, remove: ["advanced"] });
});

test("options chosen in advanced mode stay", () => {
  assert.deepEqual(migrateSettings({ advanced: true, options: { map_mode: "exact" } }), { set: {}, remove: ["advanced"] });
});

test("settings already up to date are left alone", () => {
  assert.deepEqual(migrateSettings({ options: { map_mode: "exact" } }), { set: {}, remove: [] });
});

test("the default printer is the chosen one, else the first", () => {
  const printers = [{ id: "a", slicer: "s", printer: "A" }, { id: "b", slicer: "s", printer: "B" }];
  assert.equal(defaultPrinter({ printers })?.id, "a");
  assert.equal(defaultPrinter({ printers, defaultPrinterId: "b" })?.id, "b");
  assert.equal(defaultPrinter({ printers, defaultPrinterId: "gone" })?.id, "a");
  assert.equal(defaultPrinter({ printers: [] }), undefined);
});

test("the defaults are the core's", () => {
  const options = readFileSync(join(import.meta.dirname, "../../core/src/printnomad/options.py"), "utf8");
  for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
    const expected = typeof value === "boolean" ? `Option("${key}", ${value ? "True" : "False"}` : `Option("${key}", rules.MAP_COMPATIBLE`;
    assert.ok(options.includes(expected), `${key} in options.py`);
  }
});
