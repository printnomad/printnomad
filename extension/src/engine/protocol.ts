// Messages between extension pages and the conversion worker (engine/worker.ts).

export interface ConvertRequest {
  /** Project file name, e.g. "boat.3mf"; the output is named after it. */
  name: string;
  data: ArrayBuffer;
  printer: string;
  /** Profile bundles as JSON text (catalog bundles or a local slicer folder). */
  bundles: string[];
  slicer?: string;
  platform?: string;
  nozzle?: string;
  map?: string;
  keepDesignerFilament?: boolean;
  lang?: string;
}

export interface ConvertResult {
  ok: boolean;
  needsMap: boolean;
  /** Report as produced by betterbridge.report.Report.to_dict(), or null on input errors. */
  report: Record<string, unknown> | null;
  /** Human-readable report in `lang`. */
  text: string;
  output: { name: string; data: ArrayBuffer } | null;
  ms: number;
}

export interface ListPrintersRequest {
  bundles: string[];
}

export interface PrinterInfo {
  name: string;
  model: string;
  nozzle: string;
  extruders: number;
  vendor: string;
}

export type Request =
  | { id: number; op: "convert"; args: ConvertRequest }
  | { id: number; op: "listPrinters"; args: ListPrintersRequest };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
