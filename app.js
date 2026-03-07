/* ════════════════════════════════════════════════════════
   TrackLab — app.js
   Lógica principal: parse TCX/GPX, comparação, gráficos,
   localStorage e suporte a PWA.
════════════════════════════════════════════════════════ */

'use strict';

// ──────────────────────────────────────────────────────
// PALETA DE CORES PARA AS ATIVIDADES
// ──────────────────────────────────────────────────────
const ACTIVITY_COLORS = [
  '#e03a1e', // brand red
  '#3d8ef0', // blue
  '#d4a017', // yellow/gold
  '#3da870', // green
  '#a78bfa', // violet
  '#f472b6', // pink
  '#fb923c', // amber
  '#34d399', // emerald
];

// ──────────────────────────────────────────────────────
// ESTADO GLOBAL DA APLICAÇÃO
// ──────────────────────────────────────────────────────
const state = {
  activities: [],      // Array de objetos Activity parseados
  currentMetric: 'hr', // Métrica ativa no gráfico
  currentAxis: 'time', // Eixo X: 'time' | 'distance'
  chart: null,         // Instância do Chart.js
  leafletMap: null,    // Instância do Leaflet
};

// Métricas disponíveis com label e unidade
const METRICS = {
  hr:       { label: 'Frequência Cardíaca', unit: 'bpm',  key: 'heartRate' },
  power:    { label: 'Potência',            unit: 'W',    key: 'power'     },
  altitude: { label: 'Altitude',            unit: 'm',    key: 'altitude'  },
  speed:    { label: 'Velocidade',          unit: 'km/h', key: 'speed'     },
};

// ──────────────────────────────────────────────────────
// UTILITÁRIOS
// ──────────────────────────────────────────────────────

