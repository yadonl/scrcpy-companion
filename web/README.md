# 一条命令，把安卓机搬进 iPhone

桌面端靠 scrcpy 原生窗口；**苹果这边不装 App**，走网页端。这个文件夹就是"把它跑起来"的那部分：

```
web/run.sh setup    # 拉 ws-scrcpy、构建、生成自签证书、生成访问令牌
web/run.sh start    # 起两个进程：ws-scrcpy(127.0.0.1:8000) + HTTPS 门(:9443)
web/run.sh url      # 打印 iPhone 该打开的地址和令牌
```

跑完在 iPhone Safari 打开 `https://<你的内网IP>:9443/`，输令牌，选设备，点「视频」，触摸就能操作安卓机。

## 为什么还要一道 HTTPS 门

不是多此一举，是两件必须的事：

1. **Safari 只在安全上下文里开放 WebCodecs**。用 `http://` 打开，你会看到设备列表正常、画面一片黑——这是最多人踩的坑。
2. **网页端一旦暴露在局域网，任何能访问的人都能操作你的手机**。所以 `gate.js` 在最前面挡一道：没有令牌连登录页都过不去，WebSocket 升级同样校验。

`gate.js` 只用 Node 标准库，零依赖，约 170 行：HTTPS 终结 → 校验令牌（`?token=` / Cookie / 表单登录）→ 反代到 ws-scrcpy，`Upgrade` 请求用裸 socket 透传。

## 安装

前置：

- 一台**常开**的机器（NAS、小主机、树莓派、Mac 都行）
- **Node.js 18 / 20 / 22 LTS**（Node 26 这种过新的版本，原生模块多半编不过）
- `git`、`openssl`、**C++ 构建工具链**（ws-scrcpy 依赖 node-pty，没预编译包就现场编译）
  - Debian/Ubuntu/飞牛：`apt-get install -y build-essential python3`
  - Alpine：`apk add build-base python3`
  - macOS：`xcode-select --install`

  > 缺工具链时，**换成 Node 20 也一样编不过**（实测报错都是 `gyp ERR! not ok`），真因是 C++ 编译器，不是 Node 版本。
- 安卓机和这台机器在同一个局域网，手机上打开「无线调试」

```bash
cd web
./run.sh setup      # 第一次：克隆 ws-scrcpy + npm install + 构建，几分钟
./run.sh start
./run.sh url
```

`setup` 会做四件事：

| 产物 | 说明 |
|---|---|
| `web/ws-scrcpy/` | 上游 [NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)，自动 clone |
| `web/certs/` | 自签证书，SAN 自动带上你机器的局域网 IP；397 天有效，快到期或 IP 变了 `start` 会自动重签 |
| `web/.env` | 端口与 `GATE_TOKEN`（随机 24 位，权限 600） |
| `web/logs/` | `ws.log` / `gate.log` |

## 让 ws-scrcpy 看见手机

网页端只是"看"，它得先能通过 adb 摸到手机：

```bash
adb connect 手机IP:5555      # 端口以手机「无线调试」页显示的为准
adb devices                  # 状态要是 device
```

想固定端口：先 USB 连一次，跑 `adb tcpip 5555`，之后就一直用 5555。

## iOS 上的两个必做项

1. **信任自签证书**：设置 → 通用 → 关于本机 → 证书信任设置 → 打开对应开关。不点的话 Safari 要么报证书错误，要么画面黑。
2. **点一下页面再出声**：iOS 不允许自动播放，音频要你先交互。

## 想更好用：投屏增强补丁（可选）

原生 ws-scrcpy 的参数是按「桌面浏览器调试」定的，当 iPhone 日常入口会缺几样东西。`web/overlay/` 里是我在真机上逐个改好的版本，覆盖到源码重新构建即可：

```bash
./web/overlay/apply.sh ./web/ws-scrcpy   # 覆盖补丁文件（会自动核对基线版本）
cd web/ws-scrcpy && npm run build        # 重新构建
```

它补的是这七件事（细节和根因见 `web/overlay/README.md`）：

- **码率拉满**：服务端原来只会往下压客户端传的码率，现在按机型/入口强制拉满（实测 12M → 20M）
- **掉线自愈**：手机睡一会儿无线调试就断，开流前自动 `devices → connect → mdns` 三连，不用你再回去点
- **切后台恢复**：iOS 挂后台会悄悄掐死 WebSocket（`readyState` 还骗你说 `OPEN`），回来后静默重连，不弹错误框
- **声音**：iOS 手势时机不对导致音频上下文没解锁 → 常驻监听 + 兜底按钮；音频队列原来无上限，积压 2 秒永不消化 → 改成超了就从队头丢，实测延迟 145~185ms
- **真全屏**：PWA manifest + 图标，加到主屏后没有地址栏；画布按手机真实比例重钉，不再被写死的 padding 挤小
- **横屏游戏**：手机在跑横屏游戏时，竖着拿 iPhone 也能满屏看——画面自动转 90°，触摸坐标同步反解
- **证书**：`web/overlay/certs/gen.sh` 重签脚本，叶证书 397 天 + `serverAuth`（iOS 只认 ≤825 天）

> 补丁基线是 `bilbospocketses/ws-scrcpy-web` **v0.5.13**。上游 NetrisTV/ws-scrcpy 结构不同，别直接套。

## 自启动（可选）

```bash
# crontab -e
@reboot cd /path/to/scrcpy-companion/web && ./run.sh start
```

或者用 systemd / 飞牛的定时任务，随便哪种，`run.sh start` 本身是幂等的（已经在跑就跳过）。

## 排障

| 现象 | 处理 |
|---|---|
| 页面开了，画面全黑 | 你是不是用 http 打开的？必须 https |
| `Device list` 空 | 服务器没 `adb connect`，或手机没点「允许调试」 |
| 打不开 9443 | `./run.sh status`，再看 `logs/gate.log` |
| 昨天能用今天不行 | 无线调试端口变了，重新 `adb connect`（或固定 5555） |
| WebSocket 一直重连 | 反代/防火墙没放行 Upgrade 头；本项目自带的 gate 已处理，别再套一层 Nginx |
| iPhone 报证书错误 / 勾了信任还是报 | 证书是旧参数签的（3650 天、没写 serverAuth）。删掉 `web/certs/` 再 `./run.sh start`，会按新参数重签 |
| 手机烫 | 网页端是持续编码，正常。插电 + 通风 |
| 画面糊 / 只有 12M | 用了上游原版：服务端只会压码率不会抬，套 `web/overlay/` 补丁 |
| 声音比画面慢 1~2 秒 | 音频队列积压没上限，套 `web/overlay/` 的 `PcmWorklet`（超限从队头丢） |
| 切后台回来一直转圈 | iOS 掐死 socket 但 `readyState` 仍报 `OPEN`，需要补丁里的静默自愈 |
| 横屏游戏在竖屏里只占中间一条 | 套补丁后自动转 90°；若方向反了，改 `custom-ui.js` 里 `rotate(90deg)` 为 `rotate(-90deg)` |
