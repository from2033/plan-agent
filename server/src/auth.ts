import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { resolveEmailSession } from "./email-auth.js";
import { resolveGuestSession } from "./guest-auth.js";

// 多用户：每个用户一个 token（既是身份也是密码），数据按 userId 隔离。
// 配置来源（server/.env）：
//   ACCESS_TOKEN  —— 主用户的 token，userId = PRIMARY_USER（默认 "我"）。
//   USERS         —— 其他用户，格式 "名字:token,名字2:token2"。
// 例：PRIMARY_USER=老公  ACCESS_TOKEN=xxx  USERS=老婆:yyy
export const PRIMARY_USER = process.env.PRIMARY_USER || "我";

// 构建 token -> userId(名字) 映射。
function buildUsers(): Map<string, string> {
  const map = new Map<string, string>();
  const primary = process.env.ACCESS_TOKEN || "";
  if (primary) map.set(primary, PRIMARY_USER);
  for (const pair of (process.env.USERS || "").split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (name && token) map.set(token, name);
  }
  return map;
}

const USERS = buildUsers();

// 恒定时间比较，避免计时攻击。
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 在已配置的 token 里匹配，返回 userId，匹配不到返回 null。
export function resolveUserId(token: string): string | null {
  for (const [t, userId] of USERS) {
    if (safeEqual(token, t)) return userId;
  }
  return resolveEmailSession(token) || resolveGuestSession(token);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = token ? resolveUserId(token) : null;
  if (!userId) {
    res.status(401).json({ error: "未授权" });
    return;
  }
  req.userId = userId;
  next();
}
