/* ════════════════════════════════════════════════════════
   TrackLab — app.js  v3  (corrigido + responsivo)
   Bugs corrigidos vs v2:
   - Referência a #dashNavMobile que não existe no HTML
   - compTableHead seletor correto
   - font-size literal corrompido pelo sed
   - isMobile() calculado no momento do uso
   - switchTab sincroniza TODOS os .tab-pill
   - Listener duplicado no mapStyle removido via cloneNode
   - parseFloat seguro em todos os campos
════════════════════════════════════════════════════════ */
'use strict';

// ─── Helpers ─────────────────────────────────────────
const isMobile = () => window.innerWidth < 640;

// ─── Paleta ──────────────────────────────────────────
const ACTIVITY_COLORS = [
  '#00f5ff','#f107a3','#00ff87','#ff6b35',
  '#ffe100','#c084fc','#38bdf8','#fb923c',
];

const KPI_CLASSES = ['kpi-purple','kpi-pink','kpi-cyan','kpi-green','kpi-orange','kpi-yellow'];
const KPI_ICONS   = {
  totalSec:'⏱', totalDistM:'📍', avgSpeed:'🚀',
  avgHR:'❤️',   maxHR:'💓',      elevGain:'⛰️', avgPower:'⚡',
};

// ─── Estado ──────────────────────────────────────────
const state = {
  activities:   [],
  currentMetric:'hr',
  currentAxis:  'time',
  currentTab:   'summary',
  chart:        null,
  miniChart1:   null,
  miniChart2:   null,
  map:          null,
  mapLayers:    [],
  mapTileLayer: null,
};

const METRICS = {
  hr:       { label:'Freq. Cardíaca', unit:'bpm',  key:'heartRate' },
  power:    { label:'Potência',       unit:'W',    key:'power'     },
  altitude: { label:'Altitude',       unit:'m',    key:'altitude'  },
  speed:    { label:'Velocidade',     unit:'km/h', key:'speed'     },
};

