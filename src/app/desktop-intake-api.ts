const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api";
const SESSION_KEY = "daynote_desktop_intake_session";

export interface IntakeSession { token: string; expiresAt: string }
export interface DesktopPairingSession {
  id: string; desktopSecret: string; pairingUri: string; deviceLabel: string; expiresAt: string;
}
export interface UploadSession { fileId: string; uploadId: string; chunkSize: number; chunkCount: number }

export function loadIntakeSession(): IntakeSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as IntakeSession | null;
    if (!value?.token || new Date(value.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function saveIntakeSession(session: IntakeSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
export function clearIntakeSession(): void { sessionStorage.removeItem(SESSION_KEY) }

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok && response.status !== 202) throw new Error(body?.error || `请求失败 (${response.status})`);
  return body as T;
}

export async function createPairing(deviceLabel: string): Promise<DesktopPairingSession> {
  return readResponse(await fetch(`${API_BASE}/auth/desktop-sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceLabel }),
  }));
}

export async function claimPairing(id: string, desktopSecret: string): Promise<{
  status: "waiting" | "complete"; token?: string; expiresAt?: string;
}> {
  return readResponse(await fetch(`${API_BASE}/auth/desktop-sessions/${encodeURIComponent(id)}/claim`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desktopSecret }),
  }));
}

async function intakeRequest<T>(token: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body instanceof Blob ? {} : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
    clearIntakeSession();
    throw new Error("本次投递会话已失效，请重新扫码");
  }
  if (response.status === 204) return undefined as T;
  return readResponse<T>(response);
}

export function createSubmission(token: string, input: {
  instruction: string; pastedText: string; expectedFileCount: number; idempotencyKey: string;
}): Promise<{ id: string; expectedItemCount: number }> {
  return intakeRequest(token, "/desktop/submissions", { method: "POST", body: JSON.stringify(input) });
}

export function createUpload(token: string, submissionId: string, input: {
  fileName: string; mimeType: string; totalBytes: number;
}): Promise<UploadSession> {
  return intakeRequest(token, `/desktop/submissions/${encodeURIComponent(submissionId)}/uploads`, {
    method: "POST", body: JSON.stringify(input),
  });
}

export function uploadChunk(
  token: string, submissionId: string, uploadId: string, index: number, content: Blob,
): Promise<void> {
  return intakeRequest(token, `/desktop/submissions/${encodeURIComponent(submissionId)}/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
    method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: content,
  });
}

export function completeUpload(token: string, submissionId: string, uploadId: string): Promise<void> {
  return intakeRequest(token, `/desktop/submissions/${encodeURIComponent(submissionId)}/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: "POST", body: JSON.stringify({}),
  });
}

export function commitSubmission(token: string, submissionId: string): Promise<{
  id: string; taskId: string; message: string;
}> {
  return intakeRequest(token, `/desktop/submissions/${encodeURIComponent(submissionId)}/commit`, {
    method: "POST", body: JSON.stringify({}),
  });
}
