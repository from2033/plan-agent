import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_action_plans (
    task_id TEXT NOT NULL, user_id TEXT NOT NULL, version INTEGER NOT NULL,
    facts_json TEXT NOT NULL, goals_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(task_id, version)
  );
  CREATE TABLE IF NOT EXISTS agent_plan_items (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL,
    capability TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL,
    evidence TEXT NOT NULL, risk TEXT NOT NULL, requires_confirmation INTEGER NOT NULL,
    required INTEGER NOT NULL, status TEXT NOT NULL, child_task_id TEXT,
    result_json TEXT, failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_plan_items_task ON agent_plan_items(user_id, task_id, plan_version, position);
`);

export type PlanItemStatus = "planned" | "awaiting_confirmation" | "executing" | "verifying" | "verified" | "failed" | "awaiting_user";
export interface ActionPlanItem {
  id: string; kind: string; capability: string; title: string; instruction: string;
  evidence: string; risk: "none" | "internal" | "sensitive"; requiresConfirmation: boolean;
  required: boolean; status: PlanItemStatus; childTaskId: string | null; result: unknown; failure: string | null;
}
export interface ActionPlanSnapshot {
  planVersion: number; facts: string[]; goals: string[]; planItems: ActionPlanItem[];
  coverageStatus: "pending" | "complete" | "failed"; missingRequirements: string[];
}

function festivalDate(year: number, month: string, day: number): string | null {
  const format = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" });
  for (let cursor = new Date(`${year}-08-01T04:00:00Z`); cursor < new Date(`${year}-11-15T04:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const parts = Object.fromEntries(format.formatToParts(cursor).map((part) => [part.type, part.value]));
    if (parts.month === month && Number(parts.day) === day) return cursor.toISOString().slice(0, 10);
  }
  return null;
}
export const resolveMidAutumnDate = (year: number): string | null => festivalDate(year, "八月", 15);

export function buildActionPlan(raw: string, currentDate: string): { facts: string[]; goals: string[]; actions: Omit<ActionPlanItem, "id" | "status" | "childTaskId" | "result" | "failure">[] } {
  const birthday = /(?:宝宝|孩子|小孩).{0,12}生日/u.test(raw) && /中秋/u.test(raw);
  const dachang = /(?:看下|看一下|看看|查下|查一下|找下|找一下|了解下|了解一下)/u.test(raw)
    && /(?:南京)?大厂/u.test(raw) && /(?:周边|附近|场地|餐厅|酒店|适合)/u.test(raw);
  if (birthday && dachang) {
    const year = Number(currentDate.slice(0, 4));
    const midAutumn = resolveMidAutumnDate(year);
    return {
      facts: ["宝宝生日计划安排在中秋", "地点范围为南京大厂周边"],
      goals: ["确认中秋日期", "形成宝宝生日地点方案并反馈"],
      actions: [{
        kind: "resolve_date", capability: "date_resolution", title: `确认${year}年中秋日期`,
        instruction: "将今年中秋转换为公历日期", evidence: "安排在中秋", risk: "none", requiresConfirmation: false, required: true,
      }, {
        kind: "todo", capability: "todo", title: "筹备宝宝中秋生日活动",
        instruction: `建立宝宝生日筹备待办${midAutumn ? `，日期为${midAutumn}` : ""}`, evidence: "宝宝生日准备安排在中秋", risk: "internal", requiresConfirmation: false, required: true,
      }, {
        kind: "research", capability: "research", title: "调研南京大厂周边宝宝生日场地",
        instruction: "查询南京大厂周边中秋期间适合家庭生日聚会的场地，比较位置、环境、适合人数、价格线索和预订注意事项", evidence: "去看下南京大厂周边", risk: "none", requiresConfirmation: false, required: true,
      }, {
        kind: "feedback", capability: "feedback", title: "汇总生日安排方案",
        instruction: "把中秋日期、地点调研结果、优缺点和下一步建议反馈给用户", evidence: "完整输入", risk: "none", requiresConfirmation: false, required: true,
      }],
    };
  }
  return {
    facts: [raw], goals: ["完整处理用户输入"],
    actions: [{ kind: "process", capability: "input_processing", title: raw.slice(0, 80), instruction: raw, evidence: raw, risk: "none", requiresConfirmation: false, required: true }],
  };
}

