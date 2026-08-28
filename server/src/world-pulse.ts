export interface WorldNewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  context?: string;
  verification?: "official" | "multi_source" | "single_source" | "unverified";
}

export interface WorldPulseSection {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  watchNext: string;
  action?: string;
  items: WorldNewsItem[];
}

export interface WorldPulse {
  updatedAt: string;
  stale: boolean;
  sections: WorldPulseSection[];
  analysisStatus?: "PROCESSING" | "COMPLETE";
  overview?: string;
}

export interface WorldPulseAnalysis {
  overview: string;
  sections: Array<{
    id: string;
    summary: string;
    impact: string;
    outlook: string;
    action: string;
  }>;
}

export interface WorldPulseDiscovery {
  overview: string;
  events: Array<{
    sectionId: string;
    title: string;
    summary: string;
    whyItMatters: string;
    watchNext: string;
    verification: "official" | "multi_source" | "single_source" | "unverified";
    sources: Array<{
      title: string;
      publisher: string;
      url: string;
      publishedAt: string;
    }>;
  }>;
  discoveredAt: string;
}

interface SectionDefinition {
  id: string;
  title: string;
  query?: string;
  discoveryQueries?: string[];
  discoveryMaxAgeDays?: number;
  priorityTerms: string[];
  whyItMatters: string;
  watchNext: string;
}

const GOOGLE_NEWS_BASE = "https://news.google.com/rss";
const CHINA_POLICY_URL = "https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json";
const CHINA_POLICY_PREVIEW_URL = "https://www.ndrc.gov.cn/hdjl/yjzq/";
const CACHE_MS = 5 * 60 * 1000;
const MIN_FORCE_INTERVAL_MS = 60 * 1000;

