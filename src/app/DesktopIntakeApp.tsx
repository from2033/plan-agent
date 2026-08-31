import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  CheckCircle2, FileText, FolderOpen, LoaderCircle, Plus, RefreshCw,
  ShieldCheck, Trash2, UploadCloud, XCircle,
} from "lucide-react";
import * as intake from "./desktop-intake-api";
import "../styles/desktop-intake.css";

const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "jpg", "jpeg", "png", "heic", "heif", "wav"]);
type FileState = {
  key: string; file: File; displayName: string;
  status: "ready" | "uploading" | "complete" | "failed";
  progress: number; error?: string;
};

function desktopDeviceLabel(): string {
  const ua = navigator.userAgent;
  const system = /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "电脑";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "浏览器";
  return `${system} · ${browser}`;
}
function fileName(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}
function fileMime(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain", md: "text/markdown", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    heic: "image/heic", heif: "image/heif", wav: "audio/wav" } as Record<string, string>)[extension] || "application/octet-stream";
}
function fileError(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) return "不支持这种文件类型";
  if (file.size <= 0) return "文件内容为空";
  if (file.size > MAX_FILE_BYTES) return "单个文件不能超过 1GB";
  return null;
}
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function Pairing({ onReady }: { onReady: (session: intake.IntakeSession) => void }) {
  const [pairing, setPairing] = useState<intake.DesktopPairingSession | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [seconds, setSeconds] = useState(90);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let countdownTimer: number | undefined;
    setPairing(null); setQrImage(""); setError("");
    void (async () => {
      try {
        const created = await intake.createPairing(desktopDeviceLabel());
        const qr = await QRCode.toDataURL(created.pairingUri, { width: 292, margin: 1, errorCorrectionLevel: "M" });
        if (stopped) return;
        setPairing(created); setQrImage(qr);
        const update = () => {
          const left = Math.max(0, Math.ceil((new Date(created.expiresAt).getTime() - Date.now()) / 1000));
          setSeconds(left);
          if (!left) setError("二维码已过期，请重新生成");
        };
        update(); countdownTimer = window.setInterval(update, 1000);
        const poll = async () => {
          if (stopped || Date.now() >= new Date(created.expiresAt).getTime()) return;
          try {
            const claimed = await intake.claimPairing(created.id, created.desktopSecret);
            if (claimed.status === "complete" && claimed.token && claimed.expiresAt) {
              const session = { token: claimed.token, expiresAt: claimed.expiresAt };
              intake.saveIntakeSession(session); onReadyRef.current(session); return;
            }
            pollTimer = window.setTimeout(poll, 1400);
          } catch (caught) { if (!stopped) setError(caught instanceof Error ? caught.message : "配对失败"); }
        };
        pollTimer = window.setTimeout(poll, 700);
      } catch (caught) { if (!stopped) setError(caught instanceof Error ? caught.message : "暂时无法生成二维码"); }
    })();
    return () => {
      stopped = true;
      if (pollTimer) window.clearTimeout(pollTimer);
      if (countdownTimer) window.clearInterval(countdownTimer);
    };
  }, [refreshKey]);

  return <main className="intake-shell pairing-shell"><section className="pairing-card">
    <div className="brand-mark"><UploadCloud size={23} /></div>
    <p className="eyebrow">DAYNOTE · 电脑资料投递</p><h1>用手机扫码，开始本次投递</h1>
    <p className="subtle">扫码只授权上传这一次资料，不会登录网页版，也不能查看你的其他数据。</p>
    <div className="qr-frame">{qrImage && !error ? <img src={qrImage} alt="使用 Daynote 手机 App 扫码" /> : error
      ? <div className="qr-error"><XCircle size={34} /><span>{error}</span></div> : <LoaderCircle className="spin" size={30} />}</div>
    <p className="countdown">{pairing && !error ? `${seconds} 秒后失效 · ${pairing.deviceLabel}` : "正在建立一次性安全连接…"}</p>
    {error && <button className="secondary-button" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={16} />重新生成</button>}
    <div className="security-note"><ShieldCheck size={18} /><span>提交或超时后，电脑凭证立即失效。</span></div>
  </section></main>;
}

