# LAMBDA Heat Pump Viewer

A read-only desktop viewer for LAMBDA heat pumps. It reads the heat pump over Modbus TCP and runs locally with no server. Built with Electron, [`modbus-serial`](https://www.npmjs.com/package/modbus-serial) and [Chart.js](https://www.chartjs.org/).

The register map follows *"Modbus Beschreibung und Protokoll"* (09.09.2021, published by LAMBDA Wärmepumpen; the PDF is not part of this repository).

## Download & install
Get the installer for your system from the [latest release](https://github.com/DanielMeixner/lambda-wp-viewer/releases/latest):

| System | File | Notes |
|---|---|---|
| macOS (Intel + Apple Silicon) | `LAMBDA-Viewer-<version>-mac-universal.dmg` | The app is not code-signed. On first start, right-click → **Open**, or allow it under *System Settings → Privacy & Security*. |
| Windows | `LAMBDA-Viewer-<version>-win-x64.exe` | SmartScreen may warn: click **More info → Run anyway**. |
| Linux | `LAMBDA-Viewer-<version>-linux-x86_64.AppImage` | `chmod +x` the file, then run it. |

### Building a release
Pushing a tag such as `v1.0.1` starts `.github/workflows/release.yml`. It runs the tests and builds the installers on macOS, Windows and Linux with [electron-builder](https://www.electron.build/), then publishes them as a GitHub release:
```bash
npm version patch          # bumps package.json and creates the tag
git push --follow-tags
```
To build locally, run `npm run dist`. The output goes to `dist/`.

## Features
- Shows **every documented datapoint**:
  - Ambient and E-Manager
  - Heat pump 1–3, Boiler 1–5, Buffer 1–5, Solar 1–2
  - Heating circuit 1–12
- Values are scaled to their units (0.1 °C, 0.01 °C, l/min, W, kW, %, COP), and state codes are shown as text.
- **Read-only**: the app only sends read requests: function code 0x03 (read holding registers), plus a single 0x2B/0x0E (read device identification) per connection to get the device name. It never writes to the heat pump.
- Reads are batched per module, and the app reconnects automatically. The device closes idle connections after 1 min. With longer (background) intervals the app connects again for each poll.
- **Overview** (default tab): KPI tiles with sparklines and min/max/trend, then **one section per installed module, each with its own chart(s)**. Click the module chips at the top to jump to a section.
  - Heat pumps: gauges (compressor, COP, heat output), volume flow & compressor, temperatures, performance.
  - Outdoor temperature (actual, 1 h average, calculated).
  - E-Manager: power, consumption, setpoint.
  - Each boiler and buffer: top/bottom vs. max setting.
  - Each solar module: collector, buffers, max and changeover temperatures.
  - Each heating circuit: flow vs. setpoint, return, room vs. room setpoint.
  - With more than one storage, a *Comparison* bar chart shows the current storage temperatures side by side.
- **All values**: every register, shown as a card per module.
- **Trends**: pick any numeric datapoints and a time window. Each unit gets its own Y-axis.
- **Data source is always clearly shown** in a banner under the header:
  - 🟢 **LIVE DATA – REAL HEAT PUMP**: connected to a real device.
  - 🟧 **SIMULATED DATA** (striped warning banner): connected to the bundled simulator. Every card and chart also gets a `SIM` tag and a "SIMULATED DATA" watermark.
  - ⬜ **NOT CONNECTED – OUTDATED VALUES**: the last values stay visible but greyed out, with their timestamp and source.

  The simulator answers a marker register (`9998–9999` = `"SIM!"`), and the app checks it on every connect. Real LAMBDA controllers only use index 0–5, so they reject it. Simulated and real samples are never mixed, and the CSV has a `source` column (`device` / `SIMULATED`).
- **CSV**: export all session data, or append every poll to a CSV file continuously.

## Charts

- **Axes:** every chart has a titled time axis (`Time (hh:mm)`, `Time (hh:mm:ss)` or `Time (date, hh:mm)`) with evenly spaced ticks, and y axes titled with quantity and unit, e.g. `Temperature [°C]` or `Power [kW]`.
- **Time period:** every chart states the period it shows, e.g. `16.10.2026 12:57:00 – 14:45:00 (1 h 48 min)`. KPI tiles show it below the sparkline; gauges and the storage chart show the time of the sample they display.
- **Only real data:**
  - The time axis spans only the range that actually has data.
  - When there is no sample for longer than 3× the poll interval the data was read with (at least 30 s), lines are not connected. The gap is shown as a hatched **no data** band.
  - Lines never overshoot between samples (monotone interpolation), and single isolated samples are drawn as dots.
- **No value, nothing shown:**
  - Missing or failed values are never drawn, listed in tooltips, or replaced by an older value.
  - KPI tiles and gauges show **no data** when the latest sample lacks the value.
  - Register contents that mean "no value" (`0x8000` / `0x7FFF` for signed registers, `0xFFFF` for unsigned registers) are treated as missing, for example an unconnected sensor that would otherwise read −3276.8 °C. E-Manager power registers are excluded because their sign depends on the installation.
  - Such values are written to CSV as empty cells and ignored when history is loaded.

## Usage
```bash
npm install
npm start
```
1. Open **Settings** and enter the IP address of the heat pump display. The port is 502 and the unit ID is usually 1.
2. Enter how many modules of each type your installation has. The numbering follows the order in the heat pump's configuration module.
3. Save, then click **Connect**.

## Background collection (no window)

The app can keep reading and saving data without its window, so the charts show the full history when you open it.

- **Keep collecting when the window is closed** (Settings → *Background collection*, on by default):
  - Closing the window only closes the UI. Polling and saving to the data folder continue.
  - A heat pump icon stays in the **menu bar** (macOS) or **taskbar notification area** (Windows/Linux). On macOS the dock icon also stays.
  - The icon shows the state: filled dot = collecting, ring / amber = connecting, red = error, no dot = not collecting.
  - **Tray menu:**
    - Status and last save time
    - *Open LAMBDA Viewer*
    - *Start/Stop collecting*
    - *Open data folder*
    - The two background options below
    - *Quit (stop collecting)*
  - On Windows/Linux, left-clicking the icon opens the window.
  - The first time the window is closed, a notification explains this.
  - Quitting with ⌘Q, or from the tray menu, really quits.
- **Poll intervals:**
  - Every **5 s** while the window is open (*Poll interval – window open*).
  - Every **5 min** in the background (*Poll interval – in the background*). You can change it in Settings or in the tray menu (*Background interval*: 1–60 min).
  - Opening the window polls immediately and switches to the fast interval; closing it switches back.
  - The device drops connections after 1 min without requests, so with intervals over 50 s the app connects for each poll and disconnects afterwards. The app still shows it as connected. After an error it retries within a minute.
  - Each saved row records its poll interval (CSV column `poll interval [s]`). The charts use it so that 5-minute background spacing isn't shown as a gap; only pauses longer than 3× the interval (at least 30 s) appear as *no data*.
- **Start with my computer:** starts the app at login in the background (`--background`), without a window, and begins collecting immediately.
  - macOS: a LaunchAgent `~/Library/LaunchAgents/de.lambda-wp.viewer.plist`
  - Windows: a login item
  - Linux: `~/.config/autostart/lambda-wp-viewer.desktop`

  It works both with `npm start` (it registers Electron plus this folder) and with a packaged app. If you move the project folder, untick and re-tick the option.
- **Connect automatically when the app is opened:** starts polling on a normal start, too.
- **Opening the UI:** starting the app again (dock, start menu, `npm start`) opens the window of the running instance; only one instance collects. The window then loads the history (setting *History to load*) from the data folder, including everything collected in the background, and fits the chart window to it.
- On macOS, App Nap is disabled while collecting without a window, so the poll interval is kept. If the computer goes to sleep, the charts show the gap as *no data*.
- Without a data folder, background data is only kept in memory (up to *Max. session samples*).

```bash
npm start -- --background   # start in the background manually
```

## Detecting installed modules

The number of installed modules (heat pumps, boilers, buffers, solar, heating circuits) doesn't have to be entered by hand:

- **Settings → Installed modules → 🔎 Detect from heat pump** reads the device and shows the result with the evidence for each slot. **Apply & save** takes it over.
- When you pick a LAMBDA device in **🔍 Search** and click **Use & connect**, the modules are detected and applied automatically.

How it works (read-only, FC 0x03): module slots are probed in order (subindex 0, 1, 2, …). A slot is considered *installed* when its live registers (numbers 0–49) return plausible values: valid state enums and temperatures, flows and percentages within realistic ranges. It is considered *absent* when the device answers with an exception or doesn't answer, when all registers are 0 or empty (0xFFFF/0x8000), or when the values are implausible. Because modules of one type are numbered without gaps, probing stops at the first absent slot.

The PDF doesn't document how the controller answers for unconfigured modules, so the result is a heuristic. Check it and correct the counts if needed. Heating circuits 11–12 (subindex > 9) can't be detected.

## OneDrive data folder (history)

In **Settings → ☁ OneDrive data folder**, click **📁 Choose…** and pick a folder inside your locally synced OneDrive, for example `~/Library/CloudStorage/OneDrive-Personal/LambdaWP` on macOS or `%OneDrive%\LambdaWP` on Windows. The OneDrive app uploads and downloads the files, so the app itself needs no Microsoft sign-in. Under the field, the app tells you whether the folder is inside OneDrive, local only, missing or not writable.

- **Saving**: every data query (poll) is appended as one row to one CSV file per day, `lambda-wp-YYYY-MM-DD.csv`, in the same format as the CSV export. The poll interval therefore sets the resolution; at 5 s that is about 25 MB per day.
  - If the module configuration changes, a new header line is added to the file.
  - Simulated data is written to the `simulated/` subfolder and is never loaded as history.
- **History**:
  - On start, or with **⟳ Load history now**, the last *N* days (setting **History to load**) are read from the folder and shown in all charts. Several devices or computers can share the folder.
  - Columns are matched by name with the current module settings; unknown columns are ignored.
  - Large ranges are thinned out evenly to the *Max. session samples* setting.
  - The chart window widens automatically so the history is visible; *7 days* and *30 days* options were added.
- While only history is shown, the banner says **NOT CONNECTED – OUTDATED VALUES**.
- The chip above the Overview charts shows how many stored samples were loaded and how many rows were saved.
- **Save indicator** in the header (visible on every tab):

  | Indicator | Meaning |
  |---|---|
  | 🟢 **💾 Saved 14:37:05** (flashes on every write) | A row was just written. Hover to see the file and the number of rows written this session; click to open the folder. |
  | 🔵 **💾 Ready** | Folder set; the next query will be saved. |
  | 🟡 **💾 Not saved** | No folder selected. Data is only kept for this session; click to open Settings. |
  | ⚪ **💾 Saving off** | Saving is switched off in Settings. |
  | 🔴 **💾 Save failed** | The write failed; hover for the error. |

## Device name

Once connected, the app shows the device name in the banner, the status line and the window title. The name comes from the first of these that is available:
1. Modbus *Read Device Identification* (FC 0x2B/0x0E, read-only): vendor, product, version and application name. The PDF doesn't document this request, so a heat pump may not support it.
2. The reverse-DNS hostname of the IP address (for example the name your router assigned).
3. A generic label: "LAMBDA heat pump" or "LAMBDA simulator".

## Search device (unknown IP address)

Click **🔍 Search** in the header or **Search device…** in Settings.

How the search works:
1. It scans your computer's local IPv4 network(s) for an open Modbus TCP port (default 502). Localhost is checked as well. Networks larger than /22 are reduced to the /24 around your own address.
2. Every host with an open port gets a short, **read-only** probe (FC 0x03).
3. Each result is labelled:
   - **LAMBDA**: registers 1000–1004 return a valid heat pump state.
   - **SIMULATOR**: the fake-data marker is present.
   - **MODBUS**: some other Modbus device.
4. **Use & connect** stores host, port and unit ID and starts polling.

You can override the scanned range with your own subnets, for example `192.168.1.0/24, 10.0.0.20`.

Requirements: Modbus TCP must be enabled on the heat pump display, and the heat pump must be on the same network as this computer.

## Testing without a heat pump
```bash
npm run simulator        # Modbus TCP simulator on 0.0.0.0:5020
npm start                # then set host 127.0.0.1, port 5020 in Settings
npm test                 # headless self-test (register map, decoding, polling, CSV, discovery, history, module detection)
```
By default the simulator has 2 heat pumps, 1 boiler, 1 buffer, no solar module and 4 heating circuits. Override this with `SIM_MODULES="heatpump=3,circuit=2"` (or `all`). Set `SIM_ABSENT=zero` to make absent modules answer with 0 instead of an exception.

## Addressing
`register = Index·1000 + Subindex·100 + Number`. For example, the flow temperature of heat pump 2 is `1·1000 + 1·100 + 4 = 1104`.

| Module | Index | Subindex |
|---|---|---|
| Ambient / E-Manager | 0 | 0 / 1 |
| Heat pump 1–3 | 1 | 0–2 |
| Boiler 1–5 | 2 | 0–4 |
| Buffer 1–5 | 3 | 0–4 |
| Solar 1–2 | 4 | 0–1 |
| Heating circuit 1–12 | 5 | 0–11 |

## Notes
- Heating circuits 11–12 need subindex 10–11, which the PDF's one-digit addressing scheme doesn't cover. The app still uses the formula above (6000+ / 6100+), and the card shows a warning.
- E-Manager register 0102 can be UINT16 (input power) or INT16 (excess power), depending on the device's settings. Choose the matching option in Settings.
- Config is stored in Electron's userData folder (`config.json`).

## Structure
```
src/registers.js        register map from the PDF + address/decoding helpers
src/discovery.js       network search / device identification
src/moduleDetect.js    detects installed modules by probing module slots
src/historyStore.js    daily CSV files in the (OneDrive) data folder: write + load history
src/modbusService.js    Modbus TCP poller (main process)
src/csv.js              CSV export / continuous logger
src/main.js, preload.js Electron main process (tray, background mode) + IPC bridge
src/autostart.js        "Start with my computer" (LaunchAgent / login item / XDG autostart)
src/renderer/           UI (dashboard, trends, settings); chartUtil.js holds shared axis/period/gap helpers
tools/simulator.js      local Modbus TCP simulator
tools/selftest.js       headless test
tools/make-icons.js     generates the λ (lambda) app / tray icons in assets/ (node tools/make-icons.js)
```
