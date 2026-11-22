// Statystyki systemu i procesow dla widgetu (bez sterownika, bez admina):
//  * RAM: GlobalMemoryStatusEx
//  * procesy: jedno wywolanie NtQuerySystemInformation(SystemProcessInformation) - to samo zrodlo co
//    Menedzer zadan: czasy CPU i prywatny zestaw roboczy ("Pamiec") wszystkich procesow naraz
//    (Process.GetProcesses + TotalProcessorTime kosztowalo ~36 ms, to ~1-2 ms)
//  * GPU per proces: licznik wydajnosci "GPU Engine" (jak kolumna GPU w Menedzerze zadan)
// Wyniki sumowane po nazwie procesu (np. wszystkie chrome.exe razem), jak grupowanie w Menedzerze zadan.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

static class ProcStats
{
    public static string TopCpuName, TopRamName, TopGpuName;
    public static double TopCpu, TopGpu;      // %
    public static long TopRamBytes;
    public static long RamTotal, RamUsed;     // bajty

    // ---- RAM ----

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORYSTATUSEX
    {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);

    static void SampleRam()
    {
        var m = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)) };
        if (!GlobalMemoryStatusEx(ref m)) return;
        RamTotal = (long)m.ullTotalPhys;
        RamUsed = (long)(m.ullTotalPhys - m.ullAvailPhys);
    }

    // ---- procesy (CPU + RAM) ----

    [DllImport("ntdll.dll")]
    static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);

    const int SystemProcessInformation = 5;
    const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);

    // Uklad SYSTEM_PROCESS_INFORMATION dla procesu 64-bit
    const int OffNext = 0, OffWorkingSetPrivate = 8, OffCreateTime = 32, OffUserTime = 40, OffKernelTime = 48,
              OffNameLen = 56, OffNameBuf = 64, OffPid = 80;

    static IntPtr _buf = IntPtr.Zero;
    static int _bufSize = 0;
    // klucz procesu: pid ^ czas utworzenia (odporny na ponowne uzycie PID)
    static Dictionary<long, long> _prevCpu = new Dictionary<long, long>(), seen = new Dictionary<long, long>();
    static Dictionary<long, string> _names = new Dictionary<long, string>(), namesNext = new Dictionary<long, string>();
    static readonly Dictionary<string, double> cpuByName = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, long> ramByName = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
    static long _prevTicks;
    static readonly int OwnPid = Process.GetCurrentProcess().Id; // sam helper nie jest "topem"
    static readonly Dictionary<int, string> _pidNames = new Dictionary<int, string>();
    static readonly HashSet<string> Skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "Idle", "System Idle Process", "Memory Compression", "Secure System", "Registry" };

    static bool QueryProcesses()
    {
        if (_buf == IntPtr.Zero) { _bufSize = 1 << 20; _buf = Marshal.AllocHGlobal(_bufSize); }
        for (int attempt = 0; attempt < 4; attempt++)
        {
            int needed;
            int status = NtQuerySystemInformation(SystemProcessInformation, _buf, _bufSize, out needed);
            if (status == 0) return true;
            if (status != STATUS_INFO_LENGTH_MISMATCH) return false;
            Marshal.FreeHGlobal(_buf);
            _bufSize = Math.Max(needed, _bufSize) + (256 << 10);
            _buf = Marshal.AllocHGlobal(_bufSize);
        }
        return false;
    }

    static void SampleProcesses()
    {
        if (IntPtr.Size != 8 || !QueryProcesses()) return;

        long nowTicks = DateTime.UtcNow.Ticks;
        double elapsed = _prevTicks == 0 ? 0 : (nowTicks - _prevTicks) * (double)Environment.ProcessorCount;
        _prevTicks = nowTicks;

        cpuByName.Clear();
        ramByName.Clear();
        seen.Clear();
        _pidNames.Clear();

        int offset = 0;
        while (true)
        {
            IntPtr p = new IntPtr(_buf.ToInt64() + offset);
            int pid = (int)Marshal.ReadInt64(p, OffPid);
            if (pid != 0)
            {
                long key = ((long)pid << 32) ^ Marshal.ReadInt64(p, OffCreateTime);
                string name;
                if (!_names.TryGetValue(key, out name)) // nazwa czytana tylko dla nowych procesow
                {
                    int nameLen = Marshal.ReadInt16(p, OffNameLen) & 0xFFFF;
                    IntPtr nameBuf = Marshal.ReadIntPtr(p, OffNameBuf);
                    name = nameLen > 0 && nameBuf != IntPtr.Zero ? Marshal.PtrToStringUni(nameBuf, nameLen / 2) : "System";
                    if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
                    name = string.Intern(name);
                }
                namesNext[key] = name;
                _pidNames[pid] = name;

                if (pid != OwnPid && !Skip.Contains(name))
                {
                    long cpu = Marshal.ReadInt64(p, OffUserTime) + Marshal.ReadInt64(p, OffKernelTime);
                    seen[key] = cpu;
                    long prev;
                    if (elapsed > 0 && _prevCpu.TryGetValue(key, out prev) && cpu >= prev)
                    {
                        double pct = (cpu - prev) / elapsed * 100.0;
                        double cur;
                        cpuByName.TryGetValue(name, out cur);
                        cpuByName[name] = cur + pct;
                    }
                    long ws = Marshal.ReadInt64(p, OffWorkingSetPrivate);
                    long curWs;
                    ramByName.TryGetValue(name, out curWs);
                    ramByName[name] = curWs + ws;
                }
            }
            int next = Marshal.ReadInt32(p, OffNext);
            if (next == 0) break;
            offset += next;
        }

        // zamiana buforow zamiast kopiowania; znikniete procesy wypadaja same
        var t1 = _prevCpu; _prevCpu = seen; seen = t1;
        var t2 = _names; _names = namesNext; namesNext = t2;
        namesNext.Clear();

        string best = null; double bestV = -1;
        foreach (var kv in cpuByName) if (kv.Value > bestV) { bestV = kv.Value; best = kv.Key; }
        if (best != null) { TopCpuName = best; TopCpu = Math.Min(100, bestV); }

        best = null; long bestR = -1;
        foreach (var kv in ramByName) if (kv.Value > bestR) { bestR = kv.Value; best = kv.Key; }
        if (best != null) { TopRamName = best; TopRamBytes = bestR; }
    }

    // ---- GPU per proces ----

    static PerformanceCounterCategory _gpuCat;
    static bool _gpuDisabled;
    static Dictionary<string, CounterSample> _prevGpu = new Dictionary<string, CounterSample>();

    static void SampleGpu()
    {
        if (_gpuDisabled) return;
        InstanceDataCollection data;
        try
        {
            if (_gpuCat == null) _gpuCat = new PerformanceCounterCategory("GPU Engine");
            data = _gpuCat.ReadCategory()["Utilization Percentage"];
        }
        catch { _gpuDisabled = true; return; }
        if (data == null) return;

        // pid -> typ silnika (3d, videodecode, copy...) -> suma; wartosc procesu = najwiekszy silnik (jak Menedzer zadan)
        var byPid = new Dictionary<int, Dictionary<string, double>>();
        var next = new Dictionary<string, CounterSample>(data.Count);
        foreach (InstanceData inst in data.Values)
        {
            string n = inst.InstanceName;
            CounterSample cur = inst.Sample;
            next[n] = cur;
            CounterSample prev;
            if (!_prevGpu.TryGetValue(n, out prev)) continue;
            double v = CounterSample.Calculate(prev, cur);
            if (v <= 0 || double.IsNaN(v)) continue;

            // pid_1234_luid_..._eng_0_engtype_3d
            int pidStart = n.IndexOf("pid_", StringComparison.Ordinal);
            int pidEnd = pidStart < 0 ? -1 : n.IndexOf('_', pidStart + 4);
            int pid;
            if (pidEnd < 0 || !int.TryParse(n.Substring(pidStart + 4, pidEnd - pidStart - 4), out pid)) continue;
            int et = n.LastIndexOf("engtype_", StringComparison.Ordinal);
            string engType = et < 0 ? "?" : n.Substring(et + 8);

            Dictionary<string, double> engines;
            if (!byPid.TryGetValue(pid, out engines)) byPid[pid] = engines = new Dictionary<string, double>();
            double s;
            engines.TryGetValue(engType, out s);
            engines[engType] = s + v;
        }
        _prevGpu = next;

        var byName = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in byPid)
        {
            double max = 0;
            foreach (double e in kv.Value.Values) if (e > max) max = e;
            string name;
            if (!_pidNames.TryGetValue(kv.Key, out name)) continue;
            double cur;
            byName.TryGetValue(name, out cur);
            byName[name] = cur + max;
        }

        string best = null; double bestV = 0;
        foreach (var kv in byName) if (kv.Value > bestV) { bestV = kv.Value; best = kv.Key; }
        TopGpuName = best;
        TopGpu = best == null ? 0 : Math.Min(100, bestV);
    }

    // Diagnostyka: ohmhelper.exe --bench
    public static string Bench()
    {
        var sw = new Stopwatch();
        Sample(); System.Threading.Thread.Sleep(500);
        long ram = 0, proc = 0, gpu = 0; const int N = 20;
        for (int i = 0; i < N; i++)
        {
            sw.Restart(); SampleRam(); ram += sw.ElapsedTicks;
            sw.Restart(); SampleProcesses(); proc += sw.ElapsedTicks;
            sw.Restart(); SampleGpu(); gpu += sw.ElapsedTicks;
            System.Threading.Thread.Sleep(100);
        }
        Func<long, string> ms = t => (t * 1000.0 / Stopwatch.Frequency / N).ToString("0.00") + " ms";
        return "ram " + ms(ram) + ", procesy " + ms(proc) + ", gpu " + ms(gpu);
    }

    // RAM przy kazdym odczycie (tanie); lista procesow i liczniki GPU (ok. 8 ms) tylko gdy full -
    // najbardziej obciazajacy proces nie zmienia sie tak szybko, by sprawdzac go co 2 s.
    public static void Sample(bool full = true)
    {
        try { SampleRam(); } catch { }
        if (!full) return;
        try { SampleProcesses(); } catch { }
        try { SampleGpu(); } catch { }
    }
}
