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
  return mkdtempSync(join(tmpdir(), "pn-e2e-"));
}

/** Fake profile tree, its catalog and a one-filament Bambu project (from conftest.py). */
export function buildFixtures(work) {
  const python = process.env.PYTHON ?? (existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3");
  execFileSync(python, ["-c", `
import sys; sys.path[:0] = [${JSON.stringify(repo)}, ${JSON.stringify(join(repo, "core/src"))}]
import json
from pathlib import Path
from conftest import build_profiles_tree, make_bambu_3mf
work = Path(${JSON.stringify(work)})
build_profiles_tree(work)
# The build plate can be chosen on this printer, as on the real Creator 5 Pro.
machine = work / "profiles/Flashforge/machine/c5p.json"
machine.write_text(json.dumps({**json.loads(machine.read_text()), "support_multi_bed_types": "1"}))
make_bambu_3mf(work / "boat.3mf", [("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")], [["2"]])
# 5 colours painted on one plate: more than the 4 extruders, needs an assignment.
colours = ["#000000", "#2A2E32", "#FFFFFF", "#FF6A13", "#136935"]
make_bambu_3mf(work / "painted.3mf", [("PLA", "Bambu PLA Basic @BBL A1", c) for c in colours], [["2"]], paint=(1, 2, 3, 4, 5))
`]);
  execFileSync(python, [join(repo, "tools/build_profile_catalog.py"), "--slicer", "flashstudio",
    "--profiles", join(work, "profiles"), "--ref", "test", "--out", join(work, "catalog")]);
  return { project: join(work, "boat.3mf"), painted: join(work, "painted.3mf"), catalog: join(work, "catalog") };
}

/** A value of a converted project's project_settings.config. */
export function projectSetting(file, key) {
  const python = process.env.PYTHON ?? (existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3");
  return execFileSync(python, ["-c", `
import json, sys, zipfile
print(json.loads(zipfile.ZipFile(sys.argv[1]).read("Metadata/project_settings.config")).get(sys.argv[2]))
`, file, key], { encoding: "utf8" }).trim();
}

export function buildExtension(env = {}) {
  execFileSync("npm", ["run", "build"], { cwd: ext, stdio: "inherit", env: { ...process.env, ...env } });
}

export async function launch(browserPath, work) {
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    pipe: true,
    dumpio: Boolean(process.env.CI),  // why the browser did not start, in the CI log
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
