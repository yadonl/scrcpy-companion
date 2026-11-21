export const PCM_WORKLET_NAME = 'pcm-worklet';

/**
 * 音画不同步的根因（2026-11-21 实测：声音落后画面约 2 秒）：
 * 这个 worklet 的队列是**无上限**的 —— 开流那一瞬间 WebSocket 会把缓冲里的
 * 音频包一口气灌进来（1~2 秒的量），之后生产速率和消费速率都是 48kHz，
 * 积压永远不消失，于是一路慢到底。AudioContext 自身的延迟只有几十毫秒，
 * 所以必须由我们自己「追帧」：积压超过 MAX 就从最老的样本开始丢，丢回到
 * TARGET。丢的是最早的声音，人耳感觉就是"一开就有声、立刻对齐"，比越拖越远好。
 */
const MAX_MS = 200;
const TARGET_MS = 90;

export const PCM_WORKLET_SOURCE = `
class PcmWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];
        this._queued = 0;          // 队列里还没播的样本帧数
        this._rate = sampleRate;   // 由 AudioWorkletGlobalScope 提供
        this._max = this._rate * ${MAX_MS} / 1000;
        this._target = this._rate * ${TARGET_MS} / 1000;
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
        }
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

        // Fill remaining with silence (underrun)
        if (written < frameCount) {
            for (let ch = 0; ch < outChannels; ch++) {
                output[ch].fill(0, written);
            }
        }

        // 每秒回报一次积压毫秒数（排障用：正常应稳定在目标值附近，不是 2000）
        if (currentTime - this._lastReport >= 1) {
            this._lastReport = currentTime;
            this.port.postMessage({ queuedMs: Math.round(this._queued / this._rate * 1000) });
        }

        return true;
    }
}

registerProcessor('${PCM_WORKLET_NAME}', PcmWorkletProcessor);
`;
