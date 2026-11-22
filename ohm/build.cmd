@echo off
rem Buduje helpery kompilatorem C# wbudowanym w Windows (.NET Framework 4.x).
rem Nie wymaga dotnet SDK, Windows SDK, NuGet ani internetu.
rem   ohmhelper.exe   - sensory (OpenHardwareMonitorLib.dll z tego folderu) + RAM/procesy
rem   mediahelper.exe - sterowanie muzyka (Windows Media Session, systemowe pliki .winmd)
setlocal
set "HERE=%~dp0"
set "OUT=%HERE%ohmhelper"
set "FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
if not exist "%FW%\csc.exe" set "FW=%WINDIR%\Microsoft.NET\Framework\v4.0.30319"
set "CSC=%FW%\csc.exe"
set "WINMD=%WINDIR%\System32\WinMetadata"
if not exist "%CSC%" (echo Brak csc.exe ^(.NET Framework 4.x^) & exit /b 1)

"%CSC%" /nologo /target:exe /platform:x64 /optimize+ ^
  /out:"%OUT%\ohmhelper.exe" ^
  /reference:"%OUT%\OpenHardwareMonitorLib.dll" ^
  /reference:System.dll /reference:System.Core.dll ^
  "%HERE%src\Program.cs" "%HERE%src\ProcStats.cs"
if errorlevel 1 exit /b 1

"%CSC%" /nologo /target:exe /platform:x64 /optimize+ ^
  /out:"%OUT%\mediahelper.exe" ^
  /reference:"%WINMD%\Windows.Media.winmd" ^
  /reference:"%WINMD%\Windows.Foundation.winmd" ^
  /reference:"%WINMD%\Windows.Storage.winmd" ^
  /reference:"%FW%\System.Runtime.dll" ^
  "%HERE%src\MediaHelper.cs"
exit /b %ERRORLEVEL%
