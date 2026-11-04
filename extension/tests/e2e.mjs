// End-to-end: loads dist/ in a real Chromium browser and converts a project from the
// options page, with the profiles bundled as fallback (the published catalog is not
// reachable in tests).
//
//   npm run test:e2e                      synthetic project + fake profiles (self-contained)
//   PN_E2E_FILE=x.3mf PN_E2E_PRINTER="…" [PN_E2E_SLICER=key] [PN_E2E_EXPECT=text] PN_E2E_SKIP_BUILD=1 npm run test:e2e
//                                         a real project with the dist/ you built
//
// The browser comes from CHROME_PATH or a usual install location; without one the test
// is skipped (exit 0) so CI machines without Chrome still pass.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowDownloads, buildExtension, buildFixtures, findBrowser, launch, projectSetting, workDir } from "./support.mjs";

const browserPath = findBrowser();
if (!browserPath) {
  console.log("SKIP: no Chromium-based browser found (set CHROME_PATH)");
  process.exit(0);
}

const work = workDir();
let file = process.env.PN_E2E_FILE;
const printer = process.env.PN_E2E_PRINTER ?? "Flashforge Creator 5 Pro 0.4 nozzle";
let catalog;
let painted;
if (!file) ({ project: file, painted, catalog } = buildFixtures(work));
if (!process.env.PN_E2E_SKIP_BUILD) buildExtension({ PN_PROFILES_DIR: catalog ?? process.env.PN_PROFILES_DIR ?? "" });

