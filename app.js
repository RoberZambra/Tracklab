/* ════════════════════════════════════════════════════════
   Endurance — app.js
   Lógica principal: parse TCX/GPX, comparação, gráficos,
   localStorage e suporte a PWA.
════════════════════════════════════════════════════════ */

'use strict';

// ──────────────────────────────────────────────────────
// PALETA DE CORES PARA AS ATIVIDADES
// ──────────────────────────────────────────────────────
const ACTIVITY_COLORS = [
  '#0047ff', // royal blue (brand)
  '#e85d1a', // warm orange
  '#0a8a5c', // forest green
  '#9333ea', // violet
  '#0ea5e9', // sky blue
  '#f59e0b', // amber
  '#dc2626', // red
  '#0891b2', // cyan
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
  syncMode: 'elapsed', // 'elapsed' = duração relativa | 'wallclock' = hora real do dia
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

const LS_KEY = 'endurance_activities';

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
      color:          ACTIVITY_COLORS[(offset + i) % ACTIVITY_COLORS.length],
      index:          offset + i,
      _fromChallenge: false,
      // Garante que startTime seja sempre um objeto Date
      startTime: a.startTime instanceof Date
        ? a.startTime
        : (a.startTime ? new Date(a.startTime) : null),
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
    { label: 'Z5', min: Math.round(maxHR * 0.90), max: maxHR,                    color: '#0047ff', range: `> ${Math.round(maxHR * 0.90)} bpm` },
    { label: 'Z4', min: Math.round(maxHR * 0.80), max: Math.round(maxHR * 0.89), color: '#2563ff', range: `${Math.round(maxHR * 0.80)}–${Math.round(maxHR * 0.89)} bpm` },
    { label: 'Z3', min: Math.round(maxHR * 0.70), max: Math.round(maxHR * 0.79), color: '#4a7fff', range: `${Math.round(maxHR * 0.70)}–${Math.round(maxHR * 0.79)} bpm` },
    { label: 'Z2', min: Math.round(maxHR * 0.60), max: Math.round(maxHR * 0.69), color: '#7aa8ff', range: `${Math.round(maxHR * 0.60)}–${Math.round(maxHR * 0.69)} bpm` },
    { label: 'Z1', min: 0,                          max: Math.round(maxHR * 0.59), color: '#b3ccff', range: `0–${Math.round(maxHR * 0.59)} bpm` },
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
 * Render zone bar rows showing ALL activities side-by-side for comparison.
 * zones  = array of { label, range }
 * allPcts = array of arrays — one per activity: [[pct,...], [pct,...]]
 * colors  = array of activity colors
 */
function renderZoneRows(containerId, zones, allPcts, colors) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const single = allPcts.length === 1;

  el.innerHTML = zones.map((z, i) => {
    const bars = allPcts.map((pcts, ai) => {
      const pct = pcts[i];
      const outside = pct < 14;
      const color = colors[ai];
      return `
        <div class="zone-bar-track" style="margin-bottom:${single ? 0 : '3px'};">
          <div class="zone-bar-fill${outside ? ' pct-outside' : ''}"
               style="background:${color};width:0;"
               data-target="${pct}"
               data-pct="${pct}%">
          </div>
        </div>`;
    }).join('');

    return `
    <div class="zone-row">
      <span class="zone-lbl" style="color:${z.color||'var(--muted)'};">${z.label}</span>
      <div class="zone-bar-wrap">${bars}</div>
      <span class="zone-range">${z.range}</span>
    </div>`;
  }).join('');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.querySelectorAll('.zone-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.target + '%';
      });
    });
  });
}

/**
 * Build activity legend (replaces tabs) for a zone panel.
 */
function buildZoneLegend(tabsId, activities) {
  const tabs = document.getElementById(tabsId);
  if (!tabs) return;
  tabs.innerHTML = '';
  if (activities.length <= 1) return;

  activities.forEach(act => {
    const item = document.createElement('div');
    item.style.cssText = `display:inline-flex;align-items:center;gap:.3rem;font-family:var(--font-m);font-size:.75rem;color:var(--muted);`;
    item.innerHTML = `<span style="width:10px;height:10px;border-radius:2px;background:${act.color};flex-shrink:0;display:inline-block;"></span>${act.filename.replace(/\.(tcx|gpx)$/i,'').slice(0,18)}`;
    tabs.appendChild(item);
  });
}

/** Main zone render orchestrator */
function renderZones() {
  const zoneRow = document.getElementById('zoneRow');
  if (!zoneRow) return;

  const activitiesWithHR    = state.activities.filter(a => a.summary?.maxHR > 0 && a.points.some(p => p.heartRate > 0));
  const activitiesWithSpeed = state.activities.filter(a => a.summary?.avgSpeed > 0 && a.points.some(p => p.speed > 0));

  // ── HR ZONES ── show all activities at once
  if (activitiesWithHR.length === 0) {
    document.getElementById('hrZoneRows').innerHTML = '<div class="zone-empty">Dados de frequência cardíaca não disponíveis</div>';
    document.getElementById('hrZoneSub').textContent = 'Sem dados de FC';
  } else {
    // Use max HR across all activities for a unified scale
    const maxHR = Math.max(...activitiesWithHR.map(a => a.summary.maxHR));
    const defs   = hrZoneDefs(maxHR);
    const allPcts = activitiesWithHR.map(act => computeHRZones(act, maxHR));
    const colors  = activitiesWithHR.map(act => act.color);
    document.getElementById('hrZoneSub').textContent = `FC máx. de referência: ${maxHR} bpm`;
    buildZoneLegend('hrZoneTabs', activitiesWithHR);
    renderZoneRows('hrZoneRows', defs, allPcts, colors);
  }

  // ── PACE ZONES ── show all activities at once
  if (activitiesWithSpeed.length === 0) {
    document.getElementById('paceZoneRows').innerHTML = '<div class="zone-empty">Dados de pace não disponíveis</div>';
    document.getElementById('paceZoneSub').textContent = 'Sem dados de velocidade';
  } else {
    // Use average pace across all activities as reference
    const avgSpeeds = activitiesWithSpeed.map(a => a.summary.avgSpeed);
    const refAvgKmh  = avgSpeeds.reduce((s, v) => s + v, 0) / avgSpeeds.length;
    const refSecKm   = refAvgKmh > 0 ? 3600 / refAvgKmh : 360;
    const fiveKSec   = refSecKm * 5;
    const fiveKM     = Math.floor(fiveKSec / 60);
    const fiveKS     = Math.floor(fiveKSec % 60);
    const defs   = paceZoneDefs(refSecKm);
    const allPcts = activitiesWithSpeed.map(act => {
      const secKm = act.summary.avgSpeed > 0 ? 3600 / act.summary.avgSpeed : refSecKm;
      return computePaceZones(act, secKm);
    });
    const colors = activitiesWithSpeed.map(act => act.color);
    document.getElementById('paceZoneSub').textContent =
      `Pace de referência: ${fiveKM}:${String(fiveKS).padStart(2,'0')}/km`;
    buildZoneLegend('paceZoneTabs', activitiesWithSpeed);
    renderZoneRows('paceZoneRows', defs, allPcts, colors);
  }

  if (activitiesWithHR.length === 0 && activitiesWithSpeed.length === 0) {
    zoneRow.style.display = 'none';
  } else {
    zoneRow.style.display = 'grid';
  }
}

// ──────────────────────────────────────────────────────
// SPLITS — por km
// ──────────────────────────────────────────────────────

/**
 * Calcula splits de 1 km a partir dos pontos de uma atividade.
 * Retorna array de { km, durationSec, paceSecPerKm, avgHR, elevGain, elevLoss }
 */