const MAP_TILES = {
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',                                  attr:'© CARTO' },
  satellite: { url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',  attr:'© Esri'  },
  topo:      { url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',                                               attr:'© OpenTopoMap' },
  street:    { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                                             attr:'© OpenStreetMap' },
};

// ════════════════════════════════════════════════════════
// UTILITÁRIOS
// ════════════════════════════════════════════════════════
function secondsToHMS(s) {
  s = Math.max(0, +s || 0);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function fmtDist(m) {
  m = +m || 0;
  return m >= 1000 ? `${(m/1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function avg(arr) {
  const c = arr.filter(v => v != null && !isNaN(v));
  return c.length ? c.reduce((a,b) => a+b, 0) / c.length : null;
}

function parseFloatSafe(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).trim());
  return isNaN(n) ? null : n;
}

function toast(msg, type = 'warn') {
  const el = document.getElementById('toast');
  if (!el) return;
  document.getElementById('toastIcon').textContent = type==='error' ? '✕' : type==='ok' ? '✓' : '⚠';
  document.getElementById('toastMsg').textContent  = msg;
  el.classList.remove('hidden');
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

const uid = () => Math.random().toString(36).slice(2,9);

// ════════════════════════════════════════════════════════
// PARSE TCX
// ════════════════════════════════════════════════════════
function parseTCX(xmlText, name) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido no TCX');

  const sport = doc.querySelector('Activity')?.getAttribute('Sport') || 'Treino';
  const tps   = Array.from(doc.querySelectorAll('Trackpoint'));
  if (!tps.length) throw new Error('Nenhum Trackpoint no TCX');

  const points   = [];
  let startTime  = null;

  for (const tp of tps) {
    const timeStr = tp.querySelector('Time')?.textContent?.trim();
    if (!timeStr) continue;
    const time = new Date(timeStr);
    if (isNaN(time)) continue;
    if (!startTime) startTime = time;
    const elapsedSec = (time - startTime) / 1000;

    const lat = parseFloatSafe(tp.querySelector('LatitudeDegrees')?.textContent);
    const lon = parseFloatSafe(tp.querySelector('LongitudeDegrees')?.textContent);
    const distanceM = parseFloatSafe(tp.querySelector('DistanceMeters')?.textContent);
    const altitude  = parseFloatSafe(tp.querySelector('AltitudeMeters')?.textContent);

    let heartRate = null;
    const hrBpm = tp.querySelector('HeartRateBpm');
    if (hrBpm) {
      const v = hrBpm.querySelector('Value');
      if (v) heartRate = parseInt(v.textContent, 10) || null;
    }

    let power = null;
    const ext = tp.querySelector('Extensions');
    if (ext) {
      const wEl = Array.from(ext.querySelectorAll('*'))
        .find(el => /watt|power/i.test(el.tagName));
      if (wEl) power = parseFloatSafe(wEl.textContent);
    }

    points.push({ elapsedSec, lat, lon, distanceM, altitude, heartRate, power, speed:null });
  }

  if (!points.length) throw new Error('Nenhum ponto válido no TCX');
  return buildActivity(points, name, sport, startTime);
}

// ════════════════════════════════════════════════════════
// PARSE GPX
// ════════════════════════════════════════════════════════
function parseGPX(xmlText, name) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido no GPX');

  const label = doc.querySelector('trk name')?.textContent?.trim()
              || doc.querySelector('metadata name')?.textContent?.trim()
              || name;

  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (!trkpts.length) throw new Error('Nenhum trkpt no GPX');

  const points  = [];
  let startTime = null;
  let lastDist  = 0;
  let lastLat   = null, lastLon = null;

  for (const pt of trkpts) {
    const lat = parseFloatSafe(pt.getAttribute('lat'));
    const lon = parseFloatSafe(pt.getAttribute('lon'));
    if (lat === null || lon === null) continue;

    let elapsedSec = 0;
    const timeStr  = pt.querySelector('time')?.textContent?.trim();
    if (timeStr) {
      const t = new Date(timeStr);
      if (!isNaN(t)) {
        if (!startTime) startTime = t;
        elapsedSec = (t - startTime) / 1000;
      }
    }

    const altitude  = parseFloatSafe(pt.querySelector('ele')?.textContent);
    const heartRate = parseInt(findTagSuffix(pt,'hr') || '', 10) || null;
    const power     = parseFloatSafe(findTagSuffix(pt,'power'));

    if (lastLat !== null) lastDist += haversineM(lastLat, lastLon, lat, lon);
    lastLat = lat; lastLon = lon;

    points.push({ elapsedSec, lat, lon, distanceM:lastDist, altitude, heartRate, power, speed:null });
  }

  if (!points.length) throw new Error('Nenhum ponto válido no GPX');
  return buildActivity(points, name, label, startTime);
}

function findTagSuffix(node, suffix) {
  for (const el of node.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === suffix || tag.endsWith(':'+suffix)) return el.textContent?.trim() || null;
  }
  return null;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = d => d * Math.PI/180;
  const dLat = r(lat2-lat1), dLon = r(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ════════════════════════════════════════════════════════
// BUILD ACTIVITY
// ════════════════════════════════════════════════════════
function buildActivity(points, filename, label, startTime) {
  for (let i = 1; i < points.length; i++) {
    const p = points[i-1], c = points[i];
    const dt = c.elapsedSec - p.elapsedSec;
    if (dt > 0 && c.distanceM != null && p.distanceM != null) {
      c.speed = ((c.distanceM - p.distanceM) / dt) * 3.6;
    }
  }

  const totalSec   = points[points.length-1].elapsedSec;
  const totalDistM = points.reduce((mx,p) => Math.max(mx, p.distanceM ?? 0), 0);

  const hrs  = points.map(p => p.heartRate).filter(v => v && v > 0 && v < 300);
  const pows = points.map(p => p.power).filter(v => v && v > 0);

  const avgHR    = hrs.length  ? Math.round(avg(hrs))  : null;
  const maxHR    = hrs.length  ? Math.max(...hrs)       : null;
  const avgPower = pows.length ? Math.round(avg(pows)) : null;
  const avgSpeed = totalDistM > 0 && totalSec > 0
    ? +((totalDistM/totalSec)*3.6).toFixed(2) : null;

  let elevGain = 0;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i].altitude ?? 0) - (points[i-1].altitude ?? 0);
    if (d > 0) elevGain += d;
  }

  const gpsTrack = points
    .filter(p => p.lat != null && p.lon != null && !isNaN(p.lat) && !isNaN(p.lon))
    .map(p => [p.lat, p.lon]);

  return {
    id:uid(), filename, label:label||filename, startTime,
    points, gpsTrack,
    summary:{ totalSec, totalDistM, avgHR, maxHR, avgPower, avgSpeed, elevGain:Math.round(elevGain) },
  };
}

// ════════════════════════════════════════════════════════
// LOCAL STORAGE
// ════════════════════════════════════════════════════════
const LS_KEY = 'tracklab_v3';

function saveToLS() {
  try {
    const data = state.activities.map(a => ({
      id:a.id, filename:a.filename, label:a.label,
      startTime:a.startTime, points:a.points,
      gpsTrack:a.gpsTrack, summary:a.summary,
    }));
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch(e) { console.warn('LS save failed:', e.message); }
}

function loadFromLS() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)||'null') || []; }
  catch { return []; }
}

function clearLS() { localStorage.removeItem(LS_KEY); }

// ════════════════════════════════════════════════════════
// ARQUIVOS
// ════════════════════════════════════════════════════════
let pendingFiles = [];

function addFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['tcx','gpx'].includes(ext)) { toast(`"${f.name}" ignorado — use .tcx ou .gpx`); continue; }
    if (!pendingFiles.find(x => x.name===f.name)) pendingFiles.push(f);
  }
  renderFileList();
}

function renderFileList() {
  const container = document.getElementById('fileList');
  const btn       = document.getElementById('compareBtn');
  if (!pendingFiles.length) {
    container.classList.add('hidden');
    btn.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '';
  pendingFiles.forEach((f, idx) => {
    const color = ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length];
    const card  = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-dot" style="background:${color};color:${color};"></div>
      <div class="flex-1 min-w-0">
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-size">${(f.size/1024).toFixed(1)} KB</div>
      </div>
      <button class="file-remove" data-idx="${idx}" aria-label="Remover">✕</button>
    `;
    container.appendChild(card);
  });
  btn.classList.toggle('hidden', pendingFiles.length < 2);
  container.querySelectorAll('.file-remove').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      pendingFiles.splice(parseInt(b.dataset.idx), 1);
      renderFileList();
    });
  });
}

