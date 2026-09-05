/**
 * Personal Agent 的统一任务契约与版本化验收引擎。
 * 已创建任务始终使用固化版本，生成式规则只能使用白名单 DSL。
 */
export type AgentStage = "received" | "classified" | "extracted" | "awaiting_confirmation" | "executing" | "verifying" | "verified" | "follow_up" | "failed" | "retrying" | "awaiting_user";

export interface AcceptanceEvidence {
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
  evidence?: unknown;
  reason?: string;
  advisory?: boolean;
}

export interface AcceptanceCheck {
  id: string;
  description: string;
  check: (result: unknown) => boolean | AcceptanceEvidence;
}

export interface AcceptanceCheckResult {
  id: string;
  description: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  evidence: unknown;
  reason: string;
  advisory: boolean;
  validatorVersion: string;
}

export interface AgentTask<TInput = unknown, TResult = unknown> {
  id: string;
  capability: string;
  input: TInput;
  stage: AgentStage;
  requiresConfirmation: boolean;
  acceptance: AcceptanceCheck[];
  acceptanceResults: AcceptanceCheckResult[];
  result?: TResult;
  failures: string[];
}

export const ACCEPTANCE_VALIDATOR_VERSION = "2.0";

export function createAgentTask<TInput, TResult>(params: {
  id: string;
  capability: string;
  input: TInput;
  requiresConfirmation?: boolean;
  acceptance: AcceptanceCheck[];
}): AgentTask<TInput, TResult> {
  return { id: params.id, capability: params.capability, input: params.input, stage: "received",
    requiresConfirmation: params.requiresConfirmation ?? true, acceptance: params.acceptance,
    acceptanceResults: [], failures: [] };
}

function safeEvidence(value: unknown): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "string") return value.slice(0, 2_000);
  try { return JSON.parse(JSON.stringify(value).slice(0, 8_000)); } catch { return String(value).slice(0, 2_000); }
}

export function verifyAgentTask<TInput, TResult>(task: AgentTask<TInput, TResult>, result: TResult): AgentTask<TInput, TResult> {
  const acceptanceResults = task.acceptance.map((item): AcceptanceCheckResult => {
    try {
      const checked = item.check(result);
      const detail: AcceptanceEvidence = typeof checked === "boolean"
        ? { passed: checked, actual: result, expected: item.description, evidence: { checkId: item.id, source: "deterministic_validator" } }
        : checked;
      return { id: item.id, description: item.description, passed: Boolean(detail.passed) || Boolean(detail.advisory),
        actual: safeEvidence(detail.actual), expected: safeEvidence(detail.expected), evidence: safeEvidence(detail.evidence),
        reason: String(detail.reason || (detail.passed ? "验收通过" : "未满足验收条件")).slice(0, 1_000),
        advisory: Boolean(detail.advisory), validatorVersion: ACCEPTANCE_VALIDATOR_VERSION };
    } catch (error) {
      return { id: item.id, description: item.description, passed: false, actual: null, expected: null,
        evidence: null, reason: `验证器异常：${error instanceof Error ? error.message : "unknown"}`.slice(0, 1_000),
        advisory: false, validatorVersion: ACCEPTANCE_VALIDATOR_VERSION };
    }
  });
  const failures = acceptanceResults.filter(item => !item.passed).map(item => item.description);
  return { ...task, result, acceptanceResults, failures, stage: failures.length ? "failed" : "verified" };
}

export interface CapabilityStandard {
  capability: string; version: string; description: string; requiresConfirmation: boolean;
  allowedSideEffects: string[]; inputContract: string; outputContract: string; confirmationPolicy: string;
  idempotencyRule: string; retryPolicy: string; followUpPolicy: string;
  contextTypes: string[];
  allowedTools: string[];
  reasoningEffort: "low" | "medium" | "high";
  maxCalls: number;
  maxRetries: number;
  programmaticAcceptance: string[];
  semanticAcceptance: string[];
  failurePolicy: "retry" | "awaiting_user" | "follow_up";
  acceptance: (input: unknown) => AcceptanceCheck[];
}

