// Bridge page: an invisible extension iframe inside MakerWorld that converts projects.
//
// The content script cannot run the Pyodide worker (workers must share the page's
// origin) nor use chrome.downloads; this extension page can. It only talks to the
// MakerWorld origins listed in config.json, and only to the page that embeds it.
import { CONFIG } from "../config.ts";
import { Converter, saveOutput } from "../lib/conversion.ts";
import { loadSettings, platformKey } from "../lib/settings.ts";
import { buildModels, modelOfPreset } from "../options/printer-picker.ts";
import { BRIDGE, CONTENT, type BridgeMessage, type BridgeRequest, type ConvertOutcome, type PagePrinter } from "./protocol.ts";

const parentOrigin = location.ancestorOrigins?.[0] ?? "";
const converter = new Converter();

function reply(message: BridgeMessage, transfer: Transferable[] = []) {
  window.parent.postMessage(message, parentOrigin, transfer);
}

async function printers(): Promise<PagePrinter[]> {
  const [settings, { catalog, url }] = await Promise.all([loadSettings(), converter.store.catalog()]);
  const models = buildModels(catalog, url);
  return settings.printers.map((p) => {
    const model = modelOfPreset(models, p.slicer, p.printer);
    return { id: p.id, label: model?.label ?? p.printer, brand: model?.brand ?? "", slicer: p.slicer };
  });
}

async function convert(printerId: string, name: string, data: ArrayBuffer): Promise<ConvertOutcome> {
  const settings = await loadSettings();
  const printer = settings.printers.find((p) => p.id === printerId);
  if (!printer) return { status: "error", message: "printer not found" };
  const [platform, sourceBundles] = await Promise.all([platformKey(), converter.sourceProfiles(name, data)]);
  const res = await converter.convert(printer, name, data, settings, platform, sourceBundles);
  if (res.alreadyTarget) return { status: "already" };
  if (!res.output) return { status: "error", message: res.text, needsMap: res.needsMap };
  const download = await saveOutput(res.output);
  if (!download.saved) return { status: "cancelled" };
  const warnings = Array.isArray(res.report?.warnings) ? (res.report.warnings as unknown[]).length : 0;
  return { status: "saved", fileName: download.fileName, warnings };
}

window.addEventListener("message", async (e: MessageEvent<BridgeRequest>) => {
  if (e.source !== window.parent || e.origin !== parentOrigin || e.data?.source !== CONTENT) return;
  if (!CONFIG.makerworldOrigins.includes(parentOrigin)) return;
  const request = e.data;
  try {
    const result = request.type === "printers"
      ? await printers()
      : await convert(request.printerId, request.name, request.data);
    reply({ source: BRIDGE, id: request.id, ok: true, result });
  } catch (err) {
    reply({ source: BRIDGE, id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

if (CONFIG.makerworldOrigins.includes(parentOrigin)) {
  reply({ source: BRIDGE, type: "ready" });
}
