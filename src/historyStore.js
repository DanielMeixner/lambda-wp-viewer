'use strict';
// Stores five-minute averages and cached hourly history in a (OneDrive-synced) folder.
// Real device data:  <folder>/YYYY/YYYY-MM/YYYY-MM-DD/YYYY-MM-DD-HH/YYYY-MM-DD-HH-MM/YYYY-MM-DD-HH-MM-SS-mmm.json
// Simulated data:    <folder>/simulated/YYYY/... (kept apart so history is never polluted)
// Folder and file names use local time; the "timestamp" inside each file (UTC, ISO 8601) is authoritative.
// Daily CSV files written by older versions (lambda-wp-YYYY-MM-DD.csv) are still read as history.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { INTERVAL_HEADER } = require('./csv');
const { isEmptyRaw, isPlausible } = require('./registers');

const FILE_RE = /^lambda-wp-(\d{4})-(\d{2})-(\d{2})\.csv$/;
const JSON_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})\.json$/;
const FORMAT = 'lambda-wp-sample/1';
const SAVE_INTERVAL = 5 * 60000;
const HOUR = 3600000;

function aggregateSamples(samples, instances, intervalMs) {
  const last = samples[samples.length - 1];
  const values = {};
  const counts = {};
  for (const inst of instances) for (const dp of inst.datapoints) {
    const key = `${inst.id}.${dp.key}`;
    let sum = 0;
    let count = 0;
    let latest;
    for (const sample of samples) {
      const v = sample.values[key];
      if (!v || v.error || v.missing || !Number.isFinite(v.value) || !isPlausible(v.value, dp)) continue;
      const n = sample.counts?.[key] || 1;
      sum += v.value * n;
      count += n;
      latest = v;
    }
    if (!count) continue;
    // States and error codes are categorical, even when the PDF has no enum for them.
    const categorical = dp.enum || /error|state/i.test(dp.key);
    const value = categorical ? latest.value : sum / count;
    values[key] = { value, raw: categorical ? latest.raw : null, text: categorical ? latest.text : null };
    counts[key] = count;
  }
  return { ts: last.ts, source: last.source, intervalMs, values, counts,
    periodStart: samples[0].periodStart ?? samples[0].ts, periodEnd: last.periodEnd ?? last.ts };
}

function atomicJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

function jsonToSample(doc, instances) {
  const values = {};
  for (const inst of instances) for (const dp of inst.datapoints) {
    const key = `${inst.id}.${dp.key}`;
    const value = doc.values?.[key];
    if (!Number.isFinite(value) || !isPlausible(value, dp)) continue;
    values[key] = { value, raw: Math.round(value / (dp.scale || 1)), text: doc.text?.[key] ?? null, dp };
  }
  return { ts: Date.parse(doc.timestamp), source: doc.source, intervalMs: doc.pollIntervalSec * 1000,
    values: cleanValues(values), counts: doc.counts,
    periodStart: doc.periodStart == null ? undefined : Date.parse(doc.periodStart),
    periodEnd: doc.periodEnd == null ? undefined : Date.parse(doc.periodEnd), history: true };
}

const p2 = (n) => String(n).padStart(2, '0');

function dayStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// Local-time path parts: ['2026', '2026-10', '2026-10-19', '2026-10-19-09', '2026-10-19-09-07'] and file name.
function jsonParts(ts) {
  const d = new Date(ts);
  const y = String(d.getFullYear());
  const m = `${y}-${p2(d.getMonth() + 1)}`;
  const day = `${m}-${p2(d.getDate())}`;
  const h = `${day}-${p2(d.getHours())}`;
  const min = `${h}-${p2(d.getMinutes())}`;
  return { dirs: [y, m, day, h, min], file: `${min}-${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}.json` };
}

function jsonFileFor(folder, source, ts) {
  const { dirs, file } = jsonParts(ts);
  return path.join(dirFor(folder, source), ...dirs, file);
}

