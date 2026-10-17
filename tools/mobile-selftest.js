'use strict';
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const ModbusRTU = require('modbus-serial');
const { DEFAULT_CONFIG, validateConfig, makePlan, readSample, LiveSession } = require('../src/mobile/service');

module.exports = async function testMobile() {
  const browser = { window: {} };
  vm.runInNewContext(readFileSync(join(__dirname, '../src/registers.js'), 'utf8'), browser);
  assert.strictEqual(browser.window.LwpRegisters.address(1, 1, 4), 1104, 'browser and Electron share the register map');
  const config = validateConfig({ ...DEFAULT_CONFIG, host: '127.0.0.1', port: 5021, unitId: 0 });
  assert.strictEqual(config.unitId, 0, 'unit ID zero must not turn into the default');
  assert.throws(() => validateConfig({ ...config, host: 'http://192.168.1.2' }), /IP address/);
  assert.throws(() => validateConfig({ ...config, port: 65536 }), /Port/);
  assert.throws(() => validateConfig({ ...config, timeoutMs: -1 }), /Timeout/);
  assert.throws(() => validateConfig({ ...config, modules: { ...config.modules, heatpump: 4 } }), /Heat pump/);
  assert.throws(() => validateConfig({ ...config, modules: Object.fromEntries(Object.keys(config.modules).map((k) => [k, 0])) }), /at least one/);

  // This adapter stands in for the native read-only socket plugin, against the real simulator.
  const reader = {
    async read(options) {
      const client = new ModbusRTU();
      try {
        await client.connectTCP(options.host, { port: options.port });
        client.setID(options.unitId);
        client.setTimeout(options.timeoutMs);
        const results = [];
        for (const block of options.blocks) {
          try {
            const { data } = await client.readHoldingRegisters(block.address, block.count);
            results.push({ data });
          } catch (error) {
            if (!error.modbusCode) throw error;
            results.push({ error: error.message });
          }
        }
        return { results };
      } finally {
        client.close(() => {});
      }
    },
  };
  const sample = await readSample(reader, { ...config, unitId: 1 });
  assert.strictEqual(sample.source, 'simulator');
  assert.strictEqual(sample.intervalMs, 5000);
  assert.ok(sample.values['heatpump1.tFlow'].value > 30);
  assert.strictEqual(sample.values['circuit1.offset'].value, -1);

  let calls = 0;
  const fallbackReader = {
    async read({ blocks }) {
      calls++;
      return { results: blocks.map((block, i) => {
        if (calls === 1) return { error: 'Illegal address' };
        return i === 0 ? { error: 'Illegal address' } : { data: Array(block.count).fill(0) };
      }) };
    },
  };
  const fallback = await readSample(fallbackReader, config);
  assert.strictEqual(calls, 2, 'failed blocks fall back to individual registers');
  assert.strictEqual(fallback.source, 'device', 'real device need not implement simulator marker');
  assert.ok(fallback.values['ambient.error'].error);
  assert.strictEqual(fallback.values['ambient.state'].text, 'OFF');
  await assert.rejects(() => readSample({ read: async () => ({ results: [] }) }, config), /Incomplete/);
  await assert.rejects(() => readSample({
    read: async ({ blocks }) => ({ results: blocks.map((b) => ({ data: Array(b.count).fill(65536) })) }),
  }, config), /Invalid/);
  await assert.rejects(() => readSample({
    read: async ({ blocks }) => ({ results: blocks.map(() => ({ error: 'Illegal address' })) }),
  }, config), /No readable/);
  assert.ok(makePlan(config).groups.every((b) => b.count <= 125));
  const { MODULE_TYPES } = require('../src/registers');
  const full = { ...config, modules: Object.fromEntries(MODULE_TYPES.map((t) => [t.id, t.max])) };
  const fullPlan = makePlan(full);
  assert.ok(fullPlan.groups.length + 1 <= 64, 'fully populated poll fits the native block limit');
  let fullCalls = 0;
  const fullSample = await readSample({
    read: async ({ blocks }) => {
      assert.ok(blocks.length <= 64, 'fallback batches fit the native block limit');
      fullCalls++;
      return { results: blocks.map((b) => fullCalls === 1
        ? { error: 'Illegal address' } : { data: Array(b.count).fill(0) }) };
    },
  }, full);
  assert.strictEqual(Object.keys(fullSample.values).length, 239);
  assert.strictEqual(fullCalls, 5);

  let resolve;
  let reads = 0;
  let delivered = 0;
  const delayedReader = {
    read({ blocks }) {
      reads++;
      return new Promise((done) => { resolve = () => done({ results: blocks.map((b) => ({ data: Array(b.count).fill(0) })) }); });
    },
  };
  const session = new LiveSession(delayedReader, { onData: () => delivered++ });
  session.start(config);
  clearTimeout(session.timer);
  const pending = session.poll();
  await session.poll();
  assert.strictEqual(reads, 1, 'polls never overlap');
  session.stop();
  resolve();
  await pending;
  assert.strictEqual(delivered, 0, 'disconnect suppresses late native responses');
  session.start(config);
  clearTimeout(session.timer);
  const backgroundPoll = session.poll();
  session.setActive(false);
  resolve();
  await backgroundPoll;
  assert.strictEqual(delivered, 0, 'backgrounding suppresses late native responses');
  await session.poll();
  assert.strictEqual(reads, 2, 'no polling while backgrounded');
  session.stop();
  console.log('mobile: browser register map, live simulator, validation, fallback, source detection and lifecycle OK');
};