/** Converte segundos para "hh:mm:ss" ou "mm:ss" */
function secondsToHMS(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

/** Formata metros como "1.23 km" */
function fmtDist(m) {
  return m >= 1000 ? `${(m/1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** Calcula média de array numérico (ignorando NaN/null) */
function avg(arr) {
  const clean = arr.filter(v => v != null && !isNaN(v));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/** Mostra toast temporário */
function toast(msg, type = 'warn') {
  const el = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const text = document.getElementById('toastMsg');
  icon.textContent = type === 'error' ? '✕' : type === 'ok' ? '✓' : '⚠';
  text.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

/** Gera ID único simples */
const uid = () => Math.random().toString(36).slice(2, 9);

// ──────────────────────────────────────────────────────
// PARSING DE ARQUIVOS
// ──────────────────────────────────────────────────────

/**
 * Lê o conteúdo de um File como texto
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Detecta formato pelo nome do arquivo ou conteúdo
 * @returns {'tcx'|'gpx'|null}
 */
function detectFormat(filename, xmlText) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'tcx') return 'tcx';
  if (ext === 'gpx') return 'gpx';
  // fallback pelo conteúdo
  if (xmlText.includes('<TrainingCenterDatabase') || xmlText.includes('<Trackpoint>')) return 'tcx';
  if (xmlText.includes('<gpx') || xmlText.includes('<trkpt')) return 'gpx';
  return null;
}

/**
 * Parseia um arquivo TCX e retorna objeto de atividade normalizado
 * @param {string} xmlText - Conteúdo XML
 * @param {string} name - Nome do arquivo
 * @returns {Object} atividade normalizada
 */
function parseTCX(xmlText, name) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML inválido: ' + parseErr.textContent.slice(0, 80));

  // Nome da atividade (pode estar em Notes ou no tipo de esporte)
  const activityEl = doc.querySelector('Activity');
  const sport = activityEl?.getAttribute('Sport') || 'Desconhecido';

  // Todos os trackpoints
  const trackpoints = Array.from(doc.querySelectorAll('Trackpoint'));
  if (!trackpoints.length) throw new Error('Nenhum Trackpoint encontrado no TCX.');

  const points = [];
  let startTime = null;

  for (const tp of trackpoints) {
    const timeStr = tp.querySelector('Time')?.textContent?.trim();
    if (!timeStr) continue;

    const time = new Date(timeStr);
    if (!startTime) startTime = time;

    const elapsedSec = (time - startTime) / 1000;

    const distRaw = tp.querySelector('DistanceMeters')?.textContent;
    const altRaw  = tp.querySelector('AltitudeMeters')?.textContent;
    const hrRaw   = tp.querySelector('HeartRateBpm Value, HeartRateBpm > Value')?.textContent
                  || tp.querySelector('Value')?.textContent;
    const wattsRaw = tp.querySelector('Watts')?.textContent
                   || tp.querySelector('ns3\\:Watts, Extensions Watts, TPX Watts')?.textContent;

    // Tenta buscar watts nas extensions
    let watts = wattsRaw ? parseFloat(wattsRaw) : null;
    if (!watts) {
      // Procura em qualquer elemento filho de Extensions que contenha "watts" no nome
      const ext = tp.querySelector('Extensions');
      if (ext) {
        const wEl = Array.from(ext.querySelectorAll('*'))
          .find(el => el.tagName.toLowerCase().includes('watt') || el.tagName.toLowerCase().includes('power'));
        if (wEl) watts = parseFloat(wEl.textContent);
      }
    }

    const latRaw = tp.querySelector('LatitudeDegrees')?.textContent;
    const lonRaw = tp.querySelector('LongitudeDegrees')?.textContent;

    points.push({
      elapsedSec,
      distanceM: distRaw ? parseFloat(distRaw) : null,
      altitude:  altRaw  ? parseFloat(altRaw)  : null,
      heartRate: hrRaw   ? parseInt(hrRaw, 10)  : null,
      power:     watts,
      speed:     null, // calculado depois
      lat:       latRaw ? parseFloat(latRaw) : null,
      lon:       lonRaw ? parseFloat(lonRaw) : null,
    });
  }

  return buildActivity(points, name, sport, startTime);
}

/**
 * Parseia um arquivo GPX e retorna objeto de atividade normalizado
 * @param {string} xmlText
 * @param {string} name
 * @returns {Object}
 */
function parseGPX(xmlText, name) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML inválido no GPX');

  // Nome do arquivo/rota
  const trackName = doc.querySelector('trk name')?.textContent?.trim()
                  || doc.querySelector('metadata name')?.textContent?.trim()
                  || 'GPX';

  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (!trkpts.length) throw new Error('Nenhum trkpt encontrado no GPX.');

  const points = [];
  let startTime = null;
  let lastDist = 0;
  let lastLat = null, lastLon = null;

  for (const pt of trkpts) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const timeStr = pt.querySelector('time')?.textContent?.trim();
    const altRaw  = pt.querySelector('ele')?.textContent;
    const hrRaw   = pt.querySelector('gpxtpx\\:hr, hr')?.textContent
                  || findByTagSuffix(pt, 'hr');
    const wattsRaw = pt.querySelector('gpxtpx\\:power, power')?.textContent
                   || findByTagSuffix(pt, 'power');

    let time = null, elapsedSec = 0;
    if (timeStr) {
      time = new Date(timeStr);
      if (!startTime) startTime = time;
      elapsedSec = (time - startTime) / 1000;
    }

    // Calcula distância acumulada via Haversine
    if (lastLat !== null) {
      lastDist += haversineM(lastLat, lastLon, lat, lon);
    }
    lastLat = lat; lastLon = lon;

    points.push({
      elapsedSec,
      distanceM: lastDist,
      altitude:  altRaw  ? parseFloat(altRaw)  : null,
      heartRate: hrRaw   ? parseInt(hrRaw, 10)  : null,
      power:     wattsRaw ? parseFloat(wattsRaw) : null,
      speed:     null,
      lat,
      lon,
    });
  }

  return buildActivity(points, name, trackName, startTime);
}

/** Ajudante: encontra elemento por sufixo de tagName (namespaces GPX) */
function findByTagSuffix(node, suffix) {
  const all = node.querySelectorAll('*');
  for (const el of all) {
    if (el.tagName.toLowerCase().endsWith(':' + suffix) ||
        el.tagName.toLowerCase() === suffix) {
      return el.textContent?.trim() || null;
    }
  }
  return null;
}

/** Fórmula de Haversine: distância em metros entre dois pontos lat/lon */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Constrói o objeto de atividade normalizado a partir dos pontos brutos
 * Calcula velocidade, estatísticas resumo e ganho de elevação
 */
function buildActivity(points, filename, label, startTime) {
  // Calcula velocidade instantânea (km/h) a partir de pontos adjacentes
  for (let i = 1; i < points.length; i++) {
    const prev = points[i-1], curr = points[i];
    const dt = curr.elapsedSec - prev.elapsedSec;
    if (dt > 0 && curr.distanceM != null && prev.distanceM != null) {
      const dm = curr.distanceM - prev.distanceM;
      curr.speed = (dm / dt) * 3.6; // m/s → km/h
    }
  }

  // Estatísticas resumo
  const totalSec    = points.length ? points[points.length-1].elapsedSec : 0;
  const totalDistM  = points.reduce((max, p) => Math.max(max, p.distanceM ?? 0), 0);
  const avgHR       = avg(points.map(p => p.heartRate));
  const maxHR       = Math.max(...points.map(p => p.heartRate ?? 0).filter(Boolean));
  const avgPower    = avg(points.map(p => p.power));
  const avgSpeed    = totalDistM > 0 && totalSec > 0 ? (totalDistM / totalSec) * 3.6 : null;

  // Ganho de elevação (soma dos incrementos positivos)
  let elevGain = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i-1].altitude, curr = points[i].altitude;
    if (prev != null && curr != null && curr > prev) elevGain += curr - prev;
  }

  return {
    id:         uid(),
    filename,
    label:      label || filename,
    startTime,
    points,
    coords:     points.filter(p => p.lat != null && p.lon != null).map(p => [p.lat, p.lon]),
    summary: {
      totalSec,
      totalDistM,
      avgHR:    avgHR   ? Math.round(avgHR)  : null,
      maxHR:    maxHR   || null,
      avgPower: avgPower ? Math.round(avgPower) : null,
      avgSpeed: avgSpeed ? +avgSpeed.toFixed(2)  : null,
      elevGain: Math.round(elevGain),
    },
  };
}

// ──────────────────────────────────────────────────────
// PERSISTÊNCIA — LOCALSTORAGE
// ──────────────────────────────────────────────────────

const LS_KEY = 'tracklab_activities';

/** Salva atividades no LocalStorage (serializa apenas os dados necessários) */
function saveToLS() {
  try {
    const data = state.activities.map(a => ({
      id:       a.id,
      filename: a.filename,
      label:    a.label,
      startTime: a.startTime,
      points:   a.points,
      coords:   a.coords,
      summary:  a.summary,
    }));
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) {
    // Possível QuotaExceededError com arquivos grandes
    console.warn('LocalStorage: não foi possível salvar dados.', e.message);
  }
}

/** Carrega atividades do LocalStorage */
function loadFromLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Remove do LocalStorage */
function clearLS() {
  localStorage.removeItem(LS_KEY);
}

// ──────────────────────────────────────────────────────
// GERENCIAMENTO DE ARQUIVOS (UI)
// ──────────────────────────────────────────────────────

/** Lista de Files pendentes (antes do parse) */
let pendingFiles = [];

function renderFileList() {
  const container = document.getElementById('fileList');
  const compareBtn = document.getElementById('compareBtn');

  if (!pendingFiles.length) {
    container.classList.add('hidden');
    compareBtn.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = '';

  pendingFiles.forEach((file, idx) => {
    const color = ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length];
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-dot" style="background:${color}"></div>
      <div class="file-card-info">
        <div class="name" title="${file.name}">${file.name}</div>
        <div class="size">${(file.size/1024).toFixed(1)} KB</div>
      </div>
      <button class="file-remove" data-idx="${idx}" title="Remover">✕</button>
    `;
    container.appendChild(card);
  });

  // Botão aparece com ≥1 arquivo; texto muda conforme quantidade
  compareBtn.classList.toggle('hidden', pendingFiles.length < 1);
  if (pendingFiles.length === 1) {
    compareBtn.textContent = 'Visualizar Atividade →';
  } else {
    compareBtn.textContent = 'Comparar Atividades →';
  }

  // Listeners de remoção
  container.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = parseInt(e.target.dataset.idx);
      pendingFiles.splice(i, 1);
      renderFileList();
    });
  });
}

