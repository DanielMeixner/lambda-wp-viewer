'use strict';
// Register map for LAMBDA heat pumps, from "Modbus Beschreibung und Protokoll" (09.09.2021).
// Address = Index * 1000 + Subindex * 100 + Number

const E = {
  ambientState: { 0: 'OFF', 1: 'AUTOMATIK', 2: 'MANUAL', 3: 'ERROR' },
  emanagerState: { 0: 'OFF', 1: 'AUTOMATIK', 2: 'MANUAL', 3: 'ERROR', 4: 'OFFLINE' },
  hpErrorState: { 0: 'NONE', 1: 'MESSAGE', 2: 'WARNING', 3: 'ALARM', 4: 'FAULT' },
  hpState: {
    0: 'INIT', 1: 'REFERENCE', 2: 'RESTART-BLOCK', 3: 'READY', 4: 'START PUMPS',
    5: 'START COMPRESSOR', 6: 'PRE-REGULATION', 7: 'REGULATION', 8: 'Not Used',
    9: 'COOLING', 10: 'DEFROSTING', 20: 'STOPPING', 30: 'FAULT-LOCK',
    31: 'ALARM-BLOCK', 40: 'ERROR-RESET',
  },
  hpOperating: {
    0: 'STBY', 1: 'CH', 2: 'DHW', 3: 'CC', 4: 'CIRCULATE', 5: 'DEFROST', 6: 'OFF',
    7: 'FROST', 8: 'STBY-FROST', 9: 'Not used', 10: 'SUMMER', 11: 'HOLIDAY',
    12: 'ERROR', 13: 'WARNING', 14: 'INFO-MESSAGE', 15: 'TIME-BLOCK',
    16: 'RELEASE-BLOCK', 17: 'MINTEMP-BLOCK', 18: 'FIRMWARE-DOWNLOAD',
  },
  boilerState: {
    0: 'STBY', 1: 'DHW', 2: 'LEGIO', 3: 'SUMMER', 4: 'FROST', 5: 'HOLIDAY',
    6: 'PRIO-STOP', 7: 'ERROR', 8: 'OFF', 9: 'PROMPT-DHW', 10: 'TRAILING-STOP',
    11: 'TEMP-LOCK', 12: 'STBY-FROST',
  },
  bufferState: {
    0: 'STBY', 1: 'HEATING', 2: 'COOLING', 3: 'SUMMER', 4: 'FROST', 5: 'HOLIDAY',
    6: 'PRIO-STOP', 7: 'ERROR', 8: 'OFF', 9: 'STBY-FROST',
  },
  solarState: { 0: 'STBY', 1: 'HEATING', 2: 'ERROR', 3: 'OFF' },
  circuitState: {
    0: 'HEATING', 1: 'ECO', 2: 'COOLING', 3: 'FLOORDRY', 4: 'FROST', 5: 'MAX-TEMP',
    6: 'ERROR', 7: 'SERVICE', 8: 'HOLIDAY', 9: 'CH-SUMMER', 10: 'CC-WINTER',
    11: 'PRIO-STOP', 12: 'OFF', 13: 'RELEASE-OFF', 14: 'TIME-OFF', 15: 'STBY',
    16: 'STBY-HEATING', 17: 'STBY-ECO', 18: 'STBY-COOLING', 19: 'STBY-FROST',
    20: 'STBY-FLOORDRY',
  },
  circuitMode: {
    0: 'OFF', 1: 'MANUAL', 2: 'AUTOMATIK', 3: 'AUTO-HEATING', 4: 'AUTO-COOLING',
    5: 'FROST', 6: 'SUMMER', 7: 'FLOOR-DRY',
  },
  errorQuit: { 0: '0', 1: 'Quit requested' },
};

// dp(number, key, name, type, scale, unit, extra)
const dp = (number, key, name, type, scale, unit, extra = {}) =>
  ({ number, key, name, type, scale, unit, ...extra });

