import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexFailureHint,
  appendVaultDocumentNote,
  conversationRecordProposal,
  deduplicateEvidenceSources,
  documentAnswerForIngest,
  documentSourcesForAnswer,
  evidenceWithinBudget,
  extractDocumentText,
  groundedAnswerFacts,
  hasConcreteEvidenceOverlap,
  hasExplicitTimeRange,
  isConversationTransformRequest,
  knowledgeAnswerForIngest,
  needsConversationContextForRetrieval,
  ollamaModelForJob,
  resolveKnowledgeSpaceRoot,
  rerankKnowledgeSources,
  retrievalQuestionForIngest,
  runInference,
  runOllama,
  searchAccessibleDocuments,
  searchLocalDocuments,
  shouldSearchDocumentsForIngest,
  validateIngestTemporalResult,
  writeVaultDocument,
} from "./codex-worker.mjs";

const spaceOne = "1".repeat(64);
const spaceTwo = "2".repeat(64);

const ingestJob = {
  kind: "ingest",
  input: {
    raw: "明天下午三点提醒我给张老师打电话",
    context: { currentDate: "2026-08-18", currentTime: "22:00" },
    knowledge: [],
  },
};

test("Codex 非零退出保留可处理的真实错误类别", () => {
  assert.equal(codexFailureHint("Usage limit reached", 1), "codex_quota_exhausted");
  assert.equal(codexFailureHint("Not logged in", 1), "codex_auth_failed");
  assert.equal(codexFailureHint("fetch failed: ECONNRESET", 1), "codex_network_failed");
  assert.equal(codexFailureHint("503 service unavailable", 1), "codex_service_unavailable");
  assert.equal(codexFailureHint("unexpected internal issue", 7), "codex_exit_7");
});

test("follow-up retrieval includes recent conversation context", () => {
  const question = retrievalQuestionForIngest({
    input: {
      raw: "再试一下",
      conversationHistory: [
        { role: "user", content: "帮我找一下张老师的手机号" },
        { role: "assistant", content: "刚才没有找到。" },
      ],
    },
  });
  assert.match(question, /张老师的手机号/);
  assert.match(question, /再试一下/);
});

test("a self-contained lookup does not inherit the previous subject", () => {
  const question = retrievalQuestionForIngest({
    input: {
      raw: "语文老师号码",
      conversationHistory: [
        { role: "user", content: "英语老师号码给我下" },
        { role: "assistant", content: "英语老师的号码是13800138000" },
      ],
    },
  });
  assert.equal(question, "语文老师号码");
  assert.equal(needsConversationContextForRetrieval("语文老师号码"), false);
});

test("elliptical follow-ups use prior user questions but not assistant answers", () => {
  const question = retrievalQuestionForIngest({
    input: {
      raw: "刚才那个再试一下",
      conversationHistory: [
        { role: "user", content: "帮我找张老师的联系方式" },
        { role: "assistant", content: "可能是错误号码13800138000" },
      ],
    },
  });
  assert.match(question, /张老师的联系方式/);
  assert.doesNotMatch(question, /13800138000/);
});

test("formatting follow-ups are recognized as transformations of the previous answer", () => {
  assert.equal(isConversationTransformRequest("请用表格的形式详细整理好给我看。"), true);
  assert.equal(isConversationTransformRequest("把上面的内容改成要点列表"), true);
  assert.equal(isConversationTransformRequest("南京明天天气怎么样"), false);
  assert.equal(needsConversationContextForRetrieval("请用表格的形式详细整理好给我看。"), true);
});

test("knowledge evidence answer maps model source indexes back to source ids", () => {
  assert.deepEqual(
    knowledgeAnswerForIngest(
      { conversationTitle: "老师联系方式" },
      { answer: "已找到英语老师的联系方式。", sourceIndexes: [1], insufficientEvidence: false },
      [{ id: "unrelated" }, { id: "qq-english-teacher" }],
    ),
    {
      kind: "ask",
      answer: "已找到英语老师的联系方式。",
      sourceIds: ["qq-english-teacher"],
      retrievalStatus: "answered_with_sources",
      conversationTitle: "老师联系方式",
    },
  );
});

