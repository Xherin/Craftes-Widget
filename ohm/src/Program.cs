// Craftes widget - sensor helper (OpenHardwareMonitorLib, sterownik WinRing0 wbudowany w DLL).
// Kompilacja: ohm\build.cmd (csc z .NET Framework, bez NuGet i bez pobierania czegokolwiek).
//
// Tryby:
//   ohmhelper.exe                 -> jeden odczyt, jedna linia JSON, wyjscie
//   ohmhelper.exe --loop 2000     -> proces staly: linia JSON co 2000 ms na stdout; konczy sie gdy stdin zostanie zamkniety
//   ohmhelper.exe --loop 2000 --pipe NAZWA --parent 1234
//                                 -> tryb uruchamiany przez UAC jako admin: linie JSON przez nazwany potok
//                                    \\.\pipe\NAZWA utworzony przez widget; konczy sie, gdy widget zamknie
//                                    potok albo proces o PID 1234 przestanie istniec
//   ohmhelper.exe --report        -> pelny raport biblioteki (diagnostyka) na stdout
//
// Pliki tymczasowe / sterowniki - wszystko zostaje w ohm\ohmhelper:
//  * Computer.Open(portable: true)  -> WinRing0 wypakowany jako ohm\ohmhelper\ohmhelper.sys
//    (Open(false) = ZAWSZE %TEMP%\tmpXXXX.sys w AppData - to powodowalo alarmy Malwarebytes)
//  * TMP/TEMP procesu przekierowane do ohm\ohmhelper\tmp - nic nie trafia do AppData\Local\Temp
//  * InpOut (inpoutx64.dll + sterownik w System32, uzywany przez RyzenSMU tylko do tabeli mocy)
//    jest zablokowany - temperatury CPU go nie potrzebuja.
//
// Bezpieczenstwo trybu admina (folder projektu jest zapisywalny dla zwyklego konta):
//  * odczyty ida nazwanym potokiem, nie plikiem - proces admina nie zapisuje plikow z danymi,
//  * do potoku laczymy sie z poziomem Identification - serwer potoku nie moze podszyc sie
//    pod token administratora (ochrona przed podstawionym potokiem),
//  * przed wypakowaniem sterownika usuwamy istniejaca nazwe ohmhelper.sys (gdyby byla podstawionym
//    dowiazaniem do innego pliku), test zapisu uzywa nowego, losowego pliku (CreateNew),
//  * folder tmp nie jest czyszczony, jesli jest punktem ponownej analizy (junction/dowiazanie).
//
// Wydajnosc: sensory sa wybierane raz i zapamietywane; w kazdym cyklu aktualizowany jest tylko
// sprzet, z ktorego pochodza (CPU + wybrane GPU), a JSON sklada sie z gotowych fragmentow.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Threading;
using OpenHardwareMonitor.Hardware;

static class Program
{
    const BindingFlags AnyStatic = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    static readonly Assembly Lib = typeof(Computer).Assembly;

    static volatile bool _stop;

    // Wybrane (zapamietane) sensory i sprzet do aktualizacji
    static ISensor _cpuTemp, _cpuLoad, _gpuTemp, _gpuLoad, _vramUsed, _vramTotal;
    static IHardware _cpuHw, _gpuHw;
    static bool _picked;
    static string _staticJson; // stala koncowka JSON (nazwy, flagi)
    static bool _admin, _dirWritable, _ring0;
    static string _driverStatus = "unknown";
    static string _driverReport; // raport biblioteki, gdy sterownik nie wstal (zapisuje go widget)

    static int Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        Directory.SetCurrentDirectory(exeDir);

