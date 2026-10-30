"""Página HTML del panel del plugin (vista previa + resultado).

Protocolo con Python (window.orca.postMessage / orca.onMessage):
  página -> plugin: {type: "ready"} | {type: "convert", nozzle, map?: "1:1,2:3"}
                    | {type: "preview", nozzle} | {type: "open", app: "orca" | "flash"}
                    | {type: "option", key: "same_window", value: "on" | "off"}
                    convert lleva además overwrite: "replace" | "copy" si ya existe la salida
  plugin -> página: también {type: "confirm", output_name, output_modified} si
                    llega convert sin overwrite y la salida ya existe
  Ojo: el shim de Orca (`window.orca.postMessage`) traga cualquier excepción de JS,
  así que un error en la página no deja rastro; probar la página con
  tests/test_plugin.py::test_panel_flow_in_browser_dom.
  plugin -> página: {type: "busy", text} | {type: "preview", ...} | {type: "result", ...}
                    | {type: "error", text}
"""

PAGE = r"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
  --bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--card:#f6f8fa;
  --accent:#009688;--accent-fg:#ffffff;--warn-bg:#fff8c5;--warn-fg:#7d4e00;
  --err-bg:#ffebe9;--err-fg:#a40e26;--ok-bg:#dafbe1;--ok-fg:#116329;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#1e1f22;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--card:#26282c;
  --accent:#26a69a;--accent-fg:#0d1117;--warn-bg:#3b2e05;--warn-fg:#e3b341;
  --err-bg:#3d1214;--err-fg:#ff7b72;--ok-bg:#0f2e1a;--ok-fg:#56d364;
}}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:var(--bg);color:var(--fg);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
h1{font-size:15px;margin:0 0 2px}
.sub{color:var(--muted);font-size:12px;margin-bottom:12px;word-break:break-all}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:5px 4px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
code,.mono{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.sw{display:inline-block;width:14px;height:14px;border-radius:4px;border:1px solid var(--line);vertical-align:-2px}
select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 4px;font:inherit}
button{font:inherit;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
button:disabled{opacity:.5;cursor:default}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.msg{border-radius:6px;padding:7px 9px;margin:0 0 6px;font-size:12px}
.msg.warn{background:var(--warn-bg);color:var(--warn-fg)}
.msg.err{background:var(--err-bg);color:var(--err-fg)}
.msg.ok{background:var(--ok-bg);color:var(--ok-fg)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px;text-align:center}
.stat b{display:block;font-size:17px}
.stat span{color:var(--muted);font-size:10.5px}
details{border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:var(--card)}
summary{cursor:pointer;padding:8px 10px;font-weight:600;list-style:none;display:flex;justify-content:space-between}
summary::-webkit-details-marker{display:none}
summary .n{color:var(--muted);font-weight:400}
details>div{padding:0 10px 10px;max-height:320px;overflow:auto}
input[type=search]{width:100%;margin-bottom:6px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font:inherit}
.muted{color:var(--muted)}
.miss{color:var(--err-fg);font-weight:600}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s 0.8s linear infinite;vertical-align:-3px;margin-right:6px}
@keyframes s{to{transform:rotate(360deg)}}
.hidden{display:none}
</style></head>
<body>
<div id="app"><p class="muted"><span class="spinner"></span>Cargando…</p></div>
<script>
(function(){
  var state = {preview:null, map:{}, dirty:false};
  var app = document.getElementById('app');

  function esc(v){
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') v = JSON.stringify(v);
    return v.replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});
  }
  function short(v, n){
    var s = (v === null || v === undefined) ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
    s = s.replace(/\n/g, ' ⏎ ');
    n = n || 70;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  var lastRequest = null, watchdog = null;
  function send(msg){
    lastRequest = msg;
    orca.postMessage(msg);
  }
  function busy(text){
    app.innerHTML = '<p class="muted"><span class="spinner"></span>' + esc(text) + '</p>';
    clearTimeout(watchdog);
    // Si el plugin no contesta, no dejar el panel colgado.
    watchdog = setTimeout(function(){
      app.innerHTML = '<div class="msg err">El plugin no respondió en 30 s.</div>' +
        '<p class="muted">Detalle en orca_plugins/plugin_data/betterbridge/debug.log</p>' +
        '<div class="actions"><button id="retry" class="primary">Reintentar</button></div>';
      document.getElementById('retry').addEventListener('click', function(){
        busy('Reintentando…'); orca.postMessage(lastRequest || {type:'ready'});
      });
    }, 30000);
  }
  function msgs(list, cls){ return (list || []).map(function(t){return '<div class="msg ' + cls + '">' + esc(t) + '</div>';}).join(''); }

  // ---------- vista previa ----------
  function renderPreview(p){
    state.preview = p;
    if (!state.dirty) {
      state.map = {};
      p.filaments.forEach(function(f){ state.map[f.index] = f.extruder || 1; });
      // Sin asignación automática posible: la tabla es la asignación.
      if (p.needs_map) state.dirty = true;
    }
    var rows = p.filaments.map(function(f){
      var opts = '';
      for (var e = 1; e <= p.extruders; e++) opts += '<option value="' + e + '"' + (state.map[f.index] == e ? ' selected' : '') + '>E' + e + '</option>';
      var target = f.target ? esc(f.target) : '<span class="miss">sin equivalente</span>';
      var used = f.plates.length ? 'placa ' + f.plates.join(', ') : '<span class="muted">sin uso</span>';
      return '<tr><td><span class="sw" style="background:' + esc(f.colour) + '"></span></td>' +
        '<td>#' + f.index + ' ' + esc(f.type) + '<br><span class="muted">' + esc(short(f.source, 40)) + '</span></td>' +
        '<td>' + target + '<br><span class="muted">' + used + '</span></td>' +
        '<td><select data-f="' + f.index + '"' + (f.plates.length ? '' : ' disabled') + '>' + opts + '</select></td></tr>';
    }).join('');
    var nozzles = p.nozzles.map(function(n){ return '<option' + (n === p.nozzle ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
    var high = Object.keys(state.map).some(function(k){ return state.map[k] > 2; });
    var manualNote = state.dirty && high
      ? '<div class="msg warn">Asignación manual en E3/E4: Flash Studio la respeta; OrcaSlicer 2.5 la rechaza al laminar. Lamina en Flash Studio.</div>' : '';
    app.innerHTML =
      '<h1>Convertir a ' + esc(p.target) + '</h1>' +
      '<div class="sub">' + esc(p.project) + ' · origen: ' + esc(p.source_kind) + '</div>' +
      msgs(p.errors, 'err') + manualNote +
      '<div class="card"><div class="label">Filamentos → extrusores</div>' +
      '<table><thead><tr><th></th><th>Origen</th><th>Perfil C5P</th><th>Ext.</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="card"><div class="label">Impresora y proceso</div>' +
      '<div class="row">Boquilla <select id="nozzle">' + nozzles + '</select> mm</div>' +
      '<div class="muted" style="margin-top:6px">' + esc(p.process || '') + '</div></div>' +
      (p.warnings && p.warnings.length ? '<details><summary>Avisos previos <span class="n">' + p.warnings.length + '</span></summary><div>' + msgs(p.warnings, 'warn') + '</div></details>' : '') +
      '<div class="card muted">Se crea <code>' + esc(p.output_name) + '</code> junto al original. El original no se modifica.</div>' +
      '<div class="actions"><button id="go" class="primary"' + (p.blocking ? ' disabled' : '') + '>Convertir</button></div>';
    Array.prototype.forEach.call(app.querySelectorAll('select[data-f]'), function(s){
      s.addEventListener('change', function(){ state.map[s.getAttribute('data-f')] = parseInt(s.value, 10); state.dirty = true; renderPreview(state.preview); });
    });
    document.getElementById('nozzle').addEventListener('change', function(e){ busy('Recalculando…'); send({type:'preview', nozzle:String(e.target.value)}); });
    document.getElementById('go').addEventListener('click', function(){
      // Leer el formulario ANTES de busy(): busy() reemplaza el HTML y el <select> deja de existir.
      var msg = {type:'convert', nozzle: String(document.getElementById('nozzle').value)};
      if (state.dirty) msg.map = Object.keys(state.map).map(function(k){ return k + ':' + state.map[k]; }).join(',');
      if (p.output_exists) { renderConfirm(msg, p); return; }
      busy('Convirtiendo…');
      send(msg);
    });
  }

  // ---------- ya existe una conversión ----------
  function renderConfirm(msg, info){
    app.innerHTML =
      '<h1>Ya existe una conversión</h1>' +
      '<div class="msg warn"><b>' + esc(info.output_name) + '</b>' +
      (info.output_modified ? ' (' + esc(info.output_modified) + ')' : '') + ' ya está en la carpeta del proyecto.</div>' +
      '<p class="muted">Reemplazarlo sustituye el archivo y su reporte. «Guardar como copia» crea un archivo nuevo con número.</p>' +
      '<div class="actions"><button id="cancel">Cancelar</button><button id="copy">Guardar como copia</button>' +
      '<button id="replace" class="primary">Reemplazar</button></div>';
    function go(mode){ msg.overwrite = mode; busy('Convirtiendo…'); send(msg); }
    document.getElementById('replace').addEventListener('click', function(){ go('replace'); });
    document.getElementById('copy').addEventListener('click', function(){ go('copy'); });
    document.getElementById('cancel').addEventListener('click', function(){ renderPreview(state.preview); });
  }

  // ---------- resultado ----------
  function openHint(sameWindow){
    return sameWindow
      ? 'OrcaSlicer lo carga en esta ventana (experimental).'
      : 'OrcaSlicer lo abre en otra ventana: puedes comparar original y convertido.';
  }
  function table(head, rows){
    if (!rows.length) return '<p class="muted">Nada.</p>';
    return '<table><thead><tr>' + head.map(function(h){return '<th>' + h + '</th>';}).join('') + '</tr></thead><tbody>' +
      rows.map(function(r){ return '<tr>' + r.map(function(c){ return '<td class="mono">' + esc(short(c)) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table>';
  }
  function section(title, count, body, open){
    return '<details' + (open ? ' open' : '') + '><summary>' + title + ' <span class="n">' + count + '</span></summary><div>' + body + '</div></details>';
  }
  function renderResult(r){
    var rep = r.report;
    var head = r.ok
      ? '<div class="msg ok">✓ Convertido: <b>' + esc(r.output_name) + '</b></div>'
      : '<div class="msg err">No se pudo convertir.</div>';
    var stats = '<div class="stats">' +
      [['Cambiados', rep.changed.length], ['Del autor', rep.kept_author.length],
       ['Por objeto', rep.object_overrides.length], ['Avisos', rep.warnings.length]]
      .map(function(s){ return '<div class="stat"><b>' + s[1] + '</b><span>' + s[0] + '</span></div>'; }).join('') + '</div>';
    var fil = table(['#', 'Origen', 'C5P', 'Extrusor'], rep.filaments.map(function(f){
      var ext = Object.keys(f.extruders).map(function(p){ return 'P' + p + '→E' + f.extruders[p]; }).join(' ');
      return [f.index + ' ' + f.source_type, f.source_profile, f.target_profile || 'SIN EQUIVALENTE', ext || 'sin uso'];
    }));
    var changedRows = rep.changed.map(function(c){ return [c.key, c.original, c.final, c.reason]; });
    app.innerHTML =
      '<h1>' + esc(r.project_name) + '</h1><div class="sub">' + esc(r.output || '') + '</div>' + head +
      msgs(rep.errors, 'err') + (r.ok ? stats : '') +
      (rep.warnings.length ? section('Advertencias', rep.warnings.length, msgs(rep.warnings, 'warn'), true) : '') +
      (rep.notes && rep.notes.length ? '<div class="card muted">' + rep.notes.map(esc).join('<br>') + '</div>' : '') +
      section('Filamentos', rep.filaments.length, fil, !r.ok) +
      section('Ajustes del autor conservados', rep.kept_author.length,
        table(['Clave', 'Valor', 'Perfil C5P'], rep.kept_author.map(function(c){ return [c.key, c.original, c.final]; }))) +
      section('Overrides por objeto / pieza', rep.object_overrides.length,
        table(['Objeto', 'Clave', 'Valor', 'Motivo'], rep.object_overrides.map(function(o){
          return [o.object + (o.part ? ' / ' + o.part : ''), o.key, o.original === o.final ? o.final : o.original + ' → ' + o.final, o.reason]; }))) +
      section('Descartados', rep.dropped.length,
        table(['Clave', 'Valor', 'Motivo'], rep.dropped.map(function(c){ return [c.key, c.original, c.reason]; }))) +
      (rep.positions.length ? section('Posición en el plato', rep.positions.length,
        table(['Objeto', 'Antes', 'Después'], rep.positions.map(function(c){ return [c.key, c.original, c.final]; }))) : '') +
      section('Todos los campos cambiados', rep.changed.length,
        '<input type="search" id="q" placeholder="Filtrar por clave o motivo">' + '<div id="chg">' + table(['Clave', 'Antes', 'Después', 'Motivo'], changedRows) + '</div>') +
      (r.ok ? '<div class="card"><div class="label">Abrir el archivo convertido</div><div class="row">' +
        (r.open_apps || []).map(function(a){ return '<button class="primary" data-open="' + esc(a.key) + '">Abrir en ' + esc(a.label) + '</button>'; }).join('') +
        '</div><div class="muted" style="margin-top:6px" id="openhint">' + openHint(r.same_window) + '</div>' +
        ((r.open_apps || []).some(function(a){ return a.key === 'orca'; })
          ? '<label class="muted" style="display:block;margin-top:8px"><input type="checkbox" id="samewin"' + (r.same_window ? ' checked' : '') +
            '> Experimental: abrir en esta ventana de OrcaSlicer (servidor local; deja una copia en Descargas)</label>' : '') +
        '<div class="muted" style="margin-top:6px">Reporte: <code>' + esc(r.report_name) + '</code></div></div>' : '') +
      '<div class="actions"><button id="back">Volver</button><button id="close">Cerrar</button></div>';
    var q = document.getElementById('q');
    q.addEventListener('input', function(){
      var t = q.value.toLowerCase();
      document.getElementById('chg').innerHTML = table(['Clave', 'Antes', 'Después', 'Motivo'],
        changedRows.filter(function(r){ return (r[0] + ' ' + r[3]).toLowerCase().indexOf(t) >= 0; }));
    });
    Array.prototype.forEach.call(app.querySelectorAll('button[data-open]'), function(b){
      b.addEventListener('click', function(){
        send({type:'open', app: b.getAttribute('data-open')});
        b.textContent = 'Abriendo…'; b.disabled = true;
        setTimeout(function(){ b.disabled = false; b.textContent = 'Abrir en ' + b.getAttribute('data-label'); }, 4000);
      });
      b.setAttribute('data-label', b.textContent.replace(/^Abrir en /, ''));
    });
    var samewin = document.getElementById('samewin');
    if (samewin) samewin.addEventListener('change', function(){
      r.same_window = samewin.checked;
      document.getElementById('openhint').textContent = openHint(r.same_window);
      send({type:'option', key:'same_window', value: samewin.checked ? 'on' : 'off'});
    });
    document.getElementById('back').addEventListener('click', function(){ state.dirty = false; busy('Cargando…'); send({type:'preview'}); });
    document.getElementById('close').addEventListener('click', function(){ orca.close(); });
  }

  orca.onMessage(function(m){
    if (!m || !m.type) return;
    if (m.type !== 'busy') clearTimeout(watchdog);
    if (m.type === 'busy') busy(m.text);
    else if (m.type === 'preview') renderPreview(m);
    else if (m.type === 'result') renderResult(m);
    else if (m.type === 'confirm') renderConfirm(lastRequest || {type:'convert'}, m);
    else if (m.type === 'error') app.innerHTML = '<div class="msg err">' + esc(m.text) + '</div>';
  });
  busy('Cargando…');
  send({type:'ready'});
})();
</script></body></html>
"""
