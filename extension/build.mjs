// Builds the unpacked extension into dist/ (CSS is compiled afterwards by `npm run build:css`).
//
//   node build.mjs                        → dist/
//   BB_PROFILES_DIR=<catalog dir> node build.mjs
//       also bundles the fallback profiles listed in config.json (fallbackProfiles)
//       from a catalog built by tools/build_profile_catalog.py.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const coreDir = join(here, "..", "core", "src", "betterbridge");
// Files Pyodide needs at runtime (the rest of the npm package is for Node).
const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    options: "src/options/options.ts",
    worker: "src/engine/worker.ts",
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "chrome120",
  minify: true,
  sourcemap: true,
  define: { __BB_CONFIG__: JSON.stringify({ catalogUrl: config.catalogUrl, version: pkg.version ?? "0.0.0" }) },
  logLevel: "warning",
});

// Manifest: version from package.json, host permission from the catalog URL.
const manifest = JSON.parse(readFileSync(join(here, "static", "manifest.json"), "utf8"));
manifest.version = pkg.version ?? "0.0.0";
manifest.host_permissions = [`${new URL(config.catalogUrl).origin}/*`];
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
cpSync(join(here, "static", "_locales"), join(dist, "_locales"), { recursive: true });
cpSync(join(here, "src", "options", "options.html"), join(dist, "options.html"));

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

const profilesDir = process.env.BB_PROFILES_DIR;
if (profilesDir) {
  const catalog = JSON.parse(readFileSync(join(profilesDir, "catalog.json"), "utf8"));
  const slicers = {};
  for (const [slicer, vendors] of Object.entries(config.fallbackProfiles)) {
    const entry = catalog.slicers[slicer];
    if (!entry) {
      console.warn(`fallback profiles: ${slicer} is not in ${profilesDir}/catalog.json, skipped`);
      continue;
    }
    const wanted = new Set(vendors.flatMap((v) => [v, ...(entry.vendors[v]?.depends ?? [])]));
    const kept = Object.fromEntries(Object.entries(entry.vendors).filter(([v]) => wanted.has(v)));
    for (const v of wanted) {
      if (!kept[v]) throw new Error(`fallback vendor ${slicer}/${v} is not in the catalog`);
      const src = join(profilesDir, kept[v].bundle);
      mkdirSync(dirname(join(dist, "profiles", kept[v].bundle)), { recursive: true });
      cpSync(src, join(dist, "profiles", kept[v].bundle));
    }
    slicers[slicer] = { ...entry, vendors: kept };
  }
  writeFileSync(join(dist, "profiles", "catalog.json"), JSON.stringify({ ...catalog, slicers }));
} else if (!existsSync(join(dist, "profiles"))) {
  console.warn("BB_PROFILES_DIR not set: no fallback profiles bundled");
}
console.log(`built ${pkg.name} into ${relative(process.cwd(), dist) || "."}`);
