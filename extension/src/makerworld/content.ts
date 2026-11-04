// MakerWorld integration (content script).
//
// Near MakerWorld's own download button, a split button: "Download for <default printer>"
// and a menu with the other printers, in a shadow root so neither page breaks the other.
// MakerWorld's own 3MF download is captured (see main-world.ts), converted by the bridge
// page and saved; the button itself shows the progress.
//
// MakerWorld's class names are generated (mw-css-…): elements are found by structure
// (span.primaryButton, .swiper-wrapper, MUI menus) and by "3MF" in menu texts.
import { CONFIG } from "../config.ts";
import type { AssignmentPlan, Issue } from "../engine/protocol.ts";
import { mapEditor } from "../lib/map-editor.ts";
import { clipboardReport } from "../lib/report-copy.ts";
import { reportPanel } from "../lib/report-panel.ts";
import { BRIDGE, CONTENT, type BridgeMessage, type ConvertOutcome, type FromMain, type PagePrinter, type PageState } from "./protocol.ts";

const CAPTURE_TIMEOUT_MS = 30_000;
const MENU_TIMEOUT_MS = 4_000;
const RESULT_VISIBLE_MS = 5_000;
const SAVED_VISIBLE_MS = 12_000;
/** Next to the core's codes (issues.py): MakerWorld's download could not be captured or fetched. */
const MAKERWORLD_ERROR = "PN903";

const t = (key: string, ...subs: (string | number)[]) => chrome.i18n.getMessage(key, subs.map(String)) || key;

interface Section {
  root: HTMLElement;
  button: HTMLElement;
  arrow: HTMLElement | null;
}

let state: PageState = { printers: [], defaultId: null, keeps: [] };
let busy = false;

// --- bridge (engine iframe) ---------------------------------------------------
const bridge = (() => {
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("bridge.html");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  const origin = new URL(frame.src).origin;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let nextId = 1;
  let markReady: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  window.addEventListener("message", (e: MessageEvent<BridgeMessage>) => {
    if (e.origin !== origin || e.source !== frame.contentWindow || e.data?.source !== BRIDGE) return;
    const msg = e.data;
    if ("type" in msg) {
      markReady();
      return;
    }
    const job = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) job?.resolve(msg.result);
    else job?.reject(new Error(msg.error));
  });
  document.documentElement.append(frame);
  return {
    async call<T>(request: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
      await ready;
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        frame.contentWindow!.postMessage({ ...request, source: CONTENT, id }, origin, transfer);
      });
    },
  };
})();

// --- finding MakerWorld's pieces ----------------------------------------------
function sections(): Section[] {
  const out: Section[] = [];
  for (const button of document.querySelectorAll<HTMLElement>("span.primaryButton")) {
    let root: HTMLElement | null = button;
    for (let i = 0; i < 12 && root && !root.querySelector(".swiper-wrapper"); i++) root = root.parentElement;
    if (!root?.querySelector(".swiper-wrapper")) continue;
    const arrow = button.parentElement?.querySelector<HTMLElement>(".icon-box") ?? null;
    out.push({ root, button, arrow });
  }
  return out;
}

// --- menu -------------------------------------------------------------------------
// MakerWorld's download menu is a floating MUI element anchored right below the green
// button, as wide as it; hidden copies (opacity 0, visibility hidden) stay in the page.
// Approach from makerworld-to-snapmaker-u1: find it by position, then its 3MF entry by
// text (any language).
const POPUPS = ".MuiPopper-root, .MuiPopover-root, .MuiMenu-root, [role='tooltip'], [role='menu'], [role='listbox']";
// MakerWorld remembers the last download action (e.g. "download_3mf") here.
const ACTION_KEY = "model_operate_last_key";
const ACTION_3MF = "download_3mf";

function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  }
  return true;
}

/** The open download menu: a visible popup anchored right below the button's control. */
function openMenu(section: Section | undefined): HTMLElement | null {
  const anchor = section?.button.parentElement?.getBoundingClientRect();
  const popups = [...document.querySelectorAll<HTMLElement>(POPUPS)].filter((p) => !section?.root.contains(p) && isVisible(p));
  const below = anchor && popups.find((p) => {
    const r = p.getBoundingClientRect();
    return Math.abs(r.top - anchor.bottom) <= 24 && Math.abs(r.left - anchor.left) <= 16 && Math.abs(r.right - anchor.right) <= 16;
  });
  return below ?? popups.find((p) => !!find3mf(p)) ?? null;
}

