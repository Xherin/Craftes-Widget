const { app, BrowserWindow, screen, ipcMain, net, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodeNet = require('net'); // nazwany potok helpera admina (net z electrona to HTTP)

// ---- Sensory: OpenHardwareMonitorLib + WinRing0, wszystko w folderze ./ohm ----
// Nic nie jest pobierane ani budowane w trakcie dzialania. Helper (ohm/ohmhelper/ohmhelper.exe)
// buduje sie raz skryptem ohm/build.cmd. Sterownik WinRing0 biblioteka wypakowuje obok exe
// (ohm/ohmhelper/ohmhelper.sys), a tryb admina przesyla odczyty nazwanym potokiem.
// W spakowanej aplikacji (asar) pliki .exe musza lezec w app.asar.unpacked.
const OHM_DIR = path.join(__dirname, 'ohm').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const HELPER_EXE = path.join(OHM_DIR, 'ohmhelper', 'ohmhelper.exe');
const HELPER_DIR = path.dirname(HELPER_EXE);
const SENSOR_INTERVAL = 2000;
const STALE_MS = SENSOR_INTERVAL * 5;

const WIDTH = 380;
// Wersja deweloperska: config.json w folderze projektu; spakowana: obok Craftes Widget.exe
// (wnetrze app.asar jest tylko do odczytu).
const CONFIG_FILE = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, 'config.json');

let mainWindow = null;
let tray = null;
let quitting = false;

// ---- ustawienia okna (config.json w folderze projektu) ----
const config = Object.assign({ snap: true, alwaysOnTop: true }, readConfig());
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig() {
  fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)).catch(() => {});
}

// Monitor docelowy: drugi monitor (nie-glowny; przy kilku - najbardziej z prawej), inaczej glowny.
function targetDisplay() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter(d => d.id !== primary.id);
  if (!others.length) return primary;
  return others.reduce((a, b) => (b.bounds.x > a.bounds.x ? b : a));
}

// Przyklejony: cala wysokosc obszaru roboczego (bez paska zadan), prawa krawedz, stala szerokosc.
function snappedBounds() {
  const wa = targetDisplay().workArea;
  return { x: wa.x + wa.width - WIDTH, y: wa.y, width: WIDTH, height: wa.height };
}
function floatingBounds() {
  const d = targetDisplay();
  return {
    x: d.bounds.x + d.bounds.width - WIDTH - 12,
    y: d.bounds.y + 20,
    width: WIDTH,
    height: Math.min(d.workArea.height - 40, 960)
  };
}

function applySnap() {
  if (!mainWindow) return;
  const snap = config.snap;
  mainWindow.setResizable(true); // setBounds na niezmiennym oknie bywa ignorowany
  mainWindow.setBounds(snap ? snappedBounds() : floatingBounds());
  mainWindow.setResizable(!snap);
  mainWindow.setMovable(!snap);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...(config.snap ? snappedBounds() : floatingBounds()),
    transparent: true,
    frame: false,
    alwaysOnTop: config.alwaysOnTop,
    resizable: !config.snap,
    movable: !config.snap,
    skipTaskbar: true, // widget zyje w zasobniku
    minWidth: 300,
    minHeight: 400,
    hasShadow: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  // Okno ma dostep do Node.js, wiec nie moze nigdy wyswietlic obcej tresci:
  // zadnej nawigacji, nowych okien, webview ani prosb o uprawnienia (kamera, mikrofon, lokalizacja...)
  const wc = mainWindow.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  wc.session.setPermissionCheckHandler(() => false);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // × (i Alt+F4) chowa do zasobnika; zamkniecie tylko z menu zasobnika
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    updateTrayMenu();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('show', updateTrayMenu);
}

function toggleWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
  updateTrayMenu();
}

// ---- autostart z Windows (wpis w rejestrze uzytkownika) ----
function loginItemArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}
function getAutostart() {
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
}
function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginItemArgs() });
}

// ---- zasobnik systemowy ----
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')); // + tray@2x.png
  tray = new Tray(img);
  tray.setToolTip('Widget Dashboard');
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = !!(mainWindow && mainWindow.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Schowaj widget' : 'Pokaż widget', click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Przyklej do prawej krawędzi', type: 'checkbox', checked: config.snap,
      click: (item) => { config.snap = item.checked; saveConfig(); applySnap(); }
    },
    {
      label: 'Zawsze na wierzchu', type: 'checkbox', checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked; saveConfig();
        if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
      }
    },
    {
      label: 'Uruchamiaj z Windows', type: 'checkbox', checked: getAutostart(),
      click: (item) => setAutostart(item.checked)
    },
    { type: 'separator' },
    {
      label: 'Odśwież wszystko',
      click: () => { if (mainWindow) mainWindow.webContents.send('refresh-all'); }
    },
    { label: 'Zamknij', click: () => { quitting = true; app.quit(); } }
  ]));
}

