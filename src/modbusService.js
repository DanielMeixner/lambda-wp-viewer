'use strict';
const ModbusRTU = require('modbus-serial');
const { EventEmitter } = require('events');
const dns = require('dns').promises;
const net = require('net');
const { buildInstances, blocks, decode, SIM_MARKER } = require('./registers');

// Read-only poller: issues only read requests: FC 0x03 (read holding registers) and, once per
// connection, FC 0x2B/0x0E (read device identification) to show the device name.
class ModbusService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.config = null;
    this.instances = [];
    this.timer = null;
    this.intervalMs = null; // overrides config.pollIntervalMs (e.g. slower polling in the background)
    this.lastPollAt = 0;
    this.running = false;
    this.connected = false;
    this.polling = false;
    this.source = null; // 'device' | 'simulator' | null
    this.device = null; // { name, vendor, product, version, hostname }
  }

  configure(config) {
    this.config = config;
    this.instances = buildInstances(config);
  }

  get pollIntervalMs() {
    return Math.max(1000, Number(this.intervalMs ?? this.config?.pollIntervalMs) || 5000);
  }

  // Changes the poll interval of a running poller; the next poll is due one new interval after the last one
  // (e.g. opening the window while polling every 5 min in the background polls right away).
  setPollInterval(ms) {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (!this.running || this.polling) return; // loop() schedules with the new interval when done
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loop(), Math.max(0, this.lastPollAt + this.pollIntervalMs - Date.now()));
  }

  // The device closes connections after 1 min without requests. With long intervals the connection is
  // closed after each poll and opened again for the next one, without reporting "disconnected".
  get keepsConnection() { return this.pollIntervalMs <= 50000; }

  closeIdle() {
    if (!this.client) return;
    try { this.client.close(() => {}); } catch { /* ignore */ }
    this.client = null;
  }

  async start() {
    this.stop();
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.disconnect();
  }

  disconnect() {
    if (this.client) {
      try { this.client.close(() => {}); } catch { /* ignore */ }
    }
    this.client = null;
    this.setConnected(false);
  }

  setConnected(v, error) {
    if (!v) { this.source = null; this.device = null; }
    if (this.connected !== v || error) {
      this.connected = v;
      this.emit('status', { connected: v, error: error || null, source: this.source, device: this.device });
    }
  }

  async connect() {
    const c = new ModbusRTU();
    await c.connectTCP(this.config.host, { port: Number(this.config.port) || 502 });
    c.setID(Number(this.config.unitId) || 1);
    c.setTimeout(Number(this.config.timeoutMs) || 3000);
    this.client = c;
    this.source = await this.detectSource();
    this.device = await this.identify();
    // Some devices drop the connection after an unsupported function code; reconnect if so.
    if (!c.isOpen) {
      await c.connectTCP(this.config.host, { port: Number(this.config.port) || 502 });
    }
    this.setConnected(true);
  }

  // Best-effort device name: Modbus device identification, then reverse DNS, then a generic label.
  async identify() {
    const host = String(this.config.host);
    const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
    const [ident, hostname] = await Promise.all([
      withTimeout(this.client.readDeviceIdentification(1, 0).then((r) => r.data).catch(() => null), 2000),
      net.isIP(host)
        ? withTimeout(dns.reverse(host).then((n) => n[0] || null).catch(() => null), 2000)
        : Promise.resolve(host),
    ]);
    const clean = (v) => (typeof v === 'string' && v.trim() && v.trim() !== 'undefined' ? v.trim() : null);
    const vendor = clean(ident?.[0]);
    const product = clean(ident?.[0x07]) || clean(ident?.[0x04]) || clean(ident?.[1]);
    const version = clean(ident?.[2]);
    const appName = clean(ident?.[0x06]);
    const shortHost = hostname && !net.isIP(hostname) ? hostname : null;
    const fallback = this.source === 'simulator' ? 'LAMBDA simulator' : 'LAMBDA heat pump';
    const name = appName || [vendor, product].filter(Boolean).join(' ') || (shortHost && shortHost.split('.')[0]) || fallback;
    return { name, vendor, product, version, hostname: shortHost, identified: !!(appName || vendor || product) };
  }

  // A real heat pump rejects the marker address; only the bundled simulator answers with "SIM!".
  async detectSource() {
    try {
      const { data } = await this.client.readHoldingRegisters(SIM_MARKER.address, SIM_MARKER.words.length);
      return SIM_MARKER.words.every((w, i) => data[i] === w) ? 'simulator' : 'device';
    } catch {
      return 'device';
    }
  }

  async loop() {
    if (!this.running) return;
    clearTimeout(this.timer);
    const started = Date.now();
    this.lastPollAt = started;
    let failed = false;
    // Watchdog: a poll that never settles (half-open TCP connection, e.g. after the computer slept)
    // must not stop collecting forever.
    const gen = (this.pollGen = (this.pollGen || 0) + 1);
    let watchdog;
    try {
      await Promise.race([
        this.pollOnce(gen),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Poll timed out')), this.pollDeadlineMs()); }),
      ]);
      if (!this.keepsConnection) this.closeIdle();
    } catch (e) {
      if (gen === this.pollGen) {
        this.polling = false;
        failed = true;
        this.disconnect();
        this.setConnected(false, e.message || String(e));
      }
    }
    clearTimeout(watchdog);
    if (!this.running || gen !== this.pollGen) return;
    // After an error, retry within a minute even if the regular interval is longer.
    const interval = failed ? Math.min(this.pollIntervalMs, 60000) : this.pollIntervalMs;
    this.timer = setTimeout(() => this.loop(), Math.max(0, interval - (Date.now() - started)));
  }

  // Connect (OS TCP timeout ≤ 75 s) plus generous time for all register reads.
  pollDeadlineMs() {
    return Number(this.config?.pollDeadlineMs) || 120000;
  }

  // Called after the computer wakes up: the old TCP connection is usually dead, so start fresh and poll now.
  wake() {
    if (!this.running) return;
    this.pollGen = (this.pollGen || 0) + 1; // abandon a poll that may still hang on the old socket
    this.polling = false;
    if (this.client) { try { this.client.close(() => {}); } catch { /* ignore */ } }
    this.client = null;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loop(), 2000);
  }

  async readBlock(start, count) {
    const res = await this.client.readHoldingRegisters(start, count);
    return res.data;
  }

  isConnectionError(e) {
    const msg = String(e?.message || e);
    return /Port Not Open|ECONN|EPIPE|ETIMEDOUT|EHOSTUNREACH|socket|closed/i.test(msg) || e?.errno;
  }

  async pollOnce(gen = this.pollGen) {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.client || !this.client.isOpen) await this.connect();
      const ts = Date.now();
      const values = {};
      for (const inst of this.instances) {
        const byNumber = new Map(inst.datapoints.map((d) => [d.number, d]));
        for (const b of blocks([...byNumber.keys()])) {
          const startAddr = inst.datapoints.find((d) => d.number === b.start).address;
          let data = null;
          try {
            data = await this.readBlock(startAddr, b.count);
          } catch (e) {
            if (this.isConnectionError(e)) throw e;
            data = null; // block failed (e.g. illegal address) -> fall back to single reads
          }
          for (let i = 0; i < b.count; i++) {
            const d = byNumber.get(b.start + i);
            const key = `${inst.id}.${d.key}`;
            let raw = data ? data[i] : undefined;
            if (raw === undefined) {
              try {
                raw = (await this.readBlock(d.address, 1))[0];
              } catch (e) {
                if (this.isConnectionError(e)) throw e;
                values[key] = { error: e.message || 'read error' };
                continue;
              }
            }
            values[key] = decode(raw, d, this.config);
          }
        }
      }
      if (gen !== this.pollGen) return; // timed out / abandoned meanwhile
      this.emit('data', { ts, source: this.source, intervalMs: this.pollIntervalMs, values });
    } finally {
      if (gen === this.pollGen) this.polling = false;
    }
  }
}

module.exports = { ModbusService };
