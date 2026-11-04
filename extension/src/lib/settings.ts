// User settings in chrome.storage.sync (follows the browser profile across devices).

export interface MyPrinter {
  id: string;
  /** Key in core/src/printnomad/data/slicers.json, e.g. "flashstudio". */
  slicer: string;
  /** Machine preset name, e.g. "Flashforge Creator 5 Pro 0.4 nozzle". */
  printer: string;
  /** The slicer is the one the rule picks (the brand's own), not another the user chose. */
  slicerAuto?: boolean;
  /** Build plate chosen for this printer (curr_bed_type); absent: the printer's default. */
  bedType?: string;
}

export interface Settings {
  printers: MyPrinter[];
  /** The last choice in "Convert a file" (a printer's id or all of them); absent: the first printer. */
  convertPrinterId?: string;
  /** Conversion options changed from their defaults (DEFAULT_OPTIONS). */
  options: Record<string, boolean | string>;
}

/** The core's defaults (core/src/printnomad/options.py); a test keeps them in step. */
export const DEFAULT_OPTIONS: Record<string, boolean | string> = {
  map_mode: "compatible",
  keep_designer_filament: true,
  keep_designer_cooling: false,
  keep_designer_printer_settings: false,
};

const DEFAULTS: Settings = { printers: [], options: {} };

/**
 * Settings saved by earlier versions, updated; nothing when already up to date.
 * - `advanced` is gone: options now always apply. They used to apply only in advanced mode, so
 *   with it off they are dropped, and nobody's conversions change.
 * - `generalSlicerForAll` is gone: the slicer is chosen per printer, and each printer already
 *   stores the one that switch gave it.
 * - `defaultPrinterId` is gone: on MakerWorld the printer is chosen on the page.
 */
export function migrateSettings(stored: Record<string, unknown>): { set: Partial<Settings>; remove: string[] } {
  const remove = ["advanced", "generalSlicerForAll", "defaultPrinterId"].filter((key) => key in stored);
  return { set: "advanced" in stored && stored.advanced !== true ? { options: {} } : {}, remove };
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

/** chrome.runtime platform → platform key of slicers.json. */
export async function platformKey(): Promise<string> {
  const { os } = await chrome.runtime.getPlatformInfo();
  return ({ mac: "macos", win: "windows" } as Record<string, string>)[os] ?? "linux";
}
