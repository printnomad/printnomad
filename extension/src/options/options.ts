// Options page: My printers, where profiles come from, and a manual "Convert a file".
import { CONFIG } from "../config.ts";
import { Engine } from "../engine/client.ts";
import type { PrinterInfo } from "../engine/protocol.ts";
import { localize, t, uiLanguage } from "../lib/i18n.ts";
import {
  getSlicerFolder,
  loadSettings,
  platformKey,
  saveSettings,
  setSlicerFolder,
  type MyPrinter,
  type ProfileSource,
  type Settings,
} from "../lib/settings.ts";
import { cacheStorage, ProfileStore, type Catalog } from "../profiles/catalog.ts";
import { readSlicerFolder } from "../profiles/local.ts";

// File System Access members Chromium has but TypeScript's DOM types lack.
type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission(opts: { mode: "read" }): Promise<PermissionState>;
  requestPermission(opts: { mode: "read" }): Promise<PermissionState>;
};
declare function showDirectoryPicker(opts?: { id?: string; mode?: "read" }): Promise<FileSystemDirectoryHandle>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STATUS_CLASSES = {
  ok: ["bg-ok-bg", "text-ok-fg"],
  warn: ["bg-warn-bg", "text-warn-fg"],
  error: ["bg-err-bg", "text-err-fg"],
  info: ["bg-surface", "text-muted"],
} as const;

const store = new ProfileStore(
  [CONFIG.catalogUrl, chrome.runtime.getURL("profiles/catalog.json")],
  (url) => fetch(url),
  cacheStorage(),
);
const engine = new Engine();

let settings: Settings;
let catalog: Catalog | null = null;
let localCache: Promise<{ bundles: string[]; printers: PrinterInfo[] }> | null = null;
let lastDownload: number | null = null;

// --- profiles ---------------------------------------------------------------
async function folderHandle(ask: boolean): Promise<FileSystemDirectoryHandle | null> {
  const handle = (await getSlicerFolder()) as PermissionedHandle | undefined;
  if (!handle) return null;
  let state = await handle.queryPermission({ mode: "read" });
  if (state === "prompt" && ask) state = await handle.requestPermission({ mode: "read" });
  return state === "granted" ? handle : null;
}

/** Bundles and printers of the picked slicer folder (read once per page). */
function localProfiles(handle: FileSystemDirectoryHandle) {
  localCache ??= (async () => {
    const bundles = (await readSlicerFolder(handle)).map((b) => JSON.stringify(b));
    return { bundles, printers: await engine.listPrinters(bundles) };
  })();
  localCache.catch(() => (localCache = null));
  return localCache;
}

async function bundlesFor(p: MyPrinter): Promise<string[]> {
  if (settings.profileSource === "local" && p.slicer === settings.localSlicer) {
    const handle = await folderHandle(true);
    if (!handle) throw new Error(t("permission_denied"));
    return (await localProfiles(handle)).bundles;
  }
  return (await store.bundlesFor(p.slicer, p.printer)).bundles;
}

async function loadCatalog() {
  const status = $("profiles-status");
  status.textContent = t("profiles_status_loading");
  try {
    const { catalog: c, url } = await store.catalog();
    catalog = c;
    status.textContent = url === CONFIG.catalogUrl
      ? t("profiles_status_ready", Object.keys(c.slicers).length, new Date(c.generated).toLocaleDateString())
      : t("profiles_status_fallback");
  } catch (e) {
    status.textContent = t("profiles_status_error", (e as Error).message);
  }
}

function slicerName(key: string): string {
  return catalog?.slicers[key]?.name ?? key;
}

// --- My printers ------------------------------------------------------------
function renderPrinters() {
  const list = $("printers");
  list.replaceChildren(
    ...settings.printers.map((p) => {
      const li = document.createElement("li");
      li.className = "flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2";
      const label = document.createElement("div");
      const name = document.createElement("div");
      name.className = "font-medium";
      name.textContent = p.printer;
      const slicer = document.createElement("div");
      slicer.className = "text-xs text-muted";
      slicer.textContent = slicerName(p.slicer);
      label.append(name, slicer);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "rounded-md px-2 py-1 text-xs text-muted hover:bg-err-bg hover:text-err-fg";
      remove.textContent = t("printers_remove");
      remove.onclick = () => updatePrinters(settings.printers.filter((x) => x.id !== p.id));
      li.append(label, remove);
      return li;
    }),
  );
  $("printers-empty").hidden = settings.printers.length > 0;

  const select = $<HTMLSelectElement>("convert-printer");
  select.replaceChildren(
    ...settings.printers.map((p) => new Option(`${p.printer} · ${slicerName(p.slicer)}`, p.id)),
  );
}

async function updatePrinters(printers: MyPrinter[]) {
  settings.printers = printers;
  await saveSettings({ printers });
  renderPrinters();
}

function fillSlicerSelect(select: HTMLSelectElement, selected: string) {
  const keys = Object.keys(catalog?.slicers ?? {});
  if (!keys.includes(selected)) keys.push(selected);
  select.replaceChildren(...keys.map((k) => new Option(slicerName(k), k, false, k === selected)));
}

/** Printers offered for a slicer: from its local folder when that is the source, else the catalog. */
async function printerChoices(slicer: string): Promise<{ vendor: string; name: string }[]> {
  const note = $("local-printers-note");
  note.hidden = true;
  if (settings.profileSource === "local" && slicer === settings.localSlicer) {
    const handle = await folderHandle(false);
    if (handle) {
      const { printers } = await localProfiles(handle);
      note.textContent = t("printers_from_folder", slicerName(slicer));
      note.hidden = false;
      return printers;
    }
  }
  const vendors = catalog?.slicers[slicer]?.vendors ?? {};
  return Object.entries(vendors).flatMap(([vendor, v]) => v.printers.map((p) => ({ vendor, name: p.name })));
}