test("semantic reranking is generic and prefers original evidence", async () => {
  const sources = [
    { id: "qq-message-chinese", title: "QQ群消息｜四8班｜语文-王老师13800138001", content: "原文：英语作业已发" },
    { id: "qq-message-english", title: "QQ群消息｜四8班英语学习群｜英语-王老师13800138002", content: "发送者：英语-王老师13800138002" },
    { id: "conversation-old", title: "聊天记录｜助手", content: "英语老师电话是13800138003" },
  ];
  const fakeInference = async job => {
    assert.equal(job.kind, "knowledge_rerank");
    return { result: { sourceIndexes: [1], sufficientEvidence: true }, provider: "test-local" };
  };
  assert.deepEqual(
    (await rerankKnowledgeSources("英语老师号码给我下", sources, fakeInference)).map(source => source.id),
    ["qq-message-english"],
  );
});

test("derived chat evidence is excluded when reranking also selects an original source", async () => {
  const sources = [
    { id: "original-note", title: "原始资料", content: "项目截止日为9月8日" },
    { id: "conversation-old", title: "聊天记录｜助手", content: "项目截止日为9月9日" },
  ];
  const fakeInference = async () => ({
    result: { sourceIndexes: [0, 1], sufficientEvidence: false },
    provider: "test-local",
  });
  assert.deepEqual(
    (await rerankKnowledgeSources("项目什么时候截止", sources, fakeInference)).map(source => source.id),
    ["original-note"],
  );
});

test("program controls evidence deduplication, budget and exact-fact grounding", () => {
  const sources = [
    { id: "a", title: "资料", content: "联系电话13800138000" },
    { id: "b", title: "资料", content: "联系电话13800138000" },
    { id: "c", title: "其他", content: "另一个事实" },
  ];
  assert.deepEqual(deduplicateEvidenceSources(sources).map(source => source.id), ["a", "c"]);
  assert.equal(evidenceWithinBudget(sources, 1).length, 1);
  assert.equal(groundedAnswerFacts("电话是13800138000", [sources[0]]), true);
  assert.equal(groundedAnswerFacts("电话是13900139000", [sources[0]]), false);
});

test("insufficient evidence hides unrelated sources but keeps concrete topic matches", () => {
  const question = "总结下今天早上开会关于app开发的部分";
  assert.equal(hasConcreteEvidenceOverlap(question, {
    title: "巧克力保质期",
    content: "新买的巧克力，保质期至2027年5月18日。",
  }), false);
  assert.equal(hasConcreteEvidenceOverlap(question, {
    title: "关于app开发及部署流程的会议记录",
    content: "需要把打包部署流程标准化并补充代码审查。",
  }), true);
});

test("runOllama sends a constrained non-thinking request and parses JSON", async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            kind: "record",
            fields: [{
              type: "memo",
              description: "给张老师打电话",
              category: "备忘",
              amount: null,
              currency: null,
              timeRange: null,
              priority: "medium",
              date: "2026-08-19",
              reminderTime: "15:00",
              dateEvidence: "明天",
              timeEvidence: "下午三点",
            }],
            title: "",
            content: "",
            answer: "",
            sourceIds: [],
          }),
        },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await runOllama(ingestJob, {
    url: `http://127.0.0.1:${address.port}`,
    model: "test-model",
    timeoutMs: 2_000,
  });

  assert.equal(result.fields[0].reminderTime, "15:00");
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.think, false);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.options.num_predict, 320);
  assert.equal(requestBody.format.type, "object");
  assert.deepEqual(requestBody.format.required, [
    "kind", "fields", "title", "content", "answer", "sourceIds", "conversationTitle",
  ]);
  assert.deepEqual(JSON.parse(requestBody.messages[1].content), { input: ingestJob.input });
});

