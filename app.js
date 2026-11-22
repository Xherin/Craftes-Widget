// Widget Dashboard v0.25
const { ipcRenderer } = require('electron');

const STORAGE_KEY = 'widget-dashboard-v11';
const HOUR = I18N.lang === 'pl' ? '2-digit' : 'numeric'; // 17:05 / 5:05 PM
const AUTO_ELEVATE_KEY = 'widget-sensors-autoelevate';
const PRICE_REFRESH_MS = 60 * 1000; // kursy i wykresy co minute (main i tak cache'uje zapytania 20 s)

let widgets = [];
let selectedType = null;
let sortable = null;
let isLocked = false;

// id widgetu -> { el, body, chart, refs } (referencje do elementow zamiast getElementById co cykl)
const views = new Map();

const $ = id => document.getElementById(id);
const dashboard = $('dashboard');
const modal = $('modal');
const addWidgetBtn = $('addWidgetBtn');
const lockBtn = $('lockBtn');
const refreshBtn = $('refreshBtn');
const widgetConfig = $('widgetConfig');
const confirmAdd = $('confirmAdd');
const typeButtons = document.querySelectorAll('.widget-type-btn');

// ---------- start ----------

function init() {
  I18N.applyStatic(document);
  applyTheme(loadTheme()); // kolor motywu przed narysowaniem kart (bez mrugniecia domyslnym)
  applyAlpha(loadAlpha());
  loadWidgets();
  widgets.forEach(renderWidget);
  initSortable();
  setupEvents();
  setupThemePicker();
  setInterval(refreshPrices, PRICE_REFRESH_MS);
  scheduleClock();
  // temperatury i muzyka: main wypycha zmiany, tu tylko stan poczatkowy
  ipcRenderer.on('temps', (e, t) => renderTemps(t));
  ipcRenderer.on('media', (e, m) => renderMedia(m));
  ipcRenderer.on('refresh-all', forceRefreshAll); // z menu zasobnika
  refreshTemps();
  syncMediaWant();
}

function loadWidgets() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    widgets = saved ? JSON.parse(saved) : getDefaultWidgets();
  } catch {
    widgets = getDefaultWidgets();
  }
}

let saveTimer = null;
function saveWidgets() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)); } catch {}
}
// notatki zapisuja sie po krotkiej przerwie w pisaniu, nie przy kazdym znaku
function saveWidgetsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWidgets, 400);
}
window.addEventListener('beforeunload', () => { if (saveTimer) saveWidgets(); });

