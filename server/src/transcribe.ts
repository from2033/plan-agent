// 阿里云智能语音交互（NLS）一句话识别。
// 需要环境变量：ALIYUN_NLS_APPKEY、ALIYUN_AK_ID、ALIYUN_AK_SECRET，可选 NLS_REGION（默认 cn-shanghai）。
import RPCClient from "@alicloud/pop-core";
import { Agent } from "undici";

const REGION = process.env.NLS_REGION || "cn-shanghai";

// 阿里云 NLS 在国内，直连即可。proxy.ts 给全局 fetch 设了"经海外代理访问 Anthropic"
// 的 dispatcher，会把阿里云（国内）请求也带进海外代理导致连接超时，所以这里单独用直连 Agent 绕开它。
const directDispatcher = new Agent();

export function nlsConfigured(): boolean {
  return Boolean(
    process.env.ALIYUN_NLS_APPKEY && process.env.ALIYUN_AK_ID && process.env.ALIYUN_AK_SECRET,
  );
}

// ─── Token 缓存 ───────────────────────────────────────────────────────────────
let cached: { id: string; expireAt: number } | null = null;

export async function getNlsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && now < cached.expireAt - 60) return cached.id;

  const client = new RPCClient({
    accessKeyId: process.env.ALIYUN_AK_ID as string,
    accessKeySecret: process.env.ALIYUN_AK_SECRET as string,
    endpoint: `http://nls-meta.${REGION}.aliyuncs.com`,
    apiVersion: "2019-02-28",
  });
  const res = (await client.request("CreateToken", {})) as {
    Token?: { Id: string; ExpireTime: number };
  };
  if (!res.Token?.Id) throw new Error("NLS CreateToken 未返回 Token");
  cached = { id: res.Token.Id, expireAt: res.Token.ExpireTime };
  return cached.id;
}

// ─── 一句话识别 ───────────────────────────────────────────────────────────────
// audio: 16kHz 单声道 16-bit PCM 的 WAV。
export async function transcribe(audio: Buffer): Promise<string> {
  const token = await getNlsToken();
  const appkey = process.env.ALIYUN_NLS_APPKEY as string;
  const url =
    `https://nls-gateway-${REGION}.aliyuncs.com/stream/v1/asr` +
    `?appkey=${encodeURIComponent(appkey)}` +
    `&format=wav&sample_rate=16000` +
    `&enable_punctuation_prediction=true&enable_inverse_text_normalization=true`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "X-NLS-Token": token, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(audio),
    // 绕开全局海外代理，直连阿里云。
    dispatcher: directDispatcher,
  } as RequestInit & { dispatcher: Agent });
  const data = (await resp.json()) as { status?: number; result?: string; message?: string };
  if (data.status !== 20000000) {
    throw new Error(`NLS 识别失败: status=${data.status} message=${data.message ?? ""}`);
  }
  return data.result ?? "";
}
