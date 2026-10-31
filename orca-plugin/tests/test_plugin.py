"""Flujo del plugin de OrcaSlicer con un módulo `orca` falso (sin la GUI)."""

import importlib
import json
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

from conftest import make_bambu_3mf

PLUGIN_ROOT = Path(__file__).resolve().parent.parent          # orca-plugin/
CORE_PKG = PLUGIN_ROOT.parent / "core" / "src" / "betterbridge"
PLUGIN_PKG = PLUGIN_ROOT / "betterbridge_orca"
UI_DIR = PLUGIN_ROOT / "ui"
BUILT_PANEL = UI_DIR / "dist" / "panel.html"
HAVE_UI_TOOLS = shutil.which("node") is not None and (UI_DIR / "node_modules" / "jsdom").exists()


def _built_panel() -> str | None:
    """Panel compilado con Tailwind (lo compila si hay node y dependencias)."""
    if HAVE_UI_TOOLS:
        subprocess.run(["npm", "run", "build"], cwd=UI_DIR, check=True, capture_output=True)
    return BUILT_PANEL.read_text(encoding="utf-8") if BUILT_PANEL.exists() else None
PLA = ("PLA", "Bambu PLA Basic @BBL A1", "#FF0000")


class FakePanel:
    def __init__(self, on_message, **kw):
        self.on_message, self.posts, self.open = on_message, [], True

    def post(self, msg):
        self.posts.append(msg)

    def show(self):
        pass

    def is_open(self):
        return self.open


def fake_orca(profiles_root):
    orca = types.ModuleType("orca")
    state = {"notifications": [], "panels": [], "caps": [], "perms": None, "config": {}}

    class Level:
        RegularNotificationLevel = "regular"
        WarningNotificationLevel = "warning"

    class CapBase:
        def __init__(self):
            pass

        def get_config(self):
            return json.dumps({"profiles_dir": str(profiles_root), **state["config"]})

        def save_config(self, text):
            state["config"] = json.loads(text)
            return True

    def push_notification(level, text, hyper_text="", on_click=None):
        state["notifications"].append((level, text, hyper_text, on_click))

    def create_dock_panel(html, on_message, **kw):
        panel = FakePanel(on_message, **kw)
        state["panels"].append(panel)
        return panel

    orca.base = type("base", (), {})
    orca.plugin = lambda cls: cls
    orca.register_capability = lambda cls: state["caps"].append(cls)
    orca.request_permissions = lambda **kw: state.__setitem__("perms", kw)
    orca.script = types.SimpleNamespace(ScriptPluginCapabilityBase=CapBase)
    orca.ExecutionResult = types.SimpleNamespace(skipped=lambda msg: ("skipped", msg))
    orca.LifecycleEvent = types.SimpleNamespace(ProjectOpened="opened", ProjectClosed="closed")
    orca.host = types.SimpleNamespace(
        plater=None,
        app_info=lambda: {"language": "es_ES", "version": "2.5.0"},
        ui=types.SimpleNamespace(NotificationLevel=Level, push_notification=push_notification,
                                 create_dock_panel=create_dock_panel))
    return orca, state


@pytest.fixture
def plugin(tmp_path, profiles_root, monkeypatch):
    pkg = tmp_path / "pkg" / "betterbridge_orca"
    shutil.copytree(PLUGIN_PKG, pkg)
    shutil.copytree(CORE_PKG, pkg / "core")
    # El HTML del panel viene del build de ui/; sin node basta una plantilla mínima.
    (pkg / "panel.html").write_text(
        _built_panel() or "<script>window.BB_I18N = __BB_I18N__;</script>", encoding="utf-8")
    orca, state = fake_orca(profiles_root)
    monkeypatch.setitem(sys.modules, "orca", orca)
    monkeypatch.syspath_prepend(str(pkg.parent))
    for name in [m for m in sys.modules if m.startswith("betterbridge_orca")]:
        monkeypatch.delitem(sys.modules, name)
    module = importlib.import_module("betterbridge_orca")
    module.BetterBridgePlugin().register_capabilities()
    return module, orca, state


def send(cap, panel, msg):
    panel.on_message(msg)


def open_project(module, orca, state, path):
    cap = state["caps"][0]()
    cap.on_lifecycle_event(orca.LifecycleEvent.ProjectOpened, types.SimpleNamespace(name=str(path)))
    return cap


