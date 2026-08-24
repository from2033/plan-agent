import { useMemo, useState } from "react";
import { Brain, Camera, Check, ChevronDown, Plus, RotateCcw, Trash2, X } from "lucide-react";

import type { Mistake, MistakeInput, ReviewResult } from "./api";

interface Props {
  mistakes: Mistake[];
  onCreate: (input: MistakeInput, photo: File | null) => Promise<void>;
  onReview: (id: string, result: ReviewResult) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const masteryLabel = { learning: "待巩固", review: "需复习", mastered: "已掌握" } as const;
const subjects = ["数学", "语文", "英语", "物理", "化学", "生物", "地理", "历史", "其他"];
const errorTypes = ["概念不清", "审题错误", "计算失误", "方法不熟", "其他"];

const emptyForm: MistakeInput = {
  childName: "",
  subject: "数学",
  grade: "",
  knowledgePoint: "",
  problem: "",
  wrongAnswer: "",
  correctAnswer: "",
  explanation: "",
  errorType: "审题错误",
};

export default function MistakeBook({ mistakes, onCreate, onReview, onDelete }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<MistakeInput>(emptyForm);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [childFilter, setChildFilter] = useState("全部");
  const [subjectFilter, setSubjectFilter] = useState("全部");

  const children = useMemo(
    () => [...new Set(mistakes.map((item) => item.childName))].sort(),
    [mistakes],
  );
  const usedSubjects = useMemo(
    () => [...new Set(mistakes.map((item) => item.subject))].sort(),
    [mistakes],
  );
  const visible = mistakes.filter((item) =>
    (childFilter === "全部" || item.childName === childFilter)
    && (subjectFilter === "全部" || item.subject === subjectFilter));
  const pending = mistakes.filter((item) => item.mastery !== "mastered").length;

  function field<K extends keyof MistakeInput>(key: K, value: MistakeInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.childName.trim() || (!form.problem.trim() && !photo)) return;
    setSaving(true);
    try {
      await onCreate({ ...form, problem: form.problem.trim() || "原题见关联图片" }, photo);
      setForm({ ...emptyForm, childName: form.childName, subject: form.subject, grade: form.grade });
      setPhoto(null);
      setShowForm(false);
    } catch {
      // The parent displays the API error while keeping the form contents intact.
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "w-full rounded-lg px-3 py-2 text-xs outline-none";
  const inputStyle = { background: "#fff", border: "1px solid rgba(0,0,0,.1)", color: "#1a1a1e" };

  return (
    <div className="space-y-2 pb-3">
      <div className="rounded-xl p-3.5" style={{ background: "#fff7ed", border: "1px solid #fed7aa" }}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold" style={{ color: "#9a3412" }}>家庭错题本</p>
            <p className="text-[10px] mt-0.5" style={{ color: "#c2410c" }}>
              {mistakes.length} 道错题 · {pending} 道待巩固
            </p>
          </div>
          <button
            onClick={() => setShowForm((value) => !value)}
            className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-medium"
            style={{ background: "#d97706", color: "#fff" }}
          >
            {showForm ? <X size={12} /> : <Plus size={12} />}{showForm ? "取消" : "录入错题"}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={submit} className="rounded-xl p-3.5 space-y-2" style={{ background: "#fff", border: "1px solid rgba(0,0,0,.08)" }}>
          <div className="grid grid-cols-2 gap-2">
            <input required value={form.childName} onChange={(e) => field("childName", e.target.value)} placeholder="孩子姓名/昵称 *" className={inputClass} style={inputStyle} />
            <input value={form.grade} onChange={(e) => field("grade", e.target.value)} placeholder="年级，如三年级" className={inputClass} style={inputStyle} />
            <select value={form.subject} onChange={(e) => field("subject", e.target.value)} className={inputClass} style={inputStyle}>
              {subjects.map((subject) => <option key={subject}>{subject}</option>)}
            </select>
            <input value={form.knowledgePoint} onChange={(e) => field("knowledgePoint", e.target.value)} placeholder="知识点，如分数加减" className={inputClass} style={inputStyle} />
          </div>
          <textarea value={form.problem} onChange={(e) => field("problem", e.target.value)} placeholder="题目文字或简述（有图片时可稍后补充）" rows={3} className={inputClass} style={inputStyle} />
          <label className="flex items-center justify-center gap-2 rounded-lg py-2 text-[11px] cursor-pointer" style={{ background: "#f5f4f0", color: "#8a5a24", border: "1px dashed #d6b98c" }}>
            <Camera size={14} />
            {photo ? photo.name : "拍照或选择原题图片（将进入知识库 OCR）"}
            <input type="file" accept="image/jpeg,image/png,image/heic,image/heif" capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <textarea value={form.wrongAnswer} onChange={(e) => field("wrongAnswer", e.target.value)} placeholder="孩子的错误答案" rows={2} className={inputClass} style={inputStyle} />
            <textarea value={form.correctAnswer} onChange={(e) => field("correctAnswer", e.target.value)} placeholder="正确答案" rows={2} className={inputClass} style={inputStyle} />
          </div>
          <textarea value={form.explanation} onChange={(e) => field("explanation", e.target.value)} placeholder="解题步骤或家长说明" rows={2} className={inputClass} style={inputStyle} />
          <div className="flex gap-2">
            <select value={form.errorType} onChange={(e) => field("errorType", e.target.value)} className={`${inputClass} flex-1`} style={inputStyle}>
              {errorTypes.map((type) => <option key={type}>{type}</option>)}
            </select>
            <button disabled={saving || !form.childName.trim() || (!form.problem.trim() && !photo)} className="rounded-lg px-4 text-xs font-medium disabled:opacity-50" style={{ background: "#d97706", color: "#fff" }}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      )}

      {mistakes.length > 0 && (
        <div className="flex gap-2 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          <select value={childFilter} onChange={(e) => setChildFilter(e.target.value)} className="rounded-full px-3 py-1.5 text-[10px] outline-none" style={{ background: "#ede9e1", color: "#6b6259" }}>
            <option>全部</option>{children.map((child) => <option key={child}>{child}</option>)}
          </select>
          <select value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)} className="rounded-full px-3 py-1.5 text-[10px] outline-none" style={{ background: "#ede9e1", color: "#6b6259" }}>
            <option>全部</option>{usedSubjects.map((subject) => <option key={subject}>{subject}</option>)}
          </select>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 gap-2">
          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "#ede9e1" }}><Brain size={18} style={{ color: "#8a8680" }} /></div>
          <p className="text-xs text-center px-8" style={{ color: "#8a8680" }}>拍下原题并记录错误原因，复习后标记掌握情况。</p>
        </div>
      ) : visible.map((item) => {
        const open = expanded === item.id;
        return (
          <div key={item.id} className="rounded-xl p-3.5" style={{ background: "#fff", border: "1px solid rgba(0,0,0,.07)" }}>
            <button onClick={() => setExpanded(open ? null : item.id)} className="w-full text-left">
              <div className="flex items-start gap-2">
                <div className="rounded-lg px-2 py-1 text-[10px] font-medium flex-shrink-0" style={{ background: item.mastery === "mastered" ? "#dcfce7" : "#ffedd5", color: item.mastery === "mastered" ? "#15803d" : "#c2410c" }}>{masteryLabel[item.mastery]}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px]" style={{ color: "#8a8680" }}>{item.childName} · {item.grade || "未填年级"} · {item.subject}{item.knowledgePoint ? ` · ${item.knowledgePoint}` : ""}</p>
                  <p className="text-xs mt-1 line-clamp-2" style={{ color: "#1a1a1e" }}>{item.problem}</p>
                </div>
                <ChevronDown size={14} style={{ color: "#aaa49a", transform: open ? "rotate(180deg)" : undefined }} />
              </div>
            </button>
            {open && (
              <div className="mt-3 pt-3 space-y-2 text-[11px]" style={{ borderTop: "1px solid #eeeae3" }}>
                {item.documentId && <p style={{ color: "#8a5a24" }}><Camera size={11} className="inline mr-1" />原题图片已关联知识库并进行 OCR 归档</p>}
                {item.wrongAnswer && <p><span style={{ color: "#a1a1aa" }}>错误答案：</span>{item.wrongAnswer}</p>}
                {item.correctAnswer && <p><span style={{ color: "#a1a1aa" }}>正确答案：</span>{item.correctAnswer}</p>}
                {item.explanation && <p><span style={{ color: "#a1a1aa" }}>解题说明：</span>{item.explanation}</p>}
                <p style={{ color: "#8a8680" }}>错误原因：{item.errorType} · 已复习 {item.reviewCount} 次</p>
                <div className="flex items-center gap-1.5 pt-1">
                  <button onClick={() => onReview(item.id, "again")} className="flex items-center gap-1 rounded-full px-2.5 py-1" style={{ background: "#fee2e2", color: "#b91c1c" }}><RotateCcw size={10} />还不会</button>
                  <button onClick={() => onReview(item.id, "hard")} className="rounded-full px-2.5 py-1" style={{ background: "#ffedd5", color: "#c2410c" }}>有点难</button>
                  <button onClick={() => onReview(item.id, "good")} className="flex items-center gap-1 rounded-full px-2.5 py-1" style={{ background: "#dcfce7", color: "#15803d" }}><Check size={10} />已掌握</button>
                  <button onClick={() => { if (window.confirm("删除这道错题？")) onDelete(item.id); }} className="ml-auto p-1.5" aria-label="删除错题"><Trash2 size={12} style={{ color: "#b5b0a8" }} /></button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
