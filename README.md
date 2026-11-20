# 把吃灰的安卓手机，装进你的苹果生态

> iPhone 不用装 App，Mac 不用装模拟器。你抽屉里那台闲置安卓机，可以变成一台**完全属于你**的安卓终端 —— 不注册账号、不经过任何云、数据不出家门。

iOS 和安卓之间那道墙，本质上不是硬件墙，是"账号墙"：想用安卓就得装虚拟机、买云手机、或者再买一台安卓机、注册一堆账号、把数据交出去。

这个项目走的是另一条路：**安卓机留在家里，屏幕和手指伸过去。**

```
   ┌─────────────┐        Wi-Fi / 私有网络        ┌──────────────┐
   │  你的 iPhone │  ←──────── 浏览器 ────────→  │  吃灰的安卓机  │
   │   或 Mac     │        （不经过任何云）        │  插着电待命    │
   └─────────────┘                                └──────────────┘
```

## 它解决什么

| 你想要 | 现在的做法 | 这里的做法 |
|---|---|---|
| iPhone 上用安卓 App / 看安卓通知 / 收安卓短信 | 装云手机：月租、数据在别人服务器 | 真机在家，画面直连你家局域网，**0 元月租** |
| Mac 上跑安卓 | 装模拟器：吃内存、没真传感器、装不了微信银行类 App | **真机真系统**，相机、GPS、SIM、指纹全是真的 |
| 只想安静地用一台安卓备用机 | 两台手机轮流带、轮流充电 | 安卓机插电挂在角落，随时远程操作，**用完即熄屏** |
| 隐私 | 云手机 = 你的相册/短信/微信在别人机房里 | 视频流走局域网，**不出户**；没有账号、没有厂商后台 |

## 三条使用路径

### 1) iPhone / iPad：一条命令起网页端，Safari 打开就能操作（不装 App）

```bash
cd web && ./run.sh setup && ./run.sh start && ./run.sh url
```

`setup` 自动拉 [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)、构建、签自签证书、生成访问令牌；`start` 起两个进程（网页端 + **HTTPS 门**），`url` 打印 iPhone 该打开的地址。

- 不用装描述文件、不用越狱、不用第三方 App
- **自带 HTTPS + 令牌门**：Safari 只在安全上下文里开 WebCodecs（HTTP 打开会"有设备列表、画面全黑"）；令牌门守着 `:9443`，ws-scrcpy 本体只绑 `127.0.0.1`，局域网里没有第二条路
- 延迟只取决于你家 Wi-Fi 和手机编码，没有第三方中转
- 细节与踩坑：[web/README.md](web/README.md)、[docs/web-access.md](docs/web-access.md)

### 2) Windows / Mac 桌面：scrcpy 常驻 + 悬浮控制条（本仓库主体）

scrcpy 桌面版没有工具栏、息屏点不亮、中文打不进去、每次要手打 adb——这套东西全补上：

双击一次 → 连设备 → 防睡 → 亮度压到最低 → 唤醒 → 投屏 → 右侧浮出一条控制条；关掉窗口 → 手机自动熄屏、亮度复原。

### 3) 运行期完全离网

跑起来之后不依赖互联网：安卓机 + 你的电脑/服务器 + 同一个路由器，断网照样投屏。适合放老家、放店里、放机房。

（只有第一次 `web/run.sh setup` 要联网——那一步在拉 ws-scrcpy 和它的依赖。）

## 隐私与安全（这部分我说得具体些）

**它凭什么"数据不出户"：**

| 环节 | 本项目 | 云手机 / 远程控制 App |
|---|---|---|
| 视频流 | scrcpy 通过 adb 直连你两台设备，点对点 | 先上传到厂商机房再下发 |
| 账号 | 无。不注册、不登录、不绑定手机号 | 手机号 + 实名 + 订阅 |
| 安卓机上装的东西 | 一个用完即弃的 `scrcpy-server`（临时进程，随插随删） | 常驻客户端 + 各种 SDK |
| 网络 | 局域网 / 你自己的私有网络（Tailscale、WG 都行） | 厂商公网中转 |
| 断网 | 照样能用 | 直接不可用 |

**边界也要说清楚（不吹"绝对安全"）：**

1. **谁能连上 adb，谁就拥有这台手机。** 所以调试端口只在受信网络里开，别直接映射到公网。
2. 网页端必须加访问令牌并且走 HTTPS——**ws-scrcpy 本身没有任何鉴权**，本仓库的 `web/gate.js` 补的就是这一刀；局域网里也有别人。
3. 安卓机长期插电待命更稳，但要给它留散热；不建议长期满电高温存放。
4. 你的隐私边界 = 你家网络 + 你的设备。这两样被攻破，任何方案都救不了。