const sections: SectionDefinition[] = [
  {
    id: "gold_impact",
    title: "世界变化对黄金的影响",
    query: "黄金 OR 美联储 OR 美债 OR 美元 OR 地缘冲突 OR 央行购金 when:2d",
    discoveryQueries: [
      "(黄金 OR 金价) (美联储 OR 美债 OR 美元 OR 通胀 OR 央行购金) when:2d",
      "(gold OR bullion) (Federal Reserve OR Treasury yields OR central bank buying) when:2d",
      "(战争 OR 制裁 OR 关税 OR 能源) (黄金 OR 避险) when:2d",
    ],
    discoveryMaxAgeDays: 3,
    priorityTerms: [
      "黄金", "金价", "美联储", "美债", "美元", "降息", "加息", "通胀",
      "央行购金", "冲突", "停火",
    ],
    whyItMatters: "黄金同时受美元、利率、通胀、央行购金和避险情绪影响，单条消息不能直接决定涨跌。",
    watchNext: "观察多个因素是否同向，并区分短期波动与中长期趋势；不把新闻摘要当成投资建议。",
  },
  {
    id: "china_housing",
    title: "中国房价与楼市走势",
    query: "中国房价 OR 楼市 OR 房地产政策 OR 二手房 OR 新房 when:7d",
    discoveryQueries: [
      "个人住房贷款 最长 40年 when:3d",
      "(房贷 OR 个人住房贷款 OR 首付 OR 公积金) (央行 OR 金融监管总局 OR 住建部) when:3d",
      "(房地产新政 OR 楼市政策 OR 住房政策) 中国 when:3d",
      "(房价 OR 二手房 OR 新房 OR 成交 OR 库存) 中国 when:7d",
    ],
    discoveryMaxAgeDays: 7,
    priorityTerms: [
      "房价", "楼市", "二手房", "新房", "成交", "库存", "房地产政策", "公积金",
      "一线城市", "核心城市",
    ],
    whyItMatters: "全国房价不是一个市场，需要同时看成交量、库存、城市分化和居民收入预期。",
    watchNext: "看核心城市成交能否持续、二手房价格是否企稳，以及政策是否真正改善购买力和预期。",
  },
  {
    id: "nanjing_housing",
    title: "南京房价与楼市走势",
    query: "南京房价 OR 南京楼市 OR 南京二手房 OR 南京新房 OR 南京房地产政策 when:14d",
    discoveryQueries: [
      "南京 (房贷 OR 公积金 OR 购房政策 OR 房地产新政) when:14d",
      "南京 (二手房 OR 新房 OR 房价 OR 成交 OR 挂牌 OR 土拍) when:14d",
    ],
    discoveryMaxAgeDays: 14,
    priorityTerms: [
      "南京", "房价", "二手房", "新房", "成交", "挂牌", "库存", "土拍",
      "公积金", "购房政策",
    ],
    whyItMatters: "南京不同板块、新房和二手房的表现可能差别很大，需要把成交量、挂牌量、价格和地方政策放在一起看。",
    watchNext: "重点看南京二手房成交与挂牌价格是否连续改善、热门与外围板块是否继续分化，以及本地政策的实际效果。",
  },
  {
    id: "china_programmer_jobs",
    title: "中国程序员市场与职场",
    query: "(程序员 OR 软件开发工程师 OR IT招聘) (就业 OR 招聘 OR 薪资 OR 裁员 OR 职场) 中国 when:7d",
    discoveryQueries: [
      "中国 (程序员 OR 软件工程师 OR 开发者) (招聘 OR 裁员 OR 薪资 OR 就业) when:7d",
      "(AI招聘 OR 人工智能岗位 OR 大模型人才 OR 应届生招聘) 中国 when:7d",
      "(developer jobs OR software engineer hiring OR tech layoffs) China when:7d",
    ],
    discoveryMaxAgeDays: 10,
    priorityTerms: [
      "程序员", "软件开发", "工程师", "招聘", "就业", "岗位", "薪资", "裁员",
      "校招", "社招", "外包", "技能",
    ],
    whyItMatters: "程序员市场变化直接影响岗位数量、技能要求、薪资和职业选择，但个别公司的招聘或裁员不能代表整个行业。",
    watchNext: "观察真实招聘岗位是否持续增加、哪些技术方向需求更稳定，并区分应届、资深、地域和行业差异。",
  },
  {
    id: "ai_development",
    title: "AI产业与技术发展",
    query: "人工智能 OR AI大模型 OR 智能体 OR AI芯片 OR 具身智能 OR 机器人 when:2d",
    discoveryQueries: [
      "(Dario Amodei OR Anthropic CEO) (essay OR longform OR views OR viral) when:14d",
      "(Anthropic OR OpenAI OR Google DeepMind OR 英伟达 OR Meta AI) when:3d",
      "(AI大模型 OR 智能体 OR AI芯片 OR 机器人 OR 具身智能) when:3d",
      "(AI长文 OR AI观点 OR 阅读量 OR 围观 OR 爆火) when:7d",
      "(AI essay OR AI launch OR AI research OR AI viral) when:3d",
    ],
    discoveryMaxAgeDays: 4,
    priorityTerms: [
      "人工智能", "AI", "大模型", "智能体", "芯片", "算力", "机器人", "开源",
      "应用", "产业",
    ],
    whyItMatters: "AI的发展会改变软件工作、企业效率和新的产品机会，需要区分技术演示、产品发布和真正大规模应用。",
    watchNext: "关注模型能力是否转化为稳定产品、企业是否真正付费使用，以及算力、成本、监管和人才需求的变化。",
  },
  {
    id: "international",
    title: "国际上真正重要的变化",
    query: "国际局势 OR 地缘政治 OR 全球经济 OR 国际贸易 OR 能源危机 when:2d",
    discoveryQueries: [
      "(战争 OR 停火 OR 制裁 OR 关税 OR 能源 OR 供应链) 国际 when:3d",
      "(global economy OR geopolitics OR sanctions OR tariffs OR energy) when:3d",
      "(美国 OR 欧盟 OR 俄罗斯 OR 中东 OR 日本) (政策 OR 经济 OR 冲突) when:3d",
    ],
    discoveryMaxAgeDays: 3,
    priorityTerms: [
      "冲突", "战争", "停火", "制裁", "关税", "贸易", "经济", "能源", "供应链",
      "选举", "政策",
    ],
    whyItMatters: "这里只保留可能影响中国、全球经济、能源或未来几年格局的事件，不收普通国际奇闻。",
    watchNext: "观察事件是否持续发酵，以及是否开始影响贸易、能源价格、供应链或中国政策。",
  },
];