function addFiles(files) {
  const allowed = ['tcx', 'gpx'];
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      toast(`Arquivo "${file.name}" ignorado (somente .tcx e .gpx)`);
      continue;
    }
    // Evita duplicatas pelo nome
    if (pendingFiles.find(f => f.name === file.name)) continue;
    pendingFiles.push(file);
  }
  renderFileList();
}

// ──────────────────────────────────────────────────────
// COMPARAÇÃO — DASHBOARD
// ──────────────────────────────────────────────────────

async function runComparison() {
  if (pendingFiles.length < 1) {
    toast('Adicione pelo menos 1 arquivo');
    return;
  }

  // Start with any pre-loaded challenger activities
  const challengerActivities = (state.activities || []).filter(a => a._fromChallenge);
  state.activities = [];

  // Parse uploaded files
  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    try {
      const text = await readFileText(file);
      const fmt  = detectFormat(file.name, text);
      let activity;

      if (fmt === 'tcx') {
        activity = parseTCX(text, file.name);
      } else if (fmt === 'gpx') {
        activity = parseGPX(text, file.name);
      } else {
        toast(`Formato desconhecido: ${file.name}`, 'error');
        continue;
      }

      activity.color = ACTIVITY_COLORS[i % ACTIVITY_COLORS.length];
      activity.index = i;
      state.activities.push(activity);
    } catch (err) {
      toast(`Erro em ${file.name}: ${err.message}`, 'error');
      console.error(err);
    }
  }

  // Append challenger activities (with offset colors)
  const offset = state.activities.length;
  challengerActivities.forEach((a, i) => {
    state.activities.push({
      ...a,
      color: ACTIVITY_COLORS[(offset + i) % ACTIVITY_COLORS.length],
      index: offset + i,
      _fromChallenge: false,
    });
  });

  if (state.activities.length < 1) {
    toast('Não foi possível processar o arquivo.', 'error');
    return;
  }

  // Persiste no LS
  saveToLS();

  renderDashboard();
}

// ──────────────────────────────────────────────────────
// ZONE CHARTS — Heart Rate & Pace
// ──────────────────────────────────────────────────────

/**
 * HR Zone definitions (% of max HR, Garmin 5-zone model)
 * Returns array of { label, min, max, color }
 */
function hrZoneDefs(maxHR) {
  return [
    { label: 'Z5', min: Math.round(maxHR * 0.90), max: maxHR,                    color: '#e03a1e', range: `> ${Math.round(maxHR * 0.90)} bpm` },
    { label: 'Z4', min: Math.round(maxHR * 0.80), max: Math.round(maxHR * 0.89), color: '#e8502a', range: `${Math.round(maxHR * 0.80)}–${Math.round(maxHR * 0.89)} bpm` },
    { label: 'Z3', min: Math.round(maxHR * 0.70), max: Math.round(maxHR * 0.79), color: '#e06040', range: `${Math.round(maxHR * 0.70)}–${Math.round(maxHR * 0.79)} bpm` },
    { label: 'Z2', min: Math.round(maxHR * 0.60), max: Math.round(maxHR * 0.69), color: '#d4806a', range: `${Math.round(maxHR * 0.60)}–${Math.round(maxHR * 0.69)} bpm` },
    { label: 'Z1', min: 0,                          max: Math.round(maxHR * 0.59), color: '#c4a090', range: `0–${Math.round(maxHR * 0.59)} bpm` },
  ];
}

