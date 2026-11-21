export const PCM_WORKLET_NAME = 'pcm-worklet';

/**
 * 音画不同步的根因（2026-11-21 实测：声音落后画面约 2 秒）：
 * 这个 worklet 的队列是**无上限**的 —— 开流那一瞬间 WebSocket 会把缓冲里的
 * 音频包一口气灌进来（1~2 秒的量），之后生产速率和消费速率都是 48kHz，
 * 积压永远不消失，于是一路慢到底。AudioContext 自身的延迟只有几十毫秒，
 * 所以必须由我们自己「追帧」：积压超过 MAX 就从最老的样本开始丢，丢回到
 * TARGET。丢的是最早的声音，人耳感觉就是"一开就有声、立刻对齐"，比越拖越远好。
 *
 * 「啵、啵、啵」的根因（同日）：解码 60fps 高清视频会把主线程按几十毫秒地卡住，
 * 送音频的 onmessage 跟着断续 —— 队列一空就往输出里写 0，波形从满幅直接掉到 0，
 * 一次就是一声咔哒，一秒三四次、很有规律。丢样本（_trim）同理：从波形中间剪断，
 * 接缝也是一声。所以两头都做淡变：
 *   * 断粮：把尾巴 1.3ms 淡出，接进来的第一块淡入；
 *   * 丢样本：接缝处淡入。
 * 目标水位也从 90ms 抬到 150ms —— 90ms 太薄，扛不住主线程抖动。
 */
const MAX_MS = 300;
const TARGET_MS = 150;
/** 淡入淡出的采样帧数（48kHz 下约 1.3ms：听不出来，但足以消掉跳变） */
const FADE_FRAMES = 64;

export const PCM_WORKLET_SOURCE = `
class PcmWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];
        this._queued = 0;          // 队列里还没播的样本帧数
        this._rate = sampleRate;   // 由 AudioWorkletGlobalScope 提供
        this._max = this._rate * ${MAX_MS} / 1000;
        this._target = this._rate * ${TARGET_MS} / 1000;
        this._fade = ${FADE_FRAMES};
        /** 刚断过粮 / 丢过样本 → 下一块要从 0 淡入 */
        this._needFadeIn = false;
        this._underruns = 0;
        this.port.onmessage = (e) => {
            if (e.data && e.data.reset) {
                this._queue = [];
                this._queued = 0;
                return;
            }
            this._queue.push({
                channels: e.data.channels,
                numFrames: e.data.numFrames,
                offset: 0,
            });
            this._queued += e.data.numFrames;
            this._trim();
        };
        this._lastReport = 0;
    }

    /* 积压超过上限就从队头丢样本，直到回落到 target（延迟优先于完整性） */
    _trim() {
        let dropped = false;
        while (this._queued > this._max && this._queue.length > 0) {
            const b = this._queue[0];
            const remaining = b.numFrames - b.offset;
            const overflow = this._queued - this._target;
            if (overflow <= 0) break;
            if (remaining <= overflow) {
                this._queued -= remaining;
                this._queue.shift();
            } else {
                b.offset += overflow;
                this._queued -= overflow;
            }
            dropped = true;
        }
        // 从波形中间剪断 = 一声咔哒，接缝处淡入
        if (dropped) this._needFadeIn = true;
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output.length) return true;
        const frameCount = output[0].length;
        const outChannels = output.length;
        let written = 0;

        while (written < frameCount && this._queue.length > 0) {
            const block = this._queue[0];
            const remaining = block.numFrames - block.offset;
            const toWrite = Math.min(frameCount - written, remaining);

            for (let ch = 0; ch < outChannels; ch++) {
                const src = ch < block.channels.length ? block.channels[ch] : block.channels[0];
                output[ch].set(src.subarray(block.offset, block.offset + toWrite), written);
            }

            written += toWrite;
            block.offset += toWrite;
            this._queued -= toWrite;

            if (block.offset >= block.numFrames) {
                this._queue.shift();
            }
        }

        // 断过粮 / 丢过样本：接进来的第一块从 0 淡入
        if (this._needFadeIn && written > 0) {
            const n = Math.min(this._fade, written);
            for (let ch = 0; ch < outChannels; ch++) {
                const buf = output[ch];
                for (let i = 0; i < n; i++) buf[i] *= i / n;
            }
            this._needFadeIn = false;
        }

        // 断粮：尾巴淡出再把剩下的补 0，别从满幅直接跳 0
        if (written < frameCount) {
            this._underruns++;
            const n = Math.min(this._fade, written);
            for (let ch = 0; ch < outChannels; ch++) {
                const buf = output[ch];
                for (let i = 0; i < n; i++) buf[written - 1 - i] *= i / n;
                buf.fill(0, written);
            }
            this._needFadeIn = true;
        }

        // 每秒回报一次：积压毫秒数 + 断粮次数（排障用）
        if (currentTime - this._lastReport >= 1) {
            this._lastReport = currentTime;
            this.port.postMessage({
                queuedMs: Math.round(this._queued / this._rate * 1000),
                underruns: this._underruns,
            });
        }

        return true;
    }
}

registerProcessor('${PCM_WORKLET_NAME}', PcmWorkletProcessor);
`;
