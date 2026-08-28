import assert from "node:assert/strict";
import test from "node:test";

import { parseGoogleNewsRss } from "../src/world-pulse.js";

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
