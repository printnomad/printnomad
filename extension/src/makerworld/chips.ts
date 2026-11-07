// Which chips "Print Files" shows for My printers.
import type { PagePrinter } from "./protocol.ts";

/** MakerWorld is made for this brand: its printers keep MakerWorld's own button and are not converted. */
export const NATIVE_BRAND = "Bambu Lab";

export const normalize = (text: string | null | undefined) => (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * `labels`: the texts of MakerWorld's own chips, in order, without its first one ("All").
 * `mine`: positions of the chips that are my printers, to show them first.
 * `inject`: my printers MakerWorld has no chip for, which get one of ours and are converted.
 */
export function planChips(labels: string[], printers: PagePrinter[]): { mine: number[]; inject: PagePrinter[] } {
  const listed = labels.map(normalize);
  const mine = printers.map((p) => listed.indexOf(normalize(p.label))).filter((i) => i >= 0);
  const inject = printers.filter((p) => p.brand !== NATIVE_BRAND && !listed.includes(normalize(p.label)));
  return { mine: [...new Set(mine)], inject };
}
