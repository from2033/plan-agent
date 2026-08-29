import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const testDir = mkdtempSync(path.join(tmpdir(), "daynote-shared-qq-"));
process.env.DB_PATH = path.join(testDir, "data.db");
process.env.PRIMARY_USER = "primary";

const {
  getEntry,
  insertEntry,
  listEntriesForViewer,
  setDoneForViewer,
} = await import("../src/db.js");
const { inviteFamilyMember, respondToFamilyInvitation } = await import("../src/family-sharing.js");

const familyInvite = inviteFamilyMember("primary", "viewer@qq.com", "primary");
assert.ok(familyInvite);
assert.equal(respondToFamilyInvitation(familyInvite.id, "viewer@qq.com", true), true);

function entry(id: string, category: string, timestamp: string) {
  return {
    id,
    type: "memo" as const,
    raw: id,
    time: "08:00",
    description: id,
    category,
    done: false,
    timestamp,
  };
}

test("次账号只合并同步账号的 QQ 群任务", () => {
  insertEntry(entry("primary-private", "个人", "2026-08-29T00:00:00.000Z"), "primary");
  insertEntry(entry("qq-shared", "QQ群任务", "2026-08-29T01:00:00.000Z"), "primary");
  insertEntry(entry("viewer-private", "个人", "2026-08-29T02:00:00.000Z"), "viewer@qq.com");

  const visible = listEntriesForViewer("viewer@qq.com", "primary");
  assert.deepEqual(visible.map((item) => item.id), ["qq-shared", "viewer-private"]);
});

test("次账号可以共同完成 QQ 群任务，但不能修改主账号私人待办", () => {
  const shared = setDoneForViewer("qq-shared", true, "viewer@qq.com", "primary");
  assert.equal(shared?.done, true);
  assert.equal(getEntry("qq-shared", "primary")?.done, true);

  const privateEntry = setDoneForViewer("primary-private", true, "viewer@qq.com", "primary");
  assert.equal(privateEntry, null);
  assert.equal(getEntry("primary-private", "primary")?.done, false);
});