export type DeclarativeRule = {
  id: string; description: string;
  type: "required" | "min_items" | "equals" | "regex" | "contains_all" | "count_equals" | "https_sources" | "time_range" | "receipt" | "unique" | "semantic_advisory";
  path: string; expectedPath?: string; value?: unknown; minimum?: number; pattern?: string; fields?: string[];
};

const standards = new Map<string, Map<string, CapabilityStandard>>();
const activeVersions = new Map<string, string>();

export function registerCapabilityStandard(standard: CapabilityStandard): void {
  const versions = standards.get(standard.capability) || new Map<string, CapabilityStandard>();
  if (versions.has(standard.version)) throw new Error(`agent_standard_already_registered:${standard.capability}@${standard.version}`);
  versions.set(standard.version, standard);
  standards.set(standard.capability, versions);
  if (!activeVersions.has(standard.capability)) activeVersions.set(standard.capability, standard.version);
}

export function capabilityStandard(capability: string, version?: string): CapabilityStandard | undefined {
  const versions = standards.get(capability);
  return versions?.get(version || activeVersions.get(capability) || "");
}

export function activeCapabilityVersion(capability: string): string | undefined { return activeVersions.get(capability); }

export function activateCapabilityStandard(capability: string, version: string): void {
  if (!standards.get(capability)?.has(version)) throw new Error(`agent_standard_missing:${capability}@${version}`);
  activeVersions.set(capability, version);
}

export function createCapabilityTask<TInput, TResult>(params: {
  id: string; capability: string; input: TInput; standardVersion?: string; requiresConfirmation?: boolean;
}): AgentTask<TInput, TResult> {
  const standard = capabilityStandard(params.capability, params.standardVersion);
  if (!standard) throw new Error(`agent_standard_missing:${params.capability}@${params.standardVersion || "active"}`);
  return createAgentTask({ ...params, acceptance: standard.acceptance(params.input) });
}

export function registeredCapabilities(): Array<Omit<CapabilityStandard, "acceptance">> {
  return [...standards.keys()].flatMap(capability => {
    const standard = capabilityStandard(capability);
    if (!standard) return [];
    const { acceptance: _acceptance, ...publicStandard } = standard;
    return [publicStandard];
  });
}

