// UI texts come from _locales/<lang>/messages.json (chrome.i18n), never from code.
// Contributors add a language by copying static/_locales/en (see docs/translating.md).

/** Message `key` with $1…$9 placeholders filled; the key itself if it is missing. */
export function t(key: string, ...subs: (string | number)[]): string {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

/** UI language for the Python core's report ("es", "en"…). */
export function uiLanguage(): string {
  return chrome.i18n.getUILanguage().split("-")[0];
}

/** Fill [data-i18n] (text), [data-i18n-placeholder] and [data-i18n-title] under `root`. */
export function localize(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder!)));
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle!)));
  document.documentElement.lang = uiLanguage();
}
