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

test("专题对话可邀请成员，接受后共享群消息和指定资料", () => {
  const owner = "owner@example.com";
  const member = "member@example.com";
  const conversationId = conversations.createConversation(owner, "孩子入学");
  assert.deepEqual(conversations.conversationDocumentGrants(conversationId, owner), []);
  const invitation = conversations.inviteConversationMember(conversationId, owner, member);
  assert.ok(invitation);
  assert.equal(conversations.listConversationMessages(conversationId, member), null);
  assert.equal(conversations.listConversationInvitations(member).length, 1);
  assert.equal(
    conversations.respondToConversationInvitation(invitation!.id, member, true),
    conversationId,
  );
  assert.equal(conversations.listConversationMembers(conversationId, member)?.length, 2);

  const documentId = crypto.randomUUID();
  assert.equal(conversations.addConversationResource(
    conversationId,
    owner,
    "document",
    documentId,
    owner,
  ), true);
  assert.deepEqual(
    conversations.sharedConversationResourcesForViewer(member, "document"),
    [{ resourceId: documentId, ownerUserId: owner }],
  );

  const jobId = crypto.randomUUID();
  conversations.beginAiInteraction(member, jobId, "学校几点报到？", "text", conversationId);
  conversations.completeAiInteraction(member, jobId, "ingest", {
    kind: "ask",
    answer: "上午八点报到。",
    sources: [],
  });
  const messages = conversations.listConversationMessages(conversationId, owner)!;
  assert.equal(messages.at(-2)?.senderUserId, member);
  assert.equal(messages.at(-1)?.content, "上午八点报到。");
  assert.equal(messages.some(message => message.content.startsWith("分享了资料：")), true);
  const context = conversations.conversationContextForAi(conversationId, owner)!;
  assert.equal(context.some(message => message.content === "分享了资料：资料"), true);
  assert.equal(context.at(-1)?.content, "上午八点报到。");
});

test("新对话在首次 AI 回答后自动生成标题，私人对话也可中途邀请", () => {
  const owner = "title-owner@example.com";
  const conversationId = conversations.createConversation(owner);
  const jobId = crypto.randomUUID();
  conversations.beginAiInteraction(owner, jobId, "八月三十一日学校报到要准备什么？", "text", conversationId);
  conversations.completeAiInteraction(owner, jobId, "ingest", {
    kind: "ask",
    answer: "请准备录取材料。",
    sources: [],
    conversationTitle: "学校报到准备",
  });
  assert.equal(conversations.listConversations(owner, "学校报到").some(item => item.id === conversationId), true);
  assert.equal(conversations.listConversations(owner, "录取材料").some(item => item.id === conversationId), true);
  assert.equal(conversations.listConversations(owner, "不存在的关键词").length, 0);
  assert.equal(
    conversations.listConversations(owner).find(item => item.id === conversationId)?.title,
    "学校报到准备",
  );

  const correctionJobId = crypto.randomUUID();
  conversations.beginAiInteraction(owner, correctionJobId, "总结下这个资料", "text", conversationId);
  conversations.completeAiInteraction(owner, correctionJobId, "ingest", {
    kind: "ask",
    answer: "家长会说明了报到安排。",
    sources: [],
    conversationTitle: "家长会资料总结",
  });
  assert.equal(
    conversations.listConversations(owner).find(item => item.id === conversationId)?.title,
    "家长会资料总结",
  );

  const direct = conversations.ensureDirectAiConversation(owner);
  const invitation = conversations.inviteConversationMember(
    direct,
    owner,
    "title-member@example.com",
  );
  assert.ok(invitation);
});

test("创建者可删除整段对话，成员删除时只退出", () => {
  const owner = "delete-owner@example.com";
  const member = "delete-member@example.com";
  const ownedConversation = conversations.createConversation(owner, "待删除对话");
  const invitation = conversations.inviteConversationMember(ownedConversation, owner, member)!;
  conversations.respondToConversationInvitation(invitation.id, member, true);
  assert.equal(conversations.deleteConversation(ownedConversation, member), true);
  assert.equal(conversations.listConversationMessages(ownedConversation, member), null);
  assert.notEqual(conversations.listConversationMessages(ownedConversation, owner), null);

  assert.equal(conversations.deleteConversation(ownedConversation, owner), true);
  assert.equal(conversations.listConversationMessages(ownedConversation, owner), null);
  assert.equal(conversations.deleteConversation(ownedConversation, owner), false);
});
