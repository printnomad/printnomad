// Conversion worker: runs the Python core (core/src/printnomad) in Pyodide.
//
// Pyodide cannot run in the MV3 service worker (no dynamic import there), so extension
// pages start this module worker instead. Boot takes ~1 s and happens once per worker.
import type { PyodideAPI } from "pyodide";
import type {
  ConvertRequest,
  ConvertResult,
  ListPrintersRequest,
  PrinterInfo,
  Request,
  Response,
  SourceInfo,
} from "./protocol.ts";

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
    const full = `${LIB}/printnomad/${path}`;
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
    const web = py.pyimport("printnomad.web");
    const res = toJs<{
      ok: boolean;
      output: string | null;
      already_target: boolean;
      report: Record<string, unknown> | null;
      text: string;
    }>(
      web.convert_file.callKwargs(src, `${dir}/out`, args.printer, pyBundles(py, args.bundles), {
        slicer: args.slicer ?? null,
        platform: args.platform ?? null,
        nozzle: args.nozzle ?? null,
        bed_type: args.bedType ?? null,
        options: py.toPy(args.options ?? {}),
        source_bundles: args.sourceBundles?.length ? pyBundles(py, args.sourceBundles) : null,
        lang: args.lang ?? null,
      }),
    );
    let output: ConvertResult["output"] = null;
    if (res.output) {
      const bytes = py.FS.readFile(res.output) as Uint8Array;
      output = { name: res.output.slice(res.output.lastIndexOf("/") + 1), data: bytes.slice().buffer };
    }
    return {
      ok: res.ok,
      alreadyTarget: res.already_target,
      report: res.report,
      text: res.text,
      output,
      ms: performance.now() - started,
    };
  } finally {
    py.pyimport("shutil").rmtree(dir, true);
  }
}

async function listPrinters(args: ListPrintersRequest): Promise<PrinterInfo[]> {
  const py = await engine();
  return toJs<PrinterInfo[]>(py.pyimport("printnomad.web").list_printers(pyBundles(py, args.bundles)));
}

async function sourceInfo(name: string, data: ArrayBuffer): Promise<SourceInfo> {
  const py = await engine();
  const path = `${WORK}/${crypto.randomUUID()}-${name.replace(/[\\/]/g, "_")}`;
  py.FS.writeFile(path, new Uint8Array(data));
  try {
    return toJs<SourceInfo>(py.pyimport("printnomad.web").source_info(path));
  } finally {
    py.FS.unlink(path);
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.op) {
    case "convert":
      return convert(request.args);
    case "listPrinters":
      return listPrinters(request.args);
    case "warm":
      // Start Pyodide and import the core ahead of the first conversion.
      return (await engine()).pyimport("printnomad.web") && null;
    case "sourceInfo":
      return sourceInfo(request.args.name, request.args.data);
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  let reply: Response;
  const transfer: Transferable[] = [];
  try {
    const result = await handle(data);
    if (data.op === "convert" && (result as ConvertResult).output) transfer.push((result as ConvertResult).output!.data);
    reply = { id: data.id, ok: true, result };
  } catch (e) {
    reply = { id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(reply, transfer);
};
