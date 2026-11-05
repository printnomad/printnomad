import assert from "node:assert/strict";
import { test } from "node:test";

import { clipboardReport } from "../src/lib/report-copy.ts";

const context = { version: "0.1.0", printer: "C5P", slicer: "flashstudio", file: "boat.3mf", browser: "Chrome" };

test("the copied report starts with what we need to reproduce it", () => {
  const text = clipboardReport({ ...context, plate: "Cool Plate" }, "✗ [PN401] no filament");
  assert.match(text, /^PrintNomad 0\.1\.0\nPrinter: C5P\nSlicer: flashstudio\nBuild plate: Cool Plate\nFile: boat\.3mf\nBrowser: Chrome\n\n/);
  assert.ok(text.endsWith("✗ [PN401] no filament\n"));
});

test("without a chosen plate the line is left out", () => {
  assert.ok(!clipboardReport(context, "x").includes("Build plate"));
});