function atPath(root: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, "");
  if (!clean) return root;
  return clean.split(".").reduce<unknown>((value, key) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

const compact = (value: unknown) => String(value ?? "").replace(/[\s，。！？、,.!?：:]/g, "").toLowerCase();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function declarativeOutcome(rule: DeclarativeRule, input: unknown, result: unknown): AcceptanceEvidence {
  const root = { input, result };
  const actual = atPath(root, rule.path);
  const expected = rule.expectedPath ? atPath(root, rule.expectedPath) : rule.value;
  let passed = false;
  if (rule.type === "required") passed = actual != null && (typeof actual !== "string" || actual.trim().length > 0);
  if (rule.type === "min_items") passed = array(actual).length >= Math.max(0, Number(rule.minimum || 1));
  if (rule.type === "equals") passed = JSON.stringify(actual) === JSON.stringify(expected);
  if (rule.type === "regex") {
    const pattern = String(rule.pattern || "").slice(0, 300);
    passed = pattern.length > 0 && new RegExp(pattern, "u").test(String(actual ?? ""));
  }
  if (rule.type === "contains_all") {
    const candidates = array(actual).map(compact);
    passed = array(expected).every(item => candidates.some(candidate => candidate.includes(compact(item))));
  }
  if (rule.type === "count_equals") passed = array(actual).length === Number(expected);
  if (rule.type === "https_sources") passed = array(actual).filter(item => /^https:\/\//.test(String((item as { url?: unknown })?.url || item))).length >= Math.max(1, Number(rule.minimum || 1));
  if (rule.type === "time_range") passed = typeof actual === "string" && !Number.isNaN(new Date(actual).getTime())
    && (!expected || new Date(actual).getTime() >= new Date(String(expected)).getTime());
  if (rule.type === "receipt") passed = actual != null && typeof actual === "object"
    && (rule.fields || ["id"]).every(field => Boolean(atPath(actual, field)));
  if (rule.type === "unique") { const values = array(actual).map(item => JSON.stringify(item)); passed = values.length > 0 && new Set(values).size === values.length; }
  if (rule.type === "semantic_advisory") return { passed: true, advisory: true, actual, expected, reason: "语义评审仅作辅助证据" };
  return { passed, actual, expected, evidence: { path: rule.path, type: rule.type }, reason: passed ? "声明式规则通过" : "声明式规则未满足" };
}

export function validateDeclarativeRules(value: unknown): DeclarativeRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error("acceptance_rules_invalid");
  const allowed = new Set<DeclarativeRule["type"]>(["required", "min_items", "equals", "regex", "contains_all", "count_equals", "https_sources", "time_range", "receipt", "unique", "semantic_advisory"]);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("acceptance_rule_invalid");
    const rule = item as Partial<DeclarativeRule>;
    if (!rule.id || !rule.description || !rule.type || !allowed.has(rule.type) || !/^((input|result)(\.[a-zA-Z0-9_]+)*)$/.test(String(rule.path || ""))) throw new Error(`acceptance_rule_invalid:${index}`);
    if (rule.type === "receipt" && !String(rule.path).startsWith("result._verifiedReceipts.")) throw new Error(`acceptance_receipt_path_untrusted:${index}`);
    if (rule.expectedPath && !/^((input|result)(\.[a-zA-Z0-9_]+)*)$/.test(rule.expectedPath)) throw new Error(`acceptance_rule_expected_path_invalid:${index}`);
    // Generated patterns run in the server process. Keep the DSL regex subset linear-time:
    // literals, character classes, anchors and alternation only; no repetition quantifiers.
    if (rule.pattern && (rule.pattern.length > 300 || /[+*{}]|\(\?/.test(rule.pattern))) throw new Error(`acceptance_rule_pattern_unsafe:${index}`);
    return { id: String(rule.id).slice(0, 100), description: String(rule.description).slice(0, 500), type: rule.type,
      path: String(rule.path), ...(rule.expectedPath ? { expectedPath: rule.expectedPath } : {}),
      ...(rule.value !== undefined ? { value: safeEvidence(rule.value) } : {}),
      ...(rule.minimum !== undefined ? { minimum: Math.min(100, Math.max(0, Number(rule.minimum))) } : {}),
      ...(rule.pattern ? { pattern: rule.pattern } : {}),
      ...(rule.fields ? { fields: rule.fields.slice(0, 20).map(field => String(field).slice(0, 100)) } : {}) };
  });
}

export function generatedCapabilityStandard(base: CapabilityStandard, version: string, rawRules: unknown): CapabilityStandard {
  const rules = validateDeclarativeRules(rawRules);
  const ids = [...base.acceptance({}).map(item => item.id), ...rules.map(rule => rule.id)];
  if (new Set(ids).size !== ids.length) throw new Error("acceptance_rule_id_duplicate");
  return { ...base, version, description: `${base.description}（失败驱动升级）`, acceptance: input => [
    ...base.acceptance(input),
    ...rules.map(rule => ({ id: rule.id, description: rule.description, check: (result: unknown) => declarativeOutcome(rule, input, result) })),
  ] };
}

export function registerGeneratedCapabilityStandard(baseCapability: string, baseVersion: string, version: string, rules: unknown): CapabilityStandard {
  const existing = capabilityStandard(baseCapability, version);
  if (existing) return existing;
  const base = capabilityStandard(baseCapability, baseVersion);
  if (!base) throw new Error(`agent_standard_base_missing:${baseCapability}@${baseVersion}`);
  const generated = generatedCapabilityStandard(base, version, rules);
  registerCapabilityStandard(generated);
  return generated;
}
