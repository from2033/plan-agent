import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS context_packs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    run_id TEXT,
    step_id TEXT,
    capability_ref TEXT NOT NULL,
    original_request TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    conversation_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    failure_delta_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_packs_run ON context_packs(user_id,run_id,created_at);
`);

export interface ContextPack {
  id: string;
  userId: string;
  runId: string | null;
  stepId: string | null;
  capabilityRef: string;
  originalRequest: string;
  facts: Record<string, unknown>;
  conversation: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  failureDelta: Record<string, unknown> | null;
  createdAt: string;
}

type ContextPackInput = Omit<ContextPack, "id" | "userId" | "createdAt" | "conversation" | "evidence" | "dependencies" | "failureDelta">
  & Partial<Pick<ContextPack, "conversation" | "evidence" | "dependencies" | "failureDelta">>;

interface ContextPackRow {
  id: string;
  user_id: string;
  run_id: string | null;
  step_id: string | null;
  capability_ref: string;
  original_request: string;
  facts_json: string;
  conversation_json: string;
  evidence_json: string;
  dependencies_json: string;
  failure_delta_json: string | null;
  created_at: string;
}

function boundedObject(value: unknown, maxChars: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= maxChars ? JSON.parse(encoded) : { truncated: true };
  } catch {
    return {};
  }
}

export function createContextPack(userId: string, input: ContextPackInput): ContextPack {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const conversation = (input.conversation || []).slice(-6).map(item => boundedObject(item, 4_000));
  const evidence = (input.evidence || []).slice(0, 6).map(item => boundedObject(item, 4_000));
  const dependencies = (input.dependencies || []).slice(0, 4).map(item => boundedObject(item, 8_000));
  const failureDelta = input.failureDelta ? boundedObject(input.failureDelta, 4_000) : null;
  db.prepare(`INSERT INTO context_packs
    (id,user_id,run_id,step_id,capability_ref,original_request,facts_json,conversation_json,
      evidence_json,dependencies_json,failure_delta_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, input.runId || null, input.stepId || null, input.capabilityRef,
      encField(input.originalRequest.slice(0, 20_000)), encField(JSON.stringify(boundedObject(input.facts, 12_000))),
      encField(JSON.stringify(conversation)), encField(JSON.stringify(evidence)), encField(JSON.stringify(dependencies)),
      failureDelta ? encField(JSON.stringify(failureDelta)) : null, now,
    );
  return getContextPack(id, userId)!;
}

export function getContextPack(id: string, userId: string): ContextPack | null {
  const row = db.prepare("SELECT * FROM context_packs WHERE id=? AND user_id=?").get(id, userId) as unknown as ContextPackRow | undefined;
  if (!row) return null;
  const parse = (value: string) => JSON.parse(decField(value));
  return {
    id: row.id, userId: row.user_id, runId: row.run_id, stepId: row.step_id,
    capabilityRef: row.capability_ref, originalRequest: decField(row.original_request),
    facts: parse(row.facts_json), conversation: parse(row.conversation_json), evidence: parse(row.evidence_json),
    dependencies: parse(row.dependencies_json), failureDelta: row.failure_delta_json ? parse(row.failure_delta_json) : null,
    createdAt: row.created_at,
  };
}
