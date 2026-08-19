#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [vaultArgument, spaceIdArgument] = process.argv.slice(2);
const vaultRoot = path.resolve(String(vaultArgument || ""));
const spaceId = String(spaceIdArgument || "").toLowerCase();
if (!vaultArgument || !/^[a-f0-9]{64}$/.test(spaceId)) {
  throw new Error("usage: migrate-knowledge-space.mjs <vault-root> <64-char-space-id>");
}

const targetRoot = path.join(vaultRoot, "知识库", spaceId);
fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
for (const name of ["资料", "附件", ".assistant"]) {
  const source = path.join(vaultRoot, name);
  const target = path.join(targetRoot, name);
  if (!fs.existsSync(source)) continue;
  if (fs.existsSync(target)) throw new Error(`migration_target_exists:${target}`);
  fs.renameSync(source, target);
}

const notesRoot = path.join(targetRoot, "资料");
const prefix = `知识库/${spaceId}/附件/`;
const pending = fs.existsSync(notesRoot) ? [notesRoot] : [];
let rewritten = 0;
while (pending.length) {
  const directory = pending.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) pending.push(entryPath);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const before = fs.readFileSync(entryPath, "utf8");
      const after = before
        .replaceAll('source_file: "附件/', `source_file: "${prefix}`)
        .replaceAll("[[附件/", `[[${prefix}`);
      if (after !== before) {
        fs.writeFileSync(entryPath, after, { encoding: "utf8", mode: 0o600 });
        rewritten += 1;
      }
    }
  }
}
process.stdout.write(JSON.stringify({ targetRoot, rewritten }));
