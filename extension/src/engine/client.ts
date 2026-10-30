// Promise API over the conversion worker. One worker per page, started on first use.
import type { ConvertRequest, ConvertResult, OptionInfo, PrinterInfo, Request, Response, SourceInfo } from "./protocol.ts";

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class Engine {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(chrome.runtime.getURL("worker.js"), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<Response>) => {
      const job = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.ok) job?.resolve(data.result);
      else job?.reject(new Error(data.error));
    };
    worker.onerror = (e) => {
      for (const job of this.pending.values()) job.reject(new Error(e.message || "conversion engine failed"));
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private call<T>(request: Omit<Request, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.start().postMessage({ ...request, id }, transfer);
    });
  }

  convert(args: ConvertRequest): Promise<ConvertResult> {
    return this.call({ op: "convert", args }, [args.data]);
  }

  listPrinters(bundles: string[]): Promise<PrinterInfo[]> {
    return this.call({ op: "listPrinters", args: { bundles } });
  }

  /** `data` is copied, not transferred: the caller still converts it afterwards. */
  sourceInfo(name: string, data: ArrayBuffer): Promise<SourceInfo> {
    return this.call({ op: "sourceInfo", args: { name, data: data.slice(0) } });
  }

  listOptions(lang?: string): Promise<OptionInfo[]> {
    return this.call({ op: "listOptions", args: { lang } });
  }
}
