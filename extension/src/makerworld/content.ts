// MakerWorld integration (content script).
//
// In "Print Files", the printers of My printers that MakerWorld does not list get a chip
// that looks like MakerWorld's own. With one selected, the green button and its menu
// offer "Download for <printer>": MakerWorld's own 3MF download is captured (see
// main-world.ts), converted by the bridge page and saved.
//
// MakerWorld's class names are generated (mw-css-…): elements are found by structure
// (span.primaryButton, .swiper-wrapper, MUI menus) and by "3MF" in menu texts.
import { CONFIG } from "../config.ts";
import type { Issue } from "../engine/protocol.ts";
import { clipboardReport } from "../lib/report-copy.ts";
import { reportPanel } from "../lib/report-panel.ts";
import { normalize, planChips } from "./chips.ts";
import { BRIDGE, CONTENT, type BridgeMessage, type ConvertOutcome, type FromMain, type PagePrinter } from "./protocol.ts";

/** MakerWorld normally asks for the 3MF right after the click: if not, the click did not start it. */
const START_TIMEOUT_MS = 8_000;
/** From MakerWorld's request for the 3MF to its answer. */
const ANSWER_TIMEOUT_MS = 30_000;
/** Downloading the file: no new data for this long and it has stopped. */
const STALL_TIMEOUT_MS = 30_000;
const MENU_TIMEOUT_MS = 4_000;
/** Where 3MF is already the button's action, the menu may not offer it: do not wait long for it. */
const MENU_KNOWN_TIMEOUT_MS = 300;
const RESULT_VISIBLE_MS = 5_000;
/** Next to the core's codes (issues.py): MakerWorld's download could not be captured or fetched. */
const MAKERWORLD_ERROR = "PN903";
const DIVIDER_GAP_PX = 10;

const t = (key: string, ...subs: (string | number)[]) => chrome.i18n.getMessage(key, subs.map(String)) || key;
/** False once the extension is reloaded or updated: this script stays in open tabs, without chrome.* APIs. */
const alive = () => !!chrome.runtime?.id;

interface Section {
  root: HTMLElement;
  wrapper: HTMLElement;
  button: HTMLElement;
  arrow: HTMLElement | null;
}

let printers: PagePrinter[] = [];
let active: PagePrinter | null = null;
let busy = false;
let triggering = false;
const originalButtonText = new WeakMap<HTMLElement, string>();

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
    const wrapper = root?.querySelector<HTMLElement>(".swiper-wrapper");
    if (!root || !wrapper) continue;
    const arrow = button.parentElement?.querySelector<HTMLElement>(".icon-box") ?? null;
    out.push({ root, wrapper, button, arrow });
  }
  return out;
}

const slides = (wrapper: HTMLElement) =>
  [...wrapper.children].filter((c): c is HTMLElement => c.classList.contains("swiper-slide"));
const nativeSlides = (wrapper: HTMLElement) => slides(wrapper).filter((s) => !s.dataset.pnPrinter && !s.dataset.pnDivider);
const chipOf = (slide: HTMLElement) => slide.querySelector<HTMLElement>(":scope > div > div");

// --- chips ----------------------------------------------------------------------
/** A chip of ours for a printer MakerWorld does not list. */
function newChip(printer: PagePrinter, template: HTMLElement): HTMLElement {
  const slide = template.cloneNode(true) as HTMLElement;
  slide.className = "swiper-slide";
  slide.dataset.pnPrinter = printer.id;
  slide.firstElementChild?.classList.remove("first");
  const chip = chipOf(slide);
  if (chip) {
    chip.classList.remove("selected");
    chip.dataset.pnMine = "1";
    chip.textContent = printer.label;
    chip.title = t("mw_chip_title", printer.label);
  }
  slide.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activate(printer);
  });
  return slide;
}

/**
 * The same visible gap on both sides of the line, measured between the chips themselves:
 * their slides have margins and paddings of MakerWorld's. Padding, because Swiper sets the
 * slides' margins. Whether it changed anything: then Swiper has to measure again.
 */
