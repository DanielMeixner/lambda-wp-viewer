'use strict';
// Stores samples as daily CSV files in a (OneDrive-synced) folder and reads them back as history.
// Real device data:  <folder>/lambda-wp-YYYY-MM-DD.csv
// Simulated data:    <folder>/simulated/lambda-wp-YYYY-MM-DD.csv (kept apart so history is never polluted)
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { columns, headerLine, rowLine, INTERVAL_HEADER } = require('./csv');
const { isEmptyRaw } = require('./registers');

const FILE_RE = /^lambda-wp-(\d{4})-(\d{2})-(\d{2})\.csv$/;

function dayStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dirFor(folder, source) {
  return source === 'simulator' ? path.join(folder, 'simulated') : folder;
}

function fileFor(folder, source, ts) {
  return path.join(dirFor(folder, source), `lambda-wp-${dayStamp(ts)}.csv`);
}

// RFC 4180-ish parser; yields one array of cells per record.
function* parseCsv(text) {
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') yield row;
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); yield row; }
}

// Known OneDrive locations (macOS CloudStorage, Windows env vars, legacy home folder).
function oneDriveRoots() {
  const roots = [];
  const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
  try {
    for (const n of fs.readdirSync(cloud)) {
      if (/^OneDrive/i.test(n)) roots.push({ name: n.replace(/^OneDrive-?/, 'OneDrive ').trim(), path: path.join(cloud, n) });
    }
  } catch { /* not macOS or no OneDrive */ }
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[k] && !roots.some((r) => r.path === process.env[k])) roots.push({ name: k, path: process.env[k] });
  }
  try {
    for (const n of fs.readdirSync(os.homedir())) {
      const p = path.join(os.homedir(), n);
      if (/^OneDrive/i.test(n) && !roots.some((r) => r.path === p)) roots.push({ name: n, path: p });
    }
  } catch { /* ignore */ }
  return roots;
}

function folderInfo(folder) {
  if (!folder) return { folder: null, exists: false, oneDrive: null };
  let exists = false;
  let writable = false;
  try { exists = fs.statSync(folder).isDirectory(); } catch { /* missing */ }
  if (exists) {
    try { fs.accessSync(folder, fs.constants.W_OK); writable = true; } catch { /* read-only */ }
  }
  const real = (() => { try { return fs.realpathSync(folder); } catch { return folder; } })();
  const root = oneDriveRoots().find((r) => real === r.path || real.startsWith(r.path + path.sep)
    || folder === r.path || folder.startsWith(r.path + path.sep));
  return { folder, exists, writable, oneDrive: root ? root.name : null };
}

class HistoryStore {
  constructor() {
    this.folder = null;
    this.enabled = false;
    this.cols = null;
    this.headerKey = null;
    this.checkedFiles = new Map(); // file -> header line known to be current at its end
    this.lastSampleTs = null;
    this.lastError = null;
    this.lastFile = null;
    this.lastWrittenAt = null;
    this.rowsWritten = 0;
  }

  configure({ folder, enabled, instances }) {
    this.folder = folder || null;
    this.enabled = !!(folder && enabled);
    this.cols = columns(instances);
    const hl = headerLine(this.cols);
    if (hl !== this.headerKey) { this.headerKey = hl; this.checkedFiles.clear(); }
    this.lastError = null;
  }

  status() {
    return {
      ...folderInfo(this.folder),
      enabled: this.enabled,
      lastFile: this.lastFile,
      lastWrittenAt: this.lastWrittenAt,
      lastSampleTs: this.lastSampleTs,
      lastSource: this.lastSource,
      rowsWritten: this.rowsWritten,
      error: this.lastError,
    };
  }