const MODULE_TYPES = [
  {
    id: 'ambient', name: 'Ambient', index: 0, fixedSubindex: 0, max: 1,
    datapoints: [
      dp(0, 'error', 'Error number', 'INT16', 1, '', { desc: '0 = No Error' }),
      dp(1, 'state', 'Operating state', 'UINT16', 1, '', { enum: E.ambientState }),
      dp(2, 'actual', 'Actual ambient temp.', 'INT16', 0.1, '°C', { rw: true }),
      dp(3, 'avg1h', 'Average ambient temp. 1h', 'INT16', 0.1, '°C'),
      dp(4, 'calc', 'Calculated ambient temp.', 'INT16', 0.1, '°C'),
    ],
  },
  {
    id: 'emanager', name: 'E-Manager', index: 0, fixedSubindex: 1, max: 1,
    datapoints: [
      dp(0, 'error', 'Error number', 'INT16', 1, ''),
      dp(1, 'state', 'Operating state', 'UINT16', 1, '', { enum: E.emanagerState }),
      dp(2, 'power', 'Actual power (input or excess)', 'EMGR', 1, 'W', { rw: true }),
      dp(3, 'consumption', 'Actual power consumption', 'INT16', 1, 'W'),
      dp(4, 'setpoint', 'Power consumption setpoint', 'INT16', 1, 'W'),
    ],
  },
  {
    id: 'heatpump', name: 'Heat pump', index: 1, max: 3,
    datapoints: [
      dp(0, 'errorState', 'Error state', 'UINT16', 1, '', { enum: E.hpErrorState }),
      dp(1, 'error', 'Error number', 'INT16', 1, ''),
      dp(2, 'hpState', 'HP state', 'UINT16', 1, '', { enum: E.hpState }),
      dp(3, 'opState', 'Operating state', 'UINT16', 1, '', { enum: E.hpOperating }),
      dp(4, 'tFlow', 'T-flow', 'INT16', 0.01, '°C'),
      dp(5, 'tReturn', 'T-return', 'INT16', 0.01, '°C'),
      dp(6, 'volSink', 'Vol. sink', 'INT16', 0.01, 'l/min'),
      dp(7, 'tEqIn', 'T-EQin (source in)', 'INT16', 0.01, '°C'),
      dp(8, 'tEqOut', 'T-EQout (source out)', 'INT16', 0.01, '°C'),
      dp(9, 'volSource', 'Vol. source', 'INT16', 0.01, 'l/min'),
      dp(10, 'compressor', 'Compressor rating', 'UINT16', 0.01, '%'),
      dp(11, 'qp', 'Qp heating', 'INT16', 0.1, 'kW'),
      dp(12, 'fiPower', 'FI power consumption', 'INT16', 1, 'W'),
      dp(13, 'cop', 'COP', 'INT16', 0.01, ''),
      dp(50, 'errorQuit', 'Set.: Error quit', 'UINT16', 1, '', { rw: true, enum: E.errorQuit }),
    ],
  },
  {
    id: 'boiler', name: 'Boiler', index: 2, max: 5,
    datapoints: [
      dp(0, 'error', 'Error number', 'INT16', 1, ''),
      dp(1, 'state', 'Operating state', 'UINT16', 1, '', { enum: E.boilerState }),
      dp(2, 'tHigh', 'Actual high temp.', 'INT16', 0.1, '°C'),
      dp(3, 'tLow', 'Actual low temp.', 'INT16', 0.1, '°C'),
      dp(50, 'tMax', 'Set.: Maximum boiler temp.', 'INT16', 0.1, '°C', { rw: true }),
    ],
  },
  {
    id: 'buffer', name: 'Buffer', index: 3, max: 5,
    datapoints: [
      dp(0, 'error', 'Error number', 'INT16', 1, ''),
      dp(1, 'state', 'Operating state', 'UINT16', 1, '', { enum: E.bufferState }),
      dp(2, 'tHigh', 'Actual high temp.', 'INT16', 0.1, '°C'),
      dp(3, 'tLow', 'Actual low temp.', 'INT16', 0.1, '°C'),
      dp(50, 'tMax', 'Set.: Maximum buffer temp.', 'INT16', 0.1, '°C', { rw: true }),
    ],
  },
  {
    id: 'solar', name: 'Solar', index: 4, max: 2,
    datapoints: [
      dp(0, 'error', 'Error number', 'INT16', 1, ''),
      dp(1, 'state', 'Operating state', 'UINT16', 1, '', { enum: E.solarState }),
      dp(2, 'tCollector', 'Collector temp.', 'INT16', 0.1, '°C'),
      dp(3, 'tBuffer1', 'Buffer 1 temp.', 'INT16', 0.1, '°C'),
      dp(4, 'tBuffer2', 'Buffer 2 temp.', 'INT16', 0.1, '°C'),
      dp(50, 'tMax', 'Set.: Maximum buffer temp.', 'INT16', 0.1, '°C', { rw: true }),
      dp(51, 'tChange', 'Set.: Buffer changeover temp.', 'INT16', 0.1, '°C', { rw: true }),
    ],
  },
  {
    id: 'circuit', name: 'Heating circuit', index: 5, max: 12,
    datapoints: [
      dp(0, 'error', 'Error number', 'INT16', 1, ''),
      dp(1, 'state', 'Operating state', 'UINT16', 1, '', { enum: E.circuitState }),
      dp(2, 'tFlow', 'Flow line temp.', 'INT16', 0.1, '°C'),
      dp(3, 'tReturn', 'Return line temp.', 'INT16', 0.1, '°C'),
      dp(4, 'tRoom', 'Room device temp.', 'INT16', 0.1, '°C', { rw: true }),
      dp(5, 'tFlowSet', 'Setpoint flow line temp.', 'INT16', 0.1, '°C', { rw: true }),
      dp(6, 'mode', 'Operating mode', 'INT16', 1, '', { rw: true, enum: E.circuitMode }),
      dp(50, 'offset', 'Set.: Offset flow line temp. setpoint', 'INT16', 0.1, 'K', { rw: true }),
      dp(51, 'roomHeat', 'Set.: Setpoint room heating temp.', 'INT16', 0.1, '°C', { rw: true }),
      dp(52, 'roomCool', 'Set.: Setpoint room cooling temp.', 'INT16', 0.1, '°C', { rw: true }),
    ],
  },
];