function centerDivider(divider: HTMLElement): boolean {
  const before = divider.previousElementSibling as HTMLElement | null;
  const after = divider.nextElementSibling as HTMLElement | null;
  if (!before || !after) return false;
  const left = (chipOf(before) ?? before).getBoundingClientRect();
  const right = (chipOf(after) ?? after).getBoundingClientRect();
  const box = divider.getBoundingClientRect();
  if (!box.width || !left.width || !right.width) return false; // the copy of the section not shown
  const style = getComputedStyle(divider);
  const paddingLeft = parseFloat(style.paddingLeft);
  const paddingRight = parseFloat(style.paddingRight);
  const wantedLeft = Math.max(0, paddingLeft + DIVIDER_GAP_PX - (box.left + paddingLeft - left.right));
  const wantedRight = Math.max(0, paddingRight + DIVIDER_GAP_PX - (right.left - (box.right - paddingRight)));
  if (Math.abs(wantedLeft - paddingLeft) < 0.5 && Math.abs(wantedRight - paddingRight) < 0.5) return false;
  divider.style.paddingLeft = `${wantedLeft}px`;
  divider.style.paddingRight = `${wantedRight}px`;
  return true;
}

/**
 * The order in the carousel: MakerWorld's "All", my printers (its chips first, then ours),
 * a divider, and the rest of its chips. Slides stay in their parent, so React keeps them.
 */
function injectChips(section: Section) {
  const natives = nativeSlides(section.wrapper);
  const template = natives[1] ?? natives[0];
  if (!template) return;
  const others = natives.slice(1);
  const plan = planChips(others.map((s) => s.textContent ?? ""), printers);
  const mine = plan.mine.map((i) => others[i]);
  let changed = false;

  const wanted = new Set(plan.inject.map((p) => p.id));
  for (const slide of slides(section.wrapper)) {
    if (slide.dataset.pnPrinter && !wanted.has(slide.dataset.pnPrinter)) {
      if (slide.querySelector(".selected")) deactivate();
      slide.remove();
      changed = true;
    }
  }
  const ours = plan.inject.map((printer) =>
    section.wrapper.querySelector<HTMLElement>(`:scope > [data-pn-printer="${CSS.escape(printer.id)}"]`) ?? newChip(printer, template));

  let divider = section.wrapper.querySelector<HTMLElement>(":scope > [data-pn-divider]");
  const showDivider = mine.length + ours.length > 0 && others.length > mine.length;
  if (showDivider && !divider) {
    divider = document.createElement("div");
    divider.className = "swiper-slide";
    divider.dataset.pnDivider = "1";
    divider.setAttribute("aria-hidden", "true");
  } else if (!showDivider && divider) {
    divider.remove();
    divider = null;
    changed = true;
  }

  let after: Element = natives[0];
  for (const slide of [...mine, ...ours, ...(divider ? [divider] : [])]) {
    if (after.nextElementSibling !== slide) {
      after.after(slide);
      changed = true;
    }
    after = slide;
  }
  if (divider && centerDivider(divider)) changed = true;
  for (const slide of natives) {
    const chip = chipOf(slide);
    const isMine = mine.includes(slide);
    if (chip && "pnMine" in chip.dataset !== isMine) {
      if (isMine) chip.dataset.pnMine = "1";
      else delete chip.dataset.pnMine;
      changed = true;
    }
  }
  if (changed) window.postMessage({ source: CONTENT, type: "swiper-update" }, location.origin);
}

function paintSelection(section: Section) {
  for (const slide of slides(section.wrapper)) {
    const chip = chipOf(slide);
    if (!chip) continue;
    const ours = slide.dataset.pnPrinter;
    const selected = chip.classList.contains("selected");
    // Only real changes: writing the class, even with the same value, wakes watchSelection again.
    if (ours && selected !== (ours === active?.id)) chip.classList.toggle("selected");
    else if (!ours && active && selected) {
      chip.classList.remove("selected"); // React keeps "All" selected underneath
      hiddenSelection.add(chip);
    }
  }
}

/** Chips React believes selected, with the class taken off while a printer of ours is active. */
const hiddenSelection = new Set<HTMLElement>();

/** React marks its chips by class: take "All" back before the browser paints it. */
const watchedWrappers = new WeakSet<HTMLElement>();
function watchSelection(section: Section) {
  if (watchedWrappers.has(section.wrapper)) return;
  watchedWrappers.add(section.wrapper);
  new MutationObserver(() => {
    if (alive() && active) paintSelection(section);
  }).observe(section.wrapper, { attributes: true, attributeFilter: ["class"], subtree: true });
}

