// User settings in chrome.storage.sync (follows the browser profile across devices).

export interface MyPrinter {
  id: string;
  /** Key in core/src/printnomad/data/slicers.json, e.g. "flashstudio". */
  slicer: string;
  /** Machine preset name, e.g. "Flashforge Creator 5 Pro 0.4 nozzle". */
  printer: string;
  /** The slicer was picked by the rule (brand's own / general for all), not by the user. */
  slicerAuto?: boolean;
}

export interface Settings {
  printers: MyPrinter[];
  /** Advanced mode shows the conversion options; basic mode always uses their defaults. */
  advanced: boolean;
  /** Values of the conversion options changed in advanced mode. */
  options: Record<string, boolean | string>;
  /** Use the general slicer (OrcaSlicer) for every printer instead of each brand's own. */
  generalSlicerForAll: boolean;
}

const DEFAULTS: Settings = { printers: [], advanced: false, options: {}, generalSlicerForAll: false };

export async function loadSettings(): Promise<Settings> {
  // Passing the defaults returns them for the keys that were never saved.
  return (await chrome.storage.sync.get({ ...DEFAULTS })) as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/** chrome.runtime platform → platform key of slicers.json. */
export async function platformKey(): Promise<string> {
  const { os } = await chrome.runtime.getPlatformInfo();
  return ({ mac: "macos", win: "windows" } as Record<string, string>)[os] ?? "linux";
}
