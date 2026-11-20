# ScrcpyCompanion

**A floating control bar for scrcpy on Windows — turn your phone into a permanent side display.**

scrcpy is great, but keeping an Android phone mirrored on a Windows desktop all day is missing a few pieces: the desktop build has no toolbar, the screen stays dark after it sleeps, typing Chinese does not work, and you have to type a pile of adb commands every time. This project wraps all of that behind one shortcut.

## What it fixes

| Pain | Here |
|---|---|
| Desktop scrcpy has **no side toolbar** | A topmost floating bar that sticks to the right edge of the mirror window and follows it |
| Phone screen is black and **will not wake** | `svc power stayon true` + `keyevent 224` at start, `--keep-active` while running |
| Long sessions **heat up and drain battery** | Brightness is pushed to the panel minimum; on close the phone is restored and put back to sleep |
| **Chinese input does not work** from the PC keyboard | `--keyboard=uhid` by default — the PC keyboard becomes a real HID keyboard, so the phone IME composes normally |
| You must **type adb commands** every time | One shortcut: connect → stay awake → dim → wake → mirror → bar; everything is torn down on close |
| Wireless debugging **ports keep changing** | Endpoint lives in `device.txt` / `config.json`, with clear errors instead of guesses |

## Install

Requires Windows 10/11 with PowerShell 5.1, [scrcpy](https://github.com/Genymobile/scrcpy/releases) (bundles adb), and USB/wireless debugging enabled on the phone.

```powershell
git clone https://github.com/yadonl/ScrcpyCompanion.git
cd ScrcpyCompanion
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ScrcpyDir "D:\tools\scrcpy-win64" -Device 192.168.1.20:5555
```

A **Android Mirror** shortcut appears on the desktop. Double-click it.

Self-check:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ScrcpyCompanion\bin\launch.ps1" -CheckOnly
```

## Configuration

`%LOCALAPPDATA%\ScrcpyCompanion\config.json`

| Key | Default | Meaning |
|---|---|---|
| `scrcpyDir` | app folder | Folder containing scrcpy.exe |
| `device` | empty | `IP:port`; empty = the USB-attached device |
| `windowTitle` | `Android (Mirror)` | Mirror window title |
| `maxFps` | `30` | Lower it to 24 on flaky Wi-Fi |
| `videoBitRate` | `8M` | Higher values need more Wi-Fi headroom |
| `maxSize` | `0` | 0 = native resolution |
| `keyboard` | `uhid` | **Required for CJK input**; `sdk` bypasses the IME |
| `keepActive` | `true` | Keeps the panel from timing out |
| `wakeOnStart` / `dimOnStart` | `true` | Wake and dim the panel on launch |
| `showBar` | `true` | Show the floating bar |

## Bar buttons

`Back` `Home` `Recents` `Notifications` `Power` `Vol+` `Vol-` `Screenshot`

Drag it anywhere; it re-docks 15 seconds after you move it. Closing the mirror window closes the bar.

scrcpy hotkeys still work: `Alt+P` power, `Alt+B` back, `Alt+H` home, `Alt+S` recents, `Alt+N` notifications, `Alt+O` screen off, `Alt+F` fullscreen, `Alt+↑/↓` volume, `Alt+Q` quit.

## Known limitations

1. **Screen-off and mirroring are mutually exclusive.** Once the panel loses power, frame capture freezes for 3–8 seconds. Nothing in software can fix this, so the project dims instead of turning the screen off.
2. **Minimum brightness is 1–2 nits** — a hardware floor set by the vendor.
3. **Wireless ports change** after a reboot or network switch. Pin it with `adb tcpip 5555` or update `device.txt`.
4. **Windows only** (WPF bar, PowerShell + VBScript launcher).
5. **CJK input needs uhid mode**; in `sdk` mode keystrokes bypass the IME and non-ASCII characters fail with `Could not inject char`.
6. Bandwidth-starved Wi-Fi shows up as stutter — lower `maxFps` / `videoBitRate` first.

## License

MIT
