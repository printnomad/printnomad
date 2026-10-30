"""HTML del panel: lo genera ui/ (Tailwind) y tools/build.py lo mete en la wheel.

El plugin sustituye `__BB_I18N__` por los textos `panel.*` del idioma activo.
"""

from __future__ import annotations

import json
from pathlib import Path

from .core import i18n

PAGE_FILE = Path(__file__).parent / "panel.html"
I18N_MARKER = "__BB_I18N__"
PANEL_PREFIX = "panel."


def panel_messages(lang: str | None = None) -> dict[str, str]:
    return {k: v for k, v in i18n.catalog(lang).items() if k.startswith(PANEL_PREFIX)}


def render(lang: str | None = None, template: str | None = None) -> str:
    """Página lista para `create_dock_panel` con los textos del idioma."""
    html = template if template is not None else PAGE_FILE.read_text(encoding="utf-8")
    # "</" escapado para que el JSON no pueda cerrar la etiqueta <script>.
    messages = json.dumps(panel_messages(lang), ensure_ascii=False).replace("</", "<\\/")
    return html.replace(I18N_MARKER, messages, 1)
