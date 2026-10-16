'use strict';
/* global Chart */
(() => {
const api = window.api;
const $ = (s) => document.querySelector(s);

let meta, config, instances = [];
let samples = [];
let chart;
const selected = new Set(JSON.parse(localStorage.getItem('trendKeys') || '[]'));
const COLORS = ['#0a7cc1', '#d33c3c', '#2e9e4f', '#e0a100', '#8e44ad', '#16a085', '#c0392b', '#2c3e50', '#f06292', '#7f8c8d'];

// ---------- Tabs ----------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'trends') updateChart();
  if (b.dataset.tab === 'overview') { window.LwpCharts.render(instances); window.LwpCharts.update(samples); }
}));

// ---------- Helpers ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const decimals = (scale) => (scale >= 1 ? 0 : Math.round(-Math.log10(scale)));
const addr = (a) => String(a).padStart(4, '0');

function fmt(d, v) {
  if (!v) return { html: '–', cls: 'na' };
  if (v.error) return { html: 'n/a', cls: 'bad', title: v.error };
  if (v.implausible != null) return { html: '–', cls: 'na', title: `Implausible reading hidden: ${v.implausible} ${d.unit} (e.g. sensor broken or not connected)` };
  if (v.missing || v.value == null) return { html: '–', cls: 'na', title: `No value (register contains 0x${(v.raw & 0xffff).toString(16).toUpperCase()}, e.g. sensor not connected)` };
  if (d.enum) return { html: esc(v.text), cls: 'enum', title: `raw ${v.raw}` };
  return { html: `${v.value.toFixed(decimals(d.scale))}${d.unit ? ' ' + esc(d.unit) : ''}`, cls: '', title: `raw ${v.raw}` };
}

// ---------- Dashboard ----------
function renderCards() {
  const el = $('#cards');
  if (!instances.length) {
    el.innerHTML = '<p class="muted">No modules configured. Open Settings to add the modules installed in your system.</p>';
    return;
  }
  el.innerHTML = instances.map((inst) => `
    <div class="card">
      <h2>${esc(inst.name)} <small>Index ${inst.index} · Subindex ${inst.subindex}</small></h2>
      ${inst.nonStandardAddress ? '<div class="warnnote">Subindex &gt; 9: address scheme not defined in the documentation</div>' : ''}
      <table>
        ${inst.datapoints.map((d) => `
          <tr class="${d.number >= 50 ? 'setting' : ''}">
            <td class="addr" title="Modbus register address">${addr(d.address)}</td>
            <td title="${esc(d.desc || '')}${d.rw ? ' (RW on device – shown read-only)' : ''}">${esc(d.name)}</td>
            <td class="val na" id="v-${inst.id}-${d.key}">–</td>
          </tr>`).join('')}
      </table>
    </div>`).join('');
}

function updateValues(sample) {
  for (const inst of instances) {
    for (const d of inst.datapoints) {
      const cell = document.getElementById(`v-${inst.id}-${d.key}`);
      if (!cell) continue;
      const f = fmt(d, sample.values[`${inst.id}.${d.key}`]);
      cell.innerHTML = f.html;
      cell.className = `val ${f.cls}`;
      cell.title = f.title || '';
    }
  }
  $('#lastUpdate').textContent = `updated ${new Date(sample.ts).toLocaleTimeString()}`;
}

function updateSampleCount() {
  $('#sampleCount').textContent = `${samples.length} samples in session`;
}

