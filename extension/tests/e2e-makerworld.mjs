// End-to-end: the MakerWorld integration on a local stand-in page (tests/fixtures/
// makerworld.html; the real site blocks automated browsers). Checks the injected chip,
// the button and menu texts, that MakerWorld's own download is captured and converted,
// and that only the converted file is saved.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { allowDownloads, buildExtension, buildFixtures, ext, findBrowser, launch, workDir } from "./support.mjs";

const PORT = 47823;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const browserPath = findBrowser();
if (!browserPath) {
  console.log("SKIP: no Chromium-based browser found (set CHROME_PATH)");
  process.exit(0);
}

const work = workDir();
const { project, catalog } = buildFixtures(work);
buildExtension({ BB_PROFILES_DIR: catalog, BB_TEST_ORIGINS: ORIGIN });

const page = readFileSync(join(ext, "tests/fixtures/makerworld.html"));
const projectBytes = readFileSync(project);
const server = createServer((req, res) => {
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (req.url.startsWith("/api/v1/design-service/instance/1/f3mf")) {
    return res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name: "boat.3mf", url: `${ORIGIN}/cdn/boat.3mf` }));
  }
  if (req.url === "/cdn/boat.3mf") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(projectBytes);
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1");

const { browser, id } = await launch(browserPath, work);
const errors = [];
try {
  await allowDownloads(browser, join(work, "downloads"));
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.evaluate(() => chrome.storage.sync.set({
    printers: [{ id: "c5p", slicer: "flashstudio", printer: "Flashforge Creator 5 Pro 0.4 nozzle", slicerAuto: true }],
  }));

  const mw = await browser.newPage();
  mw.on("pageerror", (e) => errors.push(String(e)));
  await mw.goto(ORIGIN);
  const label = () => mw.$eval(".primaryButton span", (e) => e.textContent);

  // 1. Our chip, next to "All", looking like MakerWorld's.
  await mw.waitForSelector('[data-bb-printer="c5p"]', { timeout: 30_000 });
  const chips = await mw.$$eval(".swiper-slide", (s) => s.map((x) => x.textContent.trim()));
  if (chips.join("|") !== "All|Creator 5 Pro|A1 mini|P1S") throw new Error(`unexpected chips: ${chips}`);

  // 2. Selecting it shows every profile and turns the button into ours.
  await mw.click('[data-bb-printer="c5p"] .chip');
  await mw.waitForFunction(() => document.querySelector(".primaryButton span").textContent === "Download for Creator 5 Pro");
  const selected = await mw.$$eval(".chip.selected", (c) => c.map((x) => x.textContent));
  if (selected.join() !== "Creator 5 Pro") throw new Error(`selected chips: ${selected}`);

  // 3. The menu offers it too.
  await mw.click(".icon-box");
  await mw.waitForSelector("[data-bb-item]");
  const item = await mw.$eval("[data-bb-item]", (e) => e.textContent.trim());
  if (item !== "Download for Creator 5 Pro") throw new Error(`menu item: ${item}`);
  const order = await mw.$$eval(".MuiPopper-root .item", (items) => items.map((i) => i.textContent.trim()));
  if (order[0] !== "Download for Creator 5 Pro" || order[1] !== "Download 3MF") throw new Error(`menu: ${order}`);
  await mw.click(".icon-box"); // close it

  // 4. The button captures MakerWorld's download (through its menu the first time,
  //    then its button), converts it and saves only the result; MakerWorld's stored
  //    download preference is left as it was.
  const convertOnce = async (n) => {
    await mw.click(".primaryButton");
    await mw.waitForFunction(() => /Saved|Could not|Not saved|failed|answer|found/.test(document.querySelector(".primaryButton span").textContent),
      { timeout: 120_000 });
    const status = await label();
    if (status !== "Saved ✓") throw new Error(`status: ${status}`);
    await mw.waitForFunction(() => document.querySelector(".primaryButton span").textContent === "Download for Creator 5 Pro", { timeout: 10_000 });
    const complete = (await options.evaluate(() => chrome.downloads.search({}))).filter((d) => d.state === "complete");
    if (complete.length !== n) throw new Error(`${complete.length} downloads after ${n} conversion(s): the original must not be saved`);
    const model = execFileSync("python3", ["-c",
      "import json,sys,zipfile; print(json.loads(zipfile.ZipFile(sys.argv[1]).read('Metadata/project_settings.config'))['printer_model'])",
      complete[0].filename]).toString().trim();
    if (model !== "Flashforge Creator 5 Pro") throw new Error(`the saved file is for ${model}, not the converted project`);
  };
  await convertOnce(1);
  await convertOnce(2);
  if (await mw.evaluate(() => window.openedInStudio)) throw new Error("MakerWorld's own action ran");
  if (await mw.evaluate(() => localStorage.getItem("model_operate_last_key")) !== null) {
    throw new Error("MakerWorld's stored download preference was changed");
  }

  // 5. A native chip gives MakerWorld its button back.
  await mw.click(".swiper-slide:last-child .chip");
  await mw.waitForFunction(() => document.querySelector(".primaryButton span").textContent === "Open in Bambu Studio", { timeout: 10_000 });
  console.log("OK: chip, button, menu, capture, conversion and restore");
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
