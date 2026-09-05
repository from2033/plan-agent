import assert from "node:assert/strict";
import test from "node:test";
import { createContextPack, getContextPack } from "../src/context-packs.js";

test("ContextPack 只保留六条相关对话、六条证据和四个依赖输出", () => {
  const userId = `context-pack-${Date.now()}`;
  const pack = createContextPack(userId, {
    runId: "run-1",
    stepId: "step-1",
    capabilityRef: "knowledge_answer@1.0",
    originalRequest: "结合资料回答",
    facts: { locale: "zh-CN" },
    conversation: Array.from({ length: 9 }, (_, id) => ({ id })),
    evidence: Array.from({ length: 9 }, (_, id) => ({ id })),
    dependencies: Array.from({ length: 7 }, (_, id) => ({ id })),
    failureDelta: { failedCheck: "source_required" },
  });
  assert.deepEqual(pack.conversation.map(item => item.id), [3, 4, 5, 6, 7, 8]);
  assert.equal(pack.evidence.length, 6);
  assert.equal(pack.dependencies.length, 4);
  assert.equal(getContextPack(pack.id, "another-user"), null);
});
