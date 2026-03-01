/* ════════════════════════════════════════════════════════
   TrackLab — app.js  v2
   Parse TCX/GPX · Gráficos · Mapa Leaflet · LocalStorage
════════════════════════════════════════════════════════ */
'use strict';

// ──────────────────────────────────────────────────────
// PALETA — cores vivas para as atividades
// ──────────────────────────────────────────────────────
const ACTIVITY_COLORS = [
  '#00f5ff', // cyan elétrico
  '#f107a3', // magenta
  '#00ff87', // verde neon
  '#ff6b35', // laranja plasma
  '#ffe100', // amarelo volt
  '#c084fc', // lilás
  '#38bdf8', // azul céu
  '#fb923c', // âmbar
];

// Cores KPI cicladas
const KPI_CLASSES = ['kpi-purple','kpi-pink','kpi-cyan','kpi-green','kpi-orange','kpi-yellow'];
const KPI_ICONS   = { totalSec:'⏱', totalDistM:'📍', avgSpeed:'🚀', avgHR:'❤️', maxHR:'💓', elevGain:'⛰️', avgPower:'⚡' };

// ──────────────────────────────────────────────────────
// ESTADO GLOBAL
// ──────────────────────────────────────────────────────
const state = {
  activities:    [],
  currentMetric: 'hr',
  currentAxis:   'time',
  currentTab:    'summary',
  chart:         null,
  miniChart1:    null,
  miniChart2:    null,
  map:           null,          // instância Leaflet
  mapLayers:     [],            // polylines por atividade
  mapTileLayer:  null,
};

const METRICS = {
  hr:       { label: 'Freq. Cardíaca', unit: 'bpm',  key: 'heartRate' },
  power:    { label: 'Potência',       unit: 'W',    key: 'power'     },
  altitude: { label: 'Altitude',       unit: 'm',    key: 'altitude'  },
  speed:    { label: 'Velocidade',     unit: 'km/h', key: 'speed'     },
};

// Tile layers para o mapa
const MAP_TILES = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attr: '© OpenStreetMap © CARTO',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri',
  },
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attr: '© OpenTopoMap',
  },
  street: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '© OpenStreetMap',
  },
};

