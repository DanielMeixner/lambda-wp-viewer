'use strict';
/* global Capacitor, Chart, LwpRegisters, LwpMobile */
(() => {
  const $ = (selector) => document.querySelector(selector);
  const { MODULE_TYPES } = LwpRegisters;
  const { DEFAULT_CONFIG, validateConfig, makePlan, LiveSession } = LwpMobile;
  const storageKey = 'lambda-mobile-config';
  let config = { ...DEFAULT_CONFIG, modules: { ...DEFAULT_CONFIG.modules } };
  let storageWarning = '';
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) config = validateConfig(JSON.parse(stored));
  } catch {
    storageWarning = 'Saved settings could not be loaded. Check and save your connection settings.';
  }
  let instances = [];
  let samples = [];
  let points = new Map();
  const cells = new Map();
  let chart;
  const form = $('#settingsForm');
  const native = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
  const reader = native ? Capacitor.registerPlugin('ModbusReader') : {
    read: async () => { throw new Error('Install the Android or iOS app to read Modbus TCP. Web browsers cannot open TCP sockets'); },
  };

  function showTab(tab) {
    $('#live').hidden = tab !== 'live';
    $('#settings').hidden = tab !== 'settings';
    document.querySelectorAll('nav button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    });
    if (tab === 'live') chart?.resize();
  }

  function showStatus(state) {
    if (state.pending) {
      $('#status').textContent = state.message;
      return;
    }
    $('#banner').className = `banner ${state.connected ? (state.source === 'simulator' ? 'sim' : 'live') : 'stale'}`;
    $('#source').textContent = state.connected
      ? (state.source === 'simulator' ? 'SIMULATED DATA — NOT A REAL HEAT PUMP' : 'LIVE DATA — REAL HEAT PUMP')
      : (samples.length ? 'NOT CONNECTED — OUTDATED VALUES' : 'NOT CONNECTED');
    $('#status').textContent = state.connected
      ? (state.source === 'simulator' ? 'Test values from the simulator.' : 'Read directly from your heat pump.')
      : state.message;
    document.body.classList.toggle('stale', !state.connected);
  }

  const session = new LiveSession(reader, {
    onData(sample) {
      if (samples.length && samples[0].source !== sample.source) samples = [];
      samples.push(sample);
      if (samples.length > 720) samples.shift();
      for (const [key, cell] of cells) {
        const value = sample.values[key];
        const d = points.get(key);
        const missing = !value || value.error || value.value == null;
        const decimals = d.scale >= 1 ? 0 : Math.round(-Math.log10(d.scale));
        cell.textContent = missing ? '—' : (value.text ?? `${value.value.toFixed(decimals)}${d.unit ? ` ${d.unit}` : ''}`);
        cell.classList.toggle('missing', !!missing);
        cell.title = value?.error || (missing ? 'No valid reading in the latest poll.' : `Register ${d.address}`);
      }
      $('#updated').textContent = `Last reading: ${new Date(sample.ts).toLocaleString()}`;
      updateChart();
    },
    onStatus: showStatus,
  });

  function renderConfig() {
    instances = makePlan(config).instances;
    $('#endpoint').textContent = `${config.host}:${config.port} · unit ${config.unitId}`;
    for (const key of ['host', 'port', 'unitId', 'timeoutMs']) form.elements[key].value = config[key];
    form.elements.pollIntervalSec.value = config.pollIntervalMs / 1000;
    form.elements.emanagerSigned.checked = config.emanagerSigned;
    $('#moduleCounts').replaceChildren();
    for (const type of MODULE_TYPES) {
      const label = document.createElement('label');
      label.textContent = `${type.name} (0–${type.max})`;
      const input = document.createElement('input');
      Object.assign(input, { name: `module_${type.id}`, type: 'number', min: '0', max: String(type.max),
        step: '1', required: true, inputMode: 'numeric', value: config.modules[type.id] });
      label.append(input);
      $('#moduleCounts').append(label);
    }
    $('#modules').replaceChildren();
    $('#trend').replaceChildren();
    cells.clear();
    points = new Map();
    for (const inst of instances) {
      const card = document.createElement('details');
      card.open = inst.type === 'heatpump' || inst.type === 'ambient';
      const summary = document.createElement('summary');
      summary.textContent = inst.name;
      const list = document.createElement('dl');
      for (const d of inst.datapoints) {
        const key = `${inst.id}.${d.key}`;
        points.set(key, d);
        const row = document.createElement('div');
        row.className = 'reading';
        const name = document.createElement('dt');
        name.textContent = d.name;
        const value = document.createElement('dd');
        value.textContent = '—';
        row.append(name, value);
        list.append(row);
        cells.set(key, value);
        if (!d.enum) {
          const option = document.createElement('option');
          option.value = key;
          option.textContent = `${inst.name} · ${d.name}${d.unit ? ` [${d.unit}]` : ''}`;
          $('#trend').append(option);
        }
      }
      card.append(summary, list);
      $('#modules').append(card);
    }
    if (points.has('heatpump1.tFlow')) $('#trend').value = 'heatpump1.tFlow';
    updateChart();
  }

  function updateChart() {
    const key = $('#trend').value;
    const d = points.get(key);
    const data = [];
    samples.forEach((sample, i) => {
      const previous = samples[i - 1];
      if (previous && sample.ts - previous.ts > Math.max(30000, 3 * sample.intervalMs)) {
        data.push({ x: previous.ts + 1, y: null });
      }
      data.push({ x: sample.ts, y: sample.values[key]?.value ?? null });
    });
    const source = samples[0]?.source === 'simulator' ? 'SIMULATED · ' : '';
    $('#period').textContent = samples.length
      ? `${source}${new Date(samples[0].ts).toLocaleString()} – ${new Date(samples[samples.length - 1].ts).toLocaleString()} · ${samples.length} session samples (max. 720)`
      : 'No readings yet. Gaps and missing values are not connected.';
    if (!chart) {
      chart = new Chart($('#chart'), {
        type: 'line',
        data: { datasets: [{ data: [], borderColor: '#1883bc', pointRadius: 2, borderWidth: 2, spanGaps: false, tension: 0 }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'linear', title: { display: true, text: 'Time (hh:mm:ss)' },
              ticks: { maxTicksLimit: 4, callback: (value) => new Date(value).toLocaleTimeString() } },
            y: { title: { display: true, text: '' } },
          },
        },
      });
    }
    chart.data.datasets[0].data = data;
    chart.options.scales.y.title.text = d ? `${d.name}${d.unit ? ` [${d.unit}]` : ''}` : 'Value';
    chart.update('none');
  }

  document.querySelectorAll('nav button').forEach((button) => {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  });
  $('#trend').addEventListener('change', updateChart);
  $('#connect').addEventListener('click', () => {
    session.start(config);
    $('#connect').disabled = true;
    $('#disconnect').disabled = false;
  });
  $('#disconnect').addEventListener('click', () => {
    session.stop();
    $('#connect').disabled = false;
    $('#disconnect').disabled = true;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const next = validateConfig({
        host: form.elements.host.value, port: form.elements.port.value, unitId: form.elements.unitId.value,
        timeoutMs: form.elements.timeoutMs.value, pollIntervalMs: Number(form.elements.pollIntervalSec.value) * 1000,
        emanagerSigned: form.elements.emanagerSigned.checked,
        modules: Object.fromEntries(MODULE_TYPES.map((type) => [type.id, form.elements[`module_${type.id}`].value])),
      });
      localStorage.setItem(storageKey, JSON.stringify(next));
      session.stop();
      config = next;
      samples = [];
      $('#updated').textContent = '';
      $('#connect').disabled = false;
      $('#disconnect').disabled = true;
      renderConfig();
      showStatus({ connected: false, message: 'Settings saved. Tap Connect for live data.' });
      $('#saveStatus').textContent = 'Saved on this device. Session readings cleared.';
    } catch (error) {
      $('#saveStatus').textContent = `Not saved: ${error.message}`;
    }
  });
  document.addEventListener('visibilitychange', () => session.setActive(!document.hidden));
  window.addEventListener('pagehide', () => session.setActive(false));
  window.addEventListener('pageshow', () => session.setActive(!document.hidden));
  renderConfig();
  session.setActive(!document.hidden);
  if (!native || storageWarning) {
    $('#saveStatus').textContent = storageWarning || 'This preview cannot connect. Install the native Android or iOS app.';
  }
  showTab('settings');
})();