// ---------- Data source banner ----------
// Makes it unmistakable whether values come from a real heat pump, the simulator, or are stale.
let source = null;      // source of the live connection: 'device' | 'simulator' | null
let connected = false;
let device = null;      // { name, vendor, product, version, hostname } of the live connection
function deviceLabel() {
  if (!device) return `${config.host}:${config.port}`;
  return `${device.name} (${config.host}:${config.port})`;
}
function deviceDetails() {
  if (!device) return '';
  const parts = [];
  if (device.vendor || device.product) parts.push([device.vendor, device.product].filter(Boolean).join(' '));
  if (device.version) parts.push(`version ${device.version}`);
  if (device.hostname) parts.push(`hostname ${device.hostname}`);
  return parts.length ? ` [${parts.join(' · ')}]` : '';
}
function lastSample() { return samples[samples.length - 1]; }
function renderBanner() {
  const b = $('#sourceBanner');
  const last = lastSample();
  const shownSource = connected ? source : last?.source || null;
  let cls, title, text;
  if (connected && source === 'simulator') {
    cls = 'sim'; title = 'SIMULATED DATA';
    text = `Connected to ${deviceLabel()}${deviceDetails()}. All values are fake test data, not from a heat pump.`;
  } else if (connected && source === 'device') {
    cls = 'live'; title = 'LIVE DATA – REAL HEAT PUMP';
    text = `Connected to ${deviceLabel()}${deviceDetails()}. Values are read directly from the device.`;
  } else if (last) {
    cls = 'stale'; title = 'NOT CONNECTED – OUTDATED VALUES';
    text = last.history
      ? `Showing stored history from the data folder (real device), last entry ${new Date(last.ts).toLocaleString()}. Values are not updating – click Connect for live data.`
      : `Values shown are from ${new Date(last.ts).toLocaleString()} (${last.source === 'simulator' ? 'SIMULATED data' : 'real device'}) and are not updating.`;
  } else {
    cls = 'none'; title = 'NOT CONNECTED';
    text = 'No data source. Click Connect to read data from the heat pump.';
  }
  b.className = `banner ${cls}`;
  b.querySelector('.banner-title').textContent = title;
  b.querySelector('.banner-text').textContent = text;
  const name = connected && device ? device.name : '';
  const dn = $('#deviceName');
  dn.textContent = name;
  dn.hidden = !name;
  document.title = name ? `${name} – LAMBDA Heat Pump Viewer` : 'LAMBDA Heat Pump Viewer';
  document.body.classList.toggle('mode-sim', shownSource === 'simulator');
  document.body.classList.toggle('mode-stale', !connected && !!last);
}

// ---------- Status ----------
function setStatus(state, text) {
  $('#statusDot').className = `dot ${state}`;
  $('#statusText').textContent = text;
  $('#statusText').title = text;
}

$('#btnStart').addEventListener('click', async () => {
  await api.start();
  setStatus('wait', `Connecting to ${config.host}:${config.port}…`);
  $('#btnStart').disabled = true;
  $('#btnStop').disabled = false;
});
$('#btnStop').addEventListener('click', async () => {
  await api.stop();
  connected = false;
  source = null;
  device = null;
  renderBanner();
  setStatus('', 'Stopped');
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = true;
});

api.onStatus((s) => {
  if ($('#btnStart').disabled === false) return; // stopped by user
  connected = s.connected;
  source = s.connected ? s.source : null;
  device = s.connected ? s.device || null : null;
  renderBanner();
  if (s.connected) setStatus('ok', `Connected: ${device ? device.name : `${config.host}:${config.port}`}`);
  else setStatus('err', s.error ? `Error: ${s.error} – retrying` : 'Disconnected – retrying');
});

api.onData((sample) => {
  samples.push(sample);
  const max = Number(config.maxSamples) || 20000;
  if (samples.length > max) samples.splice(0, samples.length - max);
  // Never mix simulated and real data (incl. stored history) in one view.
  if (samples[0].source !== sample.source) samples = samples.filter((s) => s.source === sample.source);
  if (!connected || source !== sample.source) {
    connected = true;
    source = sample.source;
  }
  renderBanner();
  setStatus('ok', `Connected: ${device ? device.name : `${config.host}:${config.port}`}`);
  updateValues(sample);
  updateSampleCount();
  if ($('#tab-trends').classList.contains('active')) updateChart();
  if ($('#tab-overview').classList.contains('active')) window.LwpCharts.update(samples);
});

// ---------- CSV ----------
$('#btnExport').addEventListener('click', async () => {
  const r = await api.exportCsv();
  if (r.ok) $('#logInfo').textContent = `Exported ${r.rows} rows to ${r.filePath}`;
});
async function refreshLogButton() {
  const s = await api.logStatus();
  $('#btnLog').textContent = s.file ? 'Stop continuous log' : 'Start continuous log…';
  $('#logInfo').textContent = s.file ? `Logging to ${s.file}` : '';
}
$('#btnLog').addEventListener('click', async () => {
  const s = await api.logStatus();
  if (s.file) await api.stopLog(); else await api.startLog();
  refreshLogButton();
});
$('#btnClear').addEventListener('click', async () => {
  await api.clearSamples();
  samples = [];
  updateSampleCount();
  updateChart();
  renderBanner();
  window.LwpCharts.render(instances);
});

