import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const testDir = mkdtempSync(path.join(tmpdir(), "daynote-family-sharing-"));
process.env.DB_PATH = path.join(testDir, "data.db");
process.env.PRIMARY_USER = "primary";
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const family = await import("../src/family-sharing.js");
const database = await import("../src/db.js");
const documents = await import("../src/document-store.js");
const access = await import("../src/document-access.js");

test("家庭邀请只由目标账号接受，接受后成为家庭成员", () => {
  const invitation = family.inviteFamilyMember("primary", "Parent@Example.com", "primary");
  assert.ok(invitation);
  assert.equal(family.respondToFamilyInvitation(invitation.id, "wrong@example.com", true), false);
  assert.equal(family.respondToFamilyInvitation(invitation.id, "parent@example.com", true), true);

  const state = family.getFamilyState("parent@example.com", "primary");
  assert.equal(state.family?.name, "我的家庭");
  assert.deepEqual(state.family?.members.map((member) => member.userId), ["primary", "parent@example.com"]);
});

test("家庭成员只能看到明确共享的知识，且共享副本不可编辑", () => {
  const privateItem = database.insertKnowledge("primary", "私人", "只有自己可见");
  const sharedItem = database.insertKnowledge("primary", "孩子资料", "学校体检记录");
  assert.equal(family.shareResourceWithFamily("primary", "knowledge", sharedItem.id), true);

  const visible = database.listKnowledgeForViewer("parent@example.com");
  assert.deepEqual(visible.map((item) => item.id), [sharedItem.id]);
  assert.equal(visible[0]?.canEdit, false);
  assert.equal(visible[0]?.sharedWithFamily, true);
  assert.equal(database.getKnowledgeForViewer(privateItem.id, "parent@example.com"), null);

  assert.equal(family.unshareResourceFromFamily("primary", "knowledge", sharedItem.id), true);
  assert.deepEqual(database.listKnowledgeForViewer("parent@example.com"), []);
});

test("共享文档在家庭资料库可见，但成员不能取得编辑权限", () => {
  const document = documents.storeDocumentUpload(
    "primary",
    "孩子体检.txt",
    "text/plain",
    Buffer.from("身高和体重记录"),
  );
  assert.deepEqual(documents.listDocumentsForViewer("parent@example.com"), []);
  assert.equal(family.shareResourceWithFamily("primary", "document", document.id), true);

  const visible = documents.listDocumentsForViewer("parent@example.com");
  assert.equal(visible[0]?.id, document.id);
  assert.equal(visible[0]?.canEdit, false);
  assert.equal(visible[0]?.sharedWithFamily, true);
  assert.equal(
    documents.readDocumentUploadForViewer(document.id, "parent@example.com")?.content.toString(),
    "身高和体重记录",
  );
  const scopes = access.sharedDocumentScopesForViewer("parent@example.com");
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0]?.documentIds, [document.id]);

  assert.equal(family.unshareResourceFromFamily("primary", "document", document.id), true);
  assert.deepEqual(access.sharedDocumentScopesForViewer("parent@example.com"), []);
});
