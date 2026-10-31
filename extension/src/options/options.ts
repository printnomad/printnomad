// Options page: My printers, profile status, conversion options and a manual "Convert a file".
import { CONFIG } from "../config.ts";
import { Engine } from "../engine/client.ts";
import type { OptionInfo } from "../engine/protocol.ts";
import { localize, t, uiLanguage } from "../lib/i18n.ts";
import { loadSettings, platformKey, saveSettings, type MyPrinter, type Settings } from "../lib/settings.ts";
import { cacheStorage, ProfileStore, type Catalog } from "../profiles/catalog.ts";
import {
  brands,
  buildModels,
  matches,
  modelOfPreset,
  nozzlesFor,
  presetFor,
  slicersFor,
  type ModelChoice,
} from "./printer-picker.ts";

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

let settings: Settings;
let catalog: Catalog | null = null;
let models: ModelChoice[] = [];
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
    models = buildModels(c, url);
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
function showCover(img: HTMLImageElement, placeholder: HTMLElement, url: string | undefined) {
  if (url) {
    img.src = url;
    img.onerror = () => {
      img.hidden = true;
      placeholder.hidden = false;
    };
  } else {
    img.hidden = true;
    placeholder.hidden = false;
  }
}

function renderPrinters() {
  const items = settings.printers.map((p) => {
    const { node, field } = fromTemplate("tpl-printer");
    const model = modelOfPreset(models, p.slicer, p.printer);
    const variant = model?.variants.find((v) => v.slicer === p.slicer && v.preset === p.printer);
    field("brand").textContent = model?.brand ?? "";
    field("name").textContent = model?.label ?? p.printer;
    field("nozzle").textContent = variant ? t("printer_nozzle", variant.nozzle) : p.printer;
    field("slicer").textContent = slicerName(p.slicer);
    showCover(field<HTMLImageElement>("cover"), field("placeholder"), model?.cover);
    const remove = node.querySelector<HTMLButtonElement>('[data-action="remove"]')!;
    remove.title = remove.ariaLabel = t("printers_remove");
    remove.onclick = () => updatePrinters(settings.printers.filter((x) => x.id !== p.id));
    return node;
  });
  const add = fromTemplate("tpl-add-card");
  add.node.querySelector("button")!.onclick = () => openPicker();
  $("printers").replaceChildren(...items, add.node);

  const select = $<HTMLSelectElement>("convert-printer");
  const selected = select.value;
  select.replaceChildren(
    ...(settings.printers.length
      ? settings.printers.map((p) => {
          const label = modelOfPreset(models, p.slicer, p.printer)?.label ?? p.printer;
          return new Option(`${label} · ${slicerName(p.slicer)}`, p.id, false, p.id === selected);
        })
      : [new Option(t("convert_no_printers"), "")]),
  );
}

async function updatePrinters(printers: MyPrinter[]) {
  settings.printers = printers;
  await saveSettings({ printers });
  renderPrinters();
}

// --- printer picker -----------------------------------------------------------
type BrandFilter = { kind: "featured" } | { kind: "all" } | { kind: "brand"; brand: string };
const picker: { filter: BrandFilter; model: ModelChoice | null; slicer: string; nozzle: string } = {
  filter: { kind: "featured" },
  model: null,
  slicer: "",
  nozzle: "",
};

function featuredModels(): ModelChoice[] {
  const featured = new Set(CONFIG.featuredModels);
  return models.filter((m) => featured.has(m.model));
}

function openPicker(focus = true) {
  // With nothing featured in this catalog, start with every model.
  picker.filter = featuredModels().length ? { kind: "featured" } : { kind: "all" };
  picker.model = null;
  $<HTMLInputElement>("picker-search").value = "";
  $("add-panel").hidden = false;
  renderPicker();
  // Opened by itself on load: do not scroll the page to it.
  if (focus) $("picker-search").focus();
}

function closePicker() {
  $("add-panel").hidden = true;
}