test("runInference falls back to Codex when Ollama is unavailable", async () => {
  const expected = {
    kind: "record",
    fields: [{ type: "memo", date: "2026-08-19", reminderTime: "15:00", dateEvidence: "明天", timeEvidence: "下午三点" }],
  };
  const inference = await runInference(ingestJob, {
    provider: "ollama",
    localRunner: async () => { throw new Error("ollama_offline"); },
    cloudRunner: async () => expected,
    codexFallback: true,
  });
  assert.equal(inference.provider, "codex-fallback");
  assert.equal(inference.result, expected);
});

test("conversation mode defaults greetings to chat instead of records", async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            kind: "ask",
            fields: [],
            title: "",
            content: "",
            answer: "你好！今天想聊点什么？",
            sourceIds: [],
            conversationTitle: "日常问候",
          }),
        },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await runOllama({
    kind: "ingest",
    input: { raw: "你好", interactionMode: "conversation", conversationHistory: [] },
  }, {
    url: `http://127.0.0.1:${address.port}`,
    model: "test-model",
    timeoutMs: 2_000,
  });

  assert.equal(result.kind, "ask");
  assert.match(result.answer, /你好/);
  assert.match(requestBody.messages[0].content, /默认 kind=ask/);
  assert.match(requestBody.messages[0].content, /“你好”/);
});

test("conversation mode asks before saving inferred long-term information", async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            kind: "ask",
            fields: [],
            title: "",
            content: "",
            answer: "知道了，之后聊到吃饭时我会注意。这个偏好可能以后会用到，需要我帮你记录为‘不吃香菜’吗？",
            sourceIds: [],
            conversationTitle: "饮食偏好",
          }),
        },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await runOllama({
    kind: "ingest",
    input: { raw: "我不吃香菜", interactionMode: "conversation", conversationHistory: [] },
  }, {
    url: `http://127.0.0.1:${address.port}`,
    model: "test-model",
    timeoutMs: 2_000,
  });

  assert.equal(result.kind, "ask");
  assert.match(result.answer, /需要我帮你记录/);
  assert.match(requestBody.messages[0].content, /用户确认前绝不能生成 record\/save/);
});

test("conversation record proposals are limited to useful long-term or actionable facts", () => {
  assert.equal(conversationRecordProposal("你好"), null);
  assert.equal(conversationRecordProposal("我今天挺累"), null);
  assert.equal(conversationRecordProposal("我不吃香菜")?.kind, "save");
  assert.equal(conversationRecordProposal("明天要去医院")?.kind, "record");
  assert.equal(conversationRecordProposal("午饭花了38元")?.kind, "record");
  assert.equal(conversationRecordProposal("帮我记一下我不吃香菜"), null);
});

test("all ingest input uses the large model", () => {
  assert.equal(ollamaModelForJob({ kind: "ingest" }), "qwen3:14b");
  assert.equal(ollamaModelForJob({ kind: "world_discovery" }), "qwen3:4b");
  assert.equal(ollamaModelForJob({ kind: "summary" }), "qwen3:14b");
  assert.equal(ollamaModelForJob({ kind: "document" }), "qwen3:14b");
  assert.equal(ollamaModelForJob({ kind: "document_question" }), "qwen3:14b");
});

test("only explicit clock ranges are accepted from a local model", () => {
  assert.equal(hasExplicitTimeRange("下午3-5点跑步"), true);
  assert.equal(hasExplicitTimeRange("晚上7点到9点看书"), true);
  assert.equal(hasExplicitTimeRange("08:30-09:15开会"), true);
  assert.equal(hasExplicitTimeRange("早上跑步30分钟"), false);
  assert.equal(hasExplicitTimeRange("2026-08-20去医院"), false);
});