/**
 * Compute % of time in each HR zone for an activity.
 * Returns array of pct values (same order as hrZoneDefs).
 */
function computeHRZones(activity, maxHR) {
  const zones = hrZoneDefs(maxHR);
  const pts = activity.points.filter(p => p.heartRate != null && p.heartRate > 0);
  if (!pts.length) return zones.map(() => 0);
  const counts = zones.map(() => 0);
  pts.forEach(p => {
    const hr = p.heartRate;
    const idx = zones.findIndex(z => hr >= z.min && hr <= z.max);
    if (idx >= 0) counts[idx]++;
  });
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map(c => Math.round(c / total * 100));
}

/**
 * Pace Zone definitions (sec/km thresholds — Garmin 6-zone model).
 * We infer a "race pace" as the average pace of the activity.
 */
function paceZoneDefs(avgSecPerKm) {
  const rp = avgSecPerKm;
  function fmt(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  return [
    { label: 'Z6', max: rp * 0.86,  min: 0,          color: '#1a6fd4', range: `< ${fmt(rp * 0.86)}/km` },
    { label: 'Z5', max: rp * 0.94,  min: rp * 0.86,  color: '#2e87e8', range: `${fmt(rp * 0.86)}–${fmt(rp * 0.94)}/km` },
    { label: 'Z4', max: rp * 1.00,  min: rp * 0.94,  color: '#4a9ef5', range: `${fmt(rp * 0.94)}–${fmt(rp)}/km` },
    { label: 'Z3', max: rp * 1.08,  min: rp * 1.00,  color: '#6ab2f8', range: `${fmt(rp)}–${fmt(rp * 1.08)}/km` },
    { label: 'Z2', max: rp * 1.18,  min: rp * 1.08,  color: '#8cc8fa', range: `${fmt(rp * 1.08)}–${fmt(rp * 1.18)}/km` },
    { label: 'Z1', max: Infinity,    min: rp * 1.18,  color: '#b0d8fb', range: `> ${fmt(rp * 1.18)}/km` },
  ];
}

function computePaceZones(activity, avgSecPerKm) {
  const zones = paceZoneDefs(avgSecPerKm);
  const pts = activity.points.filter(p => p.speed != null && p.speed > 0.5);
  if (!pts.length) return zones.map(() => 0);
  const counts = zones.map(() => 0);
  pts.forEach(p => {
    const secPerKm = 1000 / p.speed; // speed in m/s → sec/km
    const idx = zones.findIndex(z => secPerKm >= z.min && secPerKm < z.max);
    if (idx >= 0) counts[idx]++;
  });
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map(c => Math.round(c / total * 100));
}

/**
 * Render zone bar rows for one activity into a container element.
 * zones = array of { label, range, color }
 * pcts  = array of numbers (0–100), matching zones order
 */
function renderZoneRows(containerId, zones, pcts) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.innerHTML = zones.map((z, i) => {
    const pct = pcts[i];
    const outside = pct < 18; // pct label outside bar when too narrow
    return `
    <div class="zone-row">
      <span class="zone-lbl">${z.label}</span>
      <div class="zone-bar-wrap">
        <div class="zone-bar-track">
          <div class="zone-bar-fill${outside ? ' pct-outside' : ''}"
               style="background:${z.color};width:0;"
               data-target="${pct}"
               data-pct="${pct}%">
          </div>
        </div>
      </div>
      <span class="zone-range">${z.range}</span>
    </div>`;
  }).join('');

  // Animate bars after paint
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.querySelectorAll('.zone-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.target + '%';
      });
    });
  });
}

/**
 * Build activity switcher tabs for a zone panel.
 * Returns the currently selected index.
 */
function buildZoneTabs(tabsId, rowsId, subId, activities, buildFn) {
  const tabs = document.getElementById(tabsId);
  if (!tabs) return;
  tabs.innerHTML = '';
  if (activities.length <= 1) return; // no tabs needed for single activity

  activities.forEach((act, i) => {
    const btn = document.createElement('button');
    btn.className = 'zone-tab' + (i === 0 ? ' active' : '');
    btn.style.cssText = i === 0 ? `color:${act.color};border-color:${act.color}33;background:${act.color}10;` : '';
    btn.textContent = act.filename.replace(/\.(tcx|gpx)$/i, '').slice(0, 16);
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.zone-tab').forEach(b => {
        b.classList.remove('active');
        b.style.cssText = '';
      });
      btn.classList.add('active');
      btn.style.cssText = `color:${act.color};border-color:${act.color}33;background:${act.color}10;`;
      buildFn(i);
    });
    tabs.appendChild(btn);
  });
}