function getDefaultWidgets() {
  return [
    { id: uid(), type: 'crypto', symbol: 'bitcoin', vs: 'usd', range: '24' },
    { id: uid(), type: 'crypto', symbol: 'ethereum', vs: 'usd', range: '24' },
    { id: uid(), type: 'temps' },
    { id: uid(), type: 'clock' },
    { id: uid(), type: 'note', title: t('def.noteTitle'), content: t('def.noteContent') }
  ];
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function setupEvents() {
  addWidgetBtn.addEventListener('click', openModal);
  $('cancelAdd').addEventListener('click', closeModal);
  $('closeBtn').addEventListener('click', () => window.close());
  lockBtn.addEventListener('click', toggleLock);
  renderLockBtn();
  refreshBtn.addEventListener('click', forceRefreshAll);
  typeButtons.forEach(btn => btn.addEventListener('click', () => selectType(btn.dataset.type)));
  confirmAdd.addEventListener('click', addWidget);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}

async function forceRefreshAll() {
  refreshBtn.style.opacity = '0.5';
  await Promise.all([refreshTemps(), ...widgets.filter(w => MARKETS[w.type]).map(w => refreshMarket(w))]);
  setTimeout(() => { refreshBtn.style.opacity = '1'; }, 600);
}

// Ikony interfejsu (jeden styl: obrys 1.8, zaokraglone konce - wyglad ustawia CSS .icon-btn / svg)
const UI_ICONS = {
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 17V6l10-2v11"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>'
};

function renderLockBtn() {
  lockBtn.innerHTML = isLocked ? UI_ICONS.lock : UI_ICONS.unlock;
  lockBtn.title = isLocked ? t('bar.unlock') : t('bar.lock');
  lockBtn.classList.toggle('locked', isLocked);
}

function toggleLock() {
  isLocked = !isLocked;
  document.body.classList.toggle('locked', isLocked);
  renderLockBtn();
  if (sortable) sortable.option('disabled', isLocked);
}

// Sortable dziala na kontenerze - wystarczy jedna instancja, nowe widgety obsluguje sam.
function initSortable() {
  if (sortable || typeof Sortable === 'undefined') return; // CDN niedostepny (offline)
  sortable = Sortable.create(dashboard, {
    animation: 180,
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    disabled: isLocked,
    // przeciaganie widgetu nie startuje z pol, przyciskow i edytowalnego tekstu
    filter: 'input, textarea, select, button, [contenteditable], .todo-text, .music-progress, .chart-container',
    preventOnFilter: false,
    onEnd: () => {
      const order = new Map([...dashboard.children].map((el, i) => [el.dataset.id, i]));
      widgets.sort((a, b) => order.get(a.id) - order.get(b.id));
      saveWidgets();
    }
  });
}

// ---------- modal ----------

function openModal() {
  if (isLocked) return;
  selectedType = null;
  widgetConfig.innerHTML = '';
  widgetConfig.classList.add('hidden');
  confirmAdd.disabled = true;
  typeButtons.forEach(b => b.classList.remove('active'));
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
}

function selectType(type) {
  selectedType = type;
  typeButtons.forEach(b => b.classList.toggle('active', b.dataset.type === type));
  renderConfigForm(type);
  confirmAdd.disabled = false;
}

// formularze budowane przy otwarciu (teksty w biezacym jezyku)
const rangeOptions = (pairs, sel) => pairs.map(([v, label]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${label}</option>`).join('');
const CONFIG_FORMS = {
  crypto: () => `
      <label>${t('cfg.cryptoSymbol')}</label>
      <input type="text" id="cfgSymbol" value="bitcoin">
      <label>${t('cfg.currency')}</label>
      <input type="text" id="cfgVs" value="usd">
      <label>${t('cfg.range')}</label>
      <select id="cfgRange">${rangeOptions([['1', '1h'], ['4', '4h'], ['12', '12h'], ['24', '24h']], '24')}</select>
    `,
  note: () => `
      <label>${t('cfg.title')}</label>
      <input type="text" id="cfgTitle" value="${escapeHtml(t('def.noteTitle'))}">
      <label>${t('cfg.content')}</label>
      <textarea id="cfgContent" rows="3">${escapeHtml(t('def.noteContent'))}</textarea>
    `,
  weather: () => `<label>${t('cfg.city')}</label><input type="text" id="cfgCity" value="${escapeHtml(t('def.city'))}">`,
  stock: () => `
      <label>${t('cfg.symbol')}</label>
      <input type="text" id="cfgSymbol" value="AAPL">
      <p class="field-hint">${t('cfg.stockHint')}</p>
      <label>${t('cfg.range')}</label>
      <select id="cfgRange">${rangeOptions(['1d', '5d', '1mo', '6mo', '1y'].map(r => [r, t('range.' + r)]), '1d')}</select>
    `,
  todo: () => `<label>${t('cfg.title')}</label><input type="text" id="cfgTitle" value="${escapeHtml(t('def.todoTitle'))}">`,
  music: () => `<p class="config-hint">${t('cfg.musicHint')}</p>`
};

function renderConfigForm(type) {
  widgetConfig.classList.remove('hidden');
  const form = CONFIG_FORMS[type];
  widgetConfig.innerHTML = form ? form() : `<p class="config-hint">${t('modal.noConfig')}</p>`;
}

function addWidget() {
  const val = id => $(id)?.value;
  const widget = { id: uid(), type: selectedType };

  if (selectedType === 'crypto') {
    widget.symbol = val('cfgSymbol')?.trim().toLowerCase() || 'bitcoin';
    widget.vs = val('cfgVs')?.trim().toLowerCase() || 'usd';
    widget.range = val('cfgRange') || '24';
  } else if (selectedType === 'note') {
    widget.title = val('cfgTitle') || t('def.noteTitle');
    widget.content = val('cfgContent') || '';
  } else if (selectedType === 'weather') {
    widget.city = val('cfgCity') || t('def.city');
  } else if (selectedType === 'stock') {
    widget.symbol = val('cfgSymbol')?.trim().toUpperCase() || 'AAPL';
    widget.range = val('cfgRange') || '1d';
  } else if (selectedType === 'todo') {
    widget.title = val('cfgTitle')?.trim() || t('def.todoTitle');
    widget.items = [];
  }

  widgets.push(widget);
  saveWidgets();
  renderWidget(widget); // tylko nowy widget - pozostale nie sa przeladowywane
  closeModal();
}

function removeWidget(id) {
  const view = views.get(id);
  if (view) {
    if (view.chart) { try { view.chart.destroy(); } catch {} }
    view.el.remove();
    views.delete(id);
  }
  widgets = widgets.filter(w => w.id !== id);
  saveWidgets();
  syncMediaWant();
}

// ---------- widgety ----------

function renderWidget(widget) {
  const el = document.createElement('div');
  el.className = 'widget';
  el.dataset.id = widget.id;
  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-title">${escapeHtml(getWidgetTitle(widget))}</span>
      <div class="widget-controls">
        <button class="widget-close" title="${t('w.remove')}">${UI_ICONS.close}</button>
      </div>
    </div>
    <div class="widget-body" id="body-${widget.id}"><span class="loading">${t('w.loading')}</span></div>
  `;
  el.querySelector('.widget-close').addEventListener('click', (e) => {
    e.stopPropagation();
    removeWidget(widget.id);
  });

  const view = { el, body: el.lastElementChild, chart: null, refs: null };
  views.set(widget.id, view);
  dashboard.appendChild(el);
  loadWidgetData(widget, view);
}

function getWidgetTitle(w) {
  switch (w.type) {
    case 'crypto': return t('title.crypto', { s: w.symbol });
    case 'note': return w.title || t('def.noteTitle');
    case 'clock': return t('title.clock');
    case 'weather': return t('title.weather', { s: w.city || '' });
    case 'temps': return 'CPU / GPU / RAM';
    case 'stock': return t('title.stock', { s: w.symbol });
    case 'todo': return w.title || t('def.todoTitle');
    case 'music': return t('title.music');
    default: return w.type;
  }
}

async function loadWidgetData(widget, view) {
  const body = view.body;
  try {
    switch (widget.type) {
      case 'crypto':
      case 'stock':
        await refreshMarket(widget, true);
        break;
      case 'todo':
        buildTodo(widget, view);
        break;
      case 'music':
        buildMusic(view);
        if (lastMedia) renderMediaInto(view, lastMedia);
        syncMediaWant();
        break;
      case 'clock':
        body.innerHTML = `
    <div></div>
    <div class="widget-sub"></div>
  `;
        view.refs = { time: body.children[0], date: body.children[1] };
        updateClock(view, new Date());
        break;
      case 'note': {
        body.innerHTML = `<div class="note-content" contenteditable="true" spellcheck="false">${escapeHtml(widget.content || '')}</div>`;
        body.firstElementChild.addEventListener('input', (e) => {
          widget.content = e.target.innerText;
          saveWidgetsSoon();
        });
        break;
      }
      case 'temps':
        buildTemps(widget, view);
        if (lastTemps) renderTempsInto(view, lastTemps);
        break;
      case 'weather': {
        const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(widget.city)}&count=1`).then(r => r.json());
        if (!geo.results?.[0]) throw new Error(t('wx.notFound'));
        const { latitude, longitude } = geo.results[0];
        const weather = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,weather_code&timezone=auto`).then(r => r.json());
        const c = weather.current;
        // miasto jest juz w tytule karty - pod temperatura opis pogody i temperatura odczuwalna
        const desc = [weatherText(c.weather_code), c.apparent_temperature != null ? t('wx.feels', { t: tempFmt.format(c.apparent_temperature) }) : null]
          .filter(Boolean).join(' · ');
        body.innerHTML = `<div>${tempFmt.format(c.temperature_2m)}°C</div><div class="widget-sub">${escapeHtml(desc || widget.city)}</div>`;
        break;
      }
      default:
        body.innerHTML = `<div class="widget-sub">${t('w.unavailable')}</div>`;
    }
  } catch (err) {
    body.innerHTML = `<div class="error-text">${escapeHtml(t('w.error', { msg: err.message }))}</div>`;
  }
}

// ---------- krypto i akcje (wspolny widget rynkowy) ----------

