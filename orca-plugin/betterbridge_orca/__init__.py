"""Plugin de OrcaSlicer: ofrece convertir a Creator 5 Pro el proyecto abierto.

Al abrir un proyecto de Bambu Studio / PrusaSlicer muestra una notificación con
el enlace "Convertir a Creator 5 Pro". El enlace abre un panel con la vista
previa (filamentos → extrusores, boquilla, proceso); "Convertir" escribe
`<nombre>_CREATOR5_PRO.3mf` junto al original (que no se toca) y el panel pasa
a mostrar el reporte. No sustituye el proyecto abierto: la API de plugins no
permite abrir ni reemplazar proyectos.

La API de plugins de OrcaSlicer es alpha: los accesos van protegidos y lo que
falla se registra en el log en vez de romper el slicer.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import orca

from .core import i18n, read_3mf, write_3mf
from .core.convert import convert
from .core.i18n import t
from .core.printer_profiles import creator5pro
from .core.profiles import DEFAULT_ROOTS, ProfileLibrary, find_root
from .core.remap_filaments import parse_map
from .local_server import serve_once
from .panel_html import PAGE

log = logging.getLogger("betterbridge")

# Log propio: la carpeta de datos de Orca se puede escribir sin pedir permiso y
# el log de Python del host no siempre recoge lo que escribe el plugin.
DIAG_LOG = Path.home() / "Library/Application Support/OrcaSlicer/orca_plugins/plugin_data/betterbridge/debug.log"


def _setup_log() -> None:
    if log.handlers:
        return
    try:
        DIAG_LOG.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(DIAG_LOG, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s [%(threadName)s] %(levelname)s %(message)s"))
        log.addHandler(handler)
        log.setLevel(logging.INFO)
    except OSError:
        pass


_setup_log()

CONVERTIBLE = {read_3mf.SOURCE_BAMBU, read_3mf.SOURCE_ORCA, read_3mf.SOURCE_PRUSA}
SOURCE_NAMES = {
    read_3mf.SOURCE_BAMBU: "Bambu Studio",
    read_3mf.SOURCE_ORCA: "OrcaSlicer",
    read_3mf.SOURCE_PRUSA: "PrusaSlicer",
}
# Carpetas habituales de proyectos: se piden una vez al activar el plugin para
# no preguntar en cada archivo.
USER_FOLDERS = [str(Path.home() / d) + "/*" for d in ("Downloads", "Documents", "Desktop")]

# Identificador de la capacidad para Orca (estado activado, configuración): estable y
# sin traducir. No cambiarlo sin migración: Orca guarda ambos bajo este nombre.
CAPABILITY_NAME = "BetterBridge"

# Mensajes propios del plugin (locales/*.json) además de los del núcleo.
i18n.add_catalog_dir(Path(__file__).parent / "locales")


def _orca_language() -> str | None:
    """Idioma de la interfaz de OrcaSlicer (p. ej. "es_ES"), si la API lo da."""
    try:
        info = orca.host.app_info()
        return info.get("language") if isinstance(info, dict) else getattr(info, "language", None)
    except Exception as e:  # API alpha o fuera del hilo de la UI
        log.info("idioma de Orca no disponible: %s", e)
        return None

# "Abrir en…": la API de plugins no puede abrir proyectos (solo lee y exporta), así
# que se pide a macOS. Orca autoriza procesos por texto exacto del comando, por eso
# los comandos son fijos y lo que cambia (ruta o URL) va en un archivo de la carpeta
# de datos del plugin (escribible sin permiso).
#
# OrcaSlicer (GUI_App::MacOpenFiles): `open -a OrcaSlicer archivo` abre otra ventana
# salvo que esté activada «Allow only one OrcaSlicer instance». Es lo predeterminado:
# permite comparar original y convertido lado a lado.
# Experimental (opción SAME_WINDOW_OPTION): la URL orcaslicer://open?file=http://…
# carga en la ventana actual (MacOpenURL → Downloader → load_files); ver local_server.
OPEN_TARGET = DIAG_LOG.parent / "abrir.txt"
OPEN_URL_TARGET = DIAG_LOG.parent / "abrir_url.txt"
OPEN_APPS = {
    "orca": ("OrcaSlicer", Path("/Applications/OrcaSlicer.app")),
    "flash": ("Flash Studio", Path("/Applications/Flash Studio.app")),
}
SAME_WINDOW_OPTION = "abrir_en_misma_ventana_experimental"


def _open_command(app: str) -> str:
    return f'/usr/bin/open -a "{app}" "$(/bin/cat "{OPEN_TARGET}")"'


def _open_url_command() -> str:
    return f'/usr/bin/open -a "OrcaSlicer" "orcaslicer://open?file=$(/bin/cat "{OPEN_URL_TARGET}")"'


def _existing_output(dest: Path) -> dict:
    """Datos para preguntar antes de reemplazar una conversión anterior."""
    if not dest.exists():
        return {"output_exists": False}
    when = datetime.fromtimestamp(dest.stat().st_mtime).strftime("%d/%m/%Y %H:%M")
    return {"output_exists": True, "output_modified": when}


def _free_name(dest: Path) -> Path:
    """`x_CREATOR5_PRO (2).3mf`, `(3)`… el primero que no exista."""
    n = 2
    while (candidate := dest.with_name(f"{dest.stem} ({n}){dest.suffix}")).exists():
        n += 1
    return candidate


def _available_apps() -> list[dict]:
    return [{"key": k, "label": name} for k, (name, bundle) in OPEN_APPS.items() if bundle.exists()]


def _project_path(ctx) -> Path | None:
    """Ruta absoluta del proyecto abierto.

    OrcaSlicer 2.5 expone `project_path` en el plater (no documentado en la
    wiki); si no está, se usa `ctx.name` del evento ProjectOpened.
    """
    candidates = []
    plater = getattr(orca.host, "plater", None)
    try:
        plater = plater() if callable(plater) else plater
        value = getattr(plater, "project_path", None)
        candidates.append(value() if callable(value) else value)
    except Exception as e:  # API alpha: registrar y seguir
        log.warning("plater.project_path no disponible: %s", e)
    candidates.append(getattr(ctx, "name", None))
    for c in candidates:
        if c and str(c).lower().endswith(".3mf") and os.path.isabs(str(c)):
            return Path(str(c))
    log.info("no se pudo obtener una ruta absoluta del proyecto (candidatos: %r)", candidates)
    return None


class Creator5ProConverter(orca.script.ScriptPluginCapabilityBase):
    def __init__(self):
        super().__init__()
        self._panel = None
        self._path: Path | None = None
        self._project = None      # Project3MF cargado (se reutiliza entre vista previa y conversión)
        self._lib = None
        self._last: dict | None = None  # último mensaje enviado, para reenviarlo en "ready"
        self._cached = None  # (boquilla, ConversionResult) de la última vista previa
        self._output: Path | None = None  # último .3mf convertido, para "Abrir en…"
        self._language_set = False

    def get_name(self):
        return CAPABILITY_NAME

    def execute(self, *args, **kwargs):
        return orca.ExecutionResult.skipped("solo reacciona al abrir proyectos")

    def get_default_config(self):
        return {"profiles_dir": "", SAME_WINDOW_OPTION: False}

    def _config(self) -> dict:
        try:
            return json.loads(self.get_config() or "{}")
        except (TypeError, ValueError):
            return {}

    def _same_window(self) -> bool:
        return bool(self._config().get(SAME_WINDOW_OPTION, False))

    # --- eventos ---------------------------------------------------------
    def on_lifecycle_event(self, event, ctx):
        if not self._language_set:
            i18n.set_language(_orca_language())
            self._language_set = True
        if event == orca.LifecycleEvent.ProjectClosed:
            self._project = self._cached = None
            return
        if event != orca.LifecycleEvent.ProjectOpened:
            return
        path = _project_path(ctx)
        if path is None or path.stem.endswith(creator5pro.OUTPUT_SUFFIX):
            return
        try:
            kind = read_3mf.detect_source(read_3mf.peek(path))
        except Exception as e:
            log.warning("no se pudo leer %s: %s", path, e)
            return
        if kind not in CONVERTIBLE:
            return
        ui = orca.host.ui
        ui.push_notification(
            ui.NotificationLevel.RegularNotificationLevel,
            t("plugin.notify.project_from", source=SOURCE_NAMES[kind]),
            hyper_text=t("plugin.notify.convert_link", target=creator5pro.DISPLAY_NAME),
            on_click=lambda: self._open(path),
        )

    # --- panel -------------------------------------------------------------
    def _open(self, path: Path) -> bool:
        if path != self._path:
            self._path, self._project, self._cached = path, None, None
        self._last = {"type": "busy", "text": t("plugin.busy.analyzing", name=path.name)}
        try:
            if self._panel is not None and self._panel.is_open():
                self._panel.show()
                self._send_preview()
            else:
                self._panel = orca.host.ui.create_dock_panel(
                    html=PAGE, title="BetterBridge", width=440, height=640,
                    on_message=self._on_message, on_close=self._on_close, dock="right")
        except Exception:
            log.exception("no se pudo abrir el panel")
        return True

    def _post(self, msg: dict) -> None:
        self._last = msg
        if self._panel is not None:
            self._panel.post(msg)
            log.info("enviado al panel: %s", msg.get("type"))

    def _on_message(self, data):
        if not isinstance(data, dict):
            return
        kind = data.get("type")
        log.info("mensaje del panel: %s", kind)
        if kind == "ready":
            # Primera carga de la página: calcular la vista previa.
            if self._last and self._last.get("type") != "busy":
                self._panel.post(self._last)
            else:
                self._run(self._send_preview)
        elif kind == "preview":
            self._run(self._send_preview, data.get("nozzle"))
        elif kind == "convert":
            self._run(self._convert, data.get("nozzle"), data.get("map"), data.get("overwrite"))
        elif kind == "open":
            self._run(self._open_output, data.get("app"))
        elif kind == "option" and data.get("key") == "same_window":
            cfg = self._config()
            cfg[SAME_WINDOW_OPTION] = data.get("value") == "on"
            self.save_config(json.dumps(cfg))
            log.info("opción %s = %s", SAME_WINDOW_OPTION, cfg[SAME_WINDOW_OPTION])

    def _run(self, fn, *args) -> None:
        """Ejecuta el trabajo en el hilo de la interfaz (~1 s con proyectos de 30 MB).

        Sin hilo de fondo: el tiempo es corto y así no hace falta el permiso de
        hilos de Orca (uno por plugin). El panel ya muestra "Convirtiendo…".
        """
        log.info("inicio %s", fn.__name__)
        try:
            fn(*args)
            log.info("fin %s", fn.__name__)
        except Exception as e:  # el plugin nunca debe tumbar el slicer
            log.exception("error en %s", fn.__name__)
            self._post({"type": "error", "text": t("plugin.error.unexpected", detail=e)})

    def _open_output(self, app_key: str | None) -> None:
        if not self._output or app_key not in OPEN_APPS:
            return
        name = OPEN_APPS[app_key][0]
        if app_key == "orca" and self._same_window():
            try:
                url = serve_once(self._output)
            except OSError as e:
                log.warning("servidor local no disponible (%s); se abre en otra ventana", e)
                self._notify(t("plugin.notify.same_window_unavailable", detail=e))
            else:
                OPEN_URL_TARGET.write_text(quote(url, safe=""), encoding="utf-8")
                code = os.system(_open_url_command())
                log.info("abrir %s en la ventana actual vía %s: código %s", self._output.name, url, code)
                return
        OPEN_TARGET.write_text(str(self._output), encoding="utf-8")
        code = os.system(_open_command(name))
        log.info("abrir %s en %s: código %s", self._output.name, name, code)
        if code != 0:
            self._notify(t("plugin.notify.open_failed", name=self._output.name, app=name))

    def _notify(self, text: str) -> None:
        ui = orca.host.ui
        ui.push_notification(ui.NotificationLevel.WarningNotificationLevel, text)

    def _on_close(self):
        self._panel = None

    # --- lógica ------------------------------------------------------------
    def _load(self):
        if self._lib is None:
            self._lib = ProfileLibrary.load(find_root(self._config().get("profiles_dir") or None))
        if self._project is None:
            self._project = read_3mf.load(self._path)
        return self._project, self._lib

    def _send_preview(self, nozzle: str | None = None) -> None:
        project, lib = self._load()
        result = convert(project, lib, nozzle=nozzle)
        # Si se convierte sin tocar la tabla, se reutiliza este cálculo.
        self._cached = (result.report.presets.get("nozzle"), result)
        rep = result.report
        needs_map = rep.needs_map
        errors = rep.errors
        n = len(rep.filaments)
        filaments = []
        for f in rep.filaments:
            plates = sorted((p for p, used in result.usage.items() if used is None or f.index in used), key=str)
            ext = next(iter(f.extruders.values()), None) or (f.index if f.index <= creator5pro.EXTRUDERS else 1)
            filaments.append({"index": f.index, "type": f.source_type, "colour": f.colour,
                              "source": f.source_profile, "target": f.target_profile,
                              "plates": plates, "extruder": ext})
        # Los errores de asignación se resuelven en la tabla del panel; cualquier otro bloquea.
        blocking = bool(rep.errors) and not needs_map
        self._post({
            "type": "preview",
            "project": self._path.name,
            "source_kind": SOURCE_NAMES.get(rep.source_kind, rep.source_kind),
            "target": creator5pro.DISPLAY_NAME,
            "extruders": creator5pro.EXTRUDERS,
            "nozzle": rep.presets.get("nozzle", creator5pro.DEFAULT_NOZZLE),
            "nozzles": list(creator5pro.NOZZLES),
            "process": rep.presets.get("process", ""),
            "filaments": filaments,
            "needs_map": needs_map and n > 0,
            "blocking": blocking,
            "errors": errors,
            "warnings": rep.warnings,
            "output_name": write_3mf.output_path(self._path, creator5pro.OUTPUT_SUFFIX).name,
            **_existing_output(write_3mf.output_path(self._path, creator5pro.OUTPUT_SUFFIX)),
        })

    def _convert(self, nozzle: str | None, mapping: str | None, overwrite: str | None = None) -> None:
        project, lib = self._load()
        user_map = parse_map(mapping) if mapping else None
        dest = write_3mf.output_path(self._path, creator5pro.OUTPUT_SUFFIX)
        if dest.exists():
            if overwrite == "copy":
                dest = _free_name(dest)
            elif overwrite != "replace":
                # La página pregunta antes; esto cubre el caso de que el archivo
                # haya aparecido después de la vista previa.
                self._post({"type": "confirm", "output_name": dest.name, **_existing_output(dest)})
                return
        report_path = dest.with_suffix(".report.json")
        cached, self._cached = self._cached, None
        if user_map is None and cached and cached[0] == nozzle:
            result = cached[1]
            log.info("convertir: se reutiliza la vista previa")
        else:
            result = convert(project, lib, nozzle=nozzle, user_map=user_map)
        report = result.report
        if report.ok:
            log.info("escribiendo %s", dest)
            write_3mf.write(project, dest, result.files, result.removed, force=True)
            report.output = str(dest)
            report.errors.extend(write_3mf.verify(project, dest, result.files))
            report_path.write_text(report.to_json(), encoding="utf-8")
            log.info("escrito %s (errores: %d)", dest.name, len(report.errors))
        else:
            log.info("no convertido: %s", report.errors)
        self._post({
            "type": "result",
            "ok": report.ok,
            "project_name": self._path.name,
            "output": report.output,
            "output_name": dest.name,
            "report_name": report_path.name,
            "report": report.to_dict(),
            "open_apps": _available_apps() if report.ok else [],
            "same_window": self._same_window(),
        })
        self._output = dest if report.ok else None
        level = orca.host.ui.NotificationLevel
        orca.host.ui.push_notification(
            level.RegularNotificationLevel if report.ok else level.WarningNotificationLevel,
            t("plugin.notify.created", name=dest.name) if report.ok else t("plugin.notify.failed"))


@orca.plugin
class BetterBridgePlugin(orca.base):
    def register_capabilities(self):
        orca.request_permissions(
            # Perfiles de Flash Studio (solo lectura) y carpetas habituales de proyectos.
            fs_read=[f"{root}/*" for root in map(str, DEFAULT_ROOTS)] + USER_FOLDERS,
            fs_readwrite=USER_FOLDERS,
            # Comandos fijos de "Abrir en…" (Orca los autoriza por texto exacto).
            # El puerto local y el hilo de la opción experimental se piden al usarla.
            process=[_open_command(name) for name, bundle in OPEN_APPS.values() if bundle.exists()]
            + ([_open_url_command()] if OPEN_APPS["orca"][1].exists() else []),
        )
        orca.register_capability(Creator5ProConverter)