function computeSplits(activity) {
  const pts = activity.points.filter(p => p.distanceM != null);
  if (pts.length < 2) return [];

  const totalDistM = pts[pts.length - 1].distanceM;
  const numFullKm  = Math.floor(totalDistM / 1000);
  const splits = [];

  // Full km splits
  for (let k = 0; k < numFullKm; k++) {
    const targetStart = k * 1000;
    const targetEnd   = (k + 1) * 1000;

    // Find bracketing points
    const iStart = pts.findIndex(p => p.distanceM >= targetStart);
    let   iEnd   = pts.findIndex(p => p.distanceM >= targetEnd);
    if (iEnd < 0) iEnd = pts.length - 1;
    if (iStart < 0 || iStart >= iEnd) continue;

    const segment = pts.slice(iStart, iEnd + 1);
    const durationSec = segment[segment.length - 1].elapsedSec - segment[0].elapsedSec;
    const distSeg     = segment[segment.length - 1].distanceM  - segment[0].distanceM;
    const paceSecPKm  = distSeg > 0 ? (durationSec / distSeg) * 1000 : null;

    const hrs = segment.map(p => p.heartRate).filter(v => v != null && v > 0);
    const avgHR = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;

    let elevGain = 0, elevLoss = 0;
    for (let i = 1; i < segment.length; i++) {
      const dElev = (segment[i].altitude ?? 0) - (segment[i-1].altitude ?? 0);
      if (dElev > 0) elevGain += dElev;
      else elevLoss += Math.abs(dElev);
    }
    const hasElev = segment.some(p => p.altitude != null);

    splits.push({
      km: k + 1,
      label: `${k + 1}`,
      durationSec,
      paceSecPerKm: paceSecPKm,
      avgHR,
      elevGain: hasElev ? Math.round(elevGain) : null,
      elevLoss: hasElev ? Math.round(elevLoss) : null,
    });
  }

  // Partial last km
  const remainM = totalDistM - numFullKm * 1000;
  if (remainM > 50) {
    const iStart = pts.findIndex(p => p.distanceM >= numFullKm * 1000);
    if (iStart >= 0) {
      const segment = pts.slice(iStart);
      const durationSec = segment[segment.length - 1].elapsedSec - segment[0].elapsedSec;
      const distSeg     = segment[segment.length - 1].distanceM  - segment[0].distanceM;
      const paceSecPKm  = distSeg > 0 ? (durationSec / distSeg) * 1000 : null;
      const hrs = segment.map(p => p.heartRate).filter(v => v != null && v > 0);
      const avgHR = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;
      let elevGain = 0;
      for (let i = 1; i < segment.length; i++) {
        const dElev = (segment[i].altitude ?? 0) - (segment[i-1].altitude ?? 0);
        if (dElev > 0) elevGain += dElev;
      }
      const hasElev = segment.some(p => p.altitude != null);
      splits.push({
        km: numFullKm + 1,
        label: `${(remainM / 1000).toFixed(1)}`,
        partial: true,
        durationSec,
        paceSecPerKm: paceSecPKm,
        avgHR,
        elevGain: hasElev ? Math.round(elevGain) : null,
        elevLoss: null,
      });
    }
  }

  return splits;
}

/** Formata seg/km como "m:ss" */
function fmtPace(secPerKm) {
  if (!secPerKm || secPerKm <= 0 || secPerKm > 3600) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.floor(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Formata seg/km como "m:ss" — alias público para compatibilidade */
let _splitsActiveIdx = 0;

function renderSplits() {
  const panel   = document.getElementById('splitsPanel');
  const tabs    = document.getElementById('splitsActivityTabs');
  const content = document.getElementById('splitsContent');
  if (!panel || !tabs || !content) return;

  // Somente atividades com dados de distância
  const eligible = state.activities.filter(a =>
    a.points && a.points.some(p => p.distanceM != null && p.distanceM > 100)
  );

  if (!eligible.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  // ── Modo comparativo (2+ atividades) ────────────────────────────
  if (eligible.length > 1) {
    tabs.innerHTML = ''; // sem tabs individuais no modo comparativo

    // Calcula splits de todas as atividades
    const allSplits = eligible.map(act => ({
      act,
      splits: computeSplits(act),
    }));

    // Máximo de KMs entre todas as atividades
    const maxKm = Math.max(...allSplits.map(d => d.splits.length));
    if (!maxKm) {
      content.innerHTML = '<div style="font-family:var(--font-m);font-size:.8rem;color:var(--muted);padding:.5rem 0;">Dados insuficientes para calcular splits.</div>';
      return;
    }

    // Flags de colunas: presentes em QUALQUER atividade
    const hasHR   = allSplits.some(d => d.splits.some(s => s.avgHR != null));
    const hasElev = allSplits.some(d => d.splits.some(s => s.elevGain != null));

    // Escala global de pace (exclui outliers > 20 min/km)
    const allPaces = allSplits.flatMap(d =>
      d.splits.filter(s => s.paceSecPerKm && s.paceSecPerKm < 1200).map(s => s.paceSecPerKm)
    );
    const globalMax   = allPaces.length ? Math.max(...allPaces) : 600;
    const globalMin   = allPaces.length ? Math.min(...allPaces) : 300;
    const globalRange = globalMax - globalMin || 1;

    // Cabeçalho da tabela — legenda de cores à direita do título (já está no panel-hd)
    let html = `<table class="splits-table">
      <thead>
        <tr>
          <th>KM</th>
          <th class="col-pace" colspan="${eligible.length}">Pace</th>
          <th>Tempo</th>
          ${hasElev ? '<th>Elev</th>' : ''}
          ${hasHR   ? '<th>FC</th>'   : ''}
        </tr>
      </thead>
      <tbody>`;

    for (let km = 1; km <= maxKm; km++) {
      // Separador visual de grupo a cada km
      const isFirstRow = km === 1;

      eligible.forEach((act, ai) => {
        const d = allSplits[ai];
        const s = d.splits.find(sp => sp.km === km);

        const isFirstActivity = ai === 0;
        const isLastActivity  = ai === eligible.length - 1;

        // Célula do número do km — só na primeira linha do grupo, rowspan
        const kmCell = isFirstActivity
          ? `<td rowspan="${eligible.length}" style="vertical-align:middle;font-family:var(--font-d);font-weight:700;font-size:.88rem;color:var(--muted);text-align:center;border-bottom:${isLastActivity ? '' : 'none'};padding-top:${isFirstRow ? '' : '.55rem'};">${s ? (s.partial ? `<span style="opacity:.6;font-size:.7rem;">${s.label}</span>` : s.label) : km}</td>`
          : '';

        if (!s) {
          // Esta atividade não tem este km — linha vazia
          html += `<tr style="border-bottom:${isLastActivity ? '1px solid var(--border2)' : 'none'};">
            ${kmCell}
            <td colspan="${eligible.length}" style="border-bottom:none;"></td>
            <td style="border-bottom:none;"><span class="split-val-muted">—</span></td>
            ${hasElev ? `<td style="border-bottom:none;"><span class="split-val-muted">—</span></td>` : ''}
            ${hasHR   ? `<td style="border-bottom:none;"><span class="split-val-muted">—</span></td>` : ''}
          </tr>`;
          return;
        }

        const barPct = s.paceSecPerKm && s.paceSecPerKm < 1200
          ? Math.min(100, Math.max(6, Math.round(((s.paceSecPerKm - globalMin) / globalRange) * 100)))
          : 100;

        const elevTxt = s.elevGain != null
          ? `<span class="split-val-num">${s.elevGain > 0 ? '+' : ''}${s.elevGain}</span><span class="split-val-muted"> m</span>`
          : '<span class="split-val-muted">—</span>';

        const hrTxt = s.avgHR
          ? `<span class="split-val-num">${s.avgHR}</span>`
          : '<span class="split-val-muted">—</span>';

        // Sublinha só na última atividade do grupo (fecha o bloco do km)
        const rowBorder = isLastActivity
          ? 'border-bottom:1px solid var(--border2);'
          : 'border-bottom:none;';

        // Pequeno padding superior na primeira atividade de cada grupo (exceto o primeiro)
        const rowPadTop = isFirstActivity && !isFirstRow ? 'padding-top:.42rem;' : '';

        html += `<tr style="${rowBorder}">
          ${kmCell}
          <td style="padding:${isFirstActivity && !isFirstRow ? '.42rem' : '.28rem'} .6rem .28rem;border-bottom:none;">
            <div class="split-pace-bar-wrap">
              <span class="split-pace-val" style="color:${act.color};min-width:42px;">${fmtPace(s.paceSecPerKm)}</span>
              <div style="display:flex;align-items:center;gap:4px;flex:1;">
                <div style="width:7px;height:7px;border-radius:50%;background:${act.color};flex-shrink:0;opacity:.8;"></div>
                <div class="split-bar-track" style="flex:1;">
                  <div class="split-bar-fill" style="background:${act.color};width:0;" data-target="${barPct}%"></div>
                </div>
              </div>
            </div>
          </td>
          <td style="${rowPadTop}border-bottom:none;"><span class="split-val-num">${secondsToHMS(s.durationSec)}</span></td>
          ${hasElev ? `<td style="${rowPadTop}border-bottom:none;">${elevTxt}</td>` : ''}
          ${hasHR   ? `<td style="${rowPadTop}border-bottom:none;">${hrTxt}</td>`   : ''}
        </tr>`;
      });
    }

    html += '</tbody></table>';
    content.innerHTML = html;

    // Anima as barras
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        content.querySelectorAll('.split-bar-fill').forEach(bar => {
          bar.style.width = bar.dataset.target;
        });
      });
    });
    return;
  }

  // ── Modo individual (1 atividade) — comportamento original ───────
  if (_splitsActiveIdx >= eligible.length) _splitsActiveIdx = 0;
  tabs.innerHTML = '';

  const act    = eligible[_splitsActiveIdx];
  const splits = computeSplits(act);

  if (!splits.length) {
    content.innerHTML = '<div style="font-family:var(--font-m);font-size:.8rem;color:var(--muted);padding:.5rem 0;">Dados insuficientes para calcular splits.</div>';
    return;
  }

  const hasHR   = splits.some(s => s.avgHR != null);
  const hasElev = splits.some(s => s.elevGain != null);

  const validPaces = splits.filter(s => s.paceSecPerKm && s.paceSecPerKm < 1200).map(s => s.paceSecPerKm);
  const maxPace    = validPaces.length ? Math.max(...validPaces) : 600;
  const minPace    = validPaces.length ? Math.min(...validPaces) : 300;
  const paceRange  = maxPace - minPace || 1;
  const color = act.color;

  let html = `<table class="splits-table">
    <thead>
      <tr>
        <th>KM</th>
        <th class="col-pace">Pace</th>
        <th>Tempo</th>
        ${hasElev ? '<th>Elev</th>' : ''}
        ${hasHR   ? '<th>FC</th>'   : ''}
      </tr>
    </thead>
    <tbody>`;

  splits.forEach(s => {
    const barPct = s.paceSecPerKm && s.paceSecPerKm < 1200
      ? Math.min(100, Math.max(8, Math.round(((s.paceSecPerKm - minPace) / paceRange) * 100)))
      : 100;

    const elevTxt = s.elevGain != null
      ? `<span class="split-val-num">${s.elevGain > 0 ? '+' : ''}${s.elevGain}</span><span class="split-val-muted"> m</span>`
      : '<span class="split-val-muted">—</span>';

    const hrTxt = s.avgHR
      ? `<span class="split-val-num">${s.avgHR}</span>`
      : '<span class="split-val-muted">—</span>';

    html += `<tr>
      <td>${s.label}${s.partial ? '<span style="opacity:.4;font-size:.65rem;"> km</span>' : ''}</td>
      <td>
        <div class="split-pace-bar-wrap">
          <span class="split-pace-val" style="color:${color}">${fmtPace(s.paceSecPerKm)}</span>
          <div class="split-bar-track">
            <div class="split-bar-fill" style="background:${color};width:0;" data-target="${barPct}%"></div>
          </div>
        </div>
      </td>
      <td><span class="split-val-num">${secondsToHMS(s.durationSec)}</span></td>
      ${hasElev ? `<td>${elevTxt}</td>` : ''}
      ${hasHR   ? `<td>${hrTxt}</td>`   : ''}
    </tr>`;
  });

  html += '</tbody></table>';
  content.innerHTML = html;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      content.querySelectorAll('.split-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.target;
      });
    });
  });
}

