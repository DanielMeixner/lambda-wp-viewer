'use strict';
// "Start with my computer": registers the app to launch at login in background mode (--background).
//   macOS:   ~/Library/LaunchAgents/<label>.plist (works for `npm start` and for a packaged app)
//   Windows: login item in the registry Run key (app.setLoginItemSettings)
//   Linux:   ~/.config/autostart/<name>.desktop
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKGROUND_ARG = '--background';
const LABEL = 'de.lambda-wp.viewer';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quote = (s) => `"${String(s).replace(/(["\\`$])/g, '\\$1')}"`;

class Autostart {
  /**
   * @param {object} o
   * @param {string} o.execPath  executable to launch (Electron binary or packaged app)
   * @param {string} [o.appPath] app folder to pass to Electron when not packaged
   * @param {string} [o.platform]
   * @param {string} [o.dir]     override for the LaunchAgents / autostart folder (tests)
   * @param {object} [o.loginItems] Electron `app` (Windows login items)
   */
  constructor({ execPath, appPath = '', platform = process.platform, dir, loginItems } = {}) {
    this.execPath = execPath;
    this.appPath = appPath;
    this.platform = platform;
    this.loginItems = loginItems;
    this.dir = dir || (platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'LaunchAgents')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart'));
  }

  get args() { return [...(this.appPath ? [this.appPath] : []), BACKGROUND_ARG]; }

  get file() {
    if (this.platform === 'darwin') return path.join(this.dir, `${LABEL}.plist`);
    if (this.platform === 'linux') return path.join(this.dir, 'lambda-wp-viewer.desktop');
    return null;
  }

  get supported() { return ['darwin', 'linux'].includes(this.platform) || (this.platform === 'win32' && !!this.loginItems); }

  isEnabled() {
    if (this.platform === 'win32') {
      return !!this.loginItems?.getLoginItemSettings({ path: this.execPath, args: this.args }).openAtLogin;
    }
    try { return fs.readFileSync(this.file, 'utf8').includes(BACKGROUND_ARG); } catch { return false; }
  }

  set(enabled) {
    if (this.platform === 'win32') {
      this.loginItems?.setLoginItemSettings({ openAtLogin: !!enabled, path: this.execPath, args: this.args });
      return this.isEnabled();
    }
    if (!this.file) throw new Error(`Autostart is not supported on ${this.platform}`);
    if (!enabled) {
      fs.rmSync(this.file, { force: true });
      return false;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, this.platform === 'darwin' ? this.plist() : this.desktopEntry());
    return true;
  }

  plist() {
    const args = [this.execPath, ...this.args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
  }

  desktopEntry() {
    return `[Desktop Entry]
Type=Application
Name=LAMBDA Heat Pump Viewer
Comment=Collects heat pump data in the background
Exec=${[this.execPath, ...this.args].map(quote).join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
  }
}

module.exports = { Autostart, BACKGROUND_ARG };
