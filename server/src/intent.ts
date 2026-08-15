export type IntentHint = "save" | "ask" | undefined;

export function knowledgeIntentHint(raw: string): IntentHint {
  if (
    /(?:记|存|保存)(?:到|进|入)(?:我的)?(?:个人)?知识库|(?:这个|这条|上面的)?(?:方法|做法|经验|配方|路线).{0,8}(?:记下|存下|保存)/.test(raw)
  ) {
    return "save";
  }
  const reusableKnowledge = /(?:制作)?方法|做法|步骤|配方|经验|技巧|攻略|注意事项/.test(raw);
  const containsDetail = /需要|应该|先|再|然后|最后|放入|加入|小火|大火|分钟|不要/.test(raw);
  const scheduledAction = /今天|明天|后天|下周|几点|准备|计划|提醒|别忘|去学|学习/.test(raw);
  if (reusableKnowledge && containsDetail && !scheduledAction) {
    return "save";
  }
  if (/查(?:一下)?(?:我的)?知识库|我之前记的|我记得的.*(?:怎么|是什么)/.test(raw)) {
    return "ask";
  }
  return undefined;
}
