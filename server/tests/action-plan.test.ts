import assert from "node:assert/strict";
import test from "node:test";
import { buildActionPlan, getActionPlan, saveActionPlan, updatePlanItem } from "../src/action-plan.js";
import { createPersistentAgentTask, transitionPersistentAgentTask, verifyPersistentAgentTask } from "../src/agent-runtime.js";

const birthdayRequest = "宝宝生日准备安排在中秋，你再去看下南京大厂周边有没有适合的地方";

test("复合生日输入生成日期、待办、研究和反馈四项计划", () => {
  const plan = buildActionPlan(birthdayRequest, "2026-09-01");
  assert.deepEqual(plan.actions.map((item) => item.kind), ["resolve_date", "todo", "research", "feedback"]);
  assert.ok(plan.actions.every((item) => item.required && item.evidence.length > 0));
  assert.match(plan.actions.find((item) => item.kind === "research")?.instruction || "", /南京大厂/);
});

test("计划项未全部验收时父任务不能完成", () => {
  const userId = `plan-incomplete-${Date.now()}`;
  const task = createPersistentAgentTask(userId, "input_orchestration", { title: birthdayRequest, raw: birthdayRequest });
  transitionPersistentAgentTask(userId, task.id, "classified", "classified");
  transitionPersistentAgentTask(userId, task.id, "extracted", "extracted");
  transitionPersistentAgentTask(userId, task.id, "executing", "executing");
  const plan = saveActionPlan(userId, task.id, birthdayRequest, "2026-09-01");
  transitionPersistentAgentTask(userId, task.id, "verifying", "incorrectly_finished");
  const failed = verifyPersistentAgentTask(userId, task.id, plan);
  assert.equal(failed?.stage, "failed");
  assert.ok(failed?.failures.some((failure) => /必要要求/.test(failure)));
});

test("计划全部逐项通过后父任务才能通过，并保持账号隔离", () => {
  const userId = `plan-complete-${Date.now()}`;
  const task = createPersistentAgentTask(userId, "input_orchestration", { title: birthdayRequest, raw: birthdayRequest });
  transitionPersistentAgentTask(userId, task.id, "classified", "classified");
  transitionPersistentAgentTask(userId, task.id, "extracted", "extracted");
  transitionPersistentAgentTask(userId, task.id, "executing", "executing");
  const plan = saveActionPlan(userId, task.id, birthdayRequest, "2026-09-01");
  for (const item of plan.planItems) updatePlanItem(userId, item.id, "verified", { ok: true });
  const complete = getActionPlan(userId, task.id)!;
  assert.equal(complete.coverageStatus, "complete");
  assert.deepEqual(complete.missingRequirements, []);
  assert.equal(getActionPlan("other-user", task.id), null);
  transitionPersistentAgentTask(userId, task.id, "verifying", "all_children_verified", complete);
  assert.equal(verifyPersistentAgentTask(userId, task.id, complete)?.stage, "verified");
});