/**
 * The visible "…3MF…" entry inside `scope`: `leaf` is the innermost element with the
 * text (clicks on it reach MakerWorld's handler wherever it sits), `row` the whole
 * entry — the highest ancestor that is still alone, just below the list of entries.
 */
function find3mf(scope: ParentNode): { leaf: HTMLElement; row: HTMLElement } | null {
  // Cheap text test first; layout (visibility) only for the few matches.
  const leaf = [...scope.querySelectorAll<HTMLElement>("li, a, button, [role='menuitem'], div, span")].find((el) => {
    const text = el.textContent?.trim() ?? "";
    return text.length < 40 && /\b3mf\b/i.test(text)
      && ![...el.children].some((c) => /3mf/i.test(c.textContent ?? ""))
      && !el.closest("span.primaryButton") && isVisible(el);
  });
  if (!leaf) return null;
  let row = leaf;
  while (row.parentElement && row.parentElement !== scope
    && [...row.parentElement.children].filter((c) => isVisible(c)).length === 1) {
    row = row.parentElement;
  }
  return { leaf, row };
}

// While PrintNomad uses MakerWorld's menu, keep it out of sight: clipped, so it still
// has its size and opacity (our visibility checks) and still takes clicks.
const hideMenus = (() => {
  const style = document.createElement("style");
  style.textContent = `html[data-pn-hiding] :is(${POPUPS}) { clip-path: inset(100%) !important; }`;
  document.documentElement.append(style);
  return (on: boolean) => {
    if (on) document.documentElement.dataset.pnHiding = "1";
    else delete document.documentElement.dataset.pnHiding;
  };
})();

function nativeClick(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

async function poll<T>(get: () => T | null, timeout: number): Promise<T | null> {
  const started = Date.now();
  for (;;) {
    const value = get();
    if (value || Date.now() - started >= timeout) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Close the menu; MakerWorld usually does it itself after a choice, else toggle the arrow. */
async function closeMenu() {
  const section = visibleSection();
  if (await poll(() => (openMenu(section) ? null : true), 600)) return;
  if (section?.arrow && openMenu(section)) nativeClick(section.arrow);
}

const visibleSection = () => sections().find((s) => isVisible(s.button)) ?? sections()[0];

// --- download -------------------------------------------------------------------
function captureF3mf() {
  let markArmed: () => void;
  const armed = new Promise<void>((resolve) => (markArmed = resolve));
  const file = new Promise<{ url?: string; data?: ArrayBuffer; name: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(t("mw_error_timeout"))), CAPTURE_TIMEOUT_MS);
    function onMessage(e: MessageEvent<FromMain>) {
      if (e.source !== window || e.data?.source !== "printnomad:main") return;
      if (e.data.type === "armed") markArmed();
      else if (e.data.type === "f3mf" || e.data.type === "f3mf-file") finish(null, e.data);
      else finish(new Error(t("mw_error_download", e.data.status)));
    }
    function finish(error: Error | null, value?: { url?: string; data?: ArrayBuffer; name: string | null }) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      window.postMessage({ source: CONTENT, type: "disarm" }, location.origin);
      if (error) reject(error);
      else resolve(value!);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: CONTENT, type: "arm" }, location.origin);
  });
  return { armed, file };
}

let threeMfSelectedThisPage = false;

/**
 * Start MakerWorld's own 3MF download: its button when 3MF is already its action, else
 * the menu's 3MF entry. Choosing that entry also makes 3MF the button's remembered
 * action: the user's stored preference is put back afterwards.
 */