function activate(printer: PagePrinter) {
  // Show every print profile (MakerWorld filters by its own chip): select its "All" once,
  // in the visible copy of the section (desktop and mobile copies share MakerWorld's
  // state; clicking both starts two route changes and Next.js cancels the first one).
  // Switching between our chips: MakerWorld is already on "All".
  const first = !active;
  active = printer; // before the click: "All" must not show as selected, not even for a moment
  if (first) {
    const section = visibleSection();
    const all = section && chipOf(nativeSlides(section.wrapper)[0]);
    if (all && !all.classList.contains("selected")) nativeClick(all);
  }
  reconcile();
}

/**
 * Back to MakerWorld's own chips. Clicking one React already has selected writes nothing to
 * the page, so that class is ours to give back (`clicked`: the text of the chip clicked; any
 * other click moves the selection itself). Without a click, all of them.
 */
function deactivate(clicked?: string) {
  if (!active) return;
  active = null;
  for (const chip of hiddenSelection) {
    if (clicked === undefined || normalize(chip.textContent) === normalize(clicked)) chip.classList.add("selected");
  }
  hiddenSelection.clear();
  reconcile();
}

// --- green button ---------------------------------------------------------------
function buttonLabel(section: Section): HTMLElement | null {
  return section.button.querySelector<HTMLElement>("span") ?? section.button;
}

/**
 * While working, spinner and status are drawn on a layer of ours over the button, with
 * MakerWorld's own content hidden: whatever it writes there meanwhile is never seen.
 */
function paintBusy(section: Section, label: HTMLElement, text: string) {
  if (!section.button.dataset.pnBusy) {
    // Its size must not follow what MakerWorld writes underneath.
    const { width } = section.button.getBoundingClientRect();
    if (width) section.button.style.width = `${width}px`;
    section.button.dataset.pnBusy = "1";
  }
  let layer = section.button.querySelector<HTMLElement>(":scope > [data-pn-loading]");
  if (!layer) {
    const style = getComputedStyle(label);
    layer = document.createElement("div");
    layer.dataset.pnLoading = "1";
    layer.style.color = style.color;
    layer.style.font = style.font;
    section.button.append(layer);
  }
  if (layer.dataset.pnStatus !== text) {
    layer.dataset.pnStatus = text;
    layer.setAttribute("aria-label", text);
  }
}

function paintButton(section: Section, text?: string, loading = false) {
  const label = buttonLabel(section);
  if (!label) return;
  if (loading) {
    if (!originalButtonText.has(label) && !label.dataset.pnText) originalButtonText.set(label, label.textContent ?? "");
    label.dataset.pnText = "1";
    paintBusy(section, label, text ?? "");
    return;
  }
  section.button.querySelector(":scope > [data-pn-loading]")?.remove();
  if (section.button.dataset.pnBusy) {
    delete section.button.dataset.pnBusy;
    section.button.style.removeProperty("width");
  }
  if (!originalButtonText.has(label) && !label.dataset.pnText) originalButtonText.set(label, label.textContent ?? "");
  const wanted = text ?? (active ? t("mw_download_for", active.label) : null);
  if (wanted === null) {
    if (label.dataset.pnText) {
      label.textContent = originalButtonText.get(label) ?? label.textContent;
      delete label.dataset.pnText;
    }
    return;
  }
  if (label.textContent !== wanted) label.textContent = wanted;
  label.dataset.pnText = "1";
}

let statusText: string | null = null;
let statusLoading = false;

/** Show `text` on the button; texts ending in "…" (work in progress) show a spinner. */
function setStatus(text: string | null, clearAfter = 0) {
  if (!alive()) return;
  statusText = text;
  statusLoading = !!text?.endsWith("…");
  for (const s of sections()) paintButton(s, text ?? undefined, statusLoading);
  if (clearAfter) setTimeout(() => statusText === text && setStatus(null), clearAfter);
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
      && !el.closest("[data-pn-item], span.primaryButton") && isVisible(el);
  });
  if (!leaf) return null;
  let row = leaf;
  while (row.parentElement && row.parentElement !== scope
    && [...row.parentElement.children].filter((c) => isVisible(c)).length === 1) {
    row = row.parentElement;
  }
  return { leaf, row };
}