const downloads = join(work, "downloads");
const { browser, id } = await launch(browserPath, work);
const errors = [];
try {
  await allowDownloads(browser, downloads);

  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/options.html`);
  // PN_E2E_PRINTERS="slicer|preset;slicer|preset" converts for several printers at once.
  const printers = (process.env.PN_E2E_PRINTERS ?? `${process.env.PN_E2E_SLICER ?? "flashstudio"}|${printer}`)
    .split(";").map((entry, i) => {
      const [slicer, preset] = entry.split("|");
      return { id: `p${i}`, slicer, printer: preset };
    });
  if (!process.env.PN_E2E_FILE) {
    // First run: the three steps, only while there is no printer.
    await page.waitForSelector("#step-1:not([hidden])");
    if (!(await page.$eval("#home-view", (e) => e.hidden))) throw new Error("the home page shows without a printer");
    await page.click('[data-model="Flashforge Creator 5 Pro"]');
    await page.click("#step-1-next");
    await page.waitForSelector("#step-2:not([hidden])");
    await page.click("#setup-finish");
    await page.waitForSelector("#step-3:not([hidden])");
    const saved = await page.evaluate(async () => (await chrome.storage.sync.get("printers")).printers);
    if (saved.length !== 1 || saved[0].printer !== "Flashforge Creator 5 Pro 0.4 nozzle") throw new Error(`first printer: ${JSON.stringify(saved)}`);
    await page.click("#done-preferences");
    await page.waitForSelector("#home-view:not([hidden])");
    console.log("OK: first run sets up a printer in three steps");
  }
  await page.evaluate((printers) => chrome.storage.sync.set({ printers }), printers);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#convert-printer option").length > 0);

  if (!process.env.PN_E2E_FILE) {
    // The build plate chosen in Edit reaches the conversion (checked below).
    await page.click('[data-action="edit"]');
    await page.waitForSelector('#setup-beds [data-value="Supertack Plate"]', { visible: true });
    await page.click('#setup-beds [data-value="Supertack Plate"]');
    await page.click("#setup-finish");
    await page.waitForFunction(async () =>
      (await chrome.storage.sync.get("printers")).printers[0].bedType === "Supertack Plate");
    await page.waitForSelector("#home-view:not([hidden])");
  }

  const started = Date.now();
  const input = await page.$("#convert-file");
  await input.uploadFile(file);
  await page.click("#convert-button");
  await page.waitForFunction(() => !document.querySelector("#convert-button").disabled, { timeout: 300_000 });
  const rows = await page.$$eval("#convert-results > li", (items) => items.map((li) => ({
    printer: li.querySelector('[data-field="printer"]').textContent,
    status: li.querySelector('[data-field="status"]').textContent,
    report: li.querySelector('[data-field="report"]')?.textContent ?? "",
    // No report: the project was already set up for that printer (nothing converted).
    already: li.querySelector('[data-field="details"]').hidden,
  })));
  if (rows.length !== printers.length) {
    const status = await page.$eval("#convert-status", (e) => e.textContent);
    throw new Error(`expected ${printers.length} results, got ${rows.length} (${status})`);
  }
  console.log(`${rows.length} printer(s) in ${Date.now() - started} ms including engine start`);

  // CDP downloads are saved under a GUID name: find the files through chrome.downloads.
  const items = await page.evaluate(async (count) => {
    for (let i = 0; i < 100; i++) {
      const all = await chrome.downloads.search({});
      if (all.length >= count && all.every((d) => d.state !== "in_progress")) return all;
      await new Promise((r) => setTimeout(r, 100));
    }
    return chrome.downloads.search({});
  }, rows.filter((r) => !r.already).length);
  const expected = file.split("/").pop().replace(/\.3mf$/, "_");
  for (const row of rows) {
    console.log(`  ${row.printer}: ${row.status}`);
    if (row.already) continue;
    // The status shows the saved file's name (a GUID under CDP); the report, the converted name.
    if (!row.report.includes(expected)) throw new Error(`unexpected report for ${row.printer}:\n${row.report}`);
    if (process.env.PN_E2E_EXPECT && !row.report.includes(process.env.PN_E2E_EXPECT)) {
      // e.g. PN_E2E_EXPECT=" → " to check the report shows the designer's original values.
      throw new Error(`report lacks ${JSON.stringify(process.env.PN_E2E_EXPECT)}:\n${row.report}`);
    }
  }
  if (!process.env.PN_E2E_FILE && !rows[0].report.includes("Flashforge")) throw new Error(`unexpected report:\n${rows[0].report}`);
  const complete = items.filter((d) => d.state === "complete");
  const converted = rows.filter((r) => !r.already).length;
  if (complete.length !== converted) throw new Error(`${complete.length} of ${converted} files downloaded`);
  for (const d of complete) {
    if (readFileSync(d.filename).readUInt32LE(0) !== 0x04034b50) throw new Error(`${d.filename} is not a ZIP file`);
  }
  console.log(`OK: downloaded ${complete.length} file(s)`);
  if (!process.env.PN_E2E_FILE) {
    const bed = projectSetting(complete[0].filename, "curr_bed_type");
    if (bed !== "Supertack Plate") throw new Error(`build plate in the converted project: ${bed}`);
    console.log("OK: chosen build plate in the converted project");
  }

  if (painted) {
    // More colours on a plate than extruders: the assignment screen, then the conversion.
    await (await page.$("#convert-file")).uploadFile(painted);
    await page.click("#convert-button");
    await page.waitForSelector('#convert-results [data-field="map"] .btn-primary', { timeout: 120_000 });
    const groups = await page.$$eval('#convert-results [data-field="map"] [role="radio"][aria-checked="true"]', (c) => c.length);
    if (groups !== 5) throw new Error(`assignment rows: ${groups}`);
    await page.click('#convert-results [data-field="map"] .btn-primary');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#convert-results [data-field="status"]').textContent),
      { timeout: 120_000 });
    console.log("OK: assignment screen and conversion with the chosen extruders");

    // A damaged file: code, suggestion and "Copy report".
    const damaged = join(work, "damaged.3mf");
    writeFileSync(damaged, "not a zip");
    await (await page.$("#convert-file")).uploadFile(damaged);
    await page.click("#convert-button");
    await page.waitForFunction(() => /PN102/.test(document.querySelector('#convert-results [data-field="issue-message"]')?.textContent ?? ""),
      { timeout: 120_000 });
    await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${id}`, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
    await page.bringToFront();
    await page.click('#convert-results [data-field="copy"]');
    await page.waitForFunction(() => document.querySelector('#convert-results [data-field="copy"]').textContent !== "Copy report");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    for (const expected of ["PrintNomad ", "File: damaged.3mf", "PN102"]) {
      if (!copied.includes(expected)) throw new Error(`copied report lacks ${expected}:\n${copied}`);
    }
    console.log("OK: damaged file shows its code and the report can be copied");
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