function IntakeForm({ session, onExpired }: { session: intake.IntakeSession; onExpired: () => void }) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [batchStarted, setBatchStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const submissionIdRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const ready = useMemo(() => files.length > 0 || pastedText.trim().length > 0, [files.length, pastedText]);

  function addFiles(selected: FileList | File[]) {
    if (batchStarted) return;
    setFiles((current) => {
      const keys = new Set(current.map((item) => item.key));
      const next = [...current];
      for (const file of Array.from(selected)) {
        const displayName = fileName(file); const key = `${displayName}:${file.size}:${file.lastModified}`;
        if (keys.has(key)) continue;
        const validation = fileError(file);
        next.push({ key, file, displayName, status: validation ? "failed" : "ready", progress: 0, error: validation || undefined });
        keys.add(key);
      }
      return next;
    });
  }
  function updateFile(key: string, change: Partial<FileState>) {
    setFiles((current) => current.map((item) => item.key === key ? { ...item, ...change } : item));
  }
  async function uploadOne(submissionId: string, item: FileState) {
    updateFile(item.key, { status: "uploading", progress: 0, error: undefined });
    try {
      const upload = await intake.createUpload(session.token, submissionId, {
        fileName: item.displayName, mimeType: fileMime(item.file), totalBytes: item.file.size,
      });
      for (let index = 0; index < upload.chunkCount; index += 1) {
        const start = index * upload.chunkSize;
        await intake.uploadChunk(session.token, submissionId, upload.uploadId, index,
          item.file.slice(start, Math.min(start + upload.chunkSize, item.file.size)));
        updateFile(item.key, { progress: Math.round(((index + 1) / upload.chunkCount) * 94) });
      }
      await intake.completeUpload(session.token, submissionId, upload.uploadId);
      updateFile(item.key, { status: "complete", progress: 100 });
    } catch (caught) {
      updateFile(item.key, { status: "failed", error: caught instanceof Error ? caught.message : "上传失败，请重试" });
      throw caught;
    }
  }
  async function submit() {
    if (!ready || submitting) return;
    const invalid = files.find((item) => fileError(item.file));
    if (invalid) { setError(`请先移除无法上传的文件：${invalid.displayName}`); return; }
    setSubmitting(true); setError("");
    try {
      if (!submissionIdRef.current) {
        const submission = await intake.createSubmission(session.token, {
          instruction: instruction.trim(), pastedText: pastedText.trim(), expectedFileCount: files.length,
          idempotencyKey: idempotencyKeyRef.current,
        });
        submissionIdRef.current = submission.id;
        setBatchStarted(true);
      }
      for (const item of files.filter((candidate) => candidate.status !== "complete")) {
        await uploadOne(submissionIdRef.current, item);
      }
      await intake.commitSubmission(session.token, submissionIdRef.current);
      intake.clearIntakeSession(); setDone(true);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "投递失败，请重试";
      setError(message); if (message.includes("失效")) onExpired();
    } finally { setSubmitting(false); }
  }

  if (done) return <main className="intake-shell done-shell"><section className="done-card">
    <div className="done-icon"><CheckCircle2 size={45} /></div><p className="eyebrow">投递完成</p><h1>已交给 Agent</h1>
    <p>电脑页面不会展示资料内容或处理结果。你现在可以关闭网页，后续进度、确认、结果和失败反馈都在手机 Daynote 中查看。</p>
    <button className="primary-button" onClick={() => window.close()}>关闭网页</button>
  </section></main>;

  return <main className="intake-shell form-shell">
    <header className="intake-header"><div><p className="eyebrow">DAYNOTE · 电脑资料投递</p><h1>把电脑上的资料交给 Agent</h1>
      <p className="subtle">上传完成后即可关掉网页，手机会接收处理结果和需要确认的动作。</p></div>
      <div className="session-pill"><ShieldCheck size={16} />仅本次投递</div></header>
    <section className="intake-grid"><div className="intake-main">
      <div className={`drop-zone ${dragging ? "is-dragging" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
        <UploadCloud size={34} /><h2>拖入文件或文件夹</h2><p>支持 PDF、Word、文本、Markdown、图片和 WAV，单文件最大 1GB。</p>
        <div className="pick-buttons"><button disabled={batchStarted} className="secondary-button" onClick={() => fileInput.current?.click()}><Plus size={16} />选择文件</button>
          <button disabled={batchStarted} className="secondary-button" onClick={() => folderInput.current?.click()}><FolderOpen size={16} />选择文件夹</button></div>
        <input ref={fileInput} hidden type="file" multiple accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.heic,.heif,.wav" onChange={(event) => event.target.files && addFiles(event.target.files)} />
        <input ref={folderInput} hidden type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(event) => event.target.files && addFiles(event.target.files)} />
      </div>
      {files.length > 0 && <div className="file-list"><div className="section-heading"><span>文件</span><small>{files.length} 项</small></div>
        {files.map((item) => <div className="file-row" key={item.key}><div className="file-icon"><FileText size={18} /></div>
          <div className="file-info"><strong>{item.displayName}</strong><span>{formatBytes(item.file.size)}{item.error ? ` · ${item.error}` : ""}</span>
            {item.status === "uploading" && <div className="progress"><i style={{ width: `${item.progress}%` }} /></div>}</div>
          <div className={`file-status ${item.status}`}>{item.status === "uploading" ? `${item.progress}%` : item.status === "complete" ? "已上传" : item.status === "failed" ? "需处理" : "待上传"}</div>
          {!batchStarted && <button className="icon-button" aria-label="移除文件" onClick={() => setFiles((current) => current.filter((file) => file.key !== item.key))}><Trash2 size={16} /></button>}</div>)}</div>}
      <label className="field-block"><span>也可以粘贴长文本</span><textarea disabled={batchStarted} rows={7} value={pastedText} onChange={(event) => setPastedText(event.target.value)} placeholder="例如会议记录、聊天内容、网页正文……" maxLength={2_000_000} /></label>
    </div><aside className="intake-aside">
      <label className="field-block"><span>希望 Agent 怎么处理？ <small>可选</small></span><textarea disabled={batchStarted} rows={8} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：整理关键结论，识别后续待办，并把需要我确认的动作发到手机。" maxLength={100_000} /></label>
      <div className="auto-note"><strong>留空也可以</strong><p>Agent 会自动识别资料类型、生成摘要、归档并推断后续动作。外部或敏感操作仍会在手机上请求确认。</p></div>
      {error && <div className="submit-error"><XCircle size={17} />{error}</div>}
      <button className="primary-button submit-button" disabled={!ready || submitting} onClick={submit}>{submitting
        ? <><LoaderCircle className="spin" size={18} />正在安全投递…</> : <><UploadCloud size={18} />交给 Agent</>}</button>
      <p className="submit-footnote">投递开始后请保持页面打开，直到所有文件上传完成。</p>
    </aside></section>
  </main>;
}

export default function DesktopIntakeApp() {
  const [session, setSession] = useState<intake.IntakeSession | null>(() => intake.loadIntakeSession());
  return session ? <IntakeForm session={session} onExpired={() => setSession(null)} /> : <Pairing onReady={setSession} />;
}
