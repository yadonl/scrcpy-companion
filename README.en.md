# Put your idle Android phone inside your Apple ecosystem

> No app on the iPhone. No emulator on the Mac. The Android phone in your drawer becomes an Android terminal that is **entirely yours** — no account, no cloud, no data leaving the house.

The wall between iOS and Android is not a hardware wall, it is an account wall: to touch Android you are pushed into cloud phones, emulators, second phones and sign-ups, and your data ends up somewhere else.

This project takes another route: **keep the Android phone at home, reach over for its screen and its fingers.**

```
   ┌─────────────┐      Wi-Fi / private network      ┌──────────────┐
   │  your iPhone │  ←──────── browser ──────────→   │ idle Android  │
   │   or Mac     │        (no cloud involved)       │  on charger   │
   └─────────────┘                                   └──────────────┘
```

## What it replaces

| You want | Today | Here |
|---|---|---|
| Android apps / notifications / SMS from an iPhone | Cloud phone: monthly fee, data on someone else's servers | Real device at home, streamed over your own LAN, **¥0/month** |
| Android on a Mac | Emulator: heavy, no real sensors, banking apps refuse to run | **Real device, real OS** — camera, GPS, SIM, fingerprint |
| A quiet spare Android phone | Two phones to carry and charge | Phone stays plugged in a corner, mirror on demand, **screen off when done** |
| Privacy | Cloud phone = your photos and messages in a datacenter | Video flows over your LAN, **never leaves home**; no account, no vendor backend |

## Three ways to use it

### 1) iPhone / iPad — one command, then open Safari (no app to install)

```bash
cd web && ./run.sh setup && ./run.sh start && ./run.sh url
```

`setup` clones ws-scrcpy, builds it, creates a self-signed cert and an access token; `start` brings up the mirror plus an **HTTPS token gate**; `url` prints the address for the iPhone.

- No profile, no jailbreak, no third-party app
- **HTTPS + token gate included**: Safari only exposes WebCodecs in a secure context (plain HTTP gives you a device list and a black canvas), and the endpoint must not be open to the whole LAN
- 30–80 ms on the same Wi-Fi; scrolling feels native
- Details: [web/README.md](web/README.md), [docs/web-access.md](docs/web-access.md)

### 2) Windows / Mac desktop — persistent scrcpy + a floating control bar (the main part of this repo)

Desktop scrcpy has no toolbar, will not wake a sleeping phone, cannot type CJK, and needs a pile of adb commands every time. This fixes all of it:

One double-click → connect → keep awake → dim to minimum → wake → mirror → a control bar slides out on the right; close the window → the phone goes back to sleep and the brightness is restored.

### 3) Fully offline

Nothing here needs the internet: phone + your PC/server + the same router, and it still works when your ISP is down.

## Privacy and security (in concrete terms)

**Why the data stays home:**

| Stage | This project | Cloud phone / remote-control app |
|---|---|---|
| Video | scrcpy streams directly over adb between your two devices | Uploaded to a vendor datacenter, then delivered |
| Account | None. No signup, no login, no phone number | Phone number + ID + subscription |
| Installed on the Android phone | A throwaway `scrcpy-server` process | Resident client plus analytics SDKs |
| Network | Your LAN / your own private network (Tailscale, WireGuard, …) | Vendor relay |
| Offline | Still works | Dead |

**And the limits, stated plainly (no "absolute security" claims):**

1. **Whoever reaches adb owns that phone.** Keep the debug port inside a trusted network; never expose it to the internet.
2. Put a token on the web endpoint (ws-scrcpy supports one) and serve it over HTTPS — your LAN is not only you.
3. A phone that stays plugged in is more reliable, but give it airflow; do not park it at 100% charge in a hot corner.
4. Your privacy boundary is your network plus your devices. If those fall, no tool saves you.

## Quick start (desktop, Windows)

Requires [scrcpy](https://github.com/Genymobile/scrcpy/releases) (bundles adb) and USB/wireless debugging on the phone.

```powershell
git clone https://github.com/yadonl/scrcpy-companion.git
cd scrcpy-companion
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ScrcpyDir "D:\tools\scrcpy-win64" -Device 192.168.1.20:5555
```

An **Android Mirror** shortcut appears on the desktop.

Self-check:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ScrcpyCompanion\bin\launch.ps1" -CheckOnly
```

**iPhone / iPad path**: `cd web && ./run.sh setup && ./run.sh start`, then open the `https://<lan-ip>:9443/` it prints. See [web/README.md](web/README.md).

## Configuration

`%LOCALAPPDATA%\ScrcpyCompanion\config.json`

| Key | Default | Meaning |
|---|---|---|
| `scrcpyDir` | app folder | Folder containing scrcpy.exe |
| `device` | empty | `IP:port`; empty = the USB-attached device |
| `windowTitle` | `Android (Mirror)` | Mirror window title |
| `maxFps` | `30` | Drop to 24 on flaky Wi-Fi |
| `videoBitRate` | `8M` | Needs Wi-Fi headroom |
| `maxSize` | `0` | 0 = native resolution |
| `keyboard` | `uhid` | **Required for CJK input** |
| `keepActive` | `true` | Prevents the panel from timing out |
| `wakeOnStart` / `dimOnStart` | `true` | Wake and dim on launch |
| `showBar` | `true` | Show the floating bar |

## The bar

`Back` `Home` `Recents` `Notifications` `Power` `Vol+` `Vol-` `Screenshot`

Docks 4px to the right of the mirror window, re-checks every 0.4s, and re-docks 15 seconds after you drag it away. Buttons drive `adb shell input keyevent`, so they work even when the mirror window is not focused. Closing the mirror closes the bar and puts the phone back to sleep.

scrcpy hotkeys still apply: `Alt+P` power, `Alt+B` back, `Alt+H` home, `Alt+S` recents, `Alt+N` notifications, `Alt+O` screen off, `Alt+F` fullscreen, `Alt+↑/↓` volume, `Alt+Q` quit.

## Known limitations

1. **Screen-off and mirroring are mutually exclusive** — frame capture freezes 3–8 s after the panel loses power. Hence dimming instead of turning off.
2. **Minimum brightness is 1–2 nits**, a vendor hardware floor.
3. **Wireless debug ports change** after reboot or network switch; pin with `adb tcpip 5555` or update `device.txt`.
4. **CJK input needs `--keyboard=uhid`**; `sdk` mode bypasses the IME and fails on non-ASCII with `Could not inject char`.
5. The desktop bar is Windows-only (WPF + PowerShell/VBScript); on macOS use scrcpy from the terminal for now.
6. Low Wi-Fi uplink shows as stutter — lower `maxFps` / `videoBitRate` first.

## Layout

```
scrcpy-companion/
├─ install.ps1 / uninstall.ps1
├─ config.sample.json / device.txt.sample
├─ bin\
│  ├─ launch.vbs      hidden-window launcher (no black console)
│  └─ launch.ps1      connect → stay awake → dim → wake → mirror → cleanup
├─ bar\
│  └─ toolbar.ps1     floating control bar docked to the mirror window
├─ docs\
│  └─ web-access.md   iOS access: how it works, what breaks
└─ web\
   ├─ run.sh          setup / start / stop / status
   ├─ gate.js         HTTPS + token gate (zero deps, WS passthrough)
   └─ README.md       iOS web access guide
```

## License

MIT