test("invalid large-model output falls back to Codex", async () => {
  const calls = [];
  const expected = {
    kind: "record",
    fields: [{ type: "memo", date: "2026-08-19", reminderTime: "15:00", dateEvidence: "明天", timeEvidence: "下午三点" }],
  };
  const inference = await runInference(ingestJob, {
    provider: "ollama",
    localRunner: async (_job, options) => {
      calls.push(options.model);
      throw new Error("large_invalid");
    },
    cloudRunner: async () => expected,
  });
  assert.deepEqual(calls, ["qwen3:14b"]);
  assert.equal(inference.provider, "codex-fallback");
  assert.equal(inference.result, expected);
});

test("temporal validation rejects both observed voice failures", () => {
  const context = { currentDate: "2026-09-02", currentTime: "12:11", timeZone: "Asia/Shanghai" };
  const first = validateIngestTemporalResult({
    raw: "今天六点今天晚上6点40，提醒我把这个风扇带上去充电。",
    context,
  }, {
    kind: "record",
    fields: [{ type: "memo", date: "2026-09-03", reminderTime: "18:40", dateEvidence: "今天", timeEvidence: "晚上6点40" }],
  });
  assert.equal(first.ok, false);
  assert.ok(first.issues.includes("field_0_explicit_date_mismatch"));

  const second = validateIngestTemporalResult({
    raw: "今晚6点40提醒我把那个风扇带上去充电。",
    context: { ...context, currentTime: "13:00" },
  }, {
    kind: "record",
    fields: [{ type: "memo", date: "2026-09-02", reminderTime: "20:40", dateEvidence: "今晚", timeEvidence: "今晚6点40" }],
  });
  assert.equal(second.ok, false);
  assert.ok(second.issues.includes("field_0_time_mismatch"));
});

test("temporal validation accepts the corrected 14B result", () => {
  const validation = validateIngestTemporalResult({
    raw: "今晚6点40提醒我把那个风扇带上去充电。",
    context: { currentDate: "2026-09-02", currentTime: "13:00", timeZone: "Asia/Shanghai" },
  }, {
    kind: "record",
    fields: [{ type: "memo", date: "2026-09-02", reminderTime: "18:40", dateEvidence: "今晚", timeEvidence: "今晚6点40" }],
  });
  assert.deepEqual(validation, { ok: true, issues: [] });
});

test("temporal validation accepts tonight at midnight as the following date", () => {
  const validation = validateIngestTemporalResult({
    raw: "今晚12点提醒我上线。",
    context: { currentDate: "2026-09-02", currentTime: "13:00", timeZone: "Asia/Shanghai" },
  }, {
    kind: "record",
    fields: [{ type: "memo", date: "2026-09-03", reminderTime: "00:00", dateEvidence: "今晚", timeEvidence: "今晚12点" }],
  });
  assert.deepEqual(validation, { ok: true, issues: [] });
});

test("temporal validation rejects a memo classification without action evidence", () => {
  const validation = validateIngestTemporalResult({
    raw: "记录9月2号体重120.7斤。",
    context: { currentDate: "2026-09-03", currentTime: "08:00", timeZone: "Asia/Shanghai" },
  }, {
    kind: "record",
    fields: [{ type: "memo", date: "2026-09-02", dateEvidence: "9月2号" }],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes("field_0_memo_without_action_evidence"));
});

test("runInference can disable the cloud fallback", async () => {
  await assert.rejects(
    runInference(ingestJob, {
      provider: "ollama",
      localRunner: async () => { throw new Error("ollama_offline"); },
      codexFallback: false,
    }),
    /ollama_offline/,
  );
});

test("runOllama accepts document metadata with a bounded output", async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            title: "租赁合同",
            category: "合同",
            summary: "一份租赁合同。",
            people: ["张三"],
            keywords: ["租赁", "合同"],
            documentDate: "2026-08-19",
          }),
        },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const result = await runOllama({
    kind: "document",
    input: { fileName: "合同.pdf", extractedText: "张三签订租赁合同" },
  }, {
    url: `http://127.0.0.1:${address.port}`,
    timeoutMs: 2_000,
  });
  assert.equal(result.category, "合同");
  assert.equal(requestBody.options.num_predict, 320);
  assert.deepEqual(requestBody.format.required, ["title", "category", "summary", "people", "keywords", "documentDate"]);
});

