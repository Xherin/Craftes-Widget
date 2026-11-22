' Uruchamia widget jako administrator (UAC) - wtedy WinRing0 dziala od razu i widac temperature CPU.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Shell.Application")
sh.ShellExecute "cmd.exe", "/c cd /d """ & dir & """ && npx electron .", dir, "runas", 0
