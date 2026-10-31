// MakerWorld integration (content script).
//
// In "Print Files", the printers of My printers that MakerWorld does not list get a chip
// that looks like MakerWorld's own. With one selected, the green button and its menu
// offer "Download for <printer>": MakerWorld's own 3MF download is captured (see
// main-world.ts), converted by the bridge page and saved.
//
// MakerWorld's class names are generated (mw-css-…): elements are found by structure
// (span.primaryButton, .swiper-wrapper, MUI menus) and by "3MF" in menu texts.
import { BRIDGE, CONTENT, type BridgeMessage, type ConvertOutcome, type FromMain, type PagePrinter } from "./protocol.ts";

const CAPTURE_TIMEOUT_MS = 30_000;
const MENU_TIMEOUT_MS = 4_000;
const RESULT_VISIBLE_MS = 5_000;

const t = (key: string, ...subs: (string | number)[]) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const normalize = (text: string | null | undefined) => (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

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
const nativeSlides = (wrapper: HTMLElement) => slides(wrapper).filter((s) => !s.dataset.bbPrinter);
const chipOf = (slide: HTMLElement) => slide.querySelector<HTMLElement>(":scope > div > div");

/** My printers that MakerWorld has no chip for (it already lists its own printers). */
function missingPrinters(wrapper: HTMLElement): PagePrinter[] {
  const listed = new Set(nativeSlides(wrapper).map((s) => normalize(s.textContent)));
  return printers.filter((p) => !listed.has(normalize(p.label)));
}

// --- chips ----------------------------------------------------------------------
function injectChips(section: Section) {
  const natives = nativeSlides(section.wrapper);
  const template = natives[1] ?? natives[0];
  if (!template) return;
  let changed = false;
  let after: Element = natives[0];
  for (const printer of missingPrinters(section.wrapper)) {
    let slide = section.wrapper.querySelector<HTMLElement>(`:scope > [data-bb-printer="${CSS.escape(printer.id)}"]`);
    if (!slide) {
      slide = template.cloneNode(true) as HTMLElement;
      slide.className = "swiper-slide";
      slide.dataset.bbPrinter = printer.id;
      slide.firstElementChild?.classList.remove("first");
      const chip = chipOf(slide);
      if (chip) {
        chip.classList.remove("selected");
        chip.textContent = printer.label;
        chip.title = t("mw_chip_title", printer.label);
      }
      slide.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        activate(printer);
      });
      changed = true;
    }
    if (after.nextElementSibling !== slide) {
      after.after(slide);
      changed = true;
    }
    after = slide;
  }
  if (changed) window.postMessage({ source: CONTENT, type: "swiper-update" }, location.origin);
}

function paintSelection(section: Section) {
  for (const slide of slides(section.wrapper)) {
    const chip = chipOf(slide);
    if (!chip) continue;
    const ours = slide.dataset.bbPrinter;
    if (ours) chip.classList.toggle("selected", ours === active?.id);
    else if (active) chip.classList.remove("selected"); // React keeps "All" selected underneath
  }
}

function activate(printer: PagePrinter) {
  // Show every print profile (MakerWorld filters by its own chip): select its "All" once,
  // in the visible copy of the section (desktop and mobile copies share MakerWorld's
  // state; clicking both starts two route changes and Next.js cancels the first one).
  // Switching between our chips: MakerWorld is already on "All".
  if (!active) {
    const section = visibleSection();
    const all = section && chipOf(nativeSlides(section.wrapper)[0]);
    if (all && !all.classList.contains("selected")) nativeClick(all);
  }
  active = printer;
  reconcile();
}

function deactivate() {
  if (!active) return;
  active = null;
  reconcile();
}

// --- green button ---------------------------------------------------------------
function buttonLabel(section: Section): HTMLElement | null {
  return section.button.querySelector<HTMLElement>("span") ?? section.button;
}

function paintButton(section: Section, text?: string, loading = false) {
  const label = buttonLabel(section);
  if (!label) return;
  // Work in progress: a spinner instead of the text (kept for screen readers and as tooltip).
  if (loading) {
    if (!originalButtonText.has(label) && !label.dataset.bbText) originalButtonText.set(label, label.textContent ?? "");
    if (label.textContent) label.textContent = "";
    label.dataset.bbText = "1";
    label.dataset.bbLoading = "1";
    label.setAttribute("aria-label", text ?? "");
    label.title = text ?? "";
    return;
  }
  if (label.dataset.bbLoading) {
    delete label.dataset.bbLoading;
    label.removeAttribute("aria-label");
    label.removeAttribute("title");
  }
  if (!originalButtonText.has(label) && !label.dataset.bbText) originalButtonText.set(label, label.textContent ?? "");
  const wanted = text ?? (active ? t("mw_download_for", active.label) : null);
  if (wanted === null) {
    if (label.dataset.bbText) {
      label.textContent = originalButtonText.get(label) ?? label.textContent;
      delete label.dataset.bbText;
    }
    return;
  }
  if (label.textContent !== wanted) label.textContent = wanted;
  label.dataset.bbText = "1";
}