async function renderPrinterChoices() {
  const slicer = $<HTMLSelectElement>("add-slicer").value;
  const filter = $<HTMLInputElement>("add-filter").value.trim().toLowerCase();
  const choices = (await printerChoices(slicer)).filter((p) => !filter || p.name.toLowerCase().includes(filter));
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const p of choices) {
    if (!groups.has(p.vendor)) {
      const g = document.createElement("optgroup");
      g.label = p.vendor;
      groups.set(p.vendor, g);
    }
    groups.get(p.vendor)!.append(new Option(p.name, p.name));
  }
  $<HTMLSelectElement>("add-printer-name").replaceChildren(...groups.values());
}

// --- profile source -----------------------------------------------------------
function renderSource() {
  document.querySelectorAll<HTMLInputElement>('input[name="profile-source"]').forEach((r) => {
    r.checked = r.value === settings.profileSource;
  });
  $("local-folder").hidden = settings.profileSource !== "local";
  fillSlicerSelect($<HTMLSelectElement>("local-slicer"), settings.localSlicer);
  void getSlicerFolder().then((h) => {
    if (h) $("folder-name").textContent = h.name;
  });
}

async function pickFolder() {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await showDirectoryPicker({ id: "slicer-folder", mode: "read" });
  } catch {
    return; // cancelled
  }
  await setSlicerFolder(handle);
  localCache = null;
  $("folder-name").textContent = handle.name;
  const status = $("profiles-status");
  status.textContent = t("profiles_status_loading");
  try {
    const { printers } = await localProfiles(handle);
    status.textContent = t("profiles_folder_read", handle.name, printers.length);
  } catch (e) {
    status.textContent = t("profiles_status_error", (e as Error).message);
  }
  await renderPrinterChoices();
}

// --- convert a file ----------------------------------------------------------
function showStatus(kind: keyof typeof STATUS_CLASSES, text: string) {
  const el = $("convert-status");
  el.className = ["rounded-md", "px-2", "py-1", ...STATUS_CLASSES[kind]].join(" ");
  el.textContent = text;
  $("convert-result").hidden = false;
}

async function convertFile(event: SubmitEvent) {
  event.preventDefault();
  const file = $<HTMLInputElement>("convert-file").files?.[0];
  const printer = settings.printers.find((p) => p.id === $<HTMLSelectElement>("convert-printer").value);
  $("convert-show").hidden = true;
  $("convert-report").textContent = "";
  if (!printer) return showStatus("warn", t("convert_no_printers"));
  if (!file) return showStatus("warn", t("convert_no_file"));

  const button = $<HTMLButtonElement>("convert-button");
  button.disabled = true;
  showStatus("info", t("convert_busy"));
  try {
    const [bundles, platform, data] = await Promise.all([bundlesFor(printer), platformKey(), file.arrayBuffer()]);
    const res = await engine.convert({
      name: file.name, data, printer: printer.printer, bundles, slicer: printer.slicer, platform, lang: uiLanguage(),
    });
    $("convert-report").textContent = res.text;
    if (res.output) {
      const url = URL.createObjectURL(new Blob([res.output.data], { type: "model/3mf" }));
      lastDownload = await chrome.downloads.download({ url, filename: res.output.name, conflictAction: "uniquify" });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showStatus(res.report && (res.report.warnings as unknown[]).length ? "warn" : "ok",
        t("convert_ok", res.output.name, (res.ms / 1000).toFixed(1)));
      $("convert-show").hidden = false;
    } else {
      showStatus("error", res.needsMap ? t("convert_needs_map") : t("convert_failed"));
      ($("convert-details") as HTMLDetailsElement).open = true;
    }
  } catch (e) {
    showStatus("error", (e as Error).message);
  } finally {
    button.disabled = false;
  }
}

// --- wiring -----------------------------------------------------------------
async function main() {
  localize();
  settings = await loadSettings();
  await loadCatalog();
  fillSlicerSelect($<HTMLSelectElement>("add-slicer"), settings.printers.at(-1)?.slicer ?? settings.localSlicer);
  renderPrinters();
  renderSource();
  await renderPrinterChoices();

  $<HTMLSelectElement>("add-slicer").onchange = () => void renderPrinterChoices();
  $<HTMLInputElement>("add-filter").oninput = () => void renderPrinterChoices();
  $<HTMLFormElement>("add-printer").onsubmit = (e) => {
    e.preventDefault();
    const slicer = $<HTMLSelectElement>("add-slicer").value;
    const printer = $<HTMLSelectElement>("add-printer-name").value;
    if (!printer || settings.printers.some((p) => p.slicer === slicer && p.printer === printer)) return;
    void updatePrinters([...settings.printers, { id: crypto.randomUUID(), slicer, printer }]);
  };
  document.querySelectorAll<HTMLInputElement>('input[name="profile-source"]').forEach((r) => {
    r.onchange = async () => {
      settings.profileSource = r.value as ProfileSource;
      await saveSettings({ profileSource: settings.profileSource });
      renderSource();
      await renderPrinterChoices();
    };
  });
  $<HTMLSelectElement>("local-slicer").onchange = async (e) => {
    settings.localSlicer = (e.target as HTMLSelectElement).value;
    await saveSettings({ localSlicer: settings.localSlicer });
    await renderPrinterChoices();
  };
  $("pick-folder").onclick = () => void pickFolder();
  $<HTMLFormElement>("convert").onsubmit = (e) => void convertFile(e as SubmitEvent);
  $("convert-show").onclick = () => lastDownload !== null && chrome.downloads.show(lastDownload);
}

void main();