def test_notification_panel_preview_and_convert(plugin, tmp_path, monkeypatch):
    module, orca, state = plugin
    assert any("Downloads" in p for p in state["perms"]["fs_readwrite"])
    assert "threading" not in state["perms"]
    # Comandos de "Abrir en…" fijos: se autorizan una vez al activar el plugin.
    assert all("/usr/bin/open -a" in c for c in state["perms"]["process"])
    assert "network_socket" not in state["perms"]  # el experimental los pide al usarse
    src = make_bambu_3mf(tmp_path / "proj.3mf", [PLA, PLA], [["2"]], object_extruders={"2": 2})
    cap = open_project(module, orca, state, src)

    (_, text, link, on_click), = state["notifications"]
    assert "Bambu Studio" in text and "Creator 5 Pro" in link
    assert on_click() is True
    panel = state["panels"][0]

    send(cap, panel, {"type": "ready"})
    preview = panel.posts[-1]
    assert preview["type"] == "preview" and not preview["blocking"]
    assert [f["target"] for f in preview["filaments"]] == ["Flashforge PLA Basic @FF C5P"] * 2
    assert preview["filaments"][1]["plates"] == ["1"]
    assert preview["filaments"][0]["plates"] == []           # filamento 1 sin uso
    assert preview["output_name"] == "proj_CREATOR5_PRO.3mf"

    send(cap, panel, {"type": "convert", "nozzle": "0.4"})
    result = panel.posts[-1]
    assert cap._cached is None  # se reutilizó la vista previa
    send(cap, panel, {"type": "preview", "nozzle": "0.4"})
    assert panel.posts[-1]["type"] == "preview"
    assert result["type"] == "result" and result["ok"], result["report"]["errors"]
    assert (tmp_path / "proj_CREATOR5_PRO.3mf").exists()
    assert (tmp_path / "proj_CREATOR5_PRO.report.json").exists()
    assert state["notifications"][-1][0] == "regular"
    assert {a["key"] for a in result["open_apps"]} <= {"orca", "flash"}

    # Segunda conversión: la vista previa avisa y sin decisión no se escribe nada.
    out = tmp_path / "proj_CREATOR5_PRO.3mf"
    stamp = out.stat().st_mtime_ns
    send(cap, panel, {"type": "preview", "nozzle": "0.4"})
    assert panel.posts[-1]["output_exists"] and panel.posts[-1]["output_modified"]
    send(cap, panel, {"type": "convert", "nozzle": "0.4"})
    assert panel.posts[-1]["type"] == "confirm"
    assert out.stat().st_mtime_ns == stamp
    send(cap, panel, {"type": "convert", "nozzle": "0.4", "overwrite": "copy"})
    assert panel.posts[-1]["output_name"] == "proj_CREATOR5_PRO (2).3mf"
    assert (tmp_path / "proj_CREATOR5_PRO (2).3mf").exists()
    assert (tmp_path / "proj_CREATOR5_PRO (2).report.json").exists()
    send(cap, panel, {"type": "convert", "nozzle": "0.4", "overwrite": "replace"})
    assert panel.posts[-1]["ok"] and panel.posts[-1]["output_name"] == "proj_CREATOR5_PRO.3mf"
    assert not (tmp_path / "proj_CREATOR5_PRO (3).3mf").exists()
    send(cap, panel, {"type": "preview", "nozzle": "0.4"})       # recalcula para lo que sigue

    # "Abrir en…": comando fijo (autorizable una vez) y la ruta en el archivo intermedio.
    calls = []
    monkeypatch.setattr(module, "OPEN_TARGET", tmp_path / "abrir.txt")
    monkeypatch.setattr(module, "OPEN_URL_TARGET", tmp_path / "abrir_url.txt")
    monkeypatch.setattr(module.os, "system", lambda cmd: calls.append(cmd) or 0)
    monkeypatch.setattr(module, "OPEN_APPS", {"orca": ("OrcaSlicer", tmp_path)})
    # Predeterminado: otra ventana (open -a con la ruta en el archivo intermedio).
    send(cap, panel, {"type": "open", "app": "orca"})
    assert calls == [module._open_command("OrcaSlicer")]
    assert str(tmp_path / "abrir.txt") in calls[0]
    assert (tmp_path / "abrir.txt").read_text() == str(tmp_path / "proj_CREATOR5_PRO.3mf")

    # Experimental: misma ventana vía servidor local + orcaslicer://open?file=http://…
    send(cap, panel, {"type": "option", "key": "same_window", "value": "on"})
    assert state["config"][module.SAME_WINDOW_OPTION] is True
    served = []
    monkeypatch.setattr(module, "serve_once", lambda p: served.append(p) or "http://127.0.0.1:47811/proj_CREATOR5_PRO.3mf")
    send(cap, panel, {"type": "open", "app": "orca"})
    assert served == [tmp_path / "proj_CREATOR5_PRO.3mf"]
    assert calls[-1] == module._open_url_command()
    from urllib.parse import unquote
    assert unquote((tmp_path / "abrir_url.txt").read_text()) == "http://127.0.0.1:47811/proj_CREATOR5_PRO.3mf"

    # Si el puerto está ocupado, se abre en otra ventana y se avisa.
    def busy_port(p):
        raise OSError("Address already in use")
    monkeypatch.setattr(module, "serve_once", busy_port)
    send(cap, panel, {"type": "open", "app": "orca"})
    assert calls[-1] == module._open_command("OrcaSlicer")
    assert "otra ventana" in state["notifications"][-1][1]
    send(cap, panel, {"type": "option", "key": "same_window", "value": "off"})
    assert state["config"][module.SAME_WINDOW_OPTION] is False
    n = len(calls)
    send(cap, panel, {"type": "open", "app": "otra"})   # app desconocida: no hace nada
    assert len(calls) == n


