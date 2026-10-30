"""Experimental: servir un .3mf por HTTP local para abrirlo en la ventana actual de Orca.

Por qué: la URL orcaslicer://open?file=… es la única vía que carga un archivo en la
ventana ya abierta sin activar «Allow only one OrcaSlicer instance». Pero el
descargador de Orca solo termina (renombra y carga) si la respuesta tiene código
2xx (Http.cpp: `http_status >= 200 && < 300`), y una URL file:// devuelve 0: el
archivo se copia y se queda como `.download`. Sirviéndolo por http://127.0.0.1 el
código es 200 y Orca lo carga (una copia queda en su carpeta de descargas).

Un solo hilo (Orca concede uno por plugin) y un servidor de un solo hilo que se
cierra tras entregar el archivo o al agotar el tiempo.
"""

from __future__ import annotations

import http.server
import logging
import threading
import time
from pathlib import Path
from urllib.parse import quote

log = logging.getLogger("betterbridge")

HOST = "127.0.0.1"
PORT = 47811  # fijo para que el permiso de Orca (por texto exacto) se conceda una vez
TIMEOUT_S = 60


def serve_once(path: Path, port: int = PORT, timeout: float = TIMEOUT_S) -> str:
    """Arranca el servidor en un hilo y devuelve la URL del archivo.

    Lanza OSError si no puede abrir el puerto.
    """
    path = Path(path)
    data_name = quote(path.name)
    served = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (nombre del API de http.server)
            if self.path.split("?", 1)[0] != "/" + data_name:
                self.send_error(404)
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
            self.end_headers()
            self.wfile.write(body)
            served.set()

        def log_message(self, fmt, *args):
            log.info("servidor local: " + fmt, *args)

    server = http.server.HTTPServer((HOST, port), Handler, bind_and_activate=False)
    server.allow_reuse_address = True
    try:
        server.server_bind()
        server.server_activate()
    except OSError:
        server.server_close()
        raise
    server.timeout = 1.0  # handle_request vuelve cada segundo para revisar el plazo

    def run():
        deadline = time.monotonic() + timeout
        try:
            while not served.is_set() and time.monotonic() < deadline:
                server.handle_request()
        finally:
            server.server_close()
            log.info("servidor local cerrado (%s)", "entregado" if served.is_set() else "sin petición")

    threading.Thread(target=run, name="betterbridge-http", daemon=True).start()
    return f"http://{HOST}:{server.server_address[1]}/{data_name}"

