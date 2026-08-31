import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const testDir = mkdtempSync(path.join(tmpdir(), "daynote-desktop-pairing-"));
process.env.DB_PATH = path.join(testDir, "data.db");

const pairing = await import("../src/desktop-pairing.js");
const { resolveEmailSession } = await import("../src/email-auth.js");

test("电脑配对需要手机侧和电脑侧两个不同密钥", () => {
  const created = pairing.createDesktopPairing("Mac · Safari");
  assert.notEqual(created.desktopSecret, created.scanSecret);
  assert.equal(pairing.inspectDesktopPairing(created.id, "wrong"), null);
  assert.deepEqual(pairing.claimDesktopPairing(created.id, "wrong"), { status: "invalid" });
  assert.equal(pairing.inspectDesktopPairing(created.id, created.scanSecret)?.deviceLabel, "Mac · Safari");
});

test("手机确认后电脑只能领取一次独立的两小时会话", () => {
  const created = pairing.createDesktopPairing("Windows · Chrome");
  assert.deepEqual(pairing.claimDesktopPairing(created.id, created.desktopSecret), { status: "waiting" });
  assert.deepEqual(
    pairing.approveDesktopPairing(created.id, created.scanSecret, "user-1"),
    { status: "approved", deviceLabel: "Windows · Chrome" },
  );
  const claimed = pairing.claimDesktopPairing(created.id, created.desktopSecret);
  assert.equal(claimed.status, "complete");
  if (claimed.status !== "complete") return;
  assert.equal(claimed.user, "user-1");
  assert.equal(resolveEmailSession(claimed.token), "user-1");
  assert.equal(new Date(claimed.expiresAt).getTime() - Date.now() <= 2 * 60 * 60_000, true);
  assert.deepEqual(pairing.claimDesktopPairing(created.id, created.desktopSecret), { status: "consumed" });
});

test("已经由一个账号确认的二维码不能改绑另一个账号", () => {
  const created = pairing.createDesktopPairing("Shared PC");
  assert.ok(pairing.approveDesktopPairing(created.id, created.scanSecret, "user-1"));
  assert.equal(pairing.approveDesktopPairing(created.id, created.scanSecret, "user-2"), null);
});
