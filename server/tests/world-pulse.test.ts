import assert from "node:assert/strict";
import test from "node:test";

import {
  WORLD_PULSE_SECTION_IDS,
  parseChinaPolicyJson,
  parseChinaPolicyPreviewHtml,
  parseGoogleNewsRss,
} from "../src/world-pulse.js";

test("趋势栏目包含用户长期关心的程序员、AI 和南京楼市", () => {
  assert.ok(WORLD_PULSE_SECTION_IDS.includes("china_programmer_jobs"));
  assert.ok(WORLD_PULSE_SECTION_IDS.includes("ai_development"));
  assert.ok(WORLD_PULSE_SECTION_IDS.includes("nanjing_housing"));
  assert.equal(new Set(WORLD_PULSE_SECTION_IDS).size, WORLD_PULSE_SECTION_IDS.length);
});

test("Google News RSS 保留标题、来源、链接和时间", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>英伟达发布新芯片 - 示例媒体</title>
    <link>https://news.google.com/articles/abc?x=1&amp;y=2</link>
    <pubDate>Fri, 28 Aug 2026 11:13:14 GMT</pubDate>
    <source url="https://example.com">示例媒体</source>
  </item></channel></rss>`;
  assert.deepEqual(parseGoogleNewsRss(xml), [{
    title: "英伟达发布新芯片",
    source: "示例媒体",
    url: "https://news.google.com/articles/abc?x=1&y=2",
    publishedAt: "2026-08-28T11:13:14.000Z",
  }]);
});

test("中国政府网政策数据优先显示与民生和产业有关的正式政策", () => {
  const items = parseChinaPolicyJson([
    { TITLE: "关于授予英雄荣誉称号的决定", URL: "https://www.gov.cn/a", DOCRELPUBTIME: "2026-08-25" },
    { TITLE: "国务院关于修改住房公积金管理条例的决定", URL: "https://www.gov.cn/b", DOCRELPUBTIME: "2026-08-18" },
  ]);
  assert.equal(items[0].title, "国务院关于修改住房公积金管理条例的决定");
  assert.equal(items[0].source, "中国政府网");
});

test("政策风向只收录仍在进行中的官方征求意见", () => {
  const html = `<ul>
    <li><a href="https://ndrc.example/a" title="【进行中】关于《对外投资管理办法》公开征求意见">进行中</a><span>2026/08/21</span></li>
    <li><a href="https://ndrc.example/b" title="某办法公开征求意见[已结束]">已结束</a><span>2026/07/15</span></li>
  </ul>`;
  assert.deepEqual(parseChinaPolicyPreviewHtml(html).map(item => item.title), [
    "关于《对外投资管理办法》公开征求意见",
  ]);
});
