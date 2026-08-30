import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  CalendarDays,
  CheckCircle2,
  FileArchive,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Upload,
  WalletCards,
} from "lucide-react";

import * as api from "./api";

const CATEGORY_COLORS: Record<string, string> = {
  餐饮外卖: "#d97706",
  交通出行: "#4f6ef7",
  医疗健康: "#dc2626",
  生活缴费: "#0891b2",
  旅行住宿: "#0f766e",
  日用商超: "#16a34a",
  服饰运动: "#65a30d",
  个人护理: "#c026d3",
  教育学习: "#7c3aed",
  娱乐休闲: "#ea580c",
  数码订阅: "#2563eb",
  网络购物: "#db2777",
  资金往来: "#64748b",
  其他消费: "#8a8680",
};

function money(value: number): string {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  const date = value.slice(0, 10);
  return `${date.slice(0, 4)}.${date.slice(5, 7)}.${date.slice(8, 10)}`;
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-");
  return `${year.slice(2)}年${Number(month)}月`;
}

function MetricCard({ label, value, hint, color }: {
  label: string;
  value: string;
  hint: string;
  color: string;
}) {
  return (
    <div className="rounded-xl p-3" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}>
      <p className="text-[10px]" style={{ color: "#8a8680" }}>{label}</p>
      <p className="text-base font-mono font-semibold mt-1" style={{ color }}>{value}</p>
      <p className="text-[9px] mt-0.5" style={{ color: "#aaa59d" }}>{hint}</p>
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-20 rounded-xl skeleton-pulse" style={{ background: "#ece9e3" }} />
        ))}
      </div>
      <div className="h-44 rounded-xl skeleton-pulse" style={{ background: "#ece9e3" }} />
    </div>
  );
}

