import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";

// 恒定时间比较，避免计时攻击。
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!ACCESS_TOKEN) {
    res.status(500).json({ error: "服务器未配置 ACCESS_TOKEN" });
    return;
  }
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, ACCESS_TOKEN)) {
    res.status(401).json({ error: "未授权" });
    return;
  }
  next();
}