/** Main zone render orchestrator */
function renderZones() {
  const zoneRow = document.getElementById('zoneRow');
  if (!zoneRow) return;

  const activitiesWithHR    = state.activities.filter(a => a.summary?.maxHR > 0 && a.points.some(p => p.heartRate > 0));
  const activitiesWithSpeed = state.activities.filter(a => a.summary?.avgSpeed > 0 && a.points.some(p => p.speed > 0));

  // ── HR ZONES ──
  const hrPanel = document.getElementById('hrZonePanel');
  if (activitiesWithHR.length === 0) {
    document.getElementById('hrZoneRows').innerHTML = '<div class="zone-empty">Dados de frequência cardíaca não disponíveis</div>';
    document.getElementById('hrZoneSub').textContent = 'Sem dados de FC';
  } else {
    function buildHRZones(idx) {
      const act   = activitiesWithHR[idx];
      const maxHR = act.summary.maxHR;
      const defs  = hrZoneDefs(maxHR);
      const pcts  = computeHRZones(act, maxHR);
      document.getElementById('hrZoneSub').textContent = `Based on your max heart rate of ${maxHR} bpm`;
      renderZoneRows('hrZoneRows', defs, pcts);
    }
    buildZoneTabs('hrZoneTabs', 'hrZoneRows', 'hrZoneSub', activitiesWithHR, buildHRZones);
    buildHRZones(0);
  }

  // ── PACE ZONES ──
  if (activitiesWithSpeed.length === 0) {
    document.getElementById('paceZoneRows').innerHTML = '<div class="zone-empty">Dados de pace não disponíveis</div>';
    document.getElementById('paceZoneSub').textContent = 'Sem dados de velocidade';
  } else {
    function buildPaceZones(idx) {
      const act        = activitiesWithSpeed[idx];
      const avgKmh     = act.summary.avgSpeed;
      const avgSecKm   = avgKmh > 0 ? 3600 / avgKmh : 360;
      // Estimate 5k time from avg pace
      const fiveKSec   = avgSecKm * 5;
      const fiveKH     = Math.floor(fiveKSec / 3600);
      const fiveKM     = Math.floor((fiveKSec % 3600) / 60);
      const fiveKS     = Math.floor(fiveKSec % 60);
      const fiveKStr   = fiveKH > 0
        ? `${fiveKH}:${String(fiveKM).padStart(2,'0')}:${String(fiveKS).padStart(2,'0')}`
        : `${fiveKM}:${String(fiveKS).padStart(2,'0')}`;
      const defs = paceZoneDefs(avgSecKm);
      const pcts = computePaceZones(act, avgSecKm);
      document.getElementById('paceZoneSub').textContent =
        `Based on a 5k race time of ${fiveKStr}`;
      renderZoneRows('paceZoneRows', defs, pcts);
    }
    buildZoneTabs('paceZoneTabs', 'paceZoneRows', 'paceZoneSub', activitiesWithSpeed, buildPaceZones);
    buildPaceZones(0);
  }

  // Hide zoneRow entirely if no data at all
  if (activitiesWithHR.length === 0 && activitiesWithSpeed.length === 0) {
    zoneRow.style.display = 'none';
  } else {
    zoneRow.style.display = 'grid';
  }
}

function renderDashboard() {
  const isSingle = state.activities.length === 1;

  document.getElementById('uploadSection').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('clearBtn').classList.remove('hidden');

  document.getElementById('activityCount').textContent =
    isSingle
      ? `1 atividade carregada`
      : `${state.activities.length} atividades comparadas`;

  // Tabela comparativa só faz sentido com 2+ atividades
  const tablePanel = document.getElementById('compTablePanel');
  if (tablePanel) tablePanel.classList.toggle('hidden', isSingle);

  renderSummaryCards();
  if (!isSingle) renderCompTable();
  renderZones();
  buildMetricButtons();
  buildChart();
  buildMap();
}

// ──────────────────────────────────────────────────────
// MAPA — LEAFLET
// ──────────────────────────────────────────────────────

/** Destroi instância anterior do mapa (necessário para re-renderizar) */
function destroyMap() {
  if (state.leafletMap) {
    state.leafletMap.remove();
    state.leafletMap = null;
  }
}

/**
 * Constrói o mapa Leaflet com as rotas das atividades sobrepostas.
 * Usa lat/lon armazenados em activity.coords (array de [lat, lon]).
 */
