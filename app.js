/**
 * EnduranceIQ – app.js
 * Full workout comparison logic: GPX/TCX parsing, charts, map, sharing
 */

// ─── PALETTE ────────────────────────────────────────────────────────────────
const PALETTE = [
  { line: '#00e87e', fill: 'rgba(0,232,126,0.12)',  name: 'Jade'    },
  { line: '#60a5fa', fill: 'rgba(96,165,250,0.12)', name: 'Azul'    },
  { line: '#f59e0b', fill: 'rgba(245,158,11,0.12)', name: 'Âmbar'   },
  { line: '#e879f9', fill: 'rgba(232,121,249,0.12)', name: 'Rosa'   },
  { line: '#fb7185', fill: 'rgba(251,113,133,0.12)', name: 'Coral'  },
  { line: '#34d399', fill: 'rgba(52,211,153,0.12)', name: 'Menta'   },
];

// ─── STATE ───────────────────────────────────────────────────────────────────
let workouts = [];       // Array of parsed workout objects
let map = null;          // Leaflet map instance
let chartInstance = null; // Chart.js instance
let activeChart = 'elevation';

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupDropZone();
  setupFileInput();
  setupThemeToggle();
  setupShareButton();
  setupChartTabs();
  setupClearButton();
});

// ─── DROP ZONE ───────────────────────────────────────────────────────────────
function setupDropZone() {
  const zone = document.getElementById('dropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files]);
  });
}

function setupFileInput() {
  document.getElementById('fileInput').addEventListener('change', e => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });
}

// ─── FILE HANDLING ────────────────────────────────────────────────────────────
async function handleFiles(files) {
  const supported = files.filter(f => /\.(gpx|tcx)$/i.test(f.name));
  if (!supported.length) { showToast('⚠️ Selecione arquivos .GPX ou .TCX'); return; }

  document.getElementById('loadingState').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');

  for (const file of supported) {
    if (workouts.find(w => w.filename === file.name)) continue; // skip duplicates
    try {
      const text = await readFile(file);
      const workout = /\.gpx$/i.test(file.name) ? parseGPX(text, file.name) : parseTCX(text, file.name);
      if (workout) workouts.push(workout);
    } catch (err) {
      showToast(`❌ Erro ao processar ${file.name}`);
    }
  }

  document.getElementById('loadingState').classList.add('hidden');
  if (workouts.length) renderDashboard();
}

function readFile(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.onerror = () => rej(new Error('Read failed'));
    reader.readAsText(file);
  });
}

// ─── GPX PARSER ──────────────────────────────────────────────────────────────
function parseGPX(xml, filename) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido');

  const trkpts = [...doc.querySelectorAll('trkpt')];
  if (!trkpts.length) throw new Error('Sem trackpoints');

  const points = trkpts.map(pt => ({
    lat:  parseFloat(pt.getAttribute('lat')),
    lon:  parseFloat(pt.getAttribute('lon')),
    ele:  parseFloat(pt.querySelector('ele')?.textContent || 0),
    time: new Date(pt.querySelector('time')?.textContent || 0),
    hr:   parseFloat(pt.querySelector('extensions hr, gpxtpx\\:hr, ns3\\:hr')?.textContent || 0),
    cad:  parseFloat(pt.querySelector('extensions cad, gpxtpx\\:cad, ns3\\:cad')?.textContent || 0),
  }));

  return buildWorkout(points, filename, 'GPX');
}

