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
const { project, painted, catalog } = buildFixtures(work);
buildExtension({ PN_PROFILES_DIR: catalog, PN_TEST_ORIGINS: ORIGIN, PN_REPORT_URL: `${ORIGIN}/report` });

const page = readFileSync(join(ext, "tests/fixtures/makerworld.html"));
let projectBytes = readFileSync(project);
const reports = [];
const server = createServer((req, res) => {
  if (req.url === "/report") {
    // Stands in for tools/report-worker: the extension has no host permission, only CORS.
    const cors = { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-headers": "content-type" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      reports.push({ origin: req.headers.origin, ...JSON.parse(body) });
      res.writeHead(201, cors).end("{}");
    });
    return;
  }
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
  const label = () => mw.$eval(".section:not(.mobile-box) .primaryButton span", (e) => e.textContent);

  // 1. Our chip, next to "All", looking like MakerWorld's.
  await mw.waitForSelector('[data-pn-printer="c5p"]', { timeout: 30_000 });
  const chips = await mw.$$eval(".section:not(.mobile-box) .swiper-slide", (s) => s.map((x) => x.textContent.trim()));
  if (chips.join("|") !== "All|Creator 5 Pro|A1 mini|P1S") throw new Error(`unexpected chips: ${chips}`);

  // 2. Selecting it shows every profile and turns the button into ours.
  await mw.click('.section:not(.mobile-box) [data-pn-printer="c5p"] .chip');
  await mw.waitForFunction(() => document.querySelector(".section:not(.mobile-box) .primaryButton span").textContent === "Download for Creator 5 Pro");
  const selected = await mw.$$eval(".section:not(.mobile-box) .chip.selected", (c) => c.map((x) => x.textContent));
  if (selected.join() !== "Creator 5 Pro") throw new Error(`selected chips: ${selected}`);
  // "All" was clicked once (one route change), not once per copy of the section.
  const clicks = await mw.evaluate(() => window.chipClicks);
  if (clicks !== 1) throw new Error(`MakerWorld's chips were clicked ${clicks} times`);

  // 3. The menu offers it too.
  await mw.click(".section:not(.mobile-box) .icon-box");
  await mw.waitForSelector("[data-pn-item]");
  const item = await mw.$eval("[data-pn-item]", (e) => e.textContent.trim());
  if (item !== "Download for Creator 5 Pro") throw new Error(`menu item: ${item}`);
  const order = await mw.$$eval(".MuiPopper-root .list > *", (items) => items.map((i) => i.textContent.trim()));
  if (order.join("|") !== "Download for Creator 5 Pro|Download 3MF|Download STL/CAD Files i") throw new Error(`menu: ${order}`);
  await mw.click(".section:not(.mobile-box) .icon-box"); // close it

  // 4. The button captures MakerWorld's download (through its menu the first time,
  //    then its button), converts it and saves only the result; MakerWorld's stored
  //    download preference is left as it was.
  const convertOnce = async (n) => {
    // MakerWorld's menu must not flash while PrintNomad uses it.
    await mw.evaluate(() => {
      window.menuSeen = false;
      new MutationObserver(() => {
        const menu = document.querySelector(".MuiPopper-root");
        if (menu && getComputedStyle(menu).clipPath === "none") window.menuSeen = true;
      }).observe(document.body, { childList: true });
    });
    await mw.click(".section:not(.mobile-box) .primaryButton");
    // A spinner while it works.
    await mw.waitForSelector(".section:not(.mobile-box) .primaryButton [data-pn-loading]", { timeout: 10_000 });
    await mw.waitForFunction(() => /Saved|Could not|Not saved|failed|answer|found/.test(document.querySelector(".section:not(.mobile-box) .primaryButton span").textContent),
      { timeout: 120_000 });
    const status = await label();
    if (status !== "Saved ✓") throw new Error(`status: ${status}`);
    if (await mw.evaluate(() => window.menuSeen)) throw new Error("MakerWorld's menu was visible during the conversion");
    if (await mw.evaluate(() => "bbHiding" in document.documentElement.dataset)) throw new Error("menus still hidden");
    await mw.waitForFunction(() => document.querySelector(".section:not(.mobile-box) .primaryButton span").textContent === "Download for Creator 5 Pro", { timeout: 10_000 });
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
  await mw.click(".section:not(.mobile-box) .swiper-slide:last-child .chip");
  await mw.waitForFunction(() => document.querySelector(".section:not(.mobile-box) .primaryButton span").textContent === "Open in Bambu Studio", { timeout: 10_000 });
  // 6. A project with more colours on a plate than extruders: the assignment screen over
  //    MakerWorld (shadow root), then the conversion without downloading again.
  projectBytes = readFileSync(painted);
  await mw.click('.section:not(.mobile-box) [data-pn-printer="c5p"] .chip');
  await mw.click(".section:not(.mobile-box) .primaryButton");
  const modalButton = await mw.waitForFunction(
    () => document.querySelector("[data-pn-modal]")?.shadowRoot?.querySelector(".btn-primary"), { timeout: 120_000 });
  const title = await mw.evaluate(() => document.querySelector("[data-pn-modal]").shadowRoot.querySelector("h3").textContent);
  if (!/5 colours to the 4 extruders of Creator 5 Pro/.test(title)) throw new Error(`modal: ${title}`);
  await modalButton.asElement().click();
  await mw.waitForFunction(() => /Saved|Could not|Not saved/.test(document.querySelector(".section:not(.mobile-box) .primaryButton span").textContent),
    { timeout: 120_000 });
  if (await label() !== "Saved ✓") throw new Error(`after assignment: ${await label()}`);
  const all = (await options.evaluate(() => chrome.downloads.search({}))).filter((d) => d.state === "complete");
  if (all.length !== 3) throw new Error(`${all.length} downloads after the assigned conversion`);
  console.log("OK: chip, button, menu, capture, conversion, restore and assignment screen");

  // 7. A damaged project: the code on the button, the panel, and the report sent in one click.
  projectBytes = Buffer.from("not a zip");
  await mw.waitForFunction(() => document.querySelector(".section:not(.mobile-box) .primaryButton span").textContent === "Download for Creator 5 Pro", { timeout: 30_000 });
  await mw.click(".section:not(.mobile-box) .primaryButton");
  const inModal = (field) => `document.querySelector("[data-pn-modal]")?.shadowRoot?.querySelector('[data-field="${field}"]')`;
  await mw.waitForFunction(inModal("send"), { timeout: 120_000 });
  if (await label() !== "Error PN102") throw new Error(`button after a damaged file: ${await label()}`);
  await mw.evaluate(`Object.assign(${inModal("comment")}, { value: "from the test" })`);
  await mw.evaluate(`${inModal("send")}.click()`);
  await mw.waitForFunction(`${inModal("send-result")}.textContent.includes("thank you")`, { timeout: 30_000 });
  const [sent] = reports;
  if (reports.length !== 1 || sent.code !== "PN102" || sent.comment !== "from the test" || !sent.report.includes("PN102")
    || !sent.origin?.startsWith("chrome-extension://")) {
    throw new Error(`report received: ${JSON.stringify(reports)}`);
  }
  await mw.evaluate(`${inModal("close")}.click()`);
  console.log("OK: damaged project shows its code and the report is sent with one click");
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