function buildMap() {
  destroyMap();

  const mapEl = document.getElementById('routeMap');
  if (!mapEl) return;

  // Verifica se alguma atividade tem coordenadas GPS
  const hasCoords = state.activities.some(a => a.coords && a.coords.length > 1);
  const mapSection = document.getElementById('mapSection');

  if (!hasCoords) {
    if (mapSection) mapSection.classList.add('hidden');
    return;
  }
  if (mapSection) mapSection.classList.remove('hidden');

  // Aguarda o Leaflet estar disponível
  if (typeof L === 'undefined') {
    console.warn('Leaflet não carregado ainda');
    return;
  }

  // Reset do tamanho do container (importante após hidden)
  mapEl.style.height = '420px';

  const map = L.map(mapEl, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  });

  // Tile layer escuro — CartoDB Dark Matter
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  const allBounds = [];

  state.activities.forEach(act => {
    if (!act.coords || act.coords.length < 2) return;

    const color = act.color;
    const latlngs = act.coords; // [[lat, lon], ...]

    // Polyline da rota
    const line = L.polyline(latlngs, {
      color,
      weight: 3.5,
      opacity: 0.85,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(map);

    // Glow effect — segunda linha mais grossa e mais transparente
    L.polyline(latlngs, {
      color,
      weight: 8,
      opacity: 0.15,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(map);

    allBounds.push(...latlngs);

    // Marcador de início
    const startIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:14px;height:14px;border-radius:50%;
        background:${color};border:3px solid #fff;
        box-shadow:0 0 8px ${color};
      "></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    // Marcador de fim
    const endIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:12px;height:12px;border-radius:3px;
        background:${color};border:2px solid #fff;
        box-shadow:0 0 8px ${color};transform:rotate(45deg);
      "></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    const startPt = latlngs[0];
    const endPt   = latlngs[latlngs.length - 1];

    L.marker(startPt, { icon: startIcon })
      .bindTooltip(`▶ Início — ${act.filename}`, { direction: 'top', className: 'map-tooltip' })
      .addTo(map);

    L.marker(endPt, { icon: endIcon })
      .bindTooltip(`■ Fim — ${act.filename}`, { direction: 'top', className: 'map-tooltip' })
      .addTo(map);
  });

  // Build legend
  const legendEl = document.getElementById('mapLegend');
  if (legendEl) {
    legendEl.innerHTML = state.activities
      .filter(a => a.coords && a.coords.length > 1)
      .map(a => `
        <div class="map-legend-item">
          <div class="map-legend-line" style="background:${a.color};box-shadow:0 0 6px ${a.color}88;"></div>
          <span style="color:${a.color};">${a.filename}</span>
        </div>`)
      .join('');
  }

  // Ajusta o zoom para englobar todas as rotas
  if (allBounds.length) {
    try {
      map.fitBounds(L.latLngBounds(allBounds), { padding: [32, 32] });
    } catch (e) {
      console.warn('fitBounds error:', e);
    }
  }

  // Força resize após render (evita tiles em branco)
  setTimeout(() => map.invalidateSize(), 100);

  state.leafletMap = map;
}

/** Cartões de resumo com ícones, cores e valores por atividade */
function renderSummaryCards() {
  const container = document.getElementById('summaryCards');
  container.innerHTML = '';

  const fields = [
    { key: 'totalSec',   label: 'Duração',       unit: '',     fmt: v => secondsToHMS(v),             icon: '⏱', accent: '#3d8ef0' },
    { key: 'totalDistM', label: 'Distância',      unit: '',     fmt: v => fmtDist(v),                  icon: '📍', accent: '#d4a017' },
    { key: 'avgSpeed',   label: 'Veloc. Média',   unit: 'km/h', fmt: v => v ? `${v}` : '—',           icon: '⚡', accent: '#e03a1e' },
    { key: 'avgHR',      label: 'FC Média',       unit: 'bpm',  fmt: v => v ? `${v}` : '—',           icon: '♥', accent: '#f05a3a' },
    { key: 'maxHR',      label: 'FC Máxima',      unit: 'bpm',  fmt: v => v ? `${v}` : '—',           icon: '🔥', accent: '#d4a017' },
    { key: 'elevGain',   label: 'Elevação',       unit: 'm',    fmt: v => `${v}`,                      icon: '⛰', accent: '#3da870' },
    { key: 'avgPower',   label: 'Potência Média', unit: 'W',    fmt: v => v ? `${v}` : '—',           icon: '⚙', accent: '#a78bfa' },
  ];

  for (const field of fields) {
    const hasAnyValue = state.activities.some(a => a.summary[field.key] != null);
    if (!hasAnyValue) continue;

    const card = document.createElement('div');
    card.className = 'summary-card';
    card.style.cssText = `--card-accent: ${field.accent};`;

    // Build per-activity rows
    const valRows = state.activities.map(act => {
      const raw = act.summary[field.key];
      const display = raw != null ? field.fmt(raw) : '—';
      const unit = (raw != null && field.unit) ? `<span class="unit">${field.unit}</span>` : '';
      return `
        <div class="summary-act-row">
          <span class="summary-act-dot" style="background:${act.color};box-shadow:0 0 6px ${act.color}55;"></span>
          <span class="summary-act-name">${act.filename.replace(/\.(tcx|gpx)$/i,'')}</span>
          <span class="summary-act-val" style="color:${act.color};">${display}${unit}</span>
        </div>`;
    }).join('');

    card.innerHTML = `
      <div class="summary-card-header">
        <span class="summary-icon" style="color:${field.accent};">${field.icon}</span>
        <span class="summary-label">${field.label}</span>
      </div>
      <div class="summary-act-list">${valRows}</div>
    `;

    container.appendChild(card);
  }
}

/** Tabela comparativa com destaque para melhor valor */
function renderCompTable() {
  const thead = document.querySelector('#compTable thead tr');
  const tbody = document.getElementById('compTableBody');
  thead.innerHTML = '<th class="text-left py-3 pr-6 font-medium text-xs tracking-wider uppercase opacity-30">Métrica</th>';
  tbody.innerHTML = '';

  // Colunas por atividade — chips coloridos
  state.activities.forEach(act => {
    const th = document.createElement('th');
    th.className = 'text-left py-3 pr-4';
    th.innerHTML = `
      <div class="comp-th-chip" style="--chip-color:${act.color};">
        <span class="comp-th-dot" style="background:${act.color};box-shadow:0 0 6px ${act.color};"></span>
        <span class="comp-th-name" style="color:${act.color};">${act.filename.replace(/\.(tcx|gpx)$/i,'')}</span>
      </div>`;
    thead.appendChild(th);
  });

  const rows = [
    { label: 'Duração',          icon: '⏱', key: 'totalSec',   fmt: secondsToHMS,                better: 'min' },
    { label: 'Distância',        icon: '📍', key: 'totalDistM', fmt: fmtDist,                     better: 'max' },
    { label: 'Veloc. Média',     icon: '⚡', key: 'avgSpeed',   fmt: v => v ? `${v} km/h` : '—', better: 'max' },
    { label: 'FC Média',         icon: '♥', key: 'avgHR',      fmt: v => v ? `${v} bpm` : '—',  better: null  },
    { label: 'FC Máxima',        icon: '🔥', key: 'maxHR',      fmt: v => v ? `${v} bpm` : '—',  better: null  },
    { label: 'Ganho Elevação',   icon: '⛰', key: 'elevGain',   fmt: v => `${v} m`,              better: 'max' },
    { label: 'Potência Média',   icon: '⚙', key: 'avgPower',   fmt: v => v ? `${v} W` : '—',    better: 'max' },
  ];

  for (const row of rows) {
    const values = state.activities.map(a => a.summary[row.key] ?? null);
    const hasData = values.some(v => v != null);
    if (!hasData) continue;

    const tr = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.className = 'metric-label pr-6';
    tdLabel.innerHTML = `<span class="metric-icon">${row.icon}</span>${row.label}`;
    tr.appendChild(tdLabel);

    // Determina qual é o melhor valor
    let bestIdx = null;
    if (row.better) {
      const valid = values.filter(v => v != null);
      const bestVal = row.better === 'max' ? Math.max(...valid) : Math.min(...valid);
      bestIdx = values.indexOf(bestVal);
    }

    values.forEach((val, idx) => {
      const td = document.createElement('td');
      td.className = 'pr-4 py-3';
      const actColor = state.activities[idx].color;
      if (idx === bestIdx) {
        td.innerHTML = `<span class="best-val" style="color:${actColor};border-color:${actColor}33;background:${actColor}10;">${row.fmt(val)} <span class="best-crown">★</span></span>`;
      } else {
        td.innerHTML = `<span class="normal-val">${row.fmt(val)}</span>`;
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }
}

// ──────────────────────────────────────────────────────
// GRÁFICO — CHART.JS
// ──────────────────────────────────────────────────────

function buildMetricButtons() {
  const container = document.getElementById('metricBtns');
  container.innerHTML = '';

  // Verifica quais métricas têm dados
  const available = Object.entries(METRICS).filter(([, m]) =>
    state.activities.some(a => a.points.some(p => p[m.key] != null))
  );

  available.forEach(([key, meta], i) => {
    const btn = document.createElement('button');
    btn.className = 'metric-btn' + (key === state.currentMetric ? ' active' : '');
    btn.textContent = meta.label;
    btn.dataset.metric = key;
    btn.addEventListener('click', () => {
      state.currentMetric = key;
      container.querySelectorAll('.metric-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateChartDatasets();
    });
    container.appendChild(btn);
  });

  // Se a métrica atual não tem dados, muda para a primeira disponível
  if (!available.find(([k]) => k === state.currentMetric) && available.length) {
    state.currentMetric = available[0][0];
    container.querySelector('.metric-btn')?.classList.add('active');
  }

  // Eixo X — clona os botões para remover listeners acumulados
  document.querySelectorAll('.axis-btn').forEach(btn => {
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
      state.currentAxis = fresh.dataset.axis;
      document.querySelectorAll('.axis-btn').forEach(b => b.classList.remove('active'));
      fresh.classList.add('active');
      updateChartDatasets();
    });
  });
}

/** Gera os pontos de dados para o eixo X selecionado */
function getDataset(activity, metricKey) {
  const metric = METRICS[metricKey];
  return activity.points
    .filter(p => p[metric.key] != null)
    .map(p => ({
      x: state.currentAxis === 'time'
        ? p.elapsedSec / 60       // em minutos
        : (p.distanceM ?? 0) / 1000, // em km
      y: p[metric.key],
    }));
}

/** Suavização simples por média móvel */
function smooth(data, window = 5) {
  return data.map((pt, i) => {
    const slice = data.slice(Math.max(0, i - window), i + window + 1);
    const avgY = slice.reduce((s, p) => s + p.y, 0) / slice.length;
    return { x: pt.x, y: +avgY.toFixed(1) };
  });
}

function buildChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');

  // Destrói instância anterior se houver
  if (state.chart) state.chart.destroy();

  const metric = METRICS[state.currentMetric];

  const datasets = state.activities.map(act => {
    const rawData = getDataset(act, state.currentMetric);
    const data = smooth(rawData);
    return {
      label: act.filename,
      data,
      borderColor: act.color,
      backgroundColor: act.color + '18',
      fill: false,
      tension: 0.3,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: act.color,
    };
  });

  state.chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: 'rgba(255,255,255,0.5)',
            font: { family: 'JetBrains Mono', size: 11 },
            boxWidth: 14,
            boxHeight: 14,
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          backgroundColor: 'rgba(20,20,20,0.96)',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: 'rgba(255,255,255,0.35)',
          bodyColor: 'rgba(255,255,255,0.85)',
          titleFont: { family: 'JetBrains Mono', size: 10 },
          bodyFont: { family: 'JetBrains Mono', size: 12 },
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
          pan: { enabled: true, mode: 'x' },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: state.currentAxis === 'time' ? 'Tempo (min)' : 'Distância (km)',
            color: 'rgba(255,255,255,0.25)',
            font: { family: 'JetBrains Mono', size: 10 },
          },
          ticks: {
            color: 'rgba(255,255,255,0.25)',
            font: { family: 'JetBrains Mono', size: 10 },
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          title: {
            display: true,
            text: `${metric.label} (${metric.unit})`,
            color: 'rgba(255,255,255,0.25)',
            font: { family: 'JetBrains Mono', size: 10 },
          },
          ticks: {
            color: 'rgba(255,255,255,0.25)',
            font: { family: 'JetBrains Mono', size: 10 },
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
}

function updateChartDatasets() {
  if (!state.chart) return;

  const metric = METRICS[state.currentMetric];

  // Resetar zoom/pan antes de trocar dados — evita sobreposição de linhas
  // causada por limites de escala desatualizados do plugin de zoom
  try { state.chart.resetZoom(); } catch (e) { /* plugin pode não estar ativo */ }

  state.chart.data.datasets = state.activities.map((act) => ({
    label: act.filename,
    data: smooth(getDataset(act, state.currentMetric)),
    borderColor: act.color,
    backgroundColor: act.color + '18',
    fill: false,
    tension: 0.3,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: act.color,
  }));

  // Atualiza labels dos eixos
  state.chart.options.scales.x.title.text =
    state.currentAxis === 'time' ? 'Tempo (min)' : 'Distância (km)';
  state.chart.options.scales.y.title.text =
    `${metric.label} (${metric.unit})`;

  // 'none' em vez de 'active' para redesenhar completamente sem animação residual
  state.chart.update('none');
}

// ──────────────────────────────────────────────────────
// NAVEGAÇÃO
// ──────────────────────────────────────────────────────

function showUpload() {
  document.getElementById('uploadSection').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('clearBtn').classList.add('hidden');
}

function clearAll() {
  state.activities = [];
  pendingFiles = [];
  clearLS();
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  destroyMap();
  renderFileList();
  showUpload();
}

// ──────────────────────────────────────────────────────
// DRAG AND DROP
// ──────────────────────────────────────────────────────

function initDropZone() {
  const zone = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');

  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag-active'); });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-active');
  });
  zone.addEventListener('dragover', e => e.preventDefault());
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-active');
    addFiles(Array.from(e.dataTransfer.files));
  });

  input.addEventListener('change', e => {
    addFiles(Array.from(e.target.files));
    e.target.value = '';
  });
}

