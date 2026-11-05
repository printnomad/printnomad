/* Panel del plugin PrintNomad para OrcaSlicer.
 *
 * Protocolo con Python (window.orca.postMessage / orca.onMessage):
 *   página -> plugin: {type: "ready"} | {type: "preview", nozzle}
 *                     | {type: "convert", nozzle, map?: "1:1,2:3", overwrite?: "replace" | "copy"}
 *                     | {type: "open", app: "orca" | "flash"}
 *                     | {type: "option", key: "same_window", value: "on" | "off"}
 *   plugin -> página: {type: "busy", text} | {type: "preview", ...} | {type: "result", ...}
 *                     | {type: "confirm", output_name, output_modified} | {type: "error", text}
 *
 * Ojo: el puente de Orca (window.orca.postMessage) traga cualquier excepción de JS, así
 * que un error aquí no deja rastro en Orca: probar con ui/tests/panel_flow.cjs (jsdom).
 *
 * Tailwind: solo se generan las clases escritas completas en este archivo. Las variantes
 * van en el objeto UI de abajo; nunca construir nombres de clase concatenando.
 */
(function () {
  'use strict';

  // ---------- estilos (clases completas de Tailwind) ----------
  var UI = {
    h1: 'm-0 mb-0.5 text-[15px] font-semibold',
    sub: 'mb-3 break-all text-xs text-muted',
    card: 'mb-2.5 rounded-lg border border-line bg-card p-2.5',
    label: 'mb-1.5 text-[11px] uppercase tracking-wide text-muted',
    muted: 'text-muted',
    row: 'flex flex-wrap items-center gap-2',
    actions: 'mt-1 flex justify-end gap-2',
    button: 'cursor-pointer rounded-md border border-line bg-surface px-3 py-1.5 text-fg disabled:cursor-default disabled:opacity-50',
    primary: 'cursor-pointer rounded-md border border-accent bg-accent px-3 py-1.5 font-semibold text-on-accent disabled:cursor-default disabled:opacity-50',
    select: 'rounded-md border border-line bg-surface px-1 py-0.5 text-fg',
    input: 'mb-1.5 w-full rounded-md border border-line bg-surface px-2 py-1 text-fg',
    table: 'w-full border-collapse text-xs',
    th: 'border-b border-line p-1 text-left align-top font-semibold text-muted',
    td: 'border-b border-line p-1 align-top',
    tdMono: 'border-b border-line p-1 align-top font-mono text-[11.5px] break-all',
    swatch: 'inline-block size-3.5 rounded border border-line align-[-2px]',
    missing: 'font-semibold text-err-fg',
    code: 'font-mono text-[11.5px] break-all',
    details: 'mb-2 rounded-lg border border-line bg-card',
    summary: 'flex cursor-pointer list-none justify-between px-2.5 py-2 font-semibold [&::-webkit-details-marker]:hidden',
    count: 'font-normal text-muted',
    detailsBody: 'max-h-80 overflow-auto px-2.5 pb-2.5',
    stats: 'mb-2.5 grid grid-cols-4 gap-1.5',
    stat: 'rounded-lg border border-line bg-card p-1.5 text-center',
    statValue: 'block text-[17px] font-semibold',
    statLabel: 'text-[10.5px] text-muted',
    spinner: 'mr-1.5 inline-block size-3.5 animate-spin rounded-full border-2 border-line border-t-accent align-[-3px]',
    checkbox: 'mr-1 align-middle accent-accent',
    msg: {
      warn: 'mb-1.5 rounded-md bg-warn-bg px-2.5 py-1.5 text-xs text-warn-fg',
      err: 'mb-1.5 rounded-md bg-err-bg px-2.5 py-1.5 text-xs text-err-fg',
      ok: 'mb-1.5 rounded-md bg-ok-bg px-2.5 py-1.5 text-xs text-ok-fg'
    }
  };

  // ---------- i18n ----------
  var MESSAGES = window.PN_I18N || {};

  function esc(v) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') v = JSON.stringify(v);
    return v.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Texto traducido; los {parámetros} se rellenan como texto (escapado). */
  function t(key, params) {
    return esc(tRaw(key, params));
  }

  function tRaw(key, params) {
    var text = MESSAGES[key] || key;
    return text.replace(/\{(\w+)\}/g, function (all, name) {
      return params && name in params ? String(params[name]) : all;
    });
  }

  /** Como t(), pero los parámetros ya son HTML (p. ej. un nombre dentro de <code>). */
  function tHtml(key, htmlParams) {
    var text = esc(MESSAGES[key] || key);
    return text.replace(/\{(\w+)\}/g, function (all, name) {
      return htmlParams && name in htmlParams ? htmlParams[name] : all;
    });
  }

  // ---------- utilidades ----------
  var app = document.getElementById('app');
  var state = { preview: null, map: {}, dirty: false };
  var lastRequest = null;
  var watchdog = null;
  var WATCHDOG_MS = 30000;

  function short(v, n) {
    var s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    s = s.replace(/\n/g, ' ⏎ ');
    n = n || 70;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function send(msg) {
    lastRequest = msg;
    orca.postMessage(msg);
  }

  function msgs(list, kind) {
    return (list || []).map(function (m) {
      return '<div class="' + UI.msg[kind] + '">' + esc(m) + '</div>';
    }).join('');
  }

  function button(id, labelKey, primary, extra) {
    return '<button id="' + id + '" class="' + (primary ? UI.primary : UI.button) + '"' + (extra || '') + '>' +
      t(labelKey) + '</button>';
  }

  function busy(text) {
    app.innerHTML = '<p class="' + UI.muted + '"><span class="' + UI.spinner + '"></span>' + esc(text) + '</p>';
    clearTimeout(watchdog);
    // Si el plugin no contesta, no dejar el panel colgado.
    watchdog = setTimeout(function () {
      app.innerHTML = '<div class="' + UI.msg.err + '">' + t('panel.timeout') + '</div>' +
        '<p class="' + UI.muted + '">' + t('panel.timeout_detail') + '</p>' +
        '<div class="' + UI.actions + '">' + button('retry', 'panel.retry', true) + '</div>';
      document.getElementById('retry').addEventListener('click', function () {
        busy(tRaw('panel.retrying'));
        orca.postMessage(lastRequest || { type: 'ready' });
      });
    }, WATCHDOG_MS);
  }

  function table(headKeys, rows) {
    if (!rows.length) return '<p class="' + UI.muted + '">' + t('panel.nothing') + '</p>';
    return '<table class="' + UI.table + '"><thead><tr>' +
      headKeys.map(function (k) { return '<th class="' + UI.th + '">' + t(k) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + r.map(function (c) {
          return '<td class="' + UI.tdMono + '">' + esc(short(c)) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function section(titleKey, count, body, open) {
    return '<details class="' + UI.details + '"' + (open ? ' open' : '') + '>' +
      '<summary class="' + UI.summary + '">' + t(titleKey) + ' <span class="' + UI.count + '">' + count + '</span></summary>' +
      '<div class="' + UI.detailsBody + '">' + body + '</div></details>';
  }

  // ---------- vista previa ----------
  function renderPreview(p) {
    state.preview = p;
    if (!state.dirty) {
      state.map = {};
      p.filaments.forEach(function (f) { state.map[f.index] = f.extruder || 1; });
      // Sin asignación automática posible: la tabla es la asignación.
      if (p.needs_map) state.dirty = true;
    }
    var rows = p.filaments.map(function (f) {
      var opts = '';
      for (var e = 1; e <= p.extruders; e++) {
        opts += '<option value="' + e + '"' + (state.map[f.index] == e ? ' selected' : '') + '>E' + e + '</option>';
      }
      var target = f.target ? esc(f.target) : '<span class="' + UI.missing + '">' + t('panel.no_equivalent') + '</span>';
      var used = f.plates.length
        ? t('panel.used_on', { plates: f.plates.join(', ') })
        : '<span class="' + UI.muted + '">' + t('panel.unused') + '</span>';
      return '<tr>' +
        '<td class="' + UI.td + '"><span class="' + UI.swatch + '" style="background:' + esc(f.colour) + '"></span></td>' +
        '<td class="' + UI.td + '">#' + f.index + ' ' + esc(f.type) +
        '<br><span class="' + UI.muted + '">' + esc(short(f.source, 40)) + '</span></td>' +
        '<td class="' + UI.td + '">' + target + '<br><span class="' + UI.muted + '">' + used + '</span></td>' +
        '<td class="' + UI.td + '"><select class="' + UI.select + '" data-f="' + f.index + '"' +
        (f.plates.length ? '' : ' disabled') + '>' + opts + '</select></td></tr>';
    }).join('');
    var nozzles = p.nozzles.map(function (n) {
      return '<option' + (n === p.nozzle ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
    var high = Object.keys(state.map).some(function (k) { return state.map[k] > 2; });
    var manualNote = state.dirty && high ? '<div class="' + UI.msg.warn + '">' + t('panel.manual_e34') + '</div>' : '';

    app.innerHTML =
      '<h1 class="' + UI.h1 + '">' + t('panel.title', { target: p.target }) + '</h1>' +
      '<div class="' + UI.sub + '">' + t('panel.subtitle', { project: p.project, source: p.source_kind }) + '</div>' +
      msgs(p.errors, 'err') + manualNote +
      '<div class="' + UI.card + '"><div class="' + UI.label + '">' + t('panel.filaments_to_extruders') + '</div>' +
      '<table class="' + UI.table + '"><thead><tr><th class="' + UI.th + '"></th>' +
      '<th class="' + UI.th + '">' + t('panel.col.source') + '</th>' +
      '<th class="' + UI.th + '">' + t('panel.col.target_profile') + '</th>' +
      '<th class="' + UI.th + '">' + t('panel.col.extruder_short') + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="' + UI.card + '"><div class="' + UI.label + '">' + t('panel.printer_and_process') + '</div>' +
      '<div class="' + UI.row + '">' + t('panel.nozzle') + ' <select id="nozzle" class="' + UI.select + '">' + nozzles +
      '</select> mm</div>' +
      '<div class="mt-1.5 ' + UI.muted + '">' + esc(p.process || '') + '</div></div>' +
      (p.warnings && p.warnings.length ? section('panel.section.warnings', p.warnings.length, msgs(p.warnings, 'warn')) : '') +
      '<div class="' + UI.card + ' ' + UI.muted + '">' +
      tHtml('panel.output_info', { name: '<code class="' + UI.code + '">' + esc(p.output_name) + '</code>' }) + '</div>' +
      '<div class="' + UI.actions + '">' + button('go', 'panel.convert', true, p.blocking ? ' disabled' : '') + '</div>';

    Array.prototype.forEach.call(app.querySelectorAll('select[data-f]'), function (s) {
      s.addEventListener('change', function () {
        state.map[s.getAttribute('data-f')] = parseInt(s.value, 10);
        state.dirty = true;
        renderPreview(state.preview);
      });
    });
    document.getElementById('nozzle').addEventListener('change', function (e) {
      busy(tRaw('panel.recalculating'));
      send({ type: 'preview', nozzle: String(e.target.value) });
    });
    document.getElementById('go').addEventListener('click', function () {
      // Leer el formulario ANTES de busy(): busy() reemplaza el HTML y el <select> deja de existir.
      var msg = { type: 'convert', nozzle: String(document.getElementById('nozzle').value) };
      if (state.dirty) {
        msg.map = Object.keys(state.map).map(function (k) { return k + ':' + state.map[k]; }).join(',');
      }
      if (p.output_exists) { renderConfirm(msg, p); return; }
      busy(tRaw('panel.converting'));
      send(msg);
    });
  }

  // ---------- ya existe una conversión ----------
  function renderConfirm(msg, info) {
    var name = '<b>' + esc(info.output_name) + '</b>' + (info.output_modified ? ' (' + esc(info.output_modified) + ')' : '');
    app.innerHTML =
      '<h1 class="' + UI.h1 + '">' + t('panel.exists.title') + '</h1>' +
      '<div class="' + UI.msg.warn + '">' + tHtml('panel.exists.detail', { name: name }) + '</div>' +
      '<p class="' + UI.muted + '">' + t('panel.exists.help') + '</p>' +
      '<div class="' + UI.actions + '">' + button('cancel', 'panel.cancel') + button('copy', 'panel.save_copy') +
      button('replace', 'panel.replace', true) + '</div>';
    function go(mode) { msg.overwrite = mode; busy(tRaw('panel.converting')); send(msg); }
    document.getElementById('replace').addEventListener('click', function () { go('replace'); });
    document.getElementById('copy').addEventListener('click', function () { go('copy'); });
    document.getElementById('cancel').addEventListener('click', function () { renderPreview(state.preview); });
  }

  // ---------- resultado ----------
  function openHint(sameWindow) {
    return t(sameWindow ? 'panel.open.hint_same_window' : 'panel.open.hint_new_window');
  }

  function renderResult(r) {
    var rep = r.report;
    var head = r.ok
      ? '<div class="' + UI.msg.ok + '">' + tHtml('panel.converted', { name: '<b>' + esc(r.output_name) + '</b>' }) + '</div>'
      : '<div class="' + UI.msg.err + '">' + t('panel.failed') + '</div>';
    var stats = '<div class="' + UI.stats + '">' +
      [['panel.stat.changed', rep.changed.length], ['panel.stat.designer', rep.kept_author.length],
        ['panel.stat.per_object', rep.object_overrides.length], ['panel.stat.warnings', rep.warnings.length]]
        .map(function (s) {
          return '<div class="' + UI.stat + '"><b class="' + UI.statValue + '">' + s[1] + '</b>' +
            '<span class="' + UI.statLabel + '">' + t(s[0]) + '</span></div>';
        }).join('') + '</div>';
    var fil = table(['panel.col.index', 'panel.col.source', 'panel.col.target', 'panel.col.extruder'],
      rep.filaments.map(function (f) {
        var ext = Object.keys(f.extruders).map(function (p) { return 'P' + p + '→E' + f.extruders[p]; }).join(' ');
        return [f.index + ' ' + f.source_type, f.source_profile, f.target_profile || tRaw('panel.no_equivalent'),
          ext || tRaw('panel.unused')];
      }));
    var changedHead = ['panel.col.key', 'panel.col.before', 'panel.col.after', 'panel.col.reason'];
    var changedRows = rep.changed.map(function (c) { return [c.key, c.original, c.final, c.reason]; });
    var apps = r.open_apps || [];
    var openCard = !r.ok ? '' :
      '<div class="' + UI.card + '"><div class="' + UI.label + '">' + t('panel.open.title') + '</div>' +
      '<div class="' + UI.row + '">' + apps.map(function (a) {
        return '<button class="' + UI.primary + '" data-open="' + esc(a.key) + '" data-label="' + esc(a.label) + '">' +
          t('panel.open.in', { app: a.label }) + '</button>';
      }).join('') + '</div>' +
      '<div id="openhint" class="mt-1.5 ' + UI.muted + '">' + openHint(r.same_window) + '</div>' +
      (apps.some(function (a) { return a.key === 'orca'; })
        ? '<label class="mt-2 block ' + UI.muted + '"><input type="checkbox" id="samewin" class="' + UI.checkbox + '"' +
          (r.same_window ? ' checked' : '') + '>' + t('panel.open.same_window_option') + '</label>' : '') +
      '<div class="mt-1.5 ' + UI.muted + '">' +
      tHtml('panel.report_file', { name: '<code class="' + UI.code + '">' + esc(r.report_name) + '</code>' }) + '</div></div>';

    app.innerHTML =
      '<h1 class="' + UI.h1 + '">' + esc(r.project_name) + '</h1><div class="' + UI.sub + '">' + esc(r.output || '') + '</div>' +
      head + msgs(rep.errors, 'err') + (r.ok ? stats : '') +
      (rep.warnings.length ? section('panel.section.warnings', rep.warnings.length, msgs(rep.warnings, 'warn'), true) : '') +
      (rep.notes && rep.notes.length ? '<div class="' + UI.card + ' ' + UI.muted + '">' + rep.notes.map(esc).join('<br>') + '</div>' : '') +
      section('panel.section.filaments', rep.filaments.length, fil, !r.ok) +
      section('panel.section.designer', rep.kept_author.length,
        table(['panel.col.key', 'panel.col.value', 'panel.col.target_profile'],
          rep.kept_author.map(function (c) { return [c.key, c.original, c.final]; }))) +
      section('panel.section.overrides', rep.object_overrides.length,
        table(['panel.col.object', 'panel.col.key', 'panel.col.value', 'panel.col.reason'],
          rep.object_overrides.map(function (o) {
            return [o.object + (o.part ? ' / ' + o.part : ''), o.key,
              o.original === o.final ? o.final : o.original + ' → ' + o.final, o.reason];
          }))) +
      section('panel.section.dropped', rep.dropped.length,
        table(['panel.col.key', 'panel.col.value', 'panel.col.reason'],
          rep.dropped.map(function (c) { return [c.key, c.original, c.reason]; }))) +
      (rep.positions.length ? section('panel.section.positions', rep.positions.length,
        table(['panel.col.object', 'panel.col.before', 'panel.col.after'],
          rep.positions.map(function (c) { return [c.key, c.original, c.final]; }))) : '') +
      section('panel.section.changed', rep.changed.length,
        '<input type="search" id="q" class="' + UI.input + '" placeholder="' + t('panel.filter_placeholder') + '">' +
        '<div id="chg">' + table(changedHead, changedRows) + '</div>') +
      openCard +
      '<div class="' + UI.actions + '">' + button('back', 'panel.back') + button('close', 'panel.close') + '</div>';

    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      var needle = q.value.toLowerCase();
      document.getElementById('chg').innerHTML = table(changedHead, changedRows.filter(function (row) {
        return (row[0] + ' ' + row[3]).toLowerCase().indexOf(needle) >= 0;
      }));
    });
    Array.prototype.forEach.call(app.querySelectorAll('button[data-open]'), function (b) {
      b.addEventListener('click', function () {
        send({ type: 'open', app: b.getAttribute('data-open') });
        b.textContent = tRaw('panel.opening');
        b.disabled = true;
        setTimeout(function () {
          b.disabled = false;
          b.textContent = tRaw('panel.open.in', { app: b.getAttribute('data-label') });
        }, 4000);
      });
    });
    var samewin = document.getElementById('samewin');
    if (samewin) {
      samewin.addEventListener('change', function () {
        r.same_window = samewin.checked;
        document.getElementById('openhint').innerHTML = openHint(r.same_window);
        send({ type: 'option', key: 'same_window', value: samewin.checked ? 'on' : 'off' });
      });
    }
    document.getElementById('back').addEventListener('click', function () {
      state.dirty = false;
      busy(tRaw('panel.loading'));
      send({ type: 'preview' });
    });
    document.getElementById('close').addEventListener('click', function () { orca.close(); });
  }

  orca.onMessage(function (m) {
    if (!m || !m.type) return;
    if (m.type !== 'busy') clearTimeout(watchdog);
    if (m.type === 'busy') busy(m.text);
    else if (m.type === 'preview') renderPreview(m);
    else if (m.type === 'result') renderResult(m);
    else if (m.type === 'confirm') renderConfirm(lastRequest || { type: 'convert' }, m);
    else if (m.type === 'error') app.innerHTML = '<div class="' + UI.msg.err + '">' + esc(m.text) + '</div>';
  });
  busy(tRaw('panel.loading'));
  send({ type: 'ready' });
})();
