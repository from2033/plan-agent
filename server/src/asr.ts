// 把浏览器 WebSocket 桥接到阿里云 NLS「一句话识别」流式接口（带中间结果）。
// 浏览器 → 本服务器(WS) → 阿里云 NLS(WS)。用 ws 库连 NLS（走 Node http，不经 undici 海外代理，直连国内）。
import { WebSocket } from "ws";
import crypto from "node:crypto";
import { getNlsToken } from "./transcribe.js";

const REGION = process.env.NLS_REGION || "cn-shanghai";

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

type WS = WebSocket;

export async function bridgeToNls(client: WS): Promise<void> {
  const appkey = process.env.ALIYUN_NLS_APPKEY as string;
  const taskId = uuid();
  let nls: WS | null = null;
  let started = false;
  let stopped = false;
  let finalSent = false;
  const queue: Buffer[] = [];

  const toClient = (obj: unknown) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(obj));
  };

  let token: string;
  try {
    token = await getNlsToken();
  } catch (e) {
    console.error("[asr] 获取 NLS Token 失败:", (e as Error).message);
    toClient({ type: "error", message: "获取识别凭证失败" });
    client.close();
    return;
  }

  nls = new WebSocket(`wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1`, {
    headers: { "X-NLS-Token": token },
  });

  const startMsg = {
    header: { message_id: uuid(), task_id: taskId, namespace: "SpeechRecognizer", name: "StartRecognition", appkey },
    payload: {
      format: "pcm",
      sample_rate: 16000,
      enable_intermediate_result: true,
      enable_punctuation_prediction: true,
      enable_inverse_text_normalization: true,
    },
  };
  const stopMsg = () => ({
    header: { message_id: uuid(), task_id: taskId, namespace: "SpeechRecognizer", name: "StopRecognition", appkey },
  });

  nls.on("open", () => {
    nls!.send(JSON.stringify(startMsg));
  });

  nls.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    let msg: { header?: { name?: string; status_text?: string }; payload?: { result?: string } };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const name = msg.header?.name;
    if (name === "RecognitionStarted") {
      started = true;
      for (const buf of queue) nls!.send(buf);
      queue.length = 0;
      toClient({ type: "ready" });
    } else if (name === "RecognitionResultChanged") {
      toClient({ type: "partial", text: msg.payload?.result ?? "" });
    } else if (name === "RecognitionCompleted") {
      finalSent = true;
      toClient({ type: "final", text: msg.payload?.result ?? "" });
    } else if (name === "TaskFailed") {
      console.error("[asr] NLS TaskFailed:", msg.header?.status_text);
      toClient({ type: "error", message: msg.header?.status_text ?? "识别失败" });
    }
  });

  nls.on("error", (err: Error) => {
    console.error("[asr] NLS ws error:", err.message);
    toClient({ type: "error", message: "识别服务连接失败" });
  });
  nls.on("close", () => {
    if (!finalSent) toClient({ type: "error", message: "识别中断" });
    if (client.readyState === client.OPEN) client.close();
  });

  client.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!nls || nls.readyState !== WebSocket.OPEN) return;
      if (started) nls.send(data);
      else queue.push(Buffer.from(data));
    } else {
      let ctrl: { action?: string };
      try {
        ctrl = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (ctrl.action === "stop" && !stopped && nls && nls.readyState === WebSocket.OPEN) {
        stopped = true;
        nls.send(JSON.stringify(stopMsg()));
      }
    }
  });

  client.on("close", () => {
    if (nls && nls.readyState === WebSocket.OPEN) {
      try {
        if (!stopped) nls.send(JSON.stringify(stopMsg()));
      } catch {
        /* ignore */
      }
      // 给 NLS 一点时间回 RecognitionCompleted 再关
      setTimeout(() => {
        try {
          nls?.close();
        } catch {
          /* ignore */
        }
      }, 1500);
    }
  });
  client.on("error", () => {
    try {
      nls?.close();
    } catch {
      /* ignore */
    }
  });
}
