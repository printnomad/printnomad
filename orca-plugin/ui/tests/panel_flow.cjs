// Ejecuta el panel del plugin en jsdom con el shim real de OrcaSlicer y simula
// el uso: cargar, vista previa, cambiar extrusor, convertir, ver resultado.
// Uso: node panel_flow.js <panel.html>   (sale con código 1 si algo falla)
//
// El shim es copia de ORCA_BRIDGE_JS (src/slic3r/GUI/Widgets/WebHosting.cpp,
// OrcaSlicer 2.5): traga las excepciones, por eso un error de la página no deja
// rastro en Orca y hay que probarla aquí.
"use strict";
const fs = require("fs");
const { JSDOM } = require("jsdom");

const ORCA_BRIDGE_JS = `(function () {
  if (window.top !== window.self) return;
  if (window.orca) return;
  var handlers = [];
  function send(kind, data) {
    try {
      window.wx.postMessage(JSON.stringify({
        channel: 'orca', kind: kind, data: (data === undefined ? null : data)
      }));
    } catch (e) { /* bridge not ready yet */ }
  }
  window.orca = {
    postMessage: function (d) { send('message', d); },
    submit:      function (d) { send('submit', d); },
    close:       function ()  { send('close'); },
    onMessage:   function (cb) { if (typeof cb === 'function') handlers.push(cb); }
  };
  window.__orcaDispatch = function (payload) {
    var data = payload ? payload.data : null;
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](data); } catch (e) {}
    }
  };
})();`;

const PREVIEW = {
  type: "preview", project: "p.3mf", source_kind: "Bambu Studio", target: "Flashforge Creator 5 Pro",
  extruders: 4, nozzle: "0.4", nozzles: ["0.4", "0.25", "0.6", "0.8"], process: "0.20mm Standard @FF C5",
  filaments: [
    { index: 1, type: "PLA", colour: "#FF0000", source: "Bambu PLA Basic", target: "Flashforge PLA Basic @FF C5P", plates: ["1"], extruder: 1 },
    { index: 2, type: "PLA", colour: "#00FF00", source: "Bambu PLA Basic", target: "Flashforge PLA Basic @FF C5P", plates: ["1"], extruder: 2 },
  ],
  blocking: false, errors: [], warnings: ["aviso"], output_name: "p_CREATOR5_PRO.3mf",
};
const RESULT = {
  type: "result", ok: true, project_name: "p.3mf", output: "/x/p_CREATOR5_PRO.3mf",
  output_name: "p_CREATOR5_PRO.3mf", report_name: "p_CREATOR5_PRO.report.json",
  open_apps: [{ key: "orca", label: "OrcaSlicer" }, { key: "flash", label: "Flash Studio" }],
  same_window: false,
  report: {
    changed: [{ key: "printer_model", original: "Bambu Lab A1", final: "Flashforge Creator 5 Pro", reason: "perfil" }],
    kept_author: [{ key: "sparse_infill_speed", original: "300", final: "270", reason: "autor" }],
    object_overrides: [{ object: "obj", part: "p", key: "inner_wall_speed", original: "50", final: "50", reason: "conservado" }],
    dropped: [], positions: [], warnings: ["w"], notes: ["n"], errors: [],
    filaments: [{ index: 1, source_type: "PLA", source_profile: "Bambu PLA", target_profile: "FF PLA", extruders: { "1": 1 } }],
  },
};

function fail(msg) { console.error("FALLA: " + msg); process.exit(1); }

const html = fs.readFileSync(process.argv[2], "utf8");
const sent = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  beforeParse(window) {
    window.wx = { postMessage: (s) => sent.push(JSON.parse(s)) };
    window.eval(ORCA_BRIDGE_JS);
    // Los errores de la página se muestran aquí aunque el shim los trague.
    window.addEventListener("error", (e) => fail("error de JS en la página: " + e.message));
  },
});
const { window } = dom;
const doc = window.document;
const dispatch = (data) => window.__orcaDispatch({ data });
const last = () => sent[sent.length - 1];
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const change = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("change", { bubbles: true })); };

// 1. carga -> "ready"
if (!last() || last().kind !== "message" || last().data.type !== "ready") fail("no se envió ready");