async function startNativeDownload(section: Section) {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ACTION_KEY);
  } catch {
    // storage blocked: nothing to restore
  }
  try {
    if (stored === ACTION_3MF || threeMfSelectedThisPage) {
      nativeClick(section.button);
      return;
    }
    hideMenus(true);
    if (!openMenu(section) && section.arrow) nativeClick(section.arrow);
    const entry = await poll(() => {
      const menu = openMenu(section);
      return menu && find3mf(menu);
    }, MENU_TIMEOUT_MS);
    if (!entry) throw new Error(t("mw_error_menu"));
    nativeClick(entry.leaf);
    threeMfSelectedThisPage = true;
    await closeMenu();
  } finally {
    hideMenus(false);
    try {
      if (stored === null) localStorage.removeItem(ACTION_KEY);
      else localStorage.setItem(ACTION_KEY, stored);
    } catch {
      // storage blocked
    }
  }
}

/** The 3MF behind MakerWorld's signed URL, reporting how much has arrived. */
async function fetchWithProgress(url: string, onProgress: (share: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t("mw_error_download", res.status));
  const total = Number(res.headers.get("content-length"));
  if (!total || !res.body) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 1));
  }
  const data = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return data.buffer;
}

async function download(printer: PagePrinter) {
  const section = visibleSection();
  if (!section || busy) return;
  busy = true;
  closeOurMenu();
  const started = performance.now();
  setStatus({ kind: "working", text: t("mw_status_downloading") });
  try {
    const capture = captureF3mf();
    await Promise.race([capture.armed, capture.file]);
    await startNativeDownload(section);
    const captured = await capture.file;
    const data = captured.data ?? await fetchWithProgress(captured.url!, (share) =>
      setStatus({ kind: "working", text: t("mw_status_downloading_percent", Math.round(share * 100)), percent: share * 100 }));
    const downloadMs = Math.round(performance.now() - started);
    // MakerWorld's own name for the file (what its download would save).
    const name = captured.name ?? "model.3mf";
    setStatus({ kind: "working", text: t("mw_status_converting", printer.label) });
    const outcome = await bridge.call<ConvertOutcome>({ type: "convert", printerId: printer.id, name, data }, [data]);
    console.info(`[PrintNomad] 3MF from MakerWorld ${downloadMs} ms · total ${Math.round(performance.now() - started)} ms`
      + (outcome.status === "saved" ? ` · conversion ${outcome.convertMs} ms` : ""));
    await showOutcome(printer, outcome);
  } catch (e) {
    console.warn("[PrintNomad]", e);
    // Most likely MakerWorld changed its page or the download failed: worth reporting.
    const message = e instanceof Error ? e.message : String(e);
    const issue = { code: MAKERWORLD_ERROR, stage: "makerworld", message, suggestion: t("issue_makerworld_suggestion") };
    setStatus({ kind: "note", text: t("mw_status_error_code", issue.code) }, RESULT_VISIBLE_MS);
    showError(issue, clipboardReport({
      version: CONFIG.version,
      printer: printer.label,
      slicer: printer.slicer,
      file: location.pathname,
      browser: navigator.userAgent,
    }, `✗ [${issue.code}] ${message}`));
  } finally {
    busy = false;
  }
}

async function showOutcome(printer: PagePrinter, outcome: ConvertOutcome) {
  switch (outcome.status) {
    case "needs-map": {
      setStatus({ kind: "ready" });
      const map = await askAssignment(printer, outcome.plan);
      if (!map) return;
      setStatus({ kind: "working", text: t("mw_status_converting", printer.label) });
      // The bridge kept the project: converting again does not download it again.
      await showOutcome(printer, await bridge.call<ConvertOutcome>({ type: "convert", printerId: printer.id, map }));
      return;
    }
    case "saved":
      setStatus({ kind: "saved", downloadId: outcome.downloadId, notes: outcome.notes }, SAVED_VISIBLE_MS);
      return;
    case "cancelled":
      setStatus({ kind: "note", text: t("mw_status_cancelled") }, RESULT_VISIBLE_MS);
      return;
    case "already":
      setStatus({ kind: "note", text: t("mw_status_already") }, RESULT_VISIBLE_MS);
      return;
    case "error":
      setStatus({ kind: "note", text: outcome.issue ? t("mw_status_error_code", outcome.issue.code) : t("mw_status_error") }, RESULT_VISIBLE_MS);
      console.warn("[PrintNomad]", outcome.message);
      showError(outcome.issue, outcome.report ?? outcome.message);
  }
}