test("runOllama answers document questions with explicit source indexes", async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            answer: "票据显示个人支付 45.89 元。",
            sourceIndexes: [0],
            insufficientEvidence: false,
          }),
        },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const result = await runOllama({
    kind: "document_question",
    input: {
      question: "这张票据个人支付多少？",
      sources: [{ index: 0, title: "门诊票据", category: "医疗健康", excerpt: "个人支付 45.89 元" }],
    },
  }, {
    url: `http://127.0.0.1:${address.port}`,
    timeoutMs: 2_000,
  });
  assert.equal(result.sourceIndexes[0], 0);
  assert.equal(requestBody.options.num_predict, 480);
  assert.deepEqual(requestBody.format.required, ["answer", "sourceIndexes", "insufficientEvidence"]);
});

test("only document evidence cited by the answering model is returned", () => {
  const candidates = [
    {
      documentId: "2b472924-15cc-4676-8d3d-f5f947e574fa",
      title: "房屋租赁合同",
      category: "合同",
      vaultPath: "资料/合同/房屋租赁合同.md",
      excerpt: "租赁期限至 2027 年 8 月 31 日。",
      relatedDocumentIds: ["b71848a8-17de-4c97-8444-3c4270de1f77"],
    },
    {
      documentId: "642db6c9-03ef-4bd1-93b5-4c61e573e70c",
      title: "无关票据",
      category: "票据",
      vaultPath: "资料/票据/无关票据.md",
      excerpt: "个人支付 45.89 元。",
    },
  ];
  assert.deepEqual(
    documentSourcesForAnswer(candidates, { sourceIndexes: [0, 0, 99], insufficientEvidence: false }),
    [candidates[0]],
  );
  assert.deepEqual(
    documentSourcesForAnswer(candidates, { sourceIndexes: [], insufficientEvidence: true }),
    [],
  );
});

