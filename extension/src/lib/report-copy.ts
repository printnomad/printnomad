// The text "Copy report" puts on the clipboard: what a tester sends us. Nothing leaves the
// browser unless the user pastes it somewhere. It names the project file and the printer;
// the header is a fixed format for whoever reads the ticket, the report keeps the user's language.

export interface ReportContext {
  version: string;
  printer: string;
  slicer: string;
  plate?: string;
  file: string;
  browser: string;
}

export function clipboardReport(context: ReportContext, report: string): string {
  const header = [
    `PrintNomad ${context.version}`,
    `Printer: ${context.printer}`,
    `Slicer: ${context.slicer}`,
    ...(context.plate ? [`Build plate: ${context.plate}`] : []),
    `File: ${context.file}`,
    `Browser: ${context.browser}`,
  ];
  return `${header.join("\n")}\n\n${report}\n`;
}