        bool loop = false, report = false;
        int interval = 2000, parentPid = 0;
        string pipeName = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--loop":
                    loop = true;
                    int v;
                    if (i + 1 < args.Length && int.TryParse(args[i + 1], out v)) { interval = Math.Max(500, v); i++; }
                    break;
                case "--report": report = true; break;
                case "--pipe": if (i + 1 < args.Length) pipeName = args[++i]; break;
                case "--parent": if (i + 1 < args.Length) int.TryParse(args[++i], out parentPid); break;
            }
        }

        if (Array.IndexOf(args, "--bench") >= 0) { Console.WriteLine(ProcStats.Bench()); return 0; }
        if (pipeName != null && !ValidPipeName(pipeName)) { Console.Error.WriteLine("zla nazwa potoku"); return 2; }

        bool admin = IsAdmin();
        bool dirWritable = CanWrite(exeDir);

        // %TEMP% tylko w naszym folderze (biblioteka uzywa Path.GetTempFileName w kilku miejscach).
        // Jesli tmp jest junction/dowiazaniem (podmienionym), nie uzywamy go i nie czyscimy.
        string tmpDir = Path.Combine(exeDir, "tmp");
        bool tmpUsable = false;
        if (dirWritable)
        {
            try
            {
                Directory.CreateDirectory(tmpDir);
                if (!IsReparsePoint(tmpDir))
                {
                    tmpUsable = true;
                    Environment.SetEnvironmentVariable("TMP", tmpDir);
                    Environment.SetEnvironmentVariable("TEMP", tmpDir);
                    CleanDir(tmpDir);
                }
                else Console.Error.WriteLine("tmp jest punktem ponownej analizy - pomijam");
            }
            catch { }
        }

        // Jedna instancja z dostepem do sterownika naraz (inaczej druga nie moze nadpisac .sys).
        bool ownsMutex = false;
        Mutex mutex = null;
        if (admin)
        {
            try { mutex = new Mutex(true, "Global\\CraftesWidgetOhmHelper", out ownsMutex); }
            catch { ownsMutex = false; }
        }

        // Tryb admina (--pipe): jesli inny helper juz trzyma sterownik, to on dostarcza odczyty.
        // Druga kopia nic by nie dodala (bez sterownika) - konczymy od razu.
        if (pipeName != null && admin && !ownsMutex)
        {
            if (mutex != null) mutex.Dispose();
            Console.Error.WriteLine("inny helper administratora juz dziala - koniec");
            return 3;
        }

        BlockInpOut();

        bool ring0Wanted = admin && dirWritable && ownsMutex;
        // Biblioteka wypakuje sterownik jako <exe>.sys. Gdyby pod ta nazwa lezalo podstawione dowiazanie
        // (symlink/hardlink do innego pliku), zapis jako admin trafilby w cel dowiazania - usuwamy nazwe
        // (usuniecie dowiazania nie rusza pliku docelowego) i biblioteka tworzy swiezy plik.
        if (ring0Wanted) RemoveName(Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".sys"));

        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMotherboardEnabled = false,
            IsMemoryEnabled = false,
            IsStorageEnabled = false,
            IsNetworkEnabled = false,
            IsControllerEnabled = false,
            IsBatteryEnabled = false,
            IsPsuEnabled = false,
            // Bez admina sterownika i tak nie da sie zainstalowac; bez zapisu do folderu nie ma gdzie go wypakowac.
            IsRing0Enabled = ring0Wanted
        };

        try { computer.Open(true); } // true = "portable": sterownik obok exe, nie w %TEMP%
        catch (Exception ex) { Console.Error.WriteLine("open: " + ex.Message); }

        bool ring0 = Ring0IsOpen(); // nie zmienia sie po Open() - sprawdzamy raz
        _admin = admin;
        _dirWritable = dirWritable;
        _ring0 = ring0;
        _driverStatus = !admin ? "no-admin"
            : !dirWritable ? "dir-not-writable"
            : !ownsMutex ? "other-instance"
            : ring0 ? "ok" : "blocked";
        if (_driverStatus == "blocked")
            _driverReport = DateTime.Now.ToString("s") + " WinRing0 nie zostal zaladowany\r\n" + (Ring0Report() ?? "(brak raportu)");

        NamedPipeClientStream pipe = null;
        try
        {
            if (report)
            {
                UpdateAll(computer);
                Thread.Sleep(500);
                UpdateAll(computer);
                Console.WriteLine("admin=" + admin + " dirWritable=" + dirWritable + " ring0=" + ring0);
                Console.WriteLine(computer.GetReport());
                return 0;
            }

            // Pierwszy odczyt: pelna aktualizacja, wybor sensorow, drugi odczyt
            // (obciazenie CPU liczone jest z roznicy miedzy odczytami).
            UpdateAll(computer);
            Pick(computer);
            ProcStats.Sample(); // pierwsza probka (procenty CPU/GPU procesow licza sie z roznicy)
            Thread.Sleep(300);

            if (!loop)
            {
                UpdatePicked(computer);
                ProcStats.Sample();
                Console.WriteLine(Read());
                Console.Out.Flush();
                return 0;
            }

            Process parent = null;
            if (parentPid > 0)
            {
                try { parent = Process.GetProcessById(parentPid); }
                catch { return 2; } // rodzica juz nie ma
            }

            TextWriter output;
            if (pipeName != null)
            {
                // Identification: serwer potoku moze sprawdzic, kim jestesmy, ale nie moze dzialac
                // z naszym tokenem administratora (podszywanie sie)
                pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.None,
                    TokenImpersonationLevel.Identification);
                try { pipe.Connect(15000); }
                catch (Exception ex) { Console.Error.WriteLine("potok: " + ex.Message); return 4; }
                output = new StreamWriter(pipe, Utf8) { AutoFlush = false };
            }
            else
            {
                output = Console.Out;
                // Tryb stdout: konczymy gdy rodzic (Electron) zamknie stdin albo przysle "quit".
                var stdinThread = new Thread(delegate ()
                {
                    try
                    {
                        string line;
                        while ((line = Console.In.ReadLine()) != null)
                        {
                            line = line.Trim();
                            if (line == "quit" || line == "exit") break;
                        }
                    }
                    catch { }
                    _stop = true;
                });
                stdinThread.IsBackground = true;
                stdinThread.Start();
            }

            int tick = 0;
            while (!_stop)
            {
                string json;
                try
                {
                    UpdatePicked(computer);
                    ProcStats.Sample(++tick % 2 == 1); // procesy co drugi odczyt (co 4 s przy 2 s)
                    json = Read();
                }
                catch (Exception ex)
                {
                    json = "{\"error\":" + Str(ex.Message) + "}";
                }

                try { output.WriteLine(json); output.Flush(); }
                catch { break; } // potok / stdout zamkniety - widget zakonczyl prace

                // Czekanie z przerwaniem: stdin zamkniety albo rodzic zakonczony
                for (int t = 0; t < interval && !_stop; t += 250)
                {
                    Thread.Sleep(Math.Min(250, interval - t));
                    if (parent != null && parent.HasExited) _stop = true;
                }
            }
            return 0;
        }
        finally
        {
            if (pipe != null) { try { pipe.Dispose(); } catch { } }
            // Close() zatrzymuje i usuwa usluge sterownika oraz plik .sys
            try { computer.Close(); } catch { }
            if (tmpUsable && !IsReparsePoint(tmpDir)) CleanDir(tmpDir);
            if (mutex != null) { try { if (ownsMutex) mutex.ReleaseMutex(); mutex.Dispose(); } catch { } }
        }
    }

    // Nazwa potoku od widgetu: tylko litery, cyfry i myslnik (bez "\" i "..")
    static bool ValidPipeName(string name)
    {
        if (name.Length < 8 || name.Length > 100) return false;
        foreach (char c in name) if (!(char.IsLetterOrDigit(c) || c == '-')) return false;
        return true;
    }

    static bool IsReparsePoint(string path)
    {
        try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
        catch { return true; } // nie da sie sprawdzic - traktujemy jak niebezpieczne
    }

    // Usuwa sama nazwe pliku (przy dowiazaniu nie rusza celu)
    static void RemoveName(string path)
    {
        try { if (File.Exists(path) || IsReparsePoint(path)) File.Delete(path); }
        catch (Exception ex) { Console.Error.WriteLine("usuwanie " + Path.GetFileName(path) + ": " + ex.Message); }
    }

    // ---- aktualizacja sprzetu ----

    static void UpdateAll(Computer c)
    {
        foreach (IHardware hw in c.Hardware) UpdateRec(hw);
    }

    static void UpdateRec(IHardware hw)
    {
        try { hw.Update(); } catch { }
        foreach (IHardware sub in hw.SubHardware) UpdateRec(sub);
    }

    // Tylko sprzet, z ktorego czytamy; jesli wybrany sensor przestal dawac wartosc - ponowny wybor.
    static void UpdatePicked(Computer c)
    {
        if (!_picked) { UpdateAll(c); Pick(c); return; }
        if (_cpuHw != null) UpdateRec(_cpuHw);
        if (_gpuHw != null) UpdateRec(_gpuHw);
        if ((_cpuTemp != null && !Valid(_cpuTemp, SensorType.Temperature)) ||
            (_gpuTemp != null && !Valid(_gpuTemp, SensorType.Temperature)))
        {
            Pick(c);
        }
    }

    // ---- wybor sensorow (raz) ----

    static readonly string[] CpuTempPrefs = { "Tctl/Tdie", "Tdie", "Tctl", "CPU Package", "Package", "Core Average", "Core Max", "CCD" };
    static readonly string[] GpuTempPrefs = { "GPU Core", "Core", "GPU Hot Spot", "Hot Spot", "Edge" };
    static readonly string[] CpuLoadPrefs = { "CPU Total", "Total" };
    static readonly string[] GpuLoadPrefs = { "GPU Core", "D3D 3D", "Core" };
    static readonly string[] VramUsedPrefs = { "GPU Memory Used", "D3D Dedicated Memory Used" };
    static readonly string[] VramTotalPrefs = { "GPU Memory Total", "D3D Dedicated Memory Total" };

    static void Pick(Computer c)
    {
        _cpuHw = _gpuHw = null;
        _cpuTemp = _cpuLoad = _gpuTemp = _gpuLoad = _vramUsed = _vramTotal = null;
        int gpuRank = int.MaxValue;

        foreach (IHardware hw in c.Hardware)
        {
            if (hw.HardwareType == HardwareType.Cpu)
            {
                if (_cpuHw != null) continue;
                var sensors = new List<ISensor>();
                Collect(hw, sensors);
                _cpuHw = hw;
                // AMD: Tctl/Tdie, Intel: CPU Package; potem srednia/maks rdzeni, potem najgoretszy sensor.
                _cpuTemp = FindByName(sensors, SensorType.Temperature, CpuTempPrefs) ?? MaxTemp(sensors);
                _cpuLoad = FindByName(sensors, SensorType.Load, CpuLoadPrefs);
            }
            else if (hw.HardwareType == HardwareType.GpuNvidia || hw.HardwareType == HardwareType.GpuAmd || hw.HardwareType == HardwareType.GpuIntel)
            {
                var sensors = new List<ISensor>();
                Collect(hw, sensors);
                ISensor t = FindByName(sensors, SensorType.Temperature, GpuTempPrefs) ?? FirstValid(sensors, SensorType.Temperature);
                // Preferuj dedykowane GPU (Nvidia/AMD) nad zintegrowanym Intelem.
                int rank = hw.HardwareType == HardwareType.GpuIntel ? 1 : 0;
                if ((t != null && rank < gpuRank) || _gpuHw == null)
                {
                    if (t != null) gpuRank = rank;
                    _gpuHw = hw;
                    _gpuTemp = t;
                    _gpuLoad = FindByName(sensors, SensorType.Load, GpuLoadPrefs);
                    // VRAM (MB) z NvAPI/ADL; Intel/inne: pamiec dedykowana z D3D
                    _vramUsed = FindByName(sensors, SensorType.SmallData, VramUsedPrefs);
                    _vramTotal = FindByName(sensors, SensorType.SmallData, VramTotalPrefs);
                }
            }
        }
        _picked = true;
        _staticJson = BuildStaticJson(); // nazwy sprzetu moga sie zmienic po ponownym wyborze
        TrimGpu(_gpuHw, _gpuLoad);
    }

    // Nvidia: Update() kosztuje ~60 ms, glownie przez NVML (moc + 2x przepustowosc PCIe, kazda
    // probkuje ~20 ms) i liczniki D3D. Widget uzywa tylko temperatury i obciazenia z NvAPI,
    // wiec wylaczamy te zrodla w instancji GPU (-> ~2.5 ms). Licznikow D3D nie ruszamy,
    // jesli obciazenie pochodzi z sensora "D3D ...".
    static void TrimGpu(IHardware gpu, ISensor load)
    {
        if (gpu == null || gpu.HardwareType != HardwareType.GpuNvidia) return;
        const BindingFlags inst = BindingFlags.Instance | BindingFlags.NonPublic;
        try
        {
            Type t = gpu.GetType();
            FieldInfo nvml = t.GetField("_nvmlDevice", inst);
            if (nvml != null) nvml.SetValue(gpu, null);
            bool loadFromD3D = load != null && load.Name.StartsWith("D3D", StringComparison.OrdinalIgnoreCase);
            FieldInfo d3d = t.GetField("_d3dDeviceId", inst);
            if (d3d != null && !loadFromD3D) d3d.SetValue(gpu, null);
        }
        catch (Exception ex) { Console.Error.WriteLine("gpu trim: " + ex.Message); }
    }

    static void Collect(IHardware hw, List<ISensor> into)
    {
        into.AddRange(hw.Sensors);
        foreach (IHardware sub in hw.SubHardware) Collect(sub, into);
    }

    static bool Valid(ISensor s, SensorType type)
    {
        if (s.SensorType != type) return false;
        float? v = s.Value;
        if (!v.HasValue) return false;
        float f = v.Value;
        if (float.IsNaN(f) || float.IsInfinity(f)) return false;
        return type != SensorType.Temperature || (f > 1 && f < 125);
    }

    static ISensor FindByName(List<ISensor> sensors, SensorType type, string[] names)
    {
        foreach (string n in names)
            foreach (ISensor s in sensors)
                if (Valid(s, type) && s.Name.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0)
                    return s;
        return null;
    }

    static ISensor FirstValid(List<ISensor> sensors, SensorType type)
    {
        foreach (ISensor s in sensors) if (Valid(s, type)) return s;
        return null;
    }

    static ISensor MaxTemp(List<ISensor> sensors)
    {
        ISensor best = null;
        foreach (ISensor s in sensors)
            if (Valid(s, SensorType.Temperature) && (best == null || s.Value.Value > best.Value.Value)) best = s;
        return best;
    }

    // ---- JSON ----

    static string Read()
    {
        var sb = new StringBuilder(320);
        sb.Append("{\"cpu\":").Append(Num(_cpuTemp, SensorType.Temperature));
        sb.Append(",\"gpu\":").Append(Num(_gpuTemp, SensorType.Temperature));
        sb.Append(",\"cpuLoad\":").Append(Num(_cpuLoad, SensorType.Load));
        sb.Append(",\"gpuLoad\":").Append(Num(_gpuLoad, SensorType.Load));
        sb.Append(",\"vramUsed\":").Append(Num(_vramUsed, SensorType.SmallData));
        sb.Append(",\"vramTotal\":").Append(Num(_vramTotal, SensorType.SmallData));
        const long MB = 1024 * 1024;
        sb.Append(",\"ramUsed\":").Append(ProcStats.RamTotal > 0 ? (ProcStats.RamUsed / MB).ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"ramTotal\":").Append(ProcStats.RamTotal > 0 ? (ProcStats.RamTotal / MB).ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"topCpuName\":").Append(Str(ProcStats.TopCpuName));
        sb.Append(",\"topCpu\":").Append(Pct(ProcStats.TopCpu, ProcStats.TopCpuName));
        sb.Append(",\"topRamName\":").Append(Str(ProcStats.TopRamName));
        sb.Append(",\"topRam\":").Append(ProcStats.TopRamName != null ? (ProcStats.TopRamBytes / MB).ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"topGpuName\":").Append(Str(ProcStats.TopGpuName));
        sb.Append(",\"topGpu\":").Append(Pct(ProcStats.TopGpu, ProcStats.TopGpuName));
        sb.Append(_staticJson);
        return sb.ToString();
    }

    static string BuildStaticJson()
    {
        var sb = new StringBuilder(200);
        sb.Append(",\"cpuName\":").Append(Str(_cpuHw != null ? _cpuHw.Name : null));
        sb.Append(",\"gpuName\":").Append(Str(_gpuHw != null ? _gpuHw.Name : null));
        sb.Append(",\"admin\":").Append(_admin ? "true" : "false");
        sb.Append(",\"dirWritable\":").Append(_dirWritable ? "true" : "false");
        sb.Append(",\"ring0\":").Append(_ring0 ? "true" : "false");
        sb.Append(",\"driver\":").Append(Str(_driverStatus));
        // raport tylko przy problemie ze sterownikiem; plik driver.log zapisuje widget (nie proces admina)
        if (_driverReport != null) sb.Append(",\"driverReport\":").Append(Str(_driverReport));
        sb.Append('}');
        return sb.ToString();
    }

    // Wartosci calkowite (widget i tak zaokragla) - wiecej identycznych odczytow = mniej odswiezen UI.
    static string Num(ISensor s, SensorType type)
    {
        if (s == null || !Valid(s, type)) return "null";
        return ((int)Math.Round(s.Value.Value, MidpointRounding.AwayFromZero)).ToString(CultureInfo.InvariantCulture);
    }

    static string Pct(double v, string name)
    {
        if (name == null || double.IsNaN(v)) return "null";
        return ((int)Math.Round(v, MidpointRounding.AwayFromZero)).ToString(CultureInfo.InvariantCulture);
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

    // ---- pliki ----

    static void CleanDir(string dir)
    {
        try { foreach (string f in Directory.GetFiles(dir)) { try { File.Delete(f); } catch { } } }
        catch { }
    }

    static bool CanWrite(string dir)
    {
        // Nowy, losowy plik (CreateNew nie otwiera istniejacego - wiec nie pojdzie za podstawionym
        // dowiazaniem), kasowany przy zamknieciu
        try
        {
            string probe = Path.Combine(dir, ".write-test-" + Guid.NewGuid().ToString("N"));
            using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { }
            return true;
        }
        catch { return false; }
    }

    // ---- dostep do wewnetrznych klas biblioteki ----

    // RyzenSMU wola InpOut.Open(), ktory ZAWSZE wypakowuje inpoutx64.dll do %TEMP% i instaluje
    // sterownik inpoutx64.sys w System32. Oznaczamy InpOut jako "otwarty" bez bibliotek -
    // ReadMemory przy pustych delegatach zwraca null (brak tabeli mocy), temperatury dzialaja dalej.
    static void BlockInpOut()
    {
        try
        {
            Type t = Lib.GetType("OpenHardwareMonitor.Hardware.InpOut");
            if (t == null) return;
            FieldInfo f = t.GetField("<IsOpen>k__BackingField", AnyStatic);
            if (f != null) { f.SetValue(null, true); return; }
            PropertyInfo p = t.GetProperty("IsOpen", AnyStatic);
            if (p != null && p.CanWrite) p.SetValue(null, true, null);
        }
        catch (Exception ex) { Console.Error.WriteLine("inpout block: " + ex.Message); }
    }

    static bool Ring0IsOpen()
    {
        try
        {
            Type t = Lib.GetType("OpenHardwareMonitor.Hardware.Ring0");
            PropertyInfo p = t == null ? null : t.GetProperty("IsOpen", AnyStatic);
            return p != null && (bool)p.GetValue(null, null);
        }
        catch { return false; }
    }

    static string Ring0Report()
    {
        try
        {
            Type t = Lib.GetType("OpenHardwareMonitor.Hardware.Ring0");
            MethodInfo m = t == null ? null : t.GetMethod("GetReport", AnyStatic);
            return m == null ? null : m.Invoke(null, null) as string;
        }
        catch { return null; }
    }

    static bool IsAdmin()
    {
        try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
        catch { return false; }
    }
}
