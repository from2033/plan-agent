import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";
import { capabilityStandard, verifyAgentTask, createCapabilityTask, type AgentStage } from "./agent-contract.js";
import "./agent-standards.js";
import { recordAgentFailureSample } from "./agent-quality.js";
import { getActionPlan, parentForPlanChild, updatePlanItemByChild } from "./action-plan.js";

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
  "ALTER TABLE agent_tasks ADD COLUMN parent_task_id TEXT",
  "ALTER TABLE agent_tasks ADD COLUMN root_task_id TEXT",
]) { try { db.exec(definition); } catch (_) { /* existing database already migrated */ } }

export interface PersistedAgentTask {
  id: string; userId: string; capability: string; standardVersion: string;
  sourceType: string | null; sourceId: string | null; input: unknown; stage: AgentStage;
  requiresConfirmation: boolean; result: unknown | null; failures: string[];
  parentTaskId: string | null; rootTaskId: string | null;
  passedChecks: string[]; failedChecks: string[]; acceptanceStatus: "pending" | "running" | "passed" | "failed";
  nextAction: string | null; nextFollowUpAt: string | null; createdAt: string; updatedAt: string;
}
type Row = { id:string; user_id:string; capability:string; standard_version:string; source_type:string|null; source_id:string|null; input_json:string; stage:AgentStage; requires_confirmation:number; result_json:string|null; failure_json:string|null; passed_checks_json:string; failed_checks_json:string; next_action:string|null; next_follow_up_at:string|null; parent_task_id:string|null; root_task_id:string|null; created_at:string; updated_at:string };
const decodeJson = (value: string | null, fallback: unknown) => { if (!value) return fallback; try { return JSON.parse(decField(value)); } catch (_) { try { return JSON.parse(value); } catch (_) { return fallback; } } };
const decode = (row: Row): PersistedAgentTask => ({ id: row.id, userId: row.user_id, capability: row.capability, standardVersion: row.standard_version, sourceType: row.source_type, sourceId: row.source_id, input: JSON.parse(decField(row.input_json)), stage: row.stage, requiresConfirmation: row.requires_confirmation === 1, result: decodeJson(row.result_json, null), failures: decodeJson(row.failure_json, []), passedChecks: decodeJson(row.passed_checks_json, []), failedChecks: decodeJson(row.failed_checks_json, []), acceptanceStatus: row.stage === "verified" ? "passed" : row.stage === "failed" ? "failed" : row.stage === "verifying" ? "running" : "pending", nextAction: row.next_action, nextFollowUpAt: row.next_follow_up_at, parentTaskId: row.parent_task_id, rootTaskId: row.root_task_id, createdAt: row.created_at, updatedAt: row.updated_at });