function renderDashboard() {
  const isSingle = state.activities.length === 1;

  document.getElementById('uploadSection').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('clearBtn').classList.remove('hidden');
  const mobClear = document.getElementById('clearBtnMob');
  if (mobClear) mobClear.classList.remove('hidden');

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
  renderSplits();
  buildMetricButtons();
  buildChart();
  buildMap();

  // Mostra painel de IA e reseta estado
  const aiPanel = document.getElementById('aiPanel');
  if (aiPanel) {
    aiPanel.classList.remove('hidden');
    const aiBody = document.getElementById('aiBody');
    const aiBtn  = document.getElementById('aiAnalyzeBtn');
    if (aiBody) aiBody.innerHTML = `
      <div class="ai-empty" id="aiEmpty">
        <div class="ai-empty-icon">✦</div>
        <div style="font-family:var(--font-d);font-weight:700;font-size:1rem;color:var(--text);margin-bottom:.32rem;">Análise inteligente de treinos</div>
        <div style="font-family:var(--font-m);font-size:.82rem;color:var(--muted);">Clique em <strong>Analisar treinos</strong> para gerar insights personalizados com o Gemini AI sobre seu desempenho${!isSingle ? ', comparação de atividades' : ''}, pontos fortes e sugestões de melhoria.</div>
      </div>`;
    if (aiBtn) {
      aiBtn.disabled = false;
      aiBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg> Analisar treinos`;
    }
  }
}

// ──────────────────────────────────────────────────────
// MAPA — LEAFLET
// ──────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────
// MAPA — CAMADAS
// ──────────────────────────────────────────────────────

const MAP_LAYERS = {
  streets: {
    label: 'Mapa',
    url: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    attr: '© Google Maps',
    subdomains: '0123',
    maxZoom: 21,
  },
  satellite: {
    label: 'Satélite',
    url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    attr: '© Google Maps',
    subdomains: '0123',
    maxZoom: 21,
  },
  terrain: {
    label: 'Relevo',
    url: 'https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
    attr: '© Google Maps',
    subdomains: '0123',
    maxZoom: 21,
  },
};

let _currentTileLayer = null;

function setMapLayer(layerKey) {
  const map = state.leafletMap;
  if (!map) return;
  const cfg = MAP_LAYERS[layerKey] || MAP_LAYERS.streets;
  if (_currentTileLayer) map.removeLayer(_currentTileLayer);
  _currentTileLayer = L.tileLayer(cfg.url, {
    attribution: cfg.attr,
    subdomains: cfg.subdomains || 'abcd',
    maxZoom: cfg.maxZoom,
    crossOrigin: true,
  }).addTo(map);
  // Move tile layer to back so route polylines stay on top
  _currentTileLayer.bringToBack();
  state._currentLayerKey = layerKey;
}

/** Toggle CSS 3D perspective tilt on the map */
function toggle3D() {
  const mapEl  = document.getElementById('routeMap');
  const btn    = document.getElementById('map3dBtn');
  if (!mapEl) return;
  const is3D = mapEl.classList.toggle('map-3d');
  if (btn) btn.classList.toggle('active', is3D);

  // Ao entrar no 3D, ativa camada Relevo; ao sair, restaura a anterior
  if (is3D) {
    state._layerBeforeEscape = state._currentLayerKey || 'streets';
    setMapLayer('terrain');
    document.querySelectorAll('.map-layer-btn:not(#map3dBtn)').forEach(b => {
      b.classList.toggle('active', b.dataset.layer === 'terrain');
    });
  } else {
    const restore = state._layerBeforeEscape || 'streets';
    setMapLayer(restore);
    document.querySelectorAll('.map-layer-btn:not(#map3dBtn)').forEach(b => {
      b.classList.toggle('active', b.dataset.layer === restore);
    });
  }

  // Trigger Leaflet resize after transform settles
  setTimeout(() => { if (state.leafletMap) state.leafletMap.invalidateSize(); }, 450);
}

/** Destroi instância anterior do mapa (necessário para re-renderizar) */
function destroyMap() {
  if (state.leafletMap) {
    state.leafletMap.remove();
    state.leafletMap = null;
  }
  // Reseta o modo seguir ao recarregar
  state.mapFollow = false;
  const btn = document.getElementById('mapFollowBtn');
  if (btn) btn.classList.remove('active');
}

/**
 * Constrói o mapa Leaflet com as rotas das atividades sobrepostas.
 * Inclui timeline scrubber que move marcadores ao longo do trajeto.
 */
function buildMap() {
  destroyMap();

  const mapEl = document.getElementById('routeMap');
  if (!mapEl) return;

  const hasCoords = state.activities.some(a => a.coords && a.coords.length > 1);
  const mapSection = document.getElementById('mapSection');

  if (!hasCoords) {
    if (mapSection) mapSection.classList.add('hidden');
    return;
  }
  if (mapSection) mapSection.classList.remove('hidden');

  if (typeof L === 'undefined') {
    console.warn('Leaflet não carregado ainda');
    return;
  }

  mapEl.style.height = '400px';

  const map = L.map(mapEl, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  });

  state.leafletMap = map; // set early so setMapLayer can use it
  _currentTileLayer = null;
  setMapLayer(state._currentLayerKey || 'streets');

  // Sync layer button UI
  document.querySelectorAll('.map-layer-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.layer === (state._currentLayerKey || 'streets'))
  );

  const allBounds = [];

  // Per-activity data for scrubber
  const scrubData = []; // { act, coords, points, marker }

  state.activities.forEach(act => {
    if (!act.coords || act.coords.length < 2) return;

    const color   = act.color;
    const latlngs = act.coords;

    // Route polyline + glow
    L.polyline(latlngs, { color, weight: 8,   opacity: 0.12, lineJoin: 'round', lineCap: 'round' }).addTo(map);
    L.polyline(latlngs, { color, weight: 3.5, opacity: 0.85, lineJoin: 'round', lineCap: 'round' }).addTo(map);

    allBounds.push(...latlngs);

    // Start marker
    L.marker(latlngs[0], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:13px;height:13px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 8px ${color};"></div>`,
        iconSize: [13, 13], iconAnchor: [6, 6],
      })
    }).bindTooltip(`▶ Início — ${act.filename}`, { direction: 'top', className: 'map-tooltip' }).addTo(map);

    // End marker
    L.marker(latlngs[latlngs.length - 1], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:11px;height:11px;border-radius:3px;background:${color};border:2px solid #fff;box-shadow:0 0 8px ${color};transform:rotate(45deg);"></div>`,
        iconSize: [11, 11], iconAnchor: [5, 5],
      })
    }).bindTooltip(`■ Fim — ${act.filename}`, { direction: 'top', className: 'map-tooltip' }).addTo(map);

    // Scrubber position marker — starts at beginning
    const scrubIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:18px;height:18px;border-radius:50%;
        background:${color};border:3px solid #fff;
        box-shadow:0 0 0 3px ${color}55,0 2px 8px rgba(0,0,0,0.25);
      "></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9],
    });
    const scrubMarker = L.marker(latlngs[0], { icon: scrubIcon, zIndexOffset: 1000 }).addTo(map);

    // KEY FIX: build gpsPoints = only points that have lat, lon AND elapsedSec
    // This keeps coords and time perfectly in sync
    const gpsPoints = (act.points || []).filter(p =>
      p.lat != null && p.lon != null && p.elapsedSec != null
    );

    scrubData.push({ act, gpsPoints, marker: scrubMarker });
  });

  // Legend
  const legendEl = document.getElementById('mapLegend');
  if (legendEl) {
    legendEl.innerHTML = state.activities
      .filter(a => a.coords && a.coords.length > 1)
      .map(a => `
        <div class="map-legend-item">
          <div class="map-legend-line" style="background:${a.color};box-shadow:0 0 6px ${a.color}88;"></div>
          <span style="color:${a.color};">${a.filename}</span>
        </div>`).join('');
  }

  // Fit bounds
  if (allBounds.length) {
    try { map.fitBounds(L.latLngBounds(allBounds), { padding: [32, 32] }); } catch(e) {}
  }

  setTimeout(() => map.invalidateSize(), 100);

  // Auto-ativa wallclock quando ≥2 atividades têm timestamps reais no mesmo dia UTC
  // → permite comparar "quem estava na frente às HH:MM?" sem ajuste manual
  const _validTimes = scrubData.filter(d => d.act.startTime instanceof Date && !isNaN(d.act.startTime));
  if (_validTimes.length >= 2) {
    const _days = new Set(_validTimes.map(d => d.act.startTime.toISOString().slice(0, 10)));
    if (_days.size === 1) state.syncMode = 'wallclock';
  }

  // Pass scrubData to the timeline controller
  initTimeline(scrubData);
}

