import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-mistakes-test-"));
const databasePath = path.join(temporaryDir, "data.db");
process.env.DB_PATH = databasePath;
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const {
  deleteMistake,
  getMistake,
  insertMistake,
  listMistakes,
  reviewMistake,
} = await import("../src/mistakes.js");

test("错题按账号隔离且敏感文字加密存储", () => {
  const created = insertMistake("parent-1", {
    childName: "小明",
    subject: "数学",
    grade: "三年级",
    knowledgePoint: "分数加减",
    problem: "二分之一加四分之一等于多少？",
    wrongAnswer: "六分之二",
    correctAnswer: "四分之三",
    explanation: "先通分，再相加。",
    errorType: "概念不清",
  });

  assert.equal(created.childName, "小明");
  assert.equal(created.mastery, "learning");
  assert.equal(listMistakes("parent-1").length, 1);
  assert.equal(listMistakes("parent-2").length, 0);
  assert.equal(getMistake(created.id, "parent-2"), null);

  const raw = new DatabaseSync(databasePath).prepare(
    "SELECT child_name,problem,correct_answer FROM mistakes WHERE id=?",
  ).get(created.id) as { child_name: string; problem: string; correct_answer: string };
  assert.match(raw.child_name, /^enc1:/);
  assert.match(raw.problem, /^enc1:/);
  assert.match(raw.correct_answer, /^enc1:/);
  assert.doesNotMatch(JSON.stringify(raw), /小明|二分之一|四分之三/);
  const knowledge = new DatabaseSync(databasePath).prepare(
    "SELECT title,content FROM knowledge WHERE id=? AND user_id=?",
  ).get(created.id, "parent-1") as { title: string; content: string };
  assert.match(knowledge.title, /^enc1:/);
  assert.match(knowledge.content, /^enc1:/);
});

test("每次复习留下记录并同步掌握状态", () => {
  const item = listMistakes("parent-1")[0];
  const hard = reviewMistake(item.id, "parent-1", "hard", "通分还不熟");
  assert.equal(hard?.mastery, "review");
  assert.equal(hard?.reviewCount, 1);
  assert.equal(hard?.reviews[0].note, "通分还不熟");

  const good = reviewMistake(item.id, "parent-1", "good");
  assert.equal(good?.mastery, "mastered");
  assert.equal(good?.reviewCount, 2);
  assert.equal(good?.reviews.length, 2);
  assert.equal(reviewMistake(item.id, "parent-2", "good"), null);
});

test("删除错题同时删除复习记录", () => {
  const item = listMistakes("parent-1")[0];
  assert.equal(deleteMistake(item.id, "parent-2"), false);
  assert.equal(deleteMistake(item.id, "parent-1"), true);
  assert.equal(getMistake(item.id, "parent-1"), null);
  const count = new DatabaseSync(databasePath).prepare(
    "SELECT COUNT(*) AS count FROM mistake_reviews WHERE mistake_id=?",
  ).get(item.id) as { count: number };
  assert.equal(count.count, 0);
  const knowledgeCount = new DatabaseSync(databasePath).prepare(
    "SELECT COUNT(*) AS count FROM knowledge WHERE id=?",
  ).get(item.id) as { count: number };
  assert.equal(knowledgeCount.count, 0);
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
