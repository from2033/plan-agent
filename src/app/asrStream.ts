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
  // 会话代号：每次 start 自增。中途 stop/cancel 会让 in-flight 的 start 与旧连接的回调失效，
  // 避免"按住后在 getUserMedia 完成前松手 → 取消又被 start 复活"的竞态。
  private epoch = 0;
  // 连接就绪前先缓存音频，OPEN 后补发，避免丢掉开头的话。
  private pending: ArrayBuffer[] = [];

  // 本次识别是否已出结果/结束（final 可能在松手前就到达）。用于上层避免重复计数。
  get isSettled(): boolean {
    return this.settled;
  }

  // 会话是否已建立（或正在建立）。用于上层判断松手时是否该计入"处理中"。
  isActive(): boolean {
    return this.ws !== null;
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
      if (!this.sending) return;
      const pcm = toPcm16(e.inputBuffer.getChannelData(0), this.inRate);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(pcm);
      } else {
        // 连接还没就绪：先缓存，OPEN 后补发，避免丢掉开头几句。上限约 7 秒防溢出。
        this.pending.push(pcm);
        if (this.pending.length > 80) this.pending.shift();
      }
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

  // 开始一次识别：取麦克风、连 WS、开始采集。采集在连接就绪前就开始（先缓存、OPEN 后补发）。
  async start(handlers: AsrHandlers): Promise<void> {
    const myEpoch = ++this.epoch;
    this.settled = false;
    this.pending = [];

    await this.acquireMic();
    // getUserMedia 期间若已 stop/cancel（epoch 变了），放弃本次，不建连、不回调。
    if (myEpoch !== this.epoch) {
      this.releaseMic();
      return;
    }
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();

    // 麦克风已接好才开始采集（之前置 true 会把 getUserMedia 期间的静音灌进缓存）。
    // 连接就绪前采到的音频先进 pending，OPEN 后补发，避免丢掉开头几句。
    this.sending = true;

    const ws = new WebSocket(asrWsUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (myEpoch !== this.epoch || ws.readyState !== WebSocket.OPEN) return;
      for (const buf of this.pending) {
        try { ws.send(buf); } catch { /* ignore */ }
      }
      this.pending = [];
      // 若连接就绪前用户已松手，则补发 stop 让后端结算。
      if (!this.sending) {
        try { ws.send(JSON.stringify({ action: "stop" })); } catch { /* ignore */ }
      }
    };
    ws.onmessage = (ev) => {
      if (myEpoch !== this.epoch) return; // 旧会话回调，忽略
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
        try { ws.close(); } catch { /* ignore */ }
      } else if (msg.type === "error") {
        if (!this.settled) {
          this.settled = true;
          handlers.onError(msg.message ?? "识别失败");
        }
      }
    };
    ws.onerror = () => {
      if (myEpoch !== this.epoch) return;
      if (!this.settled) {
        this.settled = true;
        handlers.onError("识别连接失败");
      }
    };
    ws.onclose = () => {
      if (myEpoch === this.epoch) {
        if (!this.settled) {
          this.settled = true;
          handlers.onError("识别中断");
        }
        this.sending = false;
        this.ws = null;
      }
    };
  }

  // 结束本次说话：松开麦克风（橙点熄灭），等待最终结果（onFinal）。
  // 若连接已建立 → 通知后端停止；若还在取麦克风（连接未建）→ 放弃本次（没采到音频）。
  stop(): void {
    this.sending = false;
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ action: "stop" })); } catch { /* ignore */ }
      }
      // CONNECTING 时：onopen 里会在 sending=false 的情况下补发 stop。
      this.releaseMic();
    } else {
      // start 还在取麦克风、连接尚未建立：作废本次（onaudioprocess 已采的缓存丢弃）。
      this.epoch += 1;
      this.settled = true;
      this.pending = [];
      this.releaseMic();
    }
  }

  // 取消本次说话：按得太短（误触）时调用。作废本次会话、放麦克风，不提交、不回调结果。
  cancel(): void {
    this.epoch += 1; // 作废 in-flight start 与已建连的回调
    this.settled = true;
    this.sending = false;
    this.pending = [];
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