// ════════════════════════════════════════════════════════
// COMPARAÇÃO
// ════════════════════════════════════════════════════════
async function runComparison() {
  if (pendingFiles.length < 2) { toast('Adicione ao menos 2 arquivos'); return; }

  const btn = document.getElementById('compareBtn');
  btn.innerHTML = '<span>Processando…</span>';
  btn.disabled  = true;

  state.activities = [];
  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    try {
      const text = await readFileText(file);
      const fmt  = detectFormat(file.name, text);
      if (!fmt) { toast(`Formato desconhecido: ${file.name}`, 'error'); continue; }
      const act  = fmt==='tcx' ? parseTCX(text, file.name) : parseGPX(text, file.name);
      act.color  = ACTIVITY_COLORS[i % ACTIVITY_COLORS.length];
      act.index  = i;
      state.activities.push(act);
    } catch(err) {
      toast(`Erro em ${file.name}: ${err.message}`, 'error');
      console.error(err);
    }
  }

  btn.innerHTML = '<span>Comparar Atividades</span><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 9h10M10 5l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btn.disabled  = false;

  if (state.activities.length < 2) {
    toast('Não foi possível processar arquivos suficientes.', 'error');
    return;
  }
  saveToLS();
  renderDashboard();
}

function readFileText(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('Falha ao ler arquivo'));
    r.readAsText(file, 'UTF-8');
  });
}

function detectFormat(name, text) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext==='tcx') return 'tcx';
  if (ext==='gpx') return 'gpx';
  if (text.includes('<Trackpoint')) return 'tcx';
  if (text.includes('<trkpt'))      return 'gpx';
  return null;
}

