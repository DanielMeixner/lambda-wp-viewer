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
    const t0 = new Date(2026, 0, 10, 23, 58).getTime();
    assert.ok(store.write({ ...mk(t0, 30), intervalMs: 300000 }));
    assert.ok(store.write(mk(t0 + 10000, 31)), 'every query is saved');
    assert.strictEqual(store.status().rowsWritten, 2);
    assert.strictEqual(store.status().lastSampleTs, t0 + 10000);
    assert.ok(store.write(mk(t0 + 60000, 32)));
    assert.ok(store.write(mk(t0 + 180000, 33)), 'next day goes to a new file');
    assert.ok(store.write(mk(t0 + 300000, 99, 'simulator')));
    // A module configuration change appends a new header; old columns stay readable.
    const store2 = new HistoryStore();
    store2.configure({ folder: dir, enabled: true, instances: buildInstances({ modules: { ambient: 1, heatpump: 1, boiler: 1 } }) });
    assert.ok(store2.write(mk(t0 + 240000, 34)));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['lambda-wp-2026-01-10.csv', 'lambda-wp-2026-01-11.csv', 'simulated']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'lambda-wp-2026-01-11.csv'), 'utf8').split('\ntimestamp,').length, 2);
    const h = await store.load({ from: t0 - 3600000, to: t0 + 3600000, instances: hInst });
    console.log(`history: ${h.samples.length} samples from ${h.files.length} files`);
    assert.deepStrictEqual(h.samples.map((x) => x.values['heatpump1.tFlow'].value), [30, 31, 32, 33, 34]);
    assert.strictEqual(h.samples[0].values['heatpump1.hpState'].text, 'REGULATION');
    assert.strictEqual(h.samples[0].values['heatpump1.tFlow'].raw, 3000);
    assert.ok(h.samples.every((x) => x.source === 'device' && x.history));
    assert.strictEqual(h.samples[0].intervalMs, 300000, 'background interval is read back');
    assert.strictEqual(h.samples[1].intervalMs, undefined);
    // Rows with an old-style "empty" value (-327.68 °C = 0x8000) or a missing value never come back as values.
    assert.ok(store.write(mk(t0 + 250000, -327.68)));
    const miss = mk(t0 + 260000, 0);
    miss.values['heatpump1.tFlow'] = { raw: -32768, value: null, text: null, missing: true };
    assert.ok(store.write(miss));
    const h2 = await store.load({ from: t0 + 245000, to: t0 + 3600000, instances: hInst });
    assert.strictEqual(h2.samples.length, 2);
    assert.ok(h2.samples.every((x) => !('heatpump1.tFlow' in x.values) && x.values['ambient.actual'].value === 5.5));
    const thin = await store.load({ from: 0, to: t0 + 3600000, instances: hInst, maxSamples: 2 });
    assert.strictEqual(thin.samples.length, 2);
    assert.strictEqual(thin.samples[1].ts, t0 + 260000, 'thinning keeps the newest sample');
    fs.rmSync(dir, { recursive: true, force: true });

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