// ---- HTTP z cache (20 s) i laczeniem rownoleglych zapytan o ten sam URL ----
const CACHE_MS = 20000;
const cache = new Map();    // url -> { time, data }
const inflight = new Map(); // url -> Promise

function fetchJson(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < CACHE_MS) return Promise.resolve(cached.data);
  if (inflight.has(url)) return inflight.get(url);

  const p = new Promise((resolve, reject) => {
    const request = net.request(url);
    request.setHeader('User-Agent', 'WidgetDashboard/0.25');
    const chunks = [];
    request.on('response', (res) => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new Error('parse')); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        // przy okazji wyrzuc przeterminowane wpisy, zeby mapa nie rosla
        const now = Date.now();
        for (const [k, v] of cache) if (now - v.time >= CACHE_MS) cache.delete(k);
        cache.set(url, { time: now, data: parsed });
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.end();
  }).finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

const BINANCE_MAP = {
  bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT',
  dogecoin: 'DOGEUSDT', cardano: 'ADAUSDT', ripple: 'XRPUSDT'
};
const enc = encodeURIComponent;

ipcMain.handle('crypto-price', async (e, { symbol, vs }) => {
  const sym = BINANCE_MAP[symbol.toLowerCase()];
  if (sym && vs === 'usd') {
    try {
      const t = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
      return { price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent) };
    } catch {}
  }
  const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${enc(symbol)}&vs_currencies=${enc(vs)}&include_24hr_change=true`);
  const c = data[symbol];
  if (!c || c[vs] == null) throw new Error('brak danych');
  return { price: c[vs], change: c[`${vs}_24h_change`] };
});

// Wykres jako dwie plaskie tablice { t: czasy (ms), p: ceny } - czas potrzebny do podpisu przy najechaniu.
function series(pairs) {
  const t = [], p = [];
  for (const [time, price] of pairs) {
    if (price == null || Number.isNaN(price)) continue;
    t.push(time);
    p.push(price);
  }
  return { t, p };
}

ipcMain.handle('crypto-chart', async (e, { symbol, vs, range }) => {
  const sym = BINANCE_MAP[symbol.toLowerCase()];
  const hours = parseInt(range) || 24;
  if (sym && vs === 'usd') {
    try {
      const interval = hours <= 1 ? '1m' : hours <= 4 ? '5m' : '15m';
      const limit = Math.min(hours * (hours <= 1 ? 60 : hours <= 4 ? 12 : 4), 500);
      const k = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
      // czas zamkniecia swiecy (x[6]) - cena zamkniecia odpowiada temu momentowi
      return series(k.map(x => [x[6] + 1, parseFloat(x[4])]));
    } catch {}
  }
  const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${enc(symbol)}/market_chart?vs_currency=${enc(vs)}&days=1`);
  const from = Date.now() - hours * 3600 * 1000;
  return series((data.prices || []).filter(p => p[0] >= from));
});

