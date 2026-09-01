import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { decField, encField } from "./crypto-field.js";
import {
  activateCapabilityStandard,
  capabilityStandard,
  createAgentTask,
  generatedCapabilityStandard,
  registerGeneratedCapabilityStandard,
  validateDeclarativeRules,
  verifyAgentTask,
  type DeclarativeRule,
} from "./agent-contract.js";
import { withVerifiedSideEffectReceipts } from "./acceptance-receipts.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS acceptance_standard_proposals (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
    capability TEXT NOT NULL, base_version TEXT NOT NULL, candidate_version TEXT NOT NULL,
    status TEXT NOT NULL, risk_level TEXT NOT NULL, rationale TEXT NOT NULL,
    rules_json TEXT NOT NULL, cases_json TEXT NOT NULL, replay_json TEXT,
    baseline_pass_rate REAL, regression_count INTEGER NOT NULL DEFAULT 0,
    safety_regression INTEGER NOT NULL DEFAULT 0, activated_at TEXT, rolled_back_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptance_proposal_version
    ON acceptance_standard_proposals(capability,candidate_version);
  CREATE INDEX IF NOT EXISTS idx_acceptance_proposal_ticket
    ON acceptance_standard_proposals(ticket_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS acceptance_standard_events (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, user_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_acceptance_standard_events
    ON acceptance_standard_events(proposal_id,created_at);
`);

export type StandardProposalStatus = "draft" | "replaying" | "ready" | "approved" | "rejected" | "active" | "rolled_back";
export type StandardRisk = "low" | "medium" | "high";

export interface StandardProposal {
  id: string; userId: string; ticketId: string; capability: string; baseVersion: string;
  candidateVersion: string; status: StandardProposalStatus; riskLevel: StandardRisk;
  rationale: string; rules: DeclarativeRule[]; cases: ProposalCase[]; replay: ReplayReport | null;
  baselinePassRate: number | null; regressionCount: number; safetyRegression: boolean;
  activatedAt: string | null; rolledBackAt: string | null; createdAt: string; updatedAt: string;
}

export interface ProposalCase { name: string; input: unknown; result: unknown; expectedPass: boolean; }
export interface ReplayReport {
  negativeTotal: number; negativeBlocked: number; positiveTotal: number; positivePassed: number;
  fixtureTotal: number; fixturePassed: number; securityPassed: boolean; evidenceSufficient: boolean;
  ready: boolean; reasons: string[]; replayedAt: string;
}

type ProposalRow = {
  id:string; user_id:string; ticket_id:string; capability:string; base_version:string; candidate_version:string;
  status:StandardProposalStatus; risk_level:StandardRisk; rationale:string; rules_json:string; cases_json:string;
  replay_json:string|null; baseline_pass_rate:number|null; regression_count:number; safety_regression:number;
  activated_at:string|null; rolled_back_at:string|null; created_at:string; updated_at:string;
};

const json = (value: string | null, fallback: unknown) => {
  if (!value) return fallback;
  try { return JSON.parse(decField(value)); } catch { try { return JSON.parse(value); } catch { return fallback; } }
};
const decode = (row: ProposalRow): StandardProposal => ({
  id: row.id, userId: row.user_id, ticketId: row.ticket_id, capability: row.capability,
  baseVersion: row.base_version, candidateVersion: row.candidate_version, status: row.status,
  riskLevel: row.risk_level, rationale: decField(row.rationale), rules: json(row.rules_json, []) as DeclarativeRule[],
  cases: json(row.cases_json, []) as ProposalCase[], replay: json(row.replay_json, null) as ReplayReport | null,
  baselinePassRate: row.baseline_pass_rate, regressionCount: row.regression_count,
  safetyRegression: row.safety_regression === 1, activatedAt: row.activated_at,
  rolledBackAt: row.rolled_back_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

function raw(id: string): ProposalRow | null {
  return db.prepare("SELECT * FROM acceptance_standard_proposals WHERE id=?").get(id) as unknown as ProposalRow | undefined || null;
}
function event(proposal: StandardProposal, eventType: string, payload?: unknown): void {
  db.prepare("INSERT INTO acceptance_standard_events (id,proposal_id,user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)")
    .run(crypto.randomUUID(), proposal.id, proposal.userId, eventType, payload == null ? null : encField(JSON.stringify(payload)), new Date().toISOString());
}

export function hydrateActiveAcceptanceStandards(): void {
  const rows = db.prepare("SELECT * FROM acceptance_standard_proposals WHERE status IN ('approved','active','rolled_back') ORDER BY created_at ASC")
    .all() as unknown as ProposalRow[];
  for (const row of rows) {
    const proposal = decode(row);
    try {
      registerGeneratedCapabilityStandard(proposal.capability, proposal.baseVersion, proposal.candidateVersion, proposal.rules);
      if (proposal.status === "active") activateCapabilityStandard(proposal.capability, proposal.candidateVersion);
    } catch (error) { console.error("[acceptance evolution] active standard hydrate failed", proposal.id, error); }
  }
}

export function standardProposalsForTicket(ticketId: string, viewerId: string, primaryUser: string): StandardProposal[] {
  const owner = db.prepare("SELECT user_id FROM feedback_tickets WHERE id=?").get(ticketId) as { user_id?: string } | undefined;
  if (!owner || (owner.user_id !== viewerId && viewerId !== primaryUser)) return [];
  return (db.prepare("SELECT * FROM acceptance_standard_proposals WHERE ticket_id=? ORDER BY created_at DESC").all(ticketId) as unknown as ProposalRow[]).map(decode);
}

export function getStandardProposal(id: string, viewerId: string, primaryUser: string): StandardProposal | null {
  const row = raw(id); if (!row || (row.user_id !== viewerId && viewerId !== primaryUser)) return null;
  return decode(row);
}

type CaseRow = { id:string; source_id:string|null; input_json:string; result_json:string|null; stage:string; standard_version:string };
function historicalCases(userId: string, capability: string): { positives: ProposalCase[]; negatives: ProposalCase[] } {
  const positives = (db.prepare(`SELECT id,source_id,input_json,result_json,stage,standard_version FROM agent_tasks t
    WHERE user_id=? AND capability=? AND stage='verified' AND result_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_failure_samples f WHERE f.task_id=t.id AND f.kind='user_correction')
    ORDER BY updated_at DESC LIMIT 20`).all(userId, capability) as unknown as CaseRow[]).map((row, index) => {
    const input = json(row.input_json, {});
    const result = withVerifiedSideEffectReceipts(userId, capability, input, json(row.result_json, {}), row.source_id);
    return { name: `historical-positive-${index + 1}`, input, result, expectedPass: true };
  });
  const negatives = (db.prepare(`SELECT t.id,t.source_id,t.input_json,t.result_json,t.stage,t.standard_version FROM agent_tasks t
    WHERE t.user_id=? AND t.capability=? AND t.result_json IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_failure_samples f WHERE f.task_id=t.id AND f.kind='user_correction')
    ORDER BY t.updated_at DESC LIMIT 20`).all(userId, capability) as unknown as CaseRow[]).map((row, index) => {
    const input = json(row.input_json, {});
    const result = withVerifiedSideEffectReceipts(userId, capability, input, json(row.result_json, {}), row.source_id);
    return { name: `user-correction-${index + 1}`, input, result, expectedPass: false };
  });
  return { positives, negatives };
}

function evaluate(standard: ReturnType<typeof generatedCapabilityStandard>, value: ProposalCase): boolean {
  const task = createAgentTask({ id: `shadow-${crypto.randomUUID()}`, capability: standard.capability, input: value.input,
    requiresConfirmation: standard.requiresConfirmation, acceptance: standard.acceptance(value.input) });
  return verifyAgentTask(task, value.result).stage === "verified";
}

function replayProposal(proposal: StandardProposal): ReplayReport {
  const base = capabilityStandard(proposal.capability, proposal.baseVersion);
  if (!base) throw new Error("proposal_base_standard_missing");
  const candidate = generatedCapabilityStandard(base, proposal.candidateVersion, proposal.rules);
  const historical = historicalCases(proposal.userId, proposal.capability);
  const negativeBlocked = historical.negatives.filter(item => !evaluate(candidate, item)).length;
  const positivePassed = historical.positives.filter(item => evaluate(candidate, item)).length;
  const fixturePassed = proposal.cases.filter(item => evaluate(candidate, item) === item.expectedPass).length;
  const sideEffect = base.allowedSideEffects.length > 0;
  const hasReceiptGuard = proposal.rules.some(rule => rule.type === "receipt" || rule.type === "unique");
  const minimumPositive = proposal.riskLevel === "low" && !sideEffect ? 1 : sideEffect ? 5 : 3;
  const reasons: string[] = [];
  if (!historical.negatives.length) reasons.push("缺少真实用户纠正负例");
  if (negativeBlocked !== historical.negatives.length) reasons.push("候选规则未拦截全部负例");
  if (historical.positives.length < minimumPositive) reasons.push(`真实成功样本不足 ${minimumPositive} 例`);
  if (positivePassed !== historical.positives.length) reasons.push("候选规则误伤已有成功任务");
  if (proposal.cases.length < 2 || fixturePassed !== proposal.cases.length) reasons.push("边界回归案例未全部通过");
  if (sideEffect && !hasReceiptGuard) reasons.push("副作用能力缺少持久化回执或幂等规则");
  const securityPassed = !sideEffect || hasReceiptGuard;
  const evidenceSufficient = historical.negatives.length > 0 && historical.positives.length >= minimumPositive && proposal.cases.length >= 2;
  return { negativeTotal: historical.negatives.length, negativeBlocked, positiveTotal: historical.positives.length,
    positivePassed, fixtureTotal: proposal.cases.length, fixturePassed, securityPassed, evidenceSufficient,
    ready: reasons.length === 0, reasons, replayedAt: new Date().toISOString() };
}

export function proposalJobInput(userId: string, ticketId: string, capability: string, baseVersion: string, correction: string): unknown {
  const cases = historicalCases(userId, capability);
  const base = capabilityStandard(capability, baseVersion);
  return { ticketId, capability, baseVersion, correction: correction.slice(0, 2_000),
    positiveExamples: cases.positives.slice(0, 10), negativeExamples: cases.negatives.slice(0, 10),
    reservedRuleIds: base?.acceptance({}).map(item => item.id) || [],
    allowedRuleTypes: ["required", "min_items", "equals", "regex", "contains_all", "count_equals", "https_sources", "time_range", "receipt", "unique", "semantic_advisory"] };
}

export function createStandardProposal(userId: string, ticketId: string, value: {
  capability: string; baseVersion: string; rationale: string; riskLevel: StandardRisk; rules: unknown; cases: ProposalCase[];
}): StandardProposal {
  if (!capabilityStandard(value.capability, value.baseVersion)) throw new Error("proposal_base_standard_missing");
  const rules = validateDeclarativeRules(value.rules);
  const cases = (value.cases || []).slice(0, 20).map(item => ({ name: String(item.name || "case").slice(0, 120),
    input: item.input, result: item.result, expectedPass: Boolean(item.expectedPass) }));
  const id = crypto.randomUUID();
  const candidateVersion = `${value.baseVersion}-evo.${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO acceptance_standard_proposals
    (id,user_id,ticket_id,capability,base_version,candidate_version,status,risk_level,rationale,rules_json,cases_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?)`).run(id, userId, ticketId, value.capability, value.baseVersion,
      candidateVersion, value.riskLevel, encField(value.rationale.slice(0, 4_000)), encField(JSON.stringify(rules)),
      encField(JSON.stringify(cases)), now, now);
  let proposal = decode(raw(id)!); event(proposal, "proposal_created");
  db.prepare("UPDATE acceptance_standard_proposals SET status='replaying',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  proposal = decode(raw(id)!); event(proposal, "shadow_replay_started");
  const replay = replayProposal(proposal);
  db.prepare("UPDATE acceptance_standard_proposals SET status=?,replay_json=?,updated_at=? WHERE id=?")
    .run(replay.ready ? "ready" : "draft", encField(JSON.stringify(replay)), new Date().toISOString(), id);
  proposal = decode(raw(id)!); event(proposal, "shadow_replay_completed", replay);
  return proposal;
}

function basePassRate(userId: string, capability: string, version: string): number {
  const row = db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN first_terminal='verified' THEN 1 ELSE 0 END) passed FROM (
    SELECT t.id,(SELECT e.to_stage FROM agent_task_events e WHERE e.task_id=t.id
      AND e.to_stage IN ('verified','failed') ORDER BY e.created_at ASC LIMIT 1) first_terminal
    FROM agent_tasks t WHERE t.user_id=? AND t.capability=? AND t.standard_version=?
  ) WHERE first_terminal IS NOT NULL`)
    .get(userId, capability, version) as { total:number; passed:number|null };
  return row.total ? Number((Number(row.passed || 0) / row.total).toFixed(4)) : 1;
}

