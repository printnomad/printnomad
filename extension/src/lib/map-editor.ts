// Filament → extruder assignment screen, used by the options page and on MakerWorld
// (inside a shadow root). Starts from the core's suggestion (similar colours of the same
// material share an extruder); the user moves filaments between extruders and converts.
import type { AssignmentPlan } from "../engine/protocol.ts";
import { t } from "./i18n.ts";

export interface MapEditorOptions {
  plan: AssignmentPlan;
  printerLabel: string;
  onConvert(map: string): void;
  onCancel(): void;
}

function parseMap(text: string | null): Map<number, number> {
  const out = new Map<number, number>();
  for (const pair of (text ?? "").split(",")) {
    const [f, e] = pair.split(":").map(Number);
    if (f && e) out.set(f, e);
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function swatch(colour: string, size = "size-5"): HTMLElement {
  const dot = el("span", `inline-block ${size} shrink-0 rounded-full ring-1 ring-fg/25`);
  dot.style.background = colour;
  return dot;
}

export function mapEditor({ plan, printerLabel, onConvert, onCancel }: MapEditorOptions): HTMLElement {
  const extruders = Array.from({ length: plan.extruders }, (_, i) => i + 1);
  const used = plan.filaments.filter((f) => f.plates.length);
  const unused = plan.filaments.filter((f) => !f.plates.length);
  const assignment = parseMap(plan.suggestion);
  for (const f of plan.filaments) if (!assignment.has(f.index)) assignment.set(f.index, Math.min(f.index, plan.extruders));

  const root = el("div", "card flex flex-col gap-5 p-5");
  const header = el("div", "flex flex-col gap-1");
  header.append(
    el("h3", "font-display text-xl font-extrabold", t("map_title", used.length, plan.extruders, printerLabel)),
    el("p", "text-sm leading-relaxed text-muted", t("map_hint")),
  );
  const summary = el("div", "grid grid-cols-2 gap-2 sm:grid-cols-4");
  const rows = el("ul", "flex flex-col divide-y divide-line");
  const problem = el("p", "rounded-xl bg-err-soft px-4 py-3 text-sm text-err");
  problem.setAttribute("role", "alert");
  const actions = el("div", "flex flex-wrap justify-end gap-2");
  const cancel = el("button", "btn-ghost", t("map_cancel"));
  const convert = el("button", "btn-primary", t("map_convert"));
  cancel.type = convert.type = "button";
  actions.append(cancel, convert);
  root.append(header, summary, rows);
  if (unused.length) root.append(el("p", "text-xs text-muted", t("map_unused", unused.length)));
  root.append(problem, actions);

  function render() {
    // One card per extruder with the colours it will print.
    summary.replaceChildren(...extruders.map((e) => {
      const card = el("div", "flex flex-col gap-2 rounded-2xl bg-sunken px-3 py-2.5");
      const dots = el("div", "flex flex-wrap gap-1");
      const mine = used.filter((f) => assignment.get(f.index) === e);
      dots.append(...(mine.length ? mine.map((f) => swatch(f.colour, "size-4")) : [el("span", "text-xs text-muted", "—")]));
      card.append(el("span", "eyebrow", t("map_extruder", e)), dots);
      return card;
    }));
    rows.replaceChildren(...used.map((f) => {
      const row = el("li", "flex flex-wrap items-center gap-3 py-2.5");
      const name = el("div", "flex min-w-0 flex-1 items-center gap-2.5");
      const label = el("span", "min-w-0");
      label.append(
        el("span", "block text-sm font-bold", `#${f.index} · ${f.type}`),
        el("span", "block truncate text-xs text-muted", t("map_plates", f.plates.join(", "))),
      );
      name.append(swatch(f.colour), label);
      const choices = el("div", "flex gap-1.5");
      choices.setAttribute("role", "radiogroup");
      choices.append(...extruders.map((e) => {
        const chip = el("button", "chip bg-surface px-3 py-1 text-sm ring-1 ring-line aria-checked:bg-accent aria-checked:text-on-accent aria-checked:ring-accent", `E${e}`);
        chip.type = "button";
        chip.setAttribute("role", "radio");
        chip.ariaChecked = String(assignment.get(f.index) === e);
        chip.title = t("map_extruder", e);
        chip.onclick = () => {
          assignment.set(f.index, e);
          render();
        };
        return chip;
      }));
      row.append(name, choices);
      return row;
    }));
    // One material per extruder: the slicer cannot mix them in one nozzle.
    const mixed = extruders.find((e) => new Set(used.filter((f) => assignment.get(f.index) === e).map((f) => f.type.toUpperCase())).size > 1);
    problem.textContent = mixed ? t("map_mixed", mixed) : "";
    problem.hidden = !mixed;
    convert.disabled = !!mixed;
  }

  cancel.onclick = onCancel;
  convert.onclick = () => onConvert([...assignment].sort(([a], [b]) => a - b).map(([f, e]) => `${f}:${e}`).join(","));
  render();
  return root;
}
