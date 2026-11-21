// src/app/audio/AudioPlayer.ts
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';
import { decodeS16LEToFloat32Planar } from './pcmConvert';

/** 0.1 秒静音（8kHz / 8bit 单声道，844 字节）：只为了让 iOS 认这页"在放媒体" */
const SILENT_WAV =
    'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICK';

export class AudioPlayer {
    // Explicit `| undefined` (matching `configData` below) because
    // `exactOptionalPropertyTypes` is on: stop() clears these back to
    // undefined, which a bare `?:` optional does not permit.
    private audioContext?: AudioContext | undefined;
    private silence?: HTMLAudioElement | undefined;
    private decoder?: AudioDecoder | undefined;
    private workletNode?: AudioWorkletNode | undefined;
    private gainNode?: GainNode | undefined;
    private started = false;
    private workletReady = false;
    private configData?: Uint8Array | undefined;

    constructor(private readonly codec: string) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

        // Load worklet via Blob URL
        const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME, {
            outputChannelCount: [2],
        });
        // worklet 每秒回报积压量，挂到全局方便排障（音画不同步时先看这个数）
        this.workletNode.port.onmessage = (e: MessageEvent) => {
            const ms = (e.data as { queuedMs?: number }).queuedMs;
            if (typeof ms === 'number') {
                (globalThis as unknown as { __xAudioBufferMs?: number }).__xAudioBufferMs = ms;
            }
        };
        this.gainNode = this.audioContext.createGain();
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        this.workletReady = true;

        // Raw PCM doesn't need a decoder
        if (this.codec === 'raw') return;

        // Configure audio decoder
        this.decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                this.postDecodedAudio(audioData);
            },
            error: (err: DOMException) => {
                console.error('[AudioPlayer] Decoder error:', err.message);
            },
        });

        this.configureDecoder();
    }

    private configureDecoder(): void {
        if (!this.decoder) return;

        const config: AudioDecoderConfig = {
            codec: this.webCodecsCodecString(),
            sampleRate: 48000,
            numberOfChannels: 2,
        };

        // AAC and FLAC need the config packet as description
        if ((this.codec === 'aac' || this.codec === 'flac') && this.configData) {
            config.description = this.configData;
        }

        // Opus is self-contained; configure immediately
        // AAC/FLAC configure after receiving config packet (configureDecoder called from pushFrame)
        if (this.codec === 'opus' || this.configData) {
            this.decoder.configure(config);
        }
    }

    private webCodecsCodecString(): string {
        switch (this.codec) {
            case 'opus':
                return 'opus';
            case 'aac':
                return 'mp4a.40.2';
            case 'flac':
                return 'flac';
            default:
                return this.codec;
        }
    }

    private postDecodedAudio(audioData: AudioData): void {
        if (!this.workletReady) {
            audioData.close();
            return;
        }
        const numChannels = audioData.numberOfChannels;
        const numFrames = audioData.numberOfFrames;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = new Float32Array(numFrames);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
            channels.push(channelData);
        }
        audioData.close();
        this.workletNode!.port.postMessage(
            { channels, numFrames },
            channels.map((c) => c.buffer),
        );
    }

    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void {
        if (this.codec === 'raw') {
            this.pushRawPcm(data);
            return;
        }

        if (isConfig) {
            this.configData = new Uint8Array(data);
            // For AAC/FLAC, (re)configure decoder now that we have the config
            if (this.codec === 'aac' || this.codec === 'flac') {
                this.configureDecoder();
            }
            return;
        }

        if (this.decoder?.state !== 'configured') return;

        this.decoder.decode(
            new EncodedAudioChunk({
                type: 'key',
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Raw PCM: convert S16LE samples to Float32 and post directly to worklet. */
    private pushRawPcm(data: Uint8Array): void {
        if (!this.workletReady) return;

        const channelCount = 2;
        const channels = decodeS16LEToFloat32Planar(data, channelCount);
        const framesPerChannel = channels[0]?.length ?? 0;

        this.workletNode!.port.postMessage(
            { channels, numFrames: framesPerChannel },
            channels.map((c) => c.buffer),
        );
    }

    /**
     * 该不该 resume。
     *
     * Safari（iOS/iPadOS）后台回来给的是 `'interrupted'`，不是 Chrome 那套
     * `'suspended'`。只认 suspended 的话切回来根本不会调 resume —— 用户看到的
     * 就是"声音没了、还弹个红条要我点"。这里两种都接。
     */
    private needsResume(): boolean {
        const state = this.audioContext?.state as string | undefined;
        return state === 'suspended' || state === 'interrupted';
    }

    async resume(): Promise<void> {
        if (!this.needsResume()) return;
        try {
            await this.audioContext!.resume();
        } catch (err) {
            // 系统还没把音频会话还回来时 resume 会 reject，等下一次重试即可
            console.warn('[AudioPlayer] resume failed:', (err as Error)?.message);
        }
    }

    /**
     * 静音循环的 <audio>：给 iOS 一个「这页在放媒体」的身份。
     *
     * 有这个身份，切后台再回来系统才愿意把音频会话还给我们；纯 WebAudio
     * 的页面后台一挂就被判定成"没在放东西"。必须在用户手势里调用一次。
     */
    keepSessionAlive(): void {
        if (this.silence) return;
        const audio = new Audio(SILENT_WAV);
        audio.loop = true;
        audio.volume = 0.01;
        audio.setAttribute('playsinline', '');
        audio.setAttribute('aria-hidden', 'true');
        void audio.play().catch(() => {
            /* 没手势时 play 会被拒，下次手势会再调一次 */
        });
        // 排障抓手：控制台里看 __xAudioKeeper.paused 就知道音频会话还在不在
        (globalThis as unknown as { __xAudioKeeper?: HTMLAudioElement }).__xAudioKeeper = audio;
        this.silence = audio;
    }

    /** 供 UI 判断是否需要提示用户「点一下开声音」 */
    isRunning(): boolean {
        return this.audioContext?.state === 'running';
    }

    setVolume(volume: number): void {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    /**
     * Tear the player down. Safe to call repeatedly.
     *
     * A single user-initiated stop reaches here twice: `StreamClientScrcpy`
     * calls it directly, and the `demuxer.close()` alongside it triggers a
     * WebSocket `onclose` → `onDisconnected`, which calls it again. A real
     * `AudioContext` rejects a second `close()` with `InvalidStateError:
     * Can't close an AudioContext twice`, and nothing awaits that promise —
     * which is how it surfaced as an uncaught rejection in issue #498.
     *
     * So: guard on state the way the decoder above already did, drop the
     * references so a repeat call has nothing left to act on, and catch the
     * promise in case the browser closed the context out from under us.
     */
    stop(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        this.silence?.pause();
        this.silence = undefined;
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {
                // Already closed elsewhere — nothing to do, and an unhandled
                // rejection here is the exact bug this method is fixing.
            });
        }
        this.decoder = undefined;
        this.workletNode = undefined;
        this.gainNode = undefined;
        this.audioContext = undefined;
        this.started = false;
        this.workletReady = false;
        this.configData = undefined;
    }
}
