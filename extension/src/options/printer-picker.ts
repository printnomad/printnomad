// Printer picker data: catalog presets grouped by printer model.
//
// The catalog lists machine presets ("Flashforge Creator 5 Pro 0.4 nozzle"), one per
// nozzle and slicer. Users think in printer models: a model card holds every preset
// of that model across slicers; the nozzle and slicer are picked afterwards.
import type { Catalog } from "../profiles/catalog.ts";

export interface Variant {
  slicer: string;
  slicerName: string;
  /** Machine preset name, what My printers stores. */
  preset: string;
  nozzle: string;
}

export interface ModelChoice {
  key: string;
  brand: string;
  /** printer_model as in the profiles, e.g. "Flashforge Creator 5 Pro". */
  model: string;
  /** Without the brand when the model starts with it: "Creator 5 Pro". */
  label: string;
  /** Absolute thumbnail URL, if the slicer ships one. */
  cover?: string;
  variants: Variant[];
}

// Pseudo vendors that hold no printers of their own.
const HIDDEN_VENDORS = new Set(["OrcaFilamentLibrary"]);
const DEFAULT_NOZZLE = "0.4";

function stripBrand(model: string, brand: string): string {
  const words = brand.toLowerCase().split(/\s+/);
  const parts = model.split(/\s+/);
  const matches = words.every((w, i) => parts[i]?.toLowerCase() === w);
  return matches && parts.length > words.length ? parts.slice(words.length).join(" ") : model;
}

/** Every printer model of the catalog, sorted by brand then name. */
export function buildModels(catalog: Catalog, catalogUrl: string): ModelChoice[] {
  const models = new Map<string, ModelChoice>();
  for (const [slicer, entry] of Object.entries(catalog.slicers)) {
    for (const [vendor, v] of Object.entries(entry.vendors)) {
      if (HIDDEN_VENDORS.has(vendor)) continue;
      const brand = v.name ?? vendor;
      for (const p of v.printers) {
        const key = `${brand}\u0000${p.model}`;
        let choice = models.get(key);
        if (!choice) {
          choice = { key, brand, model: p.model, label: stripBrand(p.model, brand), variants: [] };
          models.set(key, choice);
        }
        const cover = v.covers?.[p.model];
        if (cover && !choice.cover) choice.cover = new URL(cover, catalogUrl).href;
        choice.variants.push({ slicer, slicerName: entry.name, preset: p.name, nozzle: p.nozzle });
      }
    }
  }
  return [...models.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** Brands with their number of models, most common first. */
export function brands(models: ModelChoice[]): { brand: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.brand, (counts.get(m.brand) ?? 0) + 1);
  return [...counts].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand));
}

/** All words of the query appear in the brand, model or a preset name. */
export function matches(model: ModelChoice, query: string, brand: string | null): boolean {
  if (brand && model.brand !== brand) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [model.brand, model.model, ...model.variants.map((v) => v.preset)].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * Slicers that have the model, best first: the one made for its brand (Flash Studio for
 * Flashforge…), then the general one (OrcaSlicer), then the rest in catalog order.
 * `nozzle` keeps only slicers that offer that nozzle for the model.
 */
export function slicersFor(model: ModelChoice, catalog: Catalog, nozzle?: string): { slicer: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const v of model.variants) if (!nozzle || v.nozzle === nozzle) seen.set(v.slicer, v.slicerName);
  const rank = (s: string) => ((catalog.slicers[s]?.makers ?? []).includes(model.brand) ? 2 : catalog.slicers[s]?.general ? 1 : 0);
  return [...seen].map(([slicer, name]) => ({ slicer, name })).sort((a, b) => rank(b.slicer) - rank(a.slicer));
}

/** The slicer a new printer gets: its brand's, or the general one for every printer when asked. */
export function pickSlicer(model: ModelChoice, catalog: Catalog, generalForAll: boolean, nozzle?: string): string {
  const options = slicersFor(model, catalog, nozzle);
  const general = options.find((o) => catalog.slicers[o.slicer]?.general);
  return (generalForAll && general ? general : options[0]).slicer;
}

/** Nozzles available for the model in a slicer, smallest first; the default is 0.4 when offered. */
export function nozzlesFor(model: ModelChoice, slicer: string): { nozzles: string[]; preferred: string } {
  const nozzles = [...new Set(model.variants.filter((v) => v.slicer === slicer).map((v) => v.nozzle))]
    .sort((a, b) => Number(a) - Number(b));
  return { nozzles, preferred: nozzles.includes(DEFAULT_NOZZLE) ? DEFAULT_NOZZLE : nozzles[0] };
}

/** Every nozzle of the model in any slicer, smallest first; 0.4 preferred. */
export function allNozzles(model: ModelChoice): { nozzles: string[]; preferred: string } {
  const nozzles = [...new Set(model.variants.map((v) => v.nozzle))].sort((a, b) => Number(a) - Number(b));
  return { nozzles, preferred: nozzles.includes(DEFAULT_NOZZLE) ? DEFAULT_NOZZLE : nozzles[0] };
}

export function presetFor(model: ModelChoice, slicer: string, nozzle: string): string | undefined {
  return model.variants.find((v) => v.slicer === slicer && v.nozzle === nozzle)?.preset;
}

/** The model a saved preset belongs to (for its thumbnail in My printers). */
export function modelOfPreset(models: ModelChoice[], slicer: string, preset: string): ModelChoice | undefined {
  return models.find((m) => m.variants.some((v) => v.slicer === slicer && v.preset === preset));
}
