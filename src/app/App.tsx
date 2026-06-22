import { useState, useRef, useEffect } from "react";
import {
  Clock,
  CreditCard,
  BookOpen,
  Mic,
  ChevronRight,
  TrendingUp,
  Calendar,
  Sparkles,
  Coffee,
  ShoppingBag,
  Utensils,
  Car,
  Home,
  Briefcase,
  Heart,
  Star,
  AlertCircle,
  CheckCircle,
  Trash2,
  BarChart2,
} from "lucide-react";
import * as api from "./api";
import { WavRecorder, recordingSupported } from "./recorder";

// ─── Types ──────────────────────────────────────────────────────────────────

type EntryType = "activity" | "expense" | "memo";

interface Entry {
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
  timestamp: Date;
}

type Tab = "today" | "ledger" | "memo";

interface SpeechRecognitionResultEventLike {
  resultIndex: number;
  results: {
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
    length: number;
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

// 自然语言解析已移到后端（server/src/parse.ts，用 Claude + 正则回退）。

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDate(d: Date): string {
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${days[d.getDay()]}`;
}

// ─── Category icons ──────────────────────────────────────────────────────────

function CategoryIcon({ cat, size = 14 }: { cat: string; size?: number }) {
  const cls = `w-[${size}px] h-[${size}px]`;
  if (cat === "餐饮" || cat === "饮食") return <Utensils size={size} />;
  if (cat === "交通") return <Car size={size} />;
  if (cat === "购物") return <ShoppingBag size={size} />;
  if (cat === "工作") return <Briefcase size={size} />;
  if (cat === "运动") return <Heart size={size} />;
  if (cat === "学习") return <BookOpen size={size} />;
  if (cat === "休息") return <Coffee size={size} />;
  if (cat === "生活") return <Home size={size} />;
  if (cat === "备忘") return <AlertCircle size={size} />;
  return <Star size={size} />;
}

const CATEGORY_COLORS: Record<string, string> = {
  工作: "#4f6ef7",
  运动: "#16a34a",
  饮食: "#d97706",
  餐饮: "#d97706",
  休息: "#7c3aed",
  学习: "#0284c7",
  生活: "#e11d48",
  社交: "#ea580c",
  日常: "#64748b",
  购物: "#db2777",
  交通: "#059669",
  娱乐: "#9333ea",
  健康: "#15803d",
  备忘: "#b45309",
  其他: "#64748b",
};

// ─── Sample seed data ────────────────────────────────────────────────────────

const today = new Date();

// ─── Daily summary generator ─────────────────────────────────────────────────

function generateSummary(entries: Entry[]): {
  highlights: string[];
  improvements: string[];
  suggestions: string[];
  totalExpense: number;
  workHours: number;
} {
  const expenses = entries.filter(e => e.type === "expense");
  const activities = entries.filter(e => e.type === "activity");
  const memos = entries.filter(e => e.type === "memo");
  const totalExpense = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  let workHours = 0;
  activities.filter(a => a.category === "工作" && a.timeRange).forEach(a => {
    const [sh, sm] = a.timeRange!.start.split(":").map(Number);
    const [eh, em] = a.timeRange!.end.split(":").map(Number);
    workHours += (eh * 60 + em - sh * 60 - sm) / 60;
  });

  const highlights: string[] = [];
  const improvements: string[] = [];
  const suggestions: string[] = [];

  const hasExercise = activities.some(a => a.category === "运动");
  if (hasExercise) highlights.push("完成了运动计划，坚持健康生活方式");
  if (workHours >= 6) highlights.push(`专注工作 ${workHours.toFixed(1)} 小时，效率不错`);
  if (expenses.length > 0) highlights.push(`今日共记录 ${expenses.length} 笔消费，合计 ¥${totalExpense}`);
  if (memos.some(m => m.done)) highlights.push("完成了待办事项");

  if (!hasExercise) improvements.push("今天没有运动记录，明天可以抽时间锻炼一下");
  if (totalExpense > 200) improvements.push(`今日花费 ¥${totalExpense}，消费偏高，注意控制预算`);
  const undone = memos.filter(m => !m.done);
  if (undone.length > 0) improvements.push(`还有 ${undone.length} 条备忘未处理`);
  if (workHours < 4 && activities.length > 0) improvements.push("工作时间较短，明天注意提升专注度");

  suggestions.push("明天可以提前规划日程，减少临时插入的事项");
  if (!hasExercise) suggestions.push("尝试晨跑或傍晚散步20分钟");
  if (totalExpense > 150) suggestions.push("考虑记录一下月度消费目标，合理分配预算");
  suggestions.push("睡前花5分钟回顾今日重点，提升记忆巩固效果");

  return { highlights, improvements, suggestions, totalExpense, workHours };
}

// ─── Components ──────────────────────────────────────────────────────────────

function EntryCard({ entry, onDelete, onToggleDone }: {
  entry: Entry;
  onDelete: (id: string) => void;
  onToggleDone?: (id: string) => void;
}) {
  const color = CATEGORY_COLORS[entry.category] || "#64748b";
  const [hovering, setHovering] = useState(false);

  return (
    <div
      className="relative group rounded-xl p-3.5 transition-all duration-200"
      style={{ background: hovering ? "#f0ede6" : "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="flex items-start gap-3">
        {/* Color bar + icon */}
        <div className="flex flex-col items-center gap-1 mt-0.5">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: color + "18", color }}
          >
            <CategoryIcon cat={entry.category} size={13} />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: color + "18", color }}
            >
              {entry.category}
            </span>
            {entry.type === "expense" && entry.amount && (
              <span className="text-xs font-mono" style={{ color: "#d97706" }}>
                ¥{entry.amount}
              </span>
            )}
            {entry.type === "memo" && entry.priority === "high" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#fee2e2", color: "#dc2626" }}>
                重要
              </span>
            )}
          </div>

          <p
            className="text-sm leading-snug"
            style={{
              color: entry.done ? "#8a8680" : "#1a1a1e",
              textDecoration: entry.done ? "line-through" : "none",
            }}
          >
            {entry.description}
          </p>

          {entry.timeRange && (
            <p className="text-[11px] font-mono mt-1" style={{ color: "#8a8680" }}>
              {entry.timeRange.start} → {entry.timeRange.end}
            </p>
          )}
        </div>

        {/* Right side */}
        <div className="flex flex-col items-end gap-1 ml-1 flex-shrink-0">
          <span className="text-[11px] font-mono" style={{ color: "#8a8680" }}>{entry.time}</span>
          <div
            className="flex gap-1 transition-opacity duration-150"
            style={{ opacity: hovering ? 1 : 0 }}
          >
            {entry.type === "memo" && (
              <button
                onClick={() => onToggleDone?.(entry.id)}
                className="p-1 rounded-md transition-colors"
                style={{ color: entry.done ? "#16a34a" : "#8a8680" }}
              >
                <CheckCircle size={13} />
              </button>
            )}
            <button
              onClick={() => onDelete(entry.id)}
              className="p-1 rounded-md transition-colors"
              style={{ color: "#8a8680" }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl p-3 flex flex-col gap-1" style={{ background: color + "15", border: `1px solid ${color}25` }}>
      <span className="text-[10px] font-mono" style={{ color: "#8a8680" }}>{label}</span>
      <span className="text-base font-semibold" style={{ color }}>{value}</span>
    </div>
  );
}

function SummaryPanel({ entries }: { entries: Entry[] }) {
  const summary = generateSummary(entries);
  const [expanded, setExpanded] = useState<"highlights" | "improvements" | "suggestions" | null>("highlights");

  return (
    <div className="space-y-3">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <StatPill label="总花费" value={`¥${summary.totalExpense}`} color="#d97706" />
        <StatPill label="工作时长" value={`${summary.workHours.toFixed(1)}h`} color="#4f6ef7" />
        <StatPill label="记录条数" value={`${entries.length}条`} color="#16a34a" />
      </div>

      {/* AI summary sections */}
      {[
        { key: "highlights" as const, label: "✦ 今日亮点", items: summary.highlights, color: "#16a34a" },
        { key: "improvements" as const, label: "◈ 待改进", items: summary.improvements, color: "#d97706" },
        { key: "suggestions" as const, label: "→ 明日建议", items: summary.suggestions, color: "#4f6ef7" },
      ].map(({ key, label, items, color }) => (
        <div
          key={key}
          className="rounded-xl overflow-hidden"
          style={{ border: "1px solid rgba(0,0,0,0.07)", background: "#ffffff" }}
        >
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left"
            onClick={() => setExpanded(expanded === key ? null : key)}
          >
            <span className="text-xs font-medium" style={{ color }}>{label}</span>
            <ChevronRight
              size={13}
              style={{
                color: "#8a8680",
                transform: expanded === key ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.2s",
              }}
            />
          </button>
          {expanded === key && (
            <div className="px-4 pb-3 space-y-2">
              {items.map((item, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-[10px] mt-0.5 font-mono" style={{ color }}>{String(i + 1).padStart(2, "0")}</span>
                  <p className="text-xs leading-relaxed" style={{ color: "#5a5650" }}>{item}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── 访问令牌录入 ─────────────────────────────────────────────────────────────

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div
      className="min-h-screen w-full flex items-center justify-center p-6"
      style={{ background: "#e8e5df", fontFamily: "'Inter', sans-serif" }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-6 space-y-4"
        style={{ background: "#f5f4f0", border: "1px solid rgba(0,0,0,0.08)" }}
      >
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "#1a1a1e" }}>我的流水账</h1>
          <p className="text-xs mt-1" style={{ color: "#8a8680" }}>请输入访问令牌以连接你的服务器</p>
        </div>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onSubmit(value.trim()); }}
          placeholder="访问令牌"
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.12)", color: "#1a1a1e" }}
        />
        <button
          onClick={() => value.trim() && onSubmit(value.trim())}
          className="w-full rounded-lg py-2 text-sm font-medium"
          style={{ background: "#4f6ef7", color: "#ffffff" }}
        >
          进入
        </button>
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [tab, setTab] = useState<Tab>("today");
  const [showSummary, setShowSummary] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [token, setTokenState] = useState<string>(api.getToken());
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  // 后台“识别+记录”的并发数（>0 表示有语音正在处理，用户无需等待）。
  const [voiceBusy, setVoiceBusy] = useState(0);
  // 最近一条语音记录，用于“撤销刚才说的话”。
  const [undo, setUndo] = useState<{ id: string; text: string } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<WavRecorder | null>(null);
  const holdingToTalkRef = useRef(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 录音是否可用（需 HTTPS 安全环境 + 麦克风 API）。
  useEffect(() => {
    setSpeechSupported(recordingSupported());
  }, []);

  // 把 API 记录（timestamp 为 ISO 字符串）转成前端用的 Date。
  const toLocal = (e: api.Entry): Entry => ({ ...e, timestamp: new Date(e.timestamp) });

  // 首次/令牌变化时从后端加载。
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getEntries();
        if (!cancelled) {
          setEntries(data.map(toLocal));
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof api.UnauthorizedError) {
          api.clearToken();
          setTokenState("");
        } else {
          setError("加载失败，请检查后端是否运行");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const todayEntries = entries.filter(e => {
    const d = e.timestamp;
    return d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear();
  }).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const activityEntries = todayEntries.filter(e => e.type === "activity");
  const expenseEntries = todayEntries.filter(e => e.type === "expense");
  const memoEntries = todayEntries.filter(e => e.type === "memo");

  // 把一条语音文本提交到后端并入库，弹出“撤销”浮条。
  async function pushEntry(text: string) {
    const created = toLocal(await api.addEntry(text));
    setEntries(prev => [...prev, created]);
    setLastAdded(created.id);
    setError(null);
    setTimeout(() => setLastAdded(null), 2000);
    setTimeout(() => {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
    }, 100);
    showUndo(created.id, created.description);
    return created;
  }

  // 显示“撤销”浮条，几秒后自动消失。
  function showUndo(id: string, text: string) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo({ id, text });
    undoTimerRef.current = setTimeout(() => setUndo(null), 6000);
  }

  // 撤销刚才那条语音记录（删除已入库的条目）。
  async function handleUndoVoice() {
    const target = undo;
    if (!target) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo(null);
    await handleDelete(target.id);
  }

  async function startVoiceInput() {
    if (!speechSupported) {
      setError("此环境不支持录音（需 HTTPS）。可用 iPhone 键盘上的 🎤 语音输入。");
      return;
    }
    if (holdingToTalkRef.current) return;
    holdingToTalkRef.current = true;
    setError(null);
    try {
      const rec = new WavRecorder();
      await rec.start();
      // 若用户在录音启动完成前已松手，则直接收尾
      if (!holdingToTalkRef.current) {
        await rec.stop();
        return;
      }
      recorderRef.current = rec;
      setIsListening(true);
    } catch {
      holdingToTalkRef.current = false;
      setIsListening(false);
      setError("无法访问麦克风，请在 Safari 设置里允许麦克风权限。");
    }
  }

  async function stopVoiceInput() {
    if (!holdingToTalkRef.current) return;
    holdingToTalkRef.current = false;
    const rec = recorderRef.current;
    recorderRef.current = null;
    setIsListening(false);
    if (!rec) return;
    // 松开即开始“识别 + 入库”，全程后台进行，用户无需等待，可继续说下一条或去做别的事。
    setVoiceBusy((n) => n + 1);
    try {
      const wav = await rec.stop();
      const text = await api.transcribe(wav);
      if (text) {
        await pushEntry(text);
      } else {
        setError("没听清，请再说一次");
      }
    } catch (err) {
      if (err instanceof api.UnauthorizedError) {
        api.clearToken();
        setTokenState("");
      } else {
        setError("语音识别失败，请重试");
      }
    } finally {
      setVoiceBusy((n) => n - 1);
    }
  }

  async function handleDelete(id: string) {
    const prev = entries;
    setEntries(p => p.filter(e => e.id !== id)); // 乐观更新
    try {
      await api.deleteEntry(id);
    } catch {
      setEntries(prev); // 失败回滚
      setError("删除失败");
    }
  }

  async function handleToggleDone(id: string) {
    const target = entries.find(e => e.id === id);
    if (!target) return;
    const next = !target.done;
    setEntries(p => p.map(e => (e.id === id ? { ...e, done: next } : e))); // 乐观更新
    try {
      await api.toggleDone(id, next);
    } catch {
      setEntries(p => p.map(e => (e.id === id ? { ...e, done: !next } : e))); // 回滚
      setError("更新失败");
    }
  }

  // 未输入访问令牌时，先显示令牌录入界面。
  if (!token) {
    return <TokenGate onSubmit={(t) => { api.setToken(t); setTokenState(t); }} />;
  }

  const totalExpense = expenseEntries.reduce((s, e) => s + (e.amount || 0), 0);

  const tabEntries = tab === "today" ? activityEntries
    : tab === "ledger" ? expenseEntries
    : memoEntries;

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center"
      style={{ background: "#e8e5df", fontFamily: "'Inter', sans-serif" }}
    >
      {/* Phone shell */}
      <div
        className="relative flex flex-col overflow-hidden"
        style={{
          width: 375,
          height: 780,
          maxHeight: "100vh",
          background: "#f5f4f0",
          borderRadius: 28,
          boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 24px 64px rgba(0,0,0,0.15)",
        }}
      >
        {/* 错误提示 */}
        {error && (
          <div
            className="absolute left-0 right-0 top-0 z-50 mx-3 mt-2 rounded-lg px-3 py-2 text-xs flex items-center justify-between"
            style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5" }}
          >
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 font-mono">✕</button>
          </div>
        )}
        {/* Status bar */}
        <div className="flex items-center justify-between px-6 pt-3 pb-1" style={{ flexShrink: 0 }}>
          <span className="text-[11px] font-mono" style={{ color: "#8a8680" }}>
            {formatDate(today)}
          </span>
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-mono" style={{ color: "#8a8680" }}>
              {formatTime(today)}
            </span>
          </div>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-1 pb-3" style={{ flexShrink: 0 }}>
          <div>
            <h1 className="text-lg font-semibold tracking-tight" style={{ color: "#1a1a1e" }}>
              我的流水账
            </h1>
            <p className="text-[11px]" style={{ color: "#8a8680" }}>
              {todayEntries.length} 条记录 · ¥{totalExpense} 花费
            </p>
          </div>
          <button
            onClick={() => setShowSummary(!showSummary)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all"
            style={{
              background: showSummary ? "#d97706" : "#ede9e1",
              color: showSummary ? "#ffffff" : "#d97706",
            }}
          >
            <Sparkles size={12} />
            <span className="text-[11px] font-medium">日报</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pb-3" style={{ flexShrink: 0 }}>
          {[
            { key: "today" as Tab, label: "行程", icon: <Clock size={11} />, count: activityEntries.length },
            { key: "ledger" as Tab, label: "账单", icon: <CreditCard size={11} />, count: expenseEntries.length },
            { key: "memo" as Tab, label: "备忘", icon: <BookOpen size={11} />, count: memoEntries.filter(m => !m.done).length },
          ].map(({ key, label, icon, count }) => (
            <button
              key={key}
              onClick={() => { setTab(key); setShowSummary(false); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all text-[11px] font-medium"
              style={{
                background: tab === key && !showSummary ? "#d97706" : "#ede9e1",
                color: tab === key && !showSummary ? "#ffffff" : "#8a8680",
              }}
            >
              {icon}
              {label}
              {count > 0 && (
                <span
                  className="text-[9px] rounded-full px-1 min-w-[14px] text-center"
                  style={{
                    background: tab === key && !showSummary ? "rgba(255,255,255,0.3)" : "#d1cdc5",
                    color: tab === key && !showSummary ? "#ffffff" : "#1a1a1e",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div
          ref={feedRef}
          className="flex-1 overflow-y-auto px-5 space-y-2 pb-4"
          style={{ scrollbarWidth: "none" }}
        >
          {showSummary ? (
            <SummaryPanel entries={todayEntries} />
          ) : (
            <>
              {tabEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "#ede9e1" }}>
                    {tab === "today" ? <Clock size={18} style={{ color: "#8a8680" }} />
                      : tab === "ledger" ? <CreditCard size={18} style={{ color: "#8a8680" }} />
                      : <BookOpen size={18} style={{ color: "#8a8680" }} />}
                  </div>
                  <p className="text-xs" style={{ color: "#8a8680" }}>
                    {tab === "today" ? "还没有行程记录" : tab === "ledger" ? "今天还没有消费记录" : "没有待办备忘"}
                  </p>
                </div>
              ) : (
                tabEntries.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      transition: "opacity 0.4s, transform 0.4s",
                      opacity: lastAdded === entry.id ? 0.6 : 1,
                    }}
                  >
                    <EntryCard
                      entry={entry}
                      onDelete={handleDelete}
                      onToggleDone={handleToggleDone}
                    />
                  </div>
                ))
              )}

              {/* Expense summary bar for ledger tab */}
              {tab === "ledger" && expenseEntries.length > 0 && (
                <div
                  className="rounded-xl p-3.5 mt-1"
                  style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[11px]" style={{ color: "#8a8680" }}>分类占比</span>
                    <span className="text-sm font-mono font-medium" style={{ color: "#d97706" }}>¥{totalExpense} 合计</span>
                  </div>
                  <div className="space-y-1.5">
                    {Object.entries(
                      expenseEntries.reduce((acc, e) => {
                        acc[e.category] = (acc[e.category] || 0) + (e.amount || 0);
                        return acc;
                      }, {} as Record<string, number>)
                    ).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                      <div key={cat} className="flex items-center gap-2">
                        <span className="text-[10px] w-10 text-right font-mono" style={{ color: "#8a8680" }}>
                          {cat}
                        </span>
                        <div className="flex-1 h-1.5 rounded-full" style={{ background: "#ede9e1" }}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${(amt / totalExpense) * 100}%`,
                              background: CATEGORY_COLORS[cat] || "#64748b",
                              transition: "width 0.5s ease",
                            }}
                          />
                        </div>
                        <span className="text-[10px] font-mono w-10" style={{ color: "#1a1a1e" }}>¥{amt}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Input area */}
        <div
          className="px-4 pb-5 pt-2"
          style={{ flexShrink: 0, borderTop: "1px solid rgba(0,0,0,0.06)" }}
        >
          {/* 撤销刚才说过的话 */}
          {undo && (
            <div
              className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 mb-2"
              style={{ background: "#1a1a1e", color: "#f5f4f0" }}
            >
              <span className="text-[11px] truncate flex-1">已记录：{undo.text}</span>
              <button
                onClick={handleUndoVoice}
                className="text-[11px] font-medium px-2 py-0.5 rounded-md flex-shrink-0"
                style={{ background: "rgba(255,255,255,0.15)", color: "#ffd9a8" }}
              >
                撤销
              </button>
            </div>
          )}
          <div className="flex justify-center py-1">
            <button
              type="button"
              disabled={!speechSupported}
              draggable={false}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                startVoiceInput();
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                stopVoiceInput();
              }}
              onPointerCancel={stopVoiceInput}
              onLostPointerCapture={stopVoiceInput}
              onKeyDown={(event) => {
                if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                  event.preventDefault();
                  startVoiceInput();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  stopVoiceInput();
                }
              }}
              onContextMenu={(event) => event.preventDefault()}
              aria-label="按住说话，松开自动记录"
              className="rounded-full flex items-center justify-center transition-transform active:scale-95"
              style={{
                width: 88,
                height: 88,
                background: isListening ? "#fee2e2" : speechSupported ? "#d97706" : "#ede9e1",
                color: isListening ? "#dc2626" : speechSupported ? "#ffffff" : "#b5b0a8",
                boxShadow: isListening
                  ? "0 0 0 8px rgba(220,38,38,0.12)"
                  : speechSupported
                    ? "0 8px 22px rgba(217,119,6,0.32)"
                    : "none",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Mic size={34} />
            </button>
          </div>
          <p
            className="text-[10px] text-center mt-2"
            style={{ color: "#b5b0a8", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
          >
            {isListening
              ? "松开即自动记录"
              : voiceBusy > 0
                ? "可继续按住说下一条"
                : speechSupported
                  ? "按住说话 · 松开直接记录 · 记录后可撤销"
                  : "录音需 HTTPS；可用手机键盘上的 🎤"}
          </p>
        </div>
      </div>
    </div>
  );
}