function event(task: PersistedAgentTask, fromStage: AgentStage | null, toStage: AgentStage, reason: string, payload?: unknown): void {
  db.prepare("INSERT INTO agent_task_events (id,task_id,user_id,from_stage,to_stage,reason,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), task.id, task.userId, fromStage, toStage, reason.slice(0, 500), payload == null ? null : encField(JSON.stringify(payload)), new Date().toISOString());
}

export function createPersistentAgentTask(userId: string, capability: string, input: unknown, sourceType?: string, sourceId?: string, relationship?: { parentTaskId?: string; rootTaskId?: string }): PersistedAgentTask {
  const standard = capabilityStandard(capability);
  if (!standard) throw new Error(`agent_standard_missing:${capability}`);
  const now = new Date().toISOString();
  const stage: AgentStage = standard.requiresConfirmation ? "awaiting_confirmation" : "received";
  const id = crypto.randomUUID();
  const parent = relationship?.parentTaskId
    ? getPersistentAgentTask(relationship.parentTaskId, userId)
    : null;
  if (relationship?.parentTaskId && !parent) throw new Error("agent_parent_task_missing");
  const rootTaskId = relationship?.rootTaskId || parent?.rootTaskId || parent?.id || null;
  db.prepare("INSERT INTO agent_tasks (id,user_id,capability,standard_version,source_type,source_id,input_json,stage,requires_confirmation,parent_task_id,root_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, userId, capability, standard.version, sourceType || null, sourceId || null, encField(JSON.stringify(input)), stage, standard.requiresConfirmation ? 1 : 0, relationship?.parentTaskId || null, rootTaskId, now, now);
  const task = getPersistentAgentTask(id, userId)!;
  event(task, null, stage, "task_created", input);
  return task;
}

export function getPersistentAgentTask(id: string, userId: string): PersistedAgentTask | null { const row = db.prepare("SELECT * FROM agent_tasks WHERE id=? AND user_id=?").get(id, userId) as unknown as Row | undefined; return row ? decode(row) : null; }
export function listPersistentAgentTasks(userId: string): PersistedAgentTask[] { return (db.prepare("SELECT * FROM agent_tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 200").all(userId) as unknown as Row[]).map(decode); }
export function listChildAgentTasks(userId: string, parentTaskId: string): PersistedAgentTask[] { return (db.prepare("SELECT * FROM agent_tasks WHERE user_id=? AND parent_task_id=? ORDER BY created_at ASC").all(userId, parentTaskId) as unknown as Row[]).map(decode); }

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
  if (toStage === "failed" && reason !== "acceptance_failed") {
    recordAgentFailureSample(task, "execution", reason, result);
  }
  const updated = getPersistentAgentTask(id, userId)!;
  event(updated, task.stage, toStage, reason, result);
  const planStatus = toStage === "verified" ? "verified"
    : toStage === "failed" ? "failed"
      : toStage === "awaiting_user" ? "awaiting_user"
        : toStage === "awaiting_confirmation" ? "awaiting_confirmation"
          : toStage === "verifying" ? "verifying" : toStage === "executing" || toStage === "retrying" ? "executing" : null;
  if (planStatus) updatePlanItemByChild(userId, id, planStatus, result, toStage === "failed" ? failures.join("；") : undefined);
  const parentId = parentForPlanChild(userId, id);
  if (parentId) refreshOrchestrationParent(userId, parentId);
  return updated;
}

export function refreshOrchestrationParent(userId: string, parentId: string): PersistedAgentTask | null {
  const parent = getPersistentAgentTask(parentId, userId);
  const plan = getActionPlan(userId, parentId);
  if (!parent || parent.capability !== "input_orchestration" || !plan) return parent;
  if (plan.coverageStatus === "failed" && ["executing", "verifying", "retrying"].includes(parent.stage)) {
    return transitionPersistentAgentTask(userId, parent.id, "failed", "required_plan_item_failed", plan.missingRequirements);
  }
  if (plan.coverageStatus !== "complete") {
    return parent;
  }
  if (["executing", "retrying"].includes(parent.stage)) transitionPersistentAgentTask(userId, parent.id, "verifying", "all_plan_items_verified", plan);
  const verifying = getPersistentAgentTask(parent.id, userId);
  return verifying?.stage === "verifying" ? verifyPersistentAgentTask(userId, parent.id, plan) : verifying;
}

export function verifyPersistentAgentTask(userId: string, id: string, result: unknown): PersistedAgentTask | null {
  const task = getPersistentAgentTask(id, userId); if (!task) return null;
  const standard = capabilityStandard(task.capability); if (!standard) return transitionPersistentAgentTask(userId, id, "failed", "agent_standard_missing", ["能力标准不存在"]);
  const memoryTask = createCapabilityTask({ id: task.id, capability: task.capability, input: task.input, requiresConfirmation: task.requiresConfirmation });
  const checked = verifyAgentTask(memoryTask, result);
  db.prepare("UPDATE agent_tasks SET passed_checks_json=?,failed_checks_json=? WHERE id=? AND user_id=?").run(encField(JSON.stringify(checked.acceptance.filter((item) => !checked.failures.includes(item.description)).map((item) => item.description))), encField(JSON.stringify(checked.failures)), id, userId);
  for (const failure of checked.failures) recordAgentFailureSample(task, "acceptance", failure, result);
  return transitionPersistentAgentTask(userId, id, checked.stage === "verified" ? "verified" : "failed", checked.stage === "verified" ? "acceptance_passed" : "acceptance_failed", checked.stage === "verified" ? result : checked.failures);
}

export function recordPersistentAgentExecutionFailure(
  userId: string,
  id: string,
  reason: string,
  result?: unknown,
): void {
  const task = getPersistentAgentTask(id, userId);
  if (task) recordAgentFailureSample(task, "execution", reason, result);
}

export function schedulePersistentAgentFollowUp(
  userId: string,
  id: string,
  followUpAt: string,
  reason = "follow_up_scheduled",
): PersistedAgentTask | null {
  const task = getPersistentAgentTask(id, userId);
  const at = new Date(followUpAt);
  if (!task || Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return null;
  let scheduled = task;
  if (task.stage !== "follow_up") {
    scheduled = transitionPersistentAgentTask(userId, id, "follow_up", reason) || task;
  }
  db.prepare("UPDATE agent_tasks SET next_follow_up_at=?,next_action=?,updated_at=? WHERE id=? AND user_id=?")
    .run(at.toISOString(), `将在 ${at.toISOString()} 再次提醒`, new Date().toISOString(), id, userId);
  const updated = getPersistentAgentTask(id, userId)!;
  event(updated, scheduled.stage, scheduled.stage, reason, { followUpAt: at.toISOString() });
  return updated;
}

export function wakeDueAgentFollowUps(now = new Date()): PersistedAgentTask[] {
  const due = db.prepare(`SELECT * FROM agent_tasks
    WHERE stage='follow_up' AND next_follow_up_at IS NOT NULL AND next_follow_up_at<=?
    ORDER BY next_follow_up_at ASC LIMIT 100`).all(now.toISOString()) as unknown as Row[];
  const awakened: PersistedAgentTask[] = [];
  for (const row of due) {
    db.prepare("UPDATE agent_tasks SET next_follow_up_at=NULL WHERE id=? AND user_id=?").run(row.id, row.user_id);
    const task = transitionPersistentAgentTask(row.user_id, row.id, "awaiting_user", "scheduled_follow_up_due");
    if (task) awakened.push(task);
  }
  return awakened;
}

export function auditStaleAgentTasks(
  now = new Date(),
  maximumAgeMs = 2 * 60 * 60_000,
): PersistedAgentTask[] {
  const cutoff = new Date(now.getTime() - maximumAgeMs).toISOString();
  const rows = db.prepare(`SELECT * FROM agent_tasks WHERE updated_at<=?
    AND stage IN ('received','classified','extracted','executing','verifying','retrying')
    ORDER BY updated_at ASC LIMIT 100`).all(cutoff) as unknown as Row[];
  const failed: PersistedAgentTask[] = [];
  for (const row of rows) {
    const task = transitionPersistentAgentTask(row.user_id, row.id, "failed", "agent_task_timeout", ["任务长时间没有进展"]);
    if (!task) continue;
    const scheduled = schedulePersistentAgentFollowUp(
      task.userId,
      task.id,
      new Date(now.getTime() + 15 * 60_000).toISOString(),
      "timeout_follow_up_scheduled",
    );
    failed.push(scheduled || task);
  }
  return failed;
}

export function listAgentTaskEvents(userId: string, taskId: string): unknown[] {
  if (!getPersistentAgentTask(taskId, userId)) return [];
  const rows = db.prepare("SELECT id,from_stage as fromStage,to_stage as toStage,reason,payload_json as payload,created_at as createdAt FROM agent_task_events WHERE task_id=? AND user_id=? ORDER BY created_at ASC")
    .all(taskId, userId) as unknown as Array<{ id: string; fromStage: string | null; toStage: string; reason: string; payload: string | null; createdAt: string }>;
  return rows.map((row) => ({ ...row, payload: decodeJson(row.payload, null) }));
}
