'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { ModbusService } = require('./modbusService');
const { MODULE_TYPES, buildInstances } = require('./registers');
const { toCsv, ContinuousLogger } = require('./csv');
const { Discovery, localSubnets } = require('./discovery');
const { HistoryStore, oneDriveRoots, folderInfo } = require('./historyStore');
const { detectModules } = require('./moduleDetect');
const { Autostart, BACKGROUND_ARG } = require('./autostart');

const DEFAULT_CONFIG = {
  host: '192.168.0.100',
  port: 502,
  unitId: 1,
  pollIntervalMs: 5000,              // while the window is open
  backgroundPollIntervalMs: 300000,  // while collecting without a window (5 min)
  timeoutMs: 3000,
  emanagerSigned: false,
  maxSamples: 20000,
  dataFolder: '',          // e.g. a folder inside the locally synced OneDrive
  storeEnabled: true,      // write polled data to dataFolder
  historyDays: 7,          // days of history to read from dataFolder
  loadHistoryOnStart: true,
  runInBackground: true,   // closing the window keeps collecting (tray / menu bar icon)
  connectOnStart: false,   // start polling as soon as the app starts
  backgroundHintShown: false,
  modules: { ambient: 1, emanager: 1, heatpump: 1, boiler: 1, buffer: 0, solar: 0, circuit: 1 },
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...c, modules: { ...DEFAULT_CONFIG.modules, ...(c.modules || {}) } };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

let win;
let config;
let tray = null;
let quitting = false;
let lastStatus = { connected: false, error: null };
let appNapBlocker = null;
const startedInBackground = process.argv.includes(BACKGROUND_ARG) || process.env.LWP_BACKGROUND === '1';
const ASSETS = path.join(__dirname, '..', 'assets');
let autostart;
const service = new ModbusService();
const logger = new ContinuousLogger();
const history = new HistoryStore();
const discovery = new Discovery();
discovery.on('progress', (p) => send('discovery:progress', p));
discovery.on('found', (r) => send('discovery:found', r));
let samples = [];

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

service.on('data', (sample) => {
  // Never mix simulated and real data in one session buffer.
  if (samples.length && samples[samples.length - 1].source !== sample.source) samples = [];
  samples.push(sample);
  const max = Number(config.maxSamples) || 20000;
  if (samples.length > max) samples.splice(0, samples.length - max);
  logger.write(sample);
  history.collect(sample);
  send('history:status', history.status());
  send('modbus:data', sample);
  updateTray();
});
service.on('status', (s) => {
  lastStatus = s;
  send('modbus:status', s);
  updateTray(true);
});

function saveConfigFile() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// ---------- Background collection ----------
const BACKGROUND_INTERVALS = [1, 2, 5, 10, 15, 30, 60].map((m) => m * 60000);

function fmtInterval(ms) {
  return ms % 60000 === 0 ? `${ms / 60000} min` : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
}

