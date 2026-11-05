"""Genera un HTML para ver el panel del plugin en el navegador, con datos reales.

Uso: python orca-plugin/tools/preview_panel.py proyecto.3mf [--out panel_preview.html]

No escribe ningún .3mf: la conversión se calcula en memoria y el botón
"Convertir" del HTML muestra ese resultado.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent          # orca-plugin/
sys.path.insert(0, str(PLUGIN_ROOT.parent / "core" / "src"))

from printnomad import i18n, read_3mf, write_3mf  # noqa: E402
from printnomad.convert import convert  # noqa: E402
from printnomad.target import load_target  # noqa: E402

BUILT_PANEL = PLUGIN_ROOT / "ui" / "dist" / "panel.html"   # npm run build en orca-plugin/ui
i18n.add_catalog_dir(PLUGIN_ROOT / "printnomad_orca" / "locales")

SHIM = """<script>
window.orca = (function(){
  var handlers = [], data = %s;
  function deliver(m){ setTimeout(function(){ handlers.forEach(function(h){ h(m); }); }, 250); }
  return {
    onMessage: function(h){ handlers.push(h); },
    postMessage: function(m){
      if (m.type === 'ready' && location.hash === '#result') deliver(data.result);
      else if (m.type === 'ready' || m.type === 'preview') deliver(data.preview);
      else if (m.type === 'convert') deliver(data.result);
    },
    close: function(){ document.body.innerHTML = '<p style="padding:12px">(panel cerrado)</p>'; }
  };
})();
</script>"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("project", type=Path)
    ap.add_argument("--out", type=Path, default=Path("panel_preview.html"))
    ap.add_argument("--lang", help="idioma del panel (por defecto, el del sistema)")
    ap.add_argument("--printer", default="Flashforge Creator 5 Pro 0.4 nozzle", help="preset de impresora destino")
    ap.add_argument("--slicer", help="laminador (por defecto, buscar en los instalados)")
    args = ap.parse_args()
    i18n.set_language(args.lang)
    if not BUILT_PANEL.exists():
        sys.exit(f"falta {BUILT_PANEL}: ejecuta `npm ci && npm run build` en orca-plugin/ui")

    target = load_target(args.printer, args.slicer)
    project = read_3mf.load(args.project)
    result = convert(project, target)
    rep = result.report
    dest = write_3mf.output_path(args.project, target.output_suffix)
    preview = {
        "type": "preview", "project": args.project.name,
        "source_kind": read_3mf.SOURCE_DISPLAY_NAMES.get(rep.source_kind, rep.source_kind),
        "target": target.display_name, "extruders": target.extruders,
        "nozzle": rep.presets.get("nozzle", target.nozzle), "nozzles": list(target.nozzle_variants()),
        "process": rep.presets.get("process", ""),
        "filaments": [{
            "index": f.index, "type": f.source_type, "colour": f.colour, "source": f.source_profile,
            "target": f.target_profile,
            "plates": sorted(p for p, u in result.usage.items() if u is None or f.index in u),
            "extruder": next(iter(f.extruders.values()), None)} for f in rep.filaments],
        "needs_map": rep.needs_map,
        "blocking": bool(rep.errors) and not rep.needs_map,
        "errors": rep.errors, "warnings": rep.warnings, "output_name": dest.name,
    }
    rep.output = str(dest)
    res = {"type": "result", "ok": rep.ok, "project_name": args.project.name, "output": rep.output,
           "output_name": dest.name, "report_name": dest.with_suffix(".report.json").name,
           "report": rep.to_dict(), "same_window": False,
           "open_apps": [{"key": "orca", "label": "OrcaSlicer"}, {"key": "flash", "label": "Flash Studio"}]}
    shim = SHIM % json.dumps({"preview": preview, "result": res}, ensure_ascii=False).replace("</", "<\\/")
    messages = {k: v for k, v in i18n.catalog().items() if k.startswith("panel.")}
    page = BUILT_PANEL.read_text(encoding="utf-8").replace(
        "__PN_I18N__", json.dumps(messages, ensure_ascii=False).replace("</", "<\\/"), 1)
    args.out.write_text(page.replace("<script>", shim + "\n<script>", 1), encoding="utf-8")
    print(f"abre: {args.out.resolve()}")


if __name__ == "__main__":
    main()