// 2. vista previa
dispatch(PREVIEW);
const go = doc.getElementById("go");
if (!go) fail("no hay botón Convertir");
if (doc.querySelectorAll("select[data-f]").length !== 2) fail("faltan selectores de extrusor");

// 3. convertir sin tocar la tabla
click(go);
let m = last().data;
if (m.type !== "convert") fail("Convertir no envió 'convert' (último: " + JSON.stringify(m) + ")");
if (m.nozzle !== "0.4" || "map" in m) fail("mensaje convert inesperado: " + JSON.stringify(m));
if (!doc.body.textContent.includes("Convirtiendo")) fail("no muestra 'Convirtiendo…'");

// 4. resultado
dispatch(RESULT);
if (!doc.body.textContent.includes("Convertido")) fail("no muestra el resultado");
const openBtn = doc.querySelector('button[data-open="flash"]');
if (!openBtn || !openBtn.textContent.includes("Flash Studio")) fail("falta el botón Abrir en Flash Studio");
click(openBtn);
m = last().data;
if (m.type !== "open" || m.app !== "flash") fail("Abrir no envió 'open': " + JSON.stringify(m));
const samewin = doc.getElementById("samewin");
if (!samewin || samewin.checked) fail("falta la casilla experimental (desmarcada por defecto)");
if (!doc.getElementById("openhint").textContent.includes("otra ventana")) fail("texto por defecto incorrecto");
samewin.checked = true;
samewin.dispatchEvent(new window.Event("change", { bubbles: true }));
m = last().data;
if (m.type !== "option" || m.key !== "same_window" || m.value !== "on") fail("la casilla no envió la opción: " + JSON.stringify(m));
if (!doc.getElementById("openhint").textContent.includes("esta ventana")) fail("el texto no cambió al activar");
const back = doc.getElementById("back");
if (!back) fail("no hay botón Volver");
click(back);
if (last().data.type !== "preview") fail("Volver no pidió la vista previa");

// 5. vista previa otra vez, cambiar extrusor y boquilla, convertir con mapa
dispatch(PREVIEW);
change(doc.querySelector('select[data-f="2"]'), "3");
change(doc.getElementById("nozzle"), "0.6");
if (last().data.type !== "preview" || last().data.nozzle !== "0.6") fail("cambiar boquilla no recalculó");
dispatch(Object.assign({}, PREVIEW, { nozzle: "0.6" }));
click(doc.getElementById("go"));
m = last().data;
if (m.type !== "convert" || m.map !== "1:1,2:3" || m.nozzle !== "0.6") fail("convert con mapa incorrecto: " + JSON.stringify(m));
if (!doc.body.textContent.includes("Convirtiendo")) fail("no muestra 'Convirtiendo…' (con mapa)");

// 6. ya existe la salida: preguntar; cancelar vuelve; copia y reemplazo envían overwrite
const EXISTS = Object.assign({}, PREVIEW, { output_exists: true, output_modified: "30/10/2026 10:45" });
dispatch(EXISTS);
let before = sent.length;
click(doc.getElementById("go"));
if (sent.length !== before) fail("con salida existente no debe enviar sin confirmar");
if (!doc.body.textContent.includes("Ya existe una conversión")) fail("no pregunta si reemplazar");
click(doc.getElementById("cancel"));
if (!doc.getElementById("go")) fail("Cancelar no volvió a la vista previa");
click(doc.getElementById("go"));
click(doc.getElementById("copy"));
if (last().data.type !== "convert" || last().data.overwrite !== "copy") fail("copia: " + JSON.stringify(last().data));
dispatch(EXISTS);
click(doc.getElementById("go"));
click(doc.getElementById("replace"));
if (last().data.overwrite !== "replace") fail("reemplazar: " + JSON.stringify(last().data));
// el plugin también puede pedir confirmación (archivo creado tras la vista previa)
dispatch({ type: "confirm", output_name: "p_CREATOR5_PRO.3mf", output_modified: "x" });
if (!doc.getElementById("replace")) fail("no muestra la confirmación pedida por el plugin");
click(doc.getElementById("replace"));
if (last().data.type !== "convert" || last().data.overwrite !== "replace") fail("confirmación del plugin no reenvió convert");

// 7. cerrar
dispatch(RESULT);
click(doc.getElementById("close"));
if (last().kind !== "close") fail("Cerrar no llamó a orca.close()");

window.close();
console.log("OK: " + sent.length + " mensajes");
