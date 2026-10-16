'use strict';
// Finds Modbus TCP devices on the local network and identifies LAMBDA heat pumps.
// Stage 1: fast TCP connect scan of the port. Stage 2: read-only Modbus probe (FC 0x03) of each open host.
const net = require('net');
const os = require('os');
const ModbusRTU = require('modbus-serial');
const { EventEmitter } = require('events');
const { SIM_MARKER, MODULE_TYPES } = require('./registers');

const MAX_HOSTS = 1024;

const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// Parse "a.b.c.d/nn" or a single IP into a list of host addresses.
function expandCidr(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
  if (!m || m[1].split('.').some((o) => Number(o) > 255)) throw new Error(`Invalid address or subnet: ${cidr}`);
  const prefix = m[2] === undefined ? 32 : Number(m[2]);
  if (prefix > 32) throw new Error(`Invalid prefix: /${prefix}`);
  if (prefix === 32) return [m[1]];
  const size = 2 ** (32 - prefix);
  if (size - 2 > MAX_HOSTS) throw new Error(`Subnet /${prefix} is too large (max ${MAX_HOSTS} hosts, use /22 or smaller)`);
  const base = (ipToInt(m[1]) & (~(size - 1) >>> 0)) >>> 0;
  const out = [];
  for (let i = 1; i < size - 1; i++) out.push(intToIp(base + i));
  return out;
}

// Local IPv4 subnets. Large networks are reduced to the /24 around the own address.
function localSubnets() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      let prefix = Number((a.cidr || '').split('/')[1]) || 24;
      if (prefix < 22) prefix = 24;
      const size = 2 ** (32 - prefix);
      const base = (ipToInt(a.address) & (~(size - 1) >>> 0)) >>> 0;
      const cidr = `${intToIp(base)}/${prefix}`;
      if (!out.some((s) => s.cidr === cidr)) out.push({ cidr, iface: name, address: a.address });
    }
  }
  return out;
}

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

const STATE_KEYS = {
  hpState: MODULE_TYPES.find((t) => t.id === 'heatpump').datapoints.find((d) => d.key === 'hpState').enum,
  opState: MODULE_TYPES.find((t) => t.id === 'heatpump').datapoints.find((d) => d.key === 'opState').enum,
};

// Read-only identification of a Modbus TCP host.
async function probe(host, port, unitId, timeoutMs) {
  const result = { host, port, unitId, kind: 'modbus', label: 'Modbus TCP device (not identified)', details: {} };
  const c = new ModbusRTU();
  try {
    await c.connectTCP(host, { port });
    c.setID(unitId);
    c.setTimeout(timeoutMs);
    const read = async (addr, n) => { try { return (await c.readHoldingRegisters(addr, n)).data; } catch { return null; } };

    const marker = await read(SIM_MARKER.address, SIM_MARKER.words.length);
    if (marker && SIM_MARKER.words.every((w, i) => marker[i] === w)) {
      return { ...result, kind: 'simulator', label: 'LAMBDA simulator (fake data)' };
    }
    const hp = await read(1000, 5);
    const amb = await read(0, 3);
    if (hp && STATE_KEYS.hpState[hp[2]] !== undefined && STATE_KEYS.opState[hp[3]] !== undefined) {
      const flow = ((hp[4] << 16) >> 16) / 100;
      result.kind = 'lambda';
      result.label = 'LAMBDA heat pump';
      result.details = { hpState: STATE_KEYS.hpState[hp[2]], opState: STATE_KEYS.opState[hp[3]], flowTemp: flow };
      if (amb) result.details.ambient = ((amb[2] << 16) >> 16) / 10;
    } else if (hp || amb) {
      result.label = 'Modbus TCP device (registers readable, not recognised as LAMBDA)';
    }
    return result;
  } catch (e) {
    return { ...result, label: `Port open, Modbus probe failed (${e.message || e})` };
  } finally {
    try { c.close(() => {}); } catch { /* ignore */ }
  }
}

class Discovery extends EventEmitter {
  constructor() { super(); this.cancelled = false; this.running = false; }

  cancel() { this.cancelled = true; }

  // opts: { port, unitId, subnets?: string[], includeLocalhost?: boolean, connectTimeoutMs, probeTimeoutMs, concurrency }
  async run(opts = {}) {
    const port = Number(opts.port) || 502;
    const unitId = Number(opts.unitId) || 1;
    const connectTimeoutMs = opts.connectTimeoutMs || 600;
    const probeTimeoutMs = opts.probeTimeoutMs || 1500;
    const concurrency = opts.concurrency || 64;
    this.cancelled = false;
    this.running = true;

    try {
      const subnets = opts.subnets?.length ? opts.subnets.map((cidr) => ({ cidr })) : localSubnets();
      const hosts = [];
      for (const s of subnets) for (const h of expandCidr(s.cidr)) if (!hosts.includes(h)) hosts.push(h);
      if (opts.includeLocalhost !== false && !hosts.includes('127.0.0.1')) hosts.push('127.0.0.1');
      if (hosts.length > MAX_HOSTS * 2) hosts.length = MAX_HOSTS * 2;

      this.emit('progress', { phase: 'scan', done: 0, total: hosts.length, subnets: subnets.map((s) => s.cidr), port });
      const open = [];
      let done = 0;
      let next = 0;
      const worker = async () => {
        while (!this.cancelled && next < hosts.length) {
          const h = hosts[next++];
          if (await tcpOpen(h, port, connectTimeoutMs)) {
            open.push(h);
            this.emit('found', { host: h, port, kind: 'pending', label: 'Port open – identifying…' });
          }
          done++;
          if (done % 8 === 0 || done === hosts.length) this.emit('progress', { phase: 'scan', done, total: hosts.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));

      const results = [];
      for (const h of open) {
        if (this.cancelled) break;
        this.emit('progress', { phase: 'probe', done: results.length, total: open.length, host: h });
        const r = await probe(h, port, unitId, probeTimeoutMs);
        results.push(r);
        this.emit('found', r);
      }
      const rank = { lambda: 0, simulator: 1, modbus: 2 };
      results.sort((a, b) => rank[a.kind] - rank[b.kind] || ipToInt(a.host) - ipToInt(b.host));
      return { cancelled: this.cancelled, scanned: done, port, subnets: subnets.map((s) => s.cidr), results };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Discovery, localSubnets, expandCidr, probe };