// load(widget) -> { price, change, currency, name?, prices: { t, p } (lub Promise) }
// timeFmt(range) -> formatter podpisu czasu punktu pod kursorem
const fmtHM = new Intl.DateTimeFormat(I18N.locale, { hour: HOUR, minute: '2-digit' });
const fmtDayHM = new Intl.DateTimeFormat(I18N.locale, { weekday: 'short', hour: HOUR, minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat(I18N.locale, { day: 'numeric', month: 'short' });
const fmtMonthYear = new Intl.DateTimeFormat(I18N.locale, { day: 'numeric', month: 'short', year: 'numeric' });

const MARKETS = {
  crypto: {
    ranges: [['1', '1h'], ['4', '4h'], ['12', '12h'], ['24', '24h']],
    changeLabel: '(24h)',
    timeFmt: () => fmtHM,
    load: async (w) => {
      // wykres pobierany rownolegle z cena
      const prices = ipcRenderer.invoke('crypto-chart', { symbol: w.symbol, vs: w.vs, range: w.range }).catch(() => null);
      const { price, change } = await ipcRenderer.invoke('crypto-price', { symbol: w.symbol, vs: w.vs });
      return { price, change, currency: w.vs, prices };
    }
  },
  stock: {
    ranges: [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['6mo', '6M'], ['1y', t('range.short.1y')]],
    changeLabel: t('mk.today'),
    timeFmt: (range) => range === '1d' ? fmtHM : range === '5d' ? fmtDayHM : range === '1y' ? fmtMonthYear : fmtDate,
    load: (w) => ipcRenderer.invoke('stock-data', { symbol: w.symbol, range: w.range })
  }
};

// ---------- pogoda: opis kodu WMO (Open-Meteo) ----------
const tempFmt = new Intl.NumberFormat(I18N.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function weatherText(code) {
  if (code == null) return null;
  // progi kodow WMO -> klucz opisu (wx.0, wx.2, ...)
  for (const max of [0, 2, 3, 48, 57, 67, 77, 82, 86]) if (code <= max) return t('wx.' + max);
  return t('wx.99');
}

// zmiana procentowa w formacie jezyka (pl: "+0,54%", en: "+0.54%"), z prawdziwym znakiem minus
const pctFmt = new Intl.NumberFormat(I18N.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const changeText = (pct) => pct != null ? `${pct >= 0 ? '+' : '−'}${pctFmt.format(Math.abs(pct))}%` : '–';

// Naglowek widgetu: aktualne dane (live) albo punkt wykresu pod kursorem (hover)
function showLive(view) {
  const l = view.live;
  if (!l) return;
  setText(view.refs.price, l.price);
  setText(view.refs.change, l.change);
  setClass(view.refs.change, l.cls);
}

function showHover(widget, view, idx) {
  const s = view.series;
  if (!s || idx == null || idx >= s.p.length) return showLive(view);
  const price = s.p[idx];
  const pct = s.p[0] ? (price - s.p[0]) / s.p[0] * 100 : null; // zmiana od poczatku zakresu wykresu
  const when = MARKETS[widget.type].timeFmt(widget.range).format(new Date(s.t[idx]));
  setText(view.refs.price, formatPrice(price, view.live ? view.live.currency : widget.vs));
  setText(view.refs.change, `${changeText(pct)} · ${when}`);
  setClass(view.refs.change, 'widget-sub ' + (pct >= 0 ? 'price-up' : 'price-down'));
}

// Szkielet budowany raz; odswiezenie zmienia tylko teksty i dane wykresu.
function buildMarket(widget, view) {
  const r = widget.range;
  const options = MARKETS[widget.type].ranges
    .map(([v, label]) => `<option value="${v}" ${r === v ? 'selected' : ''}>${label}</option>`).join('');
  view.body.innerHTML = `
    <div></div>
    <div class="widget-sub"></div>
    <div class="market-row">
      <span class="market-label">${t('mk.chart')}</span>
      <select class="range-select" title="${t('cfg.range')}">${options}</select>
    </div>
    <div class="chart-container"><canvas id="chart-${widget.id}"></canvas></div>
  `;
  const [price, change, row, chartBox] = view.body.children;
  view.refs = { price, change, canvas: chartBox.firstElementChild };
  row.lastElementChild.addEventListener('change', (e) => {
    widget.range = e.target.value;
    saveWidgets();
    refreshMarket(widget);
  });
}

// initial=true: blad pokazywany w widgecie; przy odswiezaniu zostaje poprzedni stan.
async function refreshMarket(widget, initial) {
  const view = views.get(widget.id);
  const market = MARKETS[widget.type];
  if (!view || !market) return;
  try {
    const d = await market.load(widget);
    if (!view.refs) buildMarket(widget, view);
    // gielda zamknieta (wieczor, weekend, swieto): kurs i wykres stoja - mowimy to wprost
    const closed = d.marketOpen === false && d.lastTrade;
    const label = closed ? t('mk.closed', { when: fmtDayHM.format(new Date(d.lastTrade)) }) : market.changeLabel;
    view.live = {
      currency: d.currency,
      price: formatPrice(d.price, d.currency),
      change: `${changeText(d.change)} ${label}`,
      cls: 'widget-sub ' + (d.change >= 0 ? 'price-up' : 'price-down')
    };
    view.live.base = view.live.change;
    setTitle(view.refs.price, [d.name, closed ? t('mk.closedTitle', { when: fmtDayHM.format(new Date(d.lastTrade)) }) : '']
      .filter(Boolean).join('\n'));
    setTitle(view.refs.change, '');
    if (view.hoverIdx == null) showLive(view); // nie przerywaj ogladania wykresu odswiezeniem
    drawChart(widget, view, await d.prices);
  } catch (e) {
    if (initial) throw e;
    // odswiezenie sie nie udalo - zostaja poprzednie dane, ale z widoczna informacja
    if (view.live && view.refs) {
      view.live.change = `${view.live.base} · ${t('mk.stale')}`;
      setTitle(view.refs.change, t('mk.staleTitle', { msg: e.message }));
      if (view.hoverIdx == null) showLive(view);
    }
  }
}

// Pionowa przerywana linia w miejscu kursora
const hoverLinePlugin = {
  id: 'hoverLine',
  afterDatasetsDraw(chart) {
    const active = chart.getActiveElements();
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  }
};

function setHover(widget, view, idx) {
  if (idx === view.hoverIdx) return;
  view.hoverIdx = idx;
  if (idx == null) showLive(view); else showHover(widget, view, idx);
}

function drawChart(widget, view, series) {
  if (!series || !series.p || series.p.length < 2 || !view.refs || typeof Chart === 'undefined') return;
  view.series = series;
  if (view.hoverIdx != null) setHover(widget, view, null);
  const labels = new Array(series.p.length).fill('');
  if (view.chart) {
    view.chart.data.labels = labels;
    view.chart.data.datasets[0].data = series.p;
    view.chart.update('none');
    return;
  }
  view.chart = new Chart(view.refs.canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: series.p,
        borderColor: theme.accent,
        borderWidth: 1.6,
        pointRadius: 0,
        pointHoverRadius: 3.5,
        pointHoverBackgroundColor: theme.accent,
        pointHoverBorderWidth: 0,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: false,
      // najblizszy punkt w poziomie, bez trafiania dokladnie w linie
      interaction: { mode: 'index', intersect: false },
      onHover: (evt, active) => setHover(widget, view, active.length ? active[0].index : null)
    },
    plugins: [hoverLinePlugin]
  });
  view.refs.canvas.addEventListener('mouseleave', () => setHover(widget, view, null));
}

function refreshPrices() {
  widgets.forEach(w => { if (MARKETS[w.type]) refreshMarket(w); });
}

// ---------- lista zadan ----------

function buildTodo(widget, view) {
  if (!Array.isArray(widget.items)) widget.items = [];
  view.body.innerHTML = `
    <ul class="todo-list"></ul>
    <div class="todo-add">
      <input type="text" class="todo-input" placeholder="${t('todo.placeholder')}" maxlength="200" spellcheck="false">
      <button class="btn-mini todo-add-btn" title="${t('todo.add')}">${UI_ICONS.plus}</button>
    </div>
    <div class="todo-foot">
      <span class="widget-sub todo-count"></span>
      <button class="todo-clear hidden">${t('todo.clear')}</button>
    </div>
  `;
  const q = s => view.body.querySelector(s);
  view.refs = { list: q('.todo-list'), input: q('.todo-input'), count: q('.todo-count'), clear: q('.todo-clear') };
  const { list, input } = view.refs;

  const add = () => {
    const text = input.value.trim();
    if (!text) return;
    widget.items.push({ id: uid(), text, done: false });
    input.value = '';
    saveWidgets();
    renderTodo(widget, view);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  q('.todo-add-btn').addEventListener('click', add);
  view.refs.clear.addEventListener('click', () => {
    widget.items = widget.items.filter(i => !i.done);
    saveWidgets();
    renderTodo(widget, view);
  });

  // delegacja zdarzen - jeden nasluchiwacz na liste zamiast na kazdy element
  const itemOf = (el) => {
    const li = el.closest('.todo-item');
    return li && widget.items.find(i => i.id === li.dataset.id);
  };
  list.addEventListener('click', (e) => {
    const item = itemOf(e.target);
    if (!item) return;
    if (e.target.closest('.todo-del')) {
      widget.items = widget.items.filter(i => i !== item);
    } else if (e.target.closest('.todo-check')) {
      item.done = !item.done;
    } else return;
    saveWidgets();
    renderTodo(widget, view);
  });
  // podwojne klikniecie = edycja tekstu
  list.addEventListener('dblclick', (e) => {
    const textEl = e.target.closest('.todo-text');
    const item = textEl && itemOf(textEl);
    if (!item || document.body.classList.contains('locked')) return;
    textEl.contentEditable = 'true';
    textEl.focus();
    document.getSelection().selectAllChildren(textEl);
    const finish = (commit) => {
      textEl.contentEditable = 'false';
      const text = textEl.textContent.trim();
      if (commit && text) { item.text = text; saveWidgets(); }
      renderTodo(widget, view);
    };
    textEl.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); textEl.blur(); }
      else if (ev.key === 'Escape') { textEl.onblur = null; finish(false); }
    };
    textEl.onblur = () => finish(true);
  });

  renderTodo(widget, view);
}