// ---------- Trends ----------
function numericDatapoints() {
  const out = [];
  for (const inst of instances) {
    for (const d of inst.datapoints) {
      if (d.enum || d.key === 'error') continue;
      out.push({ key: `${inst.id}.${d.key}`, label: `${inst.name} – ${d.name}`, unit: d.unit, digits: decimals(d.scale), inst, d });
    }
  }
  return out;
}

function renderPicker() {
  const byInst = new Map();
  for (const n of numericDatapoints()) {
    if (!byInst.has(n.inst.id)) byInst.set(n.inst.id, { name: n.inst.name, items: [] });
    byInst.get(n.inst.id).items.push(n);
  }
  $('#trendPicker').innerHTML = [...byInst.values()].map((g) => `
    <h3>${esc(g.name)}</h3>
    ${g.items.map((n) => `<label><input type="checkbox" data-key="${esc(n.key)}" ${selected.has(n.key) ? 'checked' : ''}/> ${esc(n.d.name)}${n.unit ? ` [${esc(n.unit)}]` : ''}</label>`).join('')}
  `).join('') || '<p class="muted">No numeric datapoints configured.</p>';
  $('#trendPicker').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) selected.add(cb.dataset.key); else selected.delete(cb.dataset.key);
    localStorage.setItem('trendKeys', JSON.stringify([...selected]));
    updateChart(true);
  }));
}

$('#btnTrendNone').addEventListener('click', () => {
  selected.clear();
  localStorage.setItem('trendKeys', '[]');
  renderPicker();
  updateChart(true);
});
$('#trendWindow').addEventListener('change', () => updateChart());
$('#overviewWindow').addEventListener('change', (e) => {
  window.LwpCharts.setWindow(Number(e.target.value));
  window.LwpCharts.update(samples);
});

function updateChart(rebuild = false) {
  const U = window.LwpChartUtil;
  const nums = numericDatapoints().filter((n) => selected.has(n.key));
  const win = Number($('#trendWindow').value);
  const from = win ? Date.now() - win : 0;
  const data = samples.filter((s) => s.ts >= from);
  const thr = U.gapThreshold(data);
  const units = [...new Set(nums.map((n) => n.unit || ''))];

  const datasets = nums.map((n, i) => ({
    label: `${n.label}${n.unit ? ` [${n.unit}]` : ''}`,
    unit: n.unit || '',
    digits: n.digits ?? 2,
    yAxisID: `y${units.indexOf(n.unit || '')}`,
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    borderWidth: 1.5,
    pointRadius: U.isolatedRadius,
    pointHoverRadius: 3,
    spanGaps: false,
    data: U.points(data, n.key, thr),
  }));

  // Y axes are titled with the quantity (from the selected series) and the unit.
  const unitNames = { '°C': 'Temperature', 'K': 'Temperature difference', 'kW': 'Power', 'W': 'Power', 'Wh': 'Energy', 'kWh': 'Energy', 'l/min': 'Volume flow', '%': 'Percent', 'bar': 'Pressure' };
  const scales = { x: U.timeAxis(data) };
  units.forEach((u, i) => {
    const title = u ? `${unitNames[u] || 'Value'} [${u}]` : 'Value (no unit)';
    scales[`y${i}`] = { position: i % 2 ? 'right' : 'left', title: U.axisTitle(title), grid: { drawOnChartArea: i === 0 } };
  });
  if (!units.length) scales.y = { title: U.axisTitle('Value'), min: 0, max: 1 };
  const plugins = {
    tooltip: U.tooltip((v, it) => `${v.toFixed(it.dataset.digits)}${it.dataset.unit ? ' ' + it.dataset.unit : ''}`),
    legend: { position: 'bottom' },
    subtitle: U.subtitle(U.period(data[0]?.ts, data[data.length - 1]?.ts)),
    noData: { ranges: U.gaps(data, thr), emptyText: nums.length ? 'No data in the selected period' : 'Select values to plot' },
  };

  if (!chart || rebuild) {
    if (chart) chart.destroy();
    chart = new Chart($('#chart'), {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins,
        scales,
      },
    });
  } else {
    chart.data.datasets = datasets;
    chart.options.scales = scales;
    chart.options.plugins = { ...chart.options.plugins, ...plugins };
    chart.update('none');
  }
}