function filterChip(label: string, pressed: boolean, onClick: () => void): HTMLElement {
  const { node } = fromTemplate("tpl-filter-chip");
  node.textContent = label;
  node.ariaPressed = String(pressed);
  node.onclick = onClick;
  return node;
}

function choiceChip(label: string, checked: boolean, onClick: () => void): HTMLElement {
  const { node } = fromTemplate("tpl-choice-chip");
  node.textContent = label;
  node.ariaChecked = String(checked);
  node.onclick = onClick;
  return node;
}

function selectModel(model: ModelChoice) {
  picker.model = model;
  picker.slicer = slicersFor(model, catalog!)[0].slicer;
  picker.nozzle = nozzlesFor(model, picker.slicer).preferred;
  renderPicker();
}

function renderPicker() {
  const query = $<HTMLInputElement>("picker-search").value.trim();
  const f = picker.filter;
  const setFilter = (filter: BrandFilter) => () => {
    picker.filter = filter;
    renderPicker();
  };
  const chips = [];
  if (featuredModels().length) chips.push(filterChip(t("picker_featured"), f.kind === "featured" && !query, setFilter({ kind: "featured" })));
  chips.push(filterChip(t("picker_all", models.length), f.kind === "all" || (f.kind === "featured" && !!query), setFilter({ kind: "all" })));
  for (const { brand } of brands(models)) {
    chips.push(filterChip(brand, f.kind === "brand" && f.brand === brand, setFilter({ kind: "brand", brand })));
  }
  $("picker-brands").replaceChildren(...chips);

  // Typing searches every model, unless a brand is chosen.
  const pool = f.kind === "featured" && !query ? featuredModels() : models;
  const shown = pool.filter((m) => matches(m, query, f.kind === "brand" ? f.brand : null));
  $("picker-models").replaceChildren(...shown.map((m) => {
    const { node, field } = fromTemplate("tpl-model");
    const button = node.querySelector("button")!;
    button.ariaPressed = String(picker.model?.key === m.key);
    button.onclick = () => selectModel(m);
    field("label").textContent = m.label;
    field("brand").textContent = m.brand;
    showCover(field<HTMLImageElement>("cover"), field("placeholder"), m.cover);
    return node;
  }));
  $("picker-empty").hidden = shown.length > 0;

  const model = picker.model;
  $("picker-selection").hidden = !model;
  if (!model) return;
  $("selection-brand").textContent = model.brand;
  $("selection-label").textContent = model.label;
  const cover = $<HTMLImageElement>("selection-cover");
  cover.hidden = !model.cover;
  if (model.cover) cover.src = model.cover;
  $("selection-slicers").replaceChildren(...slicersFor(model, catalog!).map(({ slicer, name }) =>
    choiceChip(name, slicer === picker.slicer, () => {
      picker.slicer = slicer;
      const { nozzles, preferred } = nozzlesFor(model, slicer);
      if (!nozzles.includes(picker.nozzle)) picker.nozzle = preferred;
      renderPicker();
    })));
  $("selection-nozzles").replaceChildren(...nozzlesFor(model, picker.slicer).nozzles.map((nozzle) =>
    choiceChip(t("printer_nozzle", nozzle), nozzle === picker.nozzle, () => {
      picker.nozzle = nozzle;
      renderPicker();
    })));
}

function addPickedPrinter() {
  const model = picker.model;
  const preset = model && presetFor(model, picker.slicer, picker.nozzle);
  if (!preset) return;
  if (!settings.printers.some((p) => p.slicer === picker.slicer && p.printer === preset)) {
    void updatePrinters([...settings.printers, { id: crypto.randomUUID(), slicer: picker.slicer, printer: preset }]);
  }
  closePicker();
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
  renderPrinters();
  void loadOptions();
  if (!settings.printers.length) openPicker(false);

  $<HTMLInputElement>("picker-search").oninput = renderPicker;
  $("picker-close").onclick = closePicker;
  $("picker-add").onclick = addPickedPrinter;
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
