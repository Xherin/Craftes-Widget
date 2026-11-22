// Tlumaczenia interfejsu: angielski (domyslny) i polski.
// Jezyk przechowuje proces glowny w config.json (tam tez korzysta z niego menu zasobnika);
// zmiana jezyka przeladowuje okno, wiec teksty i formaty liczb/dat ustawiane sa raz, przy starcie.
const I18N = (() => {
  const LANGS = { en: 'en-US', pl: 'pl-PL' };

  const STRINGS = {
    en: {
      // pasek i panel wygladu
      'bar.appearance': 'Appearance and language',
      'bar.refresh': 'Refresh all',
      'bar.lock': 'Lock layout',
      'bar.unlock': 'Unlock layout',
      'bar.add': 'Add widget',
      'bar.hide': 'Hide to tray',
      'theme.title': 'Theme color',
      'theme.custom': 'Custom color',
      'theme.alpha': 'Transparency',
      'theme.alphaAria': 'Card transparency',
      'theme.note': 'Temperature, RAM and price change colors stay the same.',
      'theme.reset': 'Default',
      'theme.resetTitle': 'Restore the default color and transparency',
      'theme.lang': 'Language',
      'theme.presets': ['Teal', 'Sky', 'Indigo', 'Violet', 'Pink', 'Coral', 'Orange', 'Gold', 'Silver', 'Purple'],
      // okno dodawania
      'modal.title': 'Add widget',
      'modal.sub': 'Choose what appears on the panel.',
      'modal.cancel': 'Cancel',
      'modal.add': 'Add',
      'modal.soon': 'soon',
      'modal.soonTitle': 'This widget is still in the works',
      'modal.noConfig': 'This widget has no settings.',
      'type.crypto': 'Crypto',
      'type.stock': 'Stocks',
      'type.temps': 'CPU / GPU / RAM',
      'type.music': 'Music',
      'type.todo': 'Tasks',
      'type.note': 'Note',
      'type.clock': 'Clock',
      'type.weather': 'Weather',
      'type.ai': 'AI / Deals',
      'cfg.cryptoSymbol': 'Symbol (bitcoin, ethereum, solana...)',
      'cfg.currency': 'Currency',
      'cfg.range': 'Chart range',
      'cfg.title': 'Title',
      'cfg.content': 'Content',
      'cfg.city': 'City',
      'cfg.symbol': 'Symbol',
      'cfg.stockHint': 'e.g. AAPL, NVDA · other exchanges with a suffix: SAP.DE, PKN.WA, 7203.T',
      'cfg.musicHint': 'Shows what is playing right now (Spotify, YouTube in the browser, etc.) and lets you control playback.',
      'range.1d': '1 day', 'range.5d': '5 days', 'range.1mo': '1 month', 'range.6mo': '6 months', 'range.1y': '1 year',
      'range.short.1y': '1Y',
      // domyslne tresci
      'def.noteTitle': 'Note',
      'def.noteContent': 'Click to edit...',
      'def.todoTitle': 'Tasks',
      'def.city': 'London',
      // karty
      'w.remove': 'Remove widget',
      'w.loading': 'Loading…',
      'w.unavailable': 'This widget type is not available yet.',
      'w.error': 'Error: {msg}',
      'title.crypto': 'Crypto • {s}',
      'title.stock': 'Stocks • {s}',
      'title.weather': 'Weather • {s}',
      'title.clock': 'Clock',
      'title.music': 'Music',
      // rynki
      'mk.chart': 'Chart',
      'mk.today': '(today)',
      'mk.closed': '(closed · {when})',
      'mk.closedTitle': 'Market closed – last price: {when}',
      'mk.stale': 'not refreshed',
      'mk.staleTitle': 'Could not refresh: {msg}',
      // pogoda
      'wx.notFound': 'City not found',
      'wx.feels': 'feels like {t}°',
      'wx.0': 'Clear sky', 'wx.2': 'Partly cloudy', 'wx.3': 'Overcast', 'wx.48': 'Fog', 'wx.57': 'Drizzle',
      'wx.67': 'Rain', 'wx.77': 'Snow', 'wx.82': 'Rain showers', 'wx.86': 'Snow showers', 'wx.99': 'Thunderstorm',
      // zadania
      'todo.placeholder': 'Add a task…',
      'todo.add': 'Add',
      'todo.clear': 'Remove completed',
      'todo.markDone': 'Mark as done',
      'todo.markUndone': 'Mark as not done',
      'todo.editHint': 'Double-click to edit',
      'todo.delete': 'Delete',
      'todo.count': '{done} / {total} done',
      'todo.empty': 'No tasks',
      // muzyka
      'music.nothing': 'Nothing playing',
      'music.untitled': 'Untitled',
      'music.unavailable': 'Music control unavailable',
      'music.prev': 'Previous',
      'music.toggle': 'Play / pause',
      'music.next': 'Next',
      // temperatury
      'tp.cpu': 'Processor',
      'tp.load': 'load {v}%',
      'tp.top': 'Using the most: {name} ({value})',
      'tp.elevate': 'Read CPU (admin)',
      'tp.elevating': 'Starting…',
      'tp.auto': 'always at startup',
      'tp.needAdmin': 'CPU temperature needs administrator rights (WinRing0 driver).',
      'tp.failed': 'Failed: {msg}',
      'tp.unknownError': 'unknown error',
      'tp.driver': 'Driver: {v}',
      'drv.blocked': 'The WinRing0 driver was blocked (Malwarebytes / Windows). Details: ohm/ohmhelper/driver.log',
      'drv.other-instance': 'The administrator helper already runs the driver – the CPU reading will appear shortly.',
      'drv.dir-not-writable': 'The ohm/ohmhelper folder is not writable – the driver has nowhere to unpack.'
    },
    pl: {
      'bar.appearance': 'Wygląd i język',
      'bar.refresh': 'Odśwież wszystko',
      'bar.lock': 'Zablokuj układ',
      'bar.unlock': 'Odblokuj układ',
      'bar.add': 'Dodaj widget',
      'bar.hide': 'Schowaj do zasobnika',
      'theme.title': 'Kolor motywu',
      'theme.custom': 'Własny kolor',
      'theme.alpha': 'Przezroczystość',
      'theme.alphaAria': 'Przezroczystość kart',
      'theme.note': 'Kolory temperatur, RAM i zmian kursów zostają bez zmian.',
      'theme.reset': 'Domyślne',
      'theme.resetTitle': 'Przywróć domyślny kolor i przezroczystość',
      'theme.lang': 'Język',
      'theme.presets': ['Turkus', 'Błękit', 'Indygo', 'Fiolet', 'Róż', 'Koral', 'Pomarańcz', 'Złoto', 'Srebro', 'Purpura'],
      'modal.title': 'Dodaj widget',
      'modal.sub': 'Wybierz, co ma się pojawić na panelu.',
      'modal.cancel': 'Anuluj',
      'modal.add': 'Dodaj',
      'modal.soon': 'wkrótce',
      'modal.soonTitle': 'Ten widget jeszcze powstaje',
      'modal.noConfig': 'Ten widget nie wymaga ustawień.',
      'type.crypto': 'Krypto',
      'type.stock': 'Akcje',
      'type.temps': 'CPU / GPU / RAM',
      'type.music': 'Muzyka',
      'type.todo': 'Zadania',
      'type.note': 'Notatka',
      'type.clock': 'Zegar',
      'type.weather': 'Pogoda',
      'type.ai': 'AI / Oferty',
      'cfg.cryptoSymbol': 'Symbol (bitcoin, ethereum, solana...)',
      'cfg.currency': 'Waluta',
      'cfg.range': 'Zakres wykresu',
      'cfg.title': 'Tytuł',
      'cfg.content': 'Treść',
      'cfg.city': 'Miasto',
      'cfg.symbol': 'Symbol',
      'cfg.stockHint': 'np. AAPL, NVDA · spółki z GPW z końcówką .WA (PKN.WA, CDR.WA)',
      'cfg.musicHint': 'Pokazuje to, co aktualnie gra (Spotify, YouTube w przeglądarce itp.) i pozwala sterować odtwarzaniem.',
      'range.1d': '1 dzień', 'range.5d': '5 dni', 'range.1mo': '1 miesiąc', 'range.6mo': '6 miesięcy', 'range.1y': '1 rok',
      'range.short.1y': '1R',
      'def.noteTitle': 'Notatka',
      'def.noteContent': 'Kliknij aby edytować...',
      'def.todoTitle': 'Zadania',
      'def.city': 'Jasło',
      'w.remove': 'Usuń widget',
      'w.loading': 'Ładowanie…',
      'w.unavailable': 'Ten typ widgetu nie jest jeszcze dostępny.',
      'w.error': 'Błąd: {msg}',
      'title.crypto': 'Krypto • {s}',
      'title.stock': 'Akcje • {s}',
      'title.weather': 'Pogoda • {s}',
      'title.clock': 'Zegar',
      'title.music': 'Muzyka',
      'mk.chart': 'Wykres',
      'mk.today': '(dziś)',
      'mk.closed': '(zamknięte · {when})',
      'mk.closedTitle': 'Giełda zamknięta – ostatni kurs: {when}',
      'mk.stale': 'brak odświeżenia',
      'mk.staleTitle': 'Nie udało się odświeżyć: {msg}',
      'wx.notFound': 'Nie znaleziono miasta',
      'wx.feels': 'odczuwalna {t}°',
      'wx.0': 'Bezchmurnie', 'wx.2': 'Częściowe zachmurzenie', 'wx.3': 'Pochmurno', 'wx.48': 'Mgła', 'wx.57': 'Mżawka',
      'wx.67': 'Deszcz', 'wx.77': 'Śnieg', 'wx.82': 'Przelotny deszcz', 'wx.86': 'Przelotny śnieg', 'wx.99': 'Burza',
      'todo.placeholder': 'Dodaj zadanie…',
      'todo.add': 'Dodaj',
      'todo.clear': 'Usuń zrobione',
      'todo.markDone': 'Oznacz jako zrobione',
      'todo.markUndone': 'Oznacz jako niezrobione',
      'todo.editHint': 'Kliknij dwukrotnie, aby edytować',
      'todo.delete': 'Usuń',
      'todo.count': '{done} / {total} zrobione',
      'todo.empty': 'Brak zadań',
      'music.nothing': 'Nic nie gra',
      'music.untitled': 'Bez tytułu',
      'music.unavailable': 'Sterowanie muzyką niedostępne',
      'music.prev': 'Poprzedni',
      'music.toggle': 'Odtwórz / pauza',
      'music.next': 'Następny',
      'tp.cpu': 'Procesor',
      'tp.load': 'obciążenie {v}%',
      'tp.top': 'Najwięcej zużywa: {name} ({value})',
      'tp.elevate': 'Odczyt CPU (admin)',
      'tp.elevating': 'Uruchamianie…',
      'tp.auto': 'zawsze przy starcie',
      'tp.needAdmin': 'Temperatura CPU wymaga uprawnień administratora (sterownik WinRing0).',
      'tp.failed': 'Nie udało się: {msg}',
      'tp.unknownError': 'nieznany błąd',
      'tp.driver': 'Sterownik: {v}',
      'drv.blocked': 'Sterownik WinRing0 został zablokowany (Malwarebytes / Windows). Szczegóły: ohm/ohmhelper/driver.log',
      'drv.other-instance': 'Sterownik obsługuje już helper administratora – odczyt CPU pojawi się za chwilę.',
      'drv.dir-not-writable': 'Brak zapisu do folderu ohm/ohmhelper – sterownik nie ma gdzie się wypakować.'
    }
  };

  let lang = 'en';
  try {
    const l = require('electron').ipcRenderer.sendSync('get-lang');
    if (STRINGS[l]) lang = l;
  } catch {}

  // t('todo.count', { done: 1, total: 3 }) -> "1 / 3 done"; brak klucza -> angielski, potem sam klucz
  function t(key, vars) {
    let s = STRINGS[lang][key];
    if (s === undefined) s = STRINGS.en[key];
    if (s === undefined) return key;
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }

  // Teksty statyczne z index.html: data-i18n (tresc), data-i18n-title, data-i18n-aria
  function applyStatic(root) {
    document.documentElement.lang = lang;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }

  return { lang, locale: LANGS[lang], langs: Object.keys(LANGS), t, applyStatic };
})();
const t = I18N.t;
