// 实时语音识别：采集麦克风 PCM，经 WebSocket 流式发到后端（再到阿里云 NLS），边说边出字。
// 关键点：AudioContext（音频引擎）「常驻保温」维持音频会话不被关闭，从而避免每次松手时
// iOS 关闭会话发出的“停止声音”；但真正的麦克风采集流（getUserMedia）按需取用，松手即停，
// 这样状态栏的橙色录音点只在说话时亮，平时熄灭。

import { asrWsUrl } from "./api";

export function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) &&
    typeof WebSocket !== "undefined"
  );
}

// Float32（任意采样率）→ Int16 PCM（16kHz），用区间平均简单抗混叠。
function toPcm16(input: Float32Array, inRate: number): ArrayBuffer {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const outLen = ratio > 1 ? Math.floor(input.length / ratio) : input.length;
  const out = new DataView(new ArrayBuffer(outLen * 2));
  for (let i = 0; i < outLen; i += 1) {
    let sample: number;
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      let n = 0;
      for (let j = start; j < end; j += 1) {
        sum += input[j];
        n += 1;
      }
      sample = n ? sum / n : 0;
    } else {
      sample = input[i];
    }
    const s = Math.max(-1, Math.min(1, sample));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out.buffer;
}

export interface AsrHandlers {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}

export class StreamingAsr {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private inRate = 44100;
  private ws: WebSocket | null = null;
  private sending = false;
  private settled = false;

  // 本次识别是否已出结果/结束（final 可能在松手前就到达）。用于上层避免重复计数。
  get isSettled(): boolean {
    return this.settled;
  }

  // 保温音频引擎：AudioContext + ScriptProcessor 常驻并连到 destination，让 iOS 音频会话
  // 保持激活，避免开关会话的提示音。不持有麦克风，所以此时没有橙色录音点。
  private async ensureEngine(): Promise<void> {
    if (this.ctx && this.processor) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    this.inRate = this.ctx.sampleRate;
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.sending || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const pcm = toPcm16(e.inputBuffer.getChannelData(0), this.inRate);
      this.ws.send(pcm);
    };
    this.processor.connect(this.ctx.destination); // 处理器不写输出 → 静音
  }

  // 取麦克风并接入引擎。第一次会弹一次授权；之后不再弹。必须在用户手势内首次调用。
  private async acquireMic(): Promise<void> {
    await this.ensureEngine();
    if (this.stream && this.source) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.source = this.ctx!.createMediaStreamSource(this.stream);
    this.source.connect(this.processor!);
  }

  // 松开麦克风：停止采集流、断开 source → 橙色录音点熄灭。引擎（ctx/processor）保留不关，
  // 会话仍激活，故无停止声。下次说话时 acquireMic 重新取麦克风。
  private releaseMic(): void {
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
  }

  // 开始一次识别：连 WS、开始发送音频。
  async start(handlers: AsrHandlers): Promise<void> {
    await this.acquireMic();
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
    this.settled = false;

    const ws = new WebSocket(asrWsUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg: { type?: string; text?: string; message?: string };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.type === "partial") handlers.onPartial?.(msg.text ?? "");
      else if (msg.type === "final") {
        if (!this.settled) {
          this.settled = true;
          handlers.onFinal(msg.text ?? "");
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      } else if (msg.type === "error") {
        if (!this.settled) {
          this.settled = true;
          handlers.onError(msg.message ?? "识别失败");
        }
      }
    };
    ws.onerror = () => {
      if (!this.settled) {
        this.settled = true;
        handlers.onError("识别连接失败");
      }
    };
    ws.onclose = () => {
      if (!this.settled) {
        this.settled = true;
        handlers.onError("识别中断");
      }
      this.sending = false;
    };

    // 连接尚未 open 时也先开采集；onaudioprocess 里已判断 ws 状态，OPEN 后才真正发。
    this.sending = true;
  }

  // 结束本次说话：通知后端停止，松开麦克风（橙点熄灭），等待最终结果（通过 onFinal 回调）。
  // 只放麦克风，不销毁音频引擎（引擎保温、会话不关 → 无停止声）。
  stop(): void {
    this.sending = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ action: "stop" }));
      } catch {
        /* ignore */
      }
    }
    this.releaseMic();
  }

  // 取消本次说话：按得太短（误触）时调用。直接关连接、放麦克风，不提交、不回调结果。
  cancel(): void {
    this.sending = false;
    this.settled = true; // 抑制 onclose 触发的“识别中断”错误
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.releaseMic();
  }

  // 彻底释放麦克风（退出登录时调用），会关闭音频会话。
  async dispose(): Promise<void> {
    this.sending = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = this.stream = this.source = this.processor = this.ws = null;
  }
}