// ════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════
function renderDashboard() {
  document.getElementById('uploadSection').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('dashNav').classList.remove('hidden');
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

function renderActivityStrip() {
  const el = document.getElementById('activityStrip');
  if (!el) return;
  el.innerHTML = '';
  state.activities.forEach(act => {
    const badge = document.createElement('div');
    badge.className = 'act-badge';
    badge.style.cssText = `border-color:${act.color}50;background:${act.color}15;color:${act.color};`;
    badge.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${act.color};
        display:inline-block;box-shadow:0 0 8px ${act.color};flex-shrink:0;"></span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${act.filename}</span>
    `;
    el.appendChild(badge);
  });
}

function renderSummaryCards() {
  const el = document.getElementById('summaryCards');
  if (!el) return;
  el.innerHTML = '';

  const fields = [
    { key:'totalSec',   label:'Tempo Total',   fmt: v => secondsToHMS(v) },
    { key:'totalDistM', label:'Distância',      fmt: v => fmtDist(v) },
    { key:'avgSpeed',   label:'Veloc. Média',   fmt: v => v ? `${v} km/h` : '—' },
    { key:'avgHR',      label:'FC Média',       fmt: v => v ? `${v} bpm` : '—' },
    { key:'maxHR',      label:'FC Máxima',      fmt: v => v ? `${v} bpm` : '—' },
    { key:'elevGain',   label:'Ganho Elev.',    fmt: v => `${v} m` },
    { key:'avgPower',   label:'Potência Média', fmt: v => v ? `${v} W` : '—' },
  ];

  fields.forEach((field, fi) => {
    if (!state.activities.some(a => a.summary[field.key] != null)) return;
    const card = document.createElement('div');
    card.className = `kpi-card ${KPI_CLASSES[fi % KPI_CLASSES.length]}`;
    card.style.animationDelay = `${fi * 60}ms`;

    card.innerHTML = `
      <span class="kpi-icon">${KPI_ICONS[field.key]||'◈'}</span>
      <div class="kpi-label">${field.label}</div>
      <div class="kpi-values">
        ${state.activities.map(act => `
          <div class="kpi-val">
            <span class="dot" style="background:${act.color};box-shadow:0 0 6px ${act.color};"></span>
            <span>${field.fmt(act.summary[field.key])}</span>
          </div>`).join('')}
      </div>
    `;
    el.appendChild(card);
  });
}

// ════════════════════════════════════════════════════════
// MINI CHARTS
// ════════════════════════════════════════════════════════
function renderMiniCharts() {
  ['miniChart1','miniChart2'].forEach(k => { if(state[k]){state[k].destroy();state[k]=null;} });

  const miniOpts = {
    responsive:true, maintainAspectRatio:false, animation:false,
    plugins:{ legend:{display:false}, tooltip:{enabled:false} },
    elements:{ point:{radius:0} },
    scales:{
      x:{ display:false },
      y:{ display:true,
          ticks:{ color:'rgba(255,255,255,0.25)', font:{family:'Fira Code',size:11}, maxTicksLimit:4 },
          grid:{ color:'rgba(255,255,255,0.05)' } },
    },
  };

  const buildMini = (canvasId, metricKey, stateKey) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const datasets = state.activities.map(act => ({
      data:            smooth(getDatasetRaw(act, metricKey)).map(p => p.y),
      borderColor:     act.color,
      backgroundColor: act.color+'18',
      fill:true, tension:0.4, borderWidth:2, pointRadius:0,
    }));
    const maxLen = Math.max(...datasets.map(d => d.data.length), 1);
    state[stateKey] = new Chart(canvas.getContext('2d'), {
      type:'line',
      data:{ labels:Array.from({length:maxLen},(_,i)=>i), datasets },
      options: miniOpts,
    });
  };

  buildMini('miniChart1','power','miniChart1');
  buildMini('miniChart2','hr','miniChart2');
}

// ════════════════════════════════════════════════════════
// GRÁFICO PRINCIPAL
// ════════════════════════════════════════════════════════
function buildMetricButtons() {
  const container = document.getElementById('metricBtns');
  if (!container) return;
  container.innerHTML = '';

  const available = Object.entries(METRICS).filter(([,m]) =>
    state.activities.some(a => a.points.some(p => p[m.key] != null))
  );
  if (!available.find(([k]) => k===state.currentMetric) && available.length) {
    state.currentMetric = available[0][0];
  }

  available.forEach(([key]) => {
    const btn = document.createElement('button');
    btn.className   = 'metric-btn'+(key===state.currentMetric?' active':'');
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

  // Eixo X — substitui botões para remover listeners antigos
  const xBtns = document.getElementById('xAxisBtns');
  if (xBtns) {
    xBtns.querySelectorAll('.axis-btn').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', () => {
        state.currentAxis = fresh.dataset.axis;
        xBtns.querySelectorAll('.axis-btn').forEach(b => b.classList.remove('active'));
        fresh.classList.add('active');
        updateChart();
      });
    });
  }
}

function getDatasetRaw(act, metricKey) {
  const key = METRICS[metricKey].key;
  return act.points
    .filter(p => p[key] != null && !isNaN(p[key]))
    .map(p => ({
      x: state.currentAxis==='time' ? p.elapsedSec/60 : (p.distanceM??0)/1000,
      y: p[key],
    }));
}

function smooth(data, win=7) {
  if (!data.length) return [];
  return data.map((pt,i) => {
    const s = data.slice(Math.max(0,i-win), i+win+1);
    return { x:pt.x, y:+(s.reduce((a,b)=>a+b.y,0)/s.length).toFixed(1) };
  });
}

function buildChart() {
  const canvas = document.getElementById('mainChart');
  if (!canvas) return;
  if (state.chart) { state.chart.destroy(); state.chart=null; }

  const metric = METRICS[state.currentMetric];
  const fs     = isMobile() ? 11 : 12;  // font size calculado agora

  state.chart = new Chart(canvas.getContext('2d'), {
    type:'line',
    data:{ datasets: state.activities.map(act => ({
      label:                     act.filename,
      data:                      smooth(getDatasetRaw(act, state.currentMetric)),
      borderColor:               act.color,
      backgroundColor:           act.color+'15',
      fill:false, tension:0.35, borderWidth:2.5,
      pointRadius:0,
      pointHoverRadius:          isMobile() ? 4 : 6,
      pointHoverBackgroundColor: act.color,
      pointHoverBorderColor:     'white',
    }))},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{
          display:true,
          labels:{ color:'rgba(255,255,255,0.55)', font:{family:'Fira Code',size:fs},
                   boxWidth:14, boxHeight:3, usePointStyle:true, pointStyle:'rectRounded' },
        },
        tooltip:{
          backgroundColor:'rgba(13,2,33,0.96)',
          borderColor:'rgba(123,47,247,0.45)', borderWidth:1,
          titleColor:'rgba(255,255,255,0.45)', bodyColor:'rgba(255,255,255,0.9)',
          titleFont:{ family:'Fira Code', size:fs },
          bodyFont: { family:'Fira Code', size:fs+2 },
          padding: isMobile() ? 8 : 14,
          callbacks:{
            title: items => {
              const x = items[0].parsed.x;
              return state.currentAxis==='time'
                ? `⏱ ${secondsToHMS(x*60)}`
                : `📍 ${x.toFixed(2)} km`;
            },
            label: item => ` ${item.dataset.label}: ${item.parsed.y} ${metric.unit}`,
          },
        },
        zoom:{
          zoom:{ wheel:{enabled:true}, pinch:{enabled:true}, mode:'x' },
          pan: { enabled:true, mode:'x' },
        },
      },
      scales:{
        x:{
          type:'linear',
          title:{ display:!isMobile(), text: state.currentAxis==='time'?'Tempo (min)':'Distância (km)',
                  color:'rgba(255,255,255,0.25)', font:{family:'Fira Code',size:fs} },
          ticks:{ color:'rgba(255,255,255,0.25)', font:{family:'Fira Code',size:fs}, maxTicksLimit:8 },
          grid: { color:'rgba(255,255,255,0.05)' },
        },
        y:{
          title:{ display:!isMobile(), text:`${metric.label} (${metric.unit})`,
                  color:'rgba(255,255,255,0.25)', font:{family:'Fira Code',size:fs} },
          ticks:{ color:'rgba(255,255,255,0.25)', font:{family:'Fira Code',size:fs}, maxTicksLimit:6 },
          grid: { color:'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
}

function updateChart() {
  if (!state.chart) return;
  const metric = METRICS[state.currentMetric];
  state.chart.data.datasets = state.activities.map(act => ({
    label:act.filename, data:smooth(getDatasetRaw(act, state.currentMetric)),
    borderColor:act.color, backgroundColor:act.color+'15',
    fill:false, tension:0.35, borderWidth:2.5, pointRadius:0,
    pointHoverRadius:isMobile()?4:6,
    pointHoverBackgroundColor:act.color, pointHoverBorderColor:'white',
  }));
  state.chart.options.scales.x.title.text = state.currentAxis==='time'?'Tempo (min)':'Distância (km)';
  state.chart.options.scales.y.title.text = `${metric.label} (${metric.unit})`;
  state.chart.update('active');
}

// ════════════════════════════════════════════════════════
// TABELA
// ════════════════════════════════════════════════════════
function renderCompTable() {
  const thead = document.getElementById('compTableHead');
  const tbody = document.getElementById('compTableBody');
  if (!thead || !tbody) return;

  thead.innerHTML = '<th class="text-left py-3 pr-4 text-white/30 text-xs tracking-wider uppercase font-medium">Métrica</th>';
  tbody.innerHTML = '';

  state.activities.forEach(act => {
    const th = document.createElement('th');
    th.className = 'text-left py-3 pr-4';
    th.innerHTML = `<span style="color:${act.color}" class="font-mono text-xs block max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap">${act.filename}</span>`;
    thead.appendChild(th);
  });

  const rows = [
    { label:'Tempo Total',    key:'totalSec',   fmt:v=>secondsToHMS(v),          better:'min' },
    { label:'Distância',      key:'totalDistM', fmt:v=>fmtDist(v),               better:'max' },
    { label:'Veloc. Média',   key:'avgSpeed',   fmt:v=>v?`${v} km/h`:'—',        better:'max' },
    { label:'FC Média',       key:'avgHR',      fmt:v=>v?`${v} bpm`:'—',         better:null  },
    { label:'FC Máxima',      key:'maxHR',      fmt:v=>v?`${v} bpm`:'—',         better:null  },
    { label:'Ganho Elev.',    key:'elevGain',   fmt:v=>`${v} m`,                  better:'max' },
    { label:'Potência Média', key:'avgPower',   fmt:v=>v?`${v} W`:'—',           better:'max' },
  ];

  rows.forEach(row => {
    const vals = state.activities.map(a => a.summary[row.key] ?? null);
    if (!vals.some(v => v!=null)) return;

    let bestIdx = null;
    if (row.better) {
      const valid   = vals.filter(v => v!=null);
      const bestVal = row.better==='max' ? Math.max(...valid) : Math.min(...valid);
      bestIdx       = vals.indexOf(bestVal);
    }

    const tr = document.createElement('tr');
    const tdL = document.createElement('td');
    tdL.className   = 'row-label';
    tdL.textContent = row.label;
    tr.appendChild(tdL);

    vals.forEach((val,idx) => {
      const td = document.createElement('td');
      td.className   = 'pr-4'+(idx===bestIdx?' best-val':'');
      td.textContent = row.fmt(val);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ════════════════════════════════════════════════════════
// MAPA
// ════════════════════════════════════════════════════════
function initMap() {
  const container = document.getElementById('mapContainer');
  if (!container) return;
  if (state.map) { state.map.remove(); state.map=null; state.mapLayers=[]; }

  const withGPS = state.activities.filter(a => a.gpsTrack && a.gpsTrack.length > 1);

  if (!withGPS.length) {
    container.innerHTML = `
      <div style="height:100%;display:flex;align-items:center;justify-content:center;
                  flex-direction:column;gap:12px;background:rgba(0,0,0,0.2);">
        <div style="font-size:3rem;">🗺️</div>
        <p style="font-family:'Fira Code',monospace;font-size:0.875rem;
                  color:rgba(255,255,255,0.35);text-align:center;padding:0 1rem;">
          Nenhum dado GPS encontrado.<br/>
          <span style="font-size:0.75rem;color:rgba(255,255,255,0.2);">
            TCX precisa de &lt;Position&gt; ou use arquivos GPX.
          </span>
        </p>
      </div>`;
    return;
  }

  state.map = L.map(container, { zoomControl:true, attributionControl:true });
  setMapTile('dark');

  state.mapLayers = [];
  const allBounds = [];

  withGPS.forEach(act => {
    const track  = act.gpsTrack;
    const shadow = L.polyline(track, { color:act.color, weight:8,  opacity:0.15, smoothFactor:1.5 }).addTo(state.map);
    const line   = L.polyline(track, { color:act.color, weight:3,  opacity:0.9,  smoothFactor:1.5, lineCap:'round', lineJoin:'round' }).addTo(state.map);

    const mkIcon = (bg, border) => L.divIcon({
      className:'',
      html:`<div style="width:14px;height:14px;border-radius:50%;background:${bg};border:2px solid ${border};box-shadow:0 0 10px ${act.color};"></div>`,
      iconSize:[14,14], iconAnchor:[7,7],
    });

    const startM = L.marker(track[0],              {icon:mkIcon(act.color,'white')}).addTo(state.map).bindTooltip(`🚩 Início — ${act.filename}`);
    const endM   = L.marker(track[track.length-1], {icon:mkIcon('white',act.color)}).addTo(state.map).bindTooltip(`🏁 Fim — ${act.filename}`);

    line.bindPopup(`
      <div style="font-family:'Fira Code',monospace;font-size:12px;min-width:160px;">
        <div style="color:${act.color};font-weight:600;margin-bottom:6px;">● ${act.filename}</div>
        <div>📍 ${fmtDist(act.summary.totalDistM)}</div>
        <div>⏱ ${secondsToHMS(act.summary.totalSec)}</div>
        ${act.summary.avgHR    ? `<div>❤️ FC: ${act.summary.avgHR} bpm</div>` : ''}
        ${act.summary.elevGain ? `<div>⛰️ Ganho: ${act.summary.elevGain} m</div>` : ''}
      </div>`);

    state.mapLayers.push({ act, shadow, line, startMarker:startM, endMarker:endM, visible:true });
    track.forEach(pt => allBounds.push(pt));
  });

  if (allBounds.length) state.map.fitBounds(allBounds, { padding:[40,40], maxZoom:16 });
  renderMapControls();
}

function setMapTile(styleKey) {
  const tile = MAP_TILES[styleKey] || MAP_TILES.dark;
  if (state.mapTileLayer) state.map.removeLayer(state.mapTileLayer);
  state.mapTileLayer = L.tileLayer(tile.url, { attribution:tile.attr, maxZoom:19 }).addTo(state.map);
}

function renderMapControls() {
  const togglesEl = document.getElementById('mapLayerToggles');
  if (togglesEl) {
    togglesEl.innerHTML = '';
    state.mapLayers.forEach(layer => {
      const btn = document.createElement('button');
      btn.className = 'map-layer-toggle';
      btn.style.cssText = `border-color:${layer.act.color}60;color:${layer.act.color};`;
      btn.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${layer.act.color};display:inline-block;flex-shrink:0;"></span> ${layer.act.filename}`;
      btn.addEventListener('click', () => {
        layer.visible = !layer.visible;
        btn.classList.toggle('off', !layer.visible);
        if (layer.visible) {
          layer.shadow.addTo(state.map); layer.line.addTo(state.map);
          layer.startMarker.addTo(state.map); layer.endMarker.addTo(state.map);
        } else {
          state.map.removeLayer(layer.shadow); state.map.removeLayer(layer.line);
          state.map.removeLayer(layer.startMarker); state.map.removeLayer(layer.endMarker);
        }
      });
      togglesEl.appendChild(btn);
    });
  }

  const legendEl = document.getElementById('mapLegend');
  if (legendEl) {
    legendEl.innerHTML = '';
    state.mapLayers.forEach(layer => {
      const item = document.createElement('div');
      item.className = 'map-legend-item';
      item.innerHTML = `
        <div class="map-legend-line" style="background:${layer.act.color};box-shadow:0 0 5px ${layer.act.color};"></div>
        <span>${layer.act.filename}</span>
        <span style="color:rgba(255,255,255,0.3)">· ${fmtDist(layer.act.summary.totalDistM)} · ${secondsToHMS(layer.act.summary.totalSec)}</span>`;
      legendEl.appendChild(item);
    });
  }

  // Clona para remover listeners anteriores (evita duplicação ao re-renderizar)
  const ms = document.getElementById('mapStyle');
  if (ms) {
    const fresh = ms.cloneNode(true);
    ms.parentNode.replaceChild(fresh, ms);
    fresh.addEventListener('change', e => setMapTile(e.target.value));
  }
}