export const WORLD_PULSE_SECTION_IDS = sections.map(section => section.id);

let cached: WorldPulse | null = null;
let cachedAt = 0;
let activeFetch: Promise<WorldPulse> | null = null;
let analysisHash = "";
let analysis: WorldPulseAnalysis | null = null;
let queuedAnalysisHash = "";
let queuedAnalysisAt = 0;
let discoveryDayKey = "";
let discovery: WorldPulseDiscovery | null = null;

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

export function parseChinaPolicyJson(value: unknown): WorldNewsItem[] {
  if (!Array.isArray(value)) return [];
  const priorityTerms = [
    "住房", "公积金", "教育", "医疗", "养老", "就业", "生育", "消费", "民生",
    "企业", "经济", "人工智能", "集成电路", "知识产权", "规划", "条例", "改革",
  ];
  const lowPriorityTerms = ["奖章", "荣誉称号", "历史文化名城", "承办", "采伐限额的复函"];
  return value
    .flatMap((entry): WorldNewsItem[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const title = String(item.TITLE || "").trim();
      const url = String(item.URL || "").trim();
      const date = String(item.DOCRELPUBTIME || "").trim();
      const published = new Date(`${date}T00:00:00+08:00`);
      if (!title || !/^https:\/\/www\.gov\.cn\//.test(url) || Number.isNaN(published.getTime())) return [];
      return [{ title, source: "中国政府网", url, publishedAt: published.toISOString() }];
    })
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const score = (item: WorldNewsItem) => priorityTerms
        .reduce((total, term) => total + (item.title.includes(term) ? 2 : 0), 0)
        - lowPriorityTerms.reduce((total, term) => total + (item.title.includes(term) ? 10 : 0), 0);
      return score(right.item) - score(left.item) || left.index - right.index;
    })
    .map(value => value.item)
    .slice(0, 6);
}

export function parseChinaPolicyPreviewHtml(html: string): WorldNewsItem[] {
  const items: WorldNewsItem[] = [];
  for (const match of html.matchAll(
    /<li>\s*<a\s+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<span>(\d{4}\/\d{2}\/\d{2})<\/span>\s*<\/li>/gi,
  )) {
    const url = decodeXml(match[1]);
    const title = decodeXml(match[2]);
    const published = new Date(`${match[3].replaceAll("/", "-")}T00:00:00+08:00`);
    if (!title.includes("进行中") || Number.isNaN(published.getTime())) continue;
    items.push({
      title: title.replace(/^【进行中】/, "").trim(),
      source: "国家发展改革委",
      url,
      publishedAt: published.toISOString(),
    });
  }
  return items.slice(0, 6);
}

function feedUrl(definition: SectionDefinition): string {
  const url = new URL(GOOGLE_NEWS_BASE + (definition.query ? "/search" : ""));
  if (definition.query) url.searchParams.set("q", definition.query);
  url.searchParams.set("hl", "zh-CN");
  url.searchParams.set("gl", "CN");
  url.searchParams.set("ceid", "CN:zh-Hans");
  return url.toString();
}

function queryFeedUrl(query: string): string {
  return feedUrl({
    id: "discovery",
    title: "discovery",
    query,
    priorityTerms: [],
    whyItMatters: "",
    watchNext: "",
  });
}