function decorateMenu() {
  if (!active) return;
  const menu = openMenu(visibleSection());
  const native = menu && find3mf(menu)?.row;
  if (!native?.parentElement || native.parentElement.querySelector(":scope > [data-pn-item]")) return;
  const item = native.cloneNode(true) as HTMLElement;
  item.dataset.pnItem = "1";
  item.removeAttribute("id");
  // Replace the deepest text, keep icons and layout.
  const textHolder = [...item.querySelectorAll<HTMLElement>("*")].reverse()
    .find((el) => el.children.length === 0 && /3mf/i.test(el.textContent ?? "")) ?? item;
  textHolder.textContent = t("mw_download_for", active.label);
  item.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    void closeMenu().then(download);
  }, true);
  native.before(item);
}

// While PrintNomad uses MakerWorld's menu, keep it out of sight: clipped, so it still
// has its size and opacity (our visibility checks) and still takes clicks.
const hideMenus = (() => {
  const style = document.createElement("style");
  style.textContent = `html[data-pn-hiding] :is(${POPUPS}) { clip-path: inset(100%) !important; }
    [data-pn-divider] {
      width: auto !important; height: auto !important; flex: none; align-self: center;
      display: flex; align-items: center; pointer-events: none;
    }
    [data-pn-divider]::before { content: ""; width: 1px; height: 16px; background: #d5d8dc; }
    /* My printers, in PrintNomad's colours and with its mark (drawn here: no image to load). */
    [data-pn-mine] {
      display: inline-flex !important; align-items: center; gap: 6px;
      background-color: #E4F1EE !important; color: #245E53 !important;
    }
    [data-pn-mine]::before {
      content: ""; flex: none; width: 13px; height: 12px;
      background:
        linear-gradient(currentColor, currentColor) center 0 / 5px 2px no-repeat,
        linear-gradient(#00AE42, #00AE42) center 3px / 9px 2px no-repeat,
        linear-gradient(#FA6831, #FA6831) center 6px / 11px 2px no-repeat,
        linear-gradient(#3D8BFD, #3D8BFD) center 9px / 13px 3px no-repeat;
    }
    [data-pn-mine].selected { background-color: #2E7466 !important; color: #fff !important; }
    [data-pn-busy] { position: relative !important; box-sizing: border-box; }
    [data-pn-busy] > :not([data-pn-loading]) { visibility: hidden; }
    [data-pn-loading] {
      position: absolute; inset: 0; pointer-events: none; display: flex; align-items: center; gap: 0.55em;
      padding-left: calc(50% - 4.25em); box-sizing: border-box; /* the same place for every status */
    }
    [data-pn-loading]::before {
      content: ""; flex: none; width: 1.15em; height: 1.15em; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent 10%, currentColor);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.6px), #000 calc(100% - 2px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 2.6px), #000 calc(100% - 2px));
      animation: pn-spin 0.8s linear infinite;
    }
    [data-pn-loading]::after { content: attr(data-pn-status); white-space: nowrap; }
    @keyframes pn-spin { to { transform: rotate(360deg); } }`;
  document.documentElement.append(style);
  return (on: boolean) => {
    if (on) document.documentElement.dataset.pnHiding = "1";
    else delete document.documentElement.dataset.pnHiding;
  };
})();

/** A click MakerWorld handles itself (our capture listener lets it through). */
function nativeClick(target: HTMLElement) {
  triggering = true;
  try {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } finally {
    triggering = false;
  }
}

