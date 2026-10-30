// Conversion worker: runs the Python core (core/src/betterbridge) in Pyodide.
//
// Pyodide cannot run in the MV3 service worker (no dynamic import there), so extension
// pages start this module worker instead. Boot takes ~1 s and happens once per worker.
import type { PyodideAPI } from "pyodide";
import type { ConvertRequest, ConvertResult, ListPrintersRequest, PrinterInfo, Request, Response } from "./protocol.ts";

const LIB = "/lib";
const WORK = "/work";

let ready: Promise<PyodideAPI> | null = null;

async function boot(): Promise<PyodideAPI> {
  // Runtime URL, not bundled: Pyodide ships its own module next to the wasm.
  const pyodideUrl = new URL("./pyodide/pyodide.mjs", import.meta.url).href;
  const { loadPyodide } = (await import(pyodideUrl)) as typeof import("pyodide");
  const [py, core] = await Promise.all([
    loadPyodide({ indexURL: new URL("./pyodide/", import.meta.url).href }),
    fetch(new URL("./core.json", import.meta.url)).then((r) => r.json() as Promise<Record<string, string>>),
  ]);
  for (const [path, text] of Object.entries(core)) {
    const full = `${LIB}/betterbridge/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(full, text);
  }
  py.FS.mkdirTree(WORK);
  py.runPython(`import sys; sys.path.insert(0, ${JSON.stringify(LIB)})`);
  return py;
}

function engine(): Promise<PyodideAPI> {
  ready ??= boot();
  return ready;
}

/** JSON texts → Python list of dicts, parsed on the Python side (faster than toPy). */
function pyBundles(py: PyodideAPI, bundles: string[]) {
  const loads = py.pyimport("json").loads;
  return py.toPy(bundles.map((text) => loads(text)));
}

function toJs<T>(value: { toJs(opts: object): unknown; destroy(): void }): T {
  try {
    return value.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false }) as T;
  } finally {
    value.destroy();
  }
}

async function convert(args: ConvertRequest): Promise<ConvertResult> {
  const started = performance.now();
  const py = await engine();
  // One folder per job: names never clash and cleanup is a single rmtree.
  const dir = `${WORK}/${crypto.randomUUID()}`;
  py.FS.mkdirTree(`${dir}/out`);
  try {
    const src = `${dir}/${args.name.replace(/[\\/]/g, "_")}`;
    py.FS.writeFile(src, new Uint8Array(args.data));
    const web = py.pyimport("betterbridge.web");
    const res = toJs<{ ok: boolean; output: string | null; needs_map: boolean; report: Record<string, unknown> | null; text: string }>(
      web.convert_file.callKwargs(src, `${dir}/out`, args.printer, pyBundles(py, args.bundles), {
        slicer: args.slicer ?? null,
        platform: args.platform ?? null,
        nozzle: args.nozzle ?? null,
        map_text: args.map ?? null,
        keep_designer_filament: args.keepDesignerFilament ?? true,
        lang: args.lang ?? null,
      }),
    );
    let output: ConvertResult["output"] = null;
    if (res.output) {
      const bytes = py.FS.readFile(res.output) as Uint8Array;
      output = { name: res.output.slice(res.output.lastIndexOf("/") + 1), data: bytes.slice().buffer };
    }
    return { ok: res.ok, needsMap: res.needs_map, report: res.report, text: res.text, output, ms: performance.now() - started };
  } finally {
    py.pyimport("shutil").rmtree(dir, true);
  }
}

async function listPrinters(args: ListPrintersRequest): Promise<PrinterInfo[]> {
  const py = await engine();
  return toJs<PrinterInfo[]>(py.pyimport("betterbridge.web").list_printers(pyBundles(py, args.bundles)));
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  let reply: Response;
  const transfer: Transferable[] = [];
  try {
    const result = data.op === "convert" ? await convert(data.args) : await listPrinters(data.args);
    if (data.op === "convert" && (result as ConvertResult).output) transfer.push((result as ConvertResult).output!.data);
    reply = { id: data.id, ok: true, result };
  } catch (e) {
    reply = { id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(reply, transfer);
};
