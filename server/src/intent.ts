export type IntentHint = "save" | "ask" | undefined;

export interface ResearchContextMessage {
  role: "user" | "assistant";
  content: string;
}

const RESEARCH_CONTINUATION_RE = /^(?:请)?(?:你)?(?:再|继续|重新)?研究(?:一下|下)?(?:吧|呢|看看)?[。！？!?]*$/u;

export function researchTopic(
  raw: string,
  conversationHistory: ResearchContextMessage[] = [],
): string | null {
  if (/(?:知识库|资料库|我之前记的|我的资料)/.test(raw)) return null;
  if (RESEARCH_CONTINUATION_RE.test(raw.trim())) {
    const previousQuestion = [...conversationHistory].reverse().find(message =>
      message.role === "user"
      && message.content.trim().length >= 2
      && !RESEARCH_CONTINUATION_RE.test(message.content.trim()));
    return previousQuestion?.content.trim().slice(0, 500) || null;
  }
  const match = raw.trim().match(
    /^(?:(?:请|麻烦)(?:你)?)?(?:再|在|重新|继续)?(?:(?:帮|给)我)?(?:再|在|重新|继续)?(?:(?:仔细|深入|好好|详细)(?:查(?:一下|下)?|研究(?:一下|下)?|了解(?:一下|下)?|调查(?:一下|下)?)|研究(?:一下|下)?|调查(?:一下|下)?)(?:关于)?[\s，,:：]*(.+)$/u,
  );
  const topic = match?.[1]?.trim().replace(/[。！？!?]+$/u, "") || "";
  return topic.length >= 2 ? topic.slice(0, 500) : null;
}

// 一段话同时包含个人安排和“去看下/查一下”时，不能因为整体不是以研究动词
// 开头就丢掉后续查询。这里提取高置信度的地点调研子目标。
export function embeddedResearchTopic(raw: string): string | null {
  if (!/(?:看下|看一下|看看|查下|查一下|找下|找一下|了解下|了解一下)/u.test(raw)) return null;
  if (/(?:知识库|资料库|我之前记的|我的资料)/u.test(raw)) return null;
  if (/(?:生日|聚会|宴请|庆祝|活动)/u.test(raw)
    && /(?:南京)?大厂/u.test(raw)
    && /(?:周边|附近|场地|餐厅|酒店|适合)/u.test(raw)) {
    const festival = /中秋/u.test(raw) ? "中秋期间" : "";
    return `南京大厂周边${festival}适合宝宝生日家庭聚会的场地与方案`;
  }
  return null;
}

export function knowledgeIntentHint(raw: string): IntentHint {
  // Short noun-phrase lookups are common in the home input (for example
  // “英语老师电话号码”) and should not be mistaken for a diary entry.
  if (/(电话号码|手机号|联系方式|地址|群里|老师|家长|作业|通知).{0,12}(是|多少|什么|怎么|找|查|告诉|电话|号码)?/.test(raw)) {
    return "ask";
  }
  // 日期事实（保质期、有效期、生产日期等）是以后查阅的资料，不是待办。
  // 只有明确要求提醒或采取行动时，才交给 memo 规则处理。
  const datedFact = /(?:保质期|有效期|生产日期|出厂日期|购买日期|到期日|截止日期|质保期|保修期|生日|纪念日)/.test(raw)
    || /(?:巧克力|食品|药品|药|合同|护照|身份证|证件|保险|会员卡|卡券).{0,24}(?:到期|截止|有效至|生产于|买于)/.test(raw);
  const asksOrActs = /(?:吗|么|什么时候|哪天|几号|是否|提醒|别忘|需要|必须|务必|续费|续签|更换|处理|办理|丢掉|扔掉|吃完|用完|？|\?)/.test(raw);
  if (datedFact && !asksOrActs && /\d/.test(raw)) return "save";
  if (
    /(?:记|记录|存|保存)(?:到|进|入)(?:我的)?(?:个人)?(?:知识库|芝士库)|(?:这个|这条|上面的)?(?:方法|做法|经验|配方|路线).{0,8}(?:记下|存下|保存)/.test(raw)
  ) {
    return "save";
  }
  const reusableKnowledge = /(?:制作)?方法|做法|步骤|配方|经验|技巧|攻略|注意事项/.test(raw);
  const containsDetail = /需要|应该|先|再|然后|最后|放入|加入|小火|大火|分钟|不要/.test(raw);
  const scheduledAction = /今天|明天|后天|下周|几点|准备|计划|提醒|别忘|去学|学习/.test(raw);
  if (reusableKnowledge && containsDetail && !scheduledAction) {
    return "save";
  }
  // 没有显式说“方法/技巧”的自然经验句，例如“红烧肉不能一开始放盐”。
  // 要同时具备领域对象和规范性措辞，避免把“我今天不能去公司”误存为知识。
  const techniqueSubject = /做|制作|烹饪|煮|炖|炒|烧|烤|蒸|煎|菜|饭|肉|汤|安装|配置|使用|清洗|维修|种植|养护/.test(raw);
  const normativeAdvice = /不能|不要|不宜|应该|应当|最好|要先|需要先|切记|记住/.test(raw);
  const personalSituation = /我(?:今天|明天|现在|刚才|不能|不要|应该|要|需要)/.test(raw);
  if (techniqueSubject && normativeAdvice && !scheduledAction && !personalSituation) {
    return "save";
  }
  if (/查(?:一下)?(?:我的)?知识库|我之前记的|我记得的.*(?:怎么|是什么)/.test(raw)) {
    return "ask";
  }
  return undefined;
}
