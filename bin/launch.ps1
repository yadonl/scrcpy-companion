<#
  launch.ps1 - start a persistent scrcpy session, with a floating control bar.

  Read config.json (same folder as the app root), connect the phone, keep the
  panel awake at minimum brightness, show the control bar, then run scrcpy in
  the foreground so closing the mirror window also tears everything down.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$Device,
  [switch]$NoBar,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Continue"
$here    = $PSScriptRoot
$appRoot = Split-Path $here -Parent

function Show-Message([string]$text, [string]$title = "Scrcpy Companion") {
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($text, $title, "OK", "Warning") | Out-Null
  } catch {
    Write-Host $text
  }
}

function Write-Note([string]$m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }

# ---------------- config ----------------
$configPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $appRoot "config.json" }
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $appRoot "config.sample.json") $configPath -Force
  Write-Note "config.json created from sample"
}
# A truncated or empty config.json used to abort the whole script inside a
# hidden VBS window: the user double-clicked and nothing happened, ever.
$cfg = $null
try {
  $rawCfg = Get-Content $configPath -Raw -ErrorAction Stop
  if (-not $rawCfg -or -not $rawCfg.Trim()) { throw "config.json is empty" }
  $cfg = $rawCfg | ConvertFrom-Json -ErrorAction Stop
} catch {
  $why = $_.Exception.Message
  $bak = $configPath + ".bad"
  Copy-Item $configPath $bak -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $appRoot "config.sample.json") $configPath -Force
  try { $cfg = (Get-Content $configPath -Raw) | ConvertFrom-Json } catch { $cfg = $null }
  Write-Note "config.json unreadable ($why) - backed up to $bak, continuing with defaults"
  if ($null -eq $cfg) {
    Show-Message "config.json 读不出来：$why`n`n已备份成 $(Split-Path $bak -Leaf)，请删掉 config.json 后重新双击。"
    exit 4
  }
}

function CfgOr($name, $default) {
  $v = $cfg.$name
  if ($null -eq $v -or ($v -is [string] -and $v -eq "")) { return $default }
  return $v
}

$windowTitle = CfgOr "windowTitle" "Android (Mirror)"
$maxFps      = CfgOr "maxFps" 30
$bitRate     = CfgOr "videoBitRate" "8M"
$maxSize     = CfgOr "maxSize" 0
$keyboard    = CfgOr "keyboard" "uhid"
$keepActive  = CfgOr "keepActive" $true
$wakeOnStart = CfgOr "wakeOnStart" $true
$dimOnStart  = CfgOr "dimOnStart" $true
$showBar     = CfgOr "showBar" $true
$logFile     = CfgOr "logFile" "scrcpy-log.txt"

# ---------------- locate scrcpy ----------------
$scrcpyDir = CfgOr "scrcpyDir" ""
if (-not $scrcpyDir) { $scrcpyDir = $appRoot }
$scrcpyExe = Join-Path $scrcpyDir "scrcpy.exe"
if (-not (Test-Path $scrcpyExe)) {
  $cmd = Get-Command scrcpy.exe -ErrorAction SilentlyContinue
  if ($cmd) { $scrcpyExe = $cmd.Source; $scrcpyDir = Split-Path $cmd.Source -Parent }
  else {
    Show-Message "找不到 scrcpy.exe。`n`n请二选一：`n1) 把 scrcpy 解压到本程序目录（与 bin、bar 同级）`n2) 在 config.json 里把 scrcpyDir 指向 scrcpy 所在目录`n`n下载：https://github.com/Genymobile/scrcpy/releases"
    exit 2
  }
}
# scrcpy 1.x has no --no-audio / --power-off-on-close: it would exit instantly,
# with stderr swallowed into err.txt and nothing on screen.
$scVersion = ((& $scrcpyExe --version 2>&1) | Out-String).Trim()
$scMajor = 0
if ($scVersion -match 'scrcpy\s+(\d+)\.') { $scMajor = [int]$Matches[1] }
$scVersionLine = ($scVersion -split "`r?`n")[0]
$scHelp = ((& $scrcpyExe --help 2>&1) | Out-String)
$hasPowerOffOnClose = $scHelp -match '--power-off-on-close'
$hasKeepActive = $scHelp -match '--keep-active'

$adbExe = Join-Path $scrcpyDir "adb.exe"
if (-not (Test-Path $adbExe)) {
  $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($cmd) { $adbExe = $cmd.Source } else { $adbExe = "adb" }
}

# ---------------- device ----------------
$dev = $Device
if (-not $dev) { $dev = CfgOr "device" "" }
$devFile = Join-Path $appRoot "device.txt"
if (-not $dev -and (Test-Path $devFile)) { $dev = (Get-Content $devFile -Raw).Trim() }

$serial = @()
if ($dev) { $serial = @("-s", $dev) }
if ($dev -match ":") { & $adbExe connect $dev 2>&1 | Out-Null }

$state = ""
try { $state = ((& $adbExe @serial get-state 2>&1) | Out-String).Trim() } catch { $state = "error" }

