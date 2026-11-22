// Craftes widget - sterowanie muzyka przez Windows Media Session (GSMTC):
// dziala ze Spotify, przegladarkami (YouTube itp.), Windows Media Player i innymi aplikacjami,
// ktore pokazuja sie w systemowym panelu multimediow. Bez admina, bez sterownikow.
//
// stdout: linie JSON
//   {"type":"state", "has":..., "title":..., "artist":..., "app":..., "playing":..., "pos":s, "dur":s, ...}
//   {"type":"art", "data":"data:image/...;base64,..."}   (tylko przy zmianie utworu)
// stdin: "toggle" | "next" | "prev" | "quit"
// Konczy sie, gdy stdin zostanie zamkniety (zamkniety widget).
//
// Kompilowany z systemowymi plikami C:\Windows\System32\WinMetadata\*.winmd (bez Windows SDK),
// dlatego bez async/await - na operacje WinRT czekamy recznie (Wait()).

using System;
using System.Globalization;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class MediaHelper
{
    static GlobalSystemMediaTransportControlsSessionManager _mgr;
    static volatile bool _stop;
    static readonly object Lock = new object();
    static string _lastState, _lastArtKey;

    static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            _mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        }
        catch (Exception ex)
        {
            Emit("{\"type\":\"state\",\"has\":false,\"error\":" + Str(ex.Message) + "}");
            return 1;
        }

        var input = new Thread(ReadCommands) { IsBackground = true };
        input.Start();

        while (!_stop)
        {
            try { lock (Lock) Poll(); }
            catch (Exception ex) { Console.Error.WriteLine("poll: " + ex.Message); }
            for (int i = 0; i < 10 && !_stop; i++) Thread.Sleep(100); // ~1 s, szybka reakcja na "quit"
        }
        return 0;
    }

    // ---- czekanie na operacje WinRT ----

    static T Wait<T>(IAsyncOperation<T> op)
    {
        if (op.Status == AsyncStatus.Started)
        {
            using (var done = new ManualResetEventSlim(false))
            {
                op.Completed = delegate { done.Set(); };
                if (op.Status == AsyncStatus.Started) done.Wait(5000);
            }
        }
        if (op.Status == AsyncStatus.Error) throw new Exception("WinRT 0x" + op.ErrorCode.HResult.ToString("X8"));
        if (op.Status != AsyncStatus.Completed) throw new TimeoutException("WinRT timeout");
        return op.GetResults();
    }

    // ---- komendy ----

    static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "quit") break;
                try
                {
                    bool done = false;
                    lock (Lock)
                    {
                        var s = _mgr.GetCurrentSession();
                        if (s != null)
                        {
                            if (line == "toggle") { Wait(s.TryTogglePlayPauseAsync()); done = true; }
                            else if (line == "next") { Wait(s.TrySkipNextAsync()); done = true; }
                            else if (line == "prev") { Wait(s.TrySkipPreviousAsync()); done = true; }
                        }
                    }
                    if (!done) continue;
                    Thread.Sleep(150);
                    lock (Lock) Poll(); // szybka odpowiedz w UI po kliknieciu
                }
                catch (Exception ex) { Console.Error.WriteLine("cmd: " + ex.Message); }
            }
        }
        catch { }
        _stop = true;
    }

    // ---- stan ----

    static void Poll()
    {
        var s = _mgr.GetCurrentSession();
        if (s == null)
        {
            _lastArtKey = null;
            EmitState("{\"type\":\"state\",\"has\":false}");
            return;
        }

        GlobalSystemMediaTransportControlsSessionMediaProperties props = null;
        try { props = Wait(s.TryGetMediaPropertiesAsync()); } catch { }
        var pb = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        var ctl = pb.Controls;

        bool playing = pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        double dur = (tl.EndTime - tl.StartTime).TotalSeconds;
        double pos = (tl.Position - tl.StartTime).TotalSeconds;
        // pozycja jest aktualna na chwile LastUpdatedTime - renderer dolicza uplyw czasu podczas odtwarzania
        long posAt = tl.LastUpdatedTime.ToUnixTimeMilliseconds();

        string title = props != null ? props.Title : null;
        string artist = props != null ? (string.IsNullOrEmpty(props.Artist) ? props.AlbumArtist : props.Artist) : null;

        var sb = new StringBuilder(256);
        sb.Append("{\"type\":\"state\",\"has\":true");
        sb.Append(",\"title\":").Append(Str(title));
        sb.Append(",\"artist\":").Append(Str(artist));
        sb.Append(",\"album\":").Append(Str(props != null ? props.AlbumTitle : null));
        sb.Append(",\"app\":").Append(Str(AppName(s.SourceAppUserModelId)));
        sb.Append(",\"playing\":").Append(playing ? "true" : "false");
        sb.Append(",\"canToggle\":").Append(ctl.IsPlayPauseToggleEnabled || ctl.IsPlayEnabled || ctl.IsPauseEnabled ? "true" : "false");
        sb.Append(",\"canNext\":").Append(ctl.IsNextEnabled ? "true" : "false");
        sb.Append(",\"canPrev\":").Append(ctl.IsPreviousEnabled ? "true" : "false");
        bool hasTl = dur > 0;
        sb.Append(",\"dur\":").Append(hasTl ? Math.Round(dur, 1).ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"pos\":").Append(hasTl ? Math.Round(Math.Max(0, pos), 1).ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"posAt\":").Append(hasTl ? posAt.ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append('}');
        EmitState(sb.ToString());

        // okladka tylko przy zmianie utworu
        string artKey = (s.SourceAppUserModelId ?? "") + "|" + title + "|" + artist;
        if (props != null && artKey != _lastArtKey)
        {
            string data = null;
            try { data = ReadThumbnail(props.Thumbnail); } catch { }
            // niektore aplikacje podaja okladke chwile po tytule - wtedy probujemy w kolejnym cyklu
            if (data != null || props.Thumbnail == null) _lastArtKey = artKey;
            Emit("{\"type\":\"art\",\"data\":" + Str(data) + "}");
        }
    }

    static string ReadThumbnail(IRandomAccessStreamReference thumb)
    {
        if (thumb == null) return null;
        var ras = Wait(thumb.OpenReadAsync());
        try
        {
            ulong size = ras.Size;
            if (size == 0 || size > 4 * 1024 * 1024) return null;
            var reader = new DataReader(ras.GetInputStreamAt(0));
            try
            {
                uint loaded = Wait(reader.LoadAsync((uint)size));
                var bytes = new byte[loaded];
                reader.ReadBytes(bytes);
                string type = string.IsNullOrEmpty(ras.ContentType) ? "image/png" : ras.ContentType;
                return "data:" + type + ";base64," + Convert.ToBase64String(bytes);
            }
            finally { reader.Dispose(); }
        }
        finally { ras.Dispose(); }
    }

    static readonly string[][] KnownApps =
    {
        new[] { "spotify", "Spotify" }, new[] { "operagx", "Opera GX" }, new[] { "opera", "Opera" },
        new[] { "msedge", "Edge" }, new[] { "chrome", "Chrome" }, new[] { "firefox", "Firefox" },
        new[] { "brave", "Brave" }, new[] { "vivaldi", "Vivaldi" }, new[] { "zunemusic", "Media Player" },
        new[] { "zunevideo", "Filmy i TV" }, new[] { "vlc", "VLC" }, new[] { "tidal", "TIDAL" },
        new[] { "deezer", "Deezer" }, new[] { "applemusic", "Apple Music" }, new[] { "itunes", "iTunes" },
        new[] { "discord", "Discord" }, new[] { "foobar", "foobar2000" }, new[] { "aimp", "AIMP" }
    };

    // "Spotify.exe" / "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" /
    // "OperaSoftware.OperaGXWebBrowser.1737826349" -> czytelna nazwa
    static string AppName(string aumid)
    {
        if (string.IsNullOrEmpty(aumid)) return null;
        string key = aumid.ToLowerInvariant().Replace(" ", "");
        foreach (var k in KnownApps) if (key.Contains(k[0])) return k[1];

        string s = aumid;
        int bang = s.LastIndexOf('!');
        if (bang >= 0) s = s.Substring(bang + 1);
        int slash = s.LastIndexOfAny(new[] { '\\', '/' });
        if (slash >= 0) s = s.Substring(slash + 1);
        if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s.Substring(0, s.Length - 4);
        // "Firma.NazwaAplikacji.123" -> najdluzszy czlon bez cyfr
        string best = s;
        if (s.IndexOf('.') >= 0)
        {
            best = "";
            foreach (string part in s.Split('.'))
                if (part.Length > best.Length && part.IndexOfAny("0123456789".ToCharArray()) < 0) best = part;
            if (best.Length == 0) best = s;
        }
        if (best.Length > 0) best = char.ToUpperInvariant(best[0]) + best.Substring(1);
        return best;
    }

    // ---- wyjscie ----

    static void EmitState(string json)
    {
        if (json == _lastState) return; // tylko zmiany
        _lastState = json;
        Emit(json);
    }

    static void Emit(string line)
    {
        try { Console.Out.WriteLine(line); Console.Out.Flush(); }
        catch { _stop = true; }
    }

    static string Str(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2).Append('"');
        foreach (char ch in s)
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }
}
