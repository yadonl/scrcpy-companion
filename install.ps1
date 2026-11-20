<#
  install.ps1 - install ScrcpyCompanion for the current user.

  Examples:
    .\install.ps1 -ScrcpyDir "D:\tools\scrcpy-win64-v3.3.3"
    .\install.ps1 -ScrcpyDir "D:\tools\scrcpy" -Device 192.168.1.20:5555
    .\install.ps1 -ScrcpyDir "D:\tools\scrcpy" -CreateStartupShortcut
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "ScrcpyCompanion"),
  [string]$ScrcpyDir,
  [string]$Device,
  [switch]$CreateStartupShortcut,
  [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot

function Fail($m) { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }
function Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Info($m) { Write-Host "    $m" -ForegroundColor Gray }

Write-Host "ScrcpyCompanion installer" -ForegroundColor Cyan
Write-Host ""

# ---- resolve scrcpy ----
if (-not $ScrcpyDir) {
  foreach ($cand in @($src, (Join-Path $env:LOCALAPPDATA "ScrcpyCompanion"))) {
    if (Test-Path (Join-Path $cand "scrcpy.exe")) { $ScrcpyDir = $cand; break }
  }
}
if (-not $ScrcpyDir) {
  $cmd = Get-Command scrcpy.exe -ErrorAction SilentlyContinue
  if ($cmd) { $ScrcpyDir = Split-Path $cmd.Source -Parent }
}
if (-not $ScrcpyDir -or -not (Test-Path (Join-Path $ScrcpyDir "scrcpy.exe"))) {
  Fail "找不到 scrcpy.exe。请先用 -ScrcpyDir 指定解压好的 scrcpy 目录（https://github.com/Genymobile/scrcpy/releases）"
}
$ScrcpyDir = (Resolve-Path $ScrcpyDir).Path
Ok "scrcpy: $ScrcpyDir"

# ---- copy program files ----
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "bar") | Out-Null
Copy-Item (Join-Path $src "bin\launch.ps1")  (Join-Path $InstallDir "bin\launch.ps1")  -Force
Copy-Item (Join-Path $src "bin\launch.vbs")  (Join-Path $InstallDir "bin\launch.vbs")  -Force
Copy-Item (Join-Path $src "bar\toolbar.ps1") (Join-Path $InstallDir "bar\toolbar.ps1") -Force
Copy-Item (Join-Path $src "config.sample.json") (Join-Path $InstallDir "config.sample.json") -Force
Ok "installed to $InstallDir"

# ---- config.json ----
$cfgPath = Join-Path $InstallDir "config.json"
if (Test-Path $cfgPath) {
  Info "config.json 已存在，保留原文件（只补齐 scrcpyDir/device）"
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
} else {
  $cfg = Get-Content (Join-Path $InstallDir "config.sample.json") -Raw | ConvertFrom-Json
}
$cfg.scrcpyDir = $ScrcpyDir
if ($Device) { $cfg.device = $Device }
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $cfgPath
Ok "config.json -> $cfgPath"

if (-not $Device) {
  Info "device 为空 = 自动用 USB 连接的那台；无线调试请填 手机IP:端口（写进 config.json 或 $InstallDir\device.txt）"
}

# ---- desktop shortcut ----
$shell = New-Object -ComObject WScript.Shell
if (-not $NoShortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Android Mirror.lnk"
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = "C:\Windows\System32\wscript.exe"
  $s.Arguments  = '"' + (Join-Path $InstallDir "bin\launch.vbs") + '"'
  $s.WorkingDirectory = $InstallDir
  $s.IconLocation = (Join-Path $ScrcpyDir "scrcpy.exe") + ",0"
  $s.WindowStyle = 7
  $s.Save()
  Ok "桌面快捷方式: $lnk"
}

if ($CreateStartupShortcut) {
  $startup = [Environment]::GetFolderPath("Startup")
  $lnk2 = Join-Path $startup "Android Mirror.lnk"
  $s2 = $shell.CreateShortcut($lnk2)
  $s2.TargetPath = "C:\Windows\System32\wscript.exe"
  $s2.Arguments  = '"' + (Join-Path $InstallDir "bin\launch.vbs") + '"'
  $s2.WorkingDirectory = $InstallDir
  $s2.IconLocation = (Join-Path $ScrcpyDir "scrcpy.exe") + ",0"
  $s2.WindowStyle = 7
  $s2.Save()
  Ok "开机启动: $lnk2"
}

Write-Host ""
Ok "完成。双击桌面「Android Mirror」即可开始投屏（同目录 bin\launch.ps1 -CheckOnly 可自检）"