function renderTodo(widget, view) {
  const { list, count, clear } = view.refs;
  list.innerHTML = widget.items.map(i => `
    <li class="todo-item${i.done ? ' done' : ''}" data-id="${i.id}">
      <button class="todo-check" title="${i.done ? t('todo.markUndone') : t('todo.markDone')}"></button>
      <span class="todo-text" title="${t('todo.editHint')}">${escapeHtml(i.text)}</span>
      <button class="todo-del" title="${t('todo.delete')}">${UI_ICONS.close}</button>
    </li>`).join('');
  const done = widget.items.filter(i => i.done).length;
  const total = widget.items.length;
  count.textContent = total ? t('todo.count', { done, total }) : t('todo.empty');
  clear.classList.toggle('hidden', done === 0);
}

// ---------- muzyka ----------

let lastMedia = null;
let mediaWanted = null;

const ICONS = {
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 6v12z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18V6l8.5 6z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
};

// helper muzyki dziala tylko, gdy na pulpicie jest widget muzyki
function syncMediaWant() {
  const want = widgets.some(w => w.type === 'music');
  if (want === mediaWanted) return;
  mediaWanted = want;
  ipcRenderer.send('media-want', want);
}

function buildMusic(view) {
  view.body.innerHTML = `
    <div class="music">
      <div class="music-art"><img alt="" class="hidden"><span class="music-art-ph">${UI_ICONS.note}</span></div>
      <div class="music-info">
        <div class="music-title">${t('music.nothing')}</div>
        <div class="widget-sub music-artist"></div>
        <div class="music-app"></div>
      </div>
    </div>
    <div class="music-progress">
      <canvas class="music-wave"></canvas>
      <div class="music-times"><span></span><span></span></div>
    </div>
    <div class="music-controls">
      <button data-cmd="prev" title="${t('music.prev')}">${ICONS.prev}</button>
      <button data-cmd="toggle" class="music-play" title="${t('music.toggle')}">${ICONS.play}</button>
      <button data-cmd="next" title="${t('music.next')}">${ICONS.next}</button>
    </div>
  `;
  const q = s => view.body.querySelector(s);
  const [timeNow, timeEnd] = q('.music-times').children;
  view.refs = {
    img: q('.music-art img'), ph: q('.music-art-ph'), title: q('.music-title'), artist: q('.music-artist'),
    app: q('.music-app'), wave: q('.music-wave'), timeNow, timeEnd,
    prev: q('[data-cmd="prev"]'), play: q('[data-cmd="toggle"]'), next: q('[data-cmd="next"]'),
    art: null, playing: null, amp: 0
  };
  q('.music-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn || btn.disabled) return;
    ipcRenderer.send('media-cmd', btn.dataset.cmd);
    if (btn.dataset.cmd === 'toggle' && lastMedia && lastMedia.has) {
      // natychmiastowa reakcja ikony; prawdziwy stan przyjdzie z helpera
      renderMedia({ ...lastMedia, playing: !lastMedia.playing, pos: mediaPosition(lastMedia), posAt: Date.now() });
    }
  });
}

function forEachMusicView(fn) {
  for (const w of widgets) {
    if (w.type !== 'music') continue;
    const v = views.get(w.id);
    if (v && v.refs) fn(v);
  }
}

function renderMedia(m) {
  if (!m) return;
  lastMedia = m;
  forEachMusicView(v => renderMediaInto(v, m));
  kickWave();
}

