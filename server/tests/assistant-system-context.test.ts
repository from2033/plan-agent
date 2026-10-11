import assert from "node:assert/strict";
import test from "node:test";
import { assistantSystemContext } from "../src/assistant-system-context.js";

test("system context distinguishes resumed live sync from offline history backfill", () => {
  const [qq] = assistantSystemContext({
    configured: true,
    state: "online",
    connected: true,
    accountLabel: "QQ",
    lastCheckedAt: "2026-09-07T14:30:00.000Z",
    lastSuccessfulSyncAt: "2026-09-07T14:29:00.000Z",
    lastMessageAt: "2026-09-07T14:28:00.000Z",
    detail: "",
  });
  assert.match(qq.facts.join("\n"), /自动继续同步此后新收到的群消息/);
  assert.match(qq.facts.join("\n"), /自动检查并回放最近 3 天/);
  assert.match(qq.facts.join("\n"), /告警邮件/);
  assert.match(qq.facts.join("\n"), /当前 QQ 采集状态：在线/);
});