// ---------- Settings ----------
function renderSettings() {
  const f = $('#settingsForm');
  f.host.value = config.host;
  f.port.value = config.port;
  f.unitId.value = config.unitId;
  f.pollIntervalSec.value = Math.round(config.pollIntervalMs / 1000);
  f.timeoutMs.value = config.timeoutMs;
  f.maxSamples.value = config.maxSamples;
  f.emanagerSigned.checked = !!config.emanagerSigned;
  f.dataFolder.value = config.dataFolder || '';
  f.storeEnabled.checked = !!config.storeEnabled;
  f.historyDays.value = config.historyDays ?? 7;
  f.loadHistoryOnStart.checked = !!config.loadHistoryOnStart;
  f.runInBackground.checked = config.runInBackground !== false;
  f.connectOnStart.checked = !!config.connectOnStart;
  f.backgroundPollMin.value = +((config.backgroundPollIntervalMs || 300000) / 60000).toFixed(2);
  renderBackgroundSettings();
  updateFolderInfo();
  $('#moduleCounts').innerHTML = meta.moduleTypes.map((t) => t.max === 1
    ? `<label>${esc(t.name)} <input type="checkbox" data-mod="${t.id}" ${config.modules[t.id] ? 'checked' : ''} /></label>`
    : `<label>${esc(t.name)} (0–${t.max}) <input type="number" min="0" max="${t.max}" data-mod="${t.id}" value="${config.modules[t.id] || 0}" /></label>`).join('');
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const modules = {};
  f.querySelectorAll('[data-mod]').forEach((i) => {
    modules[i.dataset.mod] = i.type === 'checkbox' ? (i.checked ? 1 : 0) : Math.max(0, Math.min(Number(i.max), Number(i.value) || 0));
  });
  config = await api.saveConfig({
    host: f.host.value.trim(),
    port: Number(f.port.value) || 502,
    unitId: Number(f.unitId.value) || 1,
    pollIntervalMs: Math.max(1, Math.min(55, Number(f.pollIntervalSec.value) || 5)) * 1000,
    timeoutMs: Number(f.timeoutMs.value) || 3000,
    maxSamples: Number(f.maxSamples.value) || 20000,
    emanagerSigned: f.emanagerSigned.checked,
    dataFolder: f.dataFolder.value.trim(),
    storeEnabled: f.storeEnabled.checked,
    historyDays: Math.max(1, Math.min(365, Number(f.historyDays.value) || 7)),
    loadHistoryOnStart: f.loadHistoryOnStart.checked,
    runInBackground: f.runInBackground.checked,
    connectOnStart: f.connectOnStart.checked,
    backgroundPollIntervalMs: Math.round(Math.max(0.5, Math.min(1440, Number(f.backgroundPollMin.value) || 5)) * 60000),
    autoStart: f.autoStart.disabled ? undefined : f.autoStart.checked,
    modules,
  });
  instances = await api.getInstances();
  samples = [];
  renderCards();
  renderPicker();
  updateSampleCount();
  updateChart(true);
  renderBanner();
  window.LwpCharts.render(instances);
  refreshLogButton();
  $('#saveInfo').textContent = `Saved ${new Date().toLocaleTimeString()}`;
  renderBackgroundSettings();
  // Saving clears the session buffer; bring stored history back.
  if (config.dataFolder) await loadHistory();
  else { historyResult = null; renderHistoryChip(); }
});

// ---------- Background collection ----------
async function renderBackgroundSettings() {
  const f = $('#settingsForm');
  const bg = await api.getBackground();
  const place = bg.platform === 'darwin' ? 'menu bar' : 'taskbar (notification area)';
  document.querySelectorAll('.tray-place').forEach((e) => { e.textContent = place; });
  f.runInBackground.checked = bg.runInBackground;
  f.autoStart.checked = bg.autostart;
  f.autoStart.disabled = !bg.autostartSupported;
  const notes = [];
  if (!bg.autostartSupported) notes.push('Starting with the computer is not supported on this system.');
  else if (bg.autostart) notes.push(`Registered to start at login${bg.autostartFile ? ` (${bg.autostartFile})` : ''}.`);
  if (bg.autostart && !bg.runInBackground) notes.push('⚠ Closing the window will stop collecting – enable "Keep collecting" too.');
  if (bg.autostart && !config.dataFolder) notes.push('⚠ No data folder selected – background data would not be saved.');
  $('#backgroundInfo').textContent = notes.join(' ');
}
api.onConfigChanged((c) => {
  config = c;
  $('#settingsForm').backgroundPollMin.value = +((config.backgroundPollIntervalMs || 300000) / 60000).toFixed(2);
  renderBackgroundSettings();
});
api.onRunning((running) => {
  $('#btnStart').disabled = running;
  $('#btnStop').disabled = !running;
  if (running) {
    setStatus('wait', `Connecting to ${config.host}:${config.port}…`);
  } else {
    connected = false;
    source = null;
    device = null;
    setStatus('', 'Stopped');
    renderBanner();
  }
});

