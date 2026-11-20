# ScrcpyCompanion

**给 Windows 上的 scrcpy 补一条悬浮控制条：手机变常驻副屏。**

scrcpy 本身很好用，但在 Windows 上做"长期挂在一边"的远程操作，总差几件事：桌面版没有工具栏、手机息屏后点不亮、中文打不进去、每次都要手动敲一串 adb 命令。这个项目把这几件事一次性包圆，双击一个快捷方式就能用。

```
  ┌───────────────────────────┐  ┌──────┐
  │                           │  │ ← 返回│
  │      scrcpy 投屏画面       │  │ ⌂ 主页│
  │      （手机实时镜像）        │  │ ▭ 多任务│
  │                           │  │ ≡ 通知│
  │                           │  │ ⏻ 电源│
  │                           │  │ ＋音量│
  │                           │  │ －音量│
  │                           │  │ ◉ 截图│
  └───────────────────────────┘  └──────┘
        控制条自动贴住窗口右边，跟着窗口走
```

## 它解决什么

| 痛点 | 这里的做法 |
|---|---|
| 桌面版 scrcpy **没有侧边工具栏** | 自带一条置顶悬浮控制条，自动贴住投屏窗口右边，拖窗口它跟着走 |
| 手机息屏后**点不亮** | 启动时 `svc power stayon true` + `keyevent 224`，运行中 `--keep-active` 持续保活 |
| 长时间投屏**又烫又费电** | 启动把亮度压到系统下限（省电、少发热），关窗自动恢复并让手机息屏 |
| 电脑键盘**打不了中文** | 默认 `--keyboard=uhid`，电脑键盘被当成手机物理键盘，输入法正常出候选词 |
| 每次要**手打 adb 命令** | 一个快捷方式搞定：连设备 → 防睡 → 压亮度 → 唤醒 → 投屏 → 控制条；关窗全部自动收尾 |
| 无线调试**端口老变** | 设备地址写 `device.txt` 或 `config.json`，连不上给中文提示，不再瞎猜 |

## 特性

- 纯 PowerShell + WPF，**无需编译、无第三方依赖**，只要 Windows 10/11 自带的 PowerShell 5.1
- 配置集中在 `config.json`，不写死路径和设备地址
- 控制条按钮走 `adb shell input keyevent`，**投屏窗口没有焦点也能点**
- 截图按钮直接存到 `screenshots\`，按时间命名并自动打开
- 带日志（`scrcpy-log.txt`、`bar.log`），出问题能查
- `launch.ps1 -CheckOnly` 一条命令自检环境

## 安装

前置：Windows 10/11、[scrcpy](https://github.com/Genymobile/scrcpy/releases)（含 adb）、手机开「USB 调试 / 无线调试」。

```powershell
git clone https://github.com/yadonl/ScrcpyCompanion.git
cd ScrcpyCompanion

# 指向你解压好的 scrcpy 目录；有线连接可以不给 -Device
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -ScrcpyDir "D:\tools\scrcpy-win64" `
  -Device 192.168.1.20:5555
```

装完桌面会出现 **Android Mirror** 快捷方式，双击就开始投屏 + 出控制条。

> 无线调试的端口每次重启手机都会变，用 `adb tcpip 5555` 固定，或改动 `device.txt`。

**自检**（连不上时先跑这个）：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ScrcpyCompanion\bin\launch.ps1" -CheckOnly
```

## 配置

`%LOCALAPPDATA%\ScrcpyCompanion\config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `scrcpyDir` | 程序目录 | scrcpy.exe 所在目录 |
| `device` | 空 | `IP:端口`；留空 = 用 USB 直连的那台 |
| `windowTitle` | `Android (Mirror)` | 投屏窗口标题 |
| `maxFps` | `30` | 帧率；无线不稳就降到 24 |
| `videoBitRate` | `8M` | 码率；跑满带宽会卡，往上调要小心 |
| `maxSize` | `0` | 0 = 原始分辨率 |
| `keyboard` | `uhid` | **打中文必须 uhid**；`sdk` 模式会绕过输入法 |
| `keepActive` | `true` | 持续模拟用户活动，防自动熄屏 |
| `wakeOnStart` / `dimOnStart` | `true` | 启动时唤醒 / 把亮度压到最低 |
| `showBar` | `true` | 是否显示悬浮控制条 |

## 控制条按钮

`返回` `主页` `多任务` `通知` `电源` `音量+` `音量-` `截图`

控制条可以拖动；手动拖走后 15 秒不打扰，之后自动贴回投屏窗口右边。关掉投屏窗口，控制条自动消失。

**scrcpy 自带快捷键**：`Alt+P` 电源、`Alt+B` 返回、`Alt+H` 主页、`Alt+S` 多任务、`Alt+N` 通知栏、`Alt+O` 关屏保持镜像、`Alt+F` 全屏、`Alt+↑/↓` 音量、`Alt+Q` 退出。

## 已知限制（不藏着）

1. **熄屏 + 投屏 是互斥的**。面板断电后画面采集会冻结 3~8 秒，这是硬件/系统层面的行为，改不了。所以本项目不熄屏，而是把亮度压到面板下限。
2. **亮度最低只能到 1~2 nit**，厂商锁死了（vivo / 小米 / 华为实测一致）。想更暗没有软件办法。
3. **无线调试端口会变**：手机重启或切换网络后端口重新分配。固定用 `adb tcpip 5555`，或把新端口写进 `device.txt`。
4. **只支持 Windows**：控制条是 WPF，启动器是 PowerShell + VBScript。
5. **中文输入依赖 uhid 模式**：如果切到 `sdk` 模式，字母会直接落进输入框、输入法不组词，非 ASCII 字符还会报 `Could not inject char`。
6. 无线带宽不足时会卡顿——先降 `maxFps`/`videoBitRate`，别怪内网。

## 目录结构

```
ScrcpyCompanion/
├─ install.ps1 / uninstall.ps1
├─ config.sample.json
├─ bin\
│  ├─ launch.vbs      隐藏窗口启动（避免黑框挡在投屏前面）
│  └─ launch.ps1      连设备 → 防睡 → 压亮度 → 唤醒 → 投屏 → 收尾
└─ bar\
   └─ toolbar.ps1     悬浮控制条（贴住投屏窗口右边）
```

## License

MIT