/**
 * The assignment screen in a modal over MakerWorld, isolated in a shadow root with the
 * extension's own styles. Resolves with the chosen map, or null when cancelled.
 */
function openModal(onClose: () => void) {
  const host = document.createElement("div");
  host.dataset.pnModal = "1";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("styles.css");
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/50 p-4 font-sans text-fg";
  const panel = document.createElement("div");
  panel.className = "max-h-[90vh] w-full max-w-2xl overflow-auto rounded-3xl bg-bg p-2 shadow-2xl";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    onClose();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey, true);
  overlay.append(panel);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  shadow.append(style, overlay);
  document.documentElement.append(host);
  return { panel, close };
}

function askAssignment(printer: PagePrinter, plan: AssignmentPlan): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const { panel, close } = openModal(() => resolve(chosen));
    panel.append(mapEditor({
      plan,
      printerLabel: printer.label,
      onConvert: (map) => {
        chosen = map;
        close();
      },
      onCancel: close,
    }));
  });
}

/** Why it failed and what to do, with the report to copy or send. */
function showError(issue: Pick<Issue, "code" | "message" | "suggestion"> | undefined, report: string) {
  const { panel, close } = openModal(() => {});
  const card = document.createElement("div");
  card.className = "card flex flex-col gap-3 p-5";
  const title = document.createElement("h3");
  title.className = "font-display text-xl font-extrabold";
  title.textContent = t("mw_error_title");
  card.append(title);
  if (issue) {
    const box = document.createElement("div");
    box.className = "flex flex-col gap-1 rounded-xl bg-err-soft p-3 text-sm";
    const message = document.createElement("span");
    message.className = "font-semibold text-err";
    message.textContent = `${issue.code} · ${issue.message}`;
    const suggestion = document.createElement("span");
    suggestion.textContent = issue.suggestion;
    box.append(message, suggestion);
    card.append(box);
  }
  const send = CONFIG.reportUrl
    ? (extra: { comment: string; contact: string }) => bridge.call<void>({ type: "send-report", report, ...extra, code: issue?.code })
    : undefined;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "btn-ghost self-end";
  closeButton.dataset.field = "close";
  closeButton.textContent = t("report_close");
  closeButton.onclick = close;
  card.append(reportPanel({ text: report, send, collapsed: true }), closeButton);
  panel.append(card);
}

// --- our button -----------------------------------------------------------------------
// What the button shows; every copy (MakerWorld renders desktop and mobile sections) shows the same.
type Status =
  | { kind: "ready" }
  /** `percent`: known progress; without it, a bar that only says work is going on. */
  | { kind: "working"; text: string; percent?: number }
  | { kind: "saved"; downloadId: number; notes: string[] }
  | { kind: "note"; text: string };

let status: Status = { kind: "ready" };
let menuOpen = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(next: Status, clearAfter = 0) {
  clearTimeout(statusTimer);
  status = next;
  renderButtons();
  if (clearAfter) statusTimer = setTimeout(() => setStatus({ kind: "ready" }), clearAfter);
}

function closeOurMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  renderButtons();
}

const ICON_DOWNLOAD = '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/>';
const ICON_CHEVRON = '<path d="M6 9l6 6 6-6"/>';
const ICON_CHECK = '<path d="M5 12l5 5L20 7"/>';
const LOGO = '<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M11 6h2" stroke="#FFFFFF"/><path d="M9.5 9h5" stroke="#00AE42"/><path d="M8 12h8" stroke="#FA6831"/><path d="M6.5 15h4.5M13 15h4.5" stroke="#3D8BFD"/><path d="M5 18h5.5M13.5 18h5.5" stroke="#1FB5A0"/></svg>';

