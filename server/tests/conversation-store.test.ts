import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const testDir = mkdtempSync(path.join(tmpdir(), "daynote-conversations-"));
process.env.DB_PATH = path.join(testDir, "data.db");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const conversations = await import("../src/conversation-store.js");

test("每个账号有独立的我与 AI 会话，不能跨账号读取", () => {
  const first = conversations.ensureDirectAiConversation("First@Example.com");
  const firstAgain = conversations.ensureDirectAiConversation("first@example.com");
  const second = conversations.ensureDirectAiConversation("second@example.com");
  assert.equal(firstAgain, first);
  assert.notEqual(second, first);
  assert.equal(conversations.listConversationMessages(first, "second@example.com"), null);
});

test("提问、回答和引用资料形成连续的加密消息", () => {
  const userId = "first@example.com";
  const jobId = crypto.randomUUID();
  const conversationId = conversations.beginAiInteraction(
    userId,
    jobId,
    "今天的家长会讲了什么？",
    "voice",
  );
  assert.equal(conversations.completeAiInteraction(userId, jobId, "ingest", {
    kind: "ask",
    answer: "主要讲了开学适应和校园安全。",
    sources: [{ id: crypto.randomUUID(), title: "秋季开学家长会", category: "会议录音" }],
  }), true);

  const messages = conversations.listConversationMessages(conversationId, userId)!;
  assert.deepEqual(messages.map(message => message.senderType), ["user", "assistant"]);
  assert.equal(messages[0]?.content, "今天的家长会讲了什么？");
  assert.equal(messages[0]?.metadata.inputMode, "voice");
  assert.equal(messages[1]?.content, "主要讲了开学适应和校园安全。");
  assert.equal((messages[1]?.metadata.sources as unknown[]).length, 1);

  const rawDb = new DatabaseSync(process.env.DB_PATH!, { readOnly: true });
  const stored = rawDb.prepare("SELECT content FROM conversation_messages WHERE id=?")
    .get(`assistant-${jobId}`) as { content: string };
  assert.match(stored.content, /^enc1:/);
  assert.doesNotMatch(stored.content, /校园安全/);
});

test("记录和保存动作也留下 AI 回执，失败任务保留失败状态", () => {
  const userId = "first@example.com";
  const recordJob = crypto.randomUUID();
  conversations.beginAiInteraction(userId, recordJob, "明天提醒我报名", "text");
  conversations.completeAiInteraction(userId, recordJob, "ingest", {
    kind: "record",
    entries: [{ id: "entry-1", description: "报名" }],
  });
  const failedJob = crypto.randomUUID();
  const conversationId = conversations.beginAiInteraction(userId, failedJob, "再查一下", "text");
  assert.equal(conversations.failAiInteraction(userId, failedJob), true);
  const messages = conversations.listConversationMessages(conversationId, userId)!;
  assert.equal(messages.at(-2)?.content, "已记录：报名");
  assert.equal(messages.at(-1)?.status, "failed");
});