// ════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════
function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');
  // Sincroniza TODOS os .tab-pill (header + barra mobile dentro do dashboard)
  document.querySelectorAll('.tab-pill[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab===tabId);
  });
  if (tabId==='map'    && state.map)   setTimeout(() => state.map.invalidateSize(), 100);
  if (tabId==='charts' && state.chart) setTimeout(() => state.chart.update(), 50);
}

// ════════════════════════════════════════════════════════
// DRAG & DROP
// ════════════════════════════════════════════════════════
function initDropZone() {
  const zone  = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');
  if (!zone || !input) return;
  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag-active'); });
  zone.addEventListener('dragleave', e => { if(!zone.contains(e.relatedTarget)) zone.classList.remove('drag-active'); });
  zone.addEventListener('dragover',  e => e.preventDefault());
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-active'); addFiles(Array.from(e.dataTransfer.files)); });
  input.addEventListener('change', e => { addFiles(Array.from(e.target.files)); e.target.value=''; });
}

// ════════════════════════════════════════════════════════
// NAVEGAÇÃO
// ════════════════════════════════════════════════════════
function showUpload() {
  document.getElementById('uploadSection').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('dashNav').classList.add('hidden');
  document.getElementById('backBtn').classList.add('hidden');
  document.getElementById('clearBtn').classList.add('hidden');
}