// Fast polling while the UI is open, slow polling in the background.
function applyPollInterval() {
  const ms = win
    ? Number(config.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs
    : Number(config.backgroundPollIntervalMs) || DEFAULT_CONFIG.backgroundPollIntervalMs;
  service.setPollInterval(Math.max(1000, ms));
}

function setBackgroundInterval(ms) {
  config.backgroundPollIntervalMs = ms;
  saveConfigFile();
  applyPollInterval();
  send('config:changed', config);
  updateTray(true);
}

function rememberCollecting(on) {
  if (!!config.collecting === on) return;
  config.collecting = on;
  saveConfigFile();
}

function startCollecting() {
  rememberCollecting(true);
  service.configure(config);
  applyPollInterval();
  service.start();
  lastStatus = { connected: false, error: null };
  send('modbus:running', true);
  updateTray(true);
}
function stopCollecting() {
  rememberCollecting(false);
  service.stop();
  lastStatus = { connected: false, error: null };
  send('modbus:running', false);
  updateTray(true);
}

function setRunInBackground(on) {
  config.runInBackground = !!on;
  saveConfigFile();
  send('config:changed', config);
  updateTray(true);
}
function setAutostart(on) {
  try { autostart.set(on); } catch (e) { dialog.showErrorBox('Start with my computer', e.message); }
  send('config:changed', config);
  updateTray(true);
  return autostart.isEnabled();
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
  if (process.platform === 'darwin') app.dock?.show();
  updateTray(true);
}

function trayState() {
  const h = history.status();
  if (!service.running) return { key: null, line: '○ Not collecting' };
  const name = service.device?.name || `${config.host}:${config.port}`;
  if (lastStatus.error && !service.connected) return { key: 'err', line: `⚠ Connection error – retrying (${config.host}:${config.port})` };
  if (!service.connected) return { key: 'wait', line: `◌ Connecting to ${config.host}:${config.port}…` };
  if (h.error) return { key: 'err', line: `⚠ Saving failed – ${name}` };
  return { key: 'ok', line: `● Collecting${service.source === 'simulator' ? ' SIMULATED data' : ''} – ${name} · every ${fmtInterval(service.pollIntervalMs)}` };
}

function saveLine() {
  const h = history.status();
  if (!config.dataFolder) return 'Not saved – no data folder selected';
  if (!config.storeEnabled) return 'Saving to data folder is off';
  if (h.error) return `Save failed: ${h.error}`;
  if (h.lastWrittenAt) return `Last saved ${new Date(h.lastWrittenAt).toLocaleTimeString()} · ${h.rowsWritten} five-minute samples this session`;
  return 'Saving a 5-minute average; live readings continue normally';
}

let lastMenuKey = '';
let lastMenuAt = 0;
function updateTray(force = false) {
  if (!tray) return;
  const st = trayState();
  const save = saveLine();
  // Rebuilding the menu on every poll is cheap but pointless; refresh at most every 2 s unless the state changed.
  const key = `${st.key}|${st.line}|${config.runInBackground}|${!!win}|${config.backgroundPollIntervalMs}`;
  if (!force && key === lastMenuKey && Date.now() - lastMenuAt < 2000) return;
  lastMenuKey = key;
  lastMenuAt = Date.now();
  const icon = process.platform === 'darwin'
    ? path.join(ASSETS, `trayTemplate${st.key ? `-${st.key}` : ''}.png`)
    : path.join(ASSETS, `tray${st.key ? `-${st.key}` : ''}.png`);
  tray.setImage(nativeImage.createFromPath(icon));
  tray.setToolTip(`LAMBDA Heat Pump Viewer\n${st.line}\n${save}`);
  const autostartOn = autostart.supported && autostart.isEnabled();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: st.line, enabled: false },
    { label: save, enabled: false },
    { type: 'separator' },
    { label: win ? 'Show LAMBDA Viewer' : 'Open LAMBDA Viewer', click: showWindow },
    service.running
      ? { label: 'Stop collecting', click: stopCollecting }
      : { label: 'Start collecting', click: startCollecting },
    { label: 'Open data folder', enabled: !!config.dataFolder, click: () => shell.openPath(config.dataFolder) },
    { type: 'separator' },
    { label: 'Keep collecting when the window is closed', type: 'checkbox', checked: !!config.runInBackground, click: (i) => setRunInBackground(i.checked) },
    {
      label: `Background interval: ${fmtInterval(config.backgroundPollIntervalMs)}`,
      submenu: [...new Set([...BACKGROUND_INTERVALS, config.backgroundPollIntervalMs])].sort((a, b) => a - b).map((ms) => ({
        label: `Every ${fmtInterval(ms)}`, type: 'radio', checked: ms === config.backgroundPollIntervalMs, click: () => setBackgroundInterval(ms),
      })),
    },
    { label: 'Start with my computer (in background)', type: 'checkbox', checked: autostartOn, enabled: autostart.supported, click: (i) => setAutostart(i.checked) },
    { type: 'separator' },
    { label: 'Quit (stop collecting)', click: () => { quitting = true; app.quit(); } },
  ]));
  // App Nap would throttle polling while no window is visible.
  const needBlocker = service.running && !win;
  if (needBlocker && appNapBlocker === null) appNapBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!needBlocker && appNapBlocker !== null) { powerSaveBlocker.stop(appNapBlocker); appNapBlocker = null; }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')));
  // Windows / Linux: left click opens the window, right click shows the menu. macOS always shows the menu.
  if (process.platform !== 'darwin') tray.on('click', showWindow);
  updateTray(true);
}

