// Profile catalog published by CI (tools/build_profile_catalog.py) and the bundles it lists.
//
// Bundles are kept as JSON text: they are verified (sha256) and handed to the Python
// core as is, which parses them; the extension never needs their contents.

export interface Printer {
  name: string;
  model: string;
  nozzle: string;
  extruders: number;
}

export interface VendorEntry {
  version: string | null;
  bundle: string;
  sha256: string;
  bytes: number;
  depends: string[];
  printers: Printer[];
}

export interface SlicerEntry {
  name: string;
  repo: string | null;
  ref: string;
  commit: string | null;
  /** Shown in reports, e.g. "FlashForge/Orca-Flashforge@1.7.15" or "Flash Studio 1.7.20". */
  source?: string;
  vendors: Record<string, VendorEntry>;
}

export interface Catalog {
  schema: number;
  generated: string;
  slicers: Record<string, SlicerEntry>;
}

export const CATALOG_SCHEMA = 1;

/** Minimal Cache Storage surface, so tests can pass a Map-backed fake. */
export interface TextCache {
  get(url: string): Promise<string | undefined>;
  put(url: string, text: string): Promise<void>;
}

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ProfileError extends Error {}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Vendor that ships `printer` in `slicer`, if any. */
export function vendorOf(catalog: Catalog, slicer: string, printer: string): string | undefined {
  const vendors = catalog.slicers[slicer]?.vendors ?? {};
  return Object.keys(vendors).find((v) => vendors[v].printers.some((p) => p.name === printer));
}

/** The vendor and the vendors it depends on (e.g. the shared filament library), without repeats. */
export function vendorsNeeded(entry: SlicerEntry, vendor: string): string[] {
  const out: string[] = [];
  const visit = (v: string) => {
    if (out.includes(v)) return;
    if (!entry.vendors[v]) throw new ProfileError(`vendor ${v} is missing from the catalog`);
    out.push(v);
    entry.vendors[v].depends.forEach(visit);
  };
  visit(vendor);
  return out;
}

/** Human-readable profile source, as the report shows it. */
export function describeSource(entry: SlicerEntry): string {
  return entry.source ?? (entry.repo ? `${entry.repo}@${entry.ref}` : `${entry.name} ${entry.ref}`);
}

/**
 * Catalog and bundles from a list of base URLs, first that answers wins
 * (published catalog first, the copy bundled with the extension last).
 * Bundle URLs contain the slicer release, so a cached bundle never goes stale.
 */
export class ProfileStore {
  private readonly catalogs = new Map<string, Catalog>();
  private readonly catalogUrls: string[];
  private readonly fetchFn: Fetch;
  private readonly cache?: TextCache;

  constructor(catalogUrls: string[], fetchFn: Fetch, cache?: TextCache) {
    this.catalogUrls = catalogUrls;
    this.fetchFn = fetchFn;
    this.cache = cache;
  }

  async catalog(): Promise<{ catalog: Catalog; url: string }> {
    const errors: string[] = [];
    for (const url of this.catalogUrls) {
      try {
        const catalog = this.catalogs.get(url) ?? parseCatalog(await this.fetchText(url));
        this.catalogs.set(url, catalog);
        return { catalog, url };
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message}`);
      }
    }
    throw new ProfileError(`no profile catalog available (${errors.join("; ")})`);
  }

  /** Verified bundle texts for a printer's vendor and its dependencies. */
  async bundlesFor(slicer: string, printer: string): Promise<{ bundles: string[]; source: string }> {
    const { catalog, url } = await this.catalog();
    const entry = catalog.slicers[slicer];
    const vendor = entry && vendorOf(catalog, slicer, printer);
    if (!vendor) throw new ProfileError(`${printer} is not in the ${slicer} profiles`);
    const bundles = await Promise.all(
      vendorsNeeded(entry, vendor).map((v) => this.bundle(new URL(entry.vendors[v].bundle, url).href, entry.vendors[v])),
    );
    return { bundles, source: describeSource(entry) };
  }

  private async bundle(url: string, meta: VendorEntry): Promise<string> {
    // Only downloads are cached: bundles shipped with the extension are local already
    // (and Cache Storage rejects chrome-extension:// URLs).
    const cache = /^https?:/.test(url) ? this.cache : undefined;
    const cached = await cache?.get(url);
    if (cached !== undefined && (await sha256Hex(cached)) === meta.sha256) return cached;
    const text = await this.fetchText(url);
    if ((await sha256Hex(text)) !== meta.sha256) throw new ProfileError(`checksum mismatch for ${url}`);
    await cache?.put(url, text);
    return text;
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new ProfileError(`HTTP ${res.status}`);
    return res.text();
  }
}

export function parseCatalog(text: string): Catalog {
  const data = JSON.parse(text) as Catalog;
  if (data?.schema !== CATALOG_SCHEMA || typeof data.slicers !== "object") {
    throw new ProfileError(`unsupported catalog schema ${data?.schema}`);
  }
  return data;
}

/** Cache Storage adapter (extension pages and workers). */
export function cacheStorage(name = "betterbridge-profiles"): TextCache {
  return {
    async get(url) {
      const res = await (await caches.open(name)).match(url);
      return res ? res.text() : undefined;
    },
    async put(url, text) {
      await (await caches.open(name)).put(url, new Response(text, { headers: { "content-type": "application/json" } }));
    },
  };
}
