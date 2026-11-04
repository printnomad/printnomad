// Options page: My printers, profile status, conversion options and a manual "Convert a file".
import { CONFIG } from "../config.ts";
import type { Issue } from "../engine/protocol.ts";
import { localize, t, uiLanguage } from "../lib/i18n.ts";
import { DEFAULT_OPTIONS, defaultPrinter, loadSettings, platformKey, saveSettings, type MyPrinter, type Settings } from "../lib/settings.ts";
import { Converter, saveOutput, showInFolder } from "../lib/conversion.ts";
import { mapEditor } from "../lib/map-editor.ts";
import { clipboardReport } from "../lib/report-copy.ts";
import { reportPanel } from "../lib/report-panel.ts";
import { sendReport } from "../lib/report-send.ts";
import type { Catalog } from "../profiles/catalog.ts";
import { bedLabel } from "./labels.ts";
import {
  allNozzles,
  buildModels,
  keepBed,
  matches,
  modelOfPreset,
  pickSlicer,
  presetFor,
  slicersFor,
  supportedOnly,
  type ModelChoice,
  type Variant,
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

const converter = new Converter();
const { store } = converter;

let settings: Settings;
let catalog: Catalog | null = null;
let models: ModelChoice[] = [];
/** What the picker offers; `models` also finds printers saved before the list was shortened. */
let pickable: ModelChoice[] = [];

async function loadCatalog() {
  const status = $("profiles-status");
  status.textContent = t("profiles_status_loading");
  try {
    const { catalog: c, url } = await store.catalog();
    catalog = c;
    models = buildModels(c, url);
    pickable = supportedOnly(models, CONFIG.supportedModels);
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
/** The plate menu of a printer's card: its default first, then what else the slicer offers. */
function bedOptions(variant: Variant, chosen: string | undefined): HTMLOptionElement[] {
  const first = variant.defaultBed
    ? t("printers_bed_default", bedLabel(variant.defaultBed))
    : t("printers_bed_from_project");
  return [
    new Option(first, "", false, !chosen),
    ...variant.bedTypes
      .filter((bed) => bed !== variant.defaultBed)
      .map((bed) => new Option(bedLabel(bed), bed, false, bed === chosen)),
  ];
}

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

/** "0.4 mm nozzle · Flash Studio · Cool Plate" */
function setupLine(p: MyPrinter, variant: Variant | undefined): string {
  const bed = p.bedType ?? variant?.defaultBed;
  return [variant && t("printer_setup_nozzle", variant.nozzle), slicerName(p.slicer), bed && bedLabel(bed)].filter(Boolean).join(" · ");
}

function printerLabel(p: MyPrinter): string {
  return modelOfPreset(models, p.slicer, p.printer)?.label ?? p.printer;
}

function renderPrinters() {
  const fallback = defaultPrinter(settings);
  const items = settings.printers.map((p) => {
    const { node, field } = fromTemplate("tpl-printer");
    const model = modelOfPreset(models, p.slicer, p.printer);
    const variant = model?.variants.find((v) => v.slicer === p.slicer && v.preset === p.printer);
    const isDefault = p.id === fallback?.id;
    field("brand").textContent = model?.brand ?? "";
    field("name").textContent = model?.label ?? p.printer;
    field("setup").textContent = setupLine(p, variant);
    field("default").hidden = !isDefault;
    if (variant && variant.bedTypes.length > 1) {
      const select = field<HTMLSelectElement>("bed-select");
      select.replaceChildren(...bedOptions(variant, p.bedType));
      select.title = t("printers_bed");
      select.onchange = () => void replacePrinter(p.id, { ...p, bedType: select.value || undefined });
      field("bed-menu").hidden = false;
    }
    showCover(field<HTMLImageElement>("cover"), field("placeholder"), model?.cover);
    const makeDefault = node.querySelector<HTMLButtonElement>('[data-action="default"]')!;
    makeDefault.hidden = isDefault;
    makeDefault.onclick = () => void setDefaultPrinter(p.id);
    const remove = node.querySelector<HTMLButtonElement>('[data-action="remove"]')!;
    remove.onclick = () => updatePrinters(settings.printers.filter((x) => x.id !== p.id));
    return node;
  });
  $("printers").replaceChildren(...items);
  $("printers").hidden = !items.length;

  const select = $<HTMLSelectElement>("convert-printer");
  const selected = select.value;
  const ordered = fallback ? [fallback, ...settings.printers.filter((p) => p !== fallback)] : [];
  const options = ordered.map((p) =>
    new Option(`${printerLabel(p)} · ${slicerName(p.slicer)}`, p.id, false, p.id === selected));
  // Several printers: converting for all of them (one file each) stays one choice away.
  if (options.length > 1) options.push(new Option(t("convert_all_printers", options.length), ALL_PRINTERS, false, selected === ALL_PRINTERS));
  select.replaceChildren(...(options.length ? options : [new Option(t("convert_no_printers"), "")]));
  renderHero();
  renderExamples();
}

function renderHero() {
  const printer = defaultPrinter(settings);
  const label = printer ? printerLabel(printer) : "";
  $("hero-action").textContent = t("mw_download_for", label);
  $("hero-default").textContent = t("hero_default", label);
}

async function setDefaultPrinter(id: string) {
  settings.defaultPrinterId = id;
  await saveSettings({ defaultPrinterId: id });
  renderPrinters();
}

async function updatePrinters(printers: MyPrinter[]) {
  settings.printers = printers;
  await saveSettings({ printers });
  renderPrinters();
}

function replacePrinter(id: string, printer: MyPrinter) {
  return updatePrinters(settings.printers.map((p) => (p.id === id ? printer : p)));
}

/** Re-pick the slicer of every printer whose slicer was chosen by the rule. */
async function setGeneralSlicerForAll(on: boolean) {
  settings.generalSlicerForAll = on;
  await saveSettings({ generalSlicerForAll: on });
  await updatePrinters(settings.printers.map((p) => {
    if (p.slicerAuto === false) return p;
    const model = modelOfPreset(models, p.slicer, p.printer);
    const nozzle = model?.variants.find((v) => v.slicer === p.slicer && v.preset === p.printer)?.nozzle;
    if (!model || !nozzle) return p;
    const slicer = pickSlicer(model, catalog!, on, nozzle);
    const preset = presetFor(model, slicer, nozzle);
    return preset ? { ...p, slicer, printer: preset, slicerAuto: true, bedType: keepBed(model, slicer, preset, p.bedType) } : p;
  }));
}

// --- printer picker -----------------------------------------------------------
const picker: { model: ModelChoice | null; slicer: string; nozzle: string } = { model: null, slicer: "", nozzle: "" };

function openPicker(focus = true) {
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

function choiceChip(label: string, checked: boolean, onClick: () => void): HTMLElement {
  const { node } = fromTemplate("tpl-choice-chip");
  node.textContent = label;
  node.ariaChecked = String(checked);
  node.onclick = onClick;
  return node;
}

function selectModel(model: ModelChoice) {
  picker.model = model;
  picker.nozzle = allNozzles(model).preferred;
  picker.slicer = pickSlicer(model, catalog!, settings.generalSlicerForAll, picker.nozzle);
  renderPicker();
}

function renderPicker() {
  const query = $<HTMLInputElement>("picker-search").value.trim();
  const shown = pickable.filter((m) => matches(m, query));
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
  // The slicer is chosen by the rule; it can be changed afterwards on the printer's card.
  $("selection-slicer").textContent = slicerName(picker.slicer);
  $("selection-nozzles").replaceChildren(...allNozzles(model).nozzles.map((nozzle) =>
    choiceChip(t("printer_nozzle", nozzle), nozzle === picker.nozzle, () => {
      picker.nozzle = nozzle;
      picker.slicer = pickSlicer(model, catalog!, settings.generalSlicerForAll, nozzle);
      renderPicker();
    })));
}

function addPickedPrinter() {
  const model = picker.model;
  const preset = model && presetFor(model, picker.slicer, picker.nozzle);
  if (!preset) return;
  if (!settings.printers.some((p) => p.slicer === picker.slicer && p.printer === preset)) {
    void updatePrinters([...settings.printers,
      { id: crypto.randomUUID(), slicer: picker.slicer, printer: preset, slicerAuto: true }]);
  }
  closePicker();
}

/** "My printer is not here": one click, no account, through the report service. */
function wirePrinterRequest() {
  const form = $<HTMLFormElement>("printer-request");
  form.hidden = !CONFIG.reportUrl;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("printer-request-name");
    const name = input.value.trim();
    if (!name) return;
    const result = $("printer-request-result");
    try {
      await sendReport(CONFIG.reportUrl, { report: `Printer request: ${name}`, version: CONFIG.version });
      input.value = "";
      result.textContent = t("printer_request_sent");
    } catch {
      result.textContent = t("printer_request_failed");
    }
  };
}

// --- conversion preferences -----------------------------------------------------
function optionValue(key: string): boolean | string {
  return settings.options[key] ?? DEFAULT_OPTIONS[key];
}

async function setOption(key: string, value: boolean | string) {
  const options = { ...settings.options };
  if (value === DEFAULT_OPTIONS[key]) delete options[key];
  else options[key] = value;
  settings.options = options;
  await saveSettings({ options });
  renderPrefs();
}

const WARNING_OF: Record<string, string> = { keep_designer_cooling: "cooling", keep_designer_printer_settings: "tuning" };
const EXAMPLE_COLOURS = [
  { name: () => t("assign_colour_red"), colour: "#D64541" },
  { name: () => t("assign_colour_white"), colour: "#FFFFFF" },
  { name: () => t("assign_colour_black"), colour: "#222222" },
];

function exampleTarget(mode: string, slot: number): string {
  if (mode === "exact") return t("assign_example_exact", slot);
  if (mode === "slicer") return t("assign_example_slicer", slot);
  return t("assign_example_compatible");
}

function assignLabel(mode: string): string {
  if (mode === "exact") return t("assign_exact");
  if (mode === "slicer") return t("assign_slicer");
  return t("assign_compatible");
}

function renderPrefs() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-option]")) {
    const key = button.dataset.option!;
    const on = optionValue(key) === true;
    button.setAttribute("aria-checked", String(on));
    const row = button.closest("[data-pref]")!;
    const tile = row.querySelector("[data-icon-tile]")!;
    tile.classList.toggle("bg-accent-soft", on);
    tile.classList.toggle("text-accent-strong", on);
    tile.classList.toggle("bg-bg", !on);
    tile.classList.toggle("text-faint", !on);
    const warning = WARNING_OF[key] && row.querySelector<HTMLElement>(`[data-warning="${WARNING_OF[key]}"]`);
    if (warning) warning.hidden = !on;
  }
  const mode = String(optionValue("map_mode"));
  for (const card of document.querySelectorAll<HTMLButtonElement>("[data-map-mode]")) {
    const on = card.dataset.mapMode === mode;
    card.setAttribute("aria-checked", String(on));
    card.tabIndex = on ? 0 : -1;
  }
  $("assign-example-title").textContent = t("assign_example_title", assignLabel(mode));
  $("assign-example").replaceChildren(...EXAMPLE_COLOURS.map((c, i) => {
    const pill = document.createElement("div");
    pill.className = "flex items-center gap-2.5 rounded-full bg-surface py-2 pr-3.5 pl-2 text-sm";
    const dot = document.createElement("span");
    dot.className = "size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)]";
    dot.style.background = c.colour;
    const name = document.createElement("span");
    name.className = "font-semibold";
    name.textContent = c.name();
    const target = document.createElement("span");
    target.className = "text-fg-2";
    target.textContent = `→ ${exampleTarget(mode, i + 1)}`;
    pill.append(dot, name, target);
    return pill;
  }));
}

