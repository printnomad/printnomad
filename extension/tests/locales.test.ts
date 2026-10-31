// Every text the pages use exists in every language, with the same placeholders.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const localesDir = join(root, "static", "_locales");
type Messages = Record<string, { message: string }>;
const locales: Record<string, Messages> = Object.fromEntries(
  readdirSync(localesDir).map((lang) => [lang, JSON.parse(readFileSync(join(localesDir, lang, "messages.json"), "utf8"))]),
);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|html)$/.test(e.name) ? [readFileSync(join(dir, e.name), "utf8")] : [],
  );
}

const used = new Set<string>();
for (const text of [...sources(join(root, "src")), readFileSync(join(root, "static", "manifest.json"), "utf8")]) {
  for (const m of text.matchAll(/data-i18n(?:-placeholder|-title)?="([a-z0-9_]+)"|\bt\("([a-z0-9_]+)"|__MSG_([a-z0-9_]+)__/g)) {
    used.add(m[1] ?? m[2] ?? m[3]);
  }
}

test("every message used by the pages exists in English", () => {
  const missing = [...used].filter((k) => !locales.en[k]);
  assert.deepEqual(missing, []);
});

test("no unused messages", () => {
  assert.deepEqual(Object.keys(locales.en).filter((k) => !used.has(k)), []);
});

test("every language has the same keys and placeholders as English", () => {
  const placeholders = (s: string) => [...s.matchAll(/\$\d/g)].map((m) => m[0]).sort();
  for (const [lang, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(locales.en).sort(), lang);
    for (const [key, { message }] of Object.entries(messages)) {
      assert.deepEqual(placeholders(message), placeholders(locales.en[key].message), `${lang}:${key}`);
    }
  }
});
