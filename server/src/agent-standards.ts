import { registerCapabilityStandard, type CapabilityStandard } from "./agent-contract.js";

type StandardInput = Omit<CapabilityStandard, "acceptance">;
const common = (value: StandardInput): StandardInput => value;
const compact = (value: unknown) => String(value || "").replace(/[\s，。！？、,.!?：:]/g, "");

registerCapabilityStandard({
  ...common({
    capability: "input_orchestration", version: "1.0", description: "原始输入必须形成完整行动计划并逐项闭环",
    requiresConfirmation: false, allowedSideEffects: ["create_child_tasks"], failurePolicy: "retry",
    inputContract: "原始文本、输入方式、当前时间和计划版本",
    outputContract: "事实、目标、计划项、子任务状态、覆盖状态和缺失要求",
    confirmationPolicy: "只读和明确授权的内部动作自动执行；敏感副作用由子任务确认",
    idempotencyRule: "同一父任务和计划项只能绑定一个有效子任务",
    retryPolicy: "只重试缺失或失败计划项，已通过子任务不重复执行",
    followUpPolicy: "存在缺项或失败时保持可见并反馈下一步",
  }),
  acceptance: () => [{
    id: "plan-present", description: "输入已经形成包含事实、目标和行动的计划",
    check: (result) => Boolean((result as { facts?: unknown[]; goals?: unknown[]; planItems?: unknown[] })?.facts?.length
      && (result as { goals?: unknown[] }).goals?.length && (result as { planItems?: unknown[] }).planItems?.length),
  }, {
    id: "source-coverage", description: "原始输入中的必要要求均有关联且通过验收的子任务",
    check: (result) => (result as { coverageStatus?: string }).coverageStatus === "complete"
      && !((result as { missingRequirements?: unknown[] }).missingRequirements || []).length,
  }],
});

registerCapabilityStandard({
  ...common({ capability: "date_resolution", version: "1.0", description: "相对或节日日期转换为可核对公历日期",
    requiresConfirmation: false, allowedSideEffects: [], failurePolicy: "awaiting_user", inputContract: "日期表达和当前日期",
    outputContract: "ISO 日期、原始表达和解析依据", confirmationPolicy: "无副作用自动执行", idempotencyRule: "表达+当前年份唯一",
    retryPolicy: "解析失败时等待用户补充年份或日期", followUpPolicy: "无法唯一确定时显示澄清问题" }),
  acceptance: () => [{ id: "date-resolved", description: "日期已转换为有效 ISO 日期并保留依据", check: (result) => /^\d{4}-\d{2}-\d{2}$/.test(String((result as { date?: unknown })?.date || "")) && Boolean(String((result as { basis?: unknown })?.basis || "").trim()) }],
});

registerCapabilityStandard({
  ...common({ capability: "feedback", version: "1.0", description: "汇总全部子任务结果并反馈用户",
    requiresConfirmation: false, allowedSideEffects: ["publish_agent_result"], failurePolicy: "retry", inputContract: "父任务目标和已验收子任务结果",
    outputContract: "覆盖全部目标的手机可读摘要", confirmationPolicy: "无外部副作用自动反馈", idempotencyRule: "父任务+计划版本只发布一次",
    retryPolicy: "缺少依赖时等待，反馈为空时重新汇总", followUpPolicy: "仍缺资料时明确列出未完成项" }),
  acceptance: () => [{ id: "feedback-present", description: "产生了可读的最终反馈", check: (result) => String((result as { summary?: unknown })?.summary || "").trim().length >= 10 }],
});