if ($scMajor -gt 0 -and $scMajor -lt 2) {
  Show-Message ("scrcpy 是 1.x 版本（{0}）。`n`n本项目用到 --no-audio / --power-off-on-close，只有 2.0 以上才有：`nhttps://github.com/Genymobile/scrcpy/releases`n`n解压到程序目录（或改 config.json 的 scrcpyDir）后重试。" -f $scVersionLine)
  exit 5
}

if ($CheckOnly) {
  Write-Note "scrcpy : $scrcpyExe ($scVersionLine)"
  Write-Note "adb    : $adbExe"
  Write-Note "device : $(if ($dev) { $dev } else { '(auto / usb)' })"
  Write-Note "state  : $state"
  Write-Host (& $scrcpyExe --version 2>&1 | Out-String)
  Write-Host (& $adbExe devices 2>&1 | Out-String)
  exit 0
}

if ($state -ne "device") {
  Show-Message ("连不上手机（状态：{0}）。`n`n1) 确认手机已开「无线调试」或插好 USB`n2) 手机重启 / 换 Wi-Fi 后端口会变，请更新 device.txt 或 config.json`n3) 首次连接需要在手机上点「允许调试」" -f $state)
  exit 3
}

# ---------------- wake / dim the panel ----------------
if ($wakeOnStart) {
  & $adbExe @serial shell svc power stayon true 2>&1 | Out-Null
  & $adbExe @serial shell input keyevent 224 2>&1 | Out-Null
}
$origBriMode = $null
$origBri = $null
if ($dimOnStart) {
  # remember the real values so closing the session puts the panel back
  $origBriMode = ((& $adbExe @serial shell settings get system screen_brightness_mode 2>&1) | Out-String).Trim()
  $origBri     = ((& $adbExe @serial shell settings get system screen_brightness 2>&1) | Out-String).Trim()
  & $adbExe @serial shell settings put system screen_brightness_mode 0 2>&1 | Out-Null
  & $adbExe @serial shell settings put system screen_brightness 0 2>&1 | Out-Null
}

# ---------------- control bar ----------------
$barProc = $null
if ($showBar -and -not $NoBar) {
  $barScript = Join-Path $appRoot "bar\toolbar.ps1"
  if (Test-Path $barScript) {
    $barArgs = @("-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File",$barScript)
    if ($dev) { $barArgs += @("-Device", $dev) }
    $barProc = Start-Process powershell.exe -ArgumentList $barArgs -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 500
  }
}

# ---------------- run scrcpy ----------------
$scArgs = @(
  "--no-audio",
  "--window-title=$windowTitle",
  "--max-size=$maxSize",
  "--max-fps=$maxFps",
  "--video-bit-rate=$bitRate",
  "--keyboard=$keyboard"
)
if ($hasPowerOffOnClose) { $scArgs += "--power-off-on-close" }
if ($keepActive) {
  if ($hasKeepActive) { $scArgs += "--keep-active" } else { $scArgs += "--stay-awake" }
}
if ($dev) { $scArgs = @("-s", $dev) + $scArgs }

$logPath = Join-Path $appRoot $logFile
$errPath = [System.IO.Path]::ChangeExtension($logPath, ".err.txt")
$argStr  = ($scArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }) -join " "
Write-Note "starting scrcpy (log: $logPath)"
$proc = $null
$earlyExit = $false
try {
  # -NoNewWindow keeps scrcpy attached to our hidden console (no extra black box)
  $proc = Start-Process -FilePath $scrcpyExe -ArgumentList $argStr -NoNewWindow -PassThru `
            -RedirectStandardOutput $logPath -RedirectStandardError $errPath
  if (-not $proc.WaitForExit(5000)) { $proc.WaitForExit() } else { $earlyExit = $true }
} finally {
  if (Test-Path $errPath) {
    if ((Get-Item $errPath).Length -gt 0) { Get-Content $errPath -Encoding Default | Out-File -Append -Encoding utf8 $logPath }
    Remove-Item $errPath -Force -ErrorAction SilentlyContinue
  }
  if ($barProc -and -not $barProc.HasExited) { Stop-Process -Id $barProc.Id -Force -ErrorAction SilentlyContinue }
  if ($wakeOnStart) { & $adbExe @serial shell svc power stayon false 2>&1 | Out-Null }
  if ($dimOnStart) {
    # restore the values we read on start instead of hardcoding 1
    if ($origBri -match '^\d+$')     { & $adbExe @serial shell settings put system screen_brightness $origBri 2>&1 | Out-Null }
    if ($origBriMode -match '^\d+$') { & $adbExe @serial shell settings put system screen_brightness_mode $origBriMode 2>&1 | Out-Null }
    if (-not $hasPowerOffOnClose) { & $adbExe @serial shell input keyevent 223 2>&1 | Out-Null }
  }
  if ($earlyExit -and $null -ne $proc) {
    $tail = ""
    if (Test-Path $logPath) { $tail = ((Get-Content $logPath -Tail 6 -Encoding Default -ErrorAction SilentlyContinue) -join "`r`n") }
    Show-Message ("scrcpy 启动后 5 秒内就退出了（exit {0}）。`n`n{1}`n`n完整日志：{2}" -f $proc.ExitCode, $tail, $logPath)
  }
  Write-Note "session closed"
}