// ─── TCX PARSER ──────────────────────────────────────────────────────────────
function parseTCX(xml, filename) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido');

  const ns = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';

  const getVal = (parent, tag) => {
    const el = parent.getElementsByTagNameNS(ns, tag)[0] ||
               parent.querySelector(tag);
    return el ? el.textContent.trim() : null;
  };

  const trackpoints = [...(doc.getElementsByTagNameNS(ns, 'Trackpoint').length
    ? doc.getElementsByTagNameNS(ns, 'Trackpoint')
    : doc.querySelectorAll('Trackpoint'))];

  const points = trackpoints.map(tp => {
    const latEl  = tp.getElementsByTagNameNS(ns, 'LatitudeDegrees')[0]  || tp.querySelector('LatitudeDegrees');
    const lonEl  = tp.getElementsByTagNameNS(ns, 'LongitudeDegrees')[0] || tp.querySelector('LongitudeDegrees');
    const eleEl  = tp.getElementsByTagNameNS(ns, 'AltitudeMeters')[0]   || tp.querySelector('AltitudeMeters');
    const timeEl = tp.getElementsByTagNameNS(ns, 'Time')[0]             || tp.querySelector('Time');
    const hrEl   = tp.getElementsByTagNameNS(ns, 'Value')[0]            || tp.querySelector('HeartRateBpm Value');
    const cadEl  = tp.querySelector('Cadence');

    return {
      lat:  parseFloat(latEl?.textContent  || 0),
      lon:  parseFloat(lonEl?.textContent  || 0),
      ele:  parseFloat(eleEl?.textContent  || 0),
      time: new Date(timeEl?.textContent   || 0),
      hr:   parseFloat(hrEl?.textContent   || 0),
      cad:  parseFloat(cadEl?.textContent  || 0),
    };
  }).filter(p => p.lat !== 0 || p.lon !== 0);

  // Try to get calories from TCX
  const calEl = doc.querySelector('Calories, TotalTimeSeconds');
  return buildWorkout(points, filename, 'TCX');
}

// ─── BUILD WORKOUT OBJECT ─────────────────────────────────────────────────────
function buildWorkout(points, filename, format) {
  if (points.length < 2) throw new Error('Pontos insuficientes');

  // --- Distance (Haversine) ---
  let totalDist = 0; // meters
  const distArray = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    totalDist += d;
    distArray.push(totalDist);
  }

  // --- Elevation gain ---
  let elevGain = 0, elevLoss = 0;
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].ele - points[i - 1].ele;
    if (delta > 0) elevGain += delta;
    else elevLoss += Math.abs(delta);
  }

  // --- Duration & speed ---
  const startTime = points[0].time;
  const endTime   = points[points.length - 1].time;
  const durationSec = isNaN(endTime - startTime) ? 0 : (endTime - startTime) / 1000;

  // Speed array (km/h) per point
  const speedArray = [0];
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].time - points[i - 1].time) / 1000; // seconds
    const dd = haversine(points[i - 1], points[i]);           // meters
    const spd = dt > 0 ? (dd / dt) * 3.6 : 0;               // km/h
    speedArray.push(Math.min(spd, 80)); // cap outliers
  }

  const maxSpeed = Math.max(...speedArray);
  const avgSpeed = totalDist > 0 && durationSec > 0
    ? (totalDist / 1000) / (durationSec / 3600)
    : 0;

  // Pace (min/km) from avg speed
  const avgPace = avgSpeed > 0 ? 60 / avgSpeed : 0;

  // Heart rate
  const hrValues = points.map(p => p.hr).filter(h => h > 30);
  const avgHR = hrValues.length ? hrValues.reduce((a, b) => a + b, 0) / hrValues.length : 0;
  const maxHR = hrValues.length ? Math.max(...hrValues) : 0;

  // Estimate calories (rough MET formula)
  const estimatedCal = Math.round((durationSec / 3600) * avgSpeed * 4.5);

  // Build sampled arrays for chart (max 300 points for perf)
  const step = Math.max(1, Math.floor(points.length / 300));
  const chartDist = [], chartEle = [], chartSpeed = [], chartHR = [];
  for (let i = 0; i < points.length; i += step) {
    const distKm = distArray[i] / 1000;
    chartDist.push(+distKm.toFixed(3));
    chartEle.push(+points[i].ele.toFixed(1));
    chartSpeed.push(+speedArray[i].toFixed(2));
    chartHR.push(points[i].hr || null);
  }

  return {
    filename,
    format,
    points,
    distArray,
    totalDist,        // meters
    elevGain,
    elevLoss,
    durationSec,
    avgSpeed,          // km/h
    maxSpeed,
    avgPace,           // min/km
    avgHR,
    maxHR,
    estimatedCal,
    chartDist,
    chartEle,
    chartSpeed,
    chartHR,
    startTime,
    endTime,
  };
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────
function haversine(a, b) {
  const R = 6371000;
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const Δφ = (b.lat - a.lat) * Math.PI / 180;
  const Δλ = (b.lon - a.lon) * Math.PI / 180;
  const sin = Math.sin;
  const c = 2 * Math.atan2(
    Math.sqrt(sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * sin(Δλ / 2) ** 2),
    Math.sqrt(1 - (sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * sin(Δλ / 2) ** 2))
  );
  return R * c;
}

