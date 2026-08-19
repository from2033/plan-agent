import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationScript = path.join(scriptDir, "migrate-knowledge-space.mjs");

test("legacy vault content moves into one account space and links remain valid", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-migration-test-"));
  const spaceId = "a".repeat(64);
  try {
    fs.mkdirSync(path.join(vault, "资料", "医疗健康"), { recursive: true });
    fs.mkdirSync(path.join(vault, "附件"), { recursive: true });
    fs.mkdirSync(path.join(vault, ".assistant"), { recursive: true });
    fs.writeFileSync(path.join(vault, "附件", "药品.jpg"), "image", "utf8");
    fs.writeFileSync(
      path.join(vault, "资料", "医疗健康", "药品.md"),
      `---\nsource_file: "附件/药品.jpg"\n---\n[[附件/药品.jpg]]\n`,
      "utf8",
    );

    const output = JSON.parse(execFileSync(process.execPath, [migrationScript, vault, spaceId], { encoding: "utf8" }));
    const accountRoot = path.join(vault, "知识库", spaceId);
    assert.equal(output.targetRoot, accountRoot);
    assert.equal(output.rewritten, 1);
    assert.equal(fs.existsSync(path.join(vault, "资料")), false);
    assert.equal(fs.existsSync(path.join(vault, "附件")), false);
    assert.ok(fs.existsSync(path.join(accountRoot, "附件", "药品.jpg")));
    const note = fs.readFileSync(path.join(accountRoot, "资料", "医疗健康", "药品.md"), "utf8");
    assert.match(note, new RegExp(`source_file: "知识库/${spaceId}/附件/药品.jpg"`));
    assert.match(note, new RegExp(`\\[\\[知识库/${spaceId}/附件/药品.jpg\\]\\]`));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
