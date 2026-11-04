// Options page: My printers, profile status, conversion options and a manual "Convert a file".
import { CONFIG } from "../config.ts";
import type { Issue, OptionInfo } from "../engine/protocol.ts";
import { localize, t, uiLanguage } from "../lib/i18n.ts";
import { loadSettings, platformKey, saveSettings, type MyPrinter, type Settings } from "../lib/settings.ts";
import { Converter, saveOutput, showInFolder } from "../lib/conversion.ts";
import { mapEditor } from "../lib/map-editor.ts";
import { clipboardReport } from "../lib/report-copy.ts";
import { reportPanel } from "../lib/report-panel.ts";
import { sendReport } from "../lib/report-send.ts";
import type { Catalog } from "../profiles/catalog.ts";
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
const { store, engine } = converter;

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
/** Plate names for people; the values are the slicers' (rules.BED_TYPES in the core). */
function bedLabel(bed: string): string {
  switch (bed) {
    case "Cool Plate": return t("bed_cool_plate");
    case "Engineering Plate": return t("bed_engineering_plate");
    case "High Temp Plate": return t("bed_high_temp_plate");
    case "Textured PEI Plate": return t("bed_textured_pei_plate");
    case "Textured Cool Plate": return t("bed_textured_cool_plate");
    case "Supertack Plate": return t("bed_supertack_plate");
    default: return bed;
  }
}

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

function renderPrinters() {
  const items = settings.printers.map((p) => {
    const { node, field } = fromTemplate("tpl-printer");
    const model = modelOfPreset(models, p.slicer, p.printer);
    const variant = model?.variants.find((v) => v.slicer === p.slicer && v.preset === p.printer);
    field("brand").textContent = model?.brand ?? "";
    field("name").textContent = model?.label ?? p.printer;
    field("nozzle").textContent = variant ? `${t("printer_nozzle", variant.nozzle)} · ${slicerName(p.slicer)}` : p.printer;
    // Other slicers with the same printer and nozzle: change it from the card.
    const others = model && variant ? slicersFor(model, catalog!, variant.nozzle) : [];
    if (settings.advanced && model && variant && others.length > 1) {
      const select = field<HTMLSelectElement>("slicer-select");
      select.replaceChildren(...others.map((o) => new Option(o.name, o.slicer, false, o.slicer === p.slicer)));
      select.title = t("printers_change_slicer");
      select.onchange = () => {
        const preset = presetFor(model, select.value, variant.nozzle);
        if (preset) {
          void replacePrinter(p.id, { ...p, slicer: select.value, printer: preset, slicerAuto: false,
            bedType: keepBed(model, select.value, preset, p.bedType) });
        }
      };
      field("slicer-menu").hidden = false;
    }
    if (variant && variant.bedTypes.length > 1) {
      const select = field<HTMLSelectElement>("bed-select");
      select.replaceChildren(...bedOptions(variant, p.bedType));
      select.title = t("printers_bed");
      select.onchange = () => void replacePrinter(p.id, { ...p, bedType: select.value || undefined });
      field("bed-menu").hidden = false;
    }
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
  const options = settings.printers.map((p) => {
    const label = modelOfPreset(models, p.slicer, p.printer)?.label ?? p.printer;
    return new Option(`${label} · ${slicerName(p.slicer)}`, p.id, false, p.id === selected);
  });
  // Several printers: one click converts for all of them (one file each), the default.
  if (options.length > 1) {
    options.unshift(new Option(t("convert_all_printers", options.length), ALL_PRINTERS, false,
      !selected || selected === ALL_PRINTERS));
  }
  select.replaceChildren(...(options.length ? options : [new Option(t("convert_no_printers"), "")]));
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
  $("advanced-toggle").textContent = settings.advanced ? t("advanced_hide") : t("advanced_show");
  $("advanced-toggle").ariaExpanded = String(settings.advanced);
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
  renderPrinters();
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
  void loadOptions();
  if (!settings.printers.length) openPicker(false);

  $<HTMLInputElement>("picker-search").oninput = renderPicker;
  $("picker-close").onclick = closePicker;
  $("picker-add").onclick = addPickedPrinter;
  const general = $<HTMLInputElement>("general-slicer");
  general.checked = settings.generalSlicerForAll;
  general.onchange = () => void setGeneralSlicerForAll(general.checked);
  $("advanced-toggle").onclick = () => void setAdvanced(!settings.advanced);
  wirePrinterRequest();
  $("conversion-reset").onclick = async () => {
    settings.options = {};
    await saveSettings({ options: {} });
    renderOptions();
  };
  $<HTMLFormElement>("convert").onsubmit = (e) => void convertFile(e as SubmitEvent);
}

void main();
