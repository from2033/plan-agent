import assert from "node:assert/strict";
import test from "node:test";

import { knowledgeIntentHint, researchTopic } from "../src/intent.js";

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

test("显式研究指令提取主题但不拦截个人资料查询", () => {
  assert.equal(
    researchTopic("帮我研究下湿疹是怎么回事，原理和怎么调整"),
    "湿疹是怎么回事，原理和怎么调整",
  );
  assert.equal(researchTopic("帮我深入查一下现在黄金上涨的原因"), "现在黄金上涨的原因");
  assert.equal(researchTopic("帮我研究一下现在黄金上涨的原因"), "现在黄金上涨的原因");
  assert.equal(researchTopic("再研究下湿疹水泡"), "湿疹水泡");
  assert.equal(researchTopic("帮我再研究下湿疹水泡"), "湿疹水泡");
  assert.equal(researchTopic("继续研究一下湿疹水泡"), "湿疹水泡");
  assert.equal(researchTopic("在研究下湿疹水泡"), "湿疹水泡");
  assert.equal(researchTopic("你再研究下", [
    { role: "user", content: "湿疹水泡是怎么回事？" },
    { role: "assistant", content: "现有资料中没有找到足够信息。" },
  ]), "湿疹水泡是怎么回事？");
  assert.equal(researchTopic("继续研究一下", [
    { role: "user", content: "帮我查查南京学校开学时间" },
  ]), "帮我查查南京学校开学时间");
  assert.equal(researchTopic("你再研究下"), null);
  assert.equal(researchTopic("帮我查一下最近的开学时间是几号回去"), null);
  assert.equal(researchTopic("查询一下最近的开学时间"), null);
  assert.equal(researchTopic("帮我查一下我的资料里的租赁合同"), null);
  assert.equal(researchTopic("今天吃了什么"), null);
});

test("短语式联系人查询识别为资料查找", () => {
  assert.equal(knowledgeIntentHint("英语老师电话号码"), "ask");
});
