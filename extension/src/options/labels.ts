// Names for people of values that belong to the slicers.
import { t } from "../lib/i18n.ts";

/** Plate names; the values are the slicers' (rules.BED_TYPES in the core). */
export function bedLabel(bed: string): string {
  switch (bed) {
    case "Cool Plate": return t("bed_cool_plate");
    case "Engineering Plate": return t("bed_engineering_plate");
    case "High Temp Plate": return t("bed_high_temp_plate");
    case "Textured PEI Plate": return t("bed_textured_pei_plate");
    case "Textured Cool Plate": return t("bed_textured_cool_plate");
    case "Supertack Plate": return t("bed_supertack_plate");
    default: return bed;
  }
}
