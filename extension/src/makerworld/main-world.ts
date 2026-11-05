// Runs in MakerWorld's own JavaScript world (manifest: "world": "MAIN").
//
// MakerWorld downloads a 3MF in two steps: an authenticated request to
// `/api/…/instance/<id>/f3mf` answers a small JSON with the file name and a signed CDN
// URL, then the page saves that URL with an <a download>. While the content script has
// "armed" the capture, this script reads that JSON (fetch or XHR) and passes it on, and
// stops the page from saving the original file. Idea from makerworld-to-snapmaker-u1
// (MIT part, https://github.com/Dragon2203/makerworld-to-snapmaker-u1); own code.
import { CONTENT, MAIN, type FromMain, type ToMain } from "./protocol.ts";

// After the capture, MakerWorld still tries to save the original for a moment.
const BLOCK_AFTER_CAPTURE_MS = 10_000;

let armed = false;
let blockUntil = 0;

const isF3mf = (url: string) => /\/f3mf(?:[/?#]|$)/.test(url);
const blocking = () => armed || Date.now() < blockUntil;

function post(message: FromMain) {
  window.postMessage(message, location.origin);
}

/** MakerWorld's /f3mf answer, in whatever form the request read it. */
async function captured(body: unknown, fileName: string | null = null) {
  if (!armed) return;
  armed = false;
  blockUntil = Date.now() + BLOCK_AFTER_CAPTURE_MS;
  try {
    const bytes = body instanceof ArrayBuffer ? body : body instanceof Blob ? await body.arrayBuffer() : null;
    // A ZIP ("PK"): the 3MF itself.
    if (bytes && new Uint8Array(bytes, 0, 2).every((b, i) => b === [0x50, 0x4b][i])) {
      window.postMessage({ source: MAIN, type: "f3mf-file", data: bytes, name: fileName } satisfies FromMain,
        location.origin, [bytes]);
      return;
    }
    const json = (bytes ? safeParse(new TextDecoder().decode(bytes))
      : typeof body === "string" ? safeParse(body) : body) as Record<string, unknown> | null;
    const url = json && [json.url, json.downloadUrl, json.download_url, json.fileUrl].find((v) => typeof v === "string");
    // The CDN is https; same-origin URLs serve the local test page (tests/e2e-makerworld.mjs).
    if (typeof url === "string" && (/^https:\/\//.test(url) || url.startsWith(location.origin))) {
      post({ source: MAIN, type: "f3mf", url, name: typeof json?.name === "string" ? json.name : fileName });
      return;
    }
  } catch {
    // reported below
  }
  post({ source: MAIN, type: "f3mf-error", status: 0 });
}

/** File name from a Content-Disposition header, if any. */
function dispositionName(header: string | null): string | null {
  const match = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const nativeFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  const promise = nativeFetch.call(this, input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (armed && isF3mf(url)) {
    promise.then(async (res) => {
      if (!res.ok) {
        armed = false;
        post({ source: MAIN, type: "f3mf-error", status: res.status });
        return;
      }
      void captured(await res.clone().arrayBuffer(), dispositionName(res.headers.get("content-disposition")));
    }).catch(() => post({ source: MAIN, type: "f3mf-error", status: 0 }));
  }
  return promise;
};

const xhrUrls = new WeakMap<XMLHttpRequest, string>();
const nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  xhrUrls.set(this, String(url));
  return (nativeOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
};
const nativeSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: XMLHttpRequestBodyInit | null) {
  const url = xhrUrls.get(this) ?? "";
  if (armed && isF3mf(url)) {
    this.addEventListener("loadend", () => {
      if (this.status < 200 || this.status >= 300) {
        armed = false;
        post({ source: MAIN, type: "f3mf-error", status: this.status });
        return;
      }
      // responseText throws unless responseType is "" or "text" (MakerWorld uses "arraybuffer").
      const body = this.responseType === "" || this.responseType === "text" ? this.responseText : this.response;
      void captured(body, dispositionName(this.getResponseHeader("content-disposition")));
    });
  }
  return nativeSend.call(this, body);
};

// Keep the original file from being saved while BetterBridge converts it.
document.addEventListener("click", (e) => {
  if (blocking() && (e.target as Element | null)?.closest?.("a[download]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
const nativeAnchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
  if (blocking() && (this.hasAttribute("download") || /\.3mf(?:[?#]|$)/i.test(this.href))) return;
  return nativeAnchorClick.call(this);
};

window.addEventListener("message", (e: MessageEvent<ToMain>) => {
  if (e.source !== window || e.data?.source !== CONTENT) return;
  if (e.data.type === "arm") {
    armed = true;
    post({ source: MAIN, type: "armed" }); // messages are async: confirm before the download starts
  }
  else if (e.data.type === "disarm") armed = false;
  else if (e.data.type === "swiper-update") {
    // Swiper keeps its instance on the element; only the page's world can reach it.
    document.querySelectorAll<HTMLElement & { swiper?: { update(): void } }>(".swiper").forEach((el) => el.swiper?.update());
  }
});
