'use strict';
// Headless self-test: starts the simulator and polls it with the app's ModbusService (no Electron needed).
const assert = require('assert');
const { address, blocks, decode, buildInstances, MODULE_TYPES } = require('../src/registers');
const { ModbusService } = require('../src/modbusService');
const { toCsv } = require('../src/csv');

assert.strictEqual(address(1, 1, 4), 1104, 'PDF example: HP 2 flow temperature = 1104');
assert.deepStrictEqual(blocks([0, 1, 2, 50, 51]), [{ start: 0, count: 3 }, { start: 50, count: 2 }]);
assert.strictEqual(decode(0xffff, { type: 'INT16', scale: 0.1 }).value, -0.1);
assert.strictEqual(decode(0xffff, { type: 'EMGR', scale: 1 }, { emanagerSigned: false }).value, 65535);
assert.strictEqual(decode(0xffff, { type: 'EMGR', scale: 1 }, { emanagerSigned: true }).value, -1);
// Empty register contents are "no value", never a measurement.
assert.ok(decode(0x8000, { type: 'INT16', scale: 0.1 }).missing);
assert.strictEqual(decode(0x8000, { type: 'INT16', scale: 0.1 }).value, null);
// Implausible readings (e.g. -300 °C from a broken sensor) are hidden, plausible ones kept.
{
  const t = { key: 'tFlow', type: 'INT16', scale: 0.1, unit: '°C' };
  const bad = decode((-3000) & 0xffff, t);
  assert.ok(bad.missing && bad.value === null && bad.implausible === -300);
  assert.strictEqual(decode(455, t).value, 45.5);
  assert.strictEqual(decode(2000, { ...t, key: 'tCollector' }).value, 200);
  assert.strictEqual(decode(15000, { key: 'compressor', type: 'UINT16', scale: 0.01, unit: '%' }).value, null);
  assert.strictEqual(decode(5000, { key: 'state', type: 'UINT16', scale: 1, unit: '', enum: {} }).implausible, undefined);
}
assert.ok(decode(0x7fff, { type: 'INT16', scale: 0.01 }).missing);
assert.ok(decode(0xffff, { type: 'UINT16', scale: 1, enum: { 1: 'X' } }).missing);
assert.ok(!decode(0xfffe, { type: 'INT16', scale: 0.1 }).missing);
assert.strictEqual(decode(0, { type: 'INT16', scale: 0.1 }).value, 0);
assert.strictEqual(decode(10, { type: 'UINT16', scale: 1, enum: { 10: 'DEFROSTING' } }).text, 'DEFROSTING');

// Autostart registration (written to a temp folder, never to the real login items).
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Autostart, BACKGROUND_ARG } = require('../src/autostart');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwp-autostart-'));
  const mac = new Autostart({ execPath: '/Apps/Electron & Co/electron', appPath: '/src/<app>', platform: 'darwin', dir });
  assert.ok(mac.supported && !mac.isEnabled());
  assert.strictEqual(mac.set(true), true);
  const plist = fs.readFileSync(mac.file, 'utf8');
  assert.ok(plist.includes('<string>/Apps/Electron &amp; Co/electron</string>'));
  assert.ok(plist.includes('<string>/src/&lt;app&gt;</string>'));
  assert.ok(plist.includes(`<string>${BACKGROUND_ARG}</string>`) && plist.includes('<key>RunAtLoad</key>'));
  assert.ok(mac.isEnabled());
  assert.strictEqual(mac.set(false), false);
  assert.ok(!fs.existsSync(mac.file) && !mac.isEnabled());
  const linux = new Autostart({ execPath: '/opt/lwp/lwp', platform: 'linux', dir });
  linux.set(true);
  assert.ok(fs.readFileSync(linux.file, 'utf8').includes('Exec="/opt/lwp/lwp" "--background"'));
  let win = null;
  const fakeApp = { setLoginItemSettings: (o) => { win = o; }, getLoginItemSettings: () => ({ openAtLogin: !!win?.openAtLogin }) };
  const w = new Autostart({ execPath: 'C:\\electron.exe', appPath: 'C:\\app', platform: 'win32', loginItems: fakeApp });
  assert.strictEqual(w.set(true), true);
  assert.deepStrictEqual(win.args, ['C:\\app', BACKGROUND_ARG]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('autostart: macOS LaunchAgent, Linux .desktop and Windows login item OK');
}

