#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = process.env.ASSISTANT_CHAT_ACCOUNT_CONFIG
  || path.join(os.homedir(), "Library", "Application Support", "Personal Assistant", "chat-knowledge-account.json");
const baseUrl = (process.env.ASSISTANT_API_URL || "https://assistant.5656ai.com/api").replace(/\/$/, "");
const keychainService = process.env.ASSISTANT_CODEX_KEYCHAIN_SERVICE || "personal-assistant-codex-worker";
const keychainAccount = process.env.ASSISTANT_CODEX_KEYCHAIN_ACCOUNT || os.userInfo().username;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function frontmatter(text) {
  if (!text.startsWith("---\n")) throw new Error("note_frontmatter_missing");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("note_frontmatter_invalid");
  const head = text.slice(4, end);
  const value = key => {
    const match = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!match) return "";
    try { return JSON.parse(match[1]); } catch { return match[1].trim().replace(/^['"]|['"]$/g, ""); }
  };
  return { value, body: text.slice(end + 5).trim() };
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".zip": "application/zip",
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".heic": "image/heic",
    ".md": "text/markdown",
  }[extension] || "application/octet-stream";
}

function workerToken() {
  return execFileSync("/usr/bin/security", [
    "find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const noteArgument = argument("--note");
if (!noteArgument) throw new Error("usage: register-local-document.mjs --note /absolute/note.md");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!/^[a-f0-9]{64}$/.test(config.spaceId) || !config.userId || !config.vaultRoot) {
  throw new Error("chat_account_config_invalid");
}
const accountRoot = path.resolve(config.vaultRoot, "知识库", config.spaceId);
const notePath = path.resolve(noteArgument);
if (!notePath.startsWith(accountRoot + path.sep) || !fs.existsSync(notePath)) {
  throw new Error("note_outside_account_space");
}
const text = fs.readFileSync(notePath, "utf8");
const parsed = frontmatter(text);
const documentId = String(parsed.value("document_id") || "");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId)) {
  throw new Error("note_document_id_invalid");
}
const vaultPath = path.relative(accountRoot, notePath).split(path.sep).join("/");
const sourceFile = String(parsed.value("source_file") || "");
const attachmentPath = sourceFile || vaultPath;
const attachmentAbsolute = sourceFile
  ? path.resolve(config.vaultRoot, ...sourceFile.split("/"))
  : notePath;
if (!attachmentAbsolute.startsWith(path.resolve(config.vaultRoot) + path.sep)
  || !fs.existsSync(attachmentAbsolute)) throw new Error("local_attachment_missing");
const people = parsed.value("people");
const keywords = parsed.value("keywords");
const compactBody = parsed.body.replace(/\s+/g, " ").trim();
const title = String(parsed.value("title") || path.basename(notePath, ".md")).slice(0, 200);
const payload = {
  userId: String(config.userId),
  spaceId: String(config.spaceId),
  documentId,
  fileName: path.basename(attachmentAbsolute),
  mimeType: mimeType(attachmentAbsolute),
  byteSize: fs.statSync(attachmentAbsolute).size,
  vaultPath,
  result: {
    documentId,
    title,
    category: String(parsed.value("category") || "其他").slice(0, 60),
    summary: compactBody.slice(0, 800),
    people: Array.isArray(people) ? people.map(String).slice(0, 20) : [],
    keywords: Array.isArray(keywords) ? keywords.map(String).slice(0, 30) : [],
    documentDate: String(parsed.value("document_date") || "").slice(0, 20),
    vaultPath,
    attachmentPath,
    textLength: parsed.body.length,
    warnings: sourceFile ? [] : ["本资料由聊天整理生成，原始依据请查看关联资料。"],
  },
  notes: [],
};
const response = await fetch(`${baseUrl}/internal/codex-worker/local-documents`, {
  method: "POST",
  headers: { authorization: `Bearer ${workerToken()}`, "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`local_document_registration_http_${response.status}`);
const result = await response.json();
process.stdout.write(JSON.stringify({ ok: true, documentId: result.documentId, storageKind: result.storageKind }));
