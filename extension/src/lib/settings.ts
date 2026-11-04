// User settings in chrome.storage.sync (follows the browser profile across devices).

export interface MyPrinter {
  id: string;
  /** Key in core/src/printnomad/data/slicers.json, e.g. "flashstudio". */
  slicer: string;
  /** Machine preset name, e.g. "Flashforge Creator 5 Pro 0.4 nozzle". */
  printer: string;
  /** The slicer was picked by the rule (brand's own / general for all), not by the user. */
  slicerAuto?: boolean;
  /** Build plate chosen for this printer (curr_bed_type); absent: the printer's default. */
  bedType?: string;
}

export interface Settings {
  printers: MyPrinter[];
  /** The printer the MakerWorld button and the page name first; absent: the first one. */
  defaultPrinterId?: string;
  /** Conversion options changed from their defaults (DEFAULT_OPTIONS). */
  options: Record<string, boolean | string>;
  /** Use the general slicer (OrcaSlicer) for every printer instead of each brand's own. */
  generalSlicerForAll: boolean;
}

/** The core's defaults (core/src/printnomad/options.py); a test keeps them in step. */
export const DEFAULT_OPTIONS: Record<string, boolean | string> = {
  map_mode: "compatible",
  keep_designer_filament: true,
  keep_designer_cooling: false,
  keep_designer_printer_settings: false,
};

const DEFAULTS: Settings = { printers: [], options: {}, generalSlicerForAll: false };

/**
 * Settings saved by earlier versions, updated. `advanced` is gone: options now always apply.
 * They used to apply only in advanced mode, so with it off they are dropped, and nobody's
 * conversions change. Returns what to write and to remove; nothing when already up to date.
 */
export function migrateSettings(stored: Record<string, unknown>): { set: Partial<Settings>; remove: string[] } {
  if (!("advanced" in stored)) return { set: {}, remove: [] };
  return { set: stored.advanced === true ? {} : { options: {} }, remove: ["advanced"] };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(null);
  const { set, remove } = migrateSettings(stored);
  if (remove.length) {
    await chrome.storage.sync.set(set);
    await chrome.storage.sync.remove(remove);
  }
  for (const key of remove) delete stored[key];
  return { ...DEFAULTS, ...stored, ...set } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/** The default printer: the one chosen, else the first; undefined without printers. */
export function defaultPrinter(settings: Pick<Settings, "printers" | "defaultPrinterId">): MyPrinter | undefined {
  return settings.printers.find((p) => p.id === settings.defaultPrinterId) ?? settings.printers[0];
}

/** chrome.runtime platform → platform key of slicers.json. */
export async function platformKey(): Promise<string> {
  const { os } = await chrome.runtime.getPlatformInfo();
  return ({ mac: "macos", win: "windows" } as Record<string, string>)[os] ?? "linux";
}