// ─── FORMAT HELPERS ───────────────────────────────────────────────────────────
function fmtDist(m)     { return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`; }
function fmtDur(s)      {
  if (!s) return '--';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}h ${pad(m)}m` : `${m}m ${pad(sec)}s`;
}
function fmtPace(minKm) {
  if (!minKm || !isFinite(minKm)) return '--';
  const m = Math.floor(minKm), s = Math.round((minKm - m) * 60);
  return `${m}:${pad(s)} /km`;
}
function fmtSpeed(kmh)  { return kmh ? `${kmh.toFixed(1)} km/h` : '--'; }
function fmtEle(m)      { return `+${Math.round(m)} m`; }
function fmtCal(c)      { return c ? `${c} kcal` : '--'; }
function pad(n)          { return String(n).padStart(2, '0'); }

// ─── RENDER DASHBOARD ─────────────────────────────────────────────────────────
function renderDashboard() {
  // Make dashboard visible FIRST so all containers have real pixel dimensions
  // before Chart.js and Leaflet try to measure them.
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('uploadSection').querySelector('#dropZone').style.display = 'none';
  document.getElementById('fileList').classList.remove('hidden');

  renderFileList();
  renderStatsTable();
  renderKPICards();
  renderChart(activeChart);
  renderMap(); // called last — container is visible and sized correctly
}

// ─── FILE LIST ────────────────────────────────────────────────────────────────
function renderFileList() {
  const list = document.getElementById('fileList');
  list.innerHTML = '';

  workouts.forEach((w, i) => {
    const color = PALETTE[i % PALETTE.length].line;
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between p-3 rounded-xl border';
    item.style.cssText = `background:rgba(13,20,38,0.8);border-color:${color}33`;
    item.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-3 h-3 rounded-full" style="background:${color};box-shadow:0 0 8px ${color}88"></div>
        <div>
          <p class="text-sm font-medium text-white/80">${w.filename}</p>
          <p class="text-xs font-mono" style="color:${color}99">${w.format} · ${fmtDist(w.totalDist)} · ${fmtDur(w.durationSec)}</p>
        </div>
      </div>
      <button onclick="removeWorkout(${i})" class="text-white/20 hover:text-red-400 transition-colors p-1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    list.appendChild(item);
  });
}

