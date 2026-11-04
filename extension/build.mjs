// Builds the unpacked extension into dist/ (CSS is compiled afterwards by `npm run build:css`).
//
//   node build.mjs                        → dist/
//   PN_PROFILES_DIR=<catalog dir> node build.mjs
//       also bundles the profiles listed in config.json (fallbackProfiles: vendor
//       names or "*" for every vendor of a slicer) from a catalog built by
//       tools/build_profile_catalog.py. Bundles are stored gzipped (JSON shrinks ~17×);
//       the extension decompresses them when it uses them.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const coreDir = join(here, "..", "core", "src", "printnomad");
// Files Pyodide needs at runtime (the rest of the npm package is for Node).
const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Sites of the MakerWorld integration; PN_TEST_ORIGINS adds a local test page (tests/e2e-makerworld.mjs).
const makerworldOrigins = [...config.makerworldOrigins, ...(process.env.PN_TEST_ORIGINS ?? "").split(",").filter(Boolean)];
const shared = {
  outdir: dist,
  bundle: true,
  target: "chrome120",
  minify: true,
  sourcemap: true,
  define: {
    __PN_CONFIG__: JSON.stringify({
      catalogUrl: config.catalogUrl,
      // PN_REPORT_URL: a local stand-in for the worker (tests/e2e-makerworld.mjs).
      reportUrl: process.env.PN_REPORT_URL ?? config.reportUrl ?? "",
      supportedModels: config.supportedModels ?? [],
      makerworldOrigins,
      version: pkg.version ?? "0.0.0",
    }),
  },
  logLevel: "warning",
};
// Extension pages and workers: ES modules.
await build({
  ...shared,
  format: "esm",
  entryPoints: {
    background: "src/background.ts",
    options: "src/options/options.ts",
    worker: "src/engine/worker.ts",
    bridge: "src/makerworld/bridge.ts",
  },
});
// Content scripts are classic scripts.
await build({
  ...shared,
  format: "iife",
  entryPoints: {
    "makerworld-content": "src/makerworld/content.ts",
    "makerworld-main": "src/makerworld/main-world.ts",
  },
});

// Manifest: version from package.json, host permission from the catalog URL.
const manifest = JSON.parse(readFileSync(join(here, "static", "manifest.json"), "utf8"));
manifest.version = pkg.version ?? "0.0.0";
manifest.host_permissions = config.catalogUrl ? [`${new URL(config.catalogUrl).origin}/*`] : [];
// Match patterns take no port: "http://127.0.0.1:47823" → "http://127.0.0.1/*".
const sites = makerworldOrigins.map((origin) => {
  const { protocol, hostname } = new URL(origin);
  return `${protocol}//${hostname}/*`;
});
manifest.content_scripts = [
  // Page world first: it must wrap fetch/XHR before MakerWorld's code runs.
  { matches: sites, js: ["makerworld-main.js"], world: "MAIN", run_at: "document_start" },
  { matches: sites, js: ["makerworld-content.js"], run_at: "document_idle" },
];
// bridge.html: the engine iframe; styles.css: the assignment screen's shadow root.
manifest.web_accessible_resources = [{ resources: ["bridge.html", "styles.css"], matches: sites }];
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
cpSync(join(here, "static", "_locales"), join(dist, "_locales"), { recursive: true });
cpSync(join(here, "src", "options", "options.html"), join(dist, "options.html"));
cpSync(join(here, "src", "makerworld", "bridge.html"), join(dist, "bridge.html"));

mkdirSync(join(dist, "pyodide"));
for (const f of PYODIDE_FILES) cpSync(join(here, "node_modules", "pyodide", f), join(dist, "pyodide", f));

// The Python core as {relative path: text}; the worker writes it into Pyodide's file system.
const core = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "__pycache__") continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(py|json)$/.test(name)) core[relative(coreDir, path).split("\\").join("/")] = readFileSync(path, "utf8");
  }
})(coreDir);
writeFileSync(join(dist, "core.json"), JSON.stringify(core));

const profilesDir = process.env.PN_PROFILES_DIR;
if (profilesDir) {
  const catalog = JSON.parse(readFileSync(join(profilesDir, "catalog.json"), "utf8"));
  const slicers = {};
  for (const [slicer, vendors] of Object.entries(config.fallbackProfiles)) {
    const entry = catalog.slicers[slicer];
    if (!entry) {
      console.warn(`fallback profiles: ${slicer} is not in ${profilesDir}/catalog.json, skipped`);
      continue;
    }
    const listed = vendors === "*" ? Object.keys(entry.vendors) : vendors;
    const wanted = new Set(listed.flatMap((v) => [v, ...(entry.vendors[v]?.depends ?? [])]));
    const kept = {};
    for (const v of wanted) {
      if (!entry.vendors[v]) throw new Error(`fallback vendor ${slicer}/${v} is not in the catalog`);
      const bundle = `${entry.vendors[v].bundle}.gz`;
      mkdirSync(dirname(join(dist, "profiles", bundle)), { recursive: true });
      writeFileSync(join(dist, "profiles", bundle), gzipSync(readFileSync(join(profilesDir, entry.vendors[v].bundle)), { level: 9 }));
      // sha256 stays the one of the uncompressed bundle: it is checked after decompressing.
      kept[v] = { ...entry.vendors[v], bundle };
      for (const cover of Object.values(kept[v].covers ?? {})) {
        mkdirSync(dirname(join(dist, "profiles", cover)), { recursive: true });
        cpSync(join(profilesDir, cover), join(dist, "profiles", cover));
      }
    }
    slicers[slicer] = { ...entry, vendors: kept };
  }
  writeFileSync(join(dist, "profiles", "catalog.json"), JSON.stringify({ ...catalog, slicers }));
} else if (!existsSync(join(dist, "profiles"))) {
  console.warn("PN_PROFILES_DIR not set: no fallback profiles bundled");
}
console.log(`built ${pkg.name} into ${relative(process.cwd(), dist) || "."}`);
