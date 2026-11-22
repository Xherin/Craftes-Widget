// Generator grafik promocyjnych (README / GitHub) z prawdziwego widgetu.
//
//   npx electron tools/promo/render.js
//
// 1) Uruchamia widget w ukrytym oknie (zoom 2x = ostre zrzuty), wstawia przykladowe dane
//    (temperatury, muzyka, zadania - zeby grafiki nie zalezaly od tego, co akurat dzieje sie
//    na komputerze) i robi zrzuty kart. Ceny krypto/akcji i pogoda sa pobierane na zywo.
// 2) Sklada z nich banery z szablonu tools/promo/template.html.
// Wynik: docs/promo/*.png (+ social-preview.jpg do ustawien repozytorium na GitHubie).

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUILD = path.join(__dirname, 'build');      // zrzuty posrednie
const OUT = path.join(ROOT, 'docs', 'promo');     // gotowe grafiki
const ZOOM = 2;
const WIDTH = 380;

require(path.join(ROOT, 'main.js')); // handlery IPC (ceny, akcje) - jak w prawdziwym widgecie

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tapeta za widgetem (zeby bylo widac przezroczystosc i rozmycie kart)
const WALLPAPER_CSS = `
  html:root {
    background:
      radial-gradient(120% 60% at 0% 0%, rgba(56,189,248,0.35), transparent 60%),
      radial-gradient(90% 50% at 100% 30%, rgba(139,92,246,0.35), transparent 60%),
      radial-gradient(80% 50% at 30% 100%, rgba(94,234,212,0.30), transparent 60%),
      #0b1020 !important;
  }
  body { background: transparent !important; }
  /* na grafikach karty leza na narysowanym tle - wtedy rozmycie tla ma sens */
  #drag-bar { backdrop-filter: blur(10px); }
  .widget { backdrop-filter: blur(16px); }
  .widget-stack { overflow: visible !important; height: auto !important; }
  ::-webkit-scrollbar { display: none; }
`;

// Przykladowe dane
const DEMO_SETUP = `(async () => {
  ipcRenderer.removeAllListeners('temps');   // prawdziwe odczyty nie nadpisza danych demo
  ipcRenderer.removeAllListeners('media');
  localStorage.clear();
  widgets.slice().forEach(w => removeWidget(w.id));
  const list = [
    { id: 'm', type: 'music' },
    { id: 't', type: 'temps' },
    { id: 'c', type: 'crypto', symbol: 'bitcoin', vs: 'usd', range: '24' },
    { id: 's', type: 'stock', symbol: 'AAPL', range: '1d' },
    { id: 'd', type: 'todo', title: 'Zadania', items: [
      { id: '1', text: 'Wrzucić widget na GitHuba', done: true },
      { id: '2', text: 'Dopisać README i grafiki', done: true },
      { id: '3', text: 'Nagrać krótki filmik z działania', done: false },
      { id: '4', text: 'Wymienić pastę na CPU', done: false }
    ] },
    { id: 'k', type: 'clock' },
    { id: 'w', type: 'weather', city: 'Warszawa' }
  ];
  for (const w of list) { widgets.push(w); renderWidget(w); }
  saveWidgets();

  renderTemps({
    cpu: 56, gpu: 61, cpuLoad: 23, gpuLoad: 47, vramUsed: 5320, vramTotal: 8188,
    ramUsed: 17900, ramTotal: 32693, topCpuName: 'chrome', topCpu: 9, topGpuName: 'obs64', topGpu: 18,
    topRamName: 'chrome', topRam: 3420, cpuName: 'AMD Ryzen 9 5900X', gpuName: 'NVIDIA GeForce RTX 4060',
    admin: true, ring0: true, driver: 'ok', mode: 'pipe', error: null
  });

  // okladka demo: gradient + kola, rysowana w canvasie
  const c = document.createElement('canvas'); c.width = c.height = 160;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 160, 160);
  grad.addColorStop(0, '#7c3aed'); grad.addColorStop(0.55, '#0ea5e9'); grad.addColorStop(1, '#5eead4');
  g.fillStyle = grad; g.fillRect(0, 0, 160, 160);
  g.globalAlpha = 0.35; g.fillStyle = '#fff';
  g.beginPath(); g.arc(112, 56, 34, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.2; g.beginPath(); g.arc(44, 118, 52, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.9; g.fillStyle = '#0b1020';
  g.fillRect(0, 128, 160, 32);
  g.fillStyle = '#5eead4'; g.font = 'bold 15px Inter'; g.fillText('MIDNIGHT', 12, 149);
  renderMedia({
    has: true, title: 'Midnight Drive', artist: 'Neon Avenue', album: 'Night Lines', app: 'Spotify',
    playing: true, canToggle: true, canNext: true, canPrev: true,
    dur: 214, pos: 131, posAt: Date.now(), art: c.toDataURL('image/png')
  });
})()`;

