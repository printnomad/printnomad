// Makes the Chrome Web Store package: a release build, checked, zipped into out/.
//
//   PN_PROFILES_DIR=<catalog dir> npm run package
//
// The catalog comes from tools/build_release_catalog.sh. The checks stop a package that would
// not work for users or that holds test settings.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const fail = (message) => {
  console.error(`package: ${message}`);
  process.exit(1);
};

if (!process.env.PN_PROFILES_DIR) fail("set PN_PROFILES_DIR to a catalog (tools/build_release_catalog.sh)");
for (const name of ["PN_TEST_ORIGINS", "PN_REPORT_URL"]) if (process.env[name]) fail(`unset ${name}: it is for tests`);

const env = { ...process.env, PN_RELEASE: "1" };
execFileSync(process.execPath, ["build.mjs"], { cwd: here, env, stdio: "inherit" });
execFileSync("npm", ["run", "-s", "build:css"], { cwd: here, env, stdio: "inherit" });

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(relative(dist, path));
  }
})(dist);

if (files.some((f) => f.endsWith(".map"))) fail("source maps in the package");
for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md", "icons/icon-128.png", "profiles/catalog.json"]) {
  if (!files.includes(f)) fail(`${f} is missing`);
}

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
if (JSON.stringify(manifest).includes("127.0.0.1")) fail("a test origin is in the manifest");

// Every printer offered must have its profiles in the package.
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(dist, "profiles", "catalog.json"), "utf8"));
const shipped = new Set(Object.values(catalog.slicers)
  .flatMap((slicer) => Object.values(slicer.vendors))
  .flatMap((vendor) => vendor.printers.map((printer) => printer.model)));
const missing = config.supportedModels.filter((model) => !shipped.has(model));
if (missing.length) fail(`no profiles for: ${missing.join(", ")}`);

const privacy = readFileSync(join(here, "..", "docs", "privacy.md"), "utf8");
if (privacy.includes("CONTACT_EMAIL")) console.warn("package: WARNING docs/privacy.md still has no contact address");

const out = join(here, "out");
mkdirSync(out, { recursive: true });
const zip = join(out, `printnomad-${manifest.version}.zip`);
if (existsSync(zip)) rmSync(zip);
execFileSync("zip", ["-qrX", zip, ".", "-x", "*.DS_Store"], { cwd: dist, stdio: "inherit" });

const bytes = readFileSync(zip);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sources = Object.values(catalog.slicers).map((slicer) => slicer.source).join(", ");
console.log(`${relative(process.cwd(), zip)}  ${(bytes.length / 1e6).toFixed(1)} MB  ${files.length} files`);
console.log(`version ${manifest.version} (${manifest.version_name ?? "no version name"})`);
console.log(`profiles: ${sources}`);
console.log(`sha256 ${sha256}`);