async function fetchNewsQuery(query: string): Promise<WorldNewsItem[]> {
  const response = await fetch(queryFeedUrl(query), {
    headers: { "user-agent": "Daynote/1.0 personal-news-reader" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`news_feed_${response.status}`);
  return parseGoogleNewsRss(await response.text());
}

async function fetchSection(definition: SectionDefinition): Promise<WorldPulseSection> {
  const parsed = await fetchNewsQuery(definition.query || "");
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

async function fetchChinaPolicySection(): Promise<WorldPulseSection> {
  const response = await fetch(CHINA_POLICY_URL, {
    headers: { "user-agent": "Daynote/1.0 personal-policy-reader" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`china_policy_${response.status}`);
  const items = parseChinaPolicyJson(await response.json());
  return {
    id: "china_policy",
    title: "中国最近出台的政策",
    summary: items.length
      ? `最近值得留意：${items.slice(0, 2).map(item => item.title).join("；")}`
      : "中国政府网暂未发布新的重要政策。",
    whyItMatters: "这里展示已经正式发布的中央政策，优先挑选与民生、经济、科技和企业相关的内容。",
    watchNext: "正式文件已经生效或进入执行阶段；是否直接影响你，还要看实施日期和地方配套细则。",
    items,
  };
}

async function fetchChinaPolicyPreviewSection(): Promise<WorldPulseSection> {
  const response = await fetch(CHINA_POLICY_PREVIEW_URL, {
    headers: { "user-agent": "Daynote/1.0 personal-policy-reader" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`china_policy_preview_${response.status}`);
  const items = parseChinaPolicyPreviewHtml(await response.text());
  return {
    id: "china_policy_preview",
    title: "可能将出台的政策",
    summary: items.length
      ? `官方正在征求意见：${items.slice(0, 2).map(item => item.title).join("；")}`
      : "目前没有抓取到正在进行的重要公开征求意见。",
    whyItMatters: "征求意见稿和官方预告可以提前看到政策方向，但它们还不是最终生效的政策。",
    watchNext: "关注征求意见结束后的正式文件；最终条款、发布时间和适用范围都可能变化。",
    items,
  };
}

async function fetchFresh(): Promise<WorldPulse> {
  const loaders = [
    ...sections.map(definition => () => fetchSection(definition)),
    fetchChinaPolicySection,
    fetchChinaPolicyPreviewSection,
  ];
  const sectionIds = [
    ...sections.map(section => section.id),
    "china_policy",
    "china_policy_preview",
  ];
  const results = await Promise.allSettled(loaders.map(load => load()));
  const pulseSections = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    const previous = cached?.sections.find(section => section.id === sectionIds[index]);
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
  if (cached && age < CACHE_MS && (!force || age < MIN_FORCE_INTERVAL_MS)) return withAnalysis(cached);
  if (activeFetch) return activeFetch;
  activeFetch = fetchFresh()
    .catch(error => {
      if (cached) return { ...cached, stale: true };
      throw error;
    })
    .finally(() => {
      activeFetch = null;
    });
  return withAnalysis(await activeFetch);
}

function analysisFingerprint(pulse: WorldPulse): string {
  return JSON.stringify(pulse.sections.map(section => [
    section.id,
    section.items.map(item => item.title),
  ]));
}

function withAnalysis(pulse: WorldPulse): WorldPulse {
  pulse = withDiscovery(pulse);
  const hash = analysisFingerprint(pulse);
  if (!analysis || analysisHash !== hash) {
    return {
      ...pulse,
      analysisStatus: queuedAnalysisHash === hash ? "PROCESSING" : undefined,
    };
  }
  const byId = new Map(analysis.sections.map(section => [section.id, section]));
  return {
    ...pulse,
    analysisStatus: "COMPLETE",
    overview: analysis.overview,
    sections: pulse.sections.map(section => {
      const insight = byId.get(section.id);
      return insight ? {
        ...section,
        summary: insight.summary,
        whyItMatters: insight.impact,
        watchNext: insight.outlook,
        action: insight.action,
      } : section;
    }),
  };
}

function withDiscovery(pulse: WorldPulse): WorldPulse {
  if (!discovery) return pulse;
  return {
    ...pulse,
    overview: discovery.overview,
  };
}

export function saveWorldPulseDiscovery(dayKey: string, value: WorldPulseDiscovery): void {
  discoveryDayKey = dayKey;
  discovery = value;
}

export function currentWorldPulseDiscoveryDay(): string {
  return discoveryDayKey;
}

export function worldPulseDiscoveryInput(pulse: WorldPulse, dayKey: string): unknown {
  return {
    dayKey,
    currentTime: pulse.updatedAt,
    locale: "zh-CN",
    audience: "居住在中国南京的普通用户",
    interests: [
      "世界变化对黄金的影响", "中国房价与楼市", "南京房价与楼市",
      "中国程序员就业和职场", "AI产业与技术", "中国正式政策",
      "可能出台的中国政策", "影响中国与全球经济的国际重大事件",
    ],
    knownHeadlines: pulse.sections.map(section => ({
      sectionId: section.id,
      title: section.title,
      headlines: section.items.map(item => item.title),
    })),
  };
}

export async function buildWorldPulseDiscoveryInput(pulse: WorldPulse, dayKey: string): Promise<unknown> {
  const grouped = await Promise.all(sections.map(async definition => {
    const queries = definition.discoveryQueries?.length
      ? definition.discoveryQueries
      : [definition.query || ""];
    const results = await Promise.allSettled(queries.map(fetchNewsQuery));
    const seen = new Set<string>();
    const cutoff = Date.parse(pulse.updatedAt) - (definition.discoveryMaxAgeDays || 7) * 86_400_000;
    const candidates = results.flatMap(result => result.status === "fulfilled" ? result.value.slice(0, 4) : [])
      .filter(item => {
        const key = item.title.replace(/\s+/g, "").toLowerCase();
        if (!key || seen.has(key) || Date.parse(item.publishedAt) < cutoff) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
    return { sectionId: definition.id, title: definition.title, candidates };
  }));
  const policyCandidates = pulse.sections
    .filter(section => section.id === "china_policy" || section.id === "china_policy_preview")
    .map(section => ({
      sectionId: section.id,
      title: section.title,
      candidates: section.items.filter(item => section.id === "china_policy_preview"
        || Date.parse(item.publishedAt) >= Date.parse(pulse.updatedAt) - 7 * 86_400_000),
    }));
  return {
    dayKey,
    currentTime: pulse.updatedAt,
    locale: "zh-CN",
    audience: "居住在中国南京的普通用户",
    selectionGoal: "从候选中选出今天真正值得普通人知道的变化，优先直接影响生活、资产、工作与未来趋势的事件",
    candidateGroups: [...grouped, ...policyCandidates],
  };
}

export function currentWorldPulseDiscovery(): { dayKey: string; value: WorldPulseDiscovery } | null {
  return discovery ? { dayKey: discoveryDayKey, value: discovery } : null;
}

export function worldPulseAnalysisRequest(pulse: WorldPulse): {
  hash: string;
  input: unknown;
} | null {
  const hash = analysisFingerprint(pulse);
  if (analysisHash === hash && analysis) return null;
  if (queuedAnalysisHash === hash && Date.now() - queuedAnalysisAt < 10 * 60 * 1000) return null;
  return {
    hash,
    input: {
      fingerprint: hash,
      currentTime: pulse.updatedAt,
      sections: pulse.sections.map(section => ({
        id: section.id,
        title: section.title,
        headlines: section.items.map(item => ({
          title: item.title,
          source: item.source,
          publishedAt: item.publishedAt,
          context: item.context,
          verification: item.verification,
        })),
      })),
    },
  };
}

export function markWorldPulseAnalysisQueued(hash: string): void {
  queuedAnalysisHash = hash;
  queuedAnalysisAt = Date.now();
}

export function saveWorldPulseAnalysis(hash: string, value: WorldPulseAnalysis): void {
  analysisHash = hash;
  analysis = value;
  queuedAnalysisHash = "";
  queuedAnalysisAt = 0;
}

export function currentWorldPulse(): WorldPulse | null {
  return cached ? withAnalysis(cached) : null;
}
