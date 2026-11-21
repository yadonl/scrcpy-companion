# 投屏体验增强补丁（overlay）

这不是一个独立程序，是往 **`bilbospocketses/ws-scrcpy-web` v0.5.13** 源码上覆盖的一层文件。
覆盖完重新 `npm run build`，iPhone 上的投屏就从「能用」变成「能天天用」。

> 基线：`ws-scrcpy-web` **v0.5.13**（commit `e5eb76e`）。上游 NetrisTV/ws-scrcpy 的源码结构不同，
> 直接覆盖会对不上；换基线请先核对下面 LIST 里的文件是否还存在、函数名是否还叫这个。

## 为什么需要它

原生 ws-scrcpy 的默认参数是按「桌面浏览器 + 局域网调试」定的，搬到 iPhone 上当日常入口就不够了。
下面七件事我在真机上逐个踩过、逐个改掉：

| 现象 | 真因 | 改在哪 |
| --- | --- | --- |
| 画面糊得像 480p | 服务端 `clampInt(bitrate, max)` **只封顶不抬高**，客户端传 20M 也被压回 12M | `src/server/clientProfile.ts`（新增，按 UA/入口强制拉到机型上限） |
| 锁屏一会儿 adb 就掉，回来一片黑 | 手机睡眠 → 无线调试断开，服务端不重建连接 | `src/server/ScrcpyConnection.ts` 的 `reviveIfMissing()`：`devices()` → `connect()` → `mdnsServices()` 三连 |
| 切后台再回来，画面永远转圈 | iOS 会把挂后台的 WebSocket 掐死，但 `readyState` 仍报 `OPEN`；服务端 socket 一 close 就杀 scrcpy-server | `src/app/ScrcpyDemuxer.ts`（`isOpen()` 探活）+ `src/app/googDevice/client/streamDeepLink.ts`（`x-resume-stream`，5 分钟 TTL）+ `StreamClientScrcpy.ts`（最多 3 轮、每轮 10 秒的静默自愈，不弹框） |
| 没声音；点了屏幕才响一下 | `resumeAudio` 是 `{once:true}` 的 click 监听，用户手势发生在 `AudioPlayer` 创建之前 → 音频上下文永远没解锁 | `StreamClientScrcpy.ts`：常驻捕获阶段 `pointerdown/touchend/keydown` 解锁 + 500ms 轮询兜底，超时给一个「🔇 点这里开声音」按钮 |
| 声音比画面慢 2 秒 | `PcmWorklet` 的队列**没有上限**，开流瞬间 1~2 秒音频一次性灌进来，之后生产/消费同速，积压永远消化不掉 | `src/app/audio/PcmWorklet.ts`：`MAX_MS=200 / TARGET_MS=90`，超了就**从队头丢**（延迟优先），并每秒回报 `queuedMs` 便于排查 |
| 画面在新手机上永远不铺满 | 播放器用旧尺寸画新帧；`.video` 写死 `padding: 8px 0 44px`；`pinCanvas()` 写死 `innerHeight-52` | `src/app/player/WebCodecsPlayer.ts`（按 SPS 实际方向 `onSourceResize`）+ `public/custom-ui.js/.css`（全屏只吃 `env(safe-area-inset-*)`） |
| 手机横屏玩游戏，iPhone 竖着看只剩一条 | 没有旋转层，只能靠用户把手机横过来 | `public/custom-ui.js` 自动转 90° + `src/app/interactionHandler/InteractionHandler.ts` 反解触摸坐标 |

## 还顺带做的几件小事

- **真 PWA**：`public/manifest.json` + 三个尺寸图标 + `apple-mobile-web-app-*` meta，加到主屏后没有地址栏，进流默认满屏（`navigator.standalone`）。
- **`stayAwake`**：服务端默认给 `--stay-awake`，配合亮屏常开，手机不会在投屏中途睡过去（`ScrcpyOptions.ts` / `scrcpyOptionsFromQuery.ts`）。
- **侧栏可关**：`.touch-layer` 会吃掉 `touchstart/touchend` 且**不产生 click**，所以文档上的 click 监听收不到 → 加了半透明遮罩 + 拉手 toggle 两条退出路径。
- **证书**：`certs/gen.sh` / `certs/leaf.ext` 是重签脚本。两件事必须做对：叶证书有效期 **≤825 天**（iOS 硬上限），并且 `extendedKeyUsage=serverAuth` 不能缺——缺了 iOS 只会说「此证书无效」，什么细节都不给。

## 应用

```bash
# 假定 ws-scrcpy-web 源码在 web/ws-scrcpy
./web/overlay/apply.sh ../ws-scrcpy      # 或省略参数，默认 ./ws-scrcpy
cd ../ws-scrcpy && npm run build          # 产物在 dist/
```

脚本只做「覆盖 + 版本核对」，不改你的配置、不碰证书私钥。想回滚：`git -C ../ws-scrcpy checkout -- .`（overlay 里新增的文件用 `git clean -fd` 清掉）。

## 许可

`overlay/` 下的 `src/`、`public/`、`webpack/` 文件是从 [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) /
[ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web)（GPL-3.0）改出来的，随上游按 GPL-3.0 使用；
`certs/`、`apply.sh`、本 README 是本仓库自有部分。

## 文件清单

```
certs/gen.sh                      重签证书：CA 3650 天 / 叶 397 天 / 带 serverAuth
certs/leaf.ext                    叶证书扩展（basicConstraints、keyUsage、EKU、SAN）
public/custom-ui.js               自建 UI 层：全屏、自动转向、侧栏、音频解锁按钮
public/custom-ui.css              配套样式（safe-area、旋转、遮罩）
public/index.html                 标题/图标/manifest 引用（资源都带 ?v= 便于破缓存）
public/manifest.json              真 PWA 清单
public/icon-{180,192,512}.png     主屏图标
src/app/ScrcpyDemuxer.ts          isOpen() 探活
src/app/audio/AudioPlayer.ts      isRunning()
src/app/audio/PcmWorklet.ts       音频队列上限 + 追帧丢弃 + queuedMs 回报
src/app/googDevice/client/ConfigureScrcpy.ts   音频/编码参数
src/app/googDevice/client/StreamClientScrcpy.ts   自愈三件套 + 音频解锁 + 满屏重钉
src/app/googDevice/client/codecSelection.ts    编码档位选择
src/app/googDevice/client/streamDeepLink.ts    x-resume-stream 断线恢复
src/app/interactionHandler/InteractionHandler.ts 旋转后的触摸反解
src/app/player/WebCodecsPlayer.ts 按 SPS 方向重排画布
src/server/ScrcpyConnection.ts    reviveIfMissing()
src/server/ScrcpyOptions.ts       stayAwake 选项
src/server/scrcpyOptionsFromQuery.ts  stayAwake 默认开
src/server/clientProfile.ts       按客户端能力强制码率/参数
src/style/modal.css               全屏时不再写死 padding
webpack/ws-scrcpy-web.common.ts   把 public/ 下的 PWA 与 custom-ui 资源纳入构建
```

## 已知边界

- **投屏里看不到 vivo 系统安全键盘**（`com.vivo.secime.service` 的 `SecureInputMethod` 带 `FLAG_SECURE`）。停用该服务能看见，但部分游戏会闪退，所以保持默认。
- **iOS 后台保活做不到**：不加开发者账号、不越狱的前提下，切后台必断，我们做的是「回来能自愈」，不是「不断」。
- 旋转只作用于「源是横屏 + 视口是竖屏」这一种组合；竖屏内容（抖音、微信）不会被动旋转。
