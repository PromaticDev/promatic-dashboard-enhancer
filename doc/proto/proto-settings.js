// -------- Paleta --------
// Leaflet y los SVG armados por concatenación de string escriben color como
// atributo de presentación (setAttribute), no como propiedad CSS — ahí var()
// no se resuelve de forma confiable entre navegadores. cssVar() lee el valor
// real vigente en :root una sola vez, así el hex sigue viviendo solo en
// styles_v3.css y no se duplica acá.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// -------- Tabs --------
document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    setTimeout(function () {
      Object.values(window.__pdMaps || {}).forEach(function (m) { m.invalidateSize(); });
    }, 50);
  });
});

// -------- Semi-donut de velocidad (4 categorías) — SVG arco 180°, con
// números sobre el gráfico. Agrupa los 13 buckets ya confirmados de
// speeding_pie.php en 4 franjas semánticas (despacio/normal/al límite/exceso).
function buildSemiDonut(elId, segments) {
  var el = document.getElementById(elId);
  if (!el) { return; }
  var cx = 78, cy = 78, r = 58, stroke = 15, gapDeg = 1.2;
  var total = segments.reduce(function (a, s) { return a + s.pct; }, 0);
  var cum = 0;
  var textColor = cssVar('--status-text');
  var svg = '<svg width="156" height="90" viewBox="0 0 156 90">';
  segments.forEach(function (seg) {
    var segColor = cssVar(seg.color);
    var startDeg = 180 - (cum / total) * 180 + gapDeg / 2;
    cum += seg.pct;
    var endDeg = 180 - (cum / total) * 180 - gapDeg / 2;
    var toRad = function (d) { return d * Math.PI / 180; };
    var x1 = cx + r * Math.cos(toRad(startDeg)), y1 = cy - r * Math.sin(toRad(startDeg));
    var x2 = cx + r * Math.cos(toRad(endDeg)), y2 = cy - r * Math.sin(toRad(endDeg));
    var largeArc = (startDeg - endDeg) > 180 ? 1 : 0;
    svg += '<path d="M' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + largeArc + ',1 ' + x2 + ',' + y2 +
      '" fill="none" stroke="' + segColor + '" stroke-width="' + stroke + '" stroke-linecap="butt"/>';
    var midDeg = (startDeg + endDeg) / 2;
    var lx = cx + (r) * Math.cos(toRad(midDeg)), ly = cy - (r) * Math.sin(toRad(midDeg));
    svg += '<text x="' + lx + '" y="' + (ly - 2) + '" text-anchor="middle" ' +
      'style="font-size:14px;font-weight:600;fill:' + textColor + '">' + seg.pct + '%</text>';
  });
  svg += '</svg>';
  el.innerHTML = svg;
}

// -------- Datos de muestra (mismos puntos reales del 18 ago + dummy) --------
var idlePointsReal = [
  { lat: -33.403564, lon: -70.57926, veh: 'PRKP58', n: 6 },
  { lat: -33.433334, lon: -70.63612, veh: 'RBBV51', n: 9 },
  { lat: -33.36083, lon: -70.72139, veh: 'TFWS-89', n: 4 },
  { lat: -33.45138, lon: -70.69493, veh: 'LWCD68', n: 3 },
  { lat: -22.451195, lon: -68.922356, veh: 'SPPR-43', n: 2 }
];
var dummyExtra = [
  { lat: -33.42, lon: -70.60, n: 5 },
  { lat: -33.50, lon: -70.75, n: 3 },
  { lat: -33.38, lon: -70.53, n: 7 }
];
var zonesSample = [
  { lat: -33.40, lon: -70.58, name: 'Sucursal Providencia', count: 3 },
  { lat: -33.45, lon: -70.66, name: 'Sucursal Las Condes', count: 2 },
  { lat: -33.36, lon: -70.72, name: 'Sucursal Maipú', count: 1 }
];

window.__pdMaps = {};