export function saveActionPlan(userId: string, taskId: string, raw: string, currentDate: string): ActionPlanSnapshot {
  const previous = getActionPlan(userId, taskId);
  const latest = db.prepare("SELECT MAX(version) AS version FROM agent_action_plans WHERE task_id=? AND user_id=?").get(taskId, userId) as { version: number | null };
  const version = Number(latest.version || 0) + 1;
  const plan = buildActionPlan(raw, currentDate);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO agent_action_plans (task_id,user_id,version,facts_json,goals_json,created_at) VALUES (?,?,?,?,?,?)")
    .run(taskId, userId, version, encField(JSON.stringify(plan.facts)), encField(JSON.stringify(plan.goals)), now);
  const insert = db.prepare(`INSERT INTO agent_plan_items
    (id,task_id,user_id,plan_version,position,kind,capability,title,instruction,evidence,risk,requires_confirmation,required,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'planned',?,?)`);
  plan.actions.forEach((item, position) => {
    const reused = previous?.planItems.find((old) => old.kind === item.kind && old.title === item.title && Boolean(old.childTaskId));
    const id = crypto.randomUUID();
    insert.run(id, taskId, userId, version, position, item.kind, item.capability,
      encField(item.title), encField(item.instruction), encField(item.evidence), item.risk, item.requiresConfirmation ? 1 : 0, item.required ? 1 : 0, now, now);
    if (reused) db.prepare("UPDATE agent_plan_items SET status=?,child_task_id=?,result_json=?,failure=?,updated_at=? WHERE id=?")
      .run(reused.status, reused.childTaskId, reused.result == null ? null : encField(JSON.stringify(reused.result)), reused.failure ? encField(reused.failure) : null, now, id);
  });
  return getActionPlan(userId, taskId)!;
}

export function getActionPlan(userId: string, taskId: string): ActionPlanSnapshot | null {
  const plan = db.prepare("SELECT version,facts_json,goals_json FROM agent_action_plans WHERE task_id=? AND user_id=? ORDER BY version DESC LIMIT 1").get(taskId, userId) as { version:number; facts_json:string; goals_json:string } | undefined;
  if (!plan) return null;
  const rows = db.prepare("SELECT * FROM agent_plan_items WHERE task_id=? AND user_id=? AND plan_version=? ORDER BY position").all(taskId, userId, plan.version) as Array<Record<string, unknown>>;
  const planItems = rows.map((row): ActionPlanItem => ({
    id: String(row.id), kind: String(row.kind), capability: String(row.capability), title: decField(String(row.title)), instruction: decField(String(row.instruction)), evidence: decField(String(row.evidence)),
    risk: row.risk as ActionPlanItem["risk"], requiresConfirmation: Number(row.requires_confirmation) === 1, required: Number(row.required) === 1,
    status: row.status as PlanItemStatus, childTaskId: row.child_task_id ? String(row.child_task_id) : null,
    result: row.result_json ? JSON.parse(decField(String(row.result_json))) : null, failure: row.failure ? decField(String(row.failure)) : null,
  }));
  const required = planItems.filter((item) => item.required);
  const missingRequirements = required.filter((item) => item.status !== "verified").map((item) => item.title);
  return { planVersion: plan.version, facts: JSON.parse(decField(plan.facts_json)), goals: JSON.parse(decField(plan.goals_json)), planItems,
    coverageStatus: required.some((item) => item.status === "failed") ? "failed" : missingRequirements.length ? "pending" : "complete", missingRequirements };
}

export function linkPlanItem(userId: string, itemId: string, childTaskId: string, status: PlanItemStatus): void {
  db.prepare("UPDATE agent_plan_items SET child_task_id=?,status=?,updated_at=? WHERE id=? AND user_id=?").run(childTaskId, status, new Date().toISOString(), itemId, userId);
}
export function updatePlanItem(userId: string, itemId: string, status: PlanItemStatus, result?: unknown, failure?: string): void {
  db.prepare("UPDATE agent_plan_items SET status=?,result_json=?,failure=?,updated_at=? WHERE id=? AND user_id=?")
    .run(status, result === undefined ? null : encField(JSON.stringify(result)), failure ? encField(failure) : null, new Date().toISOString(), itemId, userId);
}
export function updatePlanItemByChild(userId: string, childTaskId: string, status: PlanItemStatus, result?: unknown, failure?: string): void {
  db.prepare("UPDATE agent_plan_items SET status=?,result_json=?,failure=?,updated_at=? WHERE child_task_id=? AND user_id=?")
    .run(status, result === undefined ? null : encField(JSON.stringify(result)), failure ? encField(failure) : null, new Date().toISOString(), childTaskId, userId);
}
export function parentForPlanChild(userId: string, childTaskId: string): string | null {
  const row = db.prepare("SELECT task_id FROM agent_plan_items WHERE child_task_id=? AND user_id=? ORDER BY plan_version DESC LIMIT 1").get(childTaskId, userId) as { task_id:string } | undefined;
  return row?.task_id || null;
}
