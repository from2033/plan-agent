// 实时语音识别：采集麦克风 PCM，经 WebSocket 流式发到后端（再到阿里云 NLS），边说边出字。
// 关键点：AudioContext + 麦克风流「常驻保温」，每次说话只是开/停发送，不销毁音频引擎，
// 从而避免每次松手时 iOS 关闭音频会话发出的“停止声音”。

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

  // 第一次会弹一次麦克风授权；之后复用，保温不关闭。必须在用户手势内首次调用。
  private async ensureMic(): Promise<void> {
    if (this.stream && this.ctx && this.source) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    this.inRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.sending || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const pcm = toPcm16(e.inputBuffer.getChannelData(0), this.inRate);
      this.ws.send(pcm);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination); // 处理器不写输出 → 静音
  }

  // 开始一次识别：连 WS、开始发送音频。
  async start(handlers: AsrHandlers): Promise<void> {
    await this.ensureMic();
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

  // 结束本次说话：通知后端停止，等待最终结果（通过 onFinal 回调）。不销毁音频引擎（保温、无停止声）。
  stop(): void {
    this.sending = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ action: "stop" }));
      } catch {
        /* ignore */
      }
    }
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