function buildGrayMap(elId, center, zoom) {
  var el = document.getElementById(elId);
  if (!el) { return null; }
  var map = L.map(elId, { zoomControl: false, attributionControl: false }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  window.__pdMaps[elId] = map;
  return map;
}

function buildHotspots(elId) {
  var map = buildGrayMap(elId, [-33.42, -70.62], 9);
  if (!map) { return; }
  idlePointsReal.concat(dummyExtra).forEach(function (p) {
    L.circleMarker([p.lat, p.lon], {
      radius: 3 + Math.sqrt(p.n) * 3, color: cssVar('--g7'), weight: 1, fillColor: cssVar('--g6'), fillOpacity: 0.55
    }).bindTooltip((p.veh || 'zona') + ' — ' + p.n + ' eventos').addTo(map);
  });
}

function buildDisponibilidad(elId) {
  var map = buildGrayMap(elId, [-33.42, -70.62], 8);
  if (!map) { return; }
  zonesSample.forEach(function (z) {
    L.circleMarker([z.lat, z.lon], {
      radius: 6, color: cssVar('--g7'), weight: 1.5, fillColor: cssVar('--g4'), fillOpacity: 0.8
    }).bindTooltip(z.name + ' — ' + z.count + ' disponibles').addTo(map);
  });
}

buildSemiDonut('donut-lop', [
  { pct: 24, color: '--status-ok' }, { pct: 51, color: '--status-warn' },
  { pct: 17, color: '--status-alert' }, { pct: 8, color: '--status-danger' }
]);
// RAC (v0.5.0): el mapa de hotspots real es una instancia de MapContainer
// (Ext.panel.Panel) — el prototipo usa Leaflet dummy como aproximación
// visual, no reproduce el mecanismo real (ver title del div en
// proto-dash.html). Los mapas de LOP (vista sin actualizar todavía)
// también usan Leaflet dummy.
buildHotspots('map-hotspots-rac');
buildHotspots('map-hotspots-lop');
buildDisponibilidad('map-disponibilidad-lop');

// -------- Reloj "Hora Oficial" — card fija de la col izquierda RAC --------
// Usa Intl con timeZone fijo a America/Santiago, igual que chileTime() en
// dist/Module.js (clockConfig() default). "Exacta" acá depende del reloj
// del sistema del navegador, no de un servidor horario — suficiente para
// un prototipo/demo, no para un uso que exija NTP.
function updateChileClock() {
  var parts = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  var lookup = {};
  parts.forEach(function (p) { lookup[p.type] = p.value; });
  var text = lookup.hour + ':' + lookup.minute + ':' + lookup.second;
  ['proto-clock-time', 'clock-time-lop'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) { el.textContent = text; }
  });
}
updateChileClock();
setInterval(updateChileClock, 1000);

// -------- Buscador de reportes (solo LOP por ahora) — autocompletado dummy --------
// En RAC el buscador está OCULTO en producción (ver comentario en
// buildRacShell(), dist/Module.js — vuelve con FR-0006, asistente IA), así
// que el prototipo no lo simula en esa vista. Catálogo ilustrativo basado en
// los report_type/events confirmados en spec/api.md.
var reportCatalog = [
  'Reporte Recargas de Combustible',
  'Reporte Ralentí',
  'Reporte Eco Drive (Velocidad)',
  'Reporte Eco Drive II (Calidad de Conducción)',
  'Reporte Vehículos Fuera de Zona',
  'Reporte Kilometraje Recorrido',
  'Reporte Voltaje de Batería',
  'Reporte Desconexión GPS',
  'Reporte Utilización de Flota',
  'Reporte Mantención Pendiente'
];

function setupSearchAutocomplete(inputId, listId) {
  var input = document.getElementById(inputId);
  var list = document.getElementById(listId);
  if (!input || !list) { return; }

  function renderMatches(query) {
    var matches = reportCatalog.filter(function (name) {
      return name.toLowerCase().indexOf(query) !== -1;
    });
    list.innerHTML = '';
    if (!matches.length) {
      var empty = document.createElement('div');
      empty.className = 'search-suggestions-empty';
      empty.textContent = 'Sin coincidencias en el catálogo de reportes';
      list.appendChild(empty);
      list.classList.add('open');
      return;
    }
    matches.forEach(function (name) {
      var item = document.createElement('div');
      item.className = 'search-suggestion';
      item.textContent = name;
      // mousedown (no click) para que dispare antes del blur del input
      item.addEventListener('mousedown', function (e) {
        e.preventDefault();
        input.value = name;
        list.classList.remove('open');
      });
      list.appendChild(item);
    });
    list.classList.add('open');
  }

  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    if (!q) { list.classList.remove('open'); return; }
    renderMatches(q);
  });

  input.addEventListener('focus', function () {
    var q = input.value.trim().toLowerCase();
    if (q) { renderMatches(q); }
  });

  input.addEventListener('blur', function () {
    setTimeout(function () { list.classList.remove('open'); }, 100);
  });
}

setupSearchAutocomplete('search-input-lop', 'search-suggestions-lop');

// -------- Fix: Leaflet inicializado antes de que su contenedor tenga tamaño
// definido puede quedar mostrando un solo tile en vez del mapa completo
// (bug conocido, no depende de file:// vs servidor — pero abrir sin servidor
// suele agravarlo por la latencia de carga del CSS/JS del CDN). Se fuerza un
// recálculo de tamaño una vez que la página terminó de cargar del todo.
window.addEventListener('load', function () {
  setTimeout(function () {
    Object.values(window.__pdMaps || {}).forEach(function (m) { m.invalidateSize(); });
  }, 150);
});