'use strict';
// Detects which modules are installed by probing each module slot with read-only requests (FC 0x03).
// The PDF does not specify how the controller answers for modules that are not configured, so a slot
// counts as "absent" when it answers with an exception / no response, or with values that cannot come
// from a configured module (all 0, all 0xFFFF/0x8000, invalid states, impossible temperatures).
// Modules of one type are numbered without gaps (subindex 0, 1, 2, ...), so probing stops at the first absent slot.
const ModbusRTU = require('modbus-serial');
const { MODULE_TYPES, address, blocks, decode, plausibleRange } = require('./registers');

const EMPTY = new Set([0x0000, 0xffff, 0x8000, 0x7fff]);


// Judges one slot from its "live" datapoints (numbers < 50). Returns { present, reason, sample }.
function judge(type, raws) {
  const dps = type.datapoints.filter((d) => d.number < 50);
  const vals = dps.map((d) => raws[d.number]);
  if (vals.every((v) => v === 0)) return { present: false, reason: 'all registers are 0' };
  if (vals.every((v) => EMPTY.has(v))) return { present: false, reason: 'only empty values (0 / 0xFFFF / 0x8000)' };
  const problems = [];
  let plausible = 0;
  let checked = 0;
  const sample = {};
  for (const d of dps) {
    const raw = raws[d.number];
    const dec = decode(raw, d, {});
    sample[d.key] = d.enum ? dec.text : dec.value;
    if (dec.implausible != null) { checked++; problems.push(`${d.name} = ${dec.implausible} ${d.unit} is implausible`); continue; }
    if (dec.missing) { checked++; problems.push(`${d.name} has no value`); continue; }
    if (d.enum && d.type !== 'EMGR') {
      checked++;
      if (d.enum[dec.raw] !== undefined) plausible++;
      else problems.push(`${d.name} = ${raw} is not a valid state`);
      continue;
    }
    const r = plausibleRange(d);
    if (!r) continue;
    checked++;
    if (dec.value >= r[0] && dec.value <= r[1]) plausible++;
    else problems.push(`${d.name} = ${dec.value} ${d.unit} is implausible`);
  }
  // Tolerate a single odd value (e.g. an unconnected sensor), but not a slot that is mostly garbage.
  const present = checked === 0 || (plausible / checked >= 0.75 && problems.length <= 1);
  return {
    present,
    reason: present ? (problems.length ? `plausible values (${problems[0]})` : 'plausible values') : problems.slice(0, 2).join('; '),
    sample,
  };
}

async function readSlot(client, type, subindex) {
  const numbers = type.datapoints.filter((d) => d.number < 50).map((d) => d.number);
  const raws = {};
  for (const b of blocks(numbers)) {
    const { data } = await client.readHoldingRegisters(address(type.index, subindex, b.start), b.count);
    data.forEach((v, i) => { raws[b.start + i] = v; });
  }
  return raws;
}

// Returns { modules: {typeId: count}, details: [{type, nr, subindex, present, reason, sample}], notes: [] }
async function detectModules({ host, port = 502, unitId = 1, timeoutMs = 1500, onProgress } = {}) {
  const client = new ModbusRTU();
  const connect = async () => {
    await client.connectTCP(host, { port: Number(port) || 502 });
    client.setID(Number(unitId) || 1);
    client.setTimeout(Number(timeoutMs) || 1500);
  };
  await connect();
  const modules = {};
  const details = [];
  const notes = [];
  try {
    for (const t of MODULE_TYPES) {
      // Subindex > 9 has no defined address in the PDF; those slots are not probed.
      const maxProbe = Math.min(t.max, t.fixedSubindex !== undefined ? 1 : 10);
      let count = 0;
      for (let i = 0; i < maxProbe; i++) {
        const subindex = t.fixedSubindex ?? i;
        onProgress?.({ type: t.id, nr: i + 1 });
        let res;
        try {
          res = judge(t, await readSlot(client, t, subindex));
        } catch (e) {
          res = { present: false, reason: e.modbusCode ? `not available (device answered with exception ${e.modbusCode})` : `no answer (${e.message || e})` };
          // Some devices drop the connection after an exception or timeout.
          if (!client.isOpen) await connect().catch(() => {});
        }
        details.push({ type: t.id, typeName: t.name, nr: i + 1, subindex, ...res });
        if (!res.present) break;
        count++;
      }
      modules[t.id] = count;
      if (t.max > maxProbe && count === maxProbe) {
        notes.push(`${t.name}: ${maxProbe} found. Modules ${maxProbe + 1}–${t.max} use subindex > 9 and cannot be detected – set them manually if present.`);
      }
    }
  } finally {
    try { client.close(() => {}); } catch { /* ignore */ }
  }
  return { modules, details, notes };
}

module.exports = { detectModules, judge };
