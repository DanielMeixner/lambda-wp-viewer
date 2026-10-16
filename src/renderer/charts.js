'use strict';
/* global Chart */
// Overview tab: preset charts (KPI sparklines, gauges, per-module time series, storage bars).
(() => {
  const C = {
    blue: '#0a7cc1', red: '#d33c3c', green: '#2e9e4f', amber: '#e0a100', purple: '#8e44ad',
    teal: '#16a085', slate: '#5d6d7e', orange: '#e67e22', pink: '#d81b60', grid: '#eef1f4',
  };
  const PALETTE = [C.blue, C.red, C.green, C.amber, C.purple, C.teal, C.orange, C.pink, C.slate];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

  let charts = [];
  let updaters = [];
  let instances = [];
  let windowMs = 1800000;

  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.color = '#5b6773';

  // Draws a value label in the middle of half-doughnut gauges.
  const gaugeText = {
    id: 'gaugeText',
    afterDraw(chart) {
      const o = chart.options.plugins.gaugeText;
      if (!o) return;
      const { ctx, chartArea: a } = chart;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#1d2733';
      ctx.font = (o.empty ? '600 15px ' : '600 22px ') + Chart.defaults.font.family;
      if (o.empty) ctx.fillStyle = '#94a3b8';
      ctx.fillText(o.text, (a.left + a.right) / 2, a.bottom - 8);
      ctx.font = '12px ' + Chart.defaults.font.family;
      ctx.fillStyle = '#6b7785';
      ctx.fillText(o.label, (a.left + a.right) / 2, a.bottom + 10);
      ctx.restore();
    },
  };

  const U = window.LwpChartUtil;
  const value = (sample, key) => U.num(sample, key);
  const has = (type) => instances.filter((i) => i.type === type);

  function windowed(samples) {
    if (!windowMs) return samples;
    const from = Date.now() - windowMs;
    return samples.filter((s) => s.ts >= from);
  }

  // Gap threshold is computed once per update from all samples in the window.
  let gapThr = 15 * 60000;

  function line(label, color, opts = {}) {
    return {
      label, borderColor: color, backgroundColor: opts.fill ? alpha(color, 0.12) : color,
      borderWidth: 2, pointRadius: U.isolatedRadius, pointHoverRadius: 3, cubicInterpolationMode: 'monotone',
      spanGaps: false, fill: opts.fill ? 'origin' : false,
      borderDash: opts.dash, yAxisID: opts.y || 'y', key: opts.key, unit: opts.unit || '', digits: opts.digits ?? 1, data: [],
    };
  }

  // Generic time-series chart; datasets carry a `key` used to fill data on update.
  function timeChart(canvas, datasets, yAxes) {
    for (const d of datasets) {
      const ax = yAxes.find((a) => a.id === d.yAxisID) || yAxes[0];
      if (!d.unit) d.unit = ax.unit || '';
      if (ax.digits != null) d.digits = ax.digits;
    }
    const scales = { x: U.timeAxis([], { grid: { color: C.grid } }) };
    yAxes.forEach((ax, i) => {
      scales[ax.id] = {
        position: ax.right ? 'right' : 'left',
        title: U.axisTitle(ax.title),
        grid: { color: C.grid, drawOnChartArea: i === 0 },
        suggestedMin: ax.min, suggestedMax: ax.max, beginAtZero: !!ax.zero,
      };
    });
    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false, maintainAspectRatio: false, parsing: false, normalized: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 2, padding: 12 } },
          subtitle: U.subtitle(U.period()),
          noData: { ranges: [] },
          tooltip: U.tooltip((v, it) => `${v.toFixed(it.dataset.digits)}${it.dataset.unit ? ' ' + it.dataset.unit : ''}`),
        },
        scales,
      },
    });
    charts.push(chart);
    updaters.push((samples) => {
      const data = windowed(samples);
      chart.options.scales.x = U.timeAxis(data, { grid: { color: C.grid } });
      chart.options.plugins.subtitle.text = U.period(data[0]?.ts, data[data.length - 1]?.ts);
      chart.options.plugins.noData.ranges = U.gaps(data, gapThr);
      chart.data.datasets.forEach((d) => { d.data = U.points(data, d.key, gapThr); });
      chart.update('none');
    });
  }

  function gauge(canvas, key, label, max, unit, digits, colorFor) {
    const chart = new Chart(canvas, {
      type: 'doughnut',
      data: { datasets: [{ data: [0, max], backgroundColor: [C.blue, '#e9edf1'], borderWidth: 0 }] },
      options: {
        animation: { duration: 400 }, rotation: -90, circumference: 180, cutout: '72%',
        maintainAspectRatio: false, events: [],
        layout: { padding: { bottom: 16 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false }, gaugeText: { text: 'no data', label } },
      },
      plugins: [gaugeText],
    });
    charts.push(chart);
    updaters.push((samples) => {
      // Only the latest sample counts: an older value is never shown as current.
      const v = value(samples[samples.length - 1], key);
      const clamped = v == null ? 0 : Math.max(0, Math.min(max, v));
      chart.data.datasets[0].data = v == null ? [0, max] : [clamped, max - clamped];
      chart.data.datasets[0].backgroundColor[0] = colorFor(v ?? 0);
      chart.options.plugins.gaugeText.text = v == null ? 'no data' : `${v.toFixed(digits)}${unit}`;
      chart.options.plugins.gaugeText.empty = v == null;
      chart.update();
    });
  }

  function sparkTile(container, key, label, unit, digits, color) {
    const tile = document.createElement('div');
    tile.className = 'kpi';
    tile.innerHTML = `<div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value na">no data</div><div class="kpi-trend"></div>
      <div class="kpi-spark"><canvas></canvas></div><div class="kpi-period"></div>`;
    container.appendChild(tile);
    const chart = new Chart(tile.querySelector('canvas'), {
      type: 'line',
      data: { datasets: [{ data: [], borderColor: color, backgroundColor: alpha(color, 0.15), fill: 'origin', borderWidth: 1.5, pointRadius: U.isolatedRadius, cubicInterpolationMode: 'monotone', spanGaps: false }] },
      options: {
        animation: false, maintainAspectRatio: false, parsing: false, events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { type: 'linear', display: false }, y: { display: false, grace: '10%' } },
      },
    });
    charts.push(chart);
    updaters.push((samples) => {
      const data = windowed(samples);
      const pts = U.points(data, key, gapThr);
      chart.data.datasets[0].data = pts;
      chart.options.scales.x.min = data[0]?.ts;
      chart.options.scales.x.max = data[data.length - 1]?.ts;
      chart.update('none');
      const vals = pts.filter((p) => p.y != null);
      // The big number is the latest sample only; if it has no value, show "no data" instead of an older value.
      const last = value(samples[samples.length - 1], key);
      const valEl = tile.querySelector('.kpi-value');
      valEl.textContent = last == null ? 'no data' : `${last.toFixed(digits)}${unit ? ' ' + unit : ''}`;
      valEl.classList.toggle('na', last == null);
      const u = unit ? ' ' + unit : '';
      const per = tile.querySelector('.kpi-period');
      per.textContent = vals.length ? `🕑 ${U.periodShort(data[0].ts, data[data.length - 1].ts)}` : 'No data in the selected period';
      per.title = vals.length ? `Sparkline period: ${U.period(data[0].ts, data[data.length - 1].ts)}` : '';
      const trend = tile.querySelector('.kpi-trend');
      if (vals.length > 1) {
        const diff = vals[vals.length - 1].y - vals[0].y;
        const min = Math.min(...vals.map((p) => p.y)), max = Math.max(...vals.map((p) => p.y));
        const same = Math.abs(diff) < 0.5 * 10 ** -digits;
        trend.textContent = `${same ? '±' : diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(digits)}${u}  ·  range ${min.toFixed(digits)}–${max.toFixed(digits)}${u}`;
        trend.title = 'Change and min–max range within the period shown below the sparkline';
        trend.className = `kpi-trend ${same ? '' : diff > 0 ? 'up' : 'down'}`;
      } else trend.textContent = '';
    });
  }

  function storageChart(canvas) {
    const items = [];
    for (const i of has('boiler')) items.push({ label: i.name, hi: `${i.id}.tHigh`, lo: `${i.id}.tLow`, max: `${i.id}.tMax` });
    for (const i of has('buffer')) items.push({ label: i.name, hi: `${i.id}.tHigh`, lo: `${i.id}.tLow`, max: `${i.id}.tMax` });
    for (const i of has('solar')) {
      items.push({ label: `${i.name} collector`, hi: `${i.id}.tCollector`, lo: null, max: null });
      items.push({ label: `${i.name} buffer 1/2`, hi: `${i.id}.tBuffer1`, lo: `${i.id}.tBuffer2`, max: `${i.id}.tMax` });
    }
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: items.map((x) => x.label),
        datasets: [
          { label: 'Top / high sensor', backgroundColor: C.red, borderRadius: 4, data: [] },
          { label: 'Bottom / low sensor', backgroundColor: C.blue, borderRadius: 4, data: [] },
          { type: 'line', label: 'Max. setting', borderColor: C.slate, backgroundColor: C.slate, showLine: false, pointStyle: 'line', pointRadius: 18, pointBorderWidth: 3, data: [] },
        ],
      },
      options: {
        animation: { duration: 300 }, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
          subtitle: U.subtitle(U.at()),
          noData: { ranges: [], emptyText: 'No data' },
          tooltip: { filter: (it) => it.parsed.y != null, callbacks: { label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(1)} °C` } },
        },
        scales: {
          y: { beginAtZero: true, suggestedMax: 70, title: U.axisTitle('Temperature [°C]'), grid: { color: C.grid } },
          x: { title: U.axisTitle('Storage / sensor'), grid: { display: false } },
        },
      },
    });
    charts.push(chart);
    updaters.push((samples) => {
      const s = samples[samples.length - 1];
      chart.data.datasets[0].data = items.map((x) => value(s, x.hi));
      chart.data.datasets[1].data = items.map((x) => (x.lo ? value(s, x.lo) : null));
      chart.data.datasets[2].data = items.map((x) => (x.max ? value(s, x.max) : null));
      chart.options.plugins.subtitle.text = `${U.at(s?.ts)} (latest sample)`;
      chart.update('none');
    });
  }

  function panel(parent, title, cls = '') {
    const el = document.createElement('div');
    el.className = `panel ${cls}`;
    el.innerHTML = `<h3>${esc(title)}</h3><div class="panel-body"><canvas></canvas></div>`;
    parent.appendChild(el);
    return el.querySelector('canvas');
  }

  function render(newInstances) {
    charts.forEach((c) => c.destroy());
    charts = [];
    updaters = [];
    instances = newInstances;
    const root = document.getElementById('overview');
    root.innerHTML = '';
    if (!instances.length) {
      root.innerHTML = '<p class="muted">No modules configured. Open Settings to add modules.</p>';
      return;
    }

    // KPI tiles
    const kpis = document.createElement('div');
    kpis.className = 'kpis';
    root.appendChild(kpis);
    if (has('ambient').length) sparkTile(kpis, 'ambient.actual', 'Outdoor temperature', '°C', 1, C.teal);
    for (const hp of has('heatpump')) {
      const n = has('heatpump').length > 1 ? `${hp.name} · ` : '';
      sparkTile(kpis, `${hp.id}.qp`, `${n}Heat output`, 'kW', 1, C.red);
      sparkTile(kpis, `${hp.id}.fiPower`, `${n}Electrical power`, 'W', 0, C.amber);
      sparkTile(kpis, `${hp.id}.cop`, `${n}COP`, '', 2, C.green);
      sparkTile(kpis, `${hp.id}.tFlow`, `${n}Flow temperature`, '°C', 1, C.blue);
    }
    if (has('emanager').length) sparkTile(kpis, 'emanager.power', 'E-Manager power (PV)', 'W', 0, C.orange);
    for (const b of has('boiler')) sparkTile(kpis, `${b.id}.tHigh`, `${b.name} top`, '°C', 1, C.pink);

    // One section per installed module, each with its own chart(s).
    const order = ['heatpump', 'ambient', 'emanager', 'boiler', 'buffer', 'solar', 'circuit'];
    const mods = order.flatMap((t) => has(t));
    const nav = document.createElement('nav');
    nav.className = 'module-nav';
    nav.innerHTML = '<span class="muted">Modules:</span>' + mods.map((m) => `<a href="#mod-${m.id}" data-mod="${m.id}">${esc(m.name)}</a>`).join('');
    nav.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-mod]');
      if (!a) return;
      e.preventDefault();
      document.getElementById(`mod-${a.dataset.mod}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    root.appendChild(nav);

    const section = (m) => {
      const sec = document.createElement('section');
      sec.className = 'module-section';
      sec.id = `mod-${m.id}`;
      sec.innerHTML = `<h2>${esc(m.name)}</h2>`;
      const grid = document.createElement('div');
      grid.className = 'panels';
      sec.appendChild(grid);
      root.appendChild(sec);
      return grid;
    };
    const T = [{ id: 'y', title: 'Temperature [°C]', unit: '°C' }];

    for (const m of mods) {
      const grid = section(m);
      const k = (key) => `${m.id}.${key}`;
      if (m.type === 'heatpump') {
        const g = document.createElement('div');
        g.className = 'panel gauges';
        g.innerHTML = `<h3>${esc(m.name)} – live</h3><div class="panel-period">No data</div><div class="gauge-row">
          <div class="gauge"><canvas></canvas></div><div class="gauge"><canvas></canvas></div><div class="gauge"><canvas></canvas></div></div>`;
        grid.appendChild(g);
        const [g1, g2, g3] = g.querySelectorAll('canvas');
        updaters.push((samples) => {
          const ts = samples[samples.length - 1]?.ts;
          g.querySelector('.panel-period').textContent = `${U.at(ts)} (latest sample)`;
        });
        gauge(g1, k('compressor'), 'Compressor', 100, ' %', 0, () => C.blue);
        gauge(g2, k('cop'), 'COP', 8, '', 2, (v) => (v >= 4 ? C.green : v >= 3 ? C.amber : C.red));
        gauge(g3, k('qp'), 'Heat output', 20, ' kW', 1, () => C.red);
        timeChart(panel(grid, `${m.name} – volume flow & compressor`), [
          line('Sink flow [l/min]', C.blue, { key: k('volSink') }),
          line('Source flow [l/min]', C.teal, { key: k('volSource') }),
          line('Compressor [%]', C.purple, { key: k('compressor'), y: 'y1', dash: [4, 3] }),
        ], [{ id: 'y', title: 'Volume flow [l/min]', unit: 'l/min', zero: true }, { id: 'y1', title: 'Compressor rating [%]', unit: '%', right: true, min: 0, max: 100 }]);
        timeChart(panel(grid, `${m.name} – temperatures`, 'wide'), [
          line('Flow', C.red, { key: k('tFlow') }),
          line('Return', C.orange, { key: k('tReturn') }),
          line('Source in', C.blue, { key: k('tEqIn') }),
          line('Source out', C.teal, { key: k('tEqOut') }),
        ], T);
        timeChart(panel(grid, `${m.name} – performance`, 'wide'), [
          line('Heat output [kW]', C.red, { key: k('qp'), fill: true }),
          line('Electrical power [kW]', C.amber, { key: k('fiPowerKw'), fill: true }),
          line('COP', C.green, { key: k('cop'), y: 'y1' }),
        ], [{ id: 'y', title: 'Power [kW]', unit: 'kW', zero: true }, { id: 'y1', title: 'COP [–]', unit: '', digits: 2, right: true, zero: true }]);
      } else if (m.type === 'ambient') {
        timeChart(panel(grid, `${m.name} – outdoor temperature`), [
          line('Actual', C.teal, { key: k('actual'), fill: true }),
          line('Average 1 h', C.blue, { key: k('avg1h'), dash: [6, 4] }),
          line('Calculated', C.purple, { key: k('calc'), dash: [2, 3] }),
        ], T);
      } else if (m.type === 'emanager') {
        timeChart(panel(grid, `${m.name} – power`), [
          line('Actual power (input/excess)', C.orange, { key: k('power'), fill: true }),
          line('Consumption', C.red, { key: k('consumption') }),
          line('Consumption setpoint', C.slate, { key: k('setpoint'), dash: [6, 4] }),
        ], [{ id: 'y', title: 'Power [W]', unit: 'W', digits: 0 }]);
      } else if (m.type === 'boiler' || m.type === 'buffer') {
        timeChart(panel(grid, `${m.name} – temperatures`), [
          line('Top / high sensor', C.red, { key: k('tHigh') }),
          line('Bottom / low sensor', C.blue, { key: k('tLow') }),
          line('Max. setting', C.slate, { key: k('tMax'), dash: [6, 4] }),
        ], T);
      } else if (m.type === 'solar') {
        timeChart(panel(grid, `${m.name} – temperatures`), [
          line('Collector', C.orange, { key: k('tCollector'), fill: true }),
          line('Buffer 1', C.red, { key: k('tBuffer1') }),
          line('Buffer 2', C.blue, { key: k('tBuffer2') }),
          line('Max. setting', C.slate, { key: k('tMax'), dash: [6, 4] }),
          line('Changeover', C.purple, { key: k('tChange'), dash: [2, 3] }),
        ], T);
      } else if (m.type === 'circuit') {
        timeChart(panel(grid, `${m.name} – temperatures`), [
          line('Flow', C.red, { key: k('tFlow') }),
          line('Flow setpoint', C.red, { key: k('tFlowSet'), dash: [6, 4] }),
          line('Return', C.orange, { key: k('tReturn') }),
          line('Room', C.green, { key: k('tRoom') }),
          line('Room setpoint (heating)', C.green, { key: k('roomHeat'), dash: [6, 4] }),
        ], T);
      }
    }

    // Side-by-side comparison of all storage tanks (only useful with more than one).
    const storages = has('boiler').length + has('buffer').length + has('solar').length;
    if (storages > 1) {
      const sec = document.createElement('section');
      sec.className = 'module-section';
      sec.innerHTML = '<h2>Comparison</h2>';
      const grid = document.createElement('div');
      grid.className = 'panels';
      sec.appendChild(grid);
      root.appendChild(sec);
      storageChart(panel(grid, 'Storage temperatures (current)'));
    }
  }

  // Derived values (e.g. FI power in kW to share an axis with heat output).
  function enrich(samples) {
    const hps = has('heatpump');
    for (const s of samples) {
      if (s._enriched) continue;
      for (const hp of hps) {
        const w = value(s, `${hp.id}.fiPower`);
        s.values[`${hp.id}.fiPowerKw`] = w == null ? { missing: true, value: null } : { value: w / 1000 };
      }
      s._enriched = true;
    }
  }

  function update(samples) {
    if (!samples.length) return;
    enrich(samples);
    gapThr = U.gapThreshold(windowed(samples));
    updaters.forEach((u) => u(samples));
  }

  window.LwpCharts = {
    render,
    update,
    setWindow(ms) { windowMs = ms; },
  };
})();
