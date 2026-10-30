// Une el panel en un solo HTML: src/panel.html + CSS de Tailwind (dist/panel.css,
// generado por `npm run build:css` solo con las clases usadas) + src/panel.js.
// Salida: dist/panel.html, que tools/build.py mete en la wheel del plugin.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

const html = read("src/panel.html");
const css = read("dist/panel.css");
const js = read("src/panel.js");

// Un "</script" dentro del JS cerraría la etiqueta antes de tiempo.
if (/<\/script/i.test(js)) throw new Error("panel.js no puede contener '</script'");
for (const marker of ["/*__BB_CSS__*/", "/*__BB_JS__*/", "__BB_I18N__"]) {
  const count = html.split(marker).length - 1;
  if (count !== 1) throw new Error(`${marker} debe aparecer exactamente una vez en src/panel.html (aparece ${count})`);
}

const out = html.replace("/*__BB_CSS__*/", () => css).replace("/*__BB_JS__*/", () => js);
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist/panel.html"), out);
console.log(`dist/panel.html: ${(out.length / 1024).toFixed(1)} KiB (CSS ${(css.length / 1024).toFixed(1)} KiB)`);
