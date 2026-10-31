// Options page: My printers, profile status, conversion options and a manual "Convert a file".
import { CONFIG } from "../config.ts";
import { Engine } from "../engine/client.ts";
import type { OptionInfo } from "../engine/protocol.ts";
import { localize, t, uiLanguage } from "../lib/i18n.ts";
import { loadSettings, platformKey, saveSettings, type MyPrinter, type Settings } from "../lib/settings.ts";
import { cacheStorage, ProfileStore, type Catalog } from "../profiles/catalog.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STATUS_CLASSES = {
  ok: ["bg-ok-soft", "text-ok"],
  warn: ["bg-warn-soft", "text-warn"],
  error: ["bg-err-soft", "text-err"],
  info: ["bg-surface", "text-muted"],
} as const;

/** Clone of a <template> in options.html, localized; `fields` = its [data-field] elements. */
function fromTemplate(id: string) {
  const node = ($<HTMLTemplateElement>(id).content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  localize(node);
  const field = <T extends HTMLElement = HTMLElement>(name: string) => node.querySelector(`[data-field="${name}"]`) as T;
  return { node, field };
}

const store = new ProfileStore(
  [CONFIG.catalogUrl, chrome.runtime.getURL("profiles/catalog.json")],
  (url) => fetch(url),
  cacheStorage(),
);
const engine = new Engine();
// Slicer preselected when adding the first printer.
const DEFAULT_SLICER = "flashstudio";

let settings: Settings;
let catalog: Catalog | null = null;
let lastDownload: number | null = null;

// --- profiles ---------------------------------------------------------------
// The installed slicer's folders cannot be read from an extension: Chromium blocks
// ~/Library, /Applications and %APPDATA% in the File System Access API. Profiles come
// from the catalog; exact installed profiles and the user's own presets will come
// through the helper app (see docs/architecture.md).
async function bundlesFor(p: MyPrinter): Promise<string[]> {
  return (await store.bundlesFor(p.slicer, p.printer)).bundles;
}

async function loadCatalog() {
  const status = $("profiles-status");
  status.textContent = t("profiles_status_loading");
  try {
    const { catalog: c, url } = await store.catalog();
    catalog = c;
    const sources = Object.values(c.slicers).map((s) => s.source ?? s.name).join(", ");
    status.textContent = url === CONFIG.catalogUrl
      ? t("profiles_status_ready", sources, new Date(c.generated).toLocaleDateString())
      : t("profiles_status_fallback", sources);
  } catch (e) {
    status.textContent = t("profiles_status_error", (e as Error).message);
  }
}

function slicerName(key: string): string {
  return catalog?.slicers[key]?.name ?? key;
}

// --- My printers ------------------------------------------------------------
function renderPrinters() {
  const items = settings.printers.map((p) => {
    const { node, field } = fromTemplate("tpl-printer");
    field("name").textContent = p.printer;
    field("slicer").textContent = slicerName(p.slicer);
    const remove = node.querySelector<HTMLButtonElement>('[data-action="remove"]')!;
    remove.title = remove.ariaLabel = t("printers_remove");
    remove.onclick = () => updatePrinters(settings.printers.filter((x) => x.id !== p.id));
    return node;
  });
  $("printers").replaceChildren(...(items.length ? items : [fromTemplate("tpl-printers-empty").node]));
  // No printer yet: open the add panel so the first step is obvious.
  ($("add-panel") as HTMLDetailsElement).open ||= settings.printers.length === 0;

  const select = $<HTMLSelectElement>("convert-printer");
  const selected = select.value;
  select.replaceChildren(
    ...(settings.printers.length
      ? settings.printers.map((p) => new Option(`${p.printer} · ${slicerName(p.slicer)}`, p.id, false, p.id === selected))
      : [new Option(t("convert_no_printers"), "")]),
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

function printerChoices(slicer: string): { vendor: string; name: string }[] {
  const vendors = catalog?.slicers[slicer]?.vendors ?? {};
  return Object.entries(vendors).flatMap(([vendor, v]) => v.printers.map((p) => ({ vendor, name: p.name })));
}

function renderPrinterChoices() {
  const slicer = $<HTMLSelectElement>("add-slicer").value;
  const filter = $<HTMLInputElement>("add-filter").value.trim().toLowerCase();
  const choices = printerChoices(slicer).filter((p) => !filter || p.name.toLowerCase().includes(filter));
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

/** Profiles of the slicer the project was made with, if the catalog has them (optional). */
async function sourceProfiles(name: string, data: ArrayBuffer): Promise<string[]> {
  try {
    const info = await engine.sourceInfo(name, data);
    if (!info.slicer || !info.printer) return [];
    return (await store.bundlesFor(info.slicer, info.printer)).bundles;
  } catch {
    return []; // only enriches the report: convert without it
  }
}

// --- conversion options (advanced mode) -------------------------------------
let optionInfo: OptionInfo[] | null = null;

function optionValue(o: OptionInfo): boolean | string {
  return settings.options[o.key] ?? o.default;
}

async function setOption(o: OptionInfo, value: boolean | string) {
  const options = { ...settings.options };
  if (value === o.default) delete options[o.key];
  else options[o.key] = value;
  settings.options = options;
  await saveSettings({ options });
  renderOptions();
}

function optionControl(o: OptionInfo): HTMLElement {
  const value = optionValue(o);
  const { node, field } = fromTemplate(o.kind === "bool" ? "tpl-option-bool" : "tpl-option-choice");
  field("label").textContent = o.label;
  field("help").textContent = o.help;
  if (o.kind === "bool") {
    const input = field<HTMLInputElement>("input");
    input.checked = value === true;
    input.onchange = () => void setOption(o, input.checked);
  } else {
    field("choices").replaceChildren(...(o.choices ?? []).map((choice) => {
      const item = fromTemplate("tpl-choice");
      const input = item.field<HTMLInputElement>("input");
      input.name = `option-${o.key}`;
      input.value = choice.value;
      input.checked = value === choice.value;
      input.onchange = () => void setOption(o, choice.value);
      item.field("label").textContent = choice.label;
      return item.node;
    }));
  }
  const warning = field("warning");
  if (o.warning !== undefined && value === o.warn_when) {
    warning.textContent = o.warning;
    warning.hidden = false;
  }
  return node;
}

function renderOptions() {
  const list = $("conversion-options");
  $("mode-basic").ariaChecked = String(!settings.advanced);
  $("mode-advanced").ariaChecked = String(settings.advanced);
  $("conversion-basic").hidden = settings.advanced;
  $("conversion-advanced").hidden = !settings.advanced;
  $("conversion-reset").hidden = Object.keys(settings.options).length === 0;
  if (!settings.advanced) return;
  if (!optionInfo) {
    const loading = document.createElement("li");
    loading.className = "p-5 text-muted";
    loading.textContent = t("conversion_loading");
    list.replaceChildren(loading);
    return;
  }
  list.replaceChildren(...optionInfo.map(optionControl));
}

async function setAdvanced(advanced: boolean) {
  settings.advanced = advanced;
  await saveSettings({ advanced });
  await loadOptions();
}

async function loadOptions() {
  renderOptions();
  if (!settings.advanced || optionInfo) return;
  try {
    optionInfo = await engine.listOptions(uiLanguage());
  } catch (e) {
    const error = document.createElement("li");
    error.className = "p-5 text-err";
    error.textContent = (e as Error).message;
    $("conversion-options").replaceChildren(error);
    return;
  }
  renderOptions();
}

// --- convert a file ----------------------------------------------------------
function showStatus(kind: keyof typeof STATUS_CLASSES, text: string) {
  const el = $("convert-status");
  el.className = ["chip", ...STATUS_CLASSES[kind]].join(" ");
  el.textContent = text;
  $("convert-result").hidden = false;
}

let currentFile: File | null = null;

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function chooseFile(file: File | undefined) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".3mf")) {
    showStatus("warn", t("convert_no_file"));
    return;
  }
  currentFile = file;
  // MakerWorld names use "+" for spaces: "4-colors+Benchy+AMS" → "4-colors Benchy AMS".
  $("file-name").textContent = file.name.replace(/\.3mf$/i, "").replace(/[+_]+/g, " ");
  $("file-detail").textContent = t("convert_file_ready", formatSize(file.size));
  $("convert-result").hidden = true;
}

function wireDropzone() {
  const zone = $("dropzone");
  const input = $<HTMLInputElement>("convert-file");
  input.onchange = () => chooseFile(input.files?.[0]);
  const drag = (on: boolean) => (e: DragEvent) => {
    e.preventDefault();
    zone.dataset.drag = String(on);
  };
  zone.ondragenter = zone.ondragover = drag(true);
  zone.ondragleave = drag(false);
  zone.ondrop = (e) => {
    drag(false)(e);
    chooseFile(e.dataTransfer?.files[0]);
  };
}

function showStats(report: Record<string, unknown> | null) {
  const count = (key: string) => (Array.isArray(report?.[key]) ? (report![key] as unknown[]).length : 0);
  $("convert-stats").hidden = !report;
  if (!report) return;
  $("stat-model").textContent = String(count("kept_author"));
  $("stat-printer").textContent = String(count("changed") + count("source_defaults"));
  $("stat-warnings").textContent = String(count("warnings"));
}

async function convertFile(event: SubmitEvent) {
  event.preventDefault();
  const file = currentFile;
  const printer = settings.printers.find((p) => p.id === $<HTMLSelectElement>("convert-printer").value);
  $("convert-show").hidden = true;
  $("convert-tip").hidden = true;
  lastDownload = null;
  $("convert-report").textContent = "";
  $("convert-stats").hidden = true;
  if (!printer) return showStatus("warn", t("convert_no_printers"));
  if (!file) return showStatus("warn", t("convert_no_file"));

  const button = $<HTMLButtonElement>("convert-button");
  button.disabled = true;
  showStatus("info", t("convert_busy"));
  try {
    const [bundles, platform, data] = await Promise.all([bundlesFor(printer), platformKey(), file.arrayBuffer()]);
    const sourceBundles = await sourceProfiles(file.name, data);
    const res = await engine.convert({
      name: file.name, data, printer: printer.printer, bundles, slicer: printer.slicer, platform, lang: uiLanguage(),
      // Basic mode: the core's defaults, whatever was chosen earlier in advanced mode.
      options: settings.advanced ? settings.options : {},
      sourceBundles,
    });
    $("convert-report").textContent = res.text;
    showStats(res.report);
    if (res.output) {
      const url = URL.createObjectURL(new Blob([res.output.data], { type: "model/3mf" }));
      const id = await chrome.downloads.download({ url, filename: res.output.name, conflictAction: "uniquify" });
      showStatus("info", t("convert_saving", res.output.name));
      // With "Ask where to save each file" the download only finishes once the user
      // picks a folder; the blob must live until then and Finder has nothing to show before.
      const item = await downloadFinished(id);
      URL.revokeObjectURL(url);
      if (item?.state === "complete") {
        lastDownload = id;
        showStatus(res.report && (res.report.warnings as unknown[]).length ? "warn" : "ok",
          t("convert_ok", item.filename.split(/[\\/]/).pop() ?? res.output.name, (res.ms / 1000).toFixed(1)));
        $("convert-show").hidden = false;
        $("convert-tip").hidden = false;
      } else {
        showStatus("warn", t("convert_not_saved"));
      }
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

/** Final state of a download (complete or interrupted, e.g. cancelled in the save dialog). */
function downloadFinished(id: number): Promise<chrome.downloads.DownloadItem | undefined> {
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

async function showInFolder() {
  if (lastDownload === null) return;
  const [item] = await chrome.downloads.search({ id: lastDownload });
  // The file may have been moved or deleted since: open the downloads folder instead.
  if (item?.exists) chrome.downloads.show(lastDownload);
  else chrome.downloads.showDefaultFolder();
}

// --- wiring -----------------------------------------------------------------
async function main() {
  localize();
  settings = await loadSettings();
  await loadCatalog();
  wireDropzone();
  fillSlicerSelect($<HTMLSelectElement>("add-slicer"), settings.printers.at(-1)?.slicer ?? DEFAULT_SLICER);
  renderPrinters();
  void loadOptions();
  renderPrinterChoices();

  $<HTMLSelectElement>("add-slicer").onchange = renderPrinterChoices;
  $<HTMLInputElement>("add-filter").oninput = renderPrinterChoices;
  $<HTMLFormElement>("add-printer").onsubmit = (e) => {
    e.preventDefault();
    const slicer = $<HTMLSelectElement>("add-slicer").value;
    const printer = $<HTMLSelectElement>("add-printer-name").value;
    if (!printer || settings.printers.some((p) => p.slicer === slicer && p.printer === printer)) return;
    void updatePrinters([...settings.printers, { id: crypto.randomUUID(), slicer, printer }]);
    ($("add-panel") as HTMLDetailsElement).open = false;
  };
  $("mode-basic").onclick = () => void setAdvanced(false);
  $("mode-advanced").onclick = () => void setAdvanced(true);
  $("conversion-reset").onclick = async () => {
    settings.options = {};
    await saveSettings({ options: {} });
    renderOptions();
  };
  $<HTMLFormElement>("convert").onsubmit = (e) => void convertFile(e as SubmitEvent);
  $("convert-show").onclick = () => void showInFolder();
}

void main();
