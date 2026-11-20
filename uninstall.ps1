<#
  uninstall.ps1 - remove ScrcpyCompanion shortcuts (and optionally files).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "ScrcpyCompanion"),
  [switch]$RemoveFiles
)
$ErrorActionPreference = "Continue"

$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Android Mirror.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Startup")) "Android Mirror.lnk")
)
foreach ($t in $targets) {
  if (Test-Path $t) { Remove-Item $t -Force; Write-Host "[+] removed $t" }
}

Get-Process scrcpy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name='powershell.exe'" | Where-Object { $_.CommandLine -like "*toolbar.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($RemoveFiles -and (Test-Path $InstallDir)) {
  Remove-Item $InstallDir -Recurse -Force
  Write-Host "[+] removed $InstallDir"
} else {
  Write-Host "    程序文件保留在 $InstallDir（加 -RemoveFiles 一并删除）"
}
