export type IntentHint = "save" | "ask" | undefined;

export function researchTopic(raw: string): string | null {
  if (/(?:知识库|资料库|我之前记的|我的资料)/.test(raw)) return null;
  const match = raw.trim().match(
    /^(?:(?:请|麻烦)(?:你)?)?(?:再|在|重新|继续)?(?:(?:帮|给)我)?(?:再|在|重新|继续)?(?:(?:仔细|深入|好好|详细)(?:查(?:一下|下)?|研究(?:一下|下)?|了解(?:一下|下)?|调查(?:一下|下)?)|研究(?:一下|下)?|调查(?:一下|下)?)(?:关于)?[\s，,:：]*(.+)$/u,
  );
  const topic = match?.[1]?.trim().replace(/[。！？!?]+$/u, "") || "";
  return topic.length >= 2 ? topic.slice(0, 500) : null;
}

export function knowledgeIntentHint(raw: string): IntentHint {
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
