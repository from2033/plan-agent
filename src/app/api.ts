// 后端 API 封装。所有请求带 Authorization: Bearer <token>。

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api";
const TOKEN_KEY = "pa_access_token";

export type EntryType = "activity" | "expense" | "memo";

export interface Entry {
  id: string;
  type: EntryType;
  raw: string;
  time: string;
  timeRange?: { start: string; end: string };
  description: string;
  category: string;
  amount?: number;
  currency?: string;
  priority?: "low" | "medium" | "high";
  done?: boolean;
  timestamp: string; // ISO 字符串（前端再转 Date）
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class UnauthorizedError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) throw new UnauthorizedError("未授权");
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function getEntries(): Promise<Entry[]> {
  return request<Entry[]>("/entries");
}

export async function addEntry(raw: string): Promise<Entry> {
  const data = await request<{ entry: Entry; via: string }>("/entries", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
  return data.entry;
}

export function toggleDone(id: string, done: boolean): Promise<Entry> {
  return request<Entry>(`/entries/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ done }),
  });
}

export function deleteEntry(id: string): Promise<void> {
  return request<void>(`/entries/${id}`, { method: "DELETE" });
}

// 上传录音（WAV）做语音识别，返回识别文本。
export async function transcribe(audio: Blob): Promise<string> {
  const res = await fetch(`${API_BASE}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${getToken()}`,
    },
    body: audio,
  });
  if (res.status === 401) throw new UnauthorizedError("未授权");
  if (!res.ok) throw new Error(`语音识别失败 (${res.status})`);
  const data = (await res.json()) as { text: string };
  return data.text || "";
}