// ─── STATS TABLE ──────────────────────────────────────────────────────────────
function renderStatsTable() {
  const tbody = document.getElementById('statsTableBody');
  tbody.innerHTML = '';

  workouts.forEach((w, i) => {
    const color = PALETTE[i % PALETTE.length].line;
    const tr = document.createElement('tr');

    // Highlight best values
    const bestDist  = Math.max(...workouts.map(x => x.totalDist));
    const bestSpeed = Math.max(...workouts.map(x => x.maxSpeed));
    const bestEle   = Math.max(...workouts.map(x => x.elevGain));

    tr.innerHTML = `
      <td>
        <div class="flex items-center gap-2">
          <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></div>
          <span class="text-white/80 text-xs truncate max-w-[140px]">${w.filename.replace(/\.(gpx|tcx)$/i,'')}</span>
          <span class="workout-pill text-[9px]" style="color:${color};border-color:${color}44">${w.format}</span>
        </div>
      </td>
      <td class="text-right ${w.totalDist === bestDist ? 'font-bold' : ''}" style="${w.totalDist === bestDist ? `color:${color}` : 'color:rgba(255,255,255,0.6)'}">
        ${fmtDist(w.totalDist)}
      </td>
      <td class="text-right text-white/60">${fmtDur(w.durationSec)}</td>
      <td class="text-right text-white/60">${fmtPace(w.avgPace)}</td>
      <td class="text-right ${w.maxSpeed === bestSpeed ? 'font-bold' : ''}" style="${w.maxSpeed === bestSpeed ? `color:${color}` : 'color:rgba(255,255,255,0.6)'}">
        ${fmtSpeed(w.maxSpeed)}
      </td>
      <td class="text-right ${w.elevGain === bestEle ? 'font-bold' : ''}" style="${w.elevGain === bestEle ? `color:${color}` : 'color:rgba(255,255,255,0.6)'}">
        ${fmtEle(w.elevGain)}
      </td>
      <td class="text-right text-white/60">${fmtCal(w.estimatedCal)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── KPI CARDS ────────────────────────────────────────────────────────────────
function renderKPICards() {
  if (workouts.length < 2) { document.getElementById('kpiCards').innerHTML = ''; return; }
  const a = workouts[0], b = workouts[1];
  const color0 = PALETTE[0].line, color1 = PALETTE[1].line;

  const kpis = [
    { label: 'Distância', v0: fmtDist(a.totalDist), v1: fmtDist(b.totalDist), delta: ((b.totalDist - a.totalDist) / a.totalDist * 100).toFixed(1) },
    { label: 'Duração',   v0: fmtDur(a.durationSec), v1: fmtDur(b.durationSec) },
    { label: 'Vel. Máx.', v0: fmtSpeed(a.maxSpeed), v1: fmtSpeed(b.maxSpeed), delta: ((b.maxSpeed - a.maxSpeed) / a.maxSpeed * 100).toFixed(1) },
    { label: 'Pace Méd.', v0: fmtPace(a.avgPace), v1: fmtPace(b.avgPace) },
    { label: 'Elevação',  v0: fmtEle(a.elevGain), v1: fmtEle(b.elevGain), delta: ((b.elevGain - a.elevGain) / (a.elevGain || 1) * 100).toFixed(1) },
    { label: 'FC Média',  v0: a.avgHR ? `${Math.round(a.avgHR)} bpm` : '--', v1: b.avgHR ? `${Math.round(b.avgHR)} bpm` : '--' },
  ];

  const container = document.getElementById('kpiCards');
  container.innerHTML = kpis.map(k => `
    <div class="stat-card p-4">
      <p class="text-[10px] font-mono text-white/30 uppercase tracking-widest mb-3">${k.label}</p>
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full" style="background:${color0}"></div>
          <span class="text-xs font-mono text-white/70">${k.v0}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full" style="background:${color1}"></div>
          <span class="text-xs font-mono text-white/70">${k.v1}</span>
        </div>
        ${k.delta !== undefined ? `
        <div class="text-[10px] font-mono mt-1 ${parseFloat(k.delta) >= 0 ? 'text-emerald-400' : 'text-red-400'}">
          ${parseFloat(k.delta) >= 0 ? '▲' : '▼'} ${Math.abs(k.delta)}%
        </div>` : ''}
      </div>
    </div>
  `).join('');
}

// ─── CHART ────────────────────────────────────────────────────────────────────
function setupChartTabs() {
  document.querySelectorAll('.tab-btn[data-chart]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn[data-chart]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeChart = btn.dataset.chart;
      renderChart(activeChart);
    });
  });
}

function renderChart(type) {
  const ctx = document.getElementById('mainChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  const datasets = workouts.map((w, i) => {
    const pal = PALETTE[i % PALETTE.length];
    let data, label, yAxisLabel;

    if (type === 'elevation') {
      data = w.chartDist.map((x, j) => ({ x, y: w.chartEle[j] }));
      label = w.filename.replace(/\.(gpx|tcx)$/i, '') + ' – Altitude (m)';
      yAxisLabel = 'Altitude (m)';
    } else if (type === 'speed') {
      data = w.chartDist.map((x, j) => ({ x, y: w.chartSpeed[j] }));
      label = w.filename.replace(/\.(gpx|tcx)$/i, '') + ' – Velocidade (km/h)';
      yAxisLabel = 'Velocidade (km/h)';
    } else {
      data = w.chartDist.map((x, j) => ({ x, y: w.chartHR[j] }));
      label = w.filename.replace(/\.(gpx|tcx)$/i, '') + ' – FC (bpm)';
      yAxisLabel = 'FC (bpm)';
    }

    return {
      label,
      data,
      borderColor: pal.line,
      backgroundColor: pal.fill,
      fill: true,
      tension: 0.3,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
    };
  });

  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  const textColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.4)';

  const yLabels = { elevation: 'Altitude (m)', speed: 'Velocidade (km/h)', hr: 'FC (bpm)' };

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor, font: { family: 'JetBrains Mono', size: 11 }, boxWidth: 12, padding: 16 }
        },
        tooltip: {
          backgroundColor: isDark ? '#0d1426' : '#fff',
          borderColor: 'rgba(0,232,126,0.3)',
          borderWidth: 1,
          titleColor: '#00e87e',
          bodyColor: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)',
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'JetBrains Mono', size: 12 },
          padding: 12,
          callbacks: {
            title: items => `${items[0].parsed.x.toFixed(2)} km`,
            label: item => {
              const v = item.parsed.y;
              if (type === 'elevation') return ` ${item.dataset.label.split('–')[0].trim()}: ${v.toFixed(0)} m`;
              if (type === 'speed')     return ` ${item.dataset.label.split('–')[0].trim()}: ${v.toFixed(1)} km/h`;
              return ` ${item.dataset.label.split('–')[0].trim()}: ${v ? v.toFixed(0) + ' bpm' : '--'}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Distância (km)', color: textColor, font: { family: 'JetBrains Mono', size: 11 } },
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } }
        },
        y: {
          title: { display: true, text: yLabels[type], color: textColor, font: { family: 'JetBrains Mono', size: 11 } },
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10 } }
        }
      }
    }
  });
}

