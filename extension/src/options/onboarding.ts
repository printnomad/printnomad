// First run (which printer, is this your setup, you're ready). The printer picker also adds
// printers afterwards, on its own screen.
import { t } from "../lib/i18n.ts";
import type { MyPrinter } from "../lib/settings.ts";
import type { Catalog } from "../profiles/catalog.ts";
import { bedLabel } from "./labels.ts";
import {
  allNozzles,
  brandsOf,
  matches,
  pickSlicer,
  printerFromSetup,
  slicersFor,
  withNozzle,
  withSlicer,
  type ModelChoice,
  type Setup,
} from "./printer-picker.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface OnboardingHost {
  catalog(): Catalog | null;
  /** The models offered for new printers. */
  pickable(): ModelChoice[];
  save(printer: MyPrinter): Promise<void>;
  /** A model picked on the add screen. */
  picked(model: ModelChoice): void;
  showHome(anchor?: string): void;
  sendRequest?(name: string): Promise<void>;
}

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
  /** On the add screen: a click adds the printer at once. */
  let adding = false;
  let brand: string | null = null;
  let model: ModelChoice | null = null;
  let setup: Setup = { nozzle: "", slicer: "", bed: undefined };

  function show(step: 1 | 2 | 3) {
    $("onboarding").hidden = false;
    $("home-view").hidden = true;
    $("step-1").hidden = step !== 1;
    $("step-2").hidden = step !== 2;
    $("step-3").hidden = step !== 3;
    $("onboarding-progress").hidden = step === 3;
    $("progress-2").classList.toggle("bg-accent", step === 2);
    $("progress-2").classList.toggle("bg-strong", step !== 2);
    $("progress-text").textContent = step === 2 ? t("onboarding_step_2") : t("onboarding_step_1");
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
      if (adding) {
        host.picked(m);
        return;
      }
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
    return model?.variants.find((v) => v.slicer === setup.slicer && v.nozzle === setup.nozzle);
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
    pills("setup-nozzles", allNozzles(m).nozzles.map((n) => ({ value: n, label: t("printer_nozzle", n) })), setup.nozzle, (n) => {
      setup = withNozzle(m, host.catalog()!, setup, n);
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
    pills("setup-beds", bedChoices, setup.bed ?? "", (b) => {
      setup = { ...setup, bed: b || undefined };
      renderStep2();
    });
    pills("setup-slicers", slicersFor(m, host.catalog()!, setup.nozzle).map((s) => ({ value: s.slicer, label: s.name })), setup.slicer, (s) => {
      setup = withSlicer(m, setup, s);
      renderStep2();
    });
    const picture = $<HTMLImageElement>("setup-cover");
    picture.hidden = !m.cover;
    if (m.cover) picture.src = m.cover;
    picture.alt = `${m.brand} ${m.label}`;
    $("setup-brand").textContent = m.brand;
    $("setup-name").textContent = m.label;
    const chosenBed = setup.bed ?? fallback;
    $("setup-summary").textContent = [
      t("printer_setup_nozzle", setup.nozzle),
      ...(beds.length > 1 && chosenBed ? [bedLabel(chosenBed)] : []),
      t("setup_for_slicer", current?.slicerName ?? setup.slicer),
    ].join(" · ");
  }

  function toStep2() {
    if (!model) return;
    const nozzle = allNozzles(model).preferred;
    setup = { nozzle, slicer: pickSlicer(model, host.catalog()!, nozzle), bed: undefined };
    renderStep2();
    show(2);
  }

  async function finish() {
    const printer = model && printerFromSetup(crypto.randomUUID(), model, host.catalog()!, setup);
    if (!model || !printer) return;
    await host.save(printer);
    $("done-button-label").textContent = t("mw_download_for", model.label);
    $("done-chip").textContent = model.label;
    show(3);
  }

  // --- wiring --------------------------------------------------------------------
  $<HTMLInputElement>("picker-search").oninput = renderStep1;
  $("step-1-next").onclick = toStep2;
  $("step-2-form").onsubmit = (e) => {
    e.preventDefault();
    void finish();
  };
  $("setup-back").onclick = () => show(1);
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

  /** Put the picker in `list` and the "not on the list" line in `request`. */
  function placePicker(list: HTMLElement, request: HTMLElement) {
    list.append($("picker-body"));
    request.prepend($("printer-request-prompt"));
  }

  function resetPicker() {
    model = null;
    brand = null;
    $<HTMLInputElement>("picker-search").value = "";
  }

  return {
    /** First run: the three steps, full page. */
    start() {
      adding = false;
      resetPicker();
      placePicker($("step-1-picker"), $("step-1-bar"));
      renderStep1();
      show(1);
    },
    /** The picker on the add screen. */
    openPicker(list: HTMLElement, request: HTMLElement) {
      adding = true;
      resetPicker();
      placePicker(list, request);
      renderStep1();
    },
    hide() {
      $("onboarding").hidden = true;
      $("home-view").hidden = false;
    },
  };
}