// ---------- OneDrive data folder / history ----------
let historyResult = null;   // result of the last history load
let historyState = null;    // writer status from the main process

async function updateFolderInfo() {
  const f = $('#settingsForm');
  const el = $('#folderInfo');
  const folder = f.dataFolder.value.trim();
  if (!folder) {
    el.className = 'folder-info muted';
    el.textContent = 'No folder selected – data is only kept for this session.';
    return;
  }
  const i = await api.historyFolderInfo(folder);
  if (!i.exists) { el.className = 'folder-info err'; el.textContent = '✖ Folder does not exist.'; }
  else if (!i.writable) { el.className = 'folder-info err'; el.textContent = '✖ Folder is not writable.'; }
  else if (i.oneDrive) { el.className = 'folder-info ok'; el.textContent = `✔ Inside ${i.oneDrive} – files are synced by OneDrive.`; }
  else { el.className = 'folder-info warn'; el.textContent = '⚠ This folder is not inside a OneDrive folder – files are stored locally only.'; }
}
$('#settingsForm').dataFolder.addEventListener('change', updateFolderInfo);

$('#btnChooseFolder').addEventListener('click', async () => {
  const r = await api.historyChooseFolder();
  if (!r.ok) return;
  const f = $('#settingsForm');
  f.dataFolder.value = r.folder;
  await updateFolderInfo();
  f.requestSubmit();
});
$('#btnOpenFolder').addEventListener('click', () => api.historyOpenFolder());
$('#btnLoadHistory').addEventListener('click', () => loadHistory(true));

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ts).toLocaleString();
}

function renderHistoryChip() {
  const chip = $('#historyChip');
  const st = $('#historyStatus');
  if (!config.dataFolder) {
    chip.hidden = true;
    st.textContent = '';
    $('#historyNote').textContent = 'Charts are built from data polled in this session. Choose a OneDrive folder in Settings to keep history.';
    renderSaveIndicator();
    return;
  }
  const folderName = config.dataFolder.split(/[\\/]/).filter(Boolean).pop();
  const parts = [];
  if (historyResult?.skipped) parts.push('history hidden while showing simulated data');
  else if (historyResult?.ok) parts.push(`${historyResult.rows.toLocaleString()} stored samples (${historyResult.days} d, ${historyResult.files} file${historyResult.files === 1 ? '' : 's'})`);
  if (historyResult && !historyResult.ok) parts.push(`load failed: ${historyResult.error}`);
  if (historyState?.error) parts.push(`save failed: ${historyState.error}`);
  else if (config.storeEnabled) parts.push(historyState?.lastWrittenAt ? `${historyState.rowsWritten} rows saved, last ${fmtAgo(historyState.lastWrittenAt)}` : 'saving every poll');
  else parts.push('saving off');
  chip.hidden = false;
  chip.className = `history-chip${historyState?.error || (historyResult && !historyResult.ok) ? ' err' : config.storeEnabled ? '' : ' off'}`;
  chip.textContent = `☁ ${folderName}: ${parts.join(' · ')}`;
  chip.title = config.dataFolder + (historyState?.lastFile ? `\nLast file: ${historyState.lastFile}` : '');
  st.textContent = parts.join(' · ');
  $('#historyNote').textContent = 'Charts include history loaded from the data folder.';
  renderSaveIndicator();
}

// Pick a chart window that actually shows the loaded history.
function fitWindowsToHistory() {
  if (!samples.length) return;
  const span = Date.now() - samples[0].ts;
  for (const sel of [$('#overviewWindow'), $('#trendWindow')]) {
    const cur = Number(sel.value);
    if (!cur || cur >= span) continue;
    const opt = [...sel.options].map((o) => Number(o.value)).find((v) => v && v >= span);
    sel.value = String(opt ?? 0);
  }
  window.LwpCharts.setWindow(Number($('#overviewWindow').value));
}

async function loadHistory(manual = false) {
  $('#historyStatus').textContent = 'Loading history…';
  historyResult = await api.historyLoad();
  samples = await api.getSamples();
  if (historyResult.ok && historyResult.rows && (manual || !connected)) fitWindowsToHistory();
  updateSampleCount();
  if (samples.length) updateValues(samples[samples.length - 1]);
  updateChart();
  window.LwpCharts.update(samples);
  renderBanner();
  renderHistoryChip();
}

