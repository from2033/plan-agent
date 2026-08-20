import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendVaultDocumentNote,
  extractDocumentText,
  hasExplicitTimeRange,
  ollamaModelForJob,
  resolveKnowledgeSpaceRoot,
  runInference,
  runOllama,
  searchLocalDocuments,
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
  assert.deepEqual(requestBody.format.required, ["kind", "fields", "title", "content", "answer", "sourceIds"]);
  assert.deepEqual(JSON.parse(requestBody.messages[1].content), { input: ingestJob.input });
});

test("runInference falls back to Codex when Ollama is unavailable", async () => {
  const expected = { kind: "record", fields: [] };
  const inference = await runInference(ingestJob, {
    provider: "ollama",
    localRunner: async () => { throw new Error("ollama_offline"); },
    cloudRunner: async () => expected,
    codexFallback: true,
  });
  assert.equal(inference.provider, "codex-fallback");
  assert.equal(inference.result, expected);
});

test("daily input uses the small model while complex jobs use the large model", () => {
  assert.equal(ollamaModelForJob({ kind: "ingest" }), "qwen3:4b");
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

test("invalid small-model output escalates to the large local model before Codex", async () => {
  const calls = [];
  const expected = { kind: "record", fields: [] };
  const inference = await runInference(ingestJob, {
    provider: "ollama",
    localRunner: async (_job, options) => {
      calls.push(options.model);
      throw new Error("small_invalid");
    },
    largeLocalRunner: async (_job, options) => {
      calls.push(options.model);
      return expected;
    },
    cloudRunner: async () => { throw new Error("cloud_should_not_run"); },
  });
  assert.deepEqual(calls, ["qwen3:4b", "qwen3:14b"]);
  assert.equal(inference.provider, "ollama-large-fallback");
  assert.equal(inference.result, expected);
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

test("local document search indexes Obsidian notes and returns excerpts", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-search-test-"));
  try {
    const noteDir = path.join(temporaryDir, "资料", "医疗健康");
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(path.join(noteDir, "门诊票据.md"), `---\ndocument_id: "2b472924-15cc-4676-8d3d-f5f947e574fa"\ntitle: "张三门诊票据"\ncategory: "医疗健康"\n---\n张三门诊个人支付 45.89 元，医保支付 14.74 元。\n`, "utf8");
    const result = searchLocalDocuments("张三门诊个人支付多少钱", temporaryDir);
    assert.equal(result[0].documentId, "2b472924-15cc-4676-8d3d-f5f947e574fa");
    assert.equal(result[0].title, "张三门诊票据");
    assert.match(result[0].excerpt, /45\.89/);
    const fuzzyResult = searchLocalDocuments("张四门诊开的药是干嘛的", temporaryDir);
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

    assert.equal(searchLocalDocuments("舒筋健络油", firstRoot).length, 1);
    assert.deepEqual(searchLocalDocuments("舒筋健络油", secondRoot), []);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
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