export function approveStandardProposal(id: string): StandardProposal | null {
  const row = raw(id); if (!row) return null;
  let proposal = decode(row);
  if (["active", "approved"].includes(proposal.status)) return proposal;
  if (proposal.status !== "ready" || !proposal.replay?.ready) throw new Error("proposal_not_ready");
  const currentActive = db.prepare("SELECT id FROM acceptance_standard_proposals WHERE capability=? AND status='active'")
    .all(proposal.capability) as unknown as Array<{ id:string }>;
  for (const active of currentActive) rollbackStandardProposal(active.id, "superseded", false);
  registerGeneratedCapabilityStandard(proposal.capability, proposal.baseVersion, proposal.candidateVersion, proposal.rules);
  activateCapabilityStandard(proposal.capability, proposal.candidateVersion);
  const now = new Date().toISOString();
  db.prepare("UPDATE acceptance_standard_proposals SET status='approved',updated_at=? WHERE id=?").run(now, id);
  proposal = decode(raw(id)!); event(proposal, "proposal_approved");
  db.prepare("UPDATE acceptance_standard_proposals SET status='active',baseline_pass_rate=?,activated_at=?,updated_at=? WHERE id=?")
    .run(basePassRate(proposal.userId, proposal.capability, proposal.baseVersion), now, now, id);
  proposal = decode(raw(id)!); event(proposal, "standard_activated", { version: proposal.candidateVersion });
  return proposal;
}