function address(index, subindex, number) {
  return index * 1000 + subindex * 100 + number;
}

// Group sorted register numbers into contiguous blocks: [{start, count}]
function blocks(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last.start + last.count) last.count++;
    else out.push({ start: n, count: 1 });
  }
  return out;
}

// Build the list of concrete module instances from config.modules counts.
function buildInstances(config) {
  const instances = [];
  for (const t of MODULE_TYPES) {
    const count = Math.min(Number(config.modules?.[t.id] ?? 0), t.max);
    for (let i = 0; i < count; i++) {
      const subindex = t.fixedSubindex ?? i;
      const nr = t.max === 1 ? '' : ` ${i + 1}`;
      instances.push({
        id: t.max === 1 ? t.id : `${t.id}${i + 1}`,
        type: t.id,
        name: `${t.name}${nr}`,
        index: t.index,
        subindex,
        nonStandardAddress: subindex > 9,
        datapoints: t.datapoints.map((d) => ({
          ...d,
          address: address(t.index, subindex, d.number),
        })),
      });
    }
  }
  return instances;
}

// Register contents that mean "no value" (sensor not connected / value not available) rather than a measurement.
function isEmptyRaw(raw, type) {
  if (raw == null) return true;
  const u = raw & 0xffff;
  return type === 'UINT16' ? u === 0xffff : u === 0x8000 || u === 0x7fff;
}

function decode(raw, dpDef, config) {
  let type = dpDef.type;
  if (type === 'EMGR') type = config?.emanagerSigned ? 'INT16' : 'UINT16';
  let v = raw & 0xffff;
  if (type === 'INT16' && v > 0x7fff) v -= 0x10000;
  // E-Manager registers are signed or unsigned depending on the installation, so 0xFFFF may mean -1 there.
  if (dpDef.type !== 'EMGR' && isEmptyRaw(v, type)) return { raw: v, value: null, text: null, missing: true };
  const value = Math.round(v * dpDef.scale * 1000) / 1000;
  return { raw: v, value, text: dpDef.enum ? (dpDef.enum[v] ?? `Unknown (${v})`) : null };
}

// Marker served only by tools/simulator.js ("SIM!") so the app can tell fake data from a real device.
// Real LAMBDA controllers use index 0-5 only, so these addresses answer with an exception there.
const SIM_MARKER = { address: 9998, words: [0x5349, 0x4d21] };

module.exports = { SIM_MARKER, MODULE_TYPES, address, blocks, buildInstances, decode, isEmptyRaw };