// ──────────────────────────────────────────────────────
// UTILITÁRIOS
// ──────────────────────────────────────────────────────
function secondsToHMS(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function fmtDist(m) {
  return m >= 1000 ? `${(m/1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function avg(arr) {
  const c = arr.filter(v => v != null && !isNaN(v));
  if (!c.length) return null;
  return c.reduce((a, b) => a + b, 0) / c.length;
}

function toast(msg, type = 'warn') {
  const el = document.getElementById('toast');
  document.getElementById('toastIcon').textContent = type === 'error' ? '✕' : type === 'ok' ? '✓' : '⚠';
  document.getElementById('toastMsg').textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3800);
}

const uid = () => Math.random().toString(36).slice(2, 9);

// ──────────────────────────────────────────────────────
// PARSE — TCX
// ──────────────────────────────────────────────────────
function parseTCX(xmlText, name) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido no TCX');

  const sport = doc.querySelector('Activity')?.getAttribute('Sport') || 'Treino';
  const tps = Array.from(doc.querySelectorAll('Trackpoint'));
  if (!tps.length) throw new Error('Nenhum Trackpoint no TCX');

  const points = [];
  let startTime = null;

  for (const tp of tps) {
    const timeStr = tp.querySelector('Time')?.textContent?.trim();
    if (!timeStr) continue;
    const time = new Date(timeStr);
    if (!startTime) startTime = time;
    const elapsedSec = (time - startTime) / 1000;

    // Coordenadas GPS (lat/lon)
    const latEl = tp.querySelector('LatitudeDegrees');
    const lonEl = tp.querySelector('LongitudeDegrees');
    const lat = latEl ? parseFloat(latEl.textContent) : null;
    const lon = lonEl ? parseFloat(lonEl.textContent) : null;

    const distRaw = tp.querySelector('DistanceMeters')?.textContent;
    const altRaw  = tp.querySelector('AltitudeMeters')?.textContent;

    // HeartRate pode estar em múltiplos formatos
    let hrVal = null;
    const hrBpm = tp.querySelector('HeartRateBpm');
    if (hrBpm) {
      const v = hrBpm.querySelector('Value');
      if (v) hrVal = parseInt(v.textContent, 10);
    }

    // Watts: tenta Extensions
    let watts = null;
    const ext = tp.querySelector('Extensions');
    if (ext) {
      const wEl = Array.from(ext.querySelectorAll('*'))
        .find(el => /watt|power/i.test(el.tagName));
      if (wEl) watts = parseFloat(wEl.textContent);
    }

    points.push({
      elapsedSec,
      lat, lon,
      distanceM: distRaw ? parseFloat(distRaw) : null,
      altitude:  altRaw  ? parseFloat(altRaw)  : null,
      heartRate: hrVal,
      power:     watts,
      speed:     null,
    });
  }

  return buildActivity(points, name, sport, startTime);
}

// ──────────────────────────────────────────────────────
// PARSE — GPX
// ──────────────────────────────────────────────────────
function parseGPX(xmlText, name) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido no GPX');

  const label = doc.querySelector('trk name')?.textContent?.trim()
              || doc.querySelector('metadata name')?.textContent?.trim()
              || 'GPX';

  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (!trkpts.length) throw new Error('Nenhum trkpt no GPX');

  const points = [];
  let startTime = null;
  let lastDist = 0;
  let lastLat = null, lastLon = null;

  for (const pt of trkpts) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));

    const timeStr = pt.querySelector('time')?.textContent?.trim();
    let elapsedSec = 0;
    if (timeStr) {
      const t = new Date(timeStr);
      if (!startTime) startTime = t;
      elapsedSec = (t - startTime) / 1000;
    }

    const altRaw = pt.querySelector('ele')?.textContent;
    const hrRaw  = findTagSuffix(pt, 'hr');
    const powRaw = findTagSuffix(pt, 'power');

    if (lastLat !== null) lastDist += haversineM(lastLat, lastLon, lat, lon);
    lastLat = lat; lastLon = lon;

    points.push({
      elapsedSec,
      lat, lon,
      distanceM: lastDist,
      altitude:  altRaw ? parseFloat(altRaw) : null,
      heartRate: hrRaw  ? parseInt(hrRaw, 10) : null,
      power:     powRaw ? parseFloat(powRaw)  : null,
      speed:     null,
    });
  }

  return buildActivity(points, name, label, startTime);
}

function findTagSuffix(node, suffix) {
  for (const el of node.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === suffix || tag.endsWith(':' + suffix)) return el.textContent?.trim() || null;
  }
  return null;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = d => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ──────────────────────────────────────────────────────
// BUILD ACTIVITY
// ──────────────────────────────────────────────────────
function buildActivity(points, filename, label, startTime) {
  // Calcula velocidade instantânea
  for (let i = 1; i < points.length; i++) {
    const p = points[i-1], c = points[i];
    const dt = c.elapsedSec - p.elapsedSec;
    if (dt > 0 && c.distanceM != null && p.distanceM != null) {
      c.speed = ((c.distanceM - p.distanceM) / dt) * 3.6;
    }
  }

  const totalSec   = points.length ? points[points.length-1].elapsedSec : 0;
  const totalDistM = points.reduce((mx, p) => Math.max(mx, p.distanceM ?? 0), 0);
  const hrs        = points.map(p => p.heartRate).filter(Boolean);
  const avgHR      = hrs.length ? Math.round(avg(hrs)) : null;
  const maxHR      = hrs.length ? Math.max(...hrs) : null;
  const pows       = points.map(p => p.power).filter(Boolean);
  const avgPower   = pows.length ? Math.round(avg(pows)) : null;
  const avgSpeed   = totalDistM > 0 && totalSec > 0 ? +((totalDistM / totalSec) * 3.6).toFixed(2) : null;

  let elevGain = 0;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i].altitude ?? 0) - (points[i-1].altitude ?? 0);
    if (d > 0) elevGain += d;
  }

  // Extrai coordenadas GPS válidas para o mapa
  const gpsTrack = points
    .filter(p => p.lat != null && p.lon != null && !isNaN(p.lat) && !isNaN(p.lon))
    .map(p => [p.lat, p.lon]);

  return {
    id: uid(), filename, label: label || filename, startTime,
    points, gpsTrack,
    summary: {
      totalSec, totalDistM,
      avgHR, maxHR, avgPower, avgSpeed,
      elevGain: Math.round(elevGain),
    },
  };
}

// ──────────────────────────────────────────────────────
// LOCAL STORAGE
// ──────────────────────────────────────────────────────
const LS_KEY = 'tracklab_v2';

function saveToLS() {
  try {
    const data = state.activities.map(a => ({
      id: a.id, filename: a.filename, label: a.label,
      startTime: a.startTime, points: a.points,
      gpsTrack: a.gpsTrack, summary: a.summary,
    }));
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) { console.warn('LS save failed:', e.message); }
}

function loadFromLS() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || []; }
  catch { return []; }
}

function clearLS() { localStorage.removeItem(LS_KEY); }

// ──────────────────────────────────────────────────────
// FILE MANAGEMENT
// ──────────────────────────────────────────────────────
let pendingFiles = [];

function addFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['tcx','gpx'].includes(ext)) { toast(`"${f.name}" ignorado — só .tcx e .gpx`); continue; }
    if (pendingFiles.find(x => x.name === f.name)) continue;
    pendingFiles.push(f);
  }
  renderFileList();
}

function renderFileList() {
  const container = document.getElementById('fileList');
  const btn = document.getElementById('compareBtn');
  if (!pendingFiles.length) { container.classList.add('hidden'); btn.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  container.innerHTML = '';

  pendingFiles.forEach((f, idx) => {
    const color = ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length];
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-dot" style="background:${color}; color:${color};"></div>
      <div class="flex-1 min-w-0">
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-size">${(f.size/1024).toFixed(1)} KB</div>
      </div>
      <button class="file-remove" data-idx="${idx}">✕</button>
    `;
    container.appendChild(card);
  });

  btn.classList.toggle('hidden', pendingFiles.length < 2);
  container.querySelectorAll('.file-remove').forEach(b => {
    b.addEventListener('click', e => {
      pendingFiles.splice(parseInt(e.target.dataset.idx), 1);
      renderFileList();
    });
  });
}