async function poll<T>(get: () => T | null, timeout: number): Promise<T | null> {
  const started = Date.now();
  for (;;) {
    const value = get();
    if (value || Date.now() - started >= timeout) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Close the menu; MakerWorld usually does it itself after a choice, else toggle the arrow. */
async function closeMenu() {
  const section = visibleSection();
  if (await poll(() => (openMenu(section) ? null : true), 600)) return;
  if (section?.arrow && openMenu(section)) nativeClick(section.arrow);
}

const visibleSection = () => sections().find((s) => isVisible(s.button)) ?? sections()[0];

// --- download for the active printer ---------------------------------------------
function captureF3mf() {
  let markArmed: () => void;
  let markStarted: () => void;
  let stop: (message: string) => void;
  const armed = new Promise<void>((resolve) => (markArmed = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const file = new Promise<{ url?: string; data?: ArrayBuffer; name: string | null }>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function onMessage(e: MessageEvent<FromMain>) {
      if (e.source !== window || e.data?.source !== "printnomad:main") return;
      if (e.data.type === "armed") markArmed();
      else if (e.data.type === "f3mf-started") {
        markStarted();
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(t("mw_error_no_answer"))), ANSWER_TIMEOUT_MS);
      } else if (e.data.type === "f3mf" || e.data.type === "f3mf-file") finish(null, e.data);
      else finish(new Error(downloadError(e.data.status)));
    }
    function finish(error: Error | null, value?: { url?: string; data?: ArrayBuffer; name: string | null }) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      window.postMessage({ source: CONTENT, type: "disarm" }, location.origin);
      if (error) reject(error);
      else resolve(value!);
    }
    stop = (message) => finish(new Error(message));
    window.addEventListener("message", onMessage);
    window.postMessage({ source: CONTENT, type: "arm" }, location.origin);
  });
  /** Whether MakerWorld asked for the 3MF (or already answered) within START_TIMEOUT_MS. */
  const startedInTime = () => Promise.race([
    started.then(() => true),
    file.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), START_TIMEOUT_MS)),
  ]);
  return { armed, file, startedInTime, stop: (message: string) => stop(message) };
}

/** Only MakerWorld refusing the request says anything about the session. */
const downloadError = (status: number) =>
  status === 401 || status === 403 ? t("mw_error_signin", status) : t("mw_error_download", status);

/** The file itself, from MakerWorld's CDN; a download with no new data for a while has stopped. */
async function fetchFile(url: string): Promise<ArrayBuffer> {
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(), STALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(t("mw_error_download", res.status));
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(stall);
      stall = setTimeout(() => abort.abort(), STALL_TIMEOUT_MS);
      chunks.push(value);
      received += value.length;
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return data.buffer;
  } catch (e) {
    // Stalled, or the connection dropped (fetch reports both without a status).
    if (abort.signal.aborted || e instanceof TypeError) throw new Error(t("mw_error_network"));
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

/** Where the menu's 3MF entry was last chosen: there, 3MF is the button's action. */
let threeMfChosenAt: string | null = null;

/**
 * Start MakerWorld's own 3MF download: its button when 3MF is the stored action, else the
 * menu's 3MF entry. Choosing that entry also makes 3MF the button's remembered action: the
 * user's stored preference is put back afterwards, so after a route change (another model,
 * or just a chip) the button does what that preference says again. It is not safe to press.
 */
async function startNativeDownload(section: Section, viaMenu = false) {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ACTION_KEY);
  } catch {
    // storage blocked: nothing to restore
  }
  if (stored === ACTION_3MF && !viaMenu) {
    nativeClick(section.button);
    return;
  }
  const restore = () => {
    hideMenus(false);
    try {
      if (stored === null) localStorage.removeItem(ACTION_KEY);
      else localStorage.setItem(ACTION_KEY, stored);
    } catch {
      // storage blocked
    }
  };
  try {
    hideMenus(true);
    if (!openMenu(section) && section.arrow) nativeClick(section.arrow);
    const entry = await poll(() => {
      const menu = openMenu(section);
      return menu && find3mf(menu);
    }, threeMfChosenAt === location.href ? MENU_KNOWN_TIMEOUT_MS : MENU_TIMEOUT_MS);
    if (entry) {
      nativeClick(entry.leaf);
      threeMfChosenAt = location.href;
    } else {
      // The menu may leave out the action the button already does.
      if (threeMfChosenAt !== location.href) throw new Error(t("mw_error_menu"));
      nativeClick(section.button);
    }
  } catch (e) {
    restore();
    throw e;
  }
  // The download has started: closing the menu must not hold it back.
  void closeMenu().finally(restore);
}

