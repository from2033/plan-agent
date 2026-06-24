import crypto from "node:crypto";

// 字段级加密：对敏感内容用 AES-256-GCM 加密后再存进 SQLite。
// 存储格式： "enc1:" + base64(iv[12] | authTag[16] | ciphertext)
// 没配 DB_ENCRYPTION_KEY 时退化为明文（启动时会告警）；读取按前缀自动识别明文/密文，可平滑迁移。

const PREFIX = "enc1:";

let cachedKey: Buffer | null = null;
let resolved = false;

function getKey(): Buffer | null {
  if (resolved) return cachedKey;
  resolved = true;
  const raw = (process.env.DB_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    cachedKey = null;
    return null;
  }
  const b = Buffer.from(raw, "base64");
  if (b.length !== 32) {
    throw new Error("DB_ENCRYPTION_KEY 必须是 base64 编码的 32 字节（AES-256）。");
  }
  cachedKey = b;
  return cachedKey;
}

export function encryptionEnabled(): boolean {
  return getKey() !== null;
}

// 加密一个字符串字段。未配密钥则原样返回（明文）。
export function encField(plain: string): string {
  const k = getKey();
  if (k === null) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

// 解密。非密文（无前缀）原样返回，兼容历史明文数据。
export function decField(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const k = getKey();
  if (k === null) throw new Error("数据为密文，但未配置 DB_ENCRYPTION_KEY，无法解密。");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// 可空字符串字段的便捷封装。
export function encOpt(s: string | null | undefined): string | null {
  return s == null ? null : encField(s);
}
export function decOpt(s: string | null | undefined): string | null {
  return s == null ? null : decField(String(s));
}
