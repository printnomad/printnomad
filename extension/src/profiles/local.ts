// Profiles read from the data folder of an installed slicer, picked by the user once
// (File System Access API), e.g. ~/Library/Application Support/Orca-Flashforge.
//
// The folder holds `system/<Vendor>/{machine,process,filament}/…` and
// `user/<account>/{machine,process,filament}/…`; each becomes a bundle in the same
// shape as the catalog ones, user presets under the pseudo-vendor "user" (as the core
// expects, see profiles.USER_VENDOR).

const KINDS = ["machine", "process", "filament"] as const;
export const USER_VENDOR = "user";

export interface LocalBundle {
  vendor: string;
  source: string;
  files: Record<string, unknown>;
}

async function child(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function* entries(dir: FileSystemDirectoryHandle): AsyncGenerator<FileSystemHandle> {
  // `values()` is in the spec and in Chromium but not yet in TypeScript's DOM types.
  yield* (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
}

async function readJsonTree(dir: FileSystemDirectoryHandle, prefix: string, out: Record<string, unknown>) {
  for await (const handle of entries(dir)) {
    const path = `${prefix}/${handle.name}`;
    if (handle.kind === "directory") {
      await readJsonTree(handle as FileSystemDirectoryHandle, path, out);
    } else if (handle.name.endsWith(".json")) {
      try {
        out[path] = JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text());
      } catch {
        // unreadable or invalid JSON: the slicer ignores it too
      }
    }
  }
}

async function bundleOf(dir: FileSystemDirectoryHandle, vendor: string, source: string): Promise<LocalBundle | null> {
  const files: Record<string, unknown> = {};
  for (const kind of KINDS) {
    const sub = await child(dir, kind);
    if (sub) await readJsonTree(sub, kind, files);
  }
  return Object.keys(files).length ? { vendor, source, files } : null;
}

/** Bundles for every vendor in `system/` plus the user presets of every account in `user/`. */
export async function readSlicerFolder(root: FileSystemDirectoryHandle): Promise<LocalBundle[]> {
  const source = `${root.name} (local)`;
  const bundles: LocalBundle[] = [];
  const system = await child(root, "system");
  if (system) {
    for await (const handle of entries(system)) {
      if (handle.kind !== "directory") continue;
      const bundle = await bundleOf(handle as FileSystemDirectoryHandle, handle.name, source);
      if (bundle) bundles.push(bundle);
    }
  }
  const user = await child(root, "user");
  if (user) {
    for await (const handle of entries(user)) {
      if (handle.kind !== "directory") continue;
      const bundle = await bundleOf(handle as FileSystemDirectoryHandle, USER_VENDOR, source);
      if (bundle) bundles.push(bundle);
    }
  }
  return bundles;
}