  // Appends every sample (one row per poll). Returns true when the sample was written.
  write(sample) {
    if (!this.enabled || !this.cols) return false;
    const file = fileFor(this.folder, sample.source, sample.ts);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (this.checkedFiles.get(file) !== this.headerKey) {
        // Append a header if the file is new or its last header differs (module configuration changed).
        let last = null;
        try {
          const text = fs.readFileSync(file, 'utf8');
          const idx = text.lastIndexOf('\ntimestamp,');
          last = text.startsWith('timestamp,') && idx < 0 ? text.slice(0, text.indexOf('\n') + 1)
            : idx >= 0 ? text.slice(idx + 1, text.indexOf('\n', idx + 1) + 1) : null;
        } catch { /* new file */ }
        if (last !== this.headerKey) fs.appendFileSync(file, this.headerKey);
        this.checkedFiles.set(file, this.headerKey);
      }
      fs.appendFileSync(file, rowLine(this.cols, sample));
      this.lastSampleTs = sample.ts;
      this.lastSource = sample.source;
      this.lastFile = file;
      this.lastWrittenAt = Date.now();
      this.rowsWritten++;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e.message;
      return false;
    }
  }

  // Reads stored samples between from..to (ms). Columns are matched by header against the current
  // module configuration; unknown columns (e.g. removed modules) are ignored.
  async load({ from, to = Date.now(), source = 'device', instances, maxSamples = 20000 }) {
    if (!this.folder) return { samples: [], files: [] };
    const dir = dirFor(this.folder, source);
    let names;
    try { names = await fsp.readdir(dir); } catch (e) { throw new Error(`Cannot read folder: ${e.message}`); }
    const fromDay = dayStamp(from);
    const toDay = dayStamp(to);
    const files = names.filter((n) => {
      const m = FILE_RE.exec(n);
      if (!m) return false;
      const d = `${m[1]}-${m[2]}-${m[3]}`;
      return d >= fromDay && d <= toDay;
    }).sort();

    const byHeader = new Map();
    for (const inst of instances) {
      for (const d of inst.datapoints) {
        const unit = d.unit ? ` [${d.unit}]` : '';
        byHeader.set(`${inst.name} - ${d.name}${unit}`, { key: `${inst.id}.${d.key}`, dp: d, kind: 'value' });
        if (d.enum) byHeader.set(`${inst.name} - ${d.name} (text)`, { key: `${inst.id}.${d.key}`, dp: d, kind: 'text' });
      }
    }

    const out = [];
    for (const name of files) {
      const text = await fsp.readFile(path.join(dir, name), 'utf8');
      let map = null;
      let ivCol = -1;
      for (const row of parseCsv(text)) {
        if (row[0] === 'timestamp') { map = row.map((h) => byHeader.get(h) || null); ivCol = row.indexOf(INTERVAL_HEADER); continue; }
        if (!map) continue;
        const ts = Date.parse(row[0]);
        if (!Number.isFinite(ts) || ts < from || ts > to) continue;
        const values = {};
        for (let i = 2; i < row.length; i++) {
          const c = map[i];
          if (!c || row[i] === '') continue;
          const v = values[c.key] || (values[c.key] = { raw: null, value: null, text: null, dp: c.dp });
          if (c.kind === 'text') v.text = row[i];
          else {
            const num = Number(row[i]);
            if (!Number.isFinite(num)) continue;
            v.value = num;
            v.raw = Math.round(num / (c.dp.scale || 1));
          }
        }
        for (const k of Object.keys(values)) {
          const v = values[k];
          // Also drops "empty" register values (e.g. -3276.8 °C) written by older versions.
          if (v.value == null || (v.dp.type !== 'EMGR' && isEmptyRaw(v.raw, v.dp.type))) { delete values[k]; continue; }
          if (v.dp.enum && v.text == null) v.text = v.dp.enum[v.raw] ?? `Unknown (${v.raw})`;
          delete v.dp;
        }
        const sample = { ts, source: row[1] === 'SIMULATED' ? 'simulator' : 'device', values, history: true };
        const iv = ivCol > 0 ? Number(row[ivCol]) * 1000 : NaN;
        if (iv > 0) sample.intervalMs = iv;
        out.push(sample);
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    // Evenly thin out to the session sample limit so charts stay fast.
    let samples = out;
    if (out.length > maxSamples) {
      const step = out.length / maxSamples;
      samples = [];
      // Each kept row stands for `step` rows, so it is expected `step` intervals after the previous one.
      for (let i = 0; i < maxSamples; i++) {
        const s = out[Math.floor(i * step)];
        samples.push(s.intervalMs ? { ...s, intervalMs: Math.round(s.intervalMs * step) } : s);
      }
      samples[samples.length - 1] = out[out.length - 1];
    }
    return { samples, files, totalRows: out.length };
  }
}

module.exports = { HistoryStore, parseCsv, oneDriveRoots, folderInfo, dayStamp, fileFor };