// ──────────────────────────────────────────────────────
// COMPARAÇÃO PRINCIPAL
// ──────────────────────────────────────────────────────
async function runComparison() {
  if (pendingFiles.length < 2) { toast('Adicione ao menos 2 arquivos'); return; }
  state.activities = [];

  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    try {
      const text = await readFileText(file);
      const fmt  = detectFormat(file.name, text);
      let act = fmt === 'tcx' ? parseTCX(text, file.name)
              : fmt === 'gpx' ? parseGPX(text, file.name)
              : null;
      if (!act) { toast(`Formato desconhecido: ${file.name}`, 'error'); continue; }
      act.color = ACTIVITY_COLORS[i % ACTIVITY_COLORS.length];
      act.index = i;
      state.activities.push(act);
    } catch (err) {
      toast(`Erro em ${file.name}: ${err.message}`, 'error');
      console.error(err);
    }
  }

  if (state.activities.length < 2) { toast('Não foi possível parsear arquivos suficientes.', 'error'); return; }
  saveToLS();
  renderDashboard();
}

function readFileText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('Falha ao ler'));
    r.readAsText(file, 'UTF-8');
  });
}

function detectFormat(name, text) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'tcx') return 'tcx';
  if (ext === 'gpx') return 'gpx';
  if (text.includes('<Trackpoint')) return 'tcx';
  if (text.includes('<trkpt'))      return 'gpx';
  return null;
}