test("local document search indexes Obsidian notes and returns excerpts", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-search-test-"));
  try {
    const noteDir = path.join(temporaryDir, "资料", "医疗健康");
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(path.join(noteDir, "门诊票据.md"), `---\ndocument_id: "2b472924-15cc-4676-8d3d-f5f947e574fa"\ntitle: "张三门诊票据"\ncategory: "医疗健康"\nrelated_documents: ["b71848a8-17de-4c97-8444-3c4270de1f77"]\n---\n张三门诊个人支付 45.89 元，医保支付 14.74 元。\n`, "utf8");
    const result = searchLocalDocuments("张三门诊个人支付多少钱", temporaryDir, 6, { vectorSearch: false });
    assert.equal(result[0].documentId, "2b472924-15cc-4676-8d3d-f5f947e574fa");
    assert.equal(result[0].title, "张三门诊票据");
    assert.deepEqual(result[0].relatedDocumentIds, ["b71848a8-17de-4c97-8444-3c4270de1f77"]);
    assert.match(result[0].excerpt, /45\.89/);
    const fuzzyResult = searchLocalDocuments("张四门诊开的药是干嘛的", temporaryDir, 6, { vectorSearch: false });
    assert.equal(fuzzyResult[0].title, "张三门诊票据");
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("knowledge spaces resolve to separate account roots", () => {
  const vault = path.join(os.tmpdir(), "assistant-vault");
  assert.equal(resolveKnowledgeSpaceRoot({ spaceId: spaceOne }, vault), path.join(vault, "知识库", spaceOne));
  assert.equal(resolveKnowledgeSpaceRoot({ spaceId: spaceTwo }, vault), path.join(vault, "知识库", spaceTwo));
  assert.notEqual(
    resolveKnowledgeSpaceRoot({ spaceId: spaceOne }, vault),
    resolveKnowledgeSpaceRoot({ spaceId: spaceTwo }, vault),
  );
  assert.throws(() => resolveKnowledgeSpaceRoot({}, vault), /knowledge_space_missing_or_invalid/);
  assert.throws(() => resolveKnowledgeSpaceRoot({ spaceId: "../资料" }, vault), /knowledge_space_missing_or_invalid/);
});

test("local document search never crosses account roots", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-space-test-"));
  try {
    const firstRoot = resolveKnowledgeSpaceRoot({ spaceId: spaceOne }, temporaryDir);
    const secondRoot = resolveKnowledgeSpaceRoot({ spaceId: spaceTwo }, temporaryDir);
    const firstNoteDir = path.join(firstRoot, "资料", "医疗健康");
    fs.mkdirSync(firstNoteDir, { recursive: true });
    fs.mkdirSync(path.join(secondRoot, "资料"), { recursive: true });
    fs.writeFileSync(path.join(firstNoteDir, "私有处方.md"), `---\ndocument_id: "2b472924-15cc-4676-8d3d-f5f947e574fa"\ntitle: "账号一的私有处方"\ncategory: "医疗健康"\n---\n舒筋健络油只能在一封大药房买到。\n`, "utf8");

    assert.equal(searchLocalDocuments("舒筋健络油", firstRoot, 6, { vectorSearch: false }).length, 1);
    assert.deepEqual(searchLocalDocuments("舒筋健络油", secondRoot, 6, { vectorSearch: false }), []);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("family document search includes only explicitly granted document ids", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-family-search-test-"));
  try {
    const viewerRoot = resolveKnowledgeSpaceRoot({ spaceId: spaceOne }, temporaryDir);
    const ownerRoot = resolveKnowledgeSpaceRoot({ spaceId: spaceTwo }, temporaryDir);
    const viewerNotes = path.join(viewerRoot, "资料");
    const ownerNotes = path.join(ownerRoot, "资料");
    fs.mkdirSync(viewerNotes, { recursive: true });
    fs.mkdirSync(ownerNotes, { recursive: true });
    const ownId = "1b472924-15cc-4676-8d3d-f5f947e574fa";
    const sharedId = "2b472924-15cc-4676-8d3d-f5f947e574fa";
    const privateId = "3b472924-15cc-4676-8d3d-f5f947e574fa";
    fs.writeFileSync(path.join(viewerNotes, "自己的资料.md"), `---\ndocument_id: "${ownId}"\ntitle: "自己的资料"\ncategory: "测试"\ndocument_date: "2026-08-29"\narchived_at: "2026-08-29T08:00:00.000Z"\n---\n共同检索词 自己资料\n`, "utf8");
    fs.writeFileSync(path.join(ownerNotes, "共享资料.md"), `---\ndocument_id: "${sharedId}"\ntitle: "共享资料"\ncategory: "测试"\ndocument_date: "2026-08-29"\narchived_at: "2026-08-29T12:00:00.000Z"\n---\n# 共享资料\n\n## 摘要\n\n今晚会议讨论了共同检索词和允许共享的内容。\n\n## 提取文字\n\n未能提取文字，请查看原始文件。\n`, "utf8");
    fs.writeFileSync(path.join(ownerNotes, "私人资料.md"), `---\ndocument_id: "${privateId}"\ntitle: "私人资料"\ncategory: "测试"\n---\n共同检索词 私人秘密\n`, "utf8");

    const results = searchAccessibleDocuments("共同检索词", {
      spaceId: spaceOne,
      sharedDocumentScopes: [{ spaceId: spaceTwo, documentIds: [sharedId] }],
    }, temporaryDir, 6, { vectorSearch: false });
    assert.deepEqual(new Set(results.map(item => item.documentId)), new Set([ownId, sharedId]));
    assert.equal(results.some(item => item.documentId === privateId), false);

    const groupResults = searchAccessibleDocuments("共同检索词", {
      spaceId: spaceOne,
      primaryDocumentIds: [],
      sharedDocumentScopes: [{ spaceId: spaceTwo, documentIds: [sharedId] }],
    }, temporaryDir, 6, { vectorSearch: false });
    assert.deepEqual(groupResults.map(item => item.documentId), [sharedId]);

    const deicticResults = searchAccessibleDocuments("总结下这个资料", {
      spaceId: spaceOne,
      primaryDocumentIds: [],
      sharedDocumentScopes: [{ spaceId: spaceTwo, documentIds: [sharedId] }],
    }, temporaryDir, 6, { vectorSearch: false });
    assert.deepEqual(deicticResults.map(item => item.documentId), [sharedId]);
    assert.match(deicticResults[0].excerpt, /今晚会议讨论/);

    const recentResults = searchAccessibleDocuments("今天最新的共同检索词", {
      spaceId: spaceOne,
      input: { context: { currentDate: "2026-08-29" } },
      sharedDocumentScopes: [{ spaceId: spaceTwo, documentIds: [sharedId] }],
    }, temporaryDir, 6, { vectorSearch: false });
    assert.equal(recentResults[0].documentId, sharedId);
    assert.equal(recentResults[0].documentDate, "2026-08-29");
    assert.equal(recentResults[0].archivedAt, "2026-08-29T12:00:00.000Z");
    assert.match(recentResults[0].excerpt, /今晚会议讨论了共同检索词和允许共享的内容。/);
    assert.ok(recentResults[0].excerpt.indexOf("今晚会议讨论")
      < recentResults[0].excerpt.indexOf("未能提取文字"));

    const revoked = searchAccessibleDocuments("共同检索词", {
      spaceId: spaceOne,
      sharedDocumentScopes: [],
    }, temporaryDir, 6, { vectorSearch: false });
    assert.deepEqual(revoked.map(item => item.documentId), [ownId]);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("same-day meeting search ranks topic relevance ahead of archive time", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-meeting-ranking-test-"));
  try {
    const root = resolveKnowledgeSpaceRoot({ spaceId: spaceOne }, temporaryDir);
    const noteDir = path.join(root, "资料", "会议录音");
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(path.join(noteDir, "较早的app会议.md"), `---\ndocument_id: "4b472924-15cc-4676-8d3d-f5f947e574fa"\ntitle: "关于app开发和打包部署的会议"\ncategory: "会议录音"\ndocument_date: "2026-08-31"\narchived_at: "2026-08-31T02:50:00.000Z"\n---\n讨论app开发、代码审查以及打包部署流程。\n`, "utf8");
    fs.writeFileSync(path.join(noteDir, "较新的其他会议.md"), `---\ndocument_id: "5b472924-15cc-4676-8d3d-f5f947e574fa"\ntitle: "关于AI小票处理的会议"\ncategory: "会议录音"\ndocument_date: "2026-08-31"\narchived_at: "2026-08-31T03:18:00.000Z"\n---\n讨论小票上传、数据质检和人工确认流程。\n`, "utf8");

    const results = searchAccessibleDocuments("总结今天早上会议里关于app开发的部分", {
      spaceId: spaceOne,
      input: { context: { currentDate: "2026-08-31" } },
    }, temporaryDir, 2, { vectorSearch: false });
    assert.equal(results[0].documentId, "4b472924-15cc-4676-8d3d-f5f947e574fa");
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("explicit family document questions override an incorrect record classification", () => {
  assert.equal(shouldSearchDocumentsForIngest(
    "帮我总结今日家长会，总结成一二三这样的点，不能遗漏。",
    { kind: "record" },
  ), true);
  assert.equal(shouldSearchDocumentsForIngest(
    "请问今天晚上的会议主要内容有哪几点？",
    { kind: "record" },
  ), true);
  assert.equal(shouldSearchDocumentsForIngest(
    "明天下午三点提醒我参加家长会",
    { kind: "record" },
  ), false);
});

test("a follow-up asking to summarize this document always triggers document retrieval", () => {
  assert.equal(shouldSearchDocumentsForIngest(
    "总结下这个资料",
    { kind: "record" },
  ), true);
});

test("a document answer keeps the generated conversation title required by the queue", () => {
  const result = documentAnswerForIngest(
    { conversationTitle: "家长会资料总结" },
    { answer: "报到时间是八月三十一日。", sourceIndexes: [0] },
    [{
      documentId: "00000000-0000-4000-8000-000000000001",
      title: "秋季开学家长会",
      category: "会议录音",
      vaultPath: "/tmp/meeting.md",
      excerpt: "八月三十一日到校报到。",
      relatedDocumentIds: [],
    }],
  );
  assert.equal(result.conversationTitle, "家长会资料总结");
  assert.equal(result.documentSources.length, 1);
  assert.equal(result.retrievalStatus, "answered_with_sources");
});

test("plain text documents are extracted and archived as Obsidian notes", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-document-test-"));
  try {
    const sourcePath = path.join(temporaryDir, "hospital.txt");
    fs.writeFileSync(sourcePath, "张三 2026-08-19 医院处方：按医嘱服药。", "utf8");
    const extracted = extractDocumentText(sourcePath, "医院处方.txt", "text/plain", temporaryDir);
    assert.match(extracted.text, /医院处方/);
    const archived = writeVaultDocument(
      { input: { documentId: "2b472924-15cc-4676-8d3d-f5f947e574fa" } },
      "医院处方.txt",
      fs.readFileSync(sourcePath),
      extracted.text,
      {
        title: "张三医院处方",
        category: "医疗健康",
        summary: "张三的医院处方资料。",
        people: ["张三"],
        keywords: ["医院", "处方"],
        documentDate: "2026-08-19",
      },
      [],
      temporaryDir,
      "这个药对跌打损伤很好用，目前只能在一封大药房买到。",
      `知识库/${spaceOne}`,
    );
    const note = fs.readFileSync(path.join(temporaryDir, archived.noteRelative), "utf8");
    assert.match(note, /category: "医疗健康"/);
    assert.match(note, new RegExp(`\\[\\[知识库/${spaceOne}/附件/`));
    assert.match(note, new RegExp(`source_file: "知识库/${spaceOne}/附件/`));
    assert.match(note, /按医嘱服药/);
    assert.match(note, /## 我的说明/);
    assert.match(note, /一封大药房/);
    const appended = appendVaultDocumentNote(
      "2b472924-15cc-4676-8d3d-f5f947e574fa",
      "后来发现也可以在医院药房购买。",
      temporaryDir,
    );
    assert.equal(appended.appended, true);
    const updatedNote = fs.readFileSync(path.join(temporaryDir, archived.noteRelative), "utf8");
    assert.match(updatedNote, /后来发现也可以在医院药房购买/);
    assert.equal(appendVaultDocumentNote(
      "2b472924-15cc-4676-8d3d-f5f947e574fa",
      "后来发现也可以在医院药房购买。",
      temporaryDir,
    ).appended, false);
    assert.ok(fs.existsSync(path.join(temporaryDir, archived.attachmentRelative)));
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test("long meeting transcripts are archived without truncating the searchable text", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-meeting-note-test-"));
  try {
    const transcript = `班会开始。${"这是完整的分段转写内容。".repeat(500)}`;
    const archived = writeVaultDocument(
      { input: { documentId: "3b472924-15cc-4676-8d3d-f5f947e574fa" } },
      "会议录音.wav",
      Buffer.from("fake-wav"),
      "",
      {
        title: "班会录音",
        category: "会议录音",
        summary: "班会录音及自动转写。",
        people: [],
        keywords: ["班会"],
        documentDate: "2026-08-29",
      },
      [],
      temporaryDir,
      transcript,
      `知识库/${spaceOne}`,
    );
    const note = fs.readFileSync(path.join(temporaryDir, archived.noteRelative), "utf8");
    assert.ok(note.includes(transcript));
    assert.match(note, /## 我的说明/);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});