// Header indicator: flashes on every row written to the data folder.
let lastFlashCount = 0;
function renderSaveIndicator() {
  const el = $('#saveIndicator');
  const st = historyState;
  const time = (ts) => new Date(ts).toLocaleTimeString();
  let cls, text, title;
  if (!config.dataFolder) {
    cls = 'none'; text = '💾 Not saved'; title = 'No data folder selected – data is only kept for this session. Click to choose a folder.';
  } else if (!config.storeEnabled) {
    cls = 'off'; text = '💾 Saving off'; title = `Saving to ${config.dataFolder} is switched off in Settings.`;
  } else if (st?.error) {
    cls = 'err'; text = '💾 Save failed'; title = `Could not write to ${st.lastFile || config.dataFolder}:\n${st.error}`;
  } else if (st?.lastWrittenAt) {
    const file = (st.lastFile || '').split(/[\\/]/).pop();
    cls = 'ok'; text = `💾 Saved ${time(st.lastWrittenAt)}`;
    title = `Last write: ${new Date(st.lastWrittenAt).toLocaleString()}\nFile: ${st.lastFile}\n` +
      `Rows written this session: ${st.rowsWritten}${st.lastSource === 'simulator' ? '\n(simulated data → simulated/ subfolder)' : ''}`;
    el.dataset.file = file;
  } else {
    cls = 'idle'; text = '💾 Ready'; title = `Every data query will be saved to ${config.dataFolder}`;
  }
  el.className = `save-ind ${cls}`;
  el.textContent = text;
  el.title = title;
  if (cls === 'ok' && st.rowsWritten !== lastFlashCount) {
    lastFlashCount = st.rowsWritten;
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }
}
$('#saveIndicator').addEventListener('click', () => {
  if (config.dataFolder && config.storeEnabled && historyState?.lastFile) api.historyOpenFolder();
  else document.querySelector('nav [data-tab="settings"]').click();
});

api.onHistoryStatus((st) => { historyState = st; renderHistoryChip(); renderSaveIndicator(); });
setInterval(() => { if (historyState?.lastWrittenAt) renderHistoryChip(); }, 30000);

// ---------- Device search ----------
const dlg = $('#searchDialog');
const sf = $('#searchForm');
const results = new Map();
let searching = false;

const KIND_INFO = {
  lambda: { badge: 'LAMBDA', cls: 'k-lambda' },
  simulator: { badge: 'SIMULATOR', cls: 'k-sim' },
  modbus: { badge: 'MODBUS', cls: 'k-modbus' },
  pending: { badge: '…', cls: 'k-pending' },
};

function renderResults() {
  const list = [...results.values()].sort((a, b) => {
    const r = { lambda: 0, simulator: 1, modbus: 2, pending: 3 };
    return r[a.kind] - r[b.kind];
  });
  $('#searchResults').innerHTML = list.length ? list.map((r) => {
    const k = KIND_INFO[r.kind] || KIND_INFO.modbus;
    const d = r.details || {};
    const extra = r.kind === 'lambda'
      ? `State ${esc(d.hpState)} · ${esc(d.opState)} · Flow ${d.flowTemp?.toFixed?.(1)} °C${d.ambient != null ? ` · Outdoor ${d.ambient.toFixed(1)} °C` : ''}` : '';
    return `<li class="${k.cls}">
      <span class="kind">${k.badge}</span>
      <div class="info"><b>${esc(r.host)}:${r.port}</b><span>${esc(r.label)}</span>${extra ? `<span class="muted">${extra}</span>` : ''}</div>
      ${r.kind === 'pending' ? '' : `<button type="button" data-use="${esc(r.host)}" data-port="${r.port}" data-unit="${r.unitId ?? ''}">Use${r.kind === 'lambda' || r.kind === 'simulator' ? ' & connect' : ''}</button>`}
    </li>`;
  }).join('') : (searching ? '' : '<li class="empty muted">No devices found yet.</li>');
}

function setSearching(on) {
  searching = on;
  $('#btnSearchStart').disabled = on;
  $('#btnSearchCancel').disabled = !on;
  sf.querySelectorAll('.search-opts input').forEach((i) => { i.disabled = on; });
}