async function download() {
  const printer = active;
  const section = visibleSection();
  if (!printer || !section || busy) return;
  busy = true;
  const started = performance.now();
  setStatus(t("mw_status_downloading"));
  try {
    const capture = captureF3mf();
    await Promise.race([capture.armed, capture.file]);
    await startNativeDownload(section);
    if (!await capture.startedInTime()) {
      // The click did not start it: once more through the menu, which always downloads.
      await startNativeDownload(section, true);
      if (!await capture.startedInTime()) capture.stop(t("mw_error_not_started"));
    }
    const captured = await capture.file;
    const answerMs = Math.round(performance.now() - started);
    const data = captured.data ?? await fetchFile(captured.url!);
    const downloadMs = Math.round(performance.now() - started);
    const megabytes = (data.byteLength / 1e6).toFixed(1);
    // MakerWorld's own name for the file (what its download would save).
    const name = captured.name ?? "model.3mf";
    setStatus(t("mw_status_converting"));
    const outcome = await bridge.call<ConvertOutcome>({ type: "convert", printerId: printer.id, name, data }, [data]);
    console.info(`[PrintNomad] MakerWorld answered in ${answerMs} ms · ${megabytes} MB file in ${downloadMs - answerMs} ms · total ${Math.round(performance.now() - started)} ms`
      + (outcome.status === "saved" ? ` · conversion ${outcome.convertMs} ms` : ""));
    showOutcome(outcome);
  } catch (e) {
    console.warn("[PrintNomad]", e);
    // Most likely MakerWorld changed its page or the download failed: worth reporting.
    const message = e instanceof Error ? e.message : String(e);
    const issue = { code: MAKERWORLD_ERROR, stage: "makerworld", message, suggestion: t("issue_makerworld_suggestion") };
    setStatus(t("mw_status_error_code", issue.code), RESULT_VISIBLE_MS);
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

const outcomeText = (outcome: Exclude<ConvertOutcome, { status: "cancelled" }>) => ({
  saved: outcome.status === "saved" && outcome.checkColours ? t("mw_status_saved_check_colours") : t("mw_status_saved"),
  already: t("mw_status_already"),
  error: t("mw_status_error"),
})[outcome.status];

function showOutcome(outcome: ConvertOutcome) {
  // The user closed the save dialog: nothing to say.
  if (outcome.status === "cancelled") {
    setStatus(null);
    return;
  }
  // The status replaces the button's label: an error shows its code, and the details in a panel.
  const code = outcome.status === "error" ? outcome.issue?.code : undefined;
  setStatus(code ? t("mw_status_error_code", code) : outcomeText(outcome), RESULT_VISIBLE_MS);
  if (outcome.status === "error") {
    console.warn("[PrintNomad]", outcome.message);
    showError(outcome.issue, outcome.report ?? outcome.message);
  }
}

/** A modal over MakerWorld, isolated in a shadow root with the extension's own styles. */
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

// --- wiring -------------------------------------------------------------------------
function reconcile() {
  if (!alive()) return;
  for (const section of sections()) {
    watchSelection(section);
    injectChips(section);
    paintSelection(section);
    paintButton(section, statusText ?? undefined, statusLoading);
  }
}

// Our button replaces MakerWorld's action; native chips switch our mode off.
document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!alive() || !target || triggering || target.closest("[data-pn-item]")) return;
  const slide = target.closest<HTMLElement>(".swiper-slide");
  if (slide && !slide.dataset.pnPrinter && sections().some((s) => s.wrapper.contains(slide))) {
    deactivate(slide.textContent ?? "");
    return;
  }
  if (active && target.closest("span.primaryButton") && !target.closest(".icon-box")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    void download();
  }
}, true);

// Batched with a timer, not requestAnimationFrame: frames pause in background tabs.
let scheduled = false;
const observer = new MutationObserver(() => {
  if (!alive()) {
    observer.disconnect();
    return;
  }
  // MakerWorld rewrites the button's label while downloading: put ours back before the browser
  // paints (observers run first), or its text flashes on the button.
  if (active || statusText) for (const section of sections()) paintButton(section, statusText ?? undefined, statusLoading);
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (!alive()) return;
    reconcile();
    if (!triggering) decorateMenu();
  }, 30);
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

let prepared = false;

async function loadPrinters() {
  printers = await bridge.call<PagePrinter[]>({ type: "printers" });
  if (active && !printers.some((p) => p.id === active!.id)) active = null;
  reconcile();
  // A chip of ours is on the page: get the engine and profiles ready for the click.
  if (!prepared && document.querySelector("[data-pn-printer]")) {
    prepared = true;
    void bridge.call({ type: "prepare" }).catch(() => (prepared = false));
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.printers) void loadPrinters();
});
void loadPrinters();
