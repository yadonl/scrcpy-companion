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