// ---- Akcje (Yahoo Finance, bez klucza): cena, zmiana dzienna, waluta i wykres w jednym zapytaniu ----
const STOCK_RANGES = {
  '1d': { range: '1d', interval: '5m' },
  '5d': { range: '5d', interval: '30m' },
  '1mo': { range: '1mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1y': { range: '1y', interval: '1wk' }
};

ipcMain.handle('stock-data', async (e, { symbol, range }) => {
  const r = STOCK_RANGES[range] || STOCK_RANGES['1d'];
  const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${enc(symbol.toUpperCase())}?range=${r.range}&interval=${r.interval}`);
  const res = data && data.chart && data.chart.result && data.chart.result[0];
  if (!res) throw new Error((data && data.chart && data.chart.error && data.chart.error.description) || 'nie znaleziono');
  const m = res.meta || {};
  const price = m.regularMarketPrice;
  if (price == null) throw new Error('brak danych');
  const prev = m.previousClose ?? (range === '1d' ? m.chartPreviousClose : null);
  const change = m.regularMarketChangePercent ?? (prev ? (price - prev) / prev * 100 : null);
  const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const times = res.timestamp || [];
  // czy trwa sesja (godziny regularnego handlu dzisiaj / ostatniego dnia sesyjnego)
  const reg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const nowS = Date.now() / 1000;
  const marketOpen = reg ? nowS >= reg.start && nowS < reg.end : null;
  return {
    price,
    change,
    currency: m.currency || 'USD',
    name: m.shortName || m.longName || m.symbol,
    marketOpen,
    lastTrade: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    prices: series(closes.map((c, i) => [times[i] * 1000, c]))
  };
});

// ---------------------------------------------------------------------------
// SensorService: jeden staly proces helpera. Dwa tryby:
//  - 'pipe'     : helper jako dziecko, JSON-y na stdout (bez admina: GPU + obciazenie,
//                 z adminem: wszystko, bo dziedziczy uprawnienia widgetu)
//  - 'elevated' : helper uruchomiony przez UAC, odczyty nazwanym potokiem, sam konczy
//                 prace gdy zamknie sie widget (--parent PID)
// Odczyty sa wypychane do okna ('temps') tylko gdy cos sie zmienilo - renderer nie odpytuje.
// ---------------------------------------------------------------------------
const sensors = {
  mode: 'off',
  child: null,
  last: null,
  lastAt: 0,
  error: null,
  restartTimer: null,
  restarts: 0,
  quitting: false
};
let lastSent = '';

// pola pomiarowe - zerowane (null), gdy helper przestal przysylac dane
const LIVE_FIELDS = ['cpu', 'gpu', 'cpuLoad', 'gpuLoad', 'vramUsed', 'vramTotal', 'ramUsed', 'ramTotal',
  'topCpuName', 'topCpu', 'topRamName', 'topRam', 'topGpuName', 'topGpu'];

function snapshot() {
  const d = sensors.last || {};
  const maxAge = sensors.mode === 'elevated' ? ELEVATED_STALE_MS : STALE_MS;
  const stale = !sensors.lastAt || Date.now() - sensors.lastAt > maxAge;
  const snap = {};
  for (const k of LIVE_FIELDS) snap[k] = stale ? null : d[k] ?? null;
  return {
    ...snap,
    cpuName: d.cpuName || null,
    gpuName: d.gpuName || null,
    admin: !!d.admin,
    ring0: !!d.ring0,
    driver: d.driver || null,
    mode: sensors.mode,
    error: sensors.error
  };
}

function publish(force) {
  const snap = snapshot();
  const json = JSON.stringify(snap);
  if (!force && json === lastSent) return;
  lastSent = json;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('temps', snap);
}

function setSensorData(data) {
  sensors.last = data;
  sensors.lastAt = Date.now();
  sensors.error = data && data.error ? data.error : null;
  publish();
  // raport, gdy sterownik nie wstal: zapisuje go widget (zwykle uprawnienia), nie proces admina
  if (data && data.driverReport && data.driverReport !== sensors.driverReport) {
    sensors.driverReport = data.driverReport;
    fsp.writeFile(path.join(HELPER_DIR, 'driver.log'), String(data.driverReport)).catch(() => {});
  }
}

function setError(msg) {
  sensors.error = msg;
  publish();
}

function startPipeHelper() {
  if (sensors.child || sensors.quitting) return;
  if (!fs.existsSync(HELPER_EXE)) return setError('Brak ohm/ohmhelper/ohmhelper.exe - uruchom ohm/build.cmd');

  sensors.mode = 'pipe';
  const child = spawn(HELPER_EXE, ['--loop', String(SENSOR_INTERVAL)], {
    cwd: HELPER_DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  sensors.child = child;

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line[0] !== '{') continue;
      try { sensors.restarts = 0; setSensorData(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => console.error('[ohmhelper]', d.trim()));
  child.on('error', err => setError('helper: ' + err.message));
  child.on('exit', code => {
    if (sensors.child === child) sensors.child = null;
    if (sensors.quitting || sensors.mode !== 'pipe') return;
    // automatyczny restart z rosnacym opoznieniem
    const delay = Math.min(30000, 2000 * Math.pow(2, sensors.restarts++));
    clearTimeout(sensors.restartTimer);
    sensors.restartTimer = setTimeout(startPipeHelper, delay);
    setError(`helper zakonczyl prace (kod ${code}), restart za ${Math.round(delay / 1000)} s`);
  });
}

function stopPipeHelper() {
  clearTimeout(sensors.restartTimer);
  const child = sensors.child;
  sensors.child = null;
  if (!child) return;
  try { child.stdin.end('quit\n'); } catch {}
  // jesli nie zamknie sie sam (Close() sprzata sterownik), dobij po 3 s
  setTimeout(() => { try { child.kill(); } catch {} }, 3000).unref();
}

// ---------------------------------------------------------------------------
// Helper administratora (UAC) wysyla odczyty nazwanym potokiem, ktory tworzy widget:
//  - proces admina nie zapisuje zadnych plikow z danymi w folderze projektu,
//  - nazwa potoku jest losowa (128 bitow), a libuv tworzy go jako "pierwsza instancje" - inny
//    program nie moze go wczesniej przejac; helper laczy sie z poziomem Identification,
//    wiec serwer potoku nie moze uzyc jego tokenu administratora,
//  - zamkniecie widgetu zamyka potok, a helper konczy prace (sterownik jest wtedy wyladowywany).
// ---------------------------------------------------------------------------
const elev = { server: null, pipeName: null, sock: null };

// Helper admina z wlaczonym sterownikiem (nie "pusta" kopia bez dostepu do niego)
const isElevatedData = d => !!(d && d.admin && d.driver !== 'other-instance');

function ensureElevPipe() {
  if (elev.server) return Promise.resolve();
  const name = 'craftes-widget-' + crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const srv = nodeNet.createServer(onElevConnection);
    srv.once('error', reject);
    srv.listen(`\\\\.\\pipe\\${name}`, () => {
      srv.removeListener('error', reject);
      srv.on('error', e => console.error('[potok]', e.message));
      elev.server = srv;
      elev.pipeName = name;
      resolve();
    });
  });
}

function onElevConnection(sock) {
  if (elev.sock) { sock.destroy(); return; } // tylko jeden helper administratora naraz
  elev.sock = sock;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', chunk => {
    buf += chunk;
    if (buf.length > 1 << 20) { sock.destroy(); return; } // zabezpieczenie przed zalaniem pamieci
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line[0] !== '{') continue;
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      if (!isElevatedData(data)) continue;
      if (sensors.mode !== 'elevated') { // pierwszy odczyt - przejmujemy (takze spozniony helper)
        sensors.mode = 'elevated';
        stopPipeHelper();
      }
      setSensorData(data);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (elev.sock === sock) elev.sock = null;
    if (sensors.mode !== 'elevated' || sensors.quitting) return;
    // helper administratora zakonczyl prace -> wracamy do trybu bez admina
    sensors.mode = 'pipe';
    sensors.last = null; // bez "zawieszonych" odczytow admina do czasu pierwszego odczytu bez admina
    sensors.lastAt = 0;
    setError('Helper (admin) przestal odpowiadac');
    startPipeHelper();
  });
}

function stopElevPipe() {
  if (elev.sock) { try { elev.sock.destroy(); } catch {} elev.sock = null; } // helper skonczy prace
  if (elev.server) { try { elev.server.close(); } catch {} elev.server = null; }
}

function runElevated() {
  return new Promise(resolve => {
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const helperArgs = `--loop ${SENSOR_INTERVAL} --pipe ${elev.pipeName} --parent ${process.pid}`;
    const ps = `Start-Process -FilePath ${q(HELPER_EXE)} -WorkingDirectory ${q(HELPER_DIR)} ` +
      `-ArgumentList ${q(helperArgs)} -Verb RunAs -WindowStyle Hidden`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', e => resolve({ ok: false, error: e.message }));
    p.on('exit', code => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: /cancel|anulowa/i.test(err) ? 'Anulowano UAC' : (err.trim().split('\n')[0] || `kod ${code}`) });
    });
  });
}

// Pierwszy odczyt helpera admina moze sie spoznic (start Windows, JIT, inicjalizacja czujnikow)
const ELEVATED_START_MS = 90000;
// W trybie admina jeden spozniony odczyt (obciazony system) nie oznacza, ze helper padl
const ELEVATED_STALE_MS = 30000;
let elevatePromise = null;

// Jedno uruchomienie naraz: kolejne klikniecia czekaja na to samo zamiast otwierac nowe okno UAC
function startElevatedHelper() {
  if (!elevatePromise) elevatePromise = startElevatedHelperOnce().finally(() => { elevatePromise = null; });
  return elevatePromise;
}

async function startElevatedHelperOnce() {
  if (sensors.mode === 'elevated') return { ok: true };
  if (!fs.existsSync(HELPER_EXE)) return { ok: false, error: 'Brak ohmhelper.exe' };
  try { await ensureElevPipe(); } catch (e) { return { ok: false, error: 'potok: ' + e.message }; }

  // helper z wczesniejszej proby jest juz polaczony - tylko czekamy na jego odczyt (bez UAC)
  if (!elev.sock) {
    const r = await runElevated();
    if (!r.ok) return r;
  }

  // czekamy na pierwszy odczyt; spozniony helper zostanie przejety sam (onElevConnection)
  const t0 = Date.now();
  while (Date.now() - t0 <= ELEVATED_START_MS) {
    await new Promise(res => setTimeout(res, 500));
    if (sensors.mode === 'elevated') return { ok: true };
  }
  return { ok: false, error: 'helper administratora nie odpowiedział w ciągu 90 s' };
}

ipcMain.handle('get-temps', () => snapshot());

// ---------------------------------------------------------------------------
// MediaService: mediahelper.exe (Windows Media Session) - uruchamiany tylko gdy na pulpicie
// jest widget muzyki. Stan wypychany do okna ('media'), komendy przez stdin.
// ---------------------------------------------------------------------------
const MEDIA_EXE = path.join(HELPER_DIR, 'mediahelper.exe');
const media = { child: null, wanted: false, state: { has: false }, art: null, restarts: 0, timer: null };

function publishMedia() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media', { ...media.state, art: media.art });
}

function startMediaHelper() {
  if (media.child || !media.wanted || quitting) return;
  if (!fs.existsSync(MEDIA_EXE)) {
    media.state = { has: false, error: 'Brak ohm/ohmhelper/mediahelper.exe - uruchom ohm/build.cmd' };
    return publishMedia();
  }
  const child = spawn(MEDIA_EXE, [], { cwd: HELPER_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  media.child = child;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line[0] !== '{') continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      media.restarts = 0;
      if (msg.type === 'art') media.art = msg.data || null;
      else if (msg.type === 'state') { media.state = msg; if (!msg.has) media.art = null; }
      publishMedia();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => console.error('[mediahelper]', d.trim()));
  child.on('error', () => {});
  child.on('exit', () => {
    if (media.child === child) media.child = null;
    if (!media.wanted || quitting) return;
    const delay = Math.min(30000, 2000 * Math.pow(2, media.restarts++));
    clearTimeout(media.timer);
    media.timer = setTimeout(startMediaHelper, delay);
  });
}

function stopMediaHelper() {
  clearTimeout(media.timer);
  const child = media.child;
  media.child = null;
  if (!child) return;
  try { child.stdin.end('quit\n'); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} }, 2000).unref();
}

// renderer: czy jest jakis widget muzyki
ipcMain.on('media-want', (e, want) => {
  media.wanted = !!want;
  if (media.wanted) { startMediaHelper(); publishMedia(); }
  else stopMediaHelper();
});

ipcMain.on('media-cmd', (e, cmd) => {
  if (!['toggle', 'next', 'prev'].includes(cmd) || !media.child) return;
  try { media.child.stdin.write(cmd + '\n'); } catch {}
});

ipcMain.handle('elevate-sensors', async () => {
  if (sensors.mode === 'elevated') return { ok: true };
  if (sensors.last && sensors.last.admin) return { ok: true }; // widget juz dziala jako admin
  return startElevatedHelper();
});

// Jedna kopia widgetu: ponowne uruchomienie pokazuje istniejace okno.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return createWindow();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    startPipeHelper(); // helper startuje rownolegle z oknem
    // plik odczytow z poprzednich wersji (admin przesyla teraz dane potokiem) - sprzatamy
    fsp.unlink(path.join(OHM_DIR, 'sensors.json')).catch(() => {});
    createWindow();
    createTray();
    // nowe okno dostaje stan od razu, a gdy helper zamilknie - odczyty wygasaja (null)
    mainWindow.webContents.on('did-finish-load', () => publish(true));
    setInterval(publish, STALE_MS / 2).unref();
    // zmiana monitorow / rozdzielczosci / paska zadan -> ponowne przyklejenie
    const resnap = () => { if (config.snap) applySnap(); };
    screen.on('display-metrics-changed', resnap);
    screen.on('display-added', resnap);
    screen.on('display-removed', resnap);
  });
}

app.on('before-quit', () => {
  quitting = true;
  stopMediaHelper();
  sensors.quitting = true;
  stopElevPipe();
  stopPipeHelper();
  // helper w trybie admina zamknie sie sam (pilnuje PID widgetu)
});
// okno tylko sie chowa, wiec aplikacja zyje w zasobniku do "Zamknij"
app.on('window-all-closed', () => { if (quitting) app.quit(); });