// ─── MAP ──────────────────────────────────────────────────────────────────────
function renderMap() {
  // Always destroy and recreate — avoids tile blank bug when container
  // was hidden (size = 0) at the time of first initialization.
  if (map) {
    map.off();
    map.remove();
    map = null;
  }

  map = L.map('mapContainer', {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,      // faster rendering for many polyline points
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  const allLatLngs = [];
  const legend = document.getElementById('mapLegend');
  legend.innerHTML = '';

  workouts.forEach((w, i) => {
    const pal = PALETTE[i % PALETTE.length];
    const latlngs = w.points
      .filter(p => p.lat !== 0 && p.lon !== 0)
      .map(p => [p.lat, p.lon]);

    if (!latlngs.length) return;
    allLatLngs.push(...latlngs);

    // Shadow polyline for glow effect
    L.polyline(latlngs, { color: pal.line, weight: 7, opacity: 0.18, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    L.polyline(latlngs, { color: pal.line, weight: 3,   opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);

    // Start / end markers
    const dotIcon = (color, border = 'white') => L.divIcon({
      html: `<div style="width:13px;height:13px;border-radius:50%;background:${color};border:2.5px solid ${border};box-shadow:0 0 10px ${color};"></div>`,
      iconSize: [13, 13],
      iconAnchor: [6, 6],
      className: '',
    });

    L.marker(latlngs[0], { icon: dotIcon(pal.line) }).addTo(map)
      .bindPopup(`<b style="color:${pal.line}">${w.filename}</b><br>🟢 Início`);
    L.marker(latlngs[latlngs.length - 1], { icon: dotIcon('#ffffff', pal.line) }).addTo(map)
      .bindPopup(`<b style="color:${pal.line}">${w.filename}</b><br>🏁 Fim`);

    // Legend pill
    const pill = document.createElement('div');
    pill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono';
    pill.style.cssText = `background:${pal.line}22;border:1px solid ${pal.line}44;color:${pal.line}`;
    pill.innerHTML = `<div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${pal.line}"></div>${w.filename.replace(/\.(gpx|tcx)$/i, '')}`;
    legend.appendChild(pill);
  });

  if (allLatLngs.length) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [32, 32], maxZoom: 17 });
  }

  // 🔑 Force Leaflet to recalculate tile grid after the container
  // becomes visible — this is the key fix for the blank-map bug.
  setTimeout(() => {
    map.invalidateSize({ animate: false });
    if (allLatLngs.length) {
      map.fitBounds(L.latLngBounds(allLatLngs), { padding: [32, 32], maxZoom: 17 });
    }
  }, 120);
}

// ─── REMOVE WORKOUT ──────────────────────────────────────────────────────────
function removeWorkout(index) {
  workouts.splice(index, 1);
  if (!workouts.length) {
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('dropZone').style.display = '';
    document.getElementById('fileList').classList.add('hidden');
    document.getElementById('fileList').innerHTML = '';
    return;
  }
  renderDashboard();
}

// ─── CLEAR ────────────────────────────────────────────────────────────────────
function setupClearButton() {
  document.getElementById('clearBtn').addEventListener('click', () => {
    workouts = [];
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (map) { map.off(); map.remove(); map = null; }
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('dropZone').style.display = '';
    document.getElementById('fileList').classList.add('hidden');
    document.getElementById('fileList').innerHTML = '';
    showToast('✓ Treinos removidos');
  });
}

// ─── THEME TOGGLE ─────────────────────────────────────────────────────────────
function setupThemeToggle() {
  const html   = document.documentElement;
  const btn    = document.getElementById('themeToggle');
  const sun    = document.getElementById('sunIcon');
  const moon   = document.getElementById('moonIcon');

  const applyTheme = dark => {
    html.classList.toggle('dark', dark);
    sun.classList.toggle('hidden', !dark);
    moon.classList.toggle('hidden', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    if (chartInstance) renderChart(activeChart); // re-render with correct colors
  };

  const saved = localStorage.getItem('theme');
  applyTheme(saved !== 'light');
  btn.addEventListener('click', () => applyTheme(!html.classList.contains('dark')));
}

// ─── SHARE / INVITE ──────────────────────────────────────────────────────────
function setupShareButton() {
  document.getElementById('shareBtn').addEventListener('click', async () => {
    const workoutSummary = workouts.length
      ? workouts.map(w => `${w.filename}: ${fmtDist(w.totalDist)} em ${fmtDur(w.durationSec)}`).join('\n')
      : 'Nenhum treino carregado ainda.';

    const shareData = {
      title: 'EnduranceIQ – Comparação de Treinos',
      text: `Compare nossos treinos no EnduranceIQ!\n\n${workoutSummary}`,
      url: window.location.href,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        showToast('✓ Compartilhado!');
      } catch {}
    } else {
      // Fallback: copy link to clipboard
      const link = generateInviteLink();
      try {
        await navigator.clipboard.writeText(link);
        showToast('📋 Link copiado para a área de transferência!');
      } catch {
        prompt('Copie o link de convite:', link);
      }
    }
  });
}

function generateInviteLink() {
  const token = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `${window.location.origin}${window.location.pathname}?invite=${token}`;
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ─── DEMO DATA (if no files) ──────────────────────────────────────────────────
// Expose removeWorkout globally for inline onclick
window.removeWorkout = removeWorkout;