// ──────────────────────────────────────────────────────
// RENDER DASHBOARD
// ──────────────────────────────────────────────────────
function renderDashboard() {
  document.getElementById('uploadSection').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('dashNav').classList.remove('hidden');
  document.getElementById('dashNavMobile').classList.remove('hidden');
  document.getElementById('backBtn').classList.remove('hidden');
  document.getElementById('clearBtn').classList.remove('hidden');

  renderActivityStrip();
  renderSummaryCards();
  renderMiniCharts();
  buildMetricButtons();
  buildChart();
  renderCompTable();
  initMap();

  switchTab('summary');
}

// ── Activity strip ──
function renderActivityStrip() {
  const el = document.getElementById('activityStrip');
  el.innerHTML = '';
  state.activities.forEach(act => {
    const badge = document.createElement('div');
    badge.className = 'act-badge';
    badge.style.cssText = `border-color:${act.color}40; background:${act.color}12; color:${act.color};`;
    badge.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${act.color};display:inline-block;box-shadow:0 0 8px ${act.color};"></span>
      ${act.filename}
    `;
    el.appendChild(badge);
  });
}

// ── KPI Summary Cards ──
function renderSummaryCards() {
  const el = document.getElementById('summaryCards');
  el.innerHTML = '';

  const fields = [
    { key:'totalSec',   label:'Tempo Total',      fmt: secondsToHMS },
    { key:'totalDistM', label:'Distância',         fmt: fmtDist },
    { key:'avgSpeed',   label:'Veloc. Média',      fmt: v => v ? `${v} km/h` : '—' },
    { key:'avgHR',      label:'FC Média',          fmt: v => v ? `${v} bpm` : '—' },
    { key:'maxHR',      label:'FC Máxima',         fmt: v => v ? `${v} bpm` : '—' },
    { key:'elevGain',   label:'Ganho Elev.',       fmt: v => `${v} m` },
    { key:'avgPower',   label:'Potência Média',    fmt: v => v ? `${v} W` : '—' },
  ];

  fields.forEach((field, fi) => {
    const hasData = state.activities.some(a => a.summary[field.key] != null);
    if (!hasData) return;

    const card = document.createElement('div');
    card.className = `kpi-card ${KPI_CLASSES[fi % KPI_CLASSES.length]}`;
    card.style.animationDelay = `${fi * 60}ms`;

    const icon = KPI_ICONS[field.key] || '◈';
    const valuesHtml = state.activities.map(act => `
      <div class="kpi-val">
        <span class="dot" style="background:${act.color};box-shadow:0 0 6px ${act.color};"></span>
        ${field.fmt(act.summary[field.key])}
      </div>
    `).join('');

    card.innerHTML = `
      <span class="kpi-icon">${icon}</span>
      <div class="kpi-label">${field.label}</div>
      <div class="kpi-values">${valuesHtml}</div>
    `;
    el.appendChild(card);
  });
}

// ── Mini Charts ──
function renderMiniCharts() {
  const chartOpts = (label, unit) => ({
    type: 'line',
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      elements: { point: { radius: 0 } },
      scales: {
        x: { display: false },
        y: {
          display: true,
          ticks: { color: 'rgba(255,255,255,0.2)', font: { family: 'Fira Code', size: 9 }, maxTicksLimit: 4 },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });

  const buildMini = (canvasId, metricKey, chartRef) => {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return null;
    if (state[chartRef]) state[chartRef].destroy();

    const metric = METRICS[metricKey];
    const datasets = state.activities.map(act => ({
      data: smooth(getDataset(act, metricKey)).map(p => p.y),
      borderColor: act.color,
      backgroundColor: act.color + '15',
      fill: true,
      tension: 0.4,
      borderWidth: 1.5,
      pointRadius: 0,
    }));

    const maxLen = Math.max(...datasets.map(d => d.data.length));
    const labels = Array.from({ length: maxLen }, (_, i) => i);

    const cfg = chartOpts(metric.label, metric.unit);
    cfg.data = { labels, datasets };
    state[chartRef] = new Chart(ctx, cfg);
    return state[chartRef];
  };

  buildMini('miniChart1', 'power', 'miniChart1');
  buildMini('miniChart2', 'hr',    'miniChart2');
}

// ──────────────────────────────────────────────────────
// GRÁFICO PRINCIPAL — Chart.js
// ──────────────────────────────────────────────────────
function buildMetricButtons() {
  const container = document.getElementById('metricBtns');
  container.innerHTML = '';

  const available = Object.entries(METRICS).filter(([, m]) =>
    state.activities.some(a => a.points.some(p => p[m.key] != null))
  );
  if (!available.find(([k]) => k === state.currentMetric) && available.length) {
    state.currentMetric = available[0][0];
  }

  available.forEach(([key]) => {
    const btn = document.createElement('button');
    btn.className = 'metric-btn' + (key === state.currentMetric ? ' active' : '');
    btn.textContent = METRICS[key].label;
    btn.dataset.metric = key;
    btn.addEventListener('click', () => {
      state.currentMetric = key;
      container.querySelectorAll('.metric-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateChart();
    });
    container.appendChild(btn);
  });

  // Eixo X
  document.getElementById('xAxisBtns').querySelectorAll('.axis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentAxis = btn.dataset.axis;
      document.querySelectorAll('.axis-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateChart();
    });
  });
}

function getDataset(act, metricKey) {
  const key = METRICS[metricKey].key;
  return act.points
    .filter(p => p[key] != null)
    .map(p => ({
      x: state.currentAxis === 'time'
        ? p.elapsedSec / 60
        : (p.distanceM ?? 0) / 1000,
      y: p[key],
    }));
}

function smooth(data, win = 7) {
  return data.map((pt, i) => {
    const s = data.slice(Math.max(0, i - win), i + win + 1);
    return { x: pt.x, y: +(s.reduce((a, b) => a + b.y, 0) / s.length).toFixed(1) };
  });
}

function buildChart() {
  const ctx = document.getElementById('mainChart')?.getContext('2d');
  if (!ctx) return;
  if (state.chart) state.chart.destroy();

  const metric = METRICS[state.currentMetric];
  const datasets = state.activities.map(act => ({
    label: act.filename,
    data: smooth(getDataset(act, state.currentMetric)),
    borderColor: act.color,
    backgroundColor: act.color + '15',
    fill: false,
    tension: 0.35,
    borderWidth: 2.5,
    pointRadius: 0,
    pointHoverRadius: 6,
    pointHoverBackgroundColor: act.color,
    pointHoverBorderColor: 'white',
  }));

  state.chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: 'rgba(255,255,255,0.5)',
            font: { family: 'Fira Code', size: 11 },
            boxWidth: 14, boxHeight: 3,
            usePointStyle: true, pointStyle: 'rectRounded',
          },
        },
        tooltip: {
          backgroundColor: 'rgba(13,2,33,0.95)',
          borderColor: 'rgba(123,47,247,0.4)',
          borderWidth: 1,
          titleColor: 'rgba(255,255,255,0.4)',
          bodyColor: 'rgba(255,255,255,0.85)',
          titleFont: { family: 'Fira Code', size: 10 },
          bodyFont:  { family: 'Fira Code', size: 12 },
          padding: 12,
          callbacks: {
            title: items => {
              const x = items[0].parsed.x;
              return state.currentAxis === 'time'
                ? `⏱ ${secondsToHMS(x * 60)}`
                : `📍 ${x.toFixed(2)} km`;
            },
            label: item => ` ${item.dataset.label}: ${item.parsed.y} ${metric.unit}`,
          },
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
          pan:  { enabled: true, mode: 'x' },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: state.currentAxis === 'time' ? 'Tempo (min)' : 'Distância (km)',
            color: 'rgba(255,255,255,0.2)', font: { family: 'Fira Code', size: 10 },
          },
          ticks: { color: 'rgba(255,255,255,0.2)', font: { family: 'Fira Code', size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          title: {
            display: true,
            text: `${metric.label} (${metric.unit})`,
            color: 'rgba(255,255,255,0.2)', font: { family: 'Fira Code', size: 10 },
          },
          ticks: { color: 'rgba(255,255,255,0.2)', font: { family: 'Fira Code', size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
}

function updateChart() {
  if (!state.chart) return;
  const metric = METRICS[state.currentMetric];
  state.chart.data.datasets = state.activities.map(act => ({
    label: act.filename,
    data: smooth(getDataset(act, state.currentMetric)),
    borderColor: act.color,
    backgroundColor: act.color + '15',
    fill: false, tension: 0.35, borderWidth: 2.5,
    pointRadius: 0, pointHoverRadius: 6,
    pointHoverBackgroundColor: act.color,
    pointHoverBorderColor: 'white',
  }));
  state.chart.options.scales.x.title.text =
    state.currentAxis === 'time' ? 'Tempo (min)' : 'Distância (km)';
  state.chart.options.scales.y.title.text = `${metric.label} (${metric.unit})`;
  state.chart.update('active');
}

// ──────────────────────────────────────────────────────
// TABELA COMPARATIVA
// ──────────────────────────────────────────────────────
function renderCompTable() {
  const thead = document.getElementById('compTableHead');
  const tbody = document.getElementById('compTableBody');
  thead.innerHTML = '<th class="text-left py-3 pr-6 text-white/30 text-xs tracking-wider uppercase font-medium">Métrica</th>';
  tbody.innerHTML = '';

  state.activities.forEach(act => {
    const th = document.createElement('th');
    th.className = 'text-left py-3 pr-6';
    th.innerHTML = `<span style="color:${act.color}" class="font-mono text-xs">${act.filename}</span>`;
    thead.appendChild(th);
  });

  const rows = [
    { label:'Tempo Total',      key:'totalSec',   fmt: secondsToHMS,              better:'min' },
    { label:'Distância',        key:'totalDistM', fmt: fmtDist,                   better:'max' },
    { label:'Veloc. Média',     key:'avgSpeed',   fmt: v => v ? `${v} km/h` : '—', better:'max' },
    { label:'FC Média',         key:'avgHR',      fmt: v => v ? `${v} bpm` : '—',  better:null  },
    { label:'FC Máxima',        key:'maxHR',      fmt: v => v ? `${v} bpm` : '—',  better:null  },
    { label:'Ganho de Elev.',   key:'elevGain',   fmt: v => `${v} m`,              better:'max' },
    { label:'Potência Média',   key:'avgPower',   fmt: v => v ? `${v} W` : '—',   better:'max' },
  ];

  rows.forEach(row => {
    const vals = state.activities.map(a => a.summary[row.key] ?? null);
    if (!vals.some(v => v != null)) return;

    const tr = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.className = 'row-label';
    tdLabel.textContent = row.label;
    tr.appendChild(tdLabel);

    let bestIdx = null;
    if (row.better) {
      const valid = vals.filter(v => v != null);
      const best  = row.better === 'max' ? Math.max(...valid) : Math.min(...valid);
      bestIdx = vals.indexOf(best);
    }

    vals.forEach((val, idx) => {
      const td = document.createElement('td');
      td.className = 'pr-6' + (idx === bestIdx ? ' best-val' : '');
      td.textContent = row.fmt(val);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

// ──────────────────────────────────────────────────────
// MAPA — LEAFLET
// ──────────────────────────────────────────────────────
function initMap() {
  const container = document.getElementById('mapContainer');
  if (!container) return;

  // Destrói mapa anterior se houver
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.mapLayers = [];
  }

  // Filtra atividades com coordenadas GPS
  const withGPS = state.activities.filter(a => a.gpsTrack && a.gpsTrack.length > 1);

  if (!withGPS.length) {
    container.innerHTML = `
      <div style="height:100%;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3);">
        <div style="text-align:center;color:rgba(255,255,255,0.3);font-family:'Fira Code',monospace;font-size:13px;">
          <div style="font-size:40px;margin-bottom:12px;">🗺️</div>
          <p>Nenhum dado GPS encontrado nos arquivos.</p>
          <p style="font-size:11px;margin-top:6px;color:rgba(255,255,255,0.15);">TCX com coordenadas Position ou GPX são necessários.</p>
        </div>
      </div>
    `;
    return;
  }

  // Cria mapa Leaflet com tile dark
  state.map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
  });

  // Tile layer inicial (dark)
  setMapTile('dark');

  // Adiciona polylines coloridas
  state.mapLayers = [];
  const allBounds = [];

  withGPS.forEach(act => {
    const track = act.gpsTrack;

    // Polyline com sombra (efeito glow)
    const shadow = L.polyline(track, {
      color: act.color,
      weight: 6,
      opacity: 0.15,
      smoothFactor: 1.5,
    }).addTo(state.map);

    const line = L.polyline(track, {
      color: act.color,
      weight: 3,
      opacity: 0.9,
      smoothFactor: 1.5,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(state.map);

    // Marcador de início
    const startIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:14px;height:14px;border-radius:50%;
        background:${act.color};border:2px solid white;
        box-shadow:0 0 12px ${act.color};
      "></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    const startMarker = L.marker(track[0], { icon: startIcon })
      .bindTooltip(`🚩 Início — ${act.filename}`, { className: 'map-tooltip' });

    // Marcador de fim
    const endIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:14px;height:14px;border-radius:50%;
        background:white;border:3px solid ${act.color};
        box-shadow:0 0 12px ${act.color};
      "></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    const endMarker = L.marker(track[track.length - 1], { icon: endIcon })
      .bindTooltip(`🏁 Fim — ${act.filename}`, { className: 'map-tooltip' });

    startMarker.addTo(state.map);
    endMarker.addTo(state.map);

    // Popup no hover da polyline
    line.bindPopup(`
      <div style="font-family:'Fira Code',monospace;font-size:11px;color:#222;min-width:160px;">
        <div style="font-weight:600;margin-bottom:6px;color:${act.color};">● ${act.filename}</div>
        <div>📍 ${fmtDist(act.summary.totalDistM)}</div>
        <div>⏱ ${secondsToHMS(act.summary.totalSec)}</div>
        ${act.summary.avgHR ? `<div>❤️ FC média: ${act.summary.avgHR} bpm</div>` : ''}
        ${act.summary.elevGain ? `<div>⛰️ Ganho: ${act.summary.elevGain} m</div>` : ''}
      </div>
    `);

    state.mapLayers.push({ act, shadow, line, startMarker, endMarker, visible: true });

    // Acumula bounds para fit
    track.forEach(pt => allBounds.push(pt));
  });

  // Encaixa o mapa nos tracks
  if (allBounds.length) {
    state.map.fitBounds(allBounds, { padding: [40, 40], maxZoom: 16 });
  }

  // Renderiza toggles e legenda
  renderMapControls(withGPS);
}

function setMapTile(styleKey) {
  const tile = MAP_TILES[styleKey] || MAP_TILES.dark;
  if (state.mapTileLayer) state.map.removeLayer(state.mapTileLayer);
  state.mapTileLayer = L.tileLayer(tile.url, {
    attribution: tile.attr,
    maxZoom: 19,
    subdomains: styleKey === 'topo' ? 'abc' : 'abc',
  }).addTo(state.map);
}

function renderMapControls(withGPS) {
  // Layer toggles
  const togglesEl = document.getElementById('mapLayerToggles');
  togglesEl.innerHTML = '';

  state.mapLayers.forEach(layer => {
    const btn = document.createElement('button');
    btn.className = 'map-layer-toggle';
    btn.style.cssText = `border-color:${layer.act.color}60; color:${layer.act.color};`;
    btn.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${layer.act.color};display:inline-block;"></span>
      ${layer.act.filename}
    `;
    btn.addEventListener('click', () => {
      layer.visible = !layer.visible;
      btn.classList.toggle('off', !layer.visible);
      if (layer.visible) {
        layer.shadow.addTo(state.map);
        layer.line.addTo(state.map);
        layer.startMarker.addTo(state.map);
        layer.endMarker.addTo(state.map);
      } else {
        state.map.removeLayer(layer.shadow);
        state.map.removeLayer(layer.line);
        state.map.removeLayer(layer.startMarker);
        state.map.removeLayer(layer.endMarker);
      }
    });
    togglesEl.appendChild(btn);
  });

  // Legenda
  const legendEl = document.getElementById('mapLegend');
  legendEl.innerHTML = '';
  state.mapLayers.forEach(layer => {
    const item = document.createElement('div');
    item.className = 'map-legend-item';
    item.innerHTML = `
      <div class="map-legend-line" style="background:${layer.act.color};box-shadow:0 0 6px ${layer.act.color};"></div>
      <span>${layer.act.filename}</span>
      <span style="color:rgba(255,255,255,0.3)">· ${fmtDist(layer.act.summary.totalDistM)} · ${secondsToHMS(layer.act.summary.totalSec)}</span>
    `;
    legendEl.appendChild(item);
  });

  // Seletor de estilo do mapa
  document.getElementById('mapStyle').addEventListener('change', e => {
    setMapTile(e.target.value);
  });
}