function icon(body: string, cls: string, width = 2.2) {
  const holder = document.createElement("span");
  holder.className = "inline-flex shrink-0";
  holder.innerHTML = `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return holder;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function defaultOf(): PagePrinter | undefined {
  return state.printers.find((p) => p.id === state.defaultId) ?? state.printers[0];
}

const openOptions = () => void chrome.runtime.sendMessage({ type: "open-options" });

function mainButton(printer: PagePrinter, chevron: HTMLButtonElement | null): HTMLElement {
  const row = el("div", "flex w-fit max-w-full items-stretch overflow-hidden rounded-[var(--pn-r-inner)] shadow-[var(--pn-ring)]");
  if (status.kind === "working") {
    const bar = el("div", "relative flex min-h-[52px] w-[360px] max-w-full items-center overflow-hidden bg-[#DCEBE7] px-5");
    bar.setAttribute("role", "status");
    const fill = el("div", `absolute inset-y-0 left-0 bg-[#BFDDD5] ${status.percent === undefined ? "w-1/3 animate-pulse" : ""}`);
    if (status.percent !== undefined) fill.style.width = `${status.percent}%`;
    bar.append(fill, el("span", "relative truncate text-base font-bold text-[#183F37]", status.text));
    row.append(bar);
    return row;
  }
  const button = el("button", "flex min-h-[52px] cursor-pointer items-center gap-2.5 border-0 px-5 text-base font-bold text-white");
  button.type = "button";
  button.dataset.pnMain = "1";
  if (status.kind === "saved") {
    const { downloadId } = status;
    button.classList.add("bg-dark");
    button.append(icon(ICON_CHECK, "size-5 text-mint", 2.6), el("span", "", t("mw_saved_show")));
    button.onclick = () => void bridge.call({ type: "show-download", downloadId });
    row.append(button);
    return row;
  }
  button.classList.add("bg-accent", "hover:bg-accent-strong");
  if (status.kind === "note") {
    button.append(el("span", "", status.text));
    button.onclick = () => setStatus({ kind: "ready" });
    row.append(button);
    return row;
  }
  button.append(icon(ICON_DOWNLOAD, "size-5"), el("span", "", t("mw_download_for", printer.label)));
  button.onclick = () => void download(printer);
  row.append(button);
  if (chevron) row.append(chevron);
  return row;
}

function menu(): HTMLElement {
  const box = el("div", "absolute top-16 left-0 z-[2147483000] flex w-[340px] max-w-full flex-col rounded-[14px] bg-surface p-2 shadow-[var(--pn-shadow-menu)]");
  box.setAttribute("role", "menu");
  box.append(el("div", "px-3 py-2 text-xs font-bold tracking-[1px] text-muted uppercase", t("mw_menu_title")));
  const fallback = defaultOf();
  for (const printer of state.printers) {
    const isDefault = printer.id === fallback?.id;
    const item = el("button", `flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-[10px] border-0 px-3 text-left hover:bg-bg ${isDefault ? "bg-accent-tint" : "bg-surface"}`);
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.dataset.pnPrinter = printer.id;
    const names = el("span", "flex min-w-0 flex-col");
    names.append(el("span", "text-[15px] font-semibold text-fg", printer.label), el("span", "text-xs text-muted", printer.setup));
    item.append(names);
    if (isDefault) item.append(icon(ICON_CHECK, "size-[18px] text-accent", 2.6));
    item.onclick = () => void download(printer);
    box.append(item);
  }
  box.append(el("div", "mx-1 my-1.5 h-px bg-line-soft"));
  const manage = el("button", "flex min-h-11 cursor-pointer items-center rounded-[10px] border-0 bg-transparent px-3 text-left text-sm font-semibold text-accent-strong hover:bg-bg", t("mw_menu_manage"));
  manage.type = "button";
  manage.setAttribute("role", "menuitem");
  manage.onclick = () => {
    closeOurMenu();
    openOptions();
  };
  box.append(manage);
  return box;
}

function metaLine(printer: PagePrinter): HTMLElement {
  const line = el("div", "flex flex-wrap items-center gap-1.5 text-[13px] text-muted");
  const logo = el("span", "inline-grid size-5 place-items-center rounded-md bg-dark");
  logo.innerHTML = LOGO;
  const keeps = state.keeps.map((k) => (k === "filament" ? t("mw_keep_filament") : k === "cooling" ? t("mw_keep_cooling") : t("mw_keep_tuning")));
  const preferences = el("button", "inline-flex min-h-11 cursor-pointer items-center border-0 bg-transparent p-0 font-semibold text-accent-strong underline", t("mw_meta_preferences"));
  preferences.type = "button";
  preferences.onclick = openOptions;
  line.append(logo, el("span", "", ["PrintNomad", printer.slicerName, keeps.length ? t("mw_meta_keeps", keeps.join(", ")) : t("mw_meta_keeps_none")].join(" · ")),
    el("span", "", "·"), preferences);
  return line;
}

