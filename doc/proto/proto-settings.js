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

// -------- Gauge (Golden Score) — SVG arco, color por umbral --------
// >=80 cumple los parámetros establecidos (verde), 60-79 en revisión (ámbar),
// <60 fuera de norma (rojo). Umbrales dummy — a confirmar con el gerente/negocio.
function goldenScoreColor(value) {
  if (value >= 80) { return cssVar('--status-ok-strong'); }
  if (value >= 60) { return cssVar('--status-warn-strong'); }
  return cssVar('--status-danger-strong');
}

function buildGauge(elId, value) {
  var el = document.getElementById(elId);
  if (!el) { return; }
  var r = 46, cx = 60, cy = 60, stroke = 10;
  var circ = 2 * Math.PI * r;
  var offset = circ * (1 - value / 100);
  var trackColor = cssVar('--g1');
  var fillColor = goldenScoreColor(value);
  el.innerHTML =
    '<svg width="120" height="120" viewBox="0 0 120 120">' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + trackColor + '" stroke-width="' + stroke + '"/>' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + fillColor + '" stroke-width="' + stroke + '" ' +
    'stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '" stroke-linecap="round" ' +
    'transform="rotate(-90 ' + cx + ' ' + cy + ')"/>' +
    '<text x="' + cx + '" y="' + (cy + 2) + '" text-anchor="middle" class="gauge-num" style="fill:' + fillColor + '">' + value + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 18) + '" text-anchor="middle" class="gauge-lbl">de 100</text>' +
    '</svg>';
}

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
var fueraZonaSample = [{ lat: -33.30, lon: -70.55, veh: 'PRKP58' }];

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

function buildFueraZona(elId) {
  var map = buildGrayMap(elId, [-33.35, -70.55], 8);
  if (!map) { return; }
  fueraZonaSample.forEach(function (p) {
    L.circleMarker([p.lat, p.lon], {
      radius: 6, color: cssVar('--g7'), weight: 1.5, fillColor: cssVar('--g7'), fillOpacity: 0.85
    }).bindTooltip(p.veh + ' — fuera de zona permitida').addTo(map);
  });
}

buildGauge('gauge-rac', 82);
buildGauge('gauge-lop', 76);
buildSemiDonut('donut-rac', [
  { pct: 18, color: '--status-ok' }, { pct: 55, color: '--status-warn' },
  { pct: 19, color: '--status-alert' }, { pct: 8, color: '--status-danger' }
]);
buildSemiDonut('donut-lop', [
  { pct: 24, color: '--status-ok' }, { pct: 51, color: '--status-warn' },
  { pct: 17, color: '--status-alert' }, { pct: 8, color: '--status-danger' }
]);
buildHotspots('map-hotspots');
buildDisponibilidad('map-disponibilidad');
buildFueraZona('map-fuerazona');
buildHotspots('map-hotspots-lop');
buildDisponibilidad('map-disponibilidad-lop');

// -------- Buscador de reportes — autocompletado dummy, sin conexión real --------
// Catálogo ilustrativo basado en los report_type/events confirmados en spec/api.md
// (kilometraje rt=4, ralentí type=16, eco driving type=24, voltaje rt=15, etc.)
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

setupSearchAutocomplete('search-input-rac', 'search-suggestions-rac');
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