const all = Object.fromEntries(MODULE_TYPES.map((t) => [t.id, t.max]));
const total = buildInstances({ modules: all }).reduce((n, i) => n + i.datapoints.length, 0);
console.log(`register map: ${MODULE_TYPES.length} module types, ${total} datapoints when fully populated`);

process.env.SIM_PORT = '5021';
process.env.SIM_MODULES = 'all';
const server = require('./simulator');

server.on('initialized', async () => {
  const svc = new ModbusService();
  const config = { host: '127.0.0.1', port: 5021, unitId: 1, timeoutMs: 2000, pollIntervalMs: 1000, modules: { ...all, circuit: 10 } };
  svc.configure(config);
  // Add a bogus datapoint to verify single-register fallback for unreadable addresses
  svc.instances[0].datapoints.push({ number: 5, key: 'bogus', name: 'bogus', type: 'INT16', scale: 1, unit: '', address: 5 });
  try {
    const got = await new Promise((resolve, reject) => {
      svc.once('data', resolve);
      svc.pollOnce().catch(reject);
    });
    const v = got.values;
    const keys = Object.keys(v);
    const errs = keys.filter((k) => v[k].error);
    console.log(`polled ${keys.length} values, ${errs.length} errors (${errs.join(', ')})`);
    assert.deepStrictEqual(errs, ['ambient.bogus']);
    assert.strictEqual(got.source, 'simulator', 'simulator must be detected as fake data source');
    assert.strictEqual(svc.device.name, 'LAMBDA Simulator (fake data)');
    assert.strictEqual(svc.device.version, '1.0');
    console.log('device:', JSON.stringify(svc.device));
    assert.strictEqual(v['heatpump1.hpState'].text, 'REGULATION');
    assert.ok(v['heatpump1.tFlow'].value > 30 && v['heatpump1.tFlow'].value < 40, 'flow temp scaled 0.01');
    assert.strictEqual(v['circuit1.mode'].text, 'AUTOMATIK');
    assert.strictEqual(v['circuit1.offset'].value, -1, 'signed + scaled');
    const csv = toCsv(svc.instances, [got]);
    assert.ok(csv.split('\n')[0].startsWith('timestamp,source,Ambient - Error number'));
    assert.ok(csv.split('\n')[1].split(',')[1] === 'SIMULATED');
    assert.ok(csv.split('\n')[0].endsWith(',poll interval [s]'), 'rows record their poll interval');
    assert.strictEqual(got.intervalMs, 1000);
    assert.strictEqual(csv.split('\n')[1].split(',').pop(), '1');
    console.log('sample:', 'HP1 flow', v['heatpump1.tFlow'].value, '°C, COP', v['heatpump1.cop'].value, ', boiler1 high', v['boiler1.tHigh'].value, '°C');
    // Device discovery: simulator is recognised, a device without the marker is recognised as LAMBDA.
    const { Discovery, expandCidr } = require('../src/discovery');
    assert.strictEqual(expandCidr('192.168.178.0/24').length, 254);
    assert.deepStrictEqual(expandCidr('10.0.0.5'), ['10.0.0.5']);
    assert.throws(() => expandCidr('10.0.0.0/16'));
    const ModbusRTU = require('modbus-serial');
    const fakeHp = new ModbusRTU.ServerTCP({
      getHoldingRegister(a) { if (a >= 9000) throw { modbusErrorCode: 2 }; return { 1002: 7, 1003: 1, 1004: 3550, 2: 87 }[a] ?? 0; },
      setRegister() { throw { modbusErrorCode: 1 }; },
    }, { host: '127.0.0.1', port: 5025, unitID: 1 });
    await new Promise((r) => fakeHp.on('initialized', r));
    const found = [];
    for (const port of [5021, 5025]) {
      const disc = new Discovery();
      const res = await disc.run({ subnets: ['127.0.0.1'], includeLocalhost: false, port });
      found.push(res.results[0]);
    }
    console.log('discovery:', found.map((f) => `${f.host}:${f.port} ${f.kind} (${f.label})`).join(' | '));
    assert.strictEqual(found[0].kind, 'simulator');
    assert.strictEqual(found[1].kind, 'lambda');
    assert.strictEqual(found[1].details.flowTemp, 35.5);
    const none = await new Discovery().run({ subnets: ['127.0.0.1'], includeLocalhost: false, port: 5029 });
    assert.strictEqual(none.results.length, 0);
    // A device without FC 0x2B support still connects and gets a fallback name.
    const svc2 = new ModbusService();
    svc2.configure({ ...config, host: '127.0.0.1', port: 5025 });
    await svc2.connect();
    console.log('fake hp device:', JSON.stringify(svc2.device));
    assert.strictEqual(svc2.source, 'device');
    assert.ok(svc2.device.name);
    const { data: d2 } = await svc2.client.readHoldingRegisters(1004, 1);
    assert.strictEqual(d2[0], 3550, 'connection still usable after identification');
    svc2.stop();
    fakeHp.close(() => {});
    // History store: daily CSV files in a data folder, read back as history.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { HistoryStore, parseCsv } = require('../src/historyStore');
    assert.deepStrictEqual([...parseCsv('a,"b,""c"""\r\n1,2\n')], [['a', 'b,"c"'], ['1', '2']]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwp-hist-'));
    const hInst = buildInstances({ modules: { ambient: 1, heatpump: 1 } });
    const store = new HistoryStore();
    store.configure({ folder: dir, enabled: true, instances: hInst });
    const mk = (ts, flow, source = 'device') => ({ ts, source, values: {
      'heatpump1.tFlow': { raw: Math.round(flow * 100), value: flow, text: null },
      'heatpump1.hpState': { raw: 7, value: 7, text: 'REGULATION' },
      'ambient.actual': { raw: 55, value: 5.5, text: null },
    } });
    const t0 = new Date(2026, 0, 10, 23, 58, 5, 42).getTime();
    assert.ok(store.write({ ...mk(t0, 30), intervalMs: 300000 }));
    // Every save creates a new JSON file in YYYY/YYYY-MM/YYYY-MM-DD/YYYY-MM-DD-HH/YYYY-MM-DD-HH-MM/.
    const f0 = path.join(dir, '2026', '2026-01', '2026-01-10', '2026-01-10-23', '2026-01-10-23-58', '2026-01-10-23-58-05-042.json');
    assert.strictEqual(store.status().lastFile, f0);
    const doc = JSON.parse(fs.readFileSync(f0, 'utf8'));
    assert.strictEqual(doc.timestamp, new Date(t0).toISOString());
    assert.strictEqual(doc.source, 'device');
    assert.strictEqual(doc.pollIntervalSec, 300);
    assert.deepStrictEqual(doc.values, { 'heatpump1.tFlow': 30, 'heatpump1.hpState': 7, 'ambient.actual': 5.5 });
    assert.deepStrictEqual(doc.text, { 'heatpump1.hpState': 'REGULATION' });
    assert.strictEqual(doc.units['heatpump1.tFlow'], '°C');
    assert.strictEqual(doc.modules.heatpump1, store.instances.find((x) => x.id === 'heatpump1').name);
    assert.ok(store.write(mk(t0 + 10000, 31)), 'every query is saved');
    assert.strictEqual(store.status().rowsWritten, 2);
    assert.strictEqual(store.status().lastSampleTs, t0 + 10000);
    assert.ok(store.write(mk(t0 + 60000, 32)));
    assert.ok(store.write(mk(t0 + 180000, 33)), 'next day goes to a new day folder');
    assert.ok(fs.existsSync(path.join(dir, '2026', '2026-01', '2026-01-11', '2026-01-11-00', '2026-01-11-00-01')));
    assert.ok(store.write(mk(t0 + 300000, 99, 'simulator')));
    assert.ok(fs.existsSync(path.join(dir, 'simulated', '2026', '2026-01', '2026-01-11')));
    // Daily CSV files from older versions are still read as history.
    const { columns, headerLine, rowLine } = require('../src/csv');
    const cols = columns(hInst);
    fs.writeFileSync(path.join(dir, 'lambda-wp-2026-01-11.csv'), headerLine(cols) + '\n' + rowLine(cols, mk(t0 + 240000, 34)) + '\n');
    assert.ok(!fs.readdirSync(path.join(dir, '2026', '2026-01', '2026-01-10', '2026-01-10-23', '2026-01-10-23-58')).some((f) => f.endsWith('.tmp')));
    const h = await store.load({ from: t0 - 3600000, to: t0 + 3600000, instances: hInst });
    console.log(`history: ${h.samples.length} samples (${h.jsonFiles} JSON files, ${h.csvFiles} CSV files)`);
    assert.deepStrictEqual(h.samples.map((x) => x.values['heatpump1.tFlow'].value), [30, 31, 32, 33, 34]);
    assert.strictEqual(h.samples[0].values['heatpump1.hpState'].text, 'REGULATION');
    assert.strictEqual(h.samples[4].values['heatpump1.hpState'].text, 'REGULATION');
    assert.strictEqual(h.samples[0].values['heatpump1.tFlow'].raw, 3000);
    assert.ok(h.samples.every((x) => x.source === 'device' && x.history));
    assert.strictEqual(h.samples[0].intervalMs, 300000, 'background interval is read back');
    assert.strictEqual(h.samples[1].intervalMs, undefined);
    // Missing values are not stored; implausible stored values (-327.68 °C) never come back as values.
    assert.ok(store.write(mk(t0 + 250000, -327.68)));
    const miss = mk(t0 + 260000, 0);
    miss.values['heatpump1.tFlow'] = { raw: -32768, value: null, text: null, missing: true };
    assert.ok(store.write(miss));
    assert.ok(!('heatpump1.tFlow' in JSON.parse(fs.readFileSync(store.status().lastFile, 'utf8')).values));
    // A broken / half-synced file is skipped.
    fs.writeFileSync(path.join(path.dirname(store.status().lastFile), '2026-01-11-00-02-00-000.json'), '{"times');
    const h2 = await store.load({ from: t0 + 245000, to: t0 + 3600000, instances: hInst });
    assert.strictEqual(h2.samples.length, 2);
    assert.ok(h2.samples.every((x) => !('heatpump1.tFlow' in x.values) && x.values['ambient.actual'].value === 5.5));
    const thin = await store.load({ from: 0, to: t0 + 3600000, instances: hInst, maxSamples: 2 });
    assert.strictEqual(thin.samples.length, 2);
    assert.strictEqual(thin.samples[1].ts, t0 + 260000, 'thinning keeps the newest sample');
    const sim = await store.load({ from: t0 - 3600000, to: t0 + 3600000, source: 'simulator', instances: hInst });
    assert.deepStrictEqual(sim.samples.map((x) => x.values['heatpump1.tFlow'].value), [99]);
    // Converting legacy CSV files: one JSON file per row, CSV moved to converted-csv/, no duplicates.
    {
      const { convertFolder } = require('./csv2json');
      const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwp-conv-'));
      fs.writeFileSync(path.join(cdir, 'lambda-wp-2026-01-11.csv'), headerLine(cols) + '\n' + rowLine(cols, mk(t0 + 240000, 34)) + '\n' + rowLine(cols, mk(t0 + 250000, 35)) + '\n');
      const tot = await convertFolder(cdir, { log: () => {} });
      assert.deepStrictEqual([tot.rows, tot.written], [2, 2]);
      assert.deepStrictEqual(fs.readdirSync(path.join(cdir, 'converted-csv')), ['lambda-wp-2026-01-11.csv']);
      const conv = await store.load.call(Object.assign(new HistoryStore(), { folder: cdir }), { from: 0, to: t0 + 3600000, instances: hInst });
      assert.deepStrictEqual(conv.samples.map((x) => x.values['heatpump1.tFlow'].value), [34, 35]);
      assert.strictEqual(conv.samples[0].values['heatpump1.hpState'].text, 'REGULATION');
      assert.deepStrictEqual([conv.jsonFiles, conv.csvFiles], [2, 0]);
      fs.rmSync(cdir, { recursive: true, force: true });
      console.log('csv2json: legacy CSV converted to JSON files OK');
    }
    fs.rmSync(dir, { recursive: true, force: true });

    // Foreground polling stays fast; disk samples average complete five-minute buckets.
    {
      const sampledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwp-sampling-'));
      const sampled = new HistoryStore();
      sampled.configure({ folder: sampledDir, enabled: true, instances: hInst });
      const start = new Date(2026, 0, 12, 10).getTime();
      for (let i = 0; i < 60; i++) {
        const sample = mk(start + i * 5000, i < 30 ? 20 : 40);
        if (i % 2) delete sample.values['ambient.actual'];
        sample.values['heatpump1.hpState'] = { raw: i < 59 ? 0 : 7, value: i < 59 ? 0 : 7, text: i < 59 ? 'OFF' : 'REGULATION' };
        assert.strictEqual(sampled.collect(sample), false, 'no file for individual five-second readings');
      }
      assert.strictEqual(sampled.status().rowsWritten, 0);
      assert.strictEqual(fs.readdirSync(sampledDir).length, 0);
      assert.strictEqual(sampled.collect(mk(start + 300000, 40)), true);
      assert.strictEqual(sampled.status().rowsWritten, 1);
      const five = JSON.parse(fs.readFileSync(sampled.status().lastFile, 'utf8'));
      assert.strictEqual(five.aggregation, '5-minute-average');
      assert.strictEqual(five.values['heatpump1.tFlow'], 30);
      assert.strictEqual(five.counts['heatpump1.tFlow'], 60);
      assert.strictEqual(five.counts['ambient.actual'], 30, 'missing readings do not count as zero');
      assert.strictEqual(five.values['heatpump1.hpState'], 7, 'states retain their latest value');
      assert.strictEqual(five.pollIntervalSec, 300, 'chart spacing is independent of the live poll rate');
      assert.strictEqual(five.periodStart, new Date(start).toISOString());
      assert.strictEqual(five.periodEnd, new Date(start + 295000).toISOString());
      // Half as many observations in the next window: hourly weighting must use per-key counts.
      for (let i = 1; i < 30; i++) sampled.collect(mk(start + 300000 + i * 10000, 40));
      assert.strictEqual(sampled.collect(mk(start + 600000, 50)), true);
      const hourFile = path.join(path.dirname(path.dirname(sampled.status().lastFile)), 'hourly.json');
      const hour = JSON.parse(fs.readFileSync(hourFile, 'utf8'));
      assert.strictEqual(hour.aggregation, 'hourly-average');
      assert.strictEqual(hour.pollIntervalSec, 3600);
      assert.strictEqual(hour.counts['heatpump1.tFlow'], 90);
      assert.ok(Math.abs(hour.values['heatpump1.tFlow'] - 100 / 3) < 1e-10);
      assert.strictEqual(hour.counts['ambient.actual'], 60);
      const raw = await sampled.load({ from: start, to: start + 3600000, instances: hInst });
      assert.strictEqual(raw.samples.length, 2);
      const compact = await sampled.load({ from: start, to: start + 3600000, instances: hInst, hourly: true });
      assert.strictEqual(compact.samples.length, 1, 'history uses the hourly summary instead of its component files');
      assert.ok(Math.abs(compact.samples[0].values['heatpump1.tFlow'].value - 100 / 3) < 1e-10);
      const mtime = fs.statSync(hourFile).mtimeMs;
      const restarted = new HistoryStore();
      restarted.configure({ folder: sampledDir, enabled: true, instances: hInst });
      await restarted.load({ from: start, to: start + 3600000, instances: hInst, hourly: true });
      assert.strictEqual(fs.statSync(hourFile).mtimeMs, mtime, 'restart reuses cached hourly data');
      const boundary = await restarted.load({ from: start + 300000, to: start + 3600000, instances: hInst, hourly: true });
      assert.strictEqual(boundary.samples.length, 1);
      assert.strictEqual(boundary.samples[0].values['heatpump1.tFlow'].value, 40, 'range boundary excludes earlier readings');
      restarted.collect(mk(start + 3600000, 60));
      assert.ok(restarted.collect(mk(start + 3900000, 80)), 'background five-minute polling also saves');
      const acrossHours = await restarted.load({ from: start, to: start + 7200000, instances: hInst, hourly: true });
      assert.strictEqual(acrossHours.samples.length, 2);
      assert.strictEqual(acrossHours.samples[1].values['heatpump1.tFlow'].value, 60);
      // Historical files from old releases acquire summaries without deleting or rewriting originals.
      const legacySample = mk(start - 3600000, 25);
      assert.ok(restarted.write(legacySample));
      const legacyFile = restarted.status().lastFile;
      const old = fs.readFileSync(legacyFile, 'utf8');
      const legacy = await restarted.load({ from: start - 3600000, to: start, instances: hInst, hourly: true });
      assert.strictEqual(legacy.samples.length, 1);
      assert.strictEqual(fs.readFileSync(legacyFile, 'utf8'), old);
      assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(legacyFile)), 'hourly.json')));
      const cadenceDir = path.join(sampledDir, 'cadence');
      const cadence = new HistoryStore();
      cadence.configure({ folder: cadenceDir, enabled: true, instances: hInst });
      for (let i = 0; i <= 720; i++) cadence.collect(mk(start + i * 5000, 20 + i % 60));
      assert.strictEqual(cadence.status().rowsWritten, 12, '720 five-second polls produce exactly 12 five-minute files');
      const cadenceRaw = await cadence.load({ from: start, to: start + 3600000, instances: hInst });
      assert.strictEqual(cadenceRaw.samples.length, 12);
      const cadenceHourly = await cadence.load({ from: start, to: start + 3600000, instances: hInst, hourly: true });
      assert.strictEqual(cadenceHourly.samples.length, 1);
      assert.strictEqual(cadenceHourly.samples[0].values['heatpump1.tFlow'].value, 49.5);
      const cadenceHour = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(cadence.status().lastFile)), 'hourly.json'), 'utf8'));
      assert.strictEqual(cadenceHour.counts['heatpump1.tFlow'], 720);
      // Missing and failed sensors must not create made-up averages, and device/simulator windows stay separate.
      const missing = mk(start + 7200000, -300);
      delete missing.values['ambient.actual'];
      missing.values['heatpump1.hpState'] = { error: 'read failed' };
      cadence.collect(missing);
      cadence.collect({ ...missing, ts: start + 7500000 });
      const missingDoc = JSON.parse(fs.readFileSync(cadence.status().lastFile, 'utf8'));
      assert.deepStrictEqual(missingDoc.values, {});
      const written = cadence.status().rowsWritten;
      cadence.collect(mk(start + 7505000, 99, 'simulator'));
      assert.strictEqual(cadence.status().rowsWritten, written);
      cadence.collect(mk(start + 7800000, 99, 'simulator'));
      assert.strictEqual(cadence.status().lastSource, 'simulator');
      assert.ok(cadence.status().lastFile.includes(`${path.sep}simulated${path.sep}`));
      fs.rmSync(sampledDir, { recursive: true, force: true });
      console.log('history sampling: five-minute averages, weighted hourly summaries, cached loading and restart OK');
    }

    // Background polling: long intervals close the connection after each poll (the device drops idle
    // connections after 1 min) without reporting "disconnected"; switching back to a short interval polls at once.
    {
      const bg = new ModbusService();
      bg.configure({ ...config, pollIntervalMs: 1000 });
      bg.setPollInterval(300000);
      const statuses = [];
      bg.on('status', (st) => statuses.push(st.connected));
      const first = new Promise((r) => bg.once('data', r));
      bg.start();
      assert.strictEqual((await first).intervalMs, 300000);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(bg.connected && !bg.client, 'connection closed between background polls but still "connected"');
      const t = Date.now();
      const next = new Promise((r) => bg.once('data', r));
      bg.setPollInterval(1000); // window opened
      const s2 = await next;
      assert.ok(Date.now() - t < 1500 && s2.intervalMs === 1000, 'polls right away after switching to the UI interval');
      assert.ok(bg.client && bg.client.isOpen, 'short intervals keep the connection open');
      assert.deepStrictEqual(statuses, [true], 'no disconnect events');
      bg.stop();
      console.log('background interval: reconnect per poll, immediate poll when the window opens OK');
    }

    // Watchdog: a device that accepts the connection but never answers must not stop the poll loop.
    {
      const net = require('net');
      const silent = net.createServer((sock) => sock.on('error', () => {}));
      await new Promise((r) => silent.listen(5029, '127.0.0.1', r));
      const wd = new ModbusService();
      wd.configure({ ...config, host: '127.0.0.1', port: 5029, timeoutMs: 60000, pollDeadlineMs: 300, pollIntervalMs: 200 });
      const errors = [];
      wd.on('status', (st) => { if (st.error) errors.push(st.error); });
      wd.start();
      await new Promise((r) => setTimeout(r, 1800));
      wd.stop();
      silent.close();
      assert.ok(errors.filter((e) => /timed out/.test(e)).length >= 2, `poll loop keeps retrying after a hang: ${errors}`);
      console.log(`watchdog: hung poll aborted and retried (${errors.length}x) OK`);
    }

    // Module detection against simulators with different installations and absent-slot behaviour.
    const { fork } = require('child_process');
    const { detectModules } = require('../src/moduleDetect');
    const startSim = (port, env) => new Promise((resolve, reject) => {
      const ch = fork(path.join(__dirname, 'simulator.js'), [String(port)], { env: { ...process.env, SIM_PORT: '', SIM_MODULES: '', ...env }, silent: true });
      ch.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(ch); });
      ch.on('error', reject);
    });
    const simA = await startSim(5031, {});
    const simB = await startSim(5032, { SIM_ABSENT: 'zero', SIM_MODULES: 'emanager=0,heatpump=1,boiler=2,buffer=0,circuit=2' });
    try {
      const a = await detectModules({ host: '127.0.0.1', port: 5031 });
      const b = await detectModules({ host: '127.0.0.1', port: 5032 });
      console.log('detect (exceptions):', JSON.stringify(a.modules));
      console.log('detect (zeros):     ', JSON.stringify(b.modules));
      assert.deepStrictEqual(a.modules, { ambient: 1, emanager: 1, heatpump: 2, boiler: 1, buffer: 1, solar: 0, circuit: 4 });
      assert.deepStrictEqual(b.modules, { ambient: 1, emanager: 0, heatpump: 1, boiler: 2, buffer: 0, solar: 0, circuit: 2 });
      assert.ok(a.details.find((d) => d.type === 'heatpump' && d.nr === 3).reason.includes('exception'));
      assert.ok(b.details.find((d) => d.type === 'heatpump' && d.nr === 2).reason.includes('0'));
      const all = await detectModules({ host: '127.0.0.1', port: 5021 });
      assert.strictEqual(all.modules.circuit, 10);
      assert.ok(all.notes.some((n) => n.includes('subindex > 9')));
    } finally {
      simA.kill();
      simB.kill();
    }

    console.log('ALL TESTS PASSED');
    svc.stop();
    server.close(() => process.exit(0));
  } catch (e) {
    console.error('TEST FAILED', e);
    process.exit(1);
  }
});