## 快速开始（桌面端，Windows）

前置：[scrcpy](https://github.com/Genymobile/scrcpy/releases)（自带 adb）、手机开「USB 调试 / 无线调试」。

```powershell
git clone https://github.com/yadonl/scrcpy-companion.git
cd scrcpy-companion
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -ScrcpyDir "D:\tools\scrcpy-win64" `
  -Device 192.168.1.20:5555
```

桌面出现 **Android Mirror**，双击就用。

自检（连不上先跑这个）：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ScrcpyCompanion\bin\launch.ps1" -CheckOnly
```

**iPhone / iPad 那条路**：`cd web && ./run.sh setup && ./run.sh start`，然后打开它打印的 `https://<内网IP>:9443/`。说明见 [web/README.md](web/README.md)。

## 配置

`%LOCALAPPDATA%\ScrcpyCompanion\config.json`

| 字段 | 默认 | 说明 |
|---|---|---|
| `scrcpyDir` | 程序目录 | scrcpy.exe 所在目录 |
| `device` | 空 | `IP:端口`；留空 = USB 直连那台 |
| `windowTitle` | `Android (Mirror)` | 投屏窗口标题 |
| `maxFps` | `30` | 无线不稳降到 24 |
| `videoBitRate` | `8M` | 家里 Wi-Fi 上行不够就降 |
| `maxSize` | `0` | 0 = 原始分辨率 |
| `keyboard` | `uhid` | **打中文必须 uhid** |
| `keepActive` | `true` | 防系统自动息屏 |
| `wakeOnStart` / `dimOnStart` | `true` | 启动唤醒 / 亮度压到最低 |
| `showBar` | `true` | 是否显示悬浮控制条 |

## 控制条

`← 返回` `⌂ 主页` `▭ 多任务` `≡ 通知` `⏻ 电源` `＋ 音量` `－ 音量` `◉ 截图`

- 自动贴住投屏窗口右边沿（+4px），跟着窗口走，每 0.4 秒校一次
- 手动拖走后 15 秒不打扰，之后自动吸回
- 按钮走 `adb shell input keyevent`，窗口没有焦点也能点
- 关掉投屏窗口，控制条自动消失，手机同时熄屏

scrcpy 快捷键照旧：`Alt+P` 电源、`Alt+B` 返回、`Alt+H` 主页、`Alt+S` 多任务、`Alt+N` 通知、`Alt+O` 关屏保持镜像、`Alt+F` 全屏、`Alt+↑/↓` 音量、`Alt+Q` 退出。

## 已知限制（不藏着）

1. **熄屏与投屏互斥**：面板断电后画面采集会冻结 3~8 秒，这是硬件/系统行为。所以本项目选择"压到最低亮度"而不是关屏。
2. **亮度下限是 1~2 nit**，厂商锁死（vivo / 小米 / 华为实测一致），没有软件办法。
3. **无线调试端口会变**：手机重启或换网络后端口重分配，用 `adb tcpip 5555` 固定，或更新 `device.txt`。
4. **中文输入依赖 `--keyboard=uhid`**；`sdk` 模式下字母绕过输入法，非 ASCII 会报 `Could not inject char`。
5. 桌面端目前只做 Windows（WPF 控制条 + PowerShell/VBScript 启动器）；macOS 直接用 scrcpy 命令行即可，控制条待移植。
6. 带宽不足会卡：先降 `maxFps` / `videoBitRate`，别怪内网。

## 目录

```
scrcpy-companion/
├─ install.ps1 / uninstall.ps1
├─ config.sample.json / device.txt.sample
├─ bin\
│  ├─ launch.vbs      隐藏黑框启动
│  └─ launch.ps1      连设备 → 防睡 → 压亮度 → 唤醒 → 投屏 → 收尾
├─ bar\
│  └─ toolbar.ps1     悬浮控制条（贴住投屏窗口右沿）
├─ docs\
│  └─ web-access.md   iPhone / iPad 接入的原理与排障
└─ web\
   ├─ run.sh          一条命令：装 / 起 / 停 / 看状态
   ├─ gate.js         HTTPS + 令牌门（零依赖，WebSocket 透传）
   └─ README.md       iOS 网页端说明
```

## License

MIT