function mediaPosition(m) {
  if (m.pos == null || !m.dur) return null;
  const p = m.playing && m.posAt ? m.pos + (Date.now() - m.posAt) / 1000 : m.pos;
  return Math.max(0, Math.min(m.dur, p));
}

const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---- pasek postepu w stylu One UI 9 ----
// Nad odtworzona czescia "oddychaja" swiecace, polprzezroczyste szczyty (kilka warstw w odcieniach
// turkusu i blekitu, z poswiata), rosnace w strone kciuka; reszta to cienka linia; kciuk to
// swiecace kolko. To animacja, nie analiza dzwieku. Przy pauzie szczyty lagodnie opadaja.
// Animacja dziala tylko podczas odtwarzania (lub chwile po pauzie), ~30 kl./s, i sama staje,
// gdy okno jest schowane (requestAnimationFrame nie jest wtedy wywolywany).
// base: polozenie linii (ulamek wysokosci); 24 kl./s - plynnie dla wolnej poswiaty, ~30% taniej niz 30
const WAVE = { pad: 7, fps: 24, base: 0.7 };

// Warstwy szczytow: f - "czestotliwosci" (szerokosc szczytow), s - predkosci, a - wysokosc,
// p - ostrosc szczytow, kolory RGB, blur - poswiata
const WAVE_LAYERS = [
  { f: [0.045, 0.11, 0.23], s: [0.9, -1.4, 2.3], a: 1.0, p: 1.3, rgb: '59,130,246', alpha: 0.85, blur: 5 },   // poswiata (akcent przesuniety w odcieniu)
  { f: [0.06, 0.15, 0.31], s: [-1.1, 1.8, -2.9], a: 0.95, p: 1.4, rgb: '56,189,248', alpha: 0.75, blur: 1.5 }, // akcent lekko przesuniety
  { f: [0.08, 0.19, 0.43], s: [1.6, -2.4, 3.7], a: 0.8, p: 1.6, rgb: '94,234,212', alpha: 0.8, blur: 0 },      // akcent
  { f: [0.17, 0.37, 0.71], s: [-2.2, 3.1, -4.6], a: 0.75, p: 3.2, rgb: '224,247,255', alpha: 0.85, blur: 0 }   // waskie, jasne iglice (rozjasniony akcent)
];

// wysokosc warstwy w punkcie x (0..1): suma sinusow, potegowana -> wyrazne szczyty
function waveNoise(layer, x, t) {
  const f = layer.f, s = layer.s;
  const n = 0.55 * Math.sin(x * f[0] + t * s[0])
          + 0.30 * Math.sin(x * f[1] + t * s[1] + 1.3)
          + 0.15 * Math.sin(x * f[2] + t * s[2] + 2.1);
  return Math.pow((n + 1) / 2, layer.p);
}
let waveRaf = 0;
let waveLast = 0;

let waveTimer = 0;

function kickWave() {
  if (!waveRaf && !waveTimer) waveRaf = requestAnimationFrame(waveFrame);
}

// Kolejna klatka planowana timerem, a requestAnimationFrame dopiero tuz przed rysowaniem.
// (Ciagle requestAnimationFrame z pomijaniem klatek zmuszalo kompozytor do pracy z pelna
// czestotliwoscia odswiezania monitora - w przezroczystym oknie kosztowalo to najwiecej.)
function waveFrame(now) {
  waveRaf = 0;
  waveLast = now;
  let animating = false;
  forEachMusicView(v => { if (drawWave(v, lastMedia, now)) animating = true; });
  if (animating) {
    waveTimer = setTimeout(() => { waveTimer = 0; waveRaf = requestAnimationFrame(waveFrame); }, Math.max(0, 1000 / WAVE.fps - 4));
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) kickWave(); });

