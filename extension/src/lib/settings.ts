// User settings in chrome.storage.sync (follows the browser profile across devices).
// The local slicer folder handle cannot be serialized there: it lives in IndexedDB.

export type ProfileSource = "catalog" | "local";

export interface MyPrinter {
  id: string;
  /** Key in core/src/betterbridge/data/slicers.json, e.g. "flashstudio". */
  slicer: string;
  /** Machine preset name, e.g. "Flashforge Creator 5 Pro 0.4 nozzle". */
  printer: string;
}

export interface Settings {
  printers: MyPrinter[];
  profileSource: ProfileSource;
  /** Slicer whose data folder the user picked (profileSource "local"). */
  localSlicer: string;
}

const DEFAULTS: Settings = { printers: [], profileSource: "catalog", localSlicer: "flashstudio" };

export async function loadSettings(): Promise<Settings> {
  // Passing the defaults returns them for the keys that were never saved.
  return (await chrome.storage.sync.get({ ...DEFAULTS })) as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/** chrome.runtime platform → platform key of slicers.json. */
export async function platformKey(): Promise<string> {
  const { os } = await chrome.runtime.getPlatformInfo();
  return ({ mac: "macos", win: "windows" } as Record<string, string>)[os] ?? "linux";
}

// --- local slicer folder (IndexedDB) -------------------------------------
const DB = "betterbridge";
const STORE = "handles";
const FOLDER_KEY = "slicerFolder";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const req = fn(conn.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getSlicerFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  return tx("readonly", (s) => s.get(FOLDER_KEY));
}

export async function setSlicerFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await tx("readwrite", (s) => s.put(handle, FOLDER_KEY));
}