// ──────────────────────────────────────────────────────
// TABS
// ──────────────────────────────────────────────────────
function switchTab(tabId) {
  state.currentTab = tabId;

  // Oculta todos
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  // Exibe o alvo
  document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');

  // Atualiza pills (header e mobile)
  document.querySelectorAll('.tab-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Quando o mapa é exibido, invalida o tamanho (Leaflet precisa disto)
  if (tabId === 'map' && state.map) {
    setTimeout(() => state.map.invalidateSize(), 50);
  }
  // Refaz gráfico ao abrir charts (evita canvas em branco após display:none)
  if (tabId === 'charts') {
    setTimeout(() => { if (state.chart) state.chart.update(); }, 50);
  }
}

// ──────────────────────────────────────────────────────
// DRAG & DROP
// ──────────────────────────────────────────────────────
function initDropZone() {
  const zone  = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');

  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag-active'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-active'); });
  zone.addEventListener('dragover',  e => e.preventDefault());
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-active');
    addFiles(Array.from(e.dataTransfer.files));
  });
  input.addEventListener('change', e => { addFiles(Array.from(e.target.files)); e.target.value = ''; });
}

// ──────────────────────────────────────────────────────
// NAVEGAÇÃO
// ──────────────────────────────────────────────────────
function showUpload() {
  document.getElementById('uploadSection').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('dashNav').classList.add('hidden');
  document.getElementById('dashNavMobile').classList.add('hidden');
  document.getElementById('backBtn').classList.add('hidden');
  document.getElementById('clearBtn').classList.add('hidden');
}

