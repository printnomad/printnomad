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
  /** Advanced options (core/src/betterbridge/options.py); missing ones take their defaults. */
  options?: OptionValues;
  /** Profiles of the slicer the project was made with (see SourceInfo): original values in the report. */
  sourceBundles?: string[];
  lang?: string;
}

export type OptionValues = Record<string, boolean | string>;

/** One conversion option as described by the core (betterbridge.options.describe). */
export interface OptionInfo {
  key: string;
  kind: "bool" | "choice";
  default: boolean | string;
  label: string;
  help: string;
  choices?: { value: string; label: string }[];
  warn_when?: boolean | string;
  warning?: string;
}

/** What an assignment screen needs (betterbridge.web.assignment_plan). */
export interface AssignmentPlan {
  extruders: number;
  filaments: { index: number; type: string; colour: string; profile: string; plates: string[] }[];
  /** Filaments each plate uses; null = unknown. */
  plates: Record<string, number[] | null>;
  /** Suggested assignment in --map syntax ("1:1,2:2,…"), null if materials alone need more extruders. */
  suggestion: string | null;
}

export interface ConvertResult {
  ok: boolean;
  needsMap: boolean;
  /** When needsMap: the data to let the user assign filaments to extruders. */
  plan?: AssignmentPlan;
  /** The project is already set up for this printer: nothing to convert. */
  alreadyTarget: boolean;
  /** Report as produced by betterbridge.report.Report.to_dict(), or null on input errors. */
  report: Record<string, unknown> | null;
  /** Human-readable report in `lang`. */
  text: string;
  output: { name: string; data: ArrayBuffer } | null;
  ms: number;
}

/** What a project was made with (betterbridge.web.source_info). */
export interface SourceInfo {
  kind: string;
  /** Catalog slicer holding the presets the designer started from, e.g. "bambustudio". */
  slicer: string | null;
  printer: string | null;
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
  | { id: number; op: "listPrinters"; args: ListPrintersRequest }
  | { id: number; op: "listOptions"; args: { lang?: string } }
  | { id: number; op: "warm"; args: Record<string, never> }
  | { id: number; op: "sourceInfo"; args: { name: string; data: ArrayBuffer } };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
