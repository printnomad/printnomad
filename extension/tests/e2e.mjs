// End-to-end: loads dist/ in a real Chromium browser and converts a project from the
// options page, with the profiles bundled as fallback (the published catalog is not
// reachable in tests).
//
//   npm run test:e2e                      synthetic project + fake profiles (self-contained)
//   BB_E2E_FILE=x.3mf BB_E2E_PRINTER="…" [BB_E2E_SLICER=key] [BB_E2E_EXPECT=text] BB_E2E_SKIP_BUILD=1 npm run test:e2e
//                                         a real project with the dist/ you built
//
// The browser comes from CHROME_PATH or a usual install location; without one the test
// is skipped (exit 0) so CI machines without Chrome still pass.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const repo = join(ext, "..");
const BROWSERS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.log("SKIP: no Chromium-based browser found (set CHROME_PATH)");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "bb-e2e-"));
let file = process.env.BB_E2E_FILE;
let printer = process.env.BB_E2E_PRINTER ?? "Flashforge Creator 5 Pro 0.4 nozzle";
if (!file) {
  // Fake profile tree and project from the Python test fixtures (conftest.py).
  const python = process.env.PYTHON ?? (existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3");
  execFileSync(python, ["-c", `
import sys; sys.path[:0] = [${JSON.stringify(repo)}, ${JSON.stringify(join(repo, "core/src"))}]
from pathlib import Path
from conftest import build_profiles_tree, make_bambu_3mf
work = Path(${JSON.stringify(work)})
build_profiles_tree(work)
make_bambu_3mf(work / "boat.3mf", [("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")], [["2"]])
`]);
  execFileSync(python, [join(repo, "tools/build_profile_catalog.py"), "--slicer", "flashstudio",
    "--profiles", join(work, "profiles"), "--ref", "test", "--out", join(work, "catalog")]);
  file = join(work, "boat.3mf");
}
if (!process.env.BB_E2E_SKIP_BUILD) {
  execFileSync("npm", ["run", "build"], { cwd: ext, stdio: "inherit", env: { ...process.env, BB_PROFILES_DIR: join(work, "catalog") } });
}

const downloads = join(work, "downloads");
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  pipe: true,
  enableExtensions: [join(ext, "dist")],
  args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(work, "profile")}`],
});
const errors = [];
try {
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
  const id = new URL(worker.url()).host;
  const session = await browser.target().createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });

  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/options.html`);
  // BB_E2E_PRINTERS="slicer|preset;slicer|preset" converts for several printers at once.
  const printers = (process.env.BB_E2E_PRINTERS ?? `${process.env.BB_E2E_SLICER ?? "flashstudio"}|${printer}`)
    .split(";").map((entry, i) => {
      const [slicer, preset] = entry.split("|");
      return { id: `p${i}`, slicer, printer: preset };
    });
  await page.evaluate((printers) => chrome.storage.sync.set({ printers }), printers);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#convert-printer option").length > 0);

  const started = Date.now();
  const input = await page.$("#convert-file");
  await input.uploadFile(file);
  await page.click("#convert-button");
  await page.waitForFunction(() => !document.querySelector("#convert-button").disabled, { timeout: 300_000 });
  const rows = await page.$$eval("#convert-results > li", (items) => items.map((li) => ({
    printer: li.querySelector('[data-field="printer"]').textContent,
    status: li.querySelector('[data-field="status"]').textContent,
    report: li.querySelector('[data-field="report"]').textContent,
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
    if (process.env.BB_E2E_EXPECT && !row.report.includes(process.env.BB_E2E_EXPECT)) {
      // e.g. BB_E2E_EXPECT=" → " to check the report shows the designer's original values.
      throw new Error(`report lacks ${JSON.stringify(process.env.BB_E2E_EXPECT)}:\n${row.report}`);
    }
  }
  if (!process.env.BB_E2E_FILE && !rows[0].report.includes("Flashforge")) throw new Error(`unexpected report:\n${rows[0].report}`);
  const complete = items.filter((d) => d.state === "complete");
  const converted = rows.filter((r) => !r.already).length;
  if (complete.length !== converted) throw new Error(`${complete.length} of ${converted} files downloaded`);
  for (const d of complete) {
    if (readFileSync(d.filename).readUInt32LE(0) !== 0x04034b50) throw new Error(`${d.filename} is not a ZIP file`);
  }
  console.log(`OK: downloaded ${complete.length} file(s)`);
} finally {
  await browser.close();
}
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