document.querySelectorAll('[data-open-search]').forEach((b) => b.addEventListener('click', async () => {
  sf.port.value = config.port || 502;
  sf.unitId.value = config.unitId || 1;
  const subs = await api.discoverySubnets();
  $('#searchSubnetsInfo').textContent = subs.length
    ? `Your network: ${subs.map((s) => `${s.cidr} (${s.iface}, this computer ${s.address})`).join(', ')} – localhost is also checked.`
    : 'No network interface found. Enter a subnet manually.';
  renderResults();
  dlg.showModal();
}));

$('#btnSearchStart').addEventListener('click', async () => {
  results.clear();
  renderResults();
  setSearching(true);
  $('#searchProgress').value = 0;
  $('#searchStatus').textContent = 'Starting…';
  const subnets = sf.subnets.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const r = await api.discoveryStart({ subnets, port: Number(sf.port.value) || 502, unitId: Number(sf.unitId.value) || 1 });
  setSearching(false);
  if (!r.ok) { $('#searchStatus').textContent = `Error: ${r.error}`; return; }
  for (const x of results.values()) if (x.kind === 'pending') results.delete(`${x.host}:${x.port}`);
  r.results.forEach((x) => results.set(`${x.host}:${x.port}`, x));
  renderResults();
  $('#searchProgress').value = $('#searchProgress').max;
  const n = r.results.filter((x) => x.kind === 'lambda').length;
  $('#searchStatus').textContent = `${r.cancelled ? 'Stopped' : 'Done'}: ${r.scanned} addresses in ${r.subnets.join(', ') || '–'} on port ${r.port}. `
    + (n ? `${n} LAMBDA heat pump${n > 1 ? 's' : ''} found.` : r.results.length ? 'No LAMBDA heat pump identified.' : 'No Modbus device found. Check that Modbus TCP is enabled on the heat pump and that it is on the same network.');
});
$('#btnSearchCancel').addEventListener('click', () => api.discoveryCancel());

let scanInfo = {};
api.onDiscoveryProgress((p) => {
  const bar = $('#searchProgress');
  if (p.phase === 'scan') {
    if (p.subnets) scanInfo = { subnets: p.subnets.join(', '), port: p.port };
    bar.max = p.total || 1;
    bar.value = p.done;
    $('#searchStatus').textContent = `Scanning ${scanInfo.subnets} on port ${scanInfo.port}… ${p.done}/${p.total}`;
  } else {
    $('#searchStatus').textContent = `Identifying ${p.host} (${p.done + 1}/${p.total})…`;
  }
});
api.onDiscoveryFound((r) => { results.set(`${r.host}:${r.port}`, r); renderResults(); });

$('#searchResults').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-use]');
  if (!b) return;
  const r = results.get(`${b.dataset.use}:${b.dataset.port}`);
  const f = $('#settingsForm');
  f.host.value = b.dataset.use;
  f.port.value = b.dataset.port;
  if (b.dataset.unit) f.unitId.value = b.dataset.unit;
  if (r?.kind === 'lambda' || r?.kind === 'simulator') {
    // Find out the installed modules so the user does not have to enter them.
    $('#searchResults').querySelectorAll('button').forEach((x) => { x.disabled = true; });
    $('#searchStatus').textContent = `Detecting installed modules on ${b.dataset.use}…`;
    const d = await api.detectModules({ host: b.dataset.use, port: Number(b.dataset.port), unitId: Number(b.dataset.unit) || 1 });
    if (d.ok) { applyDetected(d.modules); showDetectResult(d, false); }
    else $('#detectStatus').textContent = `Module detection failed: ${d.error}`;
  }
  dlg.close();
  f.requestSubmit();
  await new Promise((res) => setTimeout(res, 300));
  if (r?.kind === 'lambda' || r?.kind === 'simulator') {
    if ($('#btnStart').disabled) { await api.stop(); $('#btnStart').disabled = false; }
    $('#btnStart').click();
    document.querySelector('nav button[data-tab=overview]').click();
  } else {
    document.querySelector('nav button[data-tab=settings]').click();
  }
});

// ---------- Module detection ----------
let detectedPending = null;

function currentFormModules() {
  const m = {};
  $('#settingsForm').querySelectorAll('[data-mod]').forEach((i) => {
    m[i.dataset.mod] = i.type === 'checkbox' ? (i.checked ? 1 : 0) : Number(i.value) || 0;
  });
  return m;
}

