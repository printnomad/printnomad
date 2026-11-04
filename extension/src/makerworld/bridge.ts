// Bridge page: an invisible extension iframe inside MakerWorld that converts projects.
//
// The content script cannot run the Pyodide worker (workers must share the page's
// origin) nor use chrome.downloads; this extension page can. It only talks to the
// MakerWorld origins listed in config.json, and only to the page that embeds it.
import { CONFIG } from "../config.ts";
import type { Issue } from "../engine/protocol.ts";
import { Converter, saveOutput } from "../lib/conversion.ts";
import { clipboardReport } from "../lib/report-copy.ts";
import { sendReport } from "../lib/report-send.ts";
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

/**
 * Boot the engine and load the profiles ahead of the click: the user's printers and
 * the slicer MakerWorld projects come from (made for "Bambu Lab", see slicers.json makers).
 */
async function prepare(): Promise<null> {
  const [settings, { catalog }] = await Promise.all([loadSettings(), converter.store.catalog()]);
  const source = Object.entries(catalog.slicers).find(([, s]) => s.makers?.includes("Bambu Lab"));
  const sourcePrinter = source && Object.values(source[1].vendors).flatMap((v) => v.printers)[0];
  await converter.prepare(settings.printers, source && sourcePrinter ? [{ slicer: source[0], printer: sourcePrinter.name }] : []);
  return null;
}

// The last project received: converting again with an assignment does not download it again.
let lastProject: { name: string; data: ArrayBuffer } | null = null;

async function convert(printerId: string, name?: string, data?: ArrayBuffer, map?: string): Promise<ConvertOutcome> {
  if (name && data) lastProject = { name, data };
  if (!lastProject) return { status: "error", message: "no project" };
  const settings = await loadSettings();
  const printer = settings.printers.find((p) => p.id === printerId);
  if (!printer) return { status: "error", message: "printer not found" };
  const project = lastProject;
  const [platform, sourceBundles] = await Promise.all([platformKey(), converter.sourceProfiles(project.name, project.data)]);
  const res = await converter.convert(printer, project.name, project.data, settings, platform, sourceBundles, map);
  if (res.alreadyTarget) return { status: "already" };
  if (!res.output && res.needsMap && res.plan) return { status: "needs-map", plan: res.plan };
  if (!res.output) {
    const issue = (res.report?.issues as Issue[] | undefined)?.[0];
    const report = clipboardReport({
      version: CONFIG.version,
      printer: printer.printer,
      slicer: printer.slicer,
      plate: printer.bedType,
      file: project.name,
      browser: navigator.userAgent,
    }, res.text);
    return { status: "error", message: res.text, needsMap: res.needsMap, issue, report };
  }
  const download = await saveOutput(res.output);
  if (!download.saved) return { status: "cancelled" };
  const warnings = Array.isArray(res.report?.warnings) ? (res.report.warnings as unknown[]).length : 0;
  return { status: "saved", fileName: download.fileName, warnings, convertMs: Math.round(res.ms) };
}

window.addEventListener("message", async (e: MessageEvent<BridgeRequest>) => {
  if (e.source !== window.parent || e.origin !== parentOrigin || e.data?.source !== CONTENT) return;
  if (!CONFIG.makerworldOrigins.includes(parentOrigin)) return;
  const request = e.data;
  try {
    const result = request.type === "printers" ? await printers()
      : request.type === "prepare" ? await prepare()
      : request.type === "send-report"
        ? await sendReport(CONFIG.reportUrl, { report: request.report, comment: request.comment, code: request.code, version: CONFIG.version })
      : await convert(request.printerId, request.name, request.data, request.map);
    reply({ source: BRIDGE, id: request.id, ok: true, result });
  } catch (err) {
    reply({ source: BRIDGE, id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

if (CONFIG.makerworldOrigins.includes(parentOrigin)) {
  reply({ source: BRIDGE, type: "ready" });
}
