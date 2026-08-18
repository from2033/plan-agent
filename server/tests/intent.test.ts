import assert from "node:assert/strict";
import test from "node:test";

import { knowledgeIntentHint } from "../src/intent.js";

test("知识库的常见语音误识别仍识别为保存", () => {
  assert.equal(knowledgeIntentHint("记录到芝士库红烧肉一开始不能放盐。"), "save");
});

test("自然表述的可复用烹饪经验识别为保存", () => {
  assert.equal(knowledgeIntentHint("红烧肉不能一开始放盐的。"), "save");
  assert.equal(knowledgeIntentHint("做鱼最好最后再放盐。"), "save");
});

test("个人临时安排不会误存知识库", () => {
  assert.equal(knowledgeIntentHint("我今天不能去公司。"), undefined);
  assert.equal(knowledgeIntentHint("明天不要忘记买菜。"), undefined);
  assert.equal(knowledgeIntentHint("刚才做了红烧肉。"), undefined);
});
