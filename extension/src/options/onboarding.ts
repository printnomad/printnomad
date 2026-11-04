// First run (which printer, is this your setup, you're ready) and, with the same screens,
// adding or editing a printer afterwards.
import { t } from "../lib/i18n.ts";
import type { MyPrinter } from "../lib/settings.ts";
import type { Catalog } from "../profiles/catalog.ts";
import { bedLabel } from "./labels.ts";
import {
  allNozzles,
  brandsOf,
  keepBed,
  matches,
  modelOfPreset,
  pickSlicer,
  presetFor,
  slicersFor,
  type ModelChoice,
} from "./printer-picker.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface OnboardingHost {
  catalog(): Catalog | null;
  /** The models offered for new printers. */
  pickable(): ModelChoice[];
  /** Every model, to find a saved printer's. */
  models(): ModelChoice[];
  save(printer: MyPrinter, previousId?: string): Promise<void>;
  remove(id: string): Promise<void>;
  showHome(anchor?: string): void;
  sendRequest?(name: string): Promise<void>;
}

type Mode = "first" | "add" | "edit";

const CHECK = '<path d="M5 12l5 5L20 7"/>';
const svg = (body: string, cls: string, width = 2.4) =>
  `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createOnboarding(host: OnboardingHost) {
  let mode: Mode = "first";
  let editing: MyPrinter | null = null;
  let brand: string | null = null;
  let model: ModelChoice | null = null;
  let nozzle = "";
  let slicer = "";
  let bed: string | undefined;

  function show(step: 1 | 2 | 3) {
    $("onboarding").hidden = false;
    $("home-view").hidden = true;
    $("step-1").hidden = step !== 1;
    $("step-2").hidden = step !== 2;
    $("step-3").hidden = step !== 3;
    $("onboarding-progress").hidden = step === 3 || mode === "edit";
    $("progress-2").classList.toggle("bg-accent", step === 2);
    $("progress-2").classList.toggle("bg-strong", step !== 2);
    $("progress-text").textContent = step === 2 ? t("onboarding_step_2") : t("onboarding_step_1");
    $("onboarding-cancel").hidden = mode === "first" || step === 3;
    window.scrollTo(0, 0);
  }

  // --- step 1 --------------------------------------------------------------------
  function renderStep1() {
    const offered = host.pickable();
    const query = $<HTMLInputElement>("picker-search").value.trim();
    const chip = (label: string, value: string | null) => {
      const button = el("button", "brand-chip", label);
      button.type = "button";
      button.ariaPressed = String(brand === value);
      button.onclick = () => {
        brand = value;
        renderStep1();
      };
      return button;
    };
    $("picker-brands").replaceChildren(chip(t("picker_all"), null), ...brandsOf(offered).map((b) => chip(b, b)));
    const shown = offered.filter((m) => (!brand || m.brand === brand) && matches(m, query));
    $("picker-models").replaceChildren(...shown.map((m) => tile(m)));
    $("picker-empty").hidden = shown.length > 0;
    const next = $<HTMLButtonElement>("step-1-next");
    next.disabled = !model;
    $("step-1-next-label").textContent = model ? t("onboarding_continue_with", model.label) : t("onboarding_continue");
  }

  function tile(m: ModelChoice): HTMLElement {
    const selected = model?.key === m.key;
    const button = el("button", "printer-tile");
    button.type = "button";
    button.ariaPressed = String(selected);
    button.dataset.model = m.model;
    button.onclick = () => {
      model = m;
      renderStep1();
    };
    const picture = el("span", "grid size-[72px] place-items-center rounded-[14px] bg-bg");
    if (m.cover) {
      const img = el("img", "size-[60px] object-contain mix-blend-multiply");
      img.src = m.cover;
      img.alt = "";
      picture.append(img);
    }
    const names = el("span", "flex flex-col items-center gap-0.5");
    names.append(el("span", "text-[15px] font-bold text-fg", m.label), el("span", "text-[13px] text-muted", m.brand));
    button.append(picture, names);
    if (selected) {
      const badge = el("span", "absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-full bg-accent text-white");
      badge.innerHTML = svg(CHECK, "size-3.5", 3);
      button.append(badge);
    }
    return button;
  }

  // --- step 2 --------------------------------------------------------------------
  function variant() {
    return model?.variants.find((v) => v.slicer === slicer && v.nozzle === nozzle);
  }

  function pills(group: string, options: { value: string; label: string }[], current: string, pick: (v: string) => void) {
    const box = $(group);
    box.replaceChildren(...options.map((o) => {
      const pill = el("button", "pill", o.label);
      pill.type = "button";
      pill.setAttribute("role", "radio");
      pill.setAttribute("aria-checked", String(o.value === current));
      pill.dataset.value = o.value;
      pill.tabIndex = o.value === current ? 0 : -1;
      pill.onclick = () => pick(o.value);
      return pill;
    }));
    box.onkeydown = (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const at = options.findIndex((o) => o.value === current);
      pick(options[(at + step + options.length) % options.length].value);
      box.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    };
  }

  function renderStep2() {
    if (!model) return;
    const m = model;
    pills("setup-nozzles", allNozzles(m).nozzles.map((n) => ({ value: n, label: t("printer_nozzle", n) })), nozzle, (n) => {
      nozzle = n;
      if (!presetFor(m, slicer, n)) slicer = pickSlicer(m, host.catalog()!, false, n);
      bed = keepBed(m, slicer, presetFor(m, slicer, n)!, bed);
      renderStep2();
    });
    const current = variant();
    const beds = current?.bedTypes ?? [];
    $("setup-bed-group").hidden = beds.length < 2;
    const fallback = current?.defaultBed;
    const bedChoices = [
      ...(fallback ? [{ value: "", label: bedLabel(fallback) }] : [{ value: "", label: t("printers_bed_from_project") }]),
      ...beds.filter((b) => b !== fallback).map((b) => ({ value: b, label: bedLabel(b) })),
    ];
    pills("setup-beds", bedChoices, bed ?? "", (b) => {
      bed = b || undefined;
      renderStep2();
    });
    pills("setup-slicers", slicersFor(m, host.catalog()!, nozzle).map((s) => ({ value: s.slicer, label: s.name })), slicer, (s) => {
      slicer = s;
      bed = keepBed(m, s, presetFor(m, s, nozzle)!, bed);
      renderStep2();
    });
    const picture = $<HTMLImageElement>("setup-cover");
    picture.hidden = !m.cover;
    if (m.cover) picture.src = m.cover;
    picture.alt = `${m.brand} ${m.label}`;
    $("setup-brand").textContent = m.brand;
    $("setup-name").textContent = m.label;
    const chosenBed = bed ?? fallback;
    $("setup-summary").textContent = [
      t("printer_setup_nozzle", nozzle),
      ...(beds.length > 1 && chosenBed ? [bedLabel(chosenBed)] : []),
      t("setup_for_slicer", current?.slicerName ?? slicer),
    ].join(" · ");
    $("setup-finish-label").textContent = mode === "edit" ? t("setup_save") : t("setup_finish");
    $("setup-remove").hidden = mode !== "edit";
    $("setup-back").textContent = mode === "edit" ? t("onboarding_cancel") : t("onboarding_back");
  }

  function toStep2() {
    if (!model) return;
    nozzle = allNozzles(model).preferred;
    slicer = pickSlicer(model, host.catalog()!, false, nozzle);
    bed = undefined;
    renderStep2();
    show(2);
  }

  async function finish() {
    const preset = model && presetFor(model, slicer, nozzle);
    if (!model || !preset) return;
    const byRule = slicer === pickSlicer(model, host.catalog()!, false, nozzle);
    await host.save({
      id: editing?.id ?? crypto.randomUUID(),
      slicer,
      printer: preset,
      slicerAuto: byRule,
      ...(bed ? { bedType: bed } : {}),
    }, editing?.id);
    if (mode === "first") {
      $("done-button-label").textContent = t("mw_download_for", model.label);
      show(3);
    } else {
      host.showHome();
    }
  }

  // --- wiring --------------------------------------------------------------------
  $<HTMLInputElement>("picker-search").oninput = renderStep1;
  $("step-1-next").onclick = toStep2;
  $("step-2-form").onsubmit = (e) => {
    e.preventDefault();
    void finish();
  };
  $("setup-back").onclick = () => {
    if (mode === "edit") host.showHome();
    else show(1);
  };
  $("setup-remove").onclick = async () => {
    if (!editing) return;
    await host.remove(editing.id);
  };
  $("onboarding-cancel").onclick = () => host.showHome();
  $("done-preferences").onclick = () => host.showHome("prefs");
  const request = $("printer-request");
  $("printer-request-open").onclick = () => {
    request.hidden = false;
    $("printer-request-open").hidden = true;
    $("printer-request-name").focus();
  };
  $("printer-request-prompt").hidden = !host.sendRequest;
  request.onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("printer-request-name");
    const name = input.value.trim();
    if (!name || !host.sendRequest) return;
    const result = $("printer-request-result");
    try {
      await host.sendRequest(name);
      input.value = "";
      result.textContent = t("printer_request_sent");
    } catch {
      result.textContent = t("printer_request_failed");
    }
  };

  return {
    /** Which printer: the first run, or "Add a printer". */
    start(first: boolean) {
      mode = first ? "first" : "add";
      editing = null;
      model = null;
      brand = null;
      $<HTMLInputElement>("picker-search").value = "";
      $("onboarding-subtitle").textContent = first ? t("onboarding_1_hint") : t("onboarding_1_hint_add");
      renderStep1();
      show(1);
    },
    edit(printer: MyPrinter) {
      const found = modelOfPreset(host.models(), printer.slicer, printer.printer);
      if (!found) return;
      const current = found.variants.find((v) => v.slicer === printer.slicer && v.preset === printer.printer);
      mode = "edit";
      editing = printer;
      model = found;
      nozzle = current?.nozzle ?? allNozzles(found).preferred;
      slicer = printer.slicer;
      bed = printer.bedType;
      renderStep2();
      show(2);
    },
    hide() {
      $("onboarding").hidden = true;
      $("home-view").hidden = false;
    },
  };
}
