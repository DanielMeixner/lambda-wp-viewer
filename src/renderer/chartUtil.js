'use strict';
/* global Chart */
// Shared chart helpers: axis titles, time period captions, gap handling and "no data" marking.
(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (d) => d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
  }

  // "16.10.2026 14:02:11 – 14:42:05 (40 min)"
  function period(from, to) {
    if (from == null || to == null) return 'No data in the selected period';
    const a = new Date(from), b = new Date(to);
    if (from === to) return `${dateStr(a)} ${timeStr(a)} (single sample)`;
    const end = a.toDateString() === b.toDateString() ? timeStr(b) : `${dateStr(b)} ${timeStr(b)}`;
    return `${dateStr(a)} ${timeStr(a)} – ${end} (${duration(to - from)})`;
  }

  // Compact form for small tiles: "12:57–14:45 (1 h 48 min)", with dates when not today.
  function periodShort(from, to) {
    if (from == null || to == null) return 'No data in the selected period';
    const a = new Date(from), b = new Date(to);
    const today = new Date().toDateString();
    const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}${to - from < 900000 ? ':' + pad(d.getSeconds()) : ''}`;
    const f = (d) => (d.toDateString() === today ? hm(d) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${hm(d)}`);
    return `${f(a)}–${a.toDateString() === b.toDateString() ? hm(b) : f(b)} (${duration(to - from)})`;
  }

  const at = (ts) => (ts == null ? 'No data' : `Values at ${dateStr(new Date(ts))} ${timeStr(new Date(ts))}`);

  // Time between two samples above which the chart shows "no data" instead of connecting the points:
  // 3× the typical poll interval (median), at least 30 s.
  function gapThreshold(samples) {
    if (samples.length < 3) return 15 * 60000;
    const d = [];
    for (let i = 1; i < samples.length; i++) d.push(samples[i].ts - samples[i - 1].ts);
    d.sort((x, y) => x - y);
    return Math.max(30000, 3 * d[Math.floor(d.length / 2)]);
  }

  // Samples record the poll interval they were read with (seconds with the window open, minutes in the
  // background), so a pause is a gap only when it is clearly longer than that. Older rows without it use thr.
  function isGap(a, b, thr) {
    const iv = Math.max(a.intervalMs || 0, b.intervalMs || 0);
    return b.ts - a.ts > (iv ? Math.max(30000, 3 * iv) : thr);
  }

  function gaps(samples, thr) {
    const out = [];
    for (let i = 1; i < samples.length; i++) {
      if (isGap(samples[i - 1], samples[i], thr)) out.push({ from: samples[i - 1].ts, to: samples[i].ts });
    }
    return out;
  }

  const num = (sample, key) => {
    const v = sample?.values[key];
    return v && !v.error && !v.missing && Number.isFinite(v.value) ? v.value : null;
  };

  // Points for one value. Missing values and gaps become null, so lines are never drawn across them.
  function points(samples, key, thr) {
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (i && isGap(samples[i - 1], s, thr)) out.push({ x: (s.ts + samples[i - 1].ts) / 2, y: null });
      out.push({ x: s.ts, y: num(s, key) });
    }
    return out;
  }

  // Points without neighbours would be invisible with pointRadius 0, so draw them as dots.
  function isolatedRadius(ctx) {
    const d = ctx.dataset.data;
    const i = ctx.dataIndex;
    if (d[i]?.y == null) return 0;
    return d[i - 1]?.y == null && d[i + 1]?.y == null ? 2.5 : 0;
  }

  const tickFormat = (span) => (v) => {
    const d = new Date(v);
    if (span > 20 * 3600000) return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (span < 900000) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // Evenly spaced ticks on round local times (e.g. every 15 min), about `count` of them.
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].map((s) => s * 1000);
  function niceTicks(min, max, count = 6) {
    if (!(max > min)) return min == null ? [] : [{ value: min }];
    const step = STEPS.find((s) => (max - min) / s <= count) || STEPS[STEPS.length - 1];
    const off = -new Date(min).getTimezoneOffset() * 60000;
    const out = [];
    for (let t = Math.ceil((min + off) / step) * step - off; t <= max; t += step) out.push({ value: t });
    return out;
  }

  // X axis limited to the time range that actually has data.
  function timeAxis(samples, extra = {}) {
    const min = samples.length ? samples[0].ts : undefined;
    const max = samples.length ? samples[samples.length - 1].ts : undefined;
    const span = (max ?? 0) - (min ?? 0);
    return {
      type: 'linear', min, max,
      title: { display: true, text: span > 20 * 3600000 ? 'Time (date, hh:mm)' : span < 900000 ? 'Time (hh:mm:ss)' : 'Time (hh:mm)', font: { weight: '600' } },
      ticks: { callback: tickFormat(span), maxRotation: 0, autoSkip: false },
      afterBuildTicks: (axis) => { axis.ticks = niceTicks(min, max); },
      ...extra,
    };
  }

  const axisTitle = (text) => ({ display: !!text, text, font: { weight: '600' } });

  const subtitle = (text) => ({ display: true, text, align: 'start', color: '#5b6773', font: { size: 11 }, padding: { bottom: 8 } });

  // Tooltip that never lists missing values.
  const tooltip = (fmt = (v) => v.toFixed(2)) => ({
    filter: (it) => it.parsed.y != null,
    callbacks: {
      title: (items) => (items.length ? new Date(items[0].parsed.x).toLocaleString() : ''),
      label: (it) => `${it.dataset.label.replace(/\s*\[[^\]]*\]$/, '')}: ${fmt(it.parsed.y, it)}`,
    },
  });

  // Hatched bands where no data exists; "No data" overlay when the chart is empty.
  const noData = {
    id: 'noData',
    beforeDatasetsDraw(chart) {
      const o = chart.options.plugins.noData;
      if (!o || !o.ranges?.length) return;
      const { ctx, chartArea: a, scales: { x } } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top);
      ctx.clip();
      for (const r of o.ranges) {
        const x1 = Math.max(a.left, x.getPixelForValue(r.from));
        const x2 = Math.min(a.right, x.getPixelForValue(r.to));
        if (x2 - x1 < 1) continue;
        const h = a.bottom - a.top;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1, a.top, x2 - x1, h);
        ctx.clip();
        ctx.fillStyle = 'rgba(100,116,139,0.10)';
        ctx.fillRect(x1, a.top, x2 - x1, h);
        ctx.strokeStyle = 'rgba(100,116,139,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = x1 - h; k < x2; k += 8) { ctx.moveTo(k, a.bottom); ctx.lineTo(k + h, a.top); }
        ctx.stroke();
        ctx.restore();
        if (x2 - x1 > 44) {
          ctx.fillStyle = '#64748b';
          ctx.font = '11px ' + Chart.defaults.font.family;
          ctx.textAlign = 'center';
          ctx.fillText('no data', (x1 + x2) / 2, a.top + 14);
        }
      }
      ctx.restore();
    },
    afterDraw(chart) {
      const o = chart.options.plugins.noData;
      if (!o) return;
      const empty = !chart.data.datasets.some((d) => d.data.some((p) => (p && typeof p === 'object' ? p.y : p) != null));
      if (!empty) return;
      const { ctx, chartArea: a } = chart;
      ctx.save();
      ctx.fillStyle = '#64748b';
      ctx.font = '600 13px ' + Chart.defaults.font.family;
      ctx.textAlign = 'center';
      ctx.fillText(o.emptyText || 'No data', (a.left + a.right) / 2, (a.top + a.bottom) / 2);
      ctx.restore();
    },
  };
  Chart.register(noData);

  window.LwpChartUtil = { duration, period, periodShort, at, gapThreshold, gaps, points, num, isolatedRadius, timeAxis, axisTitle, subtitle, tooltip };
})();
