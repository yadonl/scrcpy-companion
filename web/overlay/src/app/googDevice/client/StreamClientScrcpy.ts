import { ACTION } from '../../../common/Action';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { applyStreamParams } from '../../../common/StreamUrlParams';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { Attribute } from '../../Attribute';
import { AudioPlayer } from '../../audio/AudioPlayer';
import { BaseClient } from '../../client/BaseClient';
import { settingsService } from '../../client/SettingsService';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import type { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import type { DisplayInfo } from '../../DisplayInfo';
import {
    FeaturedInteractionHandler,
    type InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import { BasePlayer, type PlayerClass } from '../../player/BasePlayer';
import type { WebCodecsPlayer } from '../../player/WebCodecsPlayer';
import { probeDecodeSupport } from '../../player/webCodecsConfig';
import { ScrcpyDemuxer, type SessionMetadata } from '../../ScrcpyDemuxer';
import Size from '../../Size';
import Util from '../../Util';
import { html } from '../../ui/HtmlTag';
import VideoSettings from '../../VideoSettings';
import DeviceMessage from '../DeviceMessage';
import { type KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import { UhidKeyboardHandler } from '../UhidKeyboardHandler';
import { UhidManager } from '../UhidManager';
import { UhidMouseHandler } from '../UhidMouseHandler';
import { ClipboardCopyPrompt } from './ClipboardCopyPrompt';
import { ConfigureScrcpy } from './ConfigureScrcpy';
import { chooseCodec, chooseCodecWithoutProbe } from './codecSelection';
import { DeviceTracker } from './DeviceTracker';
import { RollingWindow } from './RollingWindow';
import { forgetStreamForResume, rememberStreamForResume } from './streamDeepLink';

type StartParams = {
    udid: string;
    playerName?: string | undefined;
    player?: BasePlayer | undefined;
    fitToScreen?: boolean | undefined;
    videoSettings?: VideoSettings | undefined;
    deviceKind?: 'phone' | 'tablet' | 'tv' | undefined;
};

const TAG = '[StreamClientScrcpy]';

/**
 * Average encoded frame size below which there is almost certainly no picture.
 * A black screen measured 13 bytes per frame on a Pixel 10a against 30-50KB
 * once unlocked, so even a still photo sits far above this.
 */
export const NO_PICTURE_FRAME_BYTES = 1000;

/**
 * Whether the stream appears to have stopped showing anything, which is the cue
 * to ask the device whether its keyguard is up.
 *
 * Two independent conditions, because one alone is not enough:
 *
 * - **Relative** catches a stream that *becomes* static, i.e. the phone locking
 *   part-way through a session.
 * - **Absolute** catches one that starts that way. Connecting to an
 *   already-locked phone builds the baseline out of black frames, so nothing
 *   can ever look small relative to it — that is exactly what a reconnect onto
 *   a locked phone does, and the case that left issue #498's reporter staring
 *   at black with no explanation.
 *
 * Being liberal here is safe: crossing the line only prompts a question to the
 * device, and the banner is driven by its answer rather than by this guess.
 */
export function looksLikeNoPicture(averageFrameBytes: number, baselineFrameBytes: number): boolean {
    const relativeDrop = baselineFrameBytes > 0 && averageFrameBytes < baselineFrameBytes * 0.1;
    return relativeDrop || averageFrameBytes < NO_PICTURE_FRAME_BYTES;
}

/**
 * Close codes that end a stream normally: 1000 normal closure, 1001 going away
 * (tab close/refresh), 1005 no code given — the server's own release on a
 * normal end closes without a code. Every other code is a failure, including
 * the server's 4xxx application codes (4005: the session failed, with the
 * reason) and 1006 (the connection dropped without a close frame).
 */
const NORMAL_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1001, 1005]);

/**
 * The error a closed stream socket stands for, or undefined for a normal end.
 * Close codes are the only signal for an async stream failure: ScrcpyDemuxer's
 * `ws.onerror` is a no-op.
 */
export function streamFailureFromClose(ev?: Pick<CloseEvent, 'code' | 'reason'>): Error | undefined {
    if (!ev || NORMAL_CLOSE_CODES.has(ev.code)) return undefined;
    return new Error(ev.reason || `WebSocket closed with code ${ev.code}`);
}

async function browserSupportsCodec(codec: string): Promise<boolean> {
    // An unanswerable probe (no WebCodecs API) resolves to false so the caller
    // exhausts its preference loop and falls through to its plain h264 default,
    // rather than committing to a codec we have even less reason to believe in.
    // A definite `false` is honoured for every codec, H.264 included — see
    // probeDecodeSupport and issue #498.
    return (await probeDecodeSupport(codec)) ?? false;
}

async function detectBestCodecAndEncoder(
    udid: string,
    params: { hostname?: string | undefined; port?: number | undefined; secure?: boolean | undefined },
): Promise<{ videoCodec: string; encoderName?: string | undefined }> {
    // 1. Probe the device for available encoders
    let videoEncoders: string[] = [];
    try {
        const { DeviceProbeClient } = await import('../../client/DeviceProbeClient');
        const probe = await DeviceProbeClient.probe(udid, {
            hostname: params.hostname || window.location.hostname,
            port: params.port || Number.parseInt(window.location.port, 10) || 80,
            secure: params.secure || false,
        });
        videoEncoders = probe.videoEncoders;
        console.log(TAG, `Probe returned encoders: ${videoEncoders.join(', ')}`);
    } catch (err) {
        console.warn(TAG, 'Device probe failed, falling back to browser-only detection:', (err as Error).message);
        return chooseCodecWithoutProbe(browserSupportsCodec, (message) => console.log(TAG, message));
    }

    // 2. Walk the preference order for a codec the device can encode and the
    //    browser can decode, and pick the best encoder for it.
    return chooseCodec(videoEncoders, browserSupportsCodec, (message) => console.log(TAG, message));
}

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private controlButtons?: HTMLElement | undefined;
    private deviceName = '';
    private touchHandler?: FeaturedInteractionHandler | undefined;
    private uhidManager?: UhidManager | undefined;
    private uhidKeyboard?: UhidKeyboardHandler | undefined;
    private uhidMouse?: UhidMouseHandler | undefined;
    private player?: BasePlayer | undefined;
    private fitToScreen?: boolean | undefined;
    private demuxer?: ScrcpyDemuxer | undefined;
    private audioPlayer?: AudioPlayer | undefined;
    // Fixed 30-frame rolling window with an O(1) running average — replaces the
    // per-frame shift()/reduce() churn on the video hot path. `frameSampleCount`
    // tracks how many frames we have observed (for the initial baseline build).
    private static readonly FRAME_WINDOW_SIZE = 30;
    private frameSizes = new RollingWindow(StreamClientScrcpy.FRAME_WINDOW_SIZE);
    private frameSampleCount = 0;
    private baselineFrameSize = 0;
    private degradationCount = 0;
    /** Banner shown over the video while the device reports its keyguard is up. */
    private lockedNotice?: HTMLElement | undefined;
    /** Offers the device clipboard for a click when the browser refuses to write it unprompted. */
    private readonly clipboardPrompt = new ClipboardCopyPrompt();
    private lastLockCheckTime = 0;
    /** Each check is an adb round trip, so do not ask more often than this. */
    private static readonly LOCK_CHECK_INTERVAL_MS = 5000;
    private stopFn?: (() => void) | undefined;

    /** Public hook — fires after session metadata is parsed. Used by the public startStream API. */
    public onMetadataReceived?: ((info: { codec: string; encoder: string; resolution: string }) => void) | undefined;

    /** Public hook — fires on async stream errors (WebSocket refused, probe failure, etc.). */
    public onErrorReceived?: ((err: Error) => void) | undefined;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    private static getPlayerClass(playerName: string): PlayerClass | undefined {
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                return value;
            }
        }
        return;
    }

    public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) return;
        return new playerClass(udid, displayInfo);
    }

    public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) return false;
        return playerClass.getFitToScreenStatus(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
        container?: HTMLElement,
        onDisconnect?: () => void,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ): { instance: StreamClientScrcpy; stop: () => void } {
        const params = query instanceof URLSearchParams ? StreamClientScrcpy.parseParameters(query) : query;
        const instance = new StreamClientScrcpy(
            params,
            player,
            fitToScreen,
            videoSettings,
            container,
            onDisconnect,
            deviceKind,
        );
        return { instance, stop: () => instance.stopStream() };
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
        private readonly container?: HTMLElement,
        private readonly onDisconnectCallback?: () => void,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ) {
        super(params);
        const { udid, player: playerName } = this.params;
        this.startStream({
            udid,
            player,
            playerName,
            fitToScreen: fitToScreen ?? params.fitToScreen,
            videoSettings,
            deviceKind,
        });
        // 后台掐断后自愈的两只耳朵，以及"页面可能死在这个后台里"的记忆
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('online', this.onNetworkBack);
        rememberStreamForResume(udid);
    }

    public static override parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
        };
    }

    private buildStreamUrl(): string {
        const { hostname, port, secure } = this.params;
        const protocol = secure ? 'wss' : 'ws';
        const host = hostname || window.location.hostname;
        const p = port || Number.parseInt(window.location.port, 10) || (secure ? 443 : 80);
        const url = new URL(`${protocol}://${host}:${p}/`);
        const vs = this.player?.getVideoSettings();
        applyStreamParams(
            url,
            {
                udid: this.params.udid,
                videoCodec: this.params.videoCodec,
                audioCodec: this.params.audioCodec,
                audioEnabled: this.params.audioEnabled,
                audioSource: this.params.audioSource,
                encoderName: this.params.encoderName,
            },
            vs
                ? {
                      bitrate: vs.bitrate,
                      maxFps: vs.maxFps,
                      bounds: vs.bounds ? { width: vs.bounds.width, height: vs.bounds.height } : undefined,
                      displayId: vs.displayId,
                      iFrameInterval: vs.iFrameInterval,
                      codecOptions: vs.codecOptions,
                  }
                : undefined,
        );
        return url.toString();
    }

    public OnDeviceMessage = (data: Uint8Array): void => {
        const message = DeviceMessage.fromRaw(data);
        if (message.type === DeviceMessage.TYPE_CLIPBOARD) {
            const text = message.getText();
            if (text) this.clipboardPrompt.deliver(text);
        }
    };

    public onVideoFrame = (data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void => {
        this.lastFrameAt = Date.now();
        if (!this.player) return;
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE['PAUSED']) {
            this.player.play();
        }
        if (this.player.getState() === STATE['PLAYING']) {
            (this.player as WebCodecsPlayer).pushVideoFrame(data, pts, isConfig, isKeyframe);
        }

        // Track frame sizes for degradation detection (skip config frames)
        if (!isConfig && data.length > 0) {
            this.frameSizes.push(data.length);
            this.frameSampleCount++;
            // Build baseline from first 30 frames (window is full at this point)
            if (this.frameSampleCount === StreamClientScrcpy.FRAME_WINDOW_SIZE) {
                this.baselineFrameSize = this.frameSizes.average();
            }
            // Once past the baseline window, evaluate degradation each frame.
            // The window evicts the oldest sample in O(1) on every push above.
            if (this.frameSampleCount > StreamClientScrcpy.FRAME_WINDOW_SIZE) {
                this.checkForDegradation();
            }
        }
    };

    public onAudioFrame = (data: Uint8Array, pts: bigint, isConfig: boolean): void => {
        this.audioPlayer?.pushFrame(data, pts, isConfig);
    };

    public onMetadata = (meta: SessionMetadata): void => {
        this.deviceName = meta.deviceName;
        console.log(
            TAG,
            `Connected: ${meta.deviceName} ${meta.screenWidth}x${meta.screenHeight} video=${meta.videoCodec} audio=${meta.audioCodec}`,
        );
        // 会话回来了 = 自愈成功，把"重连中"的提示和计时器清掉
        this.clearResume();
        this.lastFrameAt = Date.now();
        this.stallProbeAt = 0;
        // 真收到会话元数据，才算这条连接是活的；从此再断就是前台真故障
        this.pageHiddenAt = 0;

        // Pass metadata dimensions to player as fallback (AV1 config doesn't include dimensions)
        if (this.player && 'setMetadataSize' in this.player) {
            (this.player as any).setMetadataSize(meta.screenWidth, meta.screenHeight);
        }

        // Pass session info for quality stats overlay
        if (this.player) {
            this.player.setSessionInfo(meta.videoCodec, meta.audioCodec, meta.videoEncoder || this.params.encoderName);
        }

        // Public hook — fire after session metadata is parsed. Mirrors the
        // fields used by the stats overlay above so there is a single source
        // of truth for codec/encoder/resolution.
        this.onMetadataReceived?.({
            codec: meta.videoCodec ?? '',
            encoder: meta.videoEncoder ?? this.params.encoderName ?? '',
            resolution: `${meta.screenWidth ?? 0}x${meta.screenHeight ?? 0}`,
        });

        if (meta.audioCodec !== 'disabled' && meta.audioCodec !== 'error') {
            this.audioPlayer = new AudioPlayer(meta.audioCodec);
            this.audioPlayer
                .start()
                .then(() => {
                    if (this.userInteracted) void this.audioPlayer?.resume();
                    // 手势没能解锁（iOS 静音开关、或 resume 落在异步栈里）就给一个
                    // 明确可点的出口，别让用户对着无声画面猜。
                    this.watchAudioState();
                    return undefined;
                })
                .catch((err: Error) => {
                    console.error(TAG, 'Failed to start audio:', err.message);
                });
        }
    };

    /**
     * The device rotated, or the capture was resized mid-stream (item 24).
     *
     * Note what this deliberately does NOT do: it touches neither the audio
     * pipeline nor the session-info overlay. That is the whole reason a rotation
     * travels on its own channel instead of as a re-sent METADATA — `onMetadata`
     * above constructs an AudioPlayer, so routing rotations through it would
     * build a new one every time the user turned the phone.
     */
    private onSessionChange = (change: { width: number; height: number }): void => {
        console.log(TAG, `Session resized: ${change.width}x${change.height}`);
        if (this.player && 'onSourceResize' in this.player) {
            (this.player as unknown as { onSourceResize(w: number, h: number): void }).onSourceResize(
                change.width,
                change.height,
            );
        }
    };

    private isRefreshing = false;
    private isStopping = false;

    /* ---- 页面切后台后自愈 ----
     * iOS Safari 把页面放后台就挂起 JS 并掐断 WebSocket，回家时看到的是一张
     * 冻住的画面 + 设备列表，"失联要重连"就是这么来的。掐断本身拦不住，
     * 但可以认出它（后台期间关闭 / 关闭前刚进过后台）、不关投屏窗口，
     * 等页面回到前台再把连接接回来。
     */
    /** 最近一次进入后台的时刻（0 = 没进过后台）；用来认出"后台掐断"的关闭事件 */
    private pageHiddenAt = 0;
    /** 因为后台被掐断、正在等用户回来的状态 */
    private suspended = false;
    private resumeTimer: number | undefined;
    private resumeNotice?: HTMLElement | undefined;
    /** 回到前台后这么久还接不上，就认输、按正常断开退出投屏 */
    private static readonly RESUME_TIMEOUT_MS = 10000;
    /**
     * 后台超过这么久，回来就不信 socket 的 readyState 了，直接重建连接。
     * iOS 上挂了后台的 WebSocket 在 readyState 里仍然是 OPEN（要等协议栈发现
     * 对端没了才变），照旧判断就会被冻住一分钟再弹 "code 1006"。
     */
    private static readonly RESUME_PROACTIVE_AFTER_MS = 5000;
    /** 手机可能正从睡眠里醒来、adb 还没回来：一轮接不上就再来一轮 */
    private static readonly RESUME_MAX_ATTEMPTS = 6;
    private resumeAttempts = 0;
    /** 用户是否已经有过手势（iOS 靠它决定能不能唤醒 AudioContext） */
    private userInteracted = false;
    /** 「点这里开声音」按钮，AudioContext 起不来时才有 */
    private audioUnlockEl: HTMLButtonElement | undefined;

    /**
     * 盯着 AudioContext 的状态：一直起不来就给一个明确可点的按钮。
     *
     * 为什么要这么绕：iOS 上 `resume()` 只有在用户手势的同步调用栈里才生效，
     * 程序自己补唤、定时补唤都可能被忽略；而 iOS 静音开关又会把 WebAudio 直接
     * 掐掉。用户看到的只是「没声音」，分不清是哪一种 —— 给个按钮，能解锁就解锁，
     * 解锁了还没声就说明是静音开关。
     */
    private watchAudioState(container?: HTMLElement): void {
        let tries = 0;
        const tick = window.setInterval(() => {
            tries++;
            if (!this.audioPlayer) {
                window.clearInterval(tick);
                return;
            }
            if (this.audioPlayer.isRunning()) {
                window.clearInterval(tick);
                this.audioUnlockEl?.remove();
                this.audioUnlockEl = undefined;
                return;
            }
            const host = container ?? document.querySelector<HTMLElement>('.device-view');
            if (tries === 2 && host?.isConnected) this.showAudioUnlock(host);
            if (tries > 24) window.clearInterval(tick);
        }, 500);
    }

    private showAudioUnlock(container: HTMLElement): void {
        if (this.audioUnlockEl) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '🔇 点这里开声音';
        btn.style.cssText = [
            'position:absolute',
            'left:50%',
            'transform:translateX(-50%)',
            'bottom:calc(18px + env(safe-area-inset-bottom))',
            'z-index:9999',
            'padding:10px 18px',
            'border-radius:999px',
            'border:0',
            'background:#e8453c',
            'color:#fff',
            'font-size:15px',
            'box-shadow:0 6px 18px rgba(0,0,0,.45)',
        ].join(';');
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void this.audioPlayer?.resume();
            window.setTimeout(() => {
                if (this.audioPlayer?.isRunning()) {
                    btn.remove();
                    this.audioUnlockEl = undefined;
                } else {
                    btn.textContent = '🔇 仍无声：检查 iPhone 侧边静音开关';
                }
            }, 600);
        });
        container.appendChild(btn);
        this.audioUnlockEl = btn;
    }

    public onDisconnected = (ev?: CloseEvent): void => {
        // 非用户主动关流 → 一律先自己接，不再区分"是不是后台掐的"。
        // 以前的判断只认后台场景，于是「看着看着画面没了」会走到下面的失败分支：
        // 弹个错、关掉投屏，用户得手点一次连接。而 WiFi/LTE 换路径、Tailscale
        // 换 DERP 中继、手机无线调试抖一下，表现都是同一张不动的画。
        if (!this.isStopping && !this.isRefreshing) {
            this.suspended = true;
            if (document.visibilityState === 'hidden') {
                this.showResumeNotice();
            } else {
                this.resume('socket closed while visible');
            }
            return;
        }
        // Decide failure-vs-normal FIRST, before any callback runs. The
        // disconnect callback closes the connect modal, closing the modal stops
        // the stream, and stopping sets isStopping — so a check made after it
        // always read "the user stopped it" and no failure was ever reported
        // (smoke row 8.27). A user-initiated stop is never a failure.
        const failure = this.isStopping ? undefined : streamFailureFromClose(ev);
        this.audioPlayer?.stop();
        // Drop the reference the way refreshStream does. The session is over,
        // every remaining use site is optional-chained, and a live reference
        // is what let a user-initiated stop reach AudioPlayer.stop() twice.
        this.audioPlayer = undefined;
        this.uhidKeyboard?.detach();
        this.uhidMouse?.detach();
        this.uhidManager?.stop();
        // Don't destroy touch handler during refresh — refreshStream manages it,
        // and a refresh is not the end of the session, so report nothing.
        if (this.isRefreshing) return;
        this.touchHandler?.release();
        this.touchHandler = undefined;
        // Exactly one of the two. Without an error hook the end still has to be
        // reported, so a failure falls back to the disconnect callback.
        if (failure && this.onErrorReceived) {
            this.onErrorReceived(failure);
        } else {
            this.onDisconnectCallback?.();
        }
    };

    /** 帧停了但 socket 假装还活着：iOS 上这是最常见的死法 */
    private lastFrameAt = 0;
    private stallProbeAt = 0;
    private stallTimer: number | undefined = undefined;
    /** 画面静止时 scrcpy 本来就不出帧，所以先要关键帧探活，再决定要不要重连 */
    private static readonly STALL_AFTER_MS = 20000;
    private static readonly STALL_GRACE_MS = 6000;

    private startStallWatch(): void {
        if (this.stallTimer !== undefined) return;
        this.lastFrameAt = Date.now();
        this.stallProbeAt = 0;
        this.stallTimer = window.setInterval(() => this.stallTick(), 2000);
    }

    private stopStallWatch(): void {
        if (this.stallTimer !== undefined) {
            window.clearInterval(this.stallTimer);
            this.stallTimer = undefined;
        }
        this.stallProbeAt = 0;
    }

    private stallTick(): void {
        if (this.isStopping || this.isRefreshing || this.suspended) return;
        if (document.visibilityState === 'hidden') return;
        const now = Date.now();
        const quiet = now - this.lastFrameAt;
        if (quiet < StreamClientScrcpy.STALL_AFTER_MS) {
            this.stallProbeAt = 0;
            return;
        }
        if (this.stallProbeAt === 0) {
            // 不能一没帧就重连：手机屏幕不动的时候 scrcpy 就是不编码，那是正常的。
            // 要一帧关键帧（会强制重新抓屏），静态画面会立刻回帧，死连接不会。
            console.warn(TAG, `no video frame for ${Math.round(quiet / 1000)}s — asking for a keyframe`);
            this.stallProbeAt = now;
            this.demuxer?.sendControl(new CommandControlMessage(ControlMessage.TYPE_RESET_VIDEO));
            return;
        }
        if (now - this.stallProbeAt < StreamClientScrcpy.STALL_GRACE_MS) return;
        console.warn(TAG, 'still no frame after a keyframe request — the socket is dead on the wire, reconnecting');
        this.stallProbeAt = 0;
        this.suspended = true;
        this.showResumeNotice();
        this.resume('video stalled');
    }

    private readonly onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            this.pageHiddenAt = Date.now();
            // 页面可能就死在这个后台里：记下来，重载后由深链把自己接回来
            rememberStreamForResume(this.params.udid);
            return;
        }
        // 别在这里把 pageHiddenAt 清零：后台回来的 socket 会先"假装还活着"
        // （readyState 仍是 OPEN），随后才补一个 1006。清零就等于把那个 1006
        // 认成前台真故障 —— 用户看到的就是冻住一分钟之后报 "code 1006"。
        const hiddenFor = this.pageHiddenAt > 0 ? Date.now() - this.pageHiddenAt : 0;
        // 浏览器挂后台会把 AudioContext 一起挂起，回来先把它唤醒
        this.audioPlayer?.resume();
        this.resumeIfDead(hiddenFor >= StreamClientScrcpy.RESUME_PROACTIVE_AFTER_MS);
    };

    private readonly onNetworkBack = (): void => {
        if (document.visibilityState !== 'hidden') this.resumeIfDead(false);
    };

    /**
     * 回到前台：连接活着就什么都不做，死了就自己接回来。
     * force = 不信 readyState，直接重建（后台待了一会儿才回来的情况）。
     */
    private resumeIfDead(force: boolean): void {
        if (this.isStopping || this.isRefreshing) return;
        if (!force && this.demuxer?.isOpen()) {
            this.clearResume();
            return;
        }
        this.resume();
    }

    private resume(why = 'dead socket'): void {
        if (this.resumeTimer !== undefined) return;
        this.resumeAttempts++;
        console.log(TAG, `reconnecting (${why}, attempt ${this.resumeAttempts}/${StreamClientScrcpy.RESUME_MAX_ATTEMPTS})`);
        this.suspended = true;
        this.showResumeNotice();
        this.refreshStream();
        this.resumeTimer = window.setTimeout(() => {
            this.resumeTimer = undefined;
            if (this.demuxer?.isOpen()) return;
            if (this.resumeAttempts < StreamClientScrcpy.RESUME_MAX_ATTEMPTS) {
                this.resume();
                return;
            }
            console.warn(TAG, 'auto-reconnect did not come up; closing the stream');
            this.clearResume();
            this.onDisconnectCallback?.();
        }, StreamClientScrcpy.RESUME_TIMEOUT_MS);
    }

    /** 接上了，或者确定接不上：清掉"重连中"的痕迹 */
    private clearResume(): void {
        this.suspended = false;
        this.resumeAttempts = 0;
        if (this.resumeTimer !== undefined) {
            window.clearTimeout(this.resumeTimer);
            this.resumeTimer = undefined;
        }
        this.hideResumeNotice();
    }

    private showResumeNotice(): void {
        const parent = this.container;
        if (!parent || this.resumeNotice) return;
        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        const el = document.createElement('div');
        el.className = 'x-resume-notice';
        el.textContent = '重连中…';
        el.style.cssText =
            'position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:6px 14px;' +
            'border-radius:999px;background:rgba(0,0,0,.66);color:#fff;' +
            'font:13px/1.4 -apple-system,system-ui,sans-serif;z-index:2147483000;pointer-events:none;';
        parent.appendChild(el);
        this.resumeNotice = el;
    }

    private hideResumeNotice(): void {
        this.resumeNotice?.remove();
        this.resumeNotice = undefined;
    }

    public async startStream({
        udid,
        player,
        playerName,
        videoSettings,
        fitToScreen,
        deviceKind,
    }: StartParams): Promise<void> {
        this.isStopping = false;
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        // Hydrate the per-device cache before any sync video reads below (player
        // ctor read and getFitToScreen call). The hydrateDevice is once-guarded so
        // this is a cheap no-op on the modal flow (already hydrated by
        // ConfigureScrcpy.init / DeviceTracker handler) and self-sufficient on a
        // direct deep-link where no modal precedes startStream.
        await settingsService.hydrateDevice(udid);

        this.fitToScreen = fitToScreen;
        if (!player) {
            if (typeof playerName !== 'string') {
                throw Error('Must provide BasePlayer instance or playerName');
            }
            const p = StreamClientScrcpy.createPlayer(playerName, udid);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            if (typeof fitToScreen !== 'boolean') {
                fitToScreen = StreamClientScrcpy.getFitToScreen(playerName, udid);
            }
            player = p;
        }
        this.player = player;
        this.setTouchListeners(player);

        // A stalled decoder can only resynchronise on a keyframe, and keyframes
        // are scarce for every codec — h264 measured 1 in 307 frames over 24s,
        // the others 2 apiece. So if one is missed there is nothing to recover
        // on until we ask for another.
        player.on('video-stalled', ({ codec, reason }) => {
            console.log(TAG, `video stalled (codec=${codec}, reason=${reason}); requesting a keyframe`);
            this.demuxer?.sendControl(new CommandControlMessage(ControlMessage.TYPE_RESET_VIDEO));
        });

        if (!videoSettings) {
            videoSettings = player.getVideoSettings();
        }

        const deviceView = document.createElement('div');
        deviceView.className = 'device-view';
        const stop = (ev?: string | Event) => {
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(TAG, ev);
            }
            // Mark that the upcoming WebSocket close is user-initiated so
            // onDisconnected does not fire the public onErrorReceived hook.
            this.isStopping = true;
            const parent = deviceView.parentElement;
            if (parent) parent.removeChild(deviceView);
            this.setHandleKeyboardEvents(false);
            document.removeEventListener('pointerdown', unlockAudio, { capture: true });
            document.removeEventListener('touchend', unlockAudio, { capture: true });
            document.removeEventListener('keydown', unlockAudio, { capture: true });
            this.demuxer?.close();
            this.audioPlayer?.stop();
            this.audioPlayer = undefined;
            this.audioUnlockEl?.remove();
            this.audioUnlockEl = undefined;
            if (this.player) this.player.stop();
            this.clipboardPrompt.dispose();
        };

        this.stopFn = () => stop();

        const googToolBox = GoogToolBox.createToolBox(udid, player, this, deviceKind);
        this.controlButtons = googToolBox.getHolderElement();
        deviceView.appendChild(this.controlButtons);
        const video = document.createElement('div');
        video.className = 'video';
        // Overlay for "this device is locked". Android refuses to capture the
        // keyguard, so the stream is genuinely black through no fault of ours —
        // without this the app looks broken (see issue #498).
        this.lockedNotice = document.createElement('div');
        this.lockedNotice.className = 'stream-locked-notice';
        this.lockedNotice.hidden = true;
        this.lockedNotice.textContent = 'device is locked — unlock it to see the screen';
        // The prompt goes first: ws-scrcpy.css moves the notice out of its way
        // with a `prompt ~ notice` sibling rule, which only looks forward.
        video.appendChild(this.clipboardPrompt.element);
        video.appendChild(this.lockedNotice);
        deviceView.appendChild(video);
        player.setParent(video);
        player.pause();

        const target = this.container ?? document.body;
        target.appendChild(deviceView);
        if (fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                videoSettings = new VideoSettings({
                    ...videoSettings.toJSON(),
                    bounds: newBounds,
                });
            }
        }
        player.setVideoSettings(videoSettings, !!fitToScreen, false);

        // iOS 的 AudioContext 出生即 suspended，而且只有**在用户手势的同步调用栈里**
        // 调 resume() 才会真的生效。所以：
        //   * 不能 once —— 用户第一次点屏经常发生在播放器创建之前，那一下就废了；
        //   * 也要挂在 document 的捕获阶段，pointerdown/touchend 比 click 早，更稳。
        // 常驻监听、每次触摸都试一次，已经在跑就直接返回，开销可以忽略。
        const unlockAudio = () => {
            this.userInteracted = true;
            if (this.audioPlayer) void this.audioPlayer.resume();
        };
        document.addEventListener('pointerdown', unlockAudio, { capture: true });
        document.addEventListener('touchend', unlockAudio, { capture: true });
        document.addEventListener('keydown', unlockAudio, { capture: true });

        if (this.params.videoCodec) {
            // Caller supplied a codec — verify the browser can actually decode it
            if (!(await browserSupportsCodec(this.params.videoCodec))) {
                console.warn(
                    TAG,
                    `Requested codec "${this.params.videoCodec}" is not supported by this browser, falling back to h264`,
                );
                this.params.videoCodec = 'h264';
                this.params.encoderName = undefined;
            }
        } else {
            // Auto-detect best codec + encoder (direct link without ConfigureScrcpy)
            try {
                const detected = await detectBestCodecAndEncoder(udid, {
                    hostname: this.params.hostname,
                    port: this.params.port,
                    secure: this.params.secure,
                });
                this.params.videoCodec = detected.videoCodec;
                if (detected.encoderName) {
                    this.params.encoderName = detected.encoderName;
                }
            } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err));
                this.onErrorReceived?.(e);
                throw e;
            }
        }

        // Connect via ScrcpyDemuxer
        const streamUrl = this.buildStreamUrl();
        this.demuxer = new ScrcpyDemuxer(streamUrl);
        this.demuxer.onVideoFrame(this.onVideoFrame);
        this.demuxer.onAudioFrame(this.onAudioFrame);
        this.demuxer.onDeviceMessage(this.OnDeviceMessage);
        this.demuxer.onMetadata(this.onMetadata);
        this.demuxer.onSessionChange(this.onSessionChange);
        this.demuxer.onDisconnect(this.onDisconnected);

        // Always enable keyboard capture
        this.setHandleKeyboardEvents(true);
        this.startStallWatch();

        console.log(TAG, player.getName(), udid);
    }

    public stopStream(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        window.removeEventListener('online', this.onNetworkBack);
        this.stopStallWatch();
        this.clearResume();
        // 用户主动关掉的流不再自动重开
        forgetStreamForResume();
        if (this.stopFn) {
            this.stopFn();
            this.stopFn = undefined;
        }
    }

    public sendMessage(message: ControlMessage): void {
        this.demuxer?.sendControl(message);
    }

    /**
     * Watch for the frames going very small, and find out why.
     *
     * This used to conclude "the stream has degraded" and force a reconnect.
     * That premise was wrong: small frames mean the *picture is not changing*,
     * which is a perfectly healthy stream of a static screen. The thresholds
     * had already been loosened twice (10s → 30s, 25% → 10%) chasing false
     * positives rather than questioning the idea.
     *
     * The dominant cause is a locked phone. Android will not let anything
     * capture the keyguard, so it hands scrcpy a black surface, which encodes
     * to almost nothing — measured at 13 bytes per frame against 30-50KB once
     * unlocked. Reconnecting could never have fixed that; it just interrupted
     * the video for a second and landed on the same black screen, repeatedly
     * and without explanation. Issue #498 spent days on it.
     *
     * So the small-frame signal is now a prompt to *ask the device* what is
     * going on, rather than a verdict about the stream.
     */
    private checkForDegradation(): void {
        if (this.frameSizes.count < 10) return;

        const avg = this.frameSizes.average();
        if (looksLikeNoPicture(avg, this.baselineFrameSize)) {
            this.degradationCount++;
            if (this.degradationCount >= 5) {
                this.degradationCount = 0;
                void this.refreshLockedNotice();
            }
        } else {
            this.degradationCount = 0;
            // Picture is moving again, so whatever it was has passed.
            this.setLockedNotice(false);
        }
    }

    /**
     * Ask the device whether its keyguard is up, and show or hide the notice.
     *
     * Throttled because it costs an adb round trip, and deliberately fails
     * quiet: if we cannot get an answer we say nothing rather than accusing a
     * working device of being locked.
     */
    private async refreshLockedNotice(): Promise<void> {
        const now = Date.now();
        if (now - this.lastLockCheckTime < StreamClientScrcpy.LOCK_CHECK_INTERVAL_MS) return;
        this.lastLockCheckTime = now;
        try {
            const response = await fetch(`/api/devices/screen-state?udid=${encodeURIComponent(this.params.udid)}`);
            if (!response.ok) return;
            const state = (await response.json()) as { awake?: boolean; locked?: boolean };
            this.setLockedNotice(state.locked === true);
        } catch {
            // Offline, server restarting, endpoint unavailable — stay silent.
        }
    }

    private setLockedNotice(locked: boolean): void {
        if (!this.lockedNotice) return;
        const alreadyCorrect = this.lockedNotice.hidden === !locked;
        if (alreadyCorrect) return;
        this.lockedNotice.hidden = !locked;
        if (locked) {
            console.log(TAG, 'device reports its keyguard is up; screen capture will be black until it is unlocked');
        }
    }

    public refreshStream(): void {
        console.log(TAG, 'Refreshing stream (reconnect for fresh keyframe)');
        this.frameSizes.clear();
        this.frameSampleCount = 0;
        this.baselineFrameSize = 0;
        this.degradationCount = 0;

        // Detach disconnect callback from old demuxer BEFORE closing it.
        // The old WebSocket's onclose fires asynchronously — if we just use
        // isRefreshing as a guard, it races: refreshStream() sets isRefreshing=false
        // synchronously, then the async onclose fires onDisconnected which sees
        // isRefreshing=false and destroys the touch handler.
        if (this.demuxer) {
            this.demuxer.onDisconnect(() => {});
        }
        this.demuxer?.close();
        this.audioPlayer?.stop();
        this.audioPlayer = undefined;

        // Reset player state for fresh frames
        if (this.player) {
            this.player.stop();
            this.player.pause();
        }

        // Reconnect
        const streamUrl = this.buildStreamUrl();
        this.demuxer = new ScrcpyDemuxer(streamUrl);
        this.demuxer.onVideoFrame(this.onVideoFrame);
        this.demuxer.onAudioFrame(this.onAudioFrame);
        this.demuxer.onDeviceMessage(this.OnDeviceMessage);
        this.demuxer.onMetadata(this.onMetadata);
        this.demuxer.onSessionChange(this.onSessionChange);
        this.demuxer.onDisconnect(this.onDisconnected);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public setDpadMode(enabled: boolean): void {
        this.touchHandler?.setDpadMode(enabled);
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled) {
            KeyInputHandler.addEventListener(this);
        } else {
            KeyInputHandler.removeEventListener(this);
        }
    }

    public toggleUhid(enabled: boolean): void {
        if (enabled) {
            if (this.uhidManager) return;
            this.uhidManager = new UhidManager((msg) => this.sendMessage(msg));
            this.uhidManager.start();

            this.uhidKeyboard = new UhidKeyboardHandler(this.uhidManager);
            this.uhidKeyboard.attach();

            if (this.player) {
                this.uhidMouse = new UhidMouseHandler(this.uhidManager, this.player.getTouchableElement());
                this.uhidMouse.attach();
            }

            // Disable existing touch handler
            this.touchHandler?.release();
            this.touchHandler = undefined;

            // Disable existing keyboard handler
            KeyInputHandler.removeEventListener(this);
        } else {
            this.uhidKeyboard?.detach();
            this.uhidMouse?.detach();
            this.uhidManager?.stop();
            this.uhidKeyboard = undefined;
            this.uhidMouse = undefined;
            this.uhidManager = undefined;

            // Re-enable touch handler
            if (this.player) {
                this.setTouchListeners(this.player);
            }
        }
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        if (this.player) {
            this.player.setVideoSettings(videoSettings, !!this.fitToScreen, true);
        }
    }

    public getClientId(): number {
        return -1;
    }

    public getClientsCount(): number {
        return 1;
    }

    public getMaxSize(): Size | undefined {
        if (!this.controlButtons) return;
        // Use viewport dimensions, not this.container — at mount time, containers
        // inside fit-content parents (ConnectModal frame) haven't been sized yet
        // and would return 0. Viewport is stable and serves as the upper-bound
        // hint the encoder needs. CSS layout inside .video handles the
        // container-accurate display sizing.
        const width = (window.innerWidth - this.controlButtons.clientWidth) & ~15;
        const height = window.innerHeight & ~15;
        return new Size(width, height);
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) return;
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        fullName: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        const isConnected = descriptor.state === 'device';
        if (isConnected) {
            const configureButtonId = `configure_${Util.escapeUdid(descriptor.udid)}`;
            const e = html`<div class="stream ${blockClass}">
                <button
                    ${Attribute.UDID}="${descriptor.udid}"
                    ${Attribute.COMMAND}="${ControlCenterCommand.CONFIGURE_STREAM}"
                    ${Attribute.FULL_NAME}="${fullName}"
                    ${Attribute.SECURE}="${params.secure}"
                    ${Attribute.HOSTNAME}="${params.hostname}"
                    ${Attribute.PORT}="${params.port}"
                    ${Attribute.PATHNAME}="${params.pathname}"
                    id="${configureButtonId}"
                    class="active action-button"
                >
                    config stream
                </button>
            </div>`;
            const a = e.content.getElementById(configureButtonId);
            a && (a.onclick = this.onConfigureStreamClick);
            return e.content;
        }
        return;
    }

    private static onConfigureStreamClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLAnchorElement;
        const udid = Util.parseStringEnv(button.getAttribute(Attribute.UDID) || '');
        const secure = Util.parseBooleanEnv(button.getAttribute(Attribute.SECURE) || undefined) || false;
        const hostname = Util.parseStringEnv(button.getAttribute(Attribute.HOSTNAME) || undefined) || '';
        const port = Util.parseIntEnv(button.getAttribute(Attribute.PORT) || undefined);
        const pathname = Util.parseStringEnv(button.getAttribute(Attribute.PATHNAME) || undefined) || '';
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }
        if (typeof port !== 'number') {
            throw Error(`Invalid port type: ${typeof port}`);
        }
        const tracker = DeviceTracker.getInstance({
            type: 'android',
            secure,
            hostname,
            port,
            pathname,
        });
        const descriptor = tracker.getDescriptorByUdid(udid);
        if (!descriptor) return;
        event.preventDefault();

        const options: ParamsStreamScrcpy = {
            udid,
            player: '',
            action: ACTION.STREAM_SCRCPY,
            secure,
            hostname,
            port,
            pathname,
        };
        // Use device label (user-assigned name) for the modal title, falling back to model
        const nameEl = button.closest('.device')?.querySelector('.device-name-text');
        const deviceLabel = nameEl?.textContent || descriptor['ro.product.model'] || udid;
        new ConfigureScrcpy(tracker, descriptor, deviceLabel, options, (_result: boolean) => {
            // ConnectModal opens from ConfigureScrcpy.openStream() — home page stays intact
            // HostTracker.destroy() was removed: in the modal flow, the device list must persist
        });
    };
}