function clearAll() {
  state.activities = [];
  pendingFiles     = [];
  clearLS();
  if (state.chart)      { state.chart.destroy();     state.chart=null; }
  if (state.miniChart1) { state.miniChart1.destroy(); state.miniChart1=null; }
  if (state.miniChart2) { state.miniChart2.destroy(); state.miniChart2=null; }
  if (state.map)        { state.map.remove();         state.map=null; }
  state.mapLayers = [];
  renderFileList();
  showUpload();
}

// ════════════════════════════════════════════════════════
// PWA
// ════════════════════════════════════════════════════════
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('pwaInstallBtn')?.classList.remove('hidden');
});
function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    document.getElementById('pwaInstallBtn')?.classList.add('hidden');
    deferredInstallPrompt = null;
  });
}
window.installPWA = installPWA;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then(r => console.log('[SW]', r.scope))
      .catch(e => console.warn('[SW] Erro:', e));
  });
}

// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initDropZone();

  document.getElementById('compareBtn').addEventListener('click', runComparison);
  document.getElementById('backBtn').addEventListener('click', showUpload);
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Limpar todas as atividades carregadas?')) clearAll();
  });

  // Registra tabs — funciona para QUALQUER .tab-pill com data-tab no documento
  document.querySelectorAll('.tab-pill[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Restaura LocalStorage
  const saved = loadFromLS();
  if (saved && saved.length >= 2) {
    state.activities = saved.map((a,i) => ({
      ...a,
      color: ACTIVITY_COLORS[i % ACTIVITY_COLORS.length],
      index: i,
    }));
    toast(`${saved.length} atividade(s) restaurada(s) do cache`, 'ok');
    renderDashboard();
  }
});

// ════════════════════════════════════════════════════════
// RESIZE / ORIENTAÇÃO
// ════════════════════════════════════════════════════════
window.addEventListener('resize', () => {
  if (state.chart)      state.chart.resize();
  if (state.miniChart1) state.miniChart1.resize();
  if (state.miniChart2) state.miniChart2.resize();
  if (state.map)        setTimeout(() => state.map.invalidateSize(), 100);
});

window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (state.chart) state.chart.resize();
    if (state.map)   state.map.invalidateSize();
  }, 350);
});