// ──────────────────────────────────────────────────────
// PWA — SERVICE WORKER & INSTALL PROMPT
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
  deferredInstallPrompt.userChoice.then(choice => {
    if (choice.outcome === 'accepted') {
      document.getElementById('pwaInstallBtn').classList.add('hidden');
    }
    deferredInstallPrompt = null;
  });
}
window.installPWA = installPWA;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').then(reg => {
      console.log('[SW] Registrado:', reg.scope);
    }).catch(err => {
      console.warn('[SW] Falha no registro:', err);
    });
  });
}

// ──────────────────────────────────────────────────────
// INICIALIZAÇÃO
// ──────────────────────────────────────────────────────

/** Called by auth system once user is logged in */
function initApp() {
  initDropZone();

  // Botão comparar
  document.getElementById('compareBtn').addEventListener('click', async () => {
    await runComparison();
    // Save to history after comparison completes
    if (window.addToHistory && state.activities.length >= 1) {
      window.addToHistory(state.activities);
    }
  });

  // Voltar
  document.getElementById('backBtn').addEventListener('click', showUpload);

  // Limpar tudo
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Limpar todas as atividades carregadas?')) clearAll();
  });

  // Restaura dados do LocalStorage se existirem
  const saved = loadFromLS();
  if (saved && saved.length >= 1) {
    state.activities = saved.map((a, i) => ({
      ...a,
      color: ACTIVITY_COLORS[i % ACTIVITY_COLORS.length],
      index: i,
    }));
    toast(`${saved.length} atividade(s) restaurada(s) do cache`, 'ok');
    renderDashboard();
  }
}
window.initApp = initApp;

// Expose state globally for history integration
window.state = state;