let statusText: string | null = null;
let statusLoading = false;

/** Show `text` on the button; texts ending in "…" (work in progress) show a spinner. */
function setStatus(text: string | null, clearAfter = 0) {
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
      && !el.closest("[data-bb-item], span.primaryButton") && isVisible(el);
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
  if (!native?.parentElement || native.parentElement.querySelector(":scope > [data-bb-item]")) return;
  const item = native.cloneNode(true) as HTMLElement;
  item.dataset.bbItem = "1";
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

// While BetterBridge uses MakerWorld's menu, keep it out of sight: clipped, so it still
// has its size and opacity (our visibility checks) and still takes clicks.
const hideMenus = (() => {
  const style = document.createElement("style");
  style.textContent = `html[data-bb-hiding] :is(${POPUPS}) { clip-path: inset(100%) !important; }
    [data-bb-loading]::after {
      content: ""; display: inline-block; width: 1.1em; height: 1.1em; vertical-align: -0.2em;
      border: 2.5px solid currentColor; border-right-color: transparent; border-radius: 50%;
      animation: bb-spin 0.7s linear infinite;
    }
    @keyframes bb-spin { to { transform: rotate(360deg); } }`;
  document.documentElement.append(style);
  return (on: boolean) => {
    if (on) document.documentElement.dataset.bbHiding = "1";
    else delete document.documentElement.dataset.bbHiding;
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

// --- download for the active printer ---------------------------------------------
function captureF3mf() {
  let markArmed: () => void;
  const armed = new Promise<void>((resolve) => (markArmed = resolve));
  const file = new Promise<{ url?: string; data?: ArrayBuffer; name: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(t("mw_error_timeout"))), CAPTURE_TIMEOUT_MS);
    function onMessage(e: MessageEvent<FromMain>) {
      if (e.source !== window || e.data?.source !== "betterbridge:main") return;
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
    const captured = await capture.file;
    let data = captured.data;
    if (!data) {
      const res = await fetch(captured.url!);
      if (!res.ok) throw new Error(t("mw_error_download", res.status));
      data = await res.arrayBuffer();
    }
    const downloadMs = Math.round(performance.now() - started);
    // MakerWorld's own name for the file (what its download would save).
    const name = captured.name ?? "model.3mf";
    setStatus(t("mw_status_converting", printer.label));
    const outcome = await bridge.call<ConvertOutcome>({ type: "convert", printerId: printer.id, name, data }, [data]);
    console.info(`[BetterBridge] 3MF from MakerWorld ${downloadMs} ms · total ${Math.round(performance.now() - started)} ms`
      + (outcome.status === "saved" ? ` · conversion ${outcome.convertMs} ms` : ""));
    const messages: Record<ConvertOutcome["status"], string> = {
      saved: t("mw_status_saved"),
      cancelled: t("mw_status_cancelled"),
      already: t("mw_status_already"),
      error: t("mw_status_error"),
    };
    setStatus(messages[outcome.status], RESULT_VISIBLE_MS);
    if (outcome.status === "error") console.warn("[BetterBridge]", outcome.message);
  } catch (e) {
    console.warn("[BetterBridge]", e);
    setStatus(e instanceof Error ? e.message : t("mw_status_error"), RESULT_VISIBLE_MS);
  } finally {
    busy = false;
  }
}

// --- wiring -------------------------------------------------------------------------
function reconcile() {
  for (const section of sections()) {
    injectChips(section);
    paintSelection(section);
    paintButton(section, statusText ?? undefined, statusLoading);
  }
}

// Our button replaces MakerWorld's action; native chips switch our mode off.
document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!target || triggering || target.closest("[data-bb-item]")) return;
  const slide = target.closest<HTMLElement>(".swiper-slide");
  if (slide && !slide.dataset.bbPrinter && sections().some((s) => s.wrapper.contains(slide))) {
    deactivate();
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
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    reconcile();
    if (!triggering) decorateMenu();
  }, 30);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

let prepared = false;

async function loadPrinters() {
  printers = await bridge.call<PagePrinter[]>({ type: "printers" });
  if (active && !printers.some((p) => p.id === active!.id)) active = null;
  reconcile();
  // A chip of ours is on the page: get the engine and profiles ready for the click.
  if (!prepared && document.querySelector("[data-bb-printer]")) {
    prepared = true;
    void bridge.call({ type: "prepare" }).catch(() => (prepared = false));
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.printers) void loadPrinters();
});
void loadPrinters();
