import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-agent-runs-test-"));
process.env.DB_PATH = path.join(temporaryDir, "agent-runs.db");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const {
  bindAgentRun,
  completeAgentRunByJob,
  createAgentRun,
  getAgentRun,
  listAgentMessages,
  listAgentRuns,
} = await import("../src/agent-runs.js");

test("AgentRun 在提交后立即持久化并加密原始输入", () => {
  const run = createAgentRun("USER@EXAMPLE.COM", "今晚七点提醒我充电", {
    clientRequestId: "mobile-request-1",
    inputMode: "voice",
  });
  assert.equal(run.status, "received");
  assert.equal(run.userId, "user@example.com");
  assert.equal(run.raw, "今晚七点提醒我充电");

  const inspection = new DatabaseSync(process.env.DB_PATH!);
  const stored = inspection.prepare("SELECT raw_input FROM agent_runs WHERE id=?").get(run.id) as { raw_input: string };
  assert.match(stored.raw_input, /^enc1:/);
  assert.doesNotMatch(stored.raw_input, /提醒我充电/);
  inspection.close();
});

test("相同 clientRequestId 幂等复用同一个 AgentRun", () => {
  const first = createAgentRun("user-2", "查一下最近消费", { clientRequestId: "same-request" });
  const second = createAgentRun("user-2", "重复发送不应新建", { clientRequestId: "same-request" });
  assert.equal(second.id, first.id);
  assert.equal(second.raw, first.raw);
  assert.equal(listAgentRuns("user-2").length, 1);
});

test("晚到结果通过 jobId 回写并出现在统一时间线", () => {
  const run = createAgentRun("user-3", "一个需要很久的问题");
  bindAgentRun("user-3", run.id, { jobId: "job-late", rootTaskId: "legacy-task" });
  assert.equal(getAgentRun(run.id, "user-3")?.status, "queued");

  const result = { kind: "ask", answer: "这是晚到但不会丢失的答案。" };
  const completed = completeAgentRunByJob("user-3", "job-late", result);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.result, result);
  const messages = listAgentMessages(run.id, "user-3");
  assert.deepEqual(messages?.map(item => item.kind), ["input", "status", "status", "result"]);
  assert.equal(listAgentMessages(run.id, "another-user"), null);
});