async function renderWidgetShots() {
  const win = new BrowserWindow({
    width: WIDTH * ZOOM, height: 1600 * ZOOM, show: false, frame: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(ROOT, 'index.html'));
  win.webContents.setZoomFactor(ZOOM);
  await win.webContents.insertCSS(WALLPAPER_CSS);
  const js = code => win.webContents.executeJavaScript(code);
  await sleep(1500);
  await js(DEMO_SETUP);
  await sleep(9000); // ceny, wykresy, pogoda; fala muzyki dochodzi do pelnej wysokosci

  // okno dopasowane do zawartosci
  const fullH = Math.ceil(await js(`document.getElementById('dashboard').getBoundingClientRect().bottom + 14`));
  win.setSize(WIDTH * ZOOM, fullH * ZOOM);
  await sleep(800);
  // w ukrytym oknie Chart.js nie zawsze lapie zmiane rozmiaru/zoomu - wymuszamy przeliczenie
  console.log('charts:', await js(`JSON.stringify(widgets.map(w => views.get(w.id)).filter(v => v && v.chart).map(v => {
    v.chart.resize(); v.chart.update('none');
    return { w: v.chart.width, h: v.chart.height, n: v.chart.data.datasets[0].data.length };
  }))`));
  await sleep(500);

  const rect = async (sel, idxFrom, idxTo) => JSON.parse(await js(`JSON.stringify((() => {
    const cards = [...document.querySelectorAll('.widget')];
    const a = cards[${idxFrom}].getBoundingClientRect(), b = cards[${idxTo}].getBoundingClientRect();
    return { x: a.left, y: a.top, width: a.width, height: b.bottom - a.top }; // dokladnie karty (zaokraglenie w szablonie)
  })())`));
  const shot = async (name, r) => {
    const area = r && { x: Math.round(r.x * ZOOM), y: Math.round(r.y * ZOOM), width: Math.round(r.width * ZOOM), height: Math.round(r.height * ZOOM) };
    const img = await win.webContents.capturePage(area);
    fs.writeFileSync(path.join(BUILD, name), img.toPNG());
    return img.getSize();
  };

  console.log('full', await shot('widget-full.png'));
  console.log('music', await shot('music.png', await rect('', 0, 0)));
  console.log('temps', await shot('temps.png', await rect('', 1, 1)));
  console.log('todo', await shot('todo.png', await rect('', 4, 4)));
  console.log('misc', await shot('misc.png', await rect('', 5, 6)));

  // podglad punktu na wykresie akcji (najechanie myszka)
  const chart = JSON.parse(await js(`JSON.stringify((() => { const c = document.querySelectorAll('.widget')[3].querySelector('canvas').getBoundingClientRect(); return { x: c.left, y: c.top, w: c.width, h: c.height }; })())`));
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round((chart.x + chart.w * 0.62) * ZOOM), y: Math.round((chart.y + chart.h / 2) * ZOOM) });
  await sleep(500);
  console.log('hover:', await js(`document.querySelectorAll('.widget')[3].querySelector('.widget-body').innerText.split('\\n').slice(0, 2).join(' | ')`));
  console.log('markets', await shot('markets.png', await rect('', 2, 3)));
  console.log('stock', await shot('stock.png', await rect('', 3, 3)));
  win.destroy();
}

async function renderTemplate(type, w, h, file, scale = ZOOM, jpeg = false) {
  const win = new BrowserWindow({
    width: w * scale, height: h * scale, show: false, frame: false,
    enableLargerThanScreen: true, // inaczej Windows przycina okno do wysokosci ekranu
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, 'template.html'), { query: { type } });
  win.webContents.setZoomFactor(scale);
  await sleep(1200);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), jpeg ? img.toJPEG(90) : img.toPNG());
  console.log(file, img.getSize(), Math.round(fs.statSync(path.join(OUT, file)).size / 1024) + ' KB');
  win.destroy();
}

app.whenReady().then(async () => {
  try {
    // okno samego widgetu (z main.js) nie jest tu potrzebne
    for (const w of BrowserWindow.getAllWindows()) w.hide();
    fs.mkdirSync(BUILD, { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    await renderWidgetShots();
    await renderTemplate('hero', 1280, 640, 'hero.png');
    await renderTemplate('hero', 1280, 640, 'social-preview.jpg', 1, true); // GitHub: 1280x640, < 1 MB
    await renderTemplate('desktop', 1280, 640, 'desktop.png');
    await renderTemplate('monitor', 1280, 640, 'feature-monitor.png');
    await renderTemplate('music', 1280, 640, 'feature-music.png');
    await renderTemplate('markets', 1280, 640, 'feature-markets.png');
    await renderTemplate('todo', 1280, 640, 'feature-todo.png');
  } catch (e) {
    console.error(e);
  }
  app.emit('before-quit');
  app.exit(0);
});
