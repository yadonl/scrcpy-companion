<#
  toolbar.ps1 - a floating control bar that sticks to the right edge of the
  scrcpy window. Buttons drive the phone over adb, so they work even when the
  mirror window does not have focus.

  Started automatically by bin/launch.ps1; can also be run on its own:
    powershell -ExecutionPolicy Bypass -File bar\toolbar.ps1 -Device 192.168.1.20:5555
#>
param(
  [string]$Device,
  [string]$ConfigPath
)

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms

$here    = $PSScriptRoot
$appRoot = Split-Path $here -Parent
$logPath = Join-Path $appRoot "bar.log"
function Log($m) { ("{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $m) | Out-File -Append -Encoding utf8 $logPath }

# ---------------- single instance ----------------
$mutex = New-Object System.Threading.Mutex($false, "Global\scrcpy_companion_bar")
if (-not $mutex.WaitOne(0)) { exit }

# ---------------- config ----------------
$cfgPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $appRoot "config.json" }
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $cfg = $null } }
function CfgOr($name, $default) {
  if ($null -eq $cfg) { return $default }
  $v = $cfg.$name
  if ($null -eq $v -or ($v -is [string] -and $v -eq "")) { return $default }
  return $v
}

$dev = $Device
if (-not $dev) { $dev = CfgOr "device" "" }
if (-not $dev) {
  $f = Join-Path $appRoot "device.txt"
  if (Test-Path $f) { $dev = (Get-Content $f -Raw).Trim() }
}

$scrcpyDir = CfgOr "scrcpyDir" ""
if (-not $scrcpyDir) { $scrcpyDir = $appRoot }
$adb = Join-Path $scrcpyDir "adb.exe"
if (-not (Test-Path $adb)) {
  $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($cmd) { $adb = $cmd.Source } else { $adb = "adb" }
}
$serial = @()
if ($dev) { $serial = @("-s", $dev) }
$shotDir = Join-Path $appRoot "screenshots"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CompanionWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Send-Key([int]$code) { & $adb @serial shell input keyevent $code 2>$null | Out-Null }

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="scrcpy-bar" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False"
        SizeToContent="Height" Width="92" ResizeMode="NoResize">
  <Border CornerRadius="14" Background="#F01A1D24" Padding="6">
    <StackPanel>
      <Button Name="bBack"  Content="←  返回"   Margin="0,2,0,2"/>
      <Button Name="bHome"  Content="⌂  主页"   Margin="0,2,0,2"/>
      <Button Name="bTasks" Content="▭  多任务" Margin="0,2,0,2"/>
      <Button Name="bNoti"  Content="≡  通知"   Margin="0,2,0,2"/>
      <Button Name="bPower" Content="⏻  电源"   Margin="0,2,0,2"/>
      <Button Name="bVolUp" Content="＋ 音量"   Margin="0,2,0,2"/>
      <Button Name="bVolDn" Content="－ 音量"   Margin="0,2,0,2"/>
      <Button Name="bShot"  Content="◉  截图"   Margin="0,2,0,2"/>
      <TextBlock Name="lbl" Text="" Foreground="#8FA3B8" FontSize="10"
                 TextAlignment="Center" Margin="0,4,0,0" TextWrapping="Wrap"/>
    </StackPanel>
  </Border>
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Height" Value="34"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Foreground" Value="#E8EEF6"/>
      <Setter Property="Background" Value="#2A303A"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{TemplateBinding Background}" CornerRadius="8">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#3A5A86"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#4F8BE0"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
</Window>
"@

try {
  $win = [Windows.Markup.XamlReader]::Parse($xaml)
  $lbl = $win.FindName("lbl")
  $win.Add_MouseLeftButtonDown({ $win.DragMove() }.GetNewClosure())
  $win.Add_MouseLeftButtonUp({
    $script:frozenUntil = (Get-Date).AddSeconds(15)
    $lbl.Text = "已手放，15s 后自动贴回"
  })

  $win.FindName("bBack").Add_Click({  Send-Key 4;   $lbl.Text = "返回" })
  $win.FindName("bHome").Add_Click({  Send-Key 3;   $lbl.Text = "主页" })
  $win.FindName("bTasks").Add_Click({ Send-Key 187; $lbl.Text = "多任务" })
  $win.FindName("bNoti").Add_Click({  Send-Key 83;  $lbl.Text = "通知" })
  $win.FindName("bPower").Add_Click({ Send-Key 26;  $lbl.Text = "电源" })
  $win.FindName("bVolUp").Add_Click({ Send-Key 24;  $lbl.Text = "音量+" })
  $win.FindName("bVolDn").Add_Click({ Send-Key 25;  $lbl.Text = "音量-" })
  $win.FindName("bShot").Add_Click({
    New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
    $f = Join-Path $shotDir ("shot_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".png")
    & cmd.exe /c "`"$adb`" $(if ($dev) { "-s $dev" }) exec-out screencap -p > `"$f`""
    $lbl.Text = "已存 screenshots"
    if (Test-Path $f) { Start-Process $f }
  })

  # ---- stick to the right edge of the mirror window ----
  $wa = [System.Windows.SystemParameters]::WorkArea
  $script:frozenUntil = [DateTime]::MinValue
  $script:missed = 0
  $script:everSeen = $false

  $dock = {
    if ((Get-Date) -lt $script:frozenUntil) { return }
    $p = Get-Process scrcpy -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) {
      $script:missed++
      if ($script:everSeen -and $script:missed -gt 25) { $win.Close() }
      if ((-not $script:everSeen) -and $script:missed -gt 150) { $win.Close() }
      return
    }
    $script:everSeen = $true
    $script:missed = 0
    $r = New-Object CompanionWin32+RECT
    if (-not [CompanionWin32]::GetWindowRect($p.MainWindowHandle, [ref]$r)) { return }
    $wWin = $r.Right - $r.Left
    $hWin = $r.Bottom - $r.Top
    if ($wWin -lt 100 -or $hWin -lt 100) { return }
    $h = $win.ActualHeight
    if ($h -le 0) { $h = 380 }
    $x = $r.Right + 4
    if (($x + $win.Width) -gt $wa.Right) { $x = $r.Right - $win.Width - 4 }
    if ($x -lt $wa.Left) { $x = $wa.Left }
    $y = $r.Top + [int](($hWin - $h) / 2)
    if ($y -lt $wa.Top) { $y = $wa.Top }
    if (($y + $h) -gt $wa.Bottom) { $y = $wa.Bottom - $h }
    $win.Left = $x
    $win.Top  = $y
  }

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds(400)
  $timer.Add_Tick($dock)
  $timer.Start()

  $win.Add_Loaded({ $dock.Invoke() })
  Log "bar shown (device=$(if ($dev) { $dev } else { 'auto' }))"
  $win.ShowDialog() | Out-Null
  $mutex.ReleaseMutex()
} catch {
  Log ("ERROR: " + $_.Exception.Message)
  Log ($_.ScriptStackTrace)
}
