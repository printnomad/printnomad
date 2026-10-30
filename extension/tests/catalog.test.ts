import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Catalog,
  type Fetch,
  parseCatalog,
  ProfileError,
  ProfileStore,
  sha256Hex,
  type TextCache,
  vendorOf,
  vendorsNeeded,
} from "../src/profiles/catalog.ts";

const FF = '{"vendor":"Flashforge","files":{}}';
const LIB = '{"vendor":"OrcaFilamentLibrary","files":{}}';
const BASE = "https://example.test/profiles/";

async function catalogFor(ff = FF): Promise<Catalog> {
  return {
    schema: 1,
    generated: "2026-10-30T00:00:00Z",
    slicers: {
      flashstudio: {
        name: "Flash Studio", repo: "FlashForge/Orca-Flashforge", ref: "1.7.15", commit: null,
        vendors: {
          Flashforge: {
            version: "1", bundle: "flashstudio/1.7.15/Flashforge.json", sha256: await sha256Hex(ff), bytes: ff.length,
            depends: ["OrcaFilamentLibrary"],
            printers: [{ name: "Flashforge Creator 5 Pro 0.4 nozzle", model: "Flashforge Creator 5 Pro", nozzle: "0.4", extruders: 4 }],
          },
          OrcaFilamentLibrary: {
            version: "1", bundle: "flashstudio/1.7.15/OrcaFilamentLibrary.json", sha256: await sha256Hex(LIB),
            bytes: LIB.length, depends: [], printers: [],
          },
        },
      },
    },
  };
}

function fakeFetch(files: Record<string, string>, log: string[] = []): Fetch {
  return async (url) => {
    log.push(url);
    const text = files[url];
    return { ok: text !== undefined, status: text === undefined ? 404 : 200, text: async () => text ?? "" };
  };
}

function memoryCache(): TextCache & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (u) => data.get(u), put: async (u, t) => void data.set(u, t) };
}

test("finds the vendor of a printer and its dependencies", async () => {
  const c = await catalogFor();
  assert.equal(vendorOf(c, "flashstudio", "Flashforge Creator 5 Pro 0.4 nozzle"), "Flashforge");
  assert.equal(vendorOf(c, "flashstudio", "Nope"), undefined);
  assert.deepEqual(vendorsNeeded(c.slicers.flashstudio, "Flashforge"), ["Flashforge", "OrcaFilamentLibrary"]);
});

test("rejects unknown catalog schemas", () => {
  assert.throws(() => parseCatalog('{"schema": 2, "slicers": {}}'), ProfileError);
});

test("downloads verified bundles relative to the catalog and caches them", async () => {
  const c = await catalogFor();
  const log: string[] = [];
  const files = {
    [`${BASE}catalog.json`]: JSON.stringify(c),
    [`${BASE}flashstudio/1.7.15/Flashforge.json`]: FF,
    [`${BASE}flashstudio/1.7.15/OrcaFilamentLibrary.json`]: LIB,
  };
  const cache = memoryCache();
  const store = new ProfileStore([`${BASE}catalog.json`], fakeFetch(files, log), cache);
  const { bundles, source } = await store.bundlesFor("flashstudio", "Flashforge Creator 5 Pro 0.4 nozzle");
  assert.deepEqual(bundles, [FF, LIB]);
  assert.equal(source, "FlashForge/Orca-Flashforge@1.7.15");
  assert.equal(cache.data.size, 2);

  log.length = 0;
  await store.bundlesFor("flashstudio", "Flashforge Creator 5 Pro 0.4 nozzle");
  assert.deepEqual(log, [], "catalog and bundles come from memory and cache");
});

test("falls back to the next catalog and refuses tampered bundles", async () => {
  const c = await catalogFor();
  const files = {
    "chrome-extension://x/profiles/catalog.json": JSON.stringify(c),
    "chrome-extension://x/profiles/flashstudio/1.7.15/Flashforge.json": FF.replace("files", "filez"),
    "chrome-extension://x/profiles/flashstudio/1.7.15/OrcaFilamentLibrary.json": LIB,
  };
  const cache = memoryCache();
  const store = new ProfileStore([`${BASE}catalog.json`, "chrome-extension://x/profiles/catalog.json"], fakeFetch(files), cache);
  const { url } = await store.catalog();
  assert.equal(url, "chrome-extension://x/profiles/catalog.json");
  await assert.rejects(store.bundlesFor("flashstudio", "Flashforge Creator 5 Pro 0.4 nozzle"), /checksum/);
  assert.equal(cache.data.size, 0, "bundled profiles are not cached");
});

test("reports a printer missing from the catalog", async () => {
  const store = new ProfileStore([`${BASE}catalog.json`], fakeFetch({ [`${BASE}catalog.json`]: JSON.stringify(await catalogFor()) }));
  await assert.rejects(store.bundlesFor("flashstudio", "Unknown"), ProfileError);
});
