import assert from "node:assert/strict";
import test from "node:test";

import {
  WORLD_PULSE_SECTION_IDS,
  parseChinaPolicyJson,
  parseChinaPolicyPreviewHtml,
  parseGoogleNewsRss,
  parseHackerNewsHits,
  parseNfraJson,
  parseOfficialHtmlList,
  parseSitemap,
  parseSyndicationFeed,
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

test("官网 RSS 和 Atom 统一标记为一手权威来源", () => {
  const xml = `<rss><channel><item><title>央行发布住房金融新规</title>
    <link>https://official.example/policy/1</link><pubDate>Fri, 28 Aug 2026 03:00:00 GMT</pubDate>
  </item></channel></rss>`;
  assert.deepEqual(parseSyndicationFeed(xml, "示例监管机构"), [{
    title: "央行发布住房金融新规",
    source: "示例监管机构",
    url: "https://official.example/policy/1",
    publishedAt: "2026-08-28T03:00:00.000Z",
    verification: "official",
    sourceTier: "authority",
  }]);
});

test("官网站点地图只收录指定栏目", () => {
  const xml = `<urlset>
    <url><loc>https://example.com/news/important-update</loc><lastmod>2026-08-28</lastmod></url>
    <url><loc>https://example.com/careers/job</loc><lastmod>2026-08-28</lastmod></url>
  </urlset>`;
  const items = parseSitemap(xml, "示例公司", /\/news\//);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "important update");
  assert.equal(items[0].sourceTier, "authority");
});

test("官网列表解析相对链接、标题和发布日期", () => {
  const html = `<div><a href="/sj/zxfb/202608/report.html" title="七月份国民经济运行情况">摘要</a>
    <span>2026-08-28</span></div>`;
  const items = parseOfficialHtmlList(html, "国家统计局", "https://www.stats.gov.cn/sj/zxfb/", /\/sj\/zxfb\/\d{6}\//);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://www.stats.gov.cn/sj/zxfb/202608/report.html");
  assert.equal(items[0].verification, "official");
});

test("热点讨论只有达到热度门槛才作为未核验线索进入", () => {
  const items = parseHackerNewsHits({ hits: [
    { objectID: "1", title: "Anthropic publishes a long essay", created_at: "2026-08-28T10:00:00Z", points: 35, num_comments: 12 },
    { objectID: "2", title: "Low interest post", created_at: "2026-08-28T10:00:00Z", points: 2, num_comments: 1 },
  ] });
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceTier, "hotspot");
  assert.equal(items[0].verification, "unverified");
});

test("金融监管总局接口转换为可核验的一手来源", () => {
  const items = parseNfraJson({ data: { rows: [{
    docId: 1270032,
    docTitle: "国家金融监督管理总局发布房地产相关融资管理办法",
    publishDate: "2026-08-28 19:19:11",
    generaltype: "0",
  }] } });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "国家金融监督管理总局");
  assert.equal(items[0].sourceTier, "authority");
  assert.match(items[0].url, /docId=1270032/);
});