export default function FinanceDashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [months, setMonths] = useState(3);
  const [overview, setOverview] = useState<api.FinanceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function load(nextMonths = months) {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.getFinanceOverview(nextMonths));
    } catch (loadError) {
      if (loadError instanceof api.UnauthorizedError) onUnauthorized();
      else setError("消费数据加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(months);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!/\.(zip|csv)$/i.test(file.name)) {
      setError("请选择支付宝导出的 ZIP 或 CSV 账单");
      return;
    }
    setUploading(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.importFinanceFile(file);
      setMessage(result.alreadyImported
        ? "这份账单已经导入过，没有产生重复记录"
        : `已归档 ${result.rowCount} 条：新增 ${result.insertedCount} 条，更新 ${result.updatedCount} 条，重叠 ${result.duplicateCount} 条`);
      await load(months);
    } catch (uploadError) {
      if (uploadError instanceof api.UnauthorizedError) onUnauthorized();
      else setError(uploadError instanceof Error ? uploadError.message : "账单导入失败");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const hasData = Boolean(overview?.summary.paymentCount || overview?.imports.length);
  const maxMonth = Math.max(...(overview?.monthlyTrend.map((item) => item.amount) || [0]), 1);

  return (
    <div className="space-y-3 pb-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold" style={{ color: "#1a1a1e" }}>消费分析</p>
          <p className="text-[10px] mt-0.5" style={{ color: "#8a8680" }}>
            {hasData
              ? `${shortDate(overview?.periodStart || null)} — ${shortDate(overview?.periodEnd || null)}`
              : "支付宝账单按账号独立归档"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium"
          style={{ background: "#d97706", color: "#ffffff", opacity: uploading ? 0.65 : 1 }}
        >
          {uploading ? <RefreshCw size={12} className="animate-spin" /> : <Upload size={12} />}
          {uploading ? "导入中" : "导入账单"}
        </button>
        <input
          ref={fileInput}
          className="hidden"
          type="file"
          accept=".zip,.csv,application/zip,text/csv"
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
      </div>

      {message && (
        <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-[11px]" style={{ background: "#ecfdf5", color: "#047857" }}>
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
          <span>{message}</span>
        </div>
      )}
      {error && (
        <div className="rounded-xl px-3 py-2.5 text-[11px]" style={{ background: "#fef2f2", color: "#dc2626" }}>{error}</div>
      )}

      <div className="flex gap-1 p-1 rounded-full" style={{ background: "#ede9e1" }}>
        {[3, 6, 12].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setMonths(value)}
            className="flex-1 py-1.5 rounded-full text-[10px] font-medium transition-all"
            style={{
              background: months === value ? "#1a1a1e" : "transparent",
              color: months === value ? "#ffffff" : "#8a8680",
            }}
          >
            近 {value} 个月
          </button>
        ))}
      </div>

      {loading ? <LoadingCards /> : !hasData ? (
        <div className="rounded-2xl p-5 text-center" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}>
          <div className="w-11 h-11 mx-auto rounded-full flex items-center justify-center" style={{ background: "#fff7ed", color: "#d97706" }}>
            <FileArchive size={20} />
          </div>
          <p className="text-sm font-medium mt-3" style={{ color: "#1a1a1e" }}>还没有账单数据</p>
          <p className="text-[11px] leading-relaxed mt-1" style={{ color: "#8a8680" }}>
            上传支付宝电脑端导出的 ZIP 或 CSV。重复月份可以放心上传，系统会按交易号更新，不会重复累计。
          </p>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="mt-4 rounded-full px-4 py-2 text-[11px] font-medium"
            style={{ background: "#d97706", color: "#ffffff" }}
          >
            选择账单文件
          </button>
        </div>
      ) : overview && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="净支出" value={`¥${money(overview.summary.netExpense)}`} hint={`${overview.summary.paymentCount} 笔成功支付`} color="#d97706" />
            <MetricCard label="已退款" value={`¥${money(overview.summary.refunds)}`} hint={`原支出 ¥${money(overview.summary.grossExpense)}`} color="#16a34a" />
            <MetricCard label="平均每笔" value={`¥${money(overview.summary.averagePayment)}`} hint={`${overview.summary.activeDays} 个消费日`} color="#4f6ef7" />
            <MetricCard label="资金往来" value={`¥${money(overview.summary.transfersOut)}`} hint="已从消费分析中剔除" color="#7c3aed" />
          </div>

          <section className="rounded-xl p-3.5" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <ShoppingBag size={13} style={{ color: "#d97706" }} />
                <span className="text-[11px] font-medium" style={{ color: "#1a1a1e" }}>消费领域占比</span>
              </div>
              <span className="text-[9px]" style={{ color: "#aaa59d" }}>按退款后净额</span>
            </div>
            <div className="space-y-2.5">
              {overview.categories.slice(0, 8).map((item) => (
                <div key={item.category}>
                  <div className="flex justify-between gap-2 mb-1">
                    <span className="text-[10px]" style={{ color: "#5a5650" }}>{item.category} · {item.count}笔</span>
                    <span className="text-[10px] font-mono" style={{ color: "#1a1a1e" }}>
                      {(item.share * 100).toFixed(0)}% · ¥{money(item.amount)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "#ede9e1" }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(2, item.share * 100)}%`, background: CATEGORY_COLORS[item.category] || "#8a8680" }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl p-3.5" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}>
            <div className="flex items-center gap-1.5 mb-3">
              <CalendarDays size={13} style={{ color: "#4f6ef7" }} />
              <span className="text-[11px] font-medium" style={{ color: "#1a1a1e" }}>月度净支出</span>
            </div>
            <div className="flex items-end gap-2 h-28">
              {overview.monthlyTrend.map((item) => (
                <div key={item.month} className="flex-1 h-full flex flex-col justify-end items-center min-w-0">
                  <span className="text-[9px] font-mono mb-1" style={{ color: "#5a5650" }}>¥{Math.round(item.amount)}</span>
                  <div
                    className="w-full max-w-[54px] rounded-t-md"
                    style={{ height: `${Math.max(6, (item.amount / maxMonth) * 78)}px`, background: "#4f6ef7" }}
                  />
                  <span className="text-[9px] mt-1.5 truncate" style={{ color: "#8a8680" }}>{monthLabel(item.month)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl p-3.5" style={{ background: "#fff7ed", border: "1px solid #fed7aa" }}>
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles size={13} style={{ color: "#d97706" }} />
              <span className="text-[11px] font-medium" style={{ color: "#9a3412" }}>从账单里看到的规律</span>
            </div>
            <div className="space-y-2">
              {overview.insights.map((insight, index) => (
                <div key={insight} className="flex items-start gap-2">
                  <span className="text-[9px] font-mono mt-0.5" style={{ color: "#d97706" }}>{String(index + 1).padStart(2, "0")}</span>
                  <p className="text-[11px] leading-relaxed" style={{ color: "#7c2d12" }}>{insight}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl p-3.5" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.07)" }}>
            <div className="flex items-center gap-1.5 mb-2.5">
              <WalletCards size={13} style={{ color: "#16a34a" }} />
              <span className="text-[11px] font-medium" style={{ color: "#1a1a1e" }}>主要交易对方</span>
            </div>
            <div className="space-y-2">
              {overview.topCounterparties.slice(0, 6).map((item, index) => (
                <div key={item.name} className="flex items-center gap-2">
                  <span className="text-[9px] font-mono w-4" style={{ color: "#aaa59d" }}>{index + 1}</span>
                  <span className="text-[10px] flex-1 truncate" style={{ color: "#5a5650" }}>{item.name}</span>
                  <span className="text-[9px]" style={{ color: "#8a8680" }}>{item.count}笔</span>
                  <span className="text-[10px] font-mono w-20 text-right" style={{ color: "#1a1a1e" }}>¥{money(item.amount)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl p-3" style={{ background: "#ede9e1" }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <FileArchive size={14} style={{ color: "#8a8680" }} />
                <div className="min-w-0">
                  <p className="text-[10px] font-medium" style={{ color: "#5a5650" }}>增量归档已开启</p>
                  <p className="text-[9px] truncate" style={{ color: "#8a8680" }}>
                    {overview.imports.length} 个文件 · 最近导入 {overview.imports[0] ? shortDate(overview.imports[0].importedAt) : "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 text-[9px]" style={{ color: "#16a34a" }}>
                <RotateCcw size={11} />
                重叠自动去重
              </div>
            </div>
          </section>

          <div className="rounded-xl px-3 py-2.5 flex items-start gap-2" style={{ background: "#eff6ff", color: "#1d4ed8" }}>
            <ArrowDownLeft size={14} className="mt-0.5 flex-shrink-0" />
            <p className="text-[10px] leading-relaxed">收入、还款和可识别的转账/小荷包归集不会混进消费占比；退款按原交易冲减净支出。</p>
          </div>
        </>
      )}
    </div>
  );
}
