import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { runInference, runOllama } from "./codex-worker.mjs";

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
  assert.equal(requestBody.format.type, "object");
  assert.deepEqual(requestBody.format.required, ["kind"]);
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
