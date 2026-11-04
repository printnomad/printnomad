// What the user sees before reporting: the exact text, an optional comment, Copy and Send.
// Used on the options page and, inside a shadow root, on MakerWorld.
import { t } from "./i18n.ts";

export interface ReportPanelOptions {
  /** The exact text that is copied or sent. */
  text: string;
  /** Missing when no report service is configured: only Copy is offered. */
  send?(comment: string): Promise<void>;
  /** Fold the text under "What is sent", so Send is in view without scrolling. */
  collapsed?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function reportPanel({ text, send, collapsed }: ReportPanelOptions): HTMLElement {
  const root = el("div", "flex flex-col gap-2");
  const preview = el("pre", "max-h-80 overflow-auto rounded-xl bg-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap", text);
  preview.dataset.field = "report";
  const actions = el("div", "flex flex-wrap items-center gap-2");
  const copy = el("button", "btn rounded-full bg-sunken px-4 py-1.5 text-xs hover:bg-line", t("convert_copy_report"));
  copy.type = "button";
  copy.dataset.field = "copy";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = t("convert_copied");
    } catch {
      copy.textContent = t("convert_copy_failed");
    }
    setTimeout(() => (copy.textContent = t("convert_copy_report")), 2_000);
  };
  if (collapsed) {
    const fold = el("details", "");
    fold.append(el("summary", "cursor-pointer py-1 text-xs font-semibold text-muted", t("report_what_is_sent")), preview);
    root.append(fold);
  } else {
    root.append(preview);
  }
  if (send) {
    const comment = el("textarea", "w-full rounded-xl bg-sunken p-3 text-sm");
    comment.rows = 2;
    comment.maxLength = 2_000;
    comment.placeholder = t("report_comment");
    comment.ariaLabel = t("report_comment");
    comment.dataset.field = "comment";
    const button = el("button", "btn-primary px-4 py-1.5 text-xs", t("report_send"));
    button.type = "button";
    button.dataset.field = "send";
    const result = el("span", "text-xs text-muted", t("report_send_hint"));
    result.dataset.field = "send-result";
    result.setAttribute("role", "status");
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = t("report_sending");
      try {
        await send(comment.value);
        button.hidden = true;
        comment.hidden = true;
        result.textContent = t("report_sent");
      } catch {
        button.disabled = false;
        button.textContent = t("report_send");
        result.textContent = t("report_send_failed");
      }
    };
    root.append(comment);
    actions.append(button, copy, result);
  } else {
    actions.append(copy);
  }
  root.append(actions);
  return root;
}
