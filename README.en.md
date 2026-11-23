# Put your idle Android phone inside your Apple ecosystem

> **On your LAN it is a direct connection: native resolution, near-zero latency. Away from home you open your own domain in a browser — no VPN, no app.**
>
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
| Reach the phone while travelling | VPN, port forwarding, or a cloud phone | Your own domain and a real certificate, opened straight in the browser — **no VPN** |
| Keep it running 24/7 (check-ins, idling in a game, remote box) | Phone heats up, sleeps, drops the link; the IP changes | Plugged in, kept awake, **still streaming with the screen off**; IP and debug port pinned |

## Three networks, one page

| Where you are | What carries it | Picture / latency | How to open it |
|---|---|---|---|
| Home, same router | Direct on your LAN, no server in between | **Native resolution, near-zero latency** (only your Wi-Fi and the phone encoder matter) | `https://<lan-ip>:9443/` |
| Away, at the office | Your own domain + a real certificate (Let's Encrypt is enough), straight in the browser | Bounded by your home **upload** bandwidth; 1080p is fine day to day | Reverse-proxy `:9443` to the internet and issue a cert — **no VPN, no app** |
| No public IP / locked-down network | Tailscale or another private network, only your own devices get in | One extra hop, usually unnoticeable | Two commands; the private network issues the cert, still a green padlock |

All three show the same page: token gate, toolbar, screenshots, landscape, safe areas. Changing networks does not change how you use it.

## Three ways to use it

### 1) iPhone / iPad — one command, then open Safari (no app to install)

```bash
cd web && ./run.sh setup && ./run.sh start && ./run.sh url
```

`setup` clones ws-scrcpy, builds it, creates a self-signed cert and an access token; `start` brings up the mirror plus an **HTTPS token gate**; `url` prints the address for the iPhone.

- No profile, no jailbreak, no third-party app
- **HTTPS + token gate included**: Safari only exposes WebCodecs in a secure context (plain HTTP gives you a device list and a black canvas); the gate owns `:9443` and ws-scrcpy itself binds `127.0.0.1`, so the LAN has no second way in
- Latency is whatever your Wi-Fi and the phone encoder do — nothing is relayed
- **No VPN when you are out**: reverse-proxy `:9443` to the internet and sign a real certificate for your own domain (a Let's Encrypt wildcard is enough) — phones and laptops just open it, green padlock included. No public IP at home? Tailscale as a fallback, still nothing to install on the client
- Add the optional [mirror overlay](web/overlay/README.md): on desktop the window is exactly *picture + toolbar* pinned top-left; on the phone it fills the screen and clears the iPhone safe-area corners; a landscape game rotates 90° to fill the phone (toolbar becomes a top drawer) while desktop parks the toolbar under the picture; **screenshots land in the phone's own gallery**
- Details: [web/README.md](web/README.md), [docs/web-access.md](docs/web-access.md)

### 2) Windows / Mac desktop — persistent scrcpy + a floating control bar (the main part of this repo)

Desktop scrcpy has no toolbar, will not wake a sleeping phone, cannot type CJK, and needs a pile of adb commands every time. This fixes all of it:

One double-click → connect → keep awake → dim to minimum → wake → mirror → a control bar slides out on the right; close the window → the phone goes back to sleep and the brightness is restored.

### 3) Offline once running

After it is up nothing needs the internet: phone + your PC/server + the same router, and it still works when your ISP is down.

(One exception: the first `web/run.sh setup` needs the network — that is when ws-scrcpy and its dependencies are fetched.)

## Running 24/7 (check-ins, idling, a remote box)

This was built for "leave it on, always reachable":

- **Always charged**: the phone sits on a charger in a corner; `keepActive` defeats the screen timeout so it never sleeps out of the stream
- **Reconnects itself**: `devices → connect → mdns` before every stream; after a lock, a background trip or a Wi-Fi blip the page silently recovers instead of asking you to tap connect
- **Less heat, less drain**: on desktop `Alt+O` powers the panel off while still streaming; the web side runs with `--stay-awake`. For long runs give it airflow
- **Pin the address**: give the phone a **DHCP reservation** and fix the wireless debug port with `adb tcpip 5555` — after that a reboot or a network change still finds it
- **Manage it from anywhere**: the same page behind your domain, with desktop, notifications and apps in hand

> Whether a game tolerates this is a separate matter: this project only carries the picture and the touch, it does not touch any game client or protocol.

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
2. Put a token on the web endpoint and serve it over HTTPS — **ws-scrcpy has no auth of its own**; `web/gate.js` in this repo is that layer. Your LAN is not only you.
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

**Optional polish**: `web/overlay/` contains the fixes that turn this from "it works" into "usable every day" — fullscreen PWA (no address bar), audio that stays in sync (the worklet queue was unbounded and drifted 2s), silent reconnect after iOS kills the background WebSocket, forced max bitrate, a desktop layout that is exactly *picture + toolbar*, iPhone safe areas respected, a landscape game rotated 90° to fill the phone screen with the toolbar as a top drawer, and desktop keeping the toolbar under the picture. Apply with `./web/overlay/apply.sh ./web/ws-scrcpy` then `npm run build`. Baseline: `bilbospocketses/ws-scrcpy-web` v0.5.13. Details: [web/overlay/README.md](web/overlay/README.md).

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
7. **Over the internet the ceiling is your home upload**: 1080p at a good bitrate is fine, 4K is a LAN-only affair.

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
│                     (behaves as one unit with the mirror: both visible or neither)
├─ docs\
│  └─ web-access.md   iOS access: how it works, what breaks
└─ web\
   ├─ run.sh          setup / start / stop / status
   ├─ gate.js         HTTPS + token gate (zero deps, WS passthrough, screenshot endpoint)
   ├─ overlay\        mirror overlay: bitrate, self-heal, audio, dual layout, safe area, landscape, screenshots
   └─ README.md       iOS web access guide
```

## License

MIT