registerCapabilityStandard({
  ...common({
    capability: "tomorrow_brief", version: "1.2", description: "明日管家逐项覆盖明确准备事项",
    requiresConfirmation: false, allowedSideEffects: ["publish_brief"], failurePolicy: "retry",
    inputContract: "目标日期、逐条事实源、required 必带清单",
    outputContract: "目标日期、逐项 checklist、建议和事实来源引用",
    confirmationPolicy: "无外部副作用，验收通过后直接发布",
    idempotencyRule: "账号+目标日期+事实源指纹唯一",
    retryPolicy: "覆盖验收失败时使用同一事实源重新生成",
    followUpPolicy: "仍失败则展示遗漏项并等待用户检查来源",
  }),
  acceptance: (input) => [{
    id: "source-coverage", description: "原始事项全部出现在最终清单",
    check: (result) => {
      const required = (input as { required?: string[] }).required || [];
      const checklist = ((result as { checklist?: string[] }).checklist || []).map(compact);
      return required.every((item) => checklist.some((candidate) => candidate.includes(compact(item))));
    },
  }, {
    id: "checklist-not-empty", description: "有事实源时最终逐项清单不能为空",
    check: (result) => {
      const required = (input as { required?: string[] }).required || [];
      return !required.length || Boolean((result as { checklist?: unknown[] })?.checklist?.length);
    },
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "input_processing", version: "1.1", description: "输入必须正确分类并产生与请求匹配的结果",
    requiresConfirmation: false, allowedSideEffects: ["create_conversation", "create_entry", "save_knowledge"], failurePolicy: "retry",
    inputContract: "原始文本、输入方式和对话上下文",
    outputContract: "ask 答案 / record 记录 / save 资料之一",
    confirmationPolicy: "回答无确认；明确记录请求按既有授权执行",
    idempotencyRule: "同一请求 ID 只能形成一次副作用",
    retryPolicy: "空泛或不匹配回答重新检索领域事实源",
    followUpPolicy: "证据仍不足时明确列出缺失信息并等待补充",
  }),
  acceptance: () => [{
    id: "usable-result", description: "输入处理产生可用且非答非所问的结果",
    check: (result) => {
      const value = result as { kind?: string; answer?: string; entries?: unknown[]; item?: unknown } | null;
      if (!value) return false;
      if (value.kind === "ask") {
        const answer = String(value.answer || "").trim();
        return answer.length > 0 && !/没有明确写出|无法查询|没有找到相关|未配置 AI/.test(answer);
      }
      if (value.kind === "record") return Array.isArray(value.entries) && value.entries.length > 0;
      if (value.kind === "save") return value.item != null;
      return false;
    },
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "desktop_intake", version: "1.1", description: "电脑投递全部资料完成处理并形成父子闭环",
    requiresConfirmation: false, allowedSideEffects: ["archive_documents", "infer_actions"], failurePolicy: "follow_up",
    inputContract: "处理要求、粘贴文字、资料清单和 expectedItemCount",
    outputContract: "处理数量、失败数量、摘要和唯一 documentIds",
    confirmationPolicy: "归档分析自动执行；推断出的敏感动作另建待确认任务",
    idempotencyRule: "账号+客户端 idempotencyKey 唯一",
    retryPolicy: "失败文件在原投递文件槽位重传，已完成文件不重复处理",
    followUpPolicy: "任何必要子任务失败时父任务失败并在手机提示重试或补充资料",
  }),
  acceptance: (input) => [{
    id: "all-items-processed", description: "本次投递的全部资料均已处理",
    check: (result) => {
      const expected = Number((input as { expectedItemCount?: number }).expectedItemCount || 0);
      return expected > 0 && Number((result as { processedCount?: number })?.processedCount) === expected;
    },
  }, {
    id: "no-failed-items", description: "本次投递没有失败资料",
    check: (result) => Number((result as { failedCount?: number })?.failedCount) === 0,
  }, {
    id: "documents-linked", description: "每项资料均关联唯一资料编号",
    check: (result) => {
      const expected = Number((input as { expectedItemCount?: number }).expectedItemCount || 0);
      const ids = (result as { documentIds?: string[] })?.documentIds || [];
      return ids.length === expected && new Set(ids).size === expected && ids.every(Boolean);
    },
  }, {
    id: "summary-present", description: "投递完成后产生手机可读摘要",
    check: (result) => Boolean(String((result as { summary?: string })?.summary || "").trim()),
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "document_ingest", version: "1.1", description: "单份资料完成完整性校验、归档和结构化分析",
    requiresConfirmation: false, allowedSideEffects: ["archive_document"], failurePolicy: "retry",
    inputContract: "资料编号、文件名、类型、大小与内容哈希",
    outputContract: "同一资料编号、标题、摘要、归档路径和结构化元数据",
    confirmationPolicy: "无外部副作用，自动执行",
    idempotencyRule: "账号+内容 SHA-256 去重",
    retryPolicy: "保留失败源文件，允许重新进入解析队列",
    followUpPolicy: "最终失败时提示文件名、原因和重试入口",
  }),
  acceptance: () => [{
    id: "document-complete", description: "资料已经归档并产生标题、摘要和资料编号",
    check: (result) => {
      const value = result as { documentId?: string; title?: string; summary?: string; vaultPath?: string } | null;
      return Boolean(value?.documentId && String(value.title || "").trim()
        && String(value.summary || "").trim() && String(value.vaultPath || "").trim());
    },
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "todo", version: "1.1", description: "确认后创建字段一致且可追踪的待办",
    requiresConfirmation: true, allowedSideEffects: ["create_todo"], failurePolicy: "awaiting_user",
    inputContract: "标题、description、分类、优先级和可选日期",
    outputContract: "数据库 memo 条目，包含 id、description、priority、done=false",
    confirmationPolicy: "写入待办前必须确认",
    idempotencyRule: "同一 Agent 任务只允许生成一个条目",
    retryPolicy: "写入失败不改变确认状态，用户可重试",
    followUpPolicy: "权限或字段缺失时展示原因并等待补充",
  }),
  acceptance: (input) => [{
    id: "todo-persisted", description: "待办已写入数据库且保持未完成状态",
    check: (result) => Boolean((result as { id?: string; type?: string; description?: string; done?: boolean })?.id
      && (result as { type?: string }).type === "memo" && String((result as { description?: string }).description || "").trim()
      && (result as { done?: boolean }).done === false),
  }, {
    id: "todo-description-preserved", description: "待办描述与确认内容一致",
    check: (result) => {
      const expected = String((input as { payload?: { description?: string } })?.payload?.description || "").trim();
      return !expected || compact((result as { description?: string })?.description).includes(compact(expected));
    },
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "reminder", version: "1.2", description: "确认后创建日期正确、可验收的提醒条目",
    requiresConfirmation: true, allowedSideEffects: ["create_reminder"], failurePolicy: "awaiting_user",
    inputContract: "提醒标题、description、ISO reminderAt，以及无日期时的当前日期/时间上下文",
    outputContract: "数据库 memo 条目、有效 reminderAt 和系统闹钟结果",
    confirmationPolicy: "创建系统提醒前必须确认",
    idempotencyRule: "同一 Agent 任务只允许创建一次提醒",
    retryPolicy: "权限失败不静默，保留任务供重试；日期错误时按原文和当前时间重新计算",
    followUpPolicy: "权限拒绝、时间无效或日期不一致时提示用户修正并保留失败原因",
  }),
  acceptance: (input) => [{
    id: "reminder-persisted", description: "提醒条目已写入并包含有效提醒时间",
    check: (result) => {
      const value = result as { id?: string; type?: string; reminderAt?: string; done?: boolean } | null;
      if (!value || !Boolean(value.id && value.type === "memo" && value.done === false
        && value.reminderAt && !Number.isNaN(new Date(value.reminderAt).getTime()))) return false;
      const expectedDate = String((input as { expectedDate?: unknown }).expectedDate || "").trim();
      return !expectedDate || new Date(value.reminderAt!).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) === expectedDate;
    },
  }, {
    id: "reminder-action-preserved", description: "明确时间的用药行动保留为提醒而非普通活动",
    check: (result) => String((input as { title?: unknown; details?: unknown }).title || "").match(/(?:拿药|取药|吃药|服药|喂药)/)
      ? (result as { type?: string }).type === "memo"
      : true,
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "research", version: "1.1", description: "研究必须形成有来源、可核对的完整报告",
    requiresConfirmation: true, allowedSideEffects: ["start_web_research", "archive_report"], failurePolicy: "retry",
    inputContract: "明确研究主题、原始请求和查询范围",
    outputContract: "摘要、要点、至少两节正文、行动建议与至少两个 HTTPS 来源",
    confirmationPolicy: "资料推断出的新研究需确认；用户直接发起时视为已授权",
    idempotencyRule: "同一任务只生成一份研究报告",
    retryPolicy: "来源不足或报告不完整时重新检索",
    followUpPolicy: "仍无可靠来源时明确报告证据不足",
  }),
  acceptance: () => [{
    id: "research-complete", description: "研究报告包含摘要、正文和关键结论",
    check: (result) => Boolean(String((result as { executiveSummary?: string })?.executiveSummary || "").trim()
      && ((result as { keyTakeaways?: unknown[] })?.keyTakeaways?.length || 0) > 0
      && ((result as { sections?: unknown[] })?.sections?.length || 0) >= 2),
  }, {
    id: "research-sourced", description: "研究报告包含至少两个可核对 HTTPS 来源",
    check: (result) => ((result as { sources?: Array<{ url?: string }> })?.sources || [])
      .filter((source) => /^https:\/\//.test(String(source.url || ""))).length >= 2,
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "document_action", version: "1.1", description: "资料推断动作必须明确结果与审计编号",
    requiresConfirmation: true, allowedSideEffects: ["internal_reversible_action"], failurePolicy: "awaiting_user",
    inputContract: "动作标题、依据、结构化 payload 和确认原因",
    outputContract: "actionId、status=completed 和结果摘要",
    confirmationPolicy: "任何可逆内部动作也默认确认",
    idempotencyRule: "来源资料+动作种类唯一",
    retryPolicy: "执行失败可重试但不得重复副作用",
    followUpPolicy: "失败时说明原因和下一步",
  }),
  acceptance: () => [{
    id: "action-complete", description: "资料后续动作产生完成状态和审计编号",
    check: (result) => Boolean((result as { actionId?: string; status?: string })?.actionId
      && (result as { status?: string }).status === "completed"),
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "qq_task_sync", version: "1.1", description: "QQ群原文和多项任务必须完整同步",
    requiresConfirmation: false, allowedSideEffects: ["save_qq_message", "create_todos"], failurePolicy: "follow_up",
    inputContract: "账号、群、消息时间、原始消息和 stableMessageId",
    outputContract: "savedMessageId、逐项 extractedTasks 和原文事实覆盖结果",
    confirmationPolicy: "群同步按既有授权自动执行",
    idempotencyRule: "账号+stableMessageId 唯一",
    retryPolicy: "保存或拆分失败时用相同稳定 ID 重试",
    followUpPolicy: "日期或内容歧义时等待用户确认，不丢弃原文",
  }),
  acceptance: (input) => [{
    id: "qq-message-saved", description: "QQ 原始消息已保存并可追踪",
    check: (result) => Boolean((result as { savedMessageId?: string })?.savedMessageId),
  }, {
    id: "qq-facts-covered", description: "消息中的必需事实均保留在拆分任务中",
    check: (result) => {
      const required = (input as { requiredFacts?: string[] })?.requiredFacts || [];
      const text = JSON.stringify((result as { extractedTasks?: unknown[] })?.extractedTasks || []);
      return required.every((fact) => compact(text).includes(compact(fact)));
    },
  }],
});

registerCapabilityStandard({
  ...common({
    capability: "desktop_action", version: "1.1", description: "电脑敏感操作必须确认、幂等并留下审计事件",
    requiresConfirmation: true, allowedSideEffects: ["approved_desktop_operation"], failurePolicy: "awaiting_user",
    inputContract: "设备、操作目标、风险说明和授权范围",
    outputContract: "operationId、status=completed、auditEventId 和结果摘要",
    confirmationPolicy: "所有电脑操作必须在手机确认",
    idempotencyRule: "operationId 唯一，重复确认不重复执行",
    retryPolicy: "失败重试沿用 operationId 并检查已产生副作用",
    followUpPolicy: "设备离线或权限失败时等待用户处理",
  }),
  acceptance: () => [{
    id: "desktop-operation-audited", description: "电脑操作完成且留下审计事件",
    check: (result) => Boolean((result as { operationId?: string; status?: string; auditEventId?: string })?.operationId
      && (result as { status?: string }).status === "completed"
      && (result as { auditEventId?: string }).auditEventId),
  }],
});
