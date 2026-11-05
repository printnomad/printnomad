import type { Issue } from "../engine/protocol.ts";

// Messages between the MakerWorld content script, the page script (main world) and the
// bridge page (engine iframe). Every message carries `source` so unrelated postMessage
// traffic on the page is ignored.

export const CONTENT = "printnomad:content";
export const MAIN = "printnomad:main";
export const BRIDGE = "printnomad:bridge";

/** Content script → main world. */
export type ToMain =
  | { source: typeof CONTENT; type: "arm" }
  | { source: typeof CONTENT; type: "disarm" }
  | { source: typeof CONTENT; type: "swiper-update" };

/** Main world → content script: MakerWorld's own 3MF download request was captured. */
export type FromMain =
  | { source: typeof MAIN; type: "armed" }
  | { source: typeof MAIN; type: "f3mf"; url: string; name: string | null }
  /** The /f3mf answer was the 3MF file itself (not JSON with a CDN URL). */
  | { source: typeof MAIN; type: "f3mf-file"; data: ArrayBuffer; name: string | null }
  | { source: typeof MAIN; type: "f3mf-error"; status: number };

/** A printer from My printers as the MakerWorld page shows it. */
export interface PagePrinter {
  id: string;
  /** Model without the brand, e.g. "Creator 5 Pro" (what MakerWorld's chips look like). */
  label: string;
  brand: string;
  slicer: string;
}

export type BridgeRequest =
  | { source: typeof CONTENT; id: number; type: "printers" }
  | { source: typeof CONTENT; id: number; type: "prepare" }
  | { source: typeof CONTENT; id: number; type: "send-report"; report: string; comment: string; contact: string; code?: string }
  | { source: typeof CONTENT; id: number; type: "convert"; printerId: string; name: string; data: ArrayBuffer };

export type ConvertOutcome =
  | { status: "saved"; fileName: string; warnings: number; convertMs: number; checkColours: boolean }
  | { status: "cancelled" }
  | { status: "already" }
  | { status: "error"; message: string; issue?: Issue; report?: string };

export type BridgeMessage =
  | { source: typeof BRIDGE; type: "ready" }
  | { source: typeof BRIDGE; id: number; ok: true; result: unknown }
  | { source: typeof BRIDGE; id: number; ok: false; error: string };