function clearAll() {
  state.activities = [];
  pendingFiles = [];
  clearLS();
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  if (state.miniChart1) { state.miniChart1.destroy(); state.miniChart1 = null; }
  if (state.miniChart2) { state.miniChart2.destroy(); state.miniChart2 = null; }
  if (state.map) { state.map.remove(); state.map = null; }
  state.mapLayers = [];
  renderFileList();
  showUpload();
}

// ──────────────────────────────────────────────────────
// PWA
// ──────────────────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('pwaInstallBtn').classList.remove('hidden');
});
function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    document.getElementById('pwaInstallBtn').classList.add('hidden');
    deferredInstallPrompt = null;
  });
}
window.installPWA = installPWA;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then(r => console.log('[SW] OK:', r.scope))
      .catch(e => console.warn('[SW] Erro:', e));
  });
}

// ──────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initDropZone();

  document.getElementById('compareBtn').addEventListener('click', runComparison);
  document.getElementById('backBtn').addEventListener('click', showUpload);
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Limpar todas as atividades?')) clearAll();
  });

  // Tab listeners — header desktop
  document.getElementById('dashNav').querySelectorAll('.tab-pill').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // Tab listeners — mobile (dentro do dashboard)
  document.querySelectorAll('#dashboard .tab-pill').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Restaura do LocalStorage
  const saved = loadFromLS();
  if (saved && saved.length >= 2) {
    state.activities = saved.map((a, i) => ({
      ...a,
      color: ACTIVITY_COLORS[i % ACTIVITY_COLORS.length],
      index: i,
    }));
    toast(`${saved.length} atividade(s) restaurada(s) do cache`, 'ok');
    renderDashboard();
  }
});