function renderButton(shadowContent: HTMLElement, printer: PagePrinter) {
  let chevron: HTMLButtonElement | null = null;
  if (status.kind === "ready") {
    chevron = el("button", "flex w-12 shrink-0 cursor-pointer items-center justify-center border-0 border-l border-[#4F9686] bg-accent text-white hover:bg-accent-strong");
    chevron.type = "button";
    chevron.ariaLabel = t("mw_choose_printer");
    chevron.ariaHasPopup = "menu";
    chevron.ariaExpanded = String(menuOpen);
    chevron.dataset.pnChevron = "1";
    chevron.append(icon(ICON_CHEVRON, "size-[18px]", 2.4));
    chevron.onclick = () => {
      menuOpen = !menuOpen;
      renderButtons();
    };
  }
  const children: HTMLElement[] = [mainButton(printer, chevron)];
  if (status.kind === "saved" && status.notes.length) {
    children.push(el("div", "text-[13px] text-muted", status.notes.join(" · ")));
  }
  children.push(metaLine(printer));
  if (menuOpen && status.kind === "ready") children.push(menu());
  shadowContent.replaceChildren(...children);
}

const hosts = new Map<HTMLElement, HTMLElement>();

/** Our button just above MakerWorld's own, in each copy of the section. */
function ensureHost(section: Section): HTMLElement | null {
  const anchor = section.button.parentElement;
  if (!anchor?.parentElement) return null;
  let host = anchor.parentElement.querySelector<HTMLElement>(":scope > [data-pn-button]");
  if (!host) {
    host = document.createElement("div");
    host.dataset.pnButton = "1";
    // Its own row, whatever layout MakerWorld gives its buttons.
    host.style.cssText = "display:block;width:100%;flex-basis:100%;margin-bottom:12px;position:relative;z-index:10";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = chrome.runtime.getURL("styles.css");
    const content = el("div", "relative flex flex-col gap-2.5 font-sans text-base text-fg");
    // No flash of unstyled text while the stylesheet loads.
    content.style.visibility = "hidden";
    style.onload = () => (content.style.visibility = "");
    shadow.append(style, content);
    hosts.set(host, content);
    anchor.before(host);
  }
  return hosts.get(host) ?? null;
}

function renderButtons() {
  const printer = defaultOf();
  if (!printer) {
    for (const host of document.querySelectorAll("[data-pn-button]")) host.remove();
    return;
  }
  for (const section of sections()) {
    const content = ensureHost(section);
    if (content) renderButton(content, printer);
  }
}

// --- wiring -------------------------------------------------------------------------
// A click outside closes our menu (inside a shadow root, the target seen here is the host).
document.addEventListener("click", (e) => {
  if (menuOpen && !(e.target as Element | null)?.closest?.("[data-pn-button]")) closeOurMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOurMenu();
}, true);

// React re-renders can remove our button. Batched with a timer, not requestAnimationFrame:
// frames pause in background tabs. Changes inside our shadow roots are not seen here.
let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (sections().some((s) => !s.button.parentElement?.parentElement?.querySelector(":scope > [data-pn-button]"))) renderButtons();
  }, 30);
}).observe(document.documentElement, { childList: true, subtree: true });

let prepared = false;

async function loadPrinters() {
  state = await bridge.call<PageState>({ type: "printers" });
  renderButtons();
  // Our button is on the page: get the engine and profiles ready for the click.
  if (!prepared && state.printers.length && document.querySelector("[data-pn-button]")) {
    prepared = true;
    void bridge.call({ type: "prepare" }).catch(() => (prepared = false));
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.printers || changes.defaultPrinterId || changes.options) void loadPrinters();
});
void loadPrinters();
