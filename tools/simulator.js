'use strict';
// Local Modbus TCP simulator for a LAMBDA heat pump. Serves every documented register with plausible values.
// Usage: node tools/simulator.js [port]   (default 5020)
// Env: SIM_MODULES="heatpump=2,circuit=4" | all, SIM_ABSENT=zero
const ModbusRTU = require('modbus-serial');
const { MODULE_TYPES, address, SIM_MARKER } = require('../src/registers');

const port = Number(process.argv[2] || process.env.SIM_PORT || 5020);
const t0 = Date.now();
const wave = (period, amp, offset) => offset + amp * Math.sin(((Date.now() - t0) / 1000 / period) * 2 * Math.PI);
const u16 = (v) => Math.round(v) & 0xffff;

// value generators per type/key (already in raw register units)
const gen = {
  ambient: { error: () => 0, state: () => 1, actual: () => wave(120, 30, 55), avg1h: () => 52, calc: () => 54 },
  emanager: { error: () => 0, state: () => 1, power: () => wave(90, 1500, 1200), consumption: () => wave(60, 300, 1800), setpoint: () => 2000 },
  heatpump: {
    errorState: () => 0, error: () => 0, hpState: () => 7, opState: () => 1,
    tFlow: () => wave(60, 150, 3500), tReturn: () => wave(60, 120, 3000), volSink: () => 2400,
    tEqIn: () => wave(120, 200, 600), tEqOut: () => wave(120, 200, 300), volSource: () => 5100,
    compressor: () => wave(45, 1500, 6000), qp: () => wave(45, 10, 72), fiPower: () => wave(45, 300, 1700), cop: () => wave(45, 40, 420),
    errorQuit: () => 0,
  },
  boiler: { error: () => 0, state: () => 0, tHigh: () => wave(300, 20, 495), tLow: () => wave(300, 30, 430), tMax: () => 550 },
  buffer: { error: () => 0, state: () => 1, tHigh: () => wave(200, 20, 380), tLow: () => wave(200, 20, 320), tMax: () => 500 },
  solar: { error: () => 0, state: () => 1, tCollector: () => wave(100, 150, 600), tBuffer1: () => 450, tBuffer2: () => 400, tMax: () => 850, tChange: () => 600 },
  circuit: {
    error: () => 0, state: () => 0, tFlow: () => wave(80, 15, 330), tReturn: () => wave(80, 15, 290),
    tRoom: () => wave(400, 5, 215), tFlowSet: () => 340, mode: () => 2, offset: () => -10, roomHeat: () => 215, roomCool: () => 250,
  },
};

// Installed modules: SIM_MODULES="heatpump=2,boiler=1,..." or "all". Absent module slots answer with an
// exception (default) or, with SIM_ABSENT=zero, with 0 like an unconfigured controller might.
const DEFAULT_MODULES = { ambient: 1, emanager: 1, heatpump: 2, boiler: 1, buffer: 1, solar: 0, circuit: 4 };
const simModules = (() => {
  const spec = process.env.SIM_MODULES;
  if (spec === 'all') return Object.fromEntries(MODULE_TYPES.map((t) => [t.id, t.max]));
  const m = { ...DEFAULT_MODULES };
  for (const part of (spec || '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=');
    m[k.trim()] = Number(v);
  }
  return m;
})();
const absentZero = process.env.SIM_ABSENT === 'zero';

const registers = new Map();
for (const t of MODULE_TYPES) {
  for (let i = 0; i < t.max; i++) {
    if (i >= (simModules[t.id] ?? 0)) {
      if (absentZero) for (const d of t.datapoints) registers.set(address(t.index, t.fixedSubindex ?? i, d.number), () => 0);
      continue;
    }
    const sub = t.fixedSubindex ?? i;
    for (const d of t.datapoints) registers.set(address(t.index, sub, d.number), () => gen[t.id][d.key]() + (d.enum || d.key === 'error' ? 0 : i * 3));
  }
}

SIM_MARKER.words.forEach((w, i) => registers.set(SIM_MARKER.address + i, () => w));

const vector = {
  readDeviceIdentification() {
    return { 0x00: 'LAMBDA Simulator', 0x01: 'LWP-SIM', 0x02: '1.0', 0x04: 'EU-L Simulator', 0x06: 'LAMBDA Simulator (fake data)' };
  },
  getHoldingRegister(addr) {
    const f = registers.get(addr);
    if (!f) throw { modbusErrorCode: 0x02, msg: `Illegal address ${addr}` };
    return u16(f());
  },
  getInputRegister(addr) { return vector.getHoldingRegister(addr); },
  setRegister() { throw { modbusErrorCode: 0x01, msg: 'read-only simulator' }; },
};

const server = new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port, unitID: 1, debug: false });
server.on('socketError', (e) => console.error('socket error', e.message));
server.on('initialized', () => console.log(`LAMBDA simulator listening on 0.0.0.0:${port} (unit 1, ${registers.size} registers, modules ${JSON.stringify(simModules)}${absentZero ? ', absent = 0' : ''})`));
module.exports = server;