function backgroundHint() {
  if (config.backgroundHintShown || !Notification.isSupported()) return;
  const where = process.platform === 'darwin' ? 'menu bar' : 'taskbar (notification area)';
  new Notification({
    title: service.running ? 'Still collecting in the background' : 'LAMBDA Viewer keeps running',
    body: service.running
      ? `Heat pump data is still read and saved. Open the viewer or quit from the icon in the ${where}.`
      : `Start collecting, open the viewer or quit from the icon in the ${where}.`,
  }).show();
  config.backgroundHintShown = true;
  saveConfigFile();
}

function configureHistory() {
  history.configure({
    folder: config.dataFolder,
    enabled: config.storeEnabled,
    instances: buildInstances(config),
  });
}

async function loadHistory() {
  if (!config.dataFolder) return { ok: false, error: 'No data folder selected' };
  const days = Math.max(1, Number(config.historyDays) || 7);
  if (service.source === 'simulator') {
    return { ok: true, skipped: 'simulator', rows: 0, files: 0, days };
  }
  try {
    const r = await history.load({
      from: Date.now() - days * 86400000,
      source: 'device',
      instances: buildInstances(config),
      maxSamples: Number(config.maxSamples) || 20000,
      hourly: true,
    });
    // Keep live samples that are newer than the stored history; never mix with simulated data.
    const lastTs = r.samples.length ? r.samples[r.samples.length - 1].ts : 0;
    const live = samples.filter((s) => !s.history && s.source === 'device' && s.ts > lastTs);
    if (r.samples.length || !samples.some((s) => s.source === 'simulator')) {
      samples = [...r.samples, ...live];
      const max = Number(config.maxSamples) || 20000;
      if (samples.length > max) samples.splice(0, samples.length - max);
    }
    return { ok: true, hourly: true, rows: r.samples.length, totalRows: r.totalRows || 0, files: (r.jsonFiles || 0) + (r.csvFiles || 0), jsonFiles: r.jsonFiles || 0, csvFiles: r.csvFiles || 0, days };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerIpc() {
  // Strip enums of functions etc.: everything is plain data already.
  ipcMain.handle('app:getMeta', () => ({ moduleTypes: MODULE_TYPES }));
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:save', (_e, newConfig) => {
    const { autoStart, ...rest } = newConfig;
    config = { ...DEFAULT_CONFIG, backgroundHintShown: config.backgroundHintShown, ...rest, collecting: config.collecting };
    saveConfigFile();
    if (autoStart !== undefined && autostart.supported && autoStart !== autostart.isEnabled()) setAutostart(autoStart);
    const wasRunning = service.running;
    service.stop();
    service.configure(config);
    applyPollInterval();
    samples = [];
    configureHistory();
    if (logger.file) logger.start(logger.file, service.instances);
    if (wasRunning) service.start();
    updateTray(true);
    return config;
  });
  ipcMain.handle('instances:get', () => buildInstances(config));
  ipcMain.handle('modbus:start', () => { startCollecting(); return true; });
  ipcMain.handle('modbus:isRunning', () => service.running);
  ipcMain.handle('modbus:state', () => ({ running: service.running, connected: service.connected, source: service.source, device: service.device }));
  ipcMain.handle('modbus:stop', () => { stopCollecting(); return true; });
  ipcMain.handle('background:get', () => ({
    runInBackground: !!config.runInBackground,
    autostart: autostart.supported && autostart.isEnabled(),
    autostartSupported: autostart.supported,
    autostartFile: autostart.file,
    startedInBackground,
    platform: process.platform,
  }));
  ipcMain.handle('modbus:pollNow', async () => {
    try { await service.pollOnce(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('samples:get', () => samples);
  ipcMain.handle('samples:clear', () => { samples = []; return true; });
  ipcMain.handle('csv:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export CSV',
      defaultPath: `lambda-wp-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, toCsv(service.instances, samples));
    return { ok: true, filePath, rows: samples.length };
  });
  ipcMain.handle('log:start', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Continuous CSV log file',
      defaultPath: 'lambda-wp-log.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false };
    logger.start(filePath, service.instances);
    return { ok: true, filePath };
  });
  ipcMain.handle('log:stop', () => { logger.stop(); return true; });
  ipcMain.handle('log:status', () => ({ file: logger.file }));
  ipcMain.handle('history:status', () => history.status());
  ipcMain.handle('history:roots', () => oneDriveRoots());
  ipcMain.handle('history:folderInfo', (_e, folder) => folderInfo(folder));
  ipcMain.handle('history:load', () => loadHistory());
  ipcMain.handle('history:openFolder', () => (config.dataFolder ? shell.openPath(config.dataFolder) : ''));
  ipcMain.handle('history:chooseFolder', async () => {
    const roots = oneDriveRoots();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a OneDrive folder for heat pump data',
      defaultPath: config.dataFolder || (roots.find((r) => /personal/i.test(r.name)) || roots[0])?.path,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (canceled || !filePaths?.[0]) return { ok: false };
    return { ok: true, ...folderInfo(filePaths[0]) };
  });
  ipcMain.handle('modules:detect', async (_e, opts = {}) => {
    try {
      const r = await detectModules({
        host: opts.host || config.host,
        port: opts.port || config.port,
        unitId: opts.unitId || config.unitId,
        timeoutMs: Math.min(Number(config.timeoutMs) || 1500, 2000),
        onProgress: (p) => send('modules:progress', p),
      });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('discovery:subnets', () => localSubnets());
  ipcMain.handle('discovery:start', async (_e, opts) => {
    if (discovery.running) return { ok: false, error: 'A search is already running' };
    try { return { ok: true, ...(await discovery.run(opts)) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('discovery:cancel', () => { discovery.cancel(); return true; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'LAMBDA Heat Pump Viewer',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.on('closed', () => {
    win = null;
    applyPollInterval();
    if (config.runInBackground && !quitting) backgroundHint();
    updateTray(true);
  });
  applyPollInterval();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.LWP_DEVTOOLS) win.webContents.openDevTools();
}

if (process.env.LWP_USER_DATA) app.setPath('userData', process.env.LWP_USER_DATA);

// Only one instance collects data. Starting the app again (e.g. from the dock / start menu while it
// runs in the background) just opens the window of the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { if (!argv.includes(BACKGROUND_ARG)) showWindow(); });

  app.whenReady().then(() => {
    config = loadConfig();
    autostart = new Autostart({
      execPath: process.env.APPIMAGE || process.execPath, // AppImage runs from a temporary mount
      appPath: app.isPackaged ? '' : app.getAppPath(),
      dir: process.env.LWP_AUTOSTART_DIR || undefined,
      loginItems: app,
    });
    service.configure(config);
    configureHistory();
    registerIpc();
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(path.join(ASSETS, 'icon.png')));
    createTray();
    // Resume collecting if it was running when the app was quit (update, crash, restart).
    if (startedInBackground || config.connectOnStart || config.collecting || process.env.LWP_AUTOSTART) startCollecting();
    // After sleep the old TCP connection is dead: reconnect and poll right away.
    powerMonitor.on('resume', () => service.wake());
    powerMonitor.on('unlock-screen', () => service.wake());
    if (!startedInBackground) createWindow();
  });

  app.on('before-quit', () => { quitting = true; });

  // macOS: clicking the dock icon reopens the window.
  app.on('activate', () => { if (!win) showWindow(); });

  app.on('window-all-closed', () => {
    if (config.runInBackground && !quitting) return; // keep collecting, tray icon stays
    service.stop();
    app.quit();
  });
}
