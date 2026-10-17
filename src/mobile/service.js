'use strict';
((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('../registers'));
  else root.LwpMobile = factory(root.LwpRegisters);
})(typeof window === 'undefined' ? globalThis : window, (registers) => {
  const { MODULE_TYPES, SIM_MARKER, buildInstances, blocks, decode } = registers;
  const DEFAULT_CONFIG = {
    host: '192.168.0.100', port: 502, unitId: 1, timeoutMs: 3000,
    pollIntervalMs: 5000, emanagerSigned: false,
    modules: { ambient: 1, emanager: 1, heatpump: 1, boiler: 1, buffer: 0, solar: 0, circuit: 1 },
  };

  function validateConfig(input) {
    const integer = (value, min, max, label) => {
      const n = Number(value);
      if (value === '' || value == null || !Number.isInteger(n) || n < min || n > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}.`);
      }
      return n;
    };
    const host = String(input.host || '').trim();
    if (!host || host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
      throw new Error('Enter an IP address or hostname, without a URL or port.');
    }
    const config = {
      host, port: integer(input.port, 1, 65535, 'Port'),
      unitId: integer(input.unitId, 0, 255, 'Unit ID'),
      timeoutMs: integer(input.timeoutMs, 250, 10000, 'Timeout'),
      pollIntervalMs: integer(input.pollIntervalMs, 1000, 55000, 'Poll interval (ms)'),
      emanagerSigned: input.emanagerSigned === true,
      modules: {},
    };
    for (const type of MODULE_TYPES) {
      config.modules[type.id] = integer(input.modules?.[type.id], 0, type.max, type.name);
    }
    if (!Object.values(config.modules).some(Boolean)) throw new Error('Enable at least one installed module.');
    return config;
  }

  function makePlan(config) {
    const instances = buildInstances(config);
    const groups = instances.flatMap((inst) => blocks(inst.datapoints.map((d) => d.number)).map((block) => ({
      address: inst.datapoints.find((d) => d.number === block.start).address,
      count: block.count,
      points: inst.datapoints.filter((d) => d.number >= block.start && d.number < block.start + block.count)
        .map((d) => ({ key: `${inst.id}.${d.key}`, definition: d, offset: d.number - block.start })),
    })));
    return { instances, groups };
  }

  function checkedResults(response, requests) {
    if (!Array.isArray(response?.results) || response.results.length !== requests.length) {
      throw new Error('Incomplete Modbus response.');
    }
    response.results.forEach((result, i) => {
      if (typeof result?.error === 'string') return;
      if (!Array.isArray(result?.data) || result.data.length !== requests[i].count ||
          result.data.some((v) => !Number.isInteger(v) || v < 0 || v > 65535)) {
        throw new Error('Invalid Modbus register data.');
      }
    });
    return response.results;
  }

  async function readSample(reader, config) {
    const { groups } = makePlan(config);
    const requests = [{ address: SIM_MARKER.address, count: SIM_MARKER.words.length },
      ...groups.map(({ address, count }) => ({ address, count }))];
    const options = { host: config.host, port: config.port, unitId: config.unitId, timeoutMs: config.timeoutMs };
    const results = checkedResults(await reader.read({ ...options, blocks: requests }), requests);
    const source = SIM_MARKER.words.every((v, i) => results[0].data?.[i] === v) ? 'simulator' : 'device';
    const values = {};
    const fallback = [];
    let successfulReads = 0;
    groups.forEach((group, i) => {
      const result = results[i + 1];
      for (const point of group.points) {
        if (result.error) {
          fallback.push({ address: point.definition.address, count: 1, point });
        } else {
          values[point.key] = decode(result.data[point.offset], point.definition, config);
          successfulReads++;
        }
      }
    });
    // Unsupported addresses must not hide other readings in the same block.
    for (let offset = 0; offset < fallback.length; offset += 64) {
      const batch = fallback.slice(offset, offset + 64);
      const singles = batch.map(({ address, count }) => ({ address, count }));
      const replies = checkedResults(await reader.read({ ...options, blocks: singles }), singles);
      replies.forEach((reply, i) => {
        const { point } = batch[i];
        values[point.key] = reply.error ? { error: reply.error } : decode(reply.data[0], point.definition, config);
        if (!reply.error) successfulReads++;
      });
    }
    if (!successfulReads) throw new Error('No readable registers. Check the unit ID and installed modules.');
    return { ts: Date.now(), source, intervalMs: config.pollIntervalMs, values };
  }

  class LiveSession {
    constructor(reader, { onData = () => {}, onStatus = () => {} } = {}) {
      this.reader = reader;
      this.onData = onData;
      this.onStatus = onStatus;
      this.running = false;
      this.active = true;
      this.busy = false;
      this.generation = 0;
      this.timer = null;
    }

    start(input) {
      const config = validateConfig(input);
      this.stop();
      this.config = config;
      this.running = true;
      this.schedule(0);
    }

    stop() {
      this.running = false;
      this.generation++;
      clearTimeout(this.timer);
      this.onStatus({ connected: false, message: 'Disconnected — values are not updating.' });
    }

    setActive(active) {
      this.active = active;
      this.generation++;
      clearTimeout(this.timer);
      if (!active) this.onStatus({ connected: false, message: 'Paused while the app is in the background.' });
      else if (this.running) this.schedule(0);
    }

    schedule(delay) {
      clearTimeout(this.timer);
      if (this.running && this.active) this.timer = setTimeout(() => this.poll(), delay);
    }

    async poll() {
      if (!this.running || !this.active) return;
      // A native request may still be completing after Disconnect or backgrounding.
      if (this.busy) { this.schedule(100); return; }
      const generation = this.generation;
      this.busy = true;
      this.onStatus({ connected: false, pending: true, message: 'Reading live data…' });
      try {
        const sample = await readSample(this.reader, this.config);
        if (generation !== this.generation) return;
        this.onData(sample);
        this.onStatus({ connected: true, source: sample.source, message: 'Connected' });
      } catch (error) {
        if (generation === this.generation) {
          this.onStatus({ connected: false, message: `${error.message || error} — retrying.` });
        }
      } finally {
        this.busy = false;
        this.schedule(this.config.pollIntervalMs);
      }
    }
  }

  return { DEFAULT_CONFIG, validateConfig, makePlan, readSample, LiveSession };
});