function renderExamples() {
  const printer = defaultPrinter(settings);
  const title = t("pref_example", printer ? printerLabel(printer) : "", "Bambu Lab A1");
  for (const el of document.querySelectorAll("[data-example-title]")) el.textContent = title;
}

function wirePrefs() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-option]")) {
    button.onclick = () => void setOption(button.dataset.option!, optionValue(button.dataset.option!) !== true);
  }
  const cards = [...document.querySelectorAll<HTMLButtonElement>("[data-map-mode]")];
  for (const [i, card] of cards.entries()) {
    card.onclick = () => void setOption("map_mode", card.dataset.mapMode!);
    // A radio group moves with the arrow keys.
    card.onkeydown = (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = cards[(i + step + cards.length) % cards.length];
      void setOption("map_mode", next.dataset.mapMode!).then(() => next.focus());
    };
  }
}

// --- convert a file ----------------------------------------------------------
function showStatus(kind: keyof typeof STATUS_CLASSES, text: string) {
  const el = $("convert-status");
  el.className = ["chip", "self-start", ...STATUS_CLASSES[kind]].join(" ");
  el.textContent = text;
  el.hidden = false;
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

const ALL_PRINTERS = "*";

async function convertFile(event: SubmitEvent) {
  event.preventDefault();
  const file = currentFile;
  const choice = $<HTMLSelectElement>("convert-printer").value;
  const targets = choice === ALL_PRINTERS ? settings.printers : settings.printers.filter((p) => p.id === choice);
  $("convert-status").hidden = true;
  $("convert-tip").hidden = true;
  $("convert-results").replaceChildren();
  if (!targets.length) return showStatus("warn", t("convert_no_printers"));
  if (!file) return showStatus("warn", t("convert_no_file"));

  const button = $<HTMLButtonElement>("convert-button");
  button.disabled = true;
  $("convert-result").hidden = false;
  try {
    const [platform, data] = await Promise.all([platformKey(), file.arrayBuffer()]);
    const sourceBundles = await converter.sourceProfiles(file.name, data);
    const rows = targets.map((p) => resultRow(p, file.name));
    rows.forEach((row) => row.status("info", t("convert_queued")));
    let saved = false;
    // One after the other: a single Python engine, and one save dialog at a time.
    for (const [i, printer] of targets.entries()) {
      saved = (await convertFor(printer, rows[i], file, data, platform, sourceBundles)) || saved;
    }
    $("convert-tip").hidden = !saved;
  } catch (e) {
    showStatus("error", (e as Error).message);
  } finally {
    button.disabled = false;
  }
}

/** One printer's line in the results: status, stats, report and "Show in Finder". */
function resultRow(printer: MyPrinter, fileName: string) {
  const { node, field } = fromTemplate("tpl-result");
  const model = modelOfPreset(models, printer.slicer, printer.printer);
  field("printer").textContent = `${model?.label ?? printer.printer} · ${slicerName(printer.slicer)}`;
  field("printer").title = fileName;
  showCover(field<HTMLImageElement>("cover"), field("placeholder"), model?.cover);
  $("convert-results").append(node);
  let reportCode: string | undefined;
  const showReport = (text: string) => {
    field("details").hidden = !text;
    if (!text) return field("report-panel").replaceChildren();
    const copied = clipboardReport({
      version: CONFIG.version,
      printer: printer.printer,
      slicer: slicerName(printer.slicer),
      plate: printer.bedType,
      file: fileName,
      browser: navigator.userAgent,
    }, text);
    field("report-panel").replaceChildren(reportPanel({
      text: copied,
      send: CONFIG.reportUrl
        ? (extra) => sendReport(CONFIG.reportUrl, { report: copied, ...extra, code: reportCode, version: CONFIG.version })
        : undefined,
    }));
  };
  const showIssue = (issue: Pick<Issue, "code" | "message" | "suggestion"> | null) => {
    reportCode = issue?.code;
    field("issue").hidden = !issue;
    if (!issue) return;
    field("issue-message").textContent = `${issue.code} · ${issue.message}`;
    field("issue-suggestion").textContent = issue.suggestion;
  };
  const count = (report: Record<string, unknown>, key: string) =>
    (Array.isArray(report[key]) ? (report[key] as unknown[]).length : 0);
  return {
    status(kind: keyof typeof STATUS_CLASSES, text: string) {
      field("status").className = ["chip", "max-w-full", ...STATUS_CLASSES[kind]].join(" ");
      field("status").textContent = text;
    },
    report(text: string, report: Record<string, unknown> | null) {
      showReport(text);
      if (!report) return;
      field("stats").textContent = t("result_stats", count(report, "kept_author"),
        count(report, "changed") + count(report, "source_defaults"), count(report, "warnings"));
      field("stats").hidden = false;
    },
    saved(downloadId: number) {
      const show = field<HTMLButtonElement>("show");
      show.hidden = false;
      show.onclick = () => void showInFolder(downloadId);
    },
    openDetails() {
      (field("details") as HTMLDetailsElement).open = true;
    },
    issue: showIssue,
    /** The engine itself failed: there is no report from the core, only this message. */
    engineFailed(message: string) {
      const issue = { code: ENGINE_ERROR, message, suggestion: t("issue_engine_suggestion") };
      showIssue(issue);
      showReport(`✗ [${issue.code}] ${message}`);
    },
    /** Show (or hide, with null) the filament → extruder assignment screen. */
    map(editor: HTMLElement | null) {
      field("map").replaceChildren(...(editor ? [editor] : []));
      field("map").hidden = !editor;
    },
  };
}

type ResultRow = ReturnType<typeof resultRow>;

/** Next to the core's codes (issues.py): the engine did not start or stopped responding. */
const ENGINE_ERROR = "PN902";

async function convertFor(printer: MyPrinter, row: ResultRow, file: File, data: ArrayBuffer, platform: string,
  sourceBundles: string[], map?: string): Promise<boolean> {
  row.status("info", t("convert_busy"));
  row.map(null);
  row.issue(null);
  try {
    const res = await converter.convert(printer, file.name, data, settings, platform, sourceBundles, map);
    row.report(res.alreadyTarget ? "" : res.text, res.report);
    if (res.alreadyTarget) {
      row.status("info", t("convert_already"));
      return false;
    }
    if (!res.output && res.needsMap && res.plan) {
      // More filaments on a plate than extruders: let the user choose, then convert again.
      row.status("warn", t("convert_choose_extruders"));
      const label = modelOfPreset(models, printer.slicer, printer.printer)?.label ?? printer.printer;
      row.map(mapEditor({
        plan: res.plan,
        printerLabel: label,
        onConvert: (chosen) => void convertFor(printer, row, file, data, platform, sourceBundles, chosen),
        onCancel: () => {
          row.map(null);
          row.status("info", t("convert_not_converted"));
        },
      }));
      return false;
    }
    if (!res.output) {
      row.status("error", res.needsMap ? t("convert_needs_map") : t("convert_failed"));
      row.issue((res.report?.issues as Issue[] | undefined)?.[0] ?? null);
      row.openDetails();
      return false;
    }
    row.status("info", t("convert_saving", res.output.name));
    const download = await saveOutput(res.output);
    if (!download.saved) {
      row.status("warn", t("convert_not_saved"));
      return false;
    }
    row.saved(download.id);
    const warned = res.report && (res.report.warnings as unknown[]).length;
    row.status(warned ? "warn" : "ok", t("convert_ok", download.fileName, (res.ms / 1000).toFixed(1)));
    return true;
  } catch (e) {
    row.status("error", t("convert_failed"));
    row.engineFailed((e as Error).message);
    row.openDetails();
    return false;
  }
}

// --- wiring -----------------------------------------------------------------
async function main() {
  localize();
  settings = await loadSettings();
  await loadCatalog();
  wireDropzone();
  renderPrinters();
  wirePrefs();
  renderPrefs();
  if (!settings.printers.length) openPicker(false);

  $<HTMLInputElement>("picker-search").oninput = renderPicker;
  $("picker-close").onclick = closePicker;
  $("picker-add").onclick = addPickedPrinter;
  $<HTMLFormElement>("convert-form").onsubmit = (e) => void convertFile(e as SubmitEvent);
}

void main();