def test_panel_map_from_table(plugin, tmp_path):
    module, orca, state = plugin
    src = make_bambu_3mf(tmp_path / "m.3mf", [PLA] * 5, [["2"]], paint=(1, 2, 3, 4, 5))
    cap = open_project(module, orca, state, src)
    state["notifications"][0][3]()
    panel = state["panels"][0]
    send(cap, panel, {"type": "ready"})
    preview = panel.posts[-1]
    assert preview["needs_map"] and not preview["blocking"]
    assert "a mano" in preview["errors"][0]
    send(cap, panel, {"type": "convert", "map": "1:1,2:2,3:3,4:4,5:1", "nozzle": "0.4"})
    assert panel.posts[-1]["ok"]


def test_flashforge_and_converted_projects_are_ignored(plugin, tmp_path):
    module, orca, state = plugin
    ff = make_bambu_3mf(tmp_path / "ff.3mf", [PLA], [["2"]],
                        settings={"printer_model": "Flashforge Creator 5 Pro", "printer_settings_id": "x"})
    open_project(module, orca, state, ff)
    done = make_bambu_3mf(tmp_path / "x_CREATOR5_PRO.3mf", [PLA], [["2"]])
    open_project(module, orca, state, done)
    assert state["notifications"] == []


def test_panel_messages_exist_for_every_key_used():
    """Cada clave panel.* que usa panel.js existe en el catálogo inglés (y por tanto en todos)."""
    import json
    import re
    used = set(re.findall(r"'(panel\.[a-z0-9_.]+)'", (UI_DIR / "src" / "panel.js").read_text(encoding="utf-8")))
    english = json.loads((PLUGIN_PKG / "locales" / "en.json").read_text(encoding="utf-8"))
    assert used, "no panel.* keys found in panel.js"
    missing = sorted(used - set(english))
    assert not missing, f"keys used in panel.js but missing in en.json: {missing}"


def test_page_injects_translations(plugin):
    module, _, _ = plugin
    html = module.page.render("en", template="<script>window.BB_I18N = __BB_I18N__;</script>")
    assert '"panel.convert": "Convert"' in html and "__BB_I18N__" not in html
    assert '"plugin.' not in html  # solo los textos del panel


@pytest.mark.skipif(not HAVE_UI_TOOLS, reason="falta node o las dependencias de ui/ (cd orca-plugin/ui && npm ci)")
def test_panel_flow_in_browser_dom(plugin, tmp_path):
    """El panel compilado, en un DOM con el puente real de Orca: cargar, convertir, volver, mapa, cerrar.

    El puente de Orca traga las excepciones de JS, así que un error de la página
    (p. ej. leer un <select> ya borrado) solo se ve aquí.
    """
    module, _, _ = plugin
    html = module.page.render("es")
    assert "/*__BB_CSS__*/" not in html and ".bg-accent" in html   # CSS de Tailwind incrustado
    assert ".bg-red-500" not in html                                # y solo con clases usadas
    path = tmp_path / "panel.html"
    path.write_text(html, encoding="utf-8")
    proc = subprocess.run(["node", str(UI_DIR / "tests" / "panel_flow.cjs"), str(path)],
                          capture_output=True, text=True, cwd=UI_DIR)
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_local_server_serves_file_once(tmp_path):
    """El servidor experimental responde 200 (lo que Orca exige para cargar) y se cierra."""
    import runpy
    import time
    import urllib.request
    mod = runpy.run_path(str(PLUGIN_PKG / "local_server.py"))
    f = tmp_path / "Mi proyecto_CREATOR5_PRO.3mf"
    f.write_bytes(b"PK\x03\x04 datos")
    url = mod["serve_once"](f, port=0, timeout=5)
    assert url.startswith("http://127.0.0.1:") and url.endswith("/Mi%20proyecto_CREATOR5_PRO.3mf")
    req = urllib.request.Request(url, headers={"Range": "bytes=0-"})  # Orca pide rango "0-"
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        assert resp.read() == f.read_bytes()
        assert 'filename="Mi proyecto_CREATOR5_PRO.3mf"' in resp.headers["Content-Disposition"]
    time.sleep(1.5)  # entregado: el servidor se cierra
    with pytest.raises(OSError):
        urllib.request.urlopen(url, timeout=2)
