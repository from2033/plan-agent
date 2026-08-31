import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";
import { capabilityStandard, verifyAgentTask, createCapabilityTask, type AgentStage } from "./agent-contract.js";
import "./agent-standards.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, capability TEXT NOT NULL,
    standard_version TEXT NOT NULL, source_type TEXT, source_id TEXT,
    input_json TEXT NOT NULL, stage TEXT NOT NULL, requires_confirmation INTEGER NOT NULL,
    result_json TEXT, failure_json TEXT, next_follow_up_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_user ON agent_tasks(user_id, stage, updated_at);
  CREATE TABLE IF NOT EXISTS agent_task_events (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL,
    from_stage TEXT, to_stage TEXT NOT NULL, reason TEXT, payload_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_task_events_task ON agent_task_events(task_id, created_at);
`);
for (const definition of [
  "ALTER TABLE agent_tasks ADD COLUMN passed_checks_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agent_tasks ADD COLUMN failed_checks_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agent_tasks ADD COLUMN next_action TEXT",
]) { try { db.exec(definition); } catch (_) { /* existing database already migrated */ } }

export interface PersistedAgentTask {
  id: string; userId: string; capability: string; standardVersion: string;
  sourceType: string | null; sourceId: string | null; input: unknown; stage: AgentStage;
  requiresConfirmation: boolean; result: unknown | null; failures: string[];
  passedChecks: string[]; failedChecks: string[]; acceptanceStatus: "pending" | "running" | "passed" | "failed";
  nextAction: string | null; nextFollowUpAt: string | null; createdAt: string; updatedAt: string;
}
type Row = { id:string; user_id:string; capability:string; standard_version:string; source_type:string|null; source_id:string|null; input_json:string; stage:AgentStage; requires_confirmation:number; result_json:string|null; failure_json:string|null; passed_checks_json:string; failed_checks_json:string; next_action:string|null; next_follow_up_at:string|null; created_at:string; updated_at:string };
const decodeJson = (value: string | null, fallback: unknown) => { if (!value) return fallback; try { return JSON.parse(decField(value)); } catch (_) { try { return JSON.parse(value); } catch (_) { return fallback; } } };
const decode = (row: Row): PersistedAgentTask => ({ id: row.id, userId: row.user_id, capability: row.capability, standardVersion: row.standard_version, sourceType: row.source_type, sourceId: row.source_id, input: JSON.parse(decField(row.input_json)), stage: row.stage, requiresConfirmation: row.requires_confirmation === 1, result: decodeJson(row.result_json, null), failures: decodeJson(row.failure_json, []), passedChecks: decodeJson(row.passed_checks_json, []), failedChecks: decodeJson(row.failed_checks_json, []), acceptanceStatus: row.stage === "verified" ? "passed" : row.stage === "failed" ? "failed" : row.stage === "verifying" ? "running" : "pending", nextAction: row.next_action, nextFollowUpAt: row.next_follow_up_at, createdAt: row.created_at, updatedAt: row.updated_at });

function event(task: PersistedAgentTask, fromStage: AgentStage | null, toStage: AgentStage, reason: string, payload?: unknown): void {
  db.prepare("INSERT INTO agent_task_events (id,task_id,user_id,from_stage,to_stage,reason,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), task.id, task.userId, fromStage, toStage, reason.slice(0, 500), payload == null ? null : encField(JSON.stringify(payload)), new Date().toISOString());
}

export function createPersistentAgentTask(userId: string, capability: string, input: unknown, sourceType?: string, sourceId?: string): PersistedAgentTask {
  const standard = capabilityStandard(capability);
  if (!standard) throw new Error(`agent_standard_missing:${capability}`);
  const now = new Date().toISOString();
  const stage: AgentStage = standard.requiresConfirmation ? "awaiting_confirmation" : "received";
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO agent_tasks (id,user_id,capability,standard_version,source_type,source_id,input_json,stage,requires_confirmation,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?,?,?)").run(id, userId, capability, standard.version, sourceType || null, sourceId || null, encField(JSON.stringify(input)), stage, standard.requiresConfirmation ? 1 : 0, now, now);
  const task = getPersistentAgentTask(id, userId)!;
  event(task, null, stage, "task_created", input);
  return task;
}

export function getPersistentAgentTask(id: string, userId: string): PersistedAgentTask | null { const row = db.prepare("SELECT * FROM agent_tasks WHERE id=? AND user_id=?").get(id, userId) as unknown as Row | undefined; return row ? decode(row) : null; }
export function listPersistentAgentTasks(userId: string): PersistedAgentTask[] { return (db.prepare("SELECT * FROM agent_tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 200").all(userId) as unknown as Row[]).map(decode); }

export function transitionPersistentAgentTask(userId: string, id: string, toStage: AgentStage, reason: string, result?: unknown): PersistedAgentTask | null {
  const task = getPersistentAgentTask(id, userId); if (!task) return null;
  const allowed: Record<AgentStage, AgentStage[]> = {
    received: ["classified", "failed"], classified: ["extracted", "failed"], extracted: ["awaiting_confirmation", "executing", "failed"], awaiting_confirmation: ["executing", "follow_up", "failed"], executing: ["verifying", "failed", "retrying"], verifying: ["verified", "failed"], verified: ["follow_up"], follow_up: ["executing", "awaiting_user"], failed: ["retrying", "awaiting_user", "follow_up"], retrying: ["executing", "failed"], awaiting_user: ["retrying", "follow_up"],
  };
  if (task.stage !== toStage && !allowed[task.stage].includes(toStage)) throw new Error(`agent_invalid_transition:${task.stage}->${toStage}`);
  const now = new Date().toISOString();
  const failures = toStage === "failed" ? (Array.isArray(result) ? result : [reason]) : task.failures;
  const nextActions: Partial<Record<AgentStage, string>> = {
    received: "已收到，正在识别输入",
    classified: "已判断类型，正在提取目标",
    extracted: "目标已提取，准备执行",
    awaiting_confirmation: "等待用户确认",
    executing: "正在处理",
    verifying: "结果已产生，正在验收",
    verified: "已完成并通过验收",
    failed: "请重试或查看失败原因",
    retrying: "正在重试",
    follow_up: "等待后续处理",
    awaiting_user: "等待用户补充信息",
  };
  const nextAction = nextActions[toStage] || null;
  db.prepare("UPDATE agent_tasks SET stage=?,result_json=?,failure_json=?,next_action=?,updated_at=? WHERE id=? AND user_id=?").run(toStage, result == null ? task.result == null ? null : encField(JSON.stringify(task.result)) : encField(JSON.stringify(result)), encField(JSON.stringify(failures)), nextAction, now, id, userId);
  const updated = getPersistentAgentTask(id, userId)!; event(updated, task.stage, toStage, reason, result); return updated;
}

export function verifyPersistentAgentTask(userId: string, id: string, result: unknown): PersistedAgentTask | null {
  const task = getPersistentAgentTask(id, userId); if (!task) return null;
  const standard = capabilityStandard(task.capability); if (!standard) return transitionPersistentAgentTask(userId, id, "failed", "agent_standard_missing", ["能力标准不存在"]);
  const memoryTask = createCapabilityTask({ id: task.id, capability: task.capability, input: task.input, requiresConfirmation: task.requiresConfirmation });
  const checked = verifyAgentTask(memoryTask, result);
  db.prepare("UPDATE agent_tasks SET passed_checks_json=?,failed_checks_json=? WHERE id=? AND user_id=?").run(encField(JSON.stringify(checked.acceptance.filter((item) => !checked.failures.includes(item.description)).map((item) => item.description))), encField(JSON.stringify(checked.failures)), id, userId);
  return transitionPersistentAgentTask(userId, id, checked.stage === "verified" ? "verified" : "failed", checked.stage === "verified" ? "acceptance_passed" : "acceptance_failed", checked.stage === "verified" ? result : checked.failures);
}

export function listAgentTaskEvents(userId: string, taskId: string): unknown[] {
  if (!getPersistentAgentTask(taskId, userId)) return [];
  return db.prepare("SELECT id,from_stage as fromStage,to_stage as toStage,reason,payload_json as payload,created_at as createdAt FROM agent_task_events WHERE task_id=? AND user_id=? ORDER BY created_at ASC").all(taskId, userId);
}