// One sample as a self-describing JSON document. Values that are missing or failed are left out.
function sampleToJson(sample, instances) {
  const values = {};
  const text = {};
  const units = {};
  const modules = {};
  for (const inst of instances || []) {
    for (const d of inst.datapoints) {
      const key = `${inst.id}.${d.key}`;
      const v = sample.values[key];
      if (!v || v.error || v.missing || v.value == null) continue;
      values[key] = v.value;
      if (d.enum && v.text != null) text[key] = v.text;
      if (d.unit) units[key] = d.unit;
      modules[inst.id] = inst.name;
    }
  }
  return {
    format: FORMAT,
    timestamp: new Date(sample.ts).toISOString(),
    source: sample.source === 'simulator' ? 'simulator' : 'device',
    pollIntervalSec: sample.intervalMs ? sample.intervalMs / 1000 : null,
    modules,
    values,
    text,
    units,
    ...(sample.counts ? {
      aggregation: sample.intervalMs === HOUR ? 'hourly-average' : '5-minute-average',
      counts: sample.counts,
      periodStart: new Date(sample.periodStart).toISOString(),
      periodEnd: new Date(sample.periodEnd).toISOString(),
    } : {}),
  };
}

// Maps worker over items with limited concurrency (many small files on a synced folder).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

const readdirSafe = (dir) => fsp.readdir(dir).catch(() => []);

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
    this.instances = null;
    this.lastSampleTs = null;
    this.lastError = null;
    this.lastFile = null;
    this.lastWrittenAt = null;
    this.rowsWritten = 0;
    this.pending = [];
    this.lastCollectedAt = null;
  }

  configure({ folder, enabled, instances }) {
    if (this.folder !== (folder || null) || this.enabled !== !!(folder && enabled)) {
      this.pending = [];
      this.lastCollectedAt = null;
    }
    this.folder = folder || null;
    this.enabled = !!(folder && enabled);
    this.instances = instances;
    this.lastError = null;
  }

  // Live polling and disk sampling are independent. Never flush a partial window on UI changes.
  collect(sample) {
    if (!this.enabled || !this.instances) return false;
    if (this.pending.length && this.pending[0].source !== sample.source) {
      this.pending = [];
      this.lastCollectedAt = null;
    }
    if (this.lastCollectedAt == null) this.lastCollectedAt = Math.floor(sample.ts / SAVE_INTERVAL) * SAVE_INTERVAL;
    if (sample.ts - this.lastCollectedAt < SAVE_INTERVAL || !this.pending.length) {
      this.pending.push(sample);
      return false;
    }
    const average = aggregateSamples(this.pending, this.instances, SAVE_INTERVAL);
    if (!this.write(average)) {
      this.pending = [average, sample];
      return false;
    }
    this.pending = [sample];
    this.lastCollectedAt = Math.floor(sample.ts / SAVE_INTERVAL) * SAVE_INTERVAL;
    try {
      this.refreshHour(jsonFileFor(this.folder, average.source, average.ts), this.instances);
    } catch (e) {
      this.lastError = `Sample saved, but hourly average failed: ${e.message}`;
    }
    return true;
  }

  refreshHour(file, instances, entries) {
    const hourDir = path.dirname(path.dirname(file));
    if (!entries) {
      entries = [];
      for (const minute of fs.readdirSync(hourDir, { withFileTypes: true })) {
        if (!minute.isDirectory()) continue;
        for (const name of fs.readdirSync(path.join(hourDir, minute.name))) {
          if (JSON_RE.test(name)) entries.push({ file: path.join(hourDir, minute.name, name) });
        }
      }
    }
    const fingerprint = entries.map((e) => path.relative(hourDir, e.file)).sort().join('\n');
    const cache = path.join(hourDir, 'hourly.json');
    try {
      const doc = JSON.parse(fs.readFileSync(cache, 'utf8'));
      const schema = instances.flatMap((inst) => inst.datapoints.map((dp) => `${inst.id}.${dp.key}`)).join(',');
      if (doc.fingerprint === fingerprint && doc.schema === schema) return { file: cache, ts: Date.parse(doc.timestamp) };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Cannot read hourly average ${cache}: ${e.message}`);
    }
    const samples = entries.map((e) => jsonToSample(JSON.parse(fs.readFileSync(e.file, 'utf8')), instances))
      .sort((a, b) => a.ts - b.ts);
    if (!samples.length) return null;
    const average = aggregateSamples(samples, instances, HOUR);
    const schema = instances.flatMap((inst) => inst.datapoints.map((dp) => `${inst.id}.${dp.key}`)).join(',');
    atomicJson(cache, { ...sampleToJson(average, instances), fingerprint, schema });
    return { file: cache, ts: average.ts };
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

  // Writes every sample (one poll) to a new JSON file. Returns true when the sample was written.
  write(sample) {
    if (!this.enabled || !this.instances) return false;
    const file = jsonFileFor(this.folder, sample.source, sample.ts);
    try {
      atomicJson(file, sampleToJson(sample, this.instances));
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

  // Lists stored JSON files between from..to (ms) without reading them: [{ file, ts }] sorted by time.
  // Only the folders of the requested days are visited.
  async listJson(dir, from, to) {
    const days = [];
    for (let d = new Date(new Date(from).setHours(0, 0, 0, 0)); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
      days.push(jsonParts(d.getTime()).dirs.slice(0, 3));
    }
    const lists = await mapLimit(days, 4, async (parts) => {
      const dayDir = path.join(dir, ...parts);
      const out = [];
      for (const h of (await readdirSafe(dayDir)).sort()) {
        const mins = (await readdirSafe(path.join(dayDir, h))).sort();
        const files = await mapLimit(mins, 16, (m) => readdirSafe(path.join(dayDir, h, m)));
        mins.forEach((m, k) => {
          for (const f of files[k].sort()) {
            const x = JSON_RE.exec(f);
            if (!x) continue;
            const ts = new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5], +x[6], +x[7]).getTime();
            // Names are local time; allow an hour of slack around DST changes, the file content decides.
            if (ts >= from - 3600000 && ts <= to + 3600000) out.push({ file: path.join(dayDir, h, m, f), ts });
          }
        });
      }
      return out;
    });
    return lists.flat().sort((a, b) => a.ts - b.ts);
  }

  // Daily CSV files written by older versions.
  async loadCsv(dir, from, to, instances) {
    let names;
    try { names = await fsp.readdir(dir); } catch { return { samples: [], files: [] }; }
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
        const sample = { ts, source: row[1] === 'SIMULATED' ? 'simulator' : 'device', values: cleanValues(values), history: true };
        const iv = ivCol > 0 ? Number(row[ivCol]) * 1000 : NaN;
        if (iv > 0) sample.intervalMs = iv;
        out.push(sample);
      }
    }
    return { samples: out, files };
  }

  // Reads stored samples between from..to (ms) from the JSON files and legacy CSV files. Values are
  // matched against the current module configuration; unknown ones (e.g. removed modules) are ignored.
  async load({ from, to = Date.now(), source = 'device', instances, maxSamples = 20000, hourly = false }) {
    if (!this.folder) return { samples: [], files: [] };
    const dir = dirFor(this.folder, source);
    try { await fsp.access(dir); } catch (e) { throw new Error(`Cannot read folder: ${e.message}`); }
    const byKey = new Map();
    for (const inst of instances) for (const d of inst.datapoints) byKey.set(`${inst.id}.${d.key}`, d);

    const csv = await this.loadCsv(dir, from, to, instances);
    if (hourly && csv.samples.length) {
      const groups = new Map();
      for (const sample of csv.samples) {
        const hour = Math.floor(sample.ts / HOUR);
        if (!groups.has(hour)) groups.set(hour, []);
        groups.get(hour).push(sample);
      }
      csv.samples = [...groups.values()].map((group) => ({
        ...aggregateSamples(group.sort((a, b) => a.ts - b.ts), instances, HOUR), history: true,
      }));
    }
    let entries = await this.listJson(dir, from, to);
    const jsonCount = entries.length;
    if (hourly) {
      // Include complete hours in each average, not only files on the range boundary.
      const start = new Date(from); start.setMinutes(0, 0, 0);
      const end = new Date(to); end.setMinutes(59, 59, 999);
      const all = await this.listJson(dir, start.getTime(), end.getTime());
      const groups = new Map();
      for (const entry of all) {
        const hourDir = path.dirname(path.dirname(entry.file));
        if (!groups.has(hourDir)) groups.set(hourDir, []);
        groups.get(hourDir).push(entry);
      }
      entries = [];
      for (const group of groups.values()) {
        await new Promise((resolve) => setImmediate(resolve));
        // Don't let a boundary-hour average include data outside the requested range.
        const selected = group.filter((e) => e.ts >= from && e.ts <= to);
        if (!selected.length) continue;
        if (selected.length !== group.length) entries.push(...selected);
        else {
          const entry = this.refreshHour(group[0].file, instances, group);
          if (entry) entries.push(entry);
        }
      }
      entries.sort((a, b) => a.ts - b.ts);
    }
    // Too many files for the chart limit: read an evenly spaced subset instead of every file.
    const total = entries.length + csv.samples.length;
    let jsonStep = 1;
    if (total > maxSamples && entries.length) {
      const keep = Math.max(Math.min(entries.length, 2), Math.round((maxSamples * entries.length) / total));
      jsonStep = entries.length / keep;
      const picked = [];
      for (let i = 0; i < keep; i++) picked.push(entries[Math.floor(i * jsonStep)]);
      picked[picked.length - 1] = entries[entries.length - 1];
      entries = picked;
    }
    const json = (await mapLimit(entries, 32, async ({ file }) => {
      try {
        const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
        const ts = Date.parse(doc.timestamp);
        if (!Number.isFinite(ts) || ts < from || ts > to) return null;
        const values = {};
        for (const [key, num] of Object.entries(doc.values || {})) {
          const dp = byKey.get(key);
          if (!dp || typeof num !== 'number' || !Number.isFinite(num)) continue;
          values[key] = { raw: Math.round(num / (dp.scale || 1)), value: num, text: doc.text?.[key] ?? null, dp };
        }
        const sample = { ts, source: doc.source === 'simulator' ? 'simulator' : 'device', values: cleanValues(values), history: true };
        if (doc.pollIntervalSec > 0) sample.intervalMs = doc.pollIntervalSec * 1000 * jsonStep;
        return sample;
      } catch {
        return null; // unreadable / partially synced file
      }
    })).filter(Boolean);

    const out = [...csv.samples, ...json].sort((a, b) => a.ts - b.ts);
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
    return { samples, files: [...csv.files, ...(jsonCount ? [`${jsonCount} JSON files`] : [])], jsonFiles: jsonCount, csvFiles: csv.files.length, totalRows: csv.samples.length + jsonCount };
  }
}

// Drops "empty" register values (e.g. -3276.8 °C written by older versions) and implausible readings,
// and fills in enum texts.
function cleanValues(values) {
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (v.value == null || (v.dp.type !== 'EMGR' && isEmptyRaw(v.raw, v.dp.type)) || !isPlausible(v.value, v.dp)) { delete values[k]; continue; }
    if (v.dp.enum && v.text == null) v.text = v.dp.enum[v.raw] ?? `Unknown (${v.raw})`;
    delete v.dp;
  }
  return values;
}

module.exports = { HistoryStore, parseCsv, oneDriveRoots, folderInfo, dayStamp, fileFor, jsonFileFor, sampleToJson };