// zwraca true, jesli potrzebna jest kolejna klatka
function drawWave(view, m, now) {
  const r = view.refs;
  const c = r.wave;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return false;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const has = !!(m && m.has);
  const pos = has ? mediaPosition(m) : null;
  const playing = has && !!m.playing && pos != null;
  setText(r.timeNow, pos != null ? fmtTime(pos) : '');
  setText(r.timeEnd, pos != null ? fmtTime(m.dur) : '');

  // "glosnosc" szczytow plynnie rosnie przy odtwarzaniu i opada przy pauzie
  const target = playing ? 1 : 0;
  r.amp += (target - r.amp) * 0.12;
  if (Math.abs(target - r.amp) < 0.01) r.amp = target;

  const base = Math.round(h * WAVE.base) + 0.5, x0 = WAVE.pad, x1 = w - WAVE.pad;
  ctx.lineCap = 'round';

  if (pos == null) { // brak osi czasu - sama cienka, przygaszona linia
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, base); ctx.lineTo(x1, base); ctx.stroke();
    return false;
  }

  const xp = x0 + (x1 - x0) * (pos / m.dur);
  const t = now / 1000;
  const up = base - 2;          // maks. wysokosc szczytow nad linia
  const down = (h - base) - 2;  // odbicie pod linia (mniejsze)

  // pozostala czesc: cienka linia
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xp, base); ctx.lineTo(x1, base); ctx.stroke();

  // odtworzona czesc: warstwy swiecacych szczytow (tylko gdy sa widoczne)
  if (xp > x0 + 2 && r.amp > 0) {
    const span = xp - x0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter'; // nakladajace sie warstwy rozjasniaja sie jak swiatlo
    for (const L of WAVE_LAYERS) {
      const top = [], bottom = [];
      for (let x = x0; x <= xp + 0.01; x += 2) {
        const rel = (x - x0) / span;
        // obwiednia: rosnie w strone kciuka, lagodnie wygasa przy poczatku i tuz przy kciuku
        const env = (0.18 + 0.82 * Math.pow(rel, 1.1)) * Math.min(1, (x - x0) / 10) * Math.min(1, (xp - x) / 3 + 0.25);
        const v = waveNoise(L, x, t) * env * L.a * r.amp;
        top.push(base - v * up);
        bottom.push(base + v * down * 0.45);
      }
      const grad = ctx.createLinearGradient(0, base - up, 0, h);
      grad.addColorStop(0, `rgba(${L.rgb},0)`);
      grad.addColorStop(0.55, `rgba(${L.rgb},${L.alpha * 0.55})`);
      grad.addColorStop((base - (base - up)) / (h - (base - up)), `rgba(${L.rgb},${L.alpha})`);
      grad.addColorStop(1, `rgba(${L.rgb},0)`);
      ctx.filter = L.blur ? `blur(${L.blur}px)` : 'none';
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, base);
      for (let i = 0; i < top.length; i++) ctx.lineTo(x0 + i * 2, top[i]);
      ctx.lineTo(xp, base);
      for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(x0 + i * 2, bottom[i]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // odtworzona czesc: jasna linia na wierzchu
  if (xp > x0) {
    ctx.strokeStyle = theme.waveLine;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, base); ctx.lineTo(xp, base); ctx.stroke();
  }

  // kciuk: swiecace kolko
  ctx.save();
  ctx.shadowColor = `rgba(${theme.rgb},0.9)`;
  ctx.shadowBlur = 8 + 4 * r.amp;
  ctx.fillStyle = theme.thumbFill;
  ctx.beginPath(); ctx.arc(xp, base, 5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = `rgba(${WAVE_LAYERS[0].rgb},0.95)`;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(xp, base, 5, 0, Math.PI * 2); ctx.stroke();

  return playing || r.amp > 0;
}

function renderMediaInto(view, m) {
  const r = view.refs;
  const has = !!m.has;
  setText(r.title, has ? (m.title || t('music.untitled')) : (m.error ? t('music.unavailable') : t('music.nothing')));
  setTitle(r.title, has ? [m.title, m.artist, m.album].filter(Boolean).join(' — ') : (m.error || ''));
  setText(r.artist, has ? (m.artist || '') : '');
  setText(r.app, has && m.app ? m.app : '');

  const art = has ? m.art || null : null;
  if (r.art !== art) {
    r.art = art;
    if (art) r.img.src = art; else r.img.removeAttribute('src');
    r.img.classList.toggle('hidden', !art);
    r.ph.classList.toggle('hidden', !!art);
  }

  const playing = has && !!m.playing;
  if (r.playing !== playing) {
    r.playing = playing;
    r.play.innerHTML = playing ? ICONS.pause : ICONS.play;
  }
  r.play.disabled = !has || !m.canToggle;
  r.prev.disabled = !has || !m.canPrev;
  r.next.disabled = !has || !m.canNext;
  kickWave(); // pasek rysowany w nastepnej klatce
}

// ---------- zegar ----------

const timeFmt = new Intl.DateTimeFormat(I18N.locale, { hour: HOUR, minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(I18N.locale, { weekday: 'short', day: 'numeric', month: 'short' });

function updateClock(view, now) {
  if (!view.refs) return;
  setText(view.refs.time, timeFmt.format(now));
  setText(view.refs.date, dateFmt.format(now));
}

// Zegar pokazuje HH:MM - odswiezamy na poczatku kazdej minuty zamiast co sekunde.
function scheduleClock() {
  const now = new Date();
  for (const w of widgets) if (w.type === 'clock') { const v = views.get(w.id); if (v) updateClock(v, now); }
  setTimeout(scheduleClock, 60000 - (now.getTime() % 60000) + 20);
}

// ---------- temperatury ----------

let lastTemps = null;
let elevating = false;
let lastElevateError = null;
let autoElevateTried = false;

const DRIVER_MESSAGES = new Set(['blocked', 'other-instance', 'dir-not-writable']); // teksty: drv.*

function getAutoElevate() {
  try { return localStorage.getItem(AUTO_ELEVATE_KEY) === '1'; } catch { return false; }
}
function setAutoElevate(on) {
  try { localStorage.setItem(AUTO_ELEVATE_KEY, on ? '1' : '0'); } catch {}
}

function buildTemps(widget, view) {
  view.body.innerHTML = `
        <div class="temps-grid">
          <div class="temp-block">
            <div class="temp-label" id="cpuname-${widget.id}">${t('tp.cpu')}</div>
            <div class="temp-value temp-unknown" id="cpu-${widget.id}">--°C</div>
            <div class="temp-load" id="cpuload-${widget.id}"></div>
            <div class="temp-top" data-r="cpuTop"></div>
          </div>
          <div class="temp-block">
            <div class="temp-label" id="gpuname-${widget.id}">GPU</div>
            <div class="temp-value temp-unknown" id="gpu-${widget.id}">--°C</div>
            <div class="temp-load" id="gpuload-${widget.id}"></div>
            <div class="temp-load" data-r="vram"></div>
            <div class="temp-top" data-r="gpuTop"></div>
          </div>
        </div>
        <div class="mem-row" data-r="ramRow">
          <div class="mem-head">
            <span class="temp-label">RAM</span>
            <span class="mem-val" data-r="ram"></span>
          </div>
          <div class="mem-bar"><div class="mem-fill" data-r="ramFill"></div></div>
          <div class="temp-top" data-r="ramTop"></div>
        </div>
        <div class="temp-status hidden" id="tstatus-${widget.id}">
          <span class="temp-status-text"></span>
          <button class="btn-mini temp-elevate">${t('tp.elevate')}</button>
          <label class="temp-auto"><input type="checkbox" class="temp-auto-cb"> ${t('tp.auto')}</label>
        </div>
      `;
  const q = s => view.body.querySelector(s);
  view.refs = {
    cpuName: q('#cpuname-' + widget.id), cpu: q('#cpu-' + widget.id), cpuLoad: q('#cpuload-' + widget.id),
    gpuName: q('#gpuname-' + widget.id), gpu: q('#gpu-' + widget.id), gpuLoad: q('#gpuload-' + widget.id),
    status: q('.temp-status'), statusText: q('.temp-status-text'),
    elevate: q('.temp-elevate'), auto: q('.temp-auto')
  };
  view.body.querySelectorAll('[data-r]').forEach(el => { view.refs[el.dataset.r] = el; });
  view.refs.elevate.addEventListener('click', elevateSensors);
  const cb = q('.temp-auto-cb');
  cb.checked = getAutoElevate();
  cb.addEventListener('change', () => setAutoElevate(cb.checked));
}

async function refreshTemps() {
  try { renderTemps(await ipcRenderer.invoke('get-temps')); } catch {}
}

async function elevateSensors() {
  if (elevating) return;
  elevating = true;
  forEachTempsView(v => { v.refs.elevate.disabled = true; v.refs.elevate.textContent = t('tp.elevating'); });
  try {
    const r = await ipcRenderer.invoke('elevate-sensors');
    lastElevateError = r.ok ? null : (r.error || t('tp.unknownError'));
  } catch (e) {
    lastElevateError = e.message;
  } finally {
    elevating = false;
    forEachTempsView(v => { v.refs.elevate.disabled = false; v.refs.elevate.textContent = t('tp.elevate'); });
    refreshTemps();
  }
}

function forEachTempsView(fn) {
  for (const w of widgets) {
    if (w.type !== 'temps') continue;
    const v = views.get(w.id);
    if (v && v.refs) fn(v);
  }
}

function renderTemps(temps) {
  if (!temps) return;
  lastTemps = temps;
  // CPU wymaga sterownika WinRing0 -> administrator
  temps.needAdmin = temps.cpu == null && !temps.admin && temps.mode !== 'elevated' && !!temps.cpuName;
  let any = false;
  forEachTempsView(v => { any = true; renderTempsInto(v, temps); });
  if (any && temps.needAdmin && getAutoElevate() && !autoElevateTried) {
    autoElevateTried = true;
    elevateSensors();
  }
}

function tempClass(t) {
  return 'temp-value ' + (t == null ? 'temp-unknown' : t >= 85 ? 'temp-hot' : t >= 70 ? 'temp-warm' : 'temp-ok');
}

function shortName(name, fallback) {
  if (!name) return fallback;
  return name.replace(/^(AMD|Intel\(R\)|Intel|NVIDIA)\s+/i, '').replace(/\s*(Processor|CPU @.*)$/i, '').trim();
}

const fmtTemp = t => t != null ? `${Math.round(t)}°C` : '--°C';
const fmtLoad = l => l != null ? t('tp.load', { v: Math.round(l) }) : '';
const gbFmt = new Intl.NumberFormat(I18N.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtGB = mb => gbFmt.format(mb / 1024);

// "▲ nazwa 12%" - najbardziej obciazajacy proces; title z pelna nazwa (tekst moze byc uciety)
function setTop(el, name, value) {
  const text = name ? `▲ ${name} ${value}` : '';
  setText(el, text);
  setTitle(el, name ? t('tp.top', { name, value }) : '');
}

function renderTempsInto(view, t) {
  const r = view.refs;
  setText(r.cpu, fmtTemp(t.cpu)); setClass(r.cpu, tempClass(t.cpu));
  setText(r.gpu, fmtTemp(t.gpu)); setClass(r.gpu, tempClass(t.gpu));
  setText(r.cpuName, shortName(t.cpuName, I18N.t('tp.cpu'))); setTitle(r.cpuName, t.cpuName || '');
  setText(r.gpuName, shortName(t.gpuName, 'GPU')); setTitle(r.gpuName, t.gpuName || '');
  setText(r.cpuLoad, fmtLoad(t.cpuLoad));
  setText(r.gpuLoad, fmtLoad(t.gpuLoad));

  // VRAM, RAM i procesy, ktore najbardziej obciazaja dany podzespol
  setText(r.vram, t.vramUsed != null ? `VRAM ${fmtGB(t.vramUsed)}${t.vramTotal ? ' / ' + fmtGB(t.vramTotal) : ''} GB` : '');
  setTop(r.cpuTop, t.topCpuName, t.topCpu != null ? `${t.topCpu}%` : '');
  setTop(r.gpuTop, t.topGpu ? t.topGpuName : null, `${t.topGpu}%`);
  // wiersz RAM zawsze zajmuje miejsce (bez danych: "--"), zeby karta nie zmieniala wysokosci
  const hasRam = t.ramTotal != null;
  const pct = hasRam ? Math.round(t.ramUsed / t.ramTotal * 100) : 0;
  setText(r.ram, hasRam ? `${fmtGB(t.ramUsed)} / ${fmtGB(t.ramTotal)} GB · ${pct}%` : '--');
  const w = pct + '%';
  if (r.ramFill.style.width !== w) r.ramFill.style.width = w;
  setClass(r.ramFill, 'mem-fill' + (pct >= 90 ? ' mem-hot' : pct >= 75 ? ' mem-warm' : ''));
  setTop(r.ramTop, hasRam ? t.topRamName : null, t.topRam != null ? `${fmtGB(t.topRam)} GB` : '');

  let msg = null, buttons = false;
  if (t.needAdmin) {
    buttons = true;
    msg = lastElevateError ? I18N.t('tp.failed', { msg: lastElevateError }) : I18N.t('tp.needAdmin');
  } else if (t.cpu == null && t.driver && t.driver !== 'ok' && t.driver !== 'no-admin') {
    msg = DRIVER_MESSAGES.has(t.driver) ? I18N.t('drv.' + t.driver) : I18N.t('tp.driver', { v: t.driver });
  } else if (t.error && t.cpu == null && t.gpu == null) {
    msg = t.error;
  }

  r.status.classList.toggle('hidden', msg == null);
  if (msg != null) {
    r.elevate.classList.toggle('hidden', !buttons);
    r.auto.classList.toggle('hidden', !buttons);
    setText(r.statusText, msg);
  }
}

// ---------- motyw (kolor akcentu) ----------
// Wszystkie odcienie akcentu liczone z jednego koloru. Kolory "znaczeniowe" (temperatury, RAM,
// wzrost/spadek kursu) celowo zostaja zielone / zolte / czerwone niezaleznie od motywu.

const THEME_KEY = 'widget-theme-accent';
const DEFAULT_ACCENT = '#5eead4';
const THEME_PRESETS = ['#5eead4', '#60a5fa', '#818cf8', '#c084fc', '#f472b6', '#fb7185', '#fb923c', '#facc15', '#cbd5e1', '#6a1a87']
  .map((color, i) => [t('theme.presets')[i], color]);

// biezacy motyw (uzywany przez wykresy i pasek muzyki)
// chosen - wybrany kolor; accent - wariant do linii/tekstu (przy ciemnych kolorach rozjasniony)
const theme = { chosen: DEFAULT_ACCENT, accent: DEFAULT_ACCENT, rgb: '94,234,212', waveLine: '#a5f3fc', thumbFill: '#f0fdff' };

const clamp01 = v => Math.min(1, Math.max(0, v));
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
function luminance(c) {
  const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyTheme(hex) {
  const chosen = hexToRgb(hex) || hexToRgb(DEFAULT_ACCENT);
  const accent = rgbToHex(chosen);
  const white = [255, 255, 255];
  // Wariant do tekstu, ikon i linii: przy ciemnym kolorze (np. #6a1a87) rozjasniony w tym samym
  // odcieniu - inaczej na ciemnym tle bylby nieczytelny. Wypelnienia (przyciski, zaznaczenia)
  // zostaja w dokladnie wybranym kolorze.
  const [h0, s0, l0] = rgbToHsl(chosen);
  const rgb = luminance(chosen) < 0.2 ? hslToRgb(h0, s0, Math.max(l0, 0.68)).map(Math.round) : chosen;
  const fg = rgbToHex(rgb);
  const [h, s] = rgbToHsl(rgb);

  const css = document.documentElement.style; // CSSOM - dozwolone przy CSP bez stylow inline
  css.setProperty('--accent', accent);
  css.setProperty('--accent-fg', fg);
  css.setProperty('--accent-rgb', rgb.join(', '));
  css.setProperty('--accent-hover', rgbToHex(mixRgb(chosen, white, 0.2)));
  // tekst na przycisku w kolorze akcentu: ciemny na jasnym, jasny na ciemnym
  css.setProperty('--on-accent', luminance(chosen) > 0.4 ? '#0a0d12' : '#ffffff');

  // pasek muzyki: warstwy przesuniete w odcieniu (dla turkusu daje to dawne blekity).
  // Kierunek przesuniecia: chlodne barwy (turkus, niebieski, fiolet) w strone niebieskiego/fioletu,
  // cieple (zolty, pomaranczowy, rozowy) w strone czerwieni - zeby poswiata nigdy nie wpadla w zielen
  // zarezerwowana dla temperatur. Kolory stonowane (srebro, szarosci) zostaja stonowane.
  const muted = s < 0.4;
  const sat = muted ? s : Math.max(s, 0.85);
  const dir = h >= 150 && h <= 300 ? 1 : -1;
  const layer = (dh, l) => hslToRgb(h + (muted ? 0 : dir * dh), sat, l).map(Math.round).join(',');
  WAVE_LAYERS[0].rgb = layer(46, 0.6);
  WAVE_LAYERS[1].rgb = layer(28, 0.6);
  WAVE_LAYERS[2].rgb = rgb.join(',');
  WAVE_LAYERS[3].rgb = mixRgb(rgb, white, 0.86).map(Math.round).join(',');
  theme.chosen = accent;
  theme.accent = fg;
  theme.rgb = rgb.join(',');
  theme.waveLine = rgbToHex(mixRgb(rgb, white, 0.45));
  theme.thumbFill = rgbToHex(mixRgb(rgb, white, 0.92));

  // wykresy juz narysowane (linia w czytelnym wariancie)
  for (const v of views.values()) {
    if (!v.chart) continue;
    const ds = v.chart.data.datasets[0];
    ds.borderColor = fg;
    ds.pointHoverBackgroundColor = fg;
    v.chart.update('none');
  }
  kickWave();
  return accent;
}

// ---- przezroczystosc kart ----
const ALPHA_KEY = 'widget-card-alpha';
const DEFAULT_ALPHA = 0.62; // krycie kart (0.62 = przezroczystosc 38%)
const ALPHA_MIN = 0.2, ALPHA_MAX = 0.95;

function applyAlpha(alpha) {
  const a = Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, Number(alpha) || DEFAULT_ALPHA));
  document.documentElement.style.setProperty('--card-alpha', a.toFixed(2));
  return a;
}
function loadAlpha() {
  try { const v = parseFloat(localStorage.getItem(ALPHA_KEY)); return isNaN(v) ? DEFAULT_ALPHA : v; } catch { return DEFAULT_ALPHA; }
}
function saveAlpha(a) {
  try {
    if (Math.abs(a - DEFAULT_ALPHA) < 0.005) localStorage.removeItem(ALPHA_KEY);
    else localStorage.setItem(ALPHA_KEY, a.toFixed(2));
  } catch {}
}

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || DEFAULT_ACCENT; } catch { return DEFAULT_ACCENT; }
}
function saveTheme(hex) {
  try {
    if (hex.toLowerCase() === DEFAULT_ACCENT) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, hex);
  } catch {}
}