export function rejectStandardProposal(id: string): StandardProposal | null {
  const row = raw(id); if (!row) return null;
  const proposal = decode(row); if (proposal.status === "rejected") return proposal;
  if (!["draft", "ready"].includes(proposal.status)) throw new Error("proposal_not_rejectable");
  db.prepare("UPDATE acceptance_standard_proposals SET status='rejected',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  const updated = decode(raw(id)!); event(updated, "proposal_rejected"); return updated;
}

export function recordActiveStandardRegression(capability: string, version: string, safety = false): void {
  db.prepare(`UPDATE acceptance_standard_proposals SET regression_count=regression_count+1,
    safety_regression=CASE WHEN ? THEN 1 ELSE safety_regression END,updated_at=?
    WHERE capability=? AND candidate_version=? AND status='active'`)
    .run(safety ? 1 : 0, new Date().toISOString(), capability, version);
}

export function rollbackStandardProposal(id: string, reason: string, restoreBase = true): StandardProposal | null {
  const row = raw(id); if (!row) return null;
  const proposal = decode(row); if (proposal.status === "rolled_back") return proposal;
  if (proposal.status !== "active") return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE acceptance_standard_proposals SET status='rolled_back',rolled_back_at=?,updated_at=? WHERE id=?").run(now, now, id);
  const previous = capabilityStandard(proposal.capability, proposal.baseVersion);
  if (restoreBase && previous) {
    activateCapabilityStandard(proposal.capability, proposal.baseVersion);
    db.prepare(`UPDATE acceptance_standard_proposals SET status='active',rolled_back_at=NULL,activated_at=?,updated_at=?
      WHERE capability=? AND candidate_version=?`).run(now, now, proposal.capability, proposal.baseVersion);
  }
  const updated = decode(raw(id)!); event(updated, "standard_rolled_back", { reason }); return updated;
}

export function auditActiveAcceptanceStandards(now = new Date()): StandardProposal[] {
  const rows = db.prepare("SELECT * FROM acceptance_standard_proposals WHERE status='active'").all() as unknown as ProposalRow[];
  const rolledBack: StandardProposal[] = [];
  for (const row of rows) {
    const proposal = decode(row);
    const stats = db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN first_terminal='verified' THEN 1 ELSE 0 END) passed FROM (
      SELECT t.id,(SELECT e.to_stage FROM agent_task_events e WHERE e.task_id=t.id
        AND e.to_stage IN ('verified','failed') ORDER BY e.created_at ASC LIMIT 1) first_terminal
      FROM agent_tasks t WHERE t.user_id=? AND t.capability=? AND t.standard_version=?
    ) WHERE first_terminal IS NOT NULL`)
      .get(proposal.userId, proposal.capability, proposal.candidateVersion) as { total:number; passed:number|null };
    const passRate = stats.total ? Number(stats.passed || 0) / stats.total : 1;
    const repeatedSideEffects = db.prepare(`SELECT COUNT(*) count FROM (
      SELECT t.id FROM agent_tasks t JOIN agent_task_events e ON e.task_id=t.id
      WHERE t.user_id=? AND t.capability=? AND t.standard_version=?
        AND e.reason IN ('user_confirmed','action_confirmed') GROUP BY t.id HAVING COUNT(*)>1
    )`).get(proposal.userId, proposal.capability, proposal.candidateVersion) as { count:number };
    const rateRegression = proposal.regressionCount >= 3 && passRate <= Number(proposal.baselinePassRate ?? 1) - 0.1;
    if (proposal.safetyRegression || repeatedSideEffects.count > 0 || rateRegression) {
      const updated = rollbackStandardProposal(proposal.id, proposal.safetyRegression || repeatedSideEffects.count > 0 ? "safety_regression" : "quality_regression");
      if (updated) rolledBack.push(updated);
    } else if (proposal.activatedAt && (stats.total >= 20 || now.getTime() - new Date(proposal.activatedAt).getTime() >= 14 * 24 * 60 * 60_000)) {
      event(proposal, "observation_window_completed", { total: stats.total, passRate });
    }
  }
  return rolledBack;
}

export function listStandardProposalEvents(id: string, viewerId: string, primaryUser: string): unknown[] {
  const proposal = getStandardProposal(id, viewerId, primaryUser); if (!proposal) return [];
  const rows = db.prepare("SELECT event_type,payload_json,created_at FROM acceptance_standard_events WHERE proposal_id=? ORDER BY created_at")
    .all(id) as unknown as Array<{ event_type:string; payload_json:string|null; created_at:string }>;
  return rows.map(row => ({ eventType: row.event_type, payload: json(row.payload_json, null), createdAt: row.created_at }));
}

export function deleteAcceptanceEvolutionAccountData(userId: string): void {
  const ids = db.prepare("SELECT id FROM acceptance_standard_proposals WHERE user_id=?").all(userId) as unknown as Array<{ id:string }>;
  for (const item of ids) db.prepare("DELETE FROM acceptance_standard_events WHERE proposal_id=?").run(item.id);
  db.prepare("DELETE FROM acceptance_standard_proposals WHERE user_id=?").run(userId);
}
