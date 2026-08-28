export interface WorldNewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface WorldPulseSection {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  watchNext: string;
  items: WorldNewsItem[];
}

export interface WorldPulse {
  updatedAt: string;
  stale: boolean;
  sections: WorldPulseSection[];
}

interface SectionDefinition {
  id: string;
  title: string;
  query?: string;
  priorityTerms: string[];
  whyItMatters: string;
  watchNext: string;
}

const GOOGLE_NEWS_BASE = "https://news.google.com/rss";
const CACHE_MS = 5 * 60 * 1000;
const MIN_FORCE_INTERVAL_MS = 60 * 1000;

const sections: SectionDefinition[] = [
  {
    id: "ai",
    title: "AI 与科技",
    query: "英伟达 OR OpenAI OR 人工智能 OR 半导体 when:1d",
    priorityTerms: ["英伟达", "NVIDIA", "OpenAI", "芯片", "大模型", "人工智能"],
    whyItMatters: "决定算力需求、科技公司资本开支和下一轮生产力变化。",
    watchNext: "重点看芯片供给、云厂商投入、模型能力和监管政策是否出现方向性变化。",
  },
  {
    id: "macro",
    title: "美债与全球宏观",
    query: "美债 OR 美联储 OR 美元 OR 美国通胀 when:1d",
    priorityTerms: ["美联储", "美债", "降息", "加息", "通胀", "美元", "收益率"],
    whyItMatters: "美债收益率和美元会影响全球资金成本、股票估值与各国汇率。",
    watchNext: "重点看美联储表态、通胀和就业数据，以及长端美债收益率的持续方向。",
  },
  {
    id: "markets",
    title: "黄金与大宗商品",
    query: "黄金 OR 金价 OR 原油 OR 大宗商品 when:1d",
    priorityTerms: ["黄金", "金价", "原油", "OPEC", "大宗商品", "央行购金"],
    whyItMatters: "黄金反映避险和货币预期，原油及大宗商品会传导到通胀和企业成本。",
    watchNext: "重点看实际利率、美元、央行购金、地缘风险和能源供应变化。",
  },
  {
    id: "world",
    title: "国际局势",
    query: "国际局势 OR 地缘政治 OR 中东 OR 俄乌 OR 全球贸易 when:1d",
    priorityTerms: ["冲突", "战争", "停火", "制裁", "关税", "贸易", "中东", "俄乌"],
    whyItMatters: "重大政策、冲突和贸易变化可能迅速改变供应链、市场风险偏好与产业方向。",
    watchNext: "重点区分一次性事件与持续趋势，并观察是否出现跨市场和跨地区影响。",
  },
];

let cached: WorldPulse | null = null;
let cachedAt = 0;
let activeFetch: Promise<WorldPulse> | null = null;

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

export function parseGoogleNewsRss(xml: string): WorldNewsItem[] {
  const items: WorldNewsItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const source = tag(block, "source") || "未知来源";
    const rawTitle = tag(block, "title");
    const title = rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3)).trim()
      : rawTitle;
    const url = tag(block, "link");
    const published = new Date(tag(block, "pubDate"));
    if (!title || !url || !/^https:\/\//i.test(url)) continue;
    items.push({
      title: title.slice(0, 240),
      source: source.slice(0, 80),
      url,
      publishedAt: Number.isNaN(published.getTime())
        ? new Date().toISOString()
        : published.toISOString(),
    });
  }
  return items;
}

function feedUrl(definition: SectionDefinition): string {
  const url = new URL(GOOGLE_NEWS_BASE + (definition.query ? "/search" : ""));
  if (definition.query) url.searchParams.set("q", definition.query);
  url.searchParams.set("hl", "zh-CN");
  url.searchParams.set("gl", "CN");
  url.searchParams.set("ceid", "CN:zh-Hans");
  return url.toString();
}

async function fetchSection(definition: SectionDefinition): Promise<WorldPulseSection> {
  const response = await fetch(feedUrl(definition), {
    headers: { "user-agent": "Daynote/1.0 personal-news-reader" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`news_feed_${response.status}`);
  const parsed = parseGoogleNewsRss(await response.text());
  const seen = new Set<string>();
  const items = parsed
    .filter(item => {
      const key = item.title.replace(/\s+/g, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const score = (item: WorldNewsItem) => definition.priorityTerms
        .reduce((total, term) => total + (item.title.toLowerCase().includes(term.toLowerCase()) ? 1 : 0), 0);
      return score(right) - score(left)
        || Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
    })
    .slice(0, 6);
  const summary = items.length
    ? `最新线索：${items.slice(0, 2).map(item => item.title).join("；")}`
    : "暂时没有抓取到新的可靠标题，请稍后刷新。";
  return {
    id: definition.id,
    title: definition.title,
    summary,
    whyItMatters: definition.whyItMatters,
    watchNext: definition.watchNext,
    items,
  };
}

async function fetchFresh(): Promise<WorldPulse> {
  const results = await Promise.allSettled(sections.map(fetchSection));
  const pulseSections = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    const previous = cached?.sections.find(section => section.id === sections[index].id);
    return previous ? [previous] : [];
  });
  if (!pulseSections.length) throw new Error("world_news_unavailable");
  const value: WorldPulse = {
    updatedAt: new Date().toISOString(),
    stale: results.some(result => result.status === "rejected"),
    sections: pulseSections,
  };
  cached = value;
  cachedAt = Date.now();
  return value;
}

export async function getWorldPulse(force = false): Promise<WorldPulse> {
  const age = Date.now() - cachedAt;
  if (cached && age < CACHE_MS && (!force || age < MIN_FORCE_INTERVAL_MS)) return cached;
  if (activeFetch) return activeFetch;
  activeFetch = fetchFresh()
    .catch(error => {
      if (cached) return { ...cached, stale: true };
      throw error;
    })
    .finally(() => {
      activeFetch = null;
    });
  return activeFetch;
}
