// Options page: My printers, profile status, conversion options and a manual "Convert a file".
import { CONFIG } from "../config.ts";
import type { Issue } from "../engine/protocol.ts";
import { localize, t, uiLanguage } from "../lib/i18n.ts";
import { DEFAULT_OPTIONS, loadSettings, platformKey, saveSettings, type MyPrinter, type Settings } from "../lib/settings.ts";
import { Converter, saveOutput, showInFolder } from "../lib/conversion.ts";
import { mapEditor } from "../lib/map-editor.ts";
import { clipboardReport } from "../lib/report-copy.ts";
import { reportPanel } from "../lib/report-panel.ts";
import { sendReport } from "../lib/report-send.ts";
import type { Catalog } from "../profiles/catalog.ts";
import { bedLabel } from "./labels.ts";
import { createOnboarding } from "./onboarding.ts";
import {
  allNozzles,
  buildModels,
  modelOfPreset,
  pickSlicer,
  presetFor,
  printerFromSetup,
  slicersFor,
  supportedOnly,
  withNozzle,
  withSlicer,
  type ModelChoice,
  type Setup,
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

function printerLabel(p: MyPrinter): string {
  return modelOfPreset(models, p.slicer, p.printer)?.label ?? p.printer;
}

function renderPrinters() {
  const items = settings.printers.map((p) => {
    const { node, field } = fromTemplate("tpl-printer");
    const model = modelOfPreset(models, p.slicer, p.printer);
    const editing = editingId === p.id && draft !== null;
    const shownSlicer = editing ? draft!.slicer : p.slicer;
    const shownPreset = editing && model ? presetFor(model, draft!.slicer, draft!.nozzle) : p.printer;
    const variant = model?.variants.find((v) => v.slicer === shownSlicer && v.preset === shownPreset);
    const label = model?.label ?? p.printer;
    const card = field("card");
    card.dataset.editing = String(editing);
    card.ariaLabel = label;
    card.dataset.printer = p.id;
    field("brand").textContent = model?.brand ?? "";
    field("name").textContent = label;
    showCover(field<HTMLImageElement>("cover"), field("placeholder"), model?.cover);

    const bed = (editing ? draft!.bed : p.bedType) ?? variant?.defaultBed;
    const values: Record<string, string> = {
      nozzle: variant ? t("printer_nozzle", variant.nozzle) : "—",
      // Fixed plate without a name in the profile: the slicer's own (rules.FIXED_PLATE_DEFAULT).
      bed: bed ? bedLabel(bed) : variant && variant.bedTypes.length < 2 ? t("printers_bed_fixed") : t("printers_bed_from_project"),
      slicer: slicerName(shownSlicer),
    };
    for (const [name, value] of Object.entries(values)) {
      const shown = node.querySelector(`[data-value="${name}"]`) as HTMLElement;
      shown.textContent = value;
      const select = node.querySelector(`[data-edit="${name}"]`) as HTMLSelectElement;
      select.id = `${p.id}-${name}`;
      select.closest(".card-row")!.querySelector("label")!.htmlFor = select.id;
    }
    if (editing && model && variant) wireEditor(node, p, model, variant);

    const edit = node.querySelector<HTMLButtonElement>('[data-action="edit"]')!;
    edit.textContent = t("printers_edit");
    edit.ariaLabel = t("printers_edit_named", label);
    edit.hidden = editing;
    edit.onclick = () => {
      if (!model || !variant) return;
      editingId = p.id;
      draft = { nozzle: variant.nozzle, slicer: p.slicer, bed: p.bedType };
      renderPrinters();
      document.querySelector<HTMLElement>(`[data-printer="${CSS.escape(p.id)}"] select`)?.focus();
    };
    const remove = node.querySelector<HTMLButtonElement>('[data-action="remove"]')!;
    remove.hidden = !editing;
    remove.onclick = () => void removePrinter(p.id);
    field("edit-actions").hidden = !editing;
    return node;
  });
  const add = fromTemplate("tpl-add-card");
  add.node.querySelector("button")!.onclick = openAddView;
  $("printers").replaceChildren(...items, add.node);

  const select = $<HTMLSelectElement>("convert-printer");
  const selected = select.value || settings.convertPrinterId;
  const options = settings.printers.map((p) =>
    new Option(`${printerLabel(p)} · ${slicerName(p.slicer)}`, p.id, false, p.id === selected));
  // Several printers: converting for all of them (one file each) stays one choice away.
  if (options.length > 1) options.push(new Option(t("convert_all_printers", options.length), ALL_PRINTERS, false, selected === ALL_PRINTERS));
  select.replaceChildren(...(options.length ? options : [new Option(t("convert_no_printers"), "")]));
  select.onchange = () => void saveSettings({ convertPrinterId: select.value });
  renderExamples();
}

async function removePrinter(id: string) {
  editingId = null;
  draft = null;
  await updatePrinters(settings.printers.filter((p) => p.id !== id));
  if (!settings.printers.length) onboarding.start();
}

async function updatePrinters(printers: MyPrinter[]) {
  settings.printers = printers;
  await saveSettings({ printers });
  renderPrinters();
}

// --- first run, adding and editing a printer -----------------------------------------
let editingId: string | null = null;
/** The card being edited: what its selects say, until Save. */
let draft: Setup | null = null;

const onboarding = createOnboarding({
  catalog: () => catalog,
  pickable: () => pickable,
  async save(printer) {
    await updatePrinters([...settings.printers, printer]);
  },
  picked(model) {
    void addPrinter(model);
  },
  showHome,
  sendRequest: CONFIG.reportUrl
    ? (name) => sendReport(CONFIG.reportUrl, { report: `Printer request: ${name}`, version: CONFIG.version })
    : undefined,
});

function showHome(anchor?: string) {
  onboarding.hide();
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

/** Adding a printer has its own screen, under the same header. */
function openAddView() {
  editingId = null;
  draft = null;
  $("home").hidden = true;
  $("home-footer").hidden = true;
  $("add-view").hidden = false;
  onboarding.openPicker($("add-picker"), $("add-request"));
  window.scrollTo(0, 0);
  history.pushState({ adding: true }, "");
  $("picker-search").focus();
}

function closeAddView() {
  if ($("add-view").hidden) return;
  $("add-view").hidden = true;
  $("home").hidden = false;
  $("home-footer").hidden = false;
}

function backToPrinters() {
  closeAddView();
  $("printers-section").scrollIntoView({ behavior: "instant" });
}

/** Added with the model's usual setup, and open to change it right there. */
async function addPrinter(model: ModelChoice) {
  const nozzle = allNozzles(model).preferred;
  const slicer = pickSlicer(model, catalog!, nozzle);
  const printer = printerFromSetup(crypto.randomUUID(), model, catalog!, { nozzle, slicer, bed: undefined });
  if (!printer) return;
  const existing = settings.printers.find((p) => p.printer === printer.printer && p.slicer === printer.slicer);
  const added = existing ?? printer;
  editingId = added.id;
  draft = { nozzle, slicer: added.slicer, bed: added.bedType };
  backToPrinters();
  if (existing) renderPrinters();
  else await updatePrinters([...settings.printers, printer]);
  const card = document.querySelector<HTMLElement>(`[data-printer="${CSS.escape(editingId)}"]`);
  card?.scrollIntoView({ behavior: "instant", block: "center" });
  card?.querySelector("select")?.focus();
}

/** Edit: in the card itself, each value becomes a select; nothing is stored until Save. */
function wireEditor(node: HTMLElement, p: MyPrinter, model: ModelChoice, variant: Variant) {
  const select = (name: string) => node.querySelector(`[data-edit="${name}"]`) as HTMLSelectElement;
  const setup = draft!;
  const change = (next: Setup, focus: string) => {
    draft = next;
    renderPrinters();
    document.querySelector<HTMLElement>(`[data-printer="${CSS.escape(p.id)}"] [data-edit="${focus}"]`)?.focus();
  };
  const show = (name: string, on: boolean) => {
    select(name).hidden = !on;
    (node.querySelector(`[data-value="${name}"]`) as HTMLElement).hidden = on;
  };
  select("nozzle").replaceChildren(...allNozzles(model).nozzles.map((n) =>
    new Option(t("printer_nozzle", n), n, false, n === setup.nozzle)));
  select("nozzle").onchange = () => change(withNozzle(model, catalog!, setup, select("nozzle").value), "nozzle");
  show("nozzle", true);
  const others = slicersFor(model, catalog!, setup.nozzle);
  select("slicer").replaceChildren(...others.map((o) => new Option(o.name, o.slicer, false, o.slicer === setup.slicer)));
  select("slicer").onchange = () => change(withSlicer(model, setup, select("slicer").value), "slicer");
  show("slicer", true);
  // A plate that cannot be chosen stays as text, in the same row.
  if (variant.bedTypes.length > 1) {
    const first = variant.defaultBed ? bedLabel(variant.defaultBed) : t("printers_bed_from_project");
    select("bed").replaceChildren(new Option(first, "", false, !setup.bed), ...variant.bedTypes
      .filter((b) => b !== variant.defaultBed)
      .map((b) => new Option(bedLabel(b), b, false, b === setup.bed)));
    select("bed").onchange = () => change({ ...setup, bed: select("bed").value || undefined }, "bed");
    show("bed", true);
  }
  const printer = printerFromSetup(p.id, model, catalog!, setup);
  const save = node.querySelector<HTMLButtonElement>('[data-action="save"]')!;
  save.disabled = !printer || (printer.printer === p.printer && printer.slicer === p.slicer && printer.bedType === p.bedType);
  save.onclick = async () => {
    if (!printer) return;
    editingId = null;
    draft = null;
    await updatePrinters(settings.printers
      .filter((x) => x.id === p.id || !(x.printer === printer.printer && x.slicer === printer.slicer))
      .map((x) => (x.id === p.id ? printer : x)));
  };
  node.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.onclick = () => {
    editingId = null;
    draft = null;
    renderPrinters();
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
  const printer = settings.printers[0];
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
  $("add-back").onclick = () => history.back();
  // The browser's Back leaves the add screen too, and the header always leads home.
  window.addEventListener("popstate", backToPrinters);
  for (const link of document.querySelectorAll("header a")) link.addEventListener("click", closeAddView);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("add-view").hidden) history.back();
  });
  if (settings.printers.length) showHome();
  else onboarding.start();
  $<HTMLFormElement>("convert-form").onsubmit = (e) => void convertFile(e as SubmitEvent);
}

void main();