// Okienko wyboru koloru pod przyciskiem w pasku
function setupThemePicker() {
  const pop = $('themePop');
  const btn = $('themeBtn');
  const swatches = $('themeSwatches');
  const custom = $('themeCustom');

  for (const [name, color] of THEME_PRESETS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = name;
    b.dataset.color = color;
    b.style.background = color; // CSSOM (nie atrybut style) - zgodne z CSP
    swatches.appendChild(b);
  }

  const mark = (hex) => {
    swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === hex));
    custom.value = hex;
  };
  const choose = (hex, save) => {
    const applied = applyTheme(hex);
    mark(applied);
    if (save) saveTheme(applied);
  };
  const close = () => { pop.classList.add('hidden'); btn.classList.remove('active'); };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.classList.toggle('hidden') === false;
    btn.classList.toggle('active', open);
    if (open) { mark(theme.chosen); showAlpha(loadAlpha()); }
  });
  swatches.addEventListener('click', (e) => {
    const s = e.target.closest('.swatch');
    if (s) choose(s.dataset.color, true);
  });
  custom.addEventListener('input', () => choose(custom.value, false)); // podglad na zywo
  custom.addEventListener('change', () => choose(custom.value, true));
  $('themeReset').addEventListener('click', () => { choose(DEFAULT_ACCENT, true); showAlpha(applyAlpha(DEFAULT_ALPHA)); saveAlpha(DEFAULT_ALPHA); });

  // suwak przezroczystosci: pokazujemy przezroczystosc (100% - krycie), zapis po puszczeniu suwaka
  const range = $('alphaRange'), label = $('alphaValue');
  const showAlpha = (a) => { range.value = String(Math.round((1 - a) * 100)); label.textContent = Math.round((1 - a) * 100) + '%'; };
  range.min = String(Math.round((1 - ALPHA_MAX) * 100));
  range.max = String(Math.round((1 - ALPHA_MIN) * 100));
  range.addEventListener('input', () => showAlpha(applyAlpha(1 - range.value / 100)));
  range.addEventListener('change', () => saveAlpha(applyAlpha(1 - range.value / 100)));
  // jezyk: zapisuje go proces glowny (config.json) i przeladowuje okno z nowymi tekstami
  const langSwitch = $('langSwitch');
  langSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.lang === I18N.lang));
  langSwitch.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b || b.dataset.lang === I18N.lang) return;
    if (saveTimer) saveWidgets(); // niezapisana notatka
    ipcRenderer.send('set-lang', b.dataset.lang);
  });

  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ---------- narzedzia ----------

// Zapis do DOM tylko gdy wartosc sie zmienila (mniej przeliczen ukladu i odmalowan okna).
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setClass(el, cls) { if (el.className !== cls) el.className = cls; }
function setTitle(el, title) { if (el.title !== title) el.title = title; }

const priceFormats = new Map();
function formatPrice(price, vs) {
  const n = Number(price);
  const cur = (vs || 'usd').toUpperCase();
  const key = cur + (n < 1 ? ':6' : ':2');
  let f = priceFormats.get(key);
  if (f === undefined) {
    try { f = new Intl.NumberFormat(I18N.locale, { style: 'currency', currency: cur, maximumFractionDigits: n < 1 ? 6 : 2 }); }
    catch { f = null; } // nieznana waluta
    priceFormats.set(key, f);
  }
  return f ? f.format(n) : `${n.toLocaleString(I18N.locale, { maximumFractionDigits: 6 })} ${(vs || '').toUpperCase()}`;
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => HTML_ESC[c]);
}

init();
