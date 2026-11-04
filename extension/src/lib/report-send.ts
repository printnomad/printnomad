// Sends a report to the worker in tools/report-worker. The limits are the worker's.
export const MAX_REPORT = 32_000;
const TRUNCATED = "\n… (truncated)";

export interface OutgoingReport {
  report: string;
  comment?: string;
  /** Optional email, only to answer the reporter. Never part of the copied text. */
  contact?: string;
  code?: string;
  version: string;
}

export function reportPayload({ report, comment, contact, code, version }: OutgoingReport): OutgoingReport {
  const text = report.length > MAX_REPORT ? report.slice(0, MAX_REPORT - TRUNCATED.length) + TRUNCATED : report;
  return { report: text, comment: comment?.trim().slice(0, 2_000) || undefined, contact: contact?.trim() || undefined, code, version };
}

/** Rejects when the report did not arrive, so the user can copy it instead. */
export async function sendReport(url: string, report: OutgoingReport, send: typeof fetch = fetch): Promise<void> {
  const response = await send(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportPayload(report)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
