import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-actions-test-"));
process.env.DB_PATH = path.join(temporaryDir, "data.db");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { shouldSuggestMediaResearch } = await import("../src/assistant-actions.js");

test("会议资料中的普通查询表达不会被误判为电影上映研究", () => {
  assert.equal(
    shouldSuggestMediaResearch(
      "讨论了医疗费用，需要再查一下报销记录",
      "医疗费用及治疗讨论会议录音",
    ),
    false,
  );
});

test("明确询问影视上映时间时仍可生成待确认研究", () => {
  assert.equal(
    shouldSuggestMediaResearch("帮我查一下什么时候上映", "电影浪浪山小妖怪"),
    true,
  );
});

test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
