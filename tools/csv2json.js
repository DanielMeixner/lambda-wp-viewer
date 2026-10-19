#!/usr/bin/env node
// Converts the daily CSV files written by versions before 1.0.2 (lambda-wp-YYYY-MM-DD.csv) into one JSON
// file per row in the current folder hierarchy. Converted CSV files are moved to <folder>/converted-csv/
// so they are not loaded twice. Existing JSON files are never overwritten.
//
//   node tools/csv2json.js <data folder> [--dry-run]
const fs = require('fs');
const path = require('path');
const { HistoryStore, jsonFileFor, sampleToJson } = require('../src/historyStore');
const { buildInstances, MODULE_TYPES } = require('../src/registers');

const FILE_RE = /^lambda-wp-(\d{4})-(\d{2})-(\d{2})\.csv$/;

async function convertFolder(folder, { dryRun = false, log = console.log } = {}) {
  // Every possible module slot, so columns of any former module configuration are converted.
  const modules = Object.fromEntries(MODULE_TYPES.map((t) => [t.id, t.max]));
  const instances = buildInstances({ modules });
  const store = new HistoryStore();
  const totals = { csvFiles: 0, rows: 0, written: 0, skipped: 0 };

  for (const sub of ['', 'simulated']) {
    const dir = path.join(folder, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort()) {
      const [, y, m, d] = FILE_RE.exec(name);
      // Files are named by the local day of their rows, so this range reads exactly this one file.
      const from = new Date(+y, +m - 1, +d).getTime();
      const to = new Date(+y, +m - 1, +d + 1).getTime() - 1;
      const { samples: ownRows, files } = await store.loadCsv(dir, from, to, instances);
      if (files.length !== 1 || files[0] !== name) throw new Error(`unexpected files for ${name}: ${files}`);
      let written = 0;
      let skipped = 0;
      for (const s of ownRows) {
        const file = jsonFileFor(folder, s.source, s.ts);
        if (fs.existsSync(file)) { skipped++; continue; }
        if (!dryRun) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(`${file}.tmp`, JSON.stringify(sampleToJson(s, instances)));
          fs.renameSync(`${file}.tmp`, file);
        }
        written++;
      }
      if (!dryRun) {
        const archive = path.join(dir, 'converted-csv');
        fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(path.join(dir, name), path.join(archive, name));
      }
      log(`${path.join(sub, name)}: ${ownRows.length} rows → ${written} JSON files${skipped ? ` (${skipped} already existed)` : ''}`);
      totals.csvFiles++; totals.rows += ownRows.length; totals.written += written; totals.skipped += skipped;
    }
  }
  return totals;
}

module.exports = { convertFolder };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) { console.error('usage: node tools/csv2json.js <data folder> [--dry-run]'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  convertFolder(folder, { dryRun }).then((t) => {
    console.log(`${dryRun ? '[dry run] ' : ''}${t.csvFiles} CSV files, ${t.rows} rows, ${t.written} JSON files written, ${t.skipped} skipped`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
