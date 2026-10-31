// Shared helpers for the browser tests: a Chromium-based browser, the fixtures built from
// the Python test suite (conftest.py) and the extension build.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const ext = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repo = join(ext, "..");

export function findBrowser() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find((p) => existsSync(p));
}

export function workDir() {
  return mkdtempSync(join(tmpdir(), "bb-e2e-"));
}

/** Fake profile tree, its catalog and a one-filament Bambu project (from conftest.py). */
export function buildFixtures(work) {
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
  return { project: join(work, "boat.3mf"), catalog: join(work, "catalog") };
}

export function buildExtension(env = {}) {
  execFileSync("npm", ["run", "build"], { cwd: ext, stdio: "inherit", env: { ...process.env, ...env } });
}

export async function launch(browserPath, work) {
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    pipe: true,
    enableExtensions: [join(ext, "dist")],
    args: ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(work, "profile")}`],
  });
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
  return { browser, id: new URL(worker.url()).host };
}

/** Downloads go to `dir` (saved under GUID names: read them through chrome.downloads). */
export async function allowDownloads(browser, dir) {
  const session = await browser.target().createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
}