function applyDetected(modules) {
  $('#settingsForm').querySelectorAll('[data-mod]').forEach((i) => {
    const v = modules[i.dataset.mod];
    if (v === undefined) return;
    if (i.type === 'checkbox') i.checked = v > 0; else i.value = v;
    i.classList.add('detected');
  });
}

function showDetectResult(d, pending) {
  const box = $('#detectResult');
  const before = currentFormModules();
  detectedPending = pending ? d.modules : null;
  const rows = meta.moduleTypes.map((t) => {
    const slots = d.details.filter((x) => x.type === t.id);
    const n = d.modules[t.id] ?? 0;
    const changed = pending && before[t.id] !== n;
    const why = slots.map((x) => `<span class="${x.present ? 'yes' : 'no'}">${x.present ? '✔' : '✖'} ${esc(t.max === 1 ? '' : `#${x.nr} `)}${esc(x.reason)}</span>`).join('<br>');
    return `<tr class="${changed ? 'changed' : ''}"><th>${esc(t.name)}</th><td class="${n ? 'yes' : 'no'}">${n}${changed ? ` <span class="muted">(was ${before[t.id]})</span>` : ''}</td><td>${why}</td></tr>`;
  }).join('');
  box.innerHTML = `<strong>Detected modules</strong>
    <table><thead><tr><th>Module</th><th>Count</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>
    ${d.notes.map((n) => `<p class="note">⚠ ${esc(n)}</p>`).join('')}
    <div class="detect-actions">${pending
      ? '<button type="button" id="btnApplyDetected">Apply &amp; save</button><button type="button" id="btnDismissDetected">Dismiss</button>'
      : '<span class="muted">Applied automatically. Check the counts below and correct them if needed.</span><button type="button" id="btnDismissDetected">Hide</button>'}</div>`;
  box.hidden = false;
  const total = Object.values(d.modules).reduce((a, b) => a + b, 0);
  $('#detectStatus').textContent = `Found ${total} module${total === 1 ? '' : 's'} on the device (${new Date().toLocaleTimeString()}).`;
}

$('#btnDetectModules').addEventListener('click', async () => {
  const f = $('#settingsForm');
  const btn = $('#btnDetectModules');
  btn.disabled = true;
  $('#detectResult').hidden = true;
  $('#detectStatus').textContent = `Reading ${f.host.value}:${f.port.value}…`;
  const d = await api.detectModules({ host: f.host.value.trim(), port: Number(f.port.value) || 502, unitId: Number(f.unitId.value) || 1 });
  btn.disabled = false;
  if (!d.ok) { $('#detectStatus').textContent = `✖ Detection failed: ${d.error}`; return; }
  showDetectResult(d, true);
});

api.onDetectProgress((p) => {
  const t = meta.moduleTypes.find((x) => x.id === p.type);
  $('#detectStatus').textContent = `Checking ${t ? t.name : p.type}${t && t.max > 1 ? ` ${p.nr}` : ''}…`;
});

$('#detectResult').addEventListener('click', (e) => {
  if (e.target.id === 'btnApplyDetected' && detectedPending) {
    applyDetected(detectedPending);
    detectedPending = null;
    $('#detectResult').hidden = true;
    $('#settingsForm').requestSubmit();
    $('#detectStatus').textContent = 'Detected modules applied and saved.';
  } else if (e.target.id === 'btnDismissDetected') {
    $('#detectResult').hidden = true;
  }
});

// ---------- Init ----------
(async function init() {
  meta = await api.getMeta();
  config = await api.getConfig();
  instances = await api.getInstances();
  samples = await api.getSamples();
  renderSettings();
  renderCards();
  renderPicker();
  updateSampleCount();
  refreshLogButton();
  if (samples.length) updateValues(samples[samples.length - 1]);
  window.LwpCharts.render(instances);
  window.LwpCharts.update(samples);
  const st = await api.getState();
  connected = st.connected;
  source = st.source;
  device = st.device || null;
  if (st.running) {
    $('#btnStart').disabled = true;
    $('#btnStop').disabled = false;
    if (connected) setStatus('ok', `Connected: ${device ? device.name : `${config.host}:${config.port}`}`);
    else setStatus('wait', `Connecting to ${config.host}:${config.port}…`);
  }
  renderBanner();
  historyState = await api.historyStatus();
  renderHistoryChip();
  // The window may be opened long after collecting started in the background: always (re)load the
  // full history from the data folder and fit the chart window to it.
  if (config.dataFolder && config.loadHistoryOnStart) await loadHistory(true);
})();
})();
