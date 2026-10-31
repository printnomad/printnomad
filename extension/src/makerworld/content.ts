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
  // Show every print profile (MakerWorld filters by its own chip): select its "All".
  if (active?.id !== printer.id) {
    for (const section of sections()) {
      const all = nativeSlides(section.wrapper)[0];
      chipOf(all)?.click();
    }
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

function paintButton(section: Section, text?: string) {
  const label = buttonLabel(section);
  if (!label) return;
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
function setStatus(text: string | null, clearAfter = 0) {
  statusText = text;
  for (const s of sections()) paintButton(s, text ?? undefined);
  if (clearAfter) setTimeout(() => statusText === text && setStatus(null), clearAfter);
}

// --- menu -------------------------------------------------------------------------
// MakerWorld's download menu is its own dropdown (not always a MUI menu): find the
// visible "…3MF…" entry by its text, whatever the markup or language.
const isVisible = (el: Element) => (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0;

function native3mfItem(): HTMLElement | null {
  // Cheap text test first; layout (visibility) only for the few matches.
  const leaf = [...document.body.querySelectorAll<HTMLElement>("li, a, button, [role='menuitem'], div, span")].find((el) => {
    const text = el.textContent?.trim() ?? "";
    return text.length < 40 && /\b3mf\b/i.test(text)
      && ![...el.children].some((c) => /3mf/i.test(c.textContent ?? ""))
      && !el.closest("[data-bb-item], span.primaryButton") && isVisible(el);
  });
  if (!leaf) return null;
  // The clickable row: a menu item if there is one, else the leaf's own block.
  return leaf.closest<HTMLElement>("[role='menuitem'], li, a, button") ?? leaf.parentElement ?? leaf;
}

function decorateMenu() {
  if (!active) return;
  const native = native3mfItem();
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
    closeMenu();
    void download();
  }, true);
  native.before(item);
}

function closeMenu() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.querySelector<HTMLElement>(".MuiBackdrop-root, .MuiModal-backdrop")?.click();
  // A dropdown of its own closes when its arrow is clicked again.
  if (native3mfItem()) sections().find((s) => isVisible(s.root))?.arrow?.click();
}

// --- download for the active printer ---------------------------------------------
/** `armed` resolves once the page script listens; `file` with MakerWorld's answer. */
function captureF3mf() {
  let markArmed: () => void;
  const armed = new Promise<void>((resolve) => (markArmed = resolve));
  const file = new Promise<{ url: string; name: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(t("mw_error_timeout"))), CAPTURE_TIMEOUT_MS);
    function onMessage(e: MessageEvent<FromMain>) {
      if (e.source !== window || e.data?.source !== "betterbridge:main") return;
      if (e.data.type === "armed") markArmed();
      else if (e.data.type === "f3mf") finish(null, e.data);
      else finish(new Error(t("mw_error_download", e.data.status)));
    }
    function finish(error: Error | null, value?: { url: string; name: string | null }) {
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

async function clickNative3mf(section: Section) {
  if (!native3mfItem()) section.arrow?.click();
  const started = Date.now();
  while (Date.now() - started < MENU_TIMEOUT_MS) {
    const item = native3mfItem();
    if (item) {
      item.click();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(t("mw_error_menu"));
}

async function download() {
  const printer = active;
  const section = sections().find((s) => isVisible(s.root)) ?? sections()[0];
  if (!printer || !section || busy) return;
  busy = true;
  setStatus(t("mw_status_downloading"));
  try {
    const capture = captureF3mf();
    await Promise.race([capture.armed, capture.file]);
    triggering = true;
    try {
      await clickNative3mf(section);
    } finally {
      triggering = false;
    }
    const { url, name } = await capture.file;
    const res = await fetch(url);
    if (!res.ok) throw new Error(t("mw_error_download", res.status));
    const data = await res.arrayBuffer();
    setStatus(t("mw_status_converting", printer.label));
    const outcome = await bridge.call<ConvertOutcome>(
      { type: "convert", printerId: printer.id, name: name ?? "model.3mf", data }, [data]);
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
    paintButton(section, statusText ?? undefined);
  }
}

// Our button replaces MakerWorld's action; native chips switch our mode off.
document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!target || triggering) return;
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

async function loadPrinters() {
  printers = await bridge.call<PagePrinter[]>({ type: "printers" });
  if (active && !printers.some((p) => p.id === active!.id)) active = null;
  reconcile();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.printers) void loadPrinters();
});
void loadPrinters();
