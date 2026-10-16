'use strict';
const fs = require('fs');

const esc = (s) => {
  const str = String(s ?? '');
  return /[",;\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

// Poll interval the row was read with (5 s with the window open, e.g. 300 s in the background).
// Charts use it to tell a slow background interval from a real gap.
const INTERVAL_HEADER = 'poll interval [s]';

function columns(instances) {
  const cols = [];
  for (const inst of instances) {
    for (const d of inst.datapoints) {
      const unit = d.unit ? ` [${d.unit}]` : '';
      cols.push({ key: `${inst.id}.${d.key}`, header: `${inst.name} - ${d.name}${unit}`, kind: 'value' });
      if (d.enum) cols.push({ key: `${inst.id}.${d.key}`, header: `${inst.name} - ${d.name} (text)`, kind: 'text' });
    }
  }
  return cols;
}

function headerLine(cols) {
  return ['timestamp', 'source', ...cols.map((c) => c.header), INTERVAL_HEADER].map(esc).join(',') + '\n';
}

function rowLine(cols, sample) {
  const cells = [new Date(sample.ts).toISOString(), sample.source === 'simulator' ? 'SIMULATED' : 'device'];
  for (const c of cols) {
    const v = sample.values[c.key];
    if (!v || v.error || v.value == null) cells.push('');
    else cells.push(c.kind === 'text' ? v.text : v.value);
  }
  cells.push(sample.intervalMs ? sample.intervalMs / 1000 : '');
  return cells.map(esc).join(',') + '\n';
}

function toCsv(instances, samples) {
  const cols = columns(instances);
  return headerLine(cols) + samples.map((s) => rowLine(cols, s)).join('');
}

class ContinuousLogger {
  constructor() { this.file = null; this.cols = null; }

  start(file, instances) {
    this.file = file;
    this.cols = columns(instances);
    const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
    if (!exists) fs.writeFileSync(file, headerLine(this.cols));
    else fs.appendFileSync(file, headerLine(this.cols)); // config may have changed: write a fresh header
  }

  stop() { this.file = null; this.cols = null; }

  write(sample) {
    if (!this.file) return;
    fs.appendFile(this.file, rowLine(this.cols, sample), () => {});
  }
}

module.exports = { toCsv, ContinuousLogger, columns, headerLine, rowLine, INTERVAL_HEADER };
