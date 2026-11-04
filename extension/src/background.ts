// Service worker: opens the options page on install and from the toolbar button.
// Conversions do not run here (Pyodide needs dynamic import, which MV3 service workers
// lack); extension pages start engine/worker.ts.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// The MakerWorld button's "Preferences" and "Manage printers": content scripts cannot open it.
chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === "open-options") void chrome.runtime.openOptionsPage();
});