// ─────────────────────────────────────────────────────────────────────
// TIMELINE — funções globais, listeners registrados UMA vez em initApp
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// VELOCÍMETROS — um por atividade, canto superior direito do mapa
// ─────────────────────────────────────────────────────────────────────

/**
 * Constrói o SVG completo de um velocímetro.
 * Inclui: arco de fundo, arco colorido, ticks com labels de valor,
 * agulha e ponto central. Retorna o elemento DOM criado.
 */
function speedoBuildWidget(actId, actColor, actName, maxSpeed) {
  const SIZE   = 120;
  const cx     = SIZE / 2;       // 60
  const cy     = SIZE / 2;       // 60
  const R_ARC  = 44;             // raio do arco principal
  const R_TICK = 50;             // raio externo dos ticks
  const START_DEG = -225;        // -225° = 7 horas (igual a um relógio)
  const TOTAL_DEG = 270;         // sweep total

  const NS = 'http://www.w3.org/2000/svg';

  // ── helper: ponto em coordenadas cartesianas ──
  const pt = (r, deg) => {
    const rad = deg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  // ── Wrapper ──
  const widget = document.createElement('div');
  widget.className = 'speedo-widget';
  widget.dataset.actId = actId;

  // ── SVG ──
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.classList.add('speedo-svg');

  // Circunferência completa do arco
  const circ = 2 * Math.PI * R_ARC;           // ≈ 276.46
  const arcLen = circ * (TOTAL_DEG / 360);     // ≈ 207.35

  // dashoffset para começar no ângulo certo:
  // O stroke-dasharray começa às 3h (0°). Precisamos começar em START_DEG.
  // Offset = circunferência * (- START_DEG / 360) para rotacionar o início
  // Equivalente a usar um transform rotate no círculo, mas dashoffset é mais simples.
  // Ângulo START_DEG = -225 → offset = circ * (225/360)
  const dashOffset = -(circ * ((-START_DEG) / 360));

  // Fundo do arco (cinza escuro)
  const arcBg = document.createElementNS(NS, 'circle');
  arcBg.setAttribute('cx', cx); arcBg.setAttribute('cy', cy); arcBg.setAttribute('r', R_ARC);
  arcBg.setAttribute('fill', 'none');
  arcBg.setAttribute('stroke', 'rgba(255,255,255,0.08)');
  arcBg.setAttribute('stroke-width', '4');
  arcBg.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${(circ - arcLen).toFixed(2)}`);
  arcBg.setAttribute('stroke-dashoffset', dashOffset.toFixed(2));
  arcBg.setAttribute('stroke-linecap', 'round');
  svg.appendChild(arcBg);

  // Arco colorido (velocidade atual)
  const arcFill = document.createElementNS(NS, 'circle');
  arcFill.setAttribute('cx', cx); arcFill.setAttribute('cy', cy); arcFill.setAttribute('r', R_ARC);
  arcFill.setAttribute('fill', 'none');
  arcFill.setAttribute('stroke', actColor);
  arcFill.setAttribute('stroke-width', '4');
  arcFill.setAttribute('stroke-dasharray', `0 ${circ.toFixed(2)}`);
  arcFill.setAttribute('stroke-dashoffset', dashOffset.toFixed(2));
  arcFill.setAttribute('stroke-linecap', 'round');
  arcFill.style.transition = 'stroke-dasharray .22s ease, stroke .22s ease';
  arcFill.dataset.circ    = circ.toFixed(2);
  arcFill.dataset.arcLen  = arcLen.toFixed(2);
  svg.appendChild(arcFill);

  // ── Ticks + labels de valor (como relógio) ──
  // 5 divisões principais (0, 25%, 50%, 75%, 100%) + 4 menores entre cada par
  const NUM_MAJOR = 5;   // 0, max/4, max/2, 3max/4, max
  const NUM_MINOR = 3;   // entre cada par de major
  const totalTicks = (NUM_MAJOR - 1) * (NUM_MINOR + 1) + 1; // 17

  for (let i = 0; i < totalTicks; i++) {
    const frac      = i / (totalTicks - 1);
    const angleDeg  = START_DEG + frac * TOTAL_DEG;
    const isMajor   = i % (NUM_MINOR + 1) === 0;

    // Tick line
    const rOuter = R_TICK;
    const rInner = isMajor ? R_TICK - 7 : R_TICK - 4;
    const p1 = pt(rOuter, angleDeg);
    const p2 = pt(rInner, angleDeg);
    const tick = document.createElementNS(NS, 'line');
    tick.setAttribute('x1', p1.x.toFixed(2)); tick.setAttribute('y1', p1.y.toFixed(2));
    tick.setAttribute('x2', p2.x.toFixed(2)); tick.setAttribute('y2', p2.y.toFixed(2));
    tick.setAttribute('stroke', isMajor ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)');
    tick.setAttribute('stroke-width', isMajor ? '1.5' : '1');
    tick.setAttribute('stroke-linecap', 'round');
    svg.appendChild(tick);

    // Label numérico apenas nos ticks principais
    if (isMajor) {
      const labelVal  = Math.round(frac * maxSpeed);
      const rLabel    = R_TICK - 14;
      const pL        = pt(rLabel, angleDeg);
      const text      = document.createElementNS(NS, 'text');
      text.setAttribute('x', pL.x.toFixed(2));
      text.setAttribute('y', pL.y.toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('fill', 'rgba(255,255,255,0.45)');
      text.setAttribute('font-size', '6.5');
      text.setAttribute('font-family', 'Arial, sans-serif');
      text.setAttribute('font-weight', '500');
      text.textContent = labelVal;
      svg.appendChild(text);
    }
  }

  // ── Agulha ──
  const needleGroup = document.createElementNS(NS, 'g');
  needleGroup.style.transformOrigin = `${cx}px ${cy}px`;
  needleGroup.style.transform       = `rotate(${START_DEG}deg)`;
  needleGroup.style.transition      = 'transform .22s ease';

  // Linha da agulha (do centro até r=38)
  const needleLine = document.createElementNS(NS, 'line');
  needleLine.setAttribute('x1', cx); needleLine.setAttribute('y1', cy);
  needleLine.setAttribute('x2', cx); needleLine.setAttribute('y2', cy - 38);
  needleLine.setAttribute('stroke', '#ffffff');
  needleLine.setAttribute('stroke-width', '1.8');
  needleLine.setAttribute('stroke-linecap', 'round');
  needleGroup.appendChild(needleLine);

  // Contra-peso (pequeno segmento atrás)
  const counterW = document.createElementNS(NS, 'line');
  counterW.setAttribute('x1', cx); counterW.setAttribute('y1', cy);
  counterW.setAttribute('x2', cx); counterW.setAttribute('y2', cy + 8);
  counterW.setAttribute('stroke', 'rgba(255,255,255,0.35)');
  counterW.setAttribute('stroke-width', '2.5');
  counterW.setAttribute('stroke-linecap', 'round');
  needleGroup.appendChild(counterW);

  svg.appendChild(needleGroup);

  // Ponto central
  const dot1 = document.createElementNS(NS, 'circle');
  dot1.setAttribute('cx', cx); dot1.setAttribute('cy', cy); dot1.setAttribute('r', '5');
  dot1.setAttribute('fill', 'rgba(255,255,255,0.9)');
  svg.appendChild(dot1);

  const dot2 = document.createElementNS(NS, 'circle');
  dot2.setAttribute('cx', cx); dot2.setAttribute('cy', cy); dot2.setAttribute('r', '3');
  dot2.setAttribute('fill', actColor);
  svg.appendChild(dot2);

  widget.appendChild(svg);

  // Valor numérico
  const valEl = document.createElement('span');
  valEl.className = 'speedo-val';
  valEl.textContent = '0';
  widget.appendChild(valEl);

  // Unidade
  const unitEl = document.createElement('span');
  unitEl.className = 'speedo-unit';
  unitEl.textContent = 'km/h';
  widget.appendChild(unitEl);

  // Nome da atividade (label abaixo)
  const nameEl = document.createElement('span');
  nameEl.className = 'speedo-name';
  nameEl.style.color = actColor;
  nameEl.title = actName;
  nameEl.textContent = actName.replace(/\.(tcx|gpx)$/i, '');
  widget.appendChild(nameEl);

  // Refs para atualização rápida
  widget._arcFill    = arcFill;
  widget._needle     = needleGroup;
  widget._valEl      = valEl;
  widget._maxSpeed   = maxSpeed;
  widget._actColor   = actColor;
  widget._startDeg   = START_DEG;
  widget._totalDeg   = TOTAL_DEG;

  return widget;
}

/**
 * Atualiza um widget de velocímetro com a velocidade atual.
 */
function speedoUpdateWidget(widget, speedKmh) {
  if (!widget) return;
  const speed   = Math.max(0, speedKmh || 0);
  const max     = widget._maxSpeed || 40;
  const pct     = Math.min(speed / max, 1);

  // Valor numérico
  widget._valEl.textContent = speed.toFixed(1);

  // Arco
  const circ   = parseFloat(widget._arcFill.dataset.circ);
  const arcLen = parseFloat(widget._arcFill.dataset.arcLen);
  const filled = pct * arcLen;
  const gap    = circ - filled;
  widget._arcFill.setAttribute('stroke-dasharray', `${filled.toFixed(2)} ${gap.toFixed(2)}`);

  // Cor dinâmica
  let color = widget._actColor;
  if (pct > 0.85)       color = '#ef4444';
  else if (pct > 0.60)  color = '#f59e0b';
  widget._arcFill.setAttribute('stroke', color);

  // Agulha
  const angleDeg = widget._startDeg + pct * widget._totalDeg;
  widget._needle.style.transform = `rotate(${angleDeg}deg)`;
}

/**
 * Constrói o container de velocímetros para todas as atividades com GPS+velocidade.
 * Chamado por initTimeline.
 */
function speedoBuildAll(scrubData, maxSpeed) {
  const container = document.getElementById('speedoContainer');
  if (!container) return;
  container.innerHTML = '';

  const eligible = scrubData.filter(d => d.gpsPoints.some(p => p.speed > 0));
  if (!eligible.length) {
    container.classList.remove('visible');
    return;
  }

  eligible.forEach(d => {
    const widget = speedoBuildWidget(d.act.id, d.act.color, d.act.filename, maxSpeed);
    container.appendChild(widget);
  });

  container.classList.add('visible');
}

/**
 * Atualiza todos os velocímetros para um dado segundo do trajeto.
 * Chamado por tlUpdate.
 */
function speedoUpdateAll(scrubData, sec) {
  const container = document.getElementById('speedoContainer');
  if (!container || !container.classList.contains('visible')) return;

  scrubData.forEach(d => {
    if (!d.gpsPoints.some(p => p.speed > 0)) return;
    const widget = container.querySelector(`.speedo-widget[data-act-id="${d.act.id}"]`);
    if (!widget) return;
    const actSec = Math.min(
      Math.max(sec - (d.startOffset || 0), 0),
      d.gpsPoints[d.gpsPoints.length - 1].elapsedSec
    );
    const pt    = d.gpsPoints[tlFindIdx(d.gpsPoints, actSec)];
    const speed = (pt && pt.speed > 0) ? pt.speed : 0;
    speedoUpdateWidget(widget, speed);
  });
}

function tlFindIdx(pts, sec) {
  if (!pts.length) return 0;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].elapsedSec <= sec) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function tlInterp(pts, sec) {
  if (!pts.length) return null;
  const i0 = tlFindIdx(pts, sec);
  const p0 = pts[i0], p1 = pts[Math.min(i0 + 1, pts.length - 1)];
  if (p0 === p1 || p1.elapsedSec === p0.elapsedSec) return [p0.lat, p0.lon];
  const t = (sec - p0.elapsedSec) / (p1.elapsedSec - p0.elapsedSec);
  return [p0.lat + t * (p1.lat - p0.lat), p0.lon + t * (p1.lon - p0.lon)];
}

function tlUpdate(value) {
  const tl = state.timeline;
  if (!tl) return;
  const pct = Math.min(Math.max(value, 0), 1000) / 1000;
  const sec = pct * tl.maxSec;

  const scrubEl   = document.getElementById('timelineScrubber');
  const fillEl    = document.getElementById('timelineTrackFill');
  const labelEl   = document.getElementById('timelineLabel');
  if (scrubEl)  scrubEl.value = value;
  if (fillEl)   fillEl.style.width = (pct * 100) + '%';
  if (labelEl) {
    labelEl.textContent = (state.syncMode === 'wallclock' && tl.hasStartTimes)
      ? tlFmtWallclock(tl.epochMin, sec)
      : secondsToHMS(sec);
  }

  tl.scrubData.forEach(d => {
    if (!d.gpsPoints.length) return;

    // actSec: tempo relativo dentro desta atividade, descontando o offset de início
    const actSec = Math.min(
      Math.max(sec - (d.startOffset || 0), 0),
      d.gpsPoints[d.gpsPoints.length - 1].elapsedSec
    );

    const pos = tlInterp(d.gpsPoints, actSec);
    if (pos) d.marker.setLatLng(pos);

    // Oculta o marcador se a atividade ainda não começou (modo wallclock)
    if (state.syncMode === 'wallclock' && d.startOffset > 0 && sec < d.startOffset) {
      d.marker.setOpacity(0);
    } else {
      d.marker.setOpacity(1);
    }

    const pt = d.gpsPoints[tlFindIdx(d.gpsPoints, actSec)];
    const el = document.getElementById('scrub-vals-' + d.act.id);
    if (!el || !pt) return;
    const p = [];
    if (pt.distanceM != null)          p.push(`<span style="color:${d.act.color};font-weight:600">${(pt.distanceM/1000).toFixed(2)}<small style="opacity:.5"> km</small></span>`);
    if (pt.heartRate)                  p.push(`<span>♥ ${pt.heartRate}<small style="opacity:.5"> bpm</small></span>`);
    if (pt.speed > 0.3)                p.push(`<span>⚡ ${pt.speed.toFixed(1)}<small style="opacity:.5"> km/h</small></span>`);
    if (pt.altitude != null)           p.push(`<span>⛰ ${Math.round(pt.altitude)}<small style="opacity:.5"> m</small></span>`);
    // Exibe horário real se disponível
    if (state.syncMode === 'wallclock' && tl.hasStartTimes && d.act.startTime) {
      const realMs  = d.act.startTime.getTime() + actSec * 1000;
      const realHMS = new Date(realMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
      p.push(`<span style="opacity:.55">🕐 ${realHMS}</span>`);
    }
    el.innerHTML = p.join('') || '<span style="opacity:.4">—</span>';
  });

  speedoUpdateAll(tl.scrubData, sec);

  if (state.mapFollow && state.leafletMap && tl.scrubData.length > 0) {
    const positions = [];
    tl.scrubData.forEach(d => {
      if (!d.gpsPoints.length) return;
      const actSec = Math.min(
        Math.max(sec - (d.startOffset || 0), 0),
        d.gpsPoints[d.gpsPoints.length - 1].elapsedSec
      );
      const pos = tlInterp(d.gpsPoints, actSec);
      if (pos) positions.push(pos);
    });

    if (positions.length > 0) {
      const lat = positions.reduce((s, p) => s + p[0], 0) / positions.length;
      const lon = positions.reduce((s, p) => s + p[1], 0) / positions.length;
      state.leafletMap.panTo([lat, lon], { animate: false, noMoveStart: true });
    }
  }
}

function tlSetUI(playing) {
  const tl = state.timeline;
  if (tl) tl.isPlaying = playing;
  const pi = document.getElementById('playIcon');
  const pa = document.getElementById('pauseIcon');
  const pb = document.getElementById('timelinePlayBtn');
  if (pi) pi.style.display  = playing ? 'none' : '';
  if (pa) pa.style.display  = playing ? ''     : 'none';
  if (pb) pb.classList.toggle('playing', playing);
}

function tlStop() {
  const tl = state.timeline;
  if (!tl) return;
  if (tl.raf) { cancelAnimationFrame(tl.raf); tl.raf = null; }
  tl.lastTS = null;
  tlSetUI(false);
}

function tlTick(ts) {
  const tl = state.timeline;
  if (!tl || !tl.isPlaying) return;
  if (tl.lastTS === null) { tl.lastTS = ts; tl.raf = requestAnimationFrame(tlTick); return; }

  const wall = (ts - tl.lastTS) / 1000;
  tl.lastTS = ts;

  const scrubEl = document.getElementById('timelineScrubber');
  if (!scrubEl) { tlStop(); return; }

  const step   = wall * tl.speed;
  const newVal = Math.min(+scrubEl.value + step, 1000);
  tlUpdate(newVal);

  if (newVal >= 1000) { tlStop(); return; }
  tl.raf = requestAnimationFrame(tlTick);
}

function tlTogglePlay() {
  const tl = state.timeline;
  if (!tl) return;
  if (tl.isPlaying) { tlStop(); return; }
  const scrubEl = document.getElementById('timelineScrubber');
  if (scrubEl && +scrubEl.value >= 999) tlUpdate(0);
  tlSetUI(true);
  tl.lastTS = null;
  tl.raf = requestAnimationFrame(tlTick);
}

/** Called by buildMap each time new activities are loaded */
function initTimeline(scrubData) {
  tlStop();

  // ── Calcula offsets por modo de sincronização ──────────────────────
  // elapsed   → todas as atividades partem do segundo 0 (comportamento original)
  // wallclock → cada atividade é deslocada pelo delta entre seu startTime e
  //             o startTime mais antigo do conjunto. O scrubber representa
  //             a janela de tempo real (hora do dia).

  const hasStartTimes = scrubData.every(d => d.act.startTime instanceof Date && !isNaN(d.act.startTime));

  // Epoch mínimo (ms) entre todas as atividades — usado no modo wallclock
  const epochMin = hasStartTimes
    ? Math.min(...scrubData.map(d => d.act.startTime.getTime()))
    : 0;

  // startOffset (s) de cada atividade em relação à mais antiga
  scrubData.forEach(d => {
    if (state.syncMode === 'wallclock' && hasStartTimes) {
      d.startOffset = (d.act.startTime.getTime() - epochMin) / 1000;
    } else {
      d.startOffset = 0;
    }
  });

  // maxSec considera o offset + duração de cada atividade
  const maxSec = Math.max(...scrubData.map(d => {
    const dur = d.gpsPoints.length ? d.gpsPoints[d.gpsPoints.length - 1].elapsedSec : 0;
    return d.startOffset + dur;
  }));
  if (maxSec <= 0) return;

  // 1× percorre o scrubber em ~240s reais | 2×=120s | 5×=48s
  const baseSpeed = 1000 / 240;

  // Velocidade máxima para escala do velocímetro
  let maxSpeed = 0;
  scrubData.forEach(d => {
    d.gpsPoints.forEach(p => {
      if (p.speed && p.speed > maxSpeed) maxSpeed = p.speed;
    });
  });
  maxSpeed = Math.max(Math.ceil(maxSpeed / 10) * 10, 30);

  state.timeline = {
    scrubData, maxSec,
    isPlaying: false, speed: baseSpeed, baseSpeed,
    raf: null, lastTS: null, maxSpeed,
    epochMin, hasStartTimes,
  };

  // Label do fim da timeline
  const labelEnd = document.getElementById('timelineLabelEnd');
  if (labelEnd) {
    if (state.syncMode === 'wallclock' && hasStartTimes) {
      labelEnd.textContent = tlFmtWallclock(epochMin, maxSec);
    } else {
      labelEnd.textContent = secondsToHMS(maxSec);
    }
  }

  // Atualiza visual do botão de sincronização
  tlSyncBtnUpdate();

  speedoBuildAll(scrubData, maxSpeed);

  document.querySelectorAll('.speed-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.speed === '1')
  );

  const statsEl = document.getElementById('timelineStats');
  if (statsEl) statsEl.innerHTML = scrubData.map(d => `
    <div class="timeline-stat-chip">
      <div class="timeline-stat-dot" style="background:${d.act.color}"></div>
      <span style="font-family:var(--font-m);font-size:.72rem;color:var(--muted);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.act.filename.replace(/\.(tcx|gpx)$/i,'')}</span>
      <div id="scrub-vals-${d.act.id}" style="display:flex;gap:.5rem;flex-wrap:wrap"><span style="opacity:.4">—</span></div>
    </div>`).join('');

  tlUpdate(0);
}

/** Formata hora real do dia a partir do epoch mínimo + segundos decorridos */
function tlFmtWallclock(epochMin, sec) {
  const d = new Date(epochMin + sec * 1000);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
}

/** Atualiza aparência do botão de modo de sincronização */
function tlSyncBtnUpdate() {
  const btn = document.getElementById('tlSyncBtn');
  if (!btn) return;
  const isWall = state.syncMode === 'wallclock';
  btn.classList.toggle('active', isWall);
  btn.title = isWall ? 'Sincronizado por hora real — clique para voltar ao modo duração' : 'Sincronizar pelo horário real do relógio';
  btn.innerHTML = isWall
    ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="2"/></svg> Hora real`
    : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Hora real`;
}

/** Alterna entre modo elapsed e wallclock e reconstrói a timeline */
function tlToggleSyncMode() {
  state.syncMode = state.syncMode === 'wallclock' ? 'elapsed' : 'wallclock';
  // Reconstrói a timeline com os mesmos scrubData mas offsets recalculados
  if (state.timeline) {
    initTimeline(state.timeline.scrubData);
  }
}
window.tlToggleSyncMode = tlToggleSyncMode;

/** Cartões de resumo com ícones, cores e valores por atividade */
function renderSummaryCards() {
  const container = document.getElementById('summaryCards');
  container.innerHTML = '';

  // ── Card de data/hora de início ──────────────────────────────────
  const hasAnyStartTime = state.activities.some(a => a.startTime instanceof Date && !isNaN(a.startTime));
  if (hasAnyStartTime) {
    const startCard = document.createElement('div');
    startCard.className = 'summary-card';
    startCard.style.cssText = '--card-accent: #0047ff;';

    const valRows = state.activities.map(act => {
      let dateLine = '—', timeLine = '';
      if (act.startTime instanceof Date && !isNaN(act.startTime)) {
        dateLine = act.startTime.toLocaleDateString('pt-BR', {
          day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
        });
        timeLine = act.startTime.toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC'
        });
      }
      return `
        <div class="summary-act-row">
          <span class="summary-act-dot" style="background:${act.color};box-shadow:0 0 6px ${act.color}55;"></span>
          <span class="summary-act-name">${act.filename.replace(/\.(tcx|gpx)$/i,'')}</span>
          <span class="summary-act-val" style="color:${act.color};font-size:.82rem;line-height:1.3;text-align:right;">
            ${dateLine}${timeLine ? `<span class="unit" style="display:block;font-size:.7rem;opacity:.65;">${timeLine} UTC</span>` : ''}
          </span>
        </div>`;
    }).join('');

    startCard.innerHTML = `
      <div class="summary-card-header">
        <span class="summary-icon" style="color:#0047ff;">📅</span>
        <span class="summary-label">Início</span>
      </div>
      <div class="summary-act-list">${valRows}</div>
    `;
    container.appendChild(startCard);
  }

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
            color: 'rgba(10,10,18,0.45)',
            font: { family: 'Arial', size: 11 },
            boxWidth: 14,
            boxHeight: 14,
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          backgroundColor: 'rgba(255,255,255,0.98)',
          borderColor: 'rgba(0,71,255,0.12)',
          borderWidth: 1,
          titleColor: 'rgba(10,10,18,0.45)',
          bodyColor: 'rgba(10,10,18,0.85)',
          titleFont: { family: 'Arial', size: 10 },
          bodyFont: { family: 'Arial', size: 12 },
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
            color: 'rgba(10,10,18,0.3)',
            font: { family: 'Arial', size: 10 },
          },
          ticks: {
            color: 'rgba(10,10,18,0.3)',
            font: { family: 'Arial', size: 10 },
          },
          grid: { color: 'rgba(0,71,255,0.05)' },
        },
        y: {
          title: {
            display: true,
            text: `${metric.label} (${metric.unit})`,
            color: 'rgba(10,10,18,0.3)',
            font: { family: 'Arial', size: 10 },
          },
          ticks: {
            color: 'rgba(10,10,18,0.3)',
            font: { family: 'Arial', size: 10 },
          },
          grid: { color: 'rgba(0,71,255,0.05)' },
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
  const mobClear = document.getElementById('clearBtnMob');
  if (mobClear) mobClear.classList.add('hidden');
}

function clearAll() {
  state.activities = [];
  pendingFiles = [];
  clearLS();
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  destroyMap();
  renderFileList();
  showUpload();
  const aiPanel = document.getElementById('aiPanel');
  if (aiPanel) aiPanel.classList.add('hidden');
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

  // ── Timeline + speed: event delegation on document (registered once) ──
  document.addEventListener('click', e => {
    // Play/pause — match button or any child inside it
    if (e.target.closest('#timelinePlayBtn')) {
      tlTogglePlay();
      return;
    }
    // Speed chips
    const chip = e.target.closest('.speed-chip');
    if (chip) {
      document.querySelectorAll('.speed-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (state.timeline) state.timeline.speed = state.timeline.baseSpeed * +chip.dataset.speed;
      return;
    }
    // Map layer switcher
    const layerBtn = e.target.closest('.map-layer-btn[data-layer]');
    if (layerBtn && state.leafletMap) {
      document.querySelectorAll('.map-layer-btn[data-layer]').forEach(b => b.classList.remove('active'));
      layerBtn.classList.add('active');
      setMapLayer(layerBtn.dataset.layer);
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'timelineScrubber') {
      tlStop();
      tlUpdate(+e.target.value);
    }
  });

  // Botão comparar
  document.getElementById('compareBtn').addEventListener('click', async () => {
    await runComparison();
    if (window.addToHistory && state.activities.length >= 1) {
      window.addToHistory(state.activities);
    }
  });

  document.getElementById('backBtn').addEventListener('click', showUpload);

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Limpar todas as atividades carregadas?')) clearAll();
  });

  const saved = loadFromLS();
  if (saved && saved.length >= 1) {
    state.activities = saved.map((a, i) => ({
      ...a,
      color: ACTIVITY_COLORS[i % ACTIVITY_COLORS.length],
      index: i,
      // Re-hidrata startTime: JSON.parse devolve string ISO, precisa de Date
      startTime: a.startTime instanceof Date
        ? a.startTime
        : (a.startTime ? new Date(a.startTime) : null),
    }));
    toast(`${saved.length} atividade(s) restaurada(s) do cache`, 'ok');
    renderDashboard();
  }
}
window.initApp = initApp;
window.toggle3D = toggle3D;

// ──────────────────────────────────────────────────────
// MAPA — TELA INTEIRA
// ──────────────────────────────────────────────────────

function toggleMapFullscreen() {
  const section   = document.getElementById('mapSection');
  const btnExpand = document.getElementById('mapFsIconExpand');
  const btnCompress = document.getElementById('mapFsIconCompress');
  const btn       = document.getElementById('mapFullscreenBtn');
  if (!section) return;

  const isFs = section.classList.toggle('map-fullscreen');

  // Atualiza ícone
  if (btnExpand)   btnExpand.style.display   = isFs ? 'none' : '';
  if (btnCompress) btnCompress.style.display = isFs ? ''     : 'none';
  if (btn) btn.title = isFs ? 'Sair da tela inteira' : 'Tela inteira';

  // Texto do botão
  const textNode = btn ? Array.from(btn.childNodes).find(n => n.nodeType === 3) : null;
  if (textNode) textNode.textContent = isFs ? ' Sair' : ' Tela Inteira';

  // Impede scroll do body no modo fullscreen
  document.body.style.overflow = isFs ? 'hidden' : '';

  // Recalcula tamanho do mapa após transição
  setTimeout(() => {
    if (state.leafletMap) state.leafletMap.invalidateSize();
  }, 50);
}

// Fechar fullscreen com Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const section = document.getElementById('mapSection');
    if (section && section.classList.contains('map-fullscreen')) {
      toggleMapFullscreen();
    }
  }
});

window.toggleMapFullscreen = toggleMapFullscreen;

// ──────────────────────────────────────────────────────
// MAPA — SEGUIR POSIÇÃO
// ──────────────────────────────────────────────────────

function toggleMapFollow() {
  state.mapFollow = !state.mapFollow;
  const btn = document.getElementById('mapFollowBtn');
  if (btn) btn.classList.toggle('active', state.mapFollow);

  // Se acabou de ativar e já há timeline, centraliza imediatamente
  if (state.mapFollow && state.timeline) {
    const scrubEl = document.getElementById('timelineScrubber');
    if (scrubEl) tlUpdate(+scrubEl.value);
  }
}
window.toggleMapFollow = toggleMapFollow;

// Expose state globally for history integration
window.state = state;
window.renderDashboard = renderDashboard;
window.ACTIVITY_COLORS = ACTIVITY_COLORS;
// ══════════════════════════════════════════════════════════
// INTEGRAÇÃO GEMINI AI — Análise e comparação de treinos
// ══════════════════════════════════════════════════════════

const GEMINI_API_KEY = 'AIzaSyAVoNlc5HSCmI5mLyZ7EILgTilnLNwOGLE';

// Modelos em ordem de preferência — tenta o próximo se o anterior atingir cota
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

function geminiEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

/** Verifica se o erro deve acionar fallback para o próximo modelo */
function isQuotaError(errMsg) {
  return /quota|rate.?limit|429|resource.?exhausted|not found|not supported|404|503|unavailable/i.test(errMsg);
}

/**
 * Monta o resumo textual de uma atividade para enviar ao Gemini
 */
function buildActivitySummaryText(act) {
  const s = act.summary;
  const lines = [];
  lines.push(`• Arquivo: ${act.filename}`);
  if (act.startTime instanceof Date && !isNaN(act.startTime)) {
    lines.push(`• Data/Hora: ${act.startTime.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })} às ${act.startTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`);
  }
  lines.push(`• Duração: ${secondsToHMS(s.totalSec)}`);
  lines.push(`• Distância: ${fmtDist(s.totalDistM)}`);
  if (s.avgSpeed) lines.push(`• Velocidade média: ${s.avgSpeed} km/h`);
  if (s.avgHR)    lines.push(`• FC média: ${s.avgHR} bpm`);
  if (s.maxHR)    lines.push(`• FC máxima: ${s.maxHR} bpm`);
  if (s.elevGain) lines.push(`• Ganho de elevação: ${s.elevGain} m`);
  if (s.avgPower) lines.push(`• Potência média: ${s.avgPower} W`);

  // Pace médio
  if (s.avgSpeed && s.avgSpeed > 0) {
    const secKm = 3600 / s.avgSpeed;
    const pm = Math.floor(secKm / 60);
    const ps = Math.floor(secKm % 60);
    lines.push(`• Pace médio: ${pm}:${String(ps).padStart(2,'0')} min/km`);
  }

  // Zonas de FC (resumo)
  if (s.maxHR > 0 && act.points.some(p => p.heartRate > 0)) {
    const zones = hrZoneDefs(s.maxHR);
    const pcts  = computeHRZones(act, s.maxHR);
    const zonesStr = zones.map((z, i) => `${z.label}: ${pcts[i]}%`).join(', ');
    lines.push(`• Distribuição FC por zonas: ${zonesStr}`);
  }

  // Splits (até 10 km)
  const splits = computeSplits(act).slice(0, 10);
  if (splits.length) {
    const splitsStr = splits.map(sp =>
      `km${sp.label}: ${fmtPace(sp.paceSecPerKm)}/km${sp.avgHR ? ` (FC ${sp.avgHR})` : ''}`
    ).join(', ');
    lines.push(`• Splits: ${splitsStr}`);
  }

  return lines.join('\n');
}

/**
 * Monta o prompt completo para o Gemini
 */
function buildGeminiPrompt() {
  const acts = state.activities;
  const isComparison = acts.length > 1;
  const sport = detectSport(acts.map(a => a.label + ' ' + a.filename).join(' '));

  let prompt = `Você é um coach esportivo especialista em análise de dados de treino. Analise ${isComparison ? 'as seguintes atividades comparativamente' : 'a seguinte atividade'} e forneça insights em português do Brasil.

DADOS ${isComparison ? 'DAS ATIVIDADES' : 'DA ATIVIDADE'}:

`;

  acts.forEach((act, i) => {
    if (isComparison) prompt += `=== Atividade ${i + 1} ===\n`;
    prompt += buildActivitySummaryText(act) + '\n\n';
  });

  if (isComparison) {
    prompt += `
ANÁLISE SOLICITADA:
1. **Comparação Geral**: Compare o desempenho entre as atividades. Qual foi melhor e por quê?
2. **Ritmo e Eficiência**: Analise a consistência do pace/velocidade e eficiência cardíaca (relação FC × velocidade).
3. **Zonas de Treino**: Comente sobre a distribuição nas zonas de FC e se o treino foi aeróbico, limiar ou de alta intensidade.
4. **Pontos Fortes e Fracos**: Identifique o que foi bem e o que pode melhorar em cada atividade.
5. **Recomendações**: Dê 3 sugestões práticas e específicas para melhorar o desempenho com base nos dados apresentados.

Seja direto, técnico mas acessível. Use dados concretos dos treinos para embasar suas análises.`;
  } else {
    prompt += `
ANÁLISE SOLICITADA:
1. **Visão Geral**: Avalie a qualidade geral desta sessão de treino.
2. **Ritmo e Consistência**: Como foi a distribuição de velocidade/pace ao longo do treino? Houve fadiga?
3. **Resposta Cardíaca**: Analise os dados de FC e o que eles indicam sobre o esforço e condicionamento.
4. **Zonas de Treino**: Qual foi o perfil de intensidade desta sessão?
5. **Recomendações**: Dê 3 sugestões específicas para o próximo treino com base nestes dados.

Seja direto, técnico mas acessível. Use dados concretos do treino para embasar a análise.`;
  }

  return prompt;
}

/**
 * Converte markdown simples em HTML para exibição
 */
function markdownToHTML(text) {
  return text
    // Títulos **Texto**: (negrito com dois-pontos — vira h3)
    .replace(/\*\*([^*]+)\*\*:/g, '<h3>$1</h3>')
    // Negrito **texto**
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Itálico *texto*
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Listas - item
    .replace(/^[\-•]\s+(.+)$/gm, '<li>$1</li>')
    // Agrupa <li> em <ul>
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    // Números 1. item
    .replace(/^\d+\.\s+\*\*([^*]+)\*\*:?\s*/gm, '<h3>$1</h3>')
    .replace(/^\d+\.\s+(.+)$/gm, '<p>$1</p>')
    // Parágrafos — linhas não marcadas
    .replace(/^(?!<[hup])(.+)$/gm, '<p>$1</p>')
    // Espaços duplos entre blocos
    .replace(/<\/p>\s*<p>/g, '</p><p>')
    .replace(/<\/ul>\s*<p>/g, '</ul><p>')
    .replace(/<\/h3>\s*<p>/g, '</h3><p>');
}

/**
 * Tenta chamar um modelo Gemini específico. Retorna { text, model } ou lança erro.
 */
async function callGeminiModel(model, prompt) {
  const response = await fetch(geminiEndpoint(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Resposta vazia do Gemini.');
  return { text, model };
}

/**
 * Executa a análise Gemini com fallback automático entre modelos
 */
async function runAIAnalysis() {
  if (!state.activities.length) {
    toast('Carregue atividades antes de analisar', 'warn');
    return;
  }

  const btn  = document.getElementById('aiAnalyzeBtn');
  const body = document.getElementById('aiBody');

  btn.disabled = true;
  btn.innerHTML = `<div style="width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0;"></div> Analisando…`;

  body.innerHTML = `
    <div class="ai-loading">
      <div class="ai-spinner"></div>
      <div class="ai-loading-text" id="aiLoadingText">O Gemini está analisando seus treinos…</div>
      <div style="font-family:var(--font-m);font-size:.72rem;color:var(--muted);opacity:.55;">Isso pode levar alguns segundos</div>
    </div>`;

  try {
    const prompt = buildGeminiPrompt();
    let result = null;
    let lastErr = null;

    for (const model of GEMINI_MODELS) {
      try {
        const loadingText = document.getElementById('aiLoadingText');
        if (loadingText) loadingText.textContent = `Tentando ${model}…`;
        result = await callGeminiModel(model, prompt);
        break; // sucesso — sai do loop
      } catch (err) {
        console.warn(`[Gemini] ${model} falhou:`, err.message);
        lastErr = err;
        if (!isQuotaError(err.message)) throw err; // erro diferente de cota — não adianta tentar outro modelo
        // É erro de cota: tenta o próximo modelo
      }
    }

    if (!result) throw lastErr || new Error('Todos os modelos Gemini falharam.');

    const htmlContent = markdownToHTML(result.text);
    const now = new Date().toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const modelLabel = result.model.replace('gemini-', 'Gemini ').replace(/-/g, ' ');

    body.innerHTML = `
      <div class="ai-result">${htmlContent}</div>
      <div class="ai-meta">
        <span>✦ Gerado pelo ${modelLabel} · ${now}</span>
        <button onclick="runAIAnalysis()" style="font-family:var(--font-m);font-size:.72rem;color:#7c3aed;background:none;border:1px solid rgba(124,58,237,.25);border-radius:4px;padding:.18rem .55rem;cursor:pointer;transition:all .15s;" onmouseover="this.style.background='rgba(124,58,237,.07)'" onmouseout="this.style.background='none'">↻ Nova análise</button>
      </div>`;

  } catch (err) {
    console.error('[Gemini]', err);
    body.innerHTML = `
      <div class="ai-error">
        <strong>Erro ao contatar o Gemini:</strong> ${err.message}
        <br><br>
        <button onclick="runAIAnalysis()" style="font-family:var(--font-m);font-size:.82rem;color:#dc2626;background:none;border:1px solid rgba(220,38,38,.2);border-radius:4px;padding:.28rem .7rem;cursor:pointer;margin-top:.35rem;">↻ Tentar novamente</button>
      </div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg> Analisar novamente`;
  }
}

window.runAIAnalysis = runAIAnalysis;
