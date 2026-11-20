Dim fso, sh, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = here & "\launch.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
