// Conversion shared by the options page and the MakerWorld integration: profiles for a
// printer, the source slicer's profiles, the engine call and saving the result.
import { CONFIG } from "../config.ts";
import { Engine } from "../engine/client.ts";
import type { ConvertResult } from "../engine/protocol.ts";
import { cacheStorage, ProfileStore } from "../profiles/catalog.ts";
import { uiLanguage } from "./i18n.ts";
import type { MyPrinter, Settings } from "./settings.ts";

/** Published catalog first, the copy shipped with the extension as fallback. */
export function createProfileStore(): ProfileStore {
  return new ProfileStore(
    // No published catalog yet (config.json catalogUrl empty): only the shipped copy.
    [CONFIG.catalogUrl, chrome.runtime.getURL("profiles/catalog.json")].filter(Boolean),
    (url) => fetch(url),
    cacheStorage(),
  );
}

export class Converter {
  readonly store: ProfileStore;
  readonly engine: Engine;

  constructor(store: ProfileStore = createProfileStore(), engine: Engine = new Engine()) {
    this.store = store;
    this.engine = engine;
  }

  // The installed slicer's folders cannot be read from an extension: Chromium blocks
  // ~/Library, /Applications and %APPDATA% in the File System Access API. Profiles come
  // from the catalog; exact installed profiles and the user's own presets will come
  // through the helper app (see docs/architecture.md).
  async bundlesFor(printer: MyPrinter): Promise<string[]> {
    return (await this.store.bundlesFor(printer.slicer, printer.printer)).bundles;
  }

  /** Profiles of the slicer the project was made with, if the catalog has them (optional). */
  async sourceProfiles(name: string, data: ArrayBuffer): Promise<string[]> {
    try {
      const info = await this.engine.sourceInfo(name, data);
      if (!info.slicer || !info.printer) return [];
      return (await this.store.bundlesFor(info.slicer, info.printer)).bundles;
    } catch {
      return []; // only enriches the report: convert without it
    }
  }

  /** `data` is copied: the same project can be converted for several printers. */
  async convert(printer: MyPrinter, name: string, data: ArrayBuffer, settings: Settings, platform: string,
    sourceBundles: string[]): Promise<ConvertResult> {
    return this.engine.convert({
      name,
      data: data.slice(0),
      printer: printer.printer,
      bundles: await this.bundlesFor(printer),
      slicer: printer.slicer,
      platform,
      lang: uiLanguage(),
      // Basic mode: the core's defaults, whatever was chosen earlier in advanced mode.
      options: settings.advanced ? settings.options : {},
      sourceBundles,
    });
  }
}

/** Downloads the converted project; resolves when saved (or cancelled in the save dialog). */
export async function saveOutput(output: { name: string; data: ArrayBuffer }) {
  const url = URL.createObjectURL(new Blob([output.data], { type: "model/3mf" }));
  const id = await chrome.downloads.download({ url, filename: output.name, conflictAction: "uniquify" });
  // With "Ask where to save each file" the download only finishes once the user picks a
  // folder; the blob must live until then.
  const item = await downloadFinished(id);
  URL.revokeObjectURL(url);
  return { id, saved: item?.state === "complete", fileName: item?.filename.split(/[\\/]/).pop() ?? output.name };
}

/** Final state of a download (complete or interrupted, e.g. cancelled in the save dialog). */
export function downloadFinished(id: number): Promise<chrome.downloads.DownloadItem | undefined> {
  return new Promise((resolve) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item || item.state !== "in_progress") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(item);
      }
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && delta.state) void check();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    void check();
  });
}

export async function showInFolder(id: number) {
  const [item] = await chrome.downloads.search({ id });
  // The file may have been moved or deleted since: open the downloads folder instead.
  if (item?.exists) chrome.downloads.show(id);
  else chrome.downloads.showDefaultFolder();
}